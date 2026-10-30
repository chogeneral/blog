import { buildPrompt } from './content.js';
import { buildChatPrompt, parseChatText } from './chat.js';

// 무료 등급으로 쓸 수 있는 Google Gemini API 를 기본 글 생성 엔진으로 씁니다.
// 키가 없으면 null 을 돌려주고, 프로그램은 내장 글 틀로 작성합니다.

const SYSTEM = '당신은 네이버 홈판에 오르는 글을 10년 동안 기획해 온 마케터이자, 주제에 맞는 정보를 정확하고 전문적으로 전하는 네이버 블로그의 한국어 글쓴이입니다. 지정한 키워드를 조합해 통념을 뒤집는 반전·직관적인 숫자·클릭을 부르는 말("믿었는데 알고 보니", "결국 ~하더라")로 궁금증을 자극하는 제목을 짓고(제목의 반전과 숫자는 본문에서 실제로 풀어 줌), 인사말 바로 다음 도입부 첫 문장부터 제목이 던진 궁금증의 답을 예고나 뜸 들이기 없이 바로 풀어 줍니다. 제목이 묻는 것에 정면으로 답하며, 글쓴이 개인 경험담 대신 그 주제의 독자가 흔히 겪는 경험을 이야기처럼 생생하게 보여 주며 공감을 얻은 뒤(육아 주제가 아니면 아이·부모 이야기를 쓰지 않음) 주제에 대한 구체적이고 최신인 정보를 기승전결로 풀어 씁니다. 확인되지 않은 수치는 지어내지 않고, 키워드를 반복해 도배하지 않습니다. 말투는 지시문의 말투 규칙을 그대로 따르며(기본: ~해요·~거든요·~죠를 섞은 친근하고 몰입감 있는 구어체) 반말 평서체는 쓰지 않습니다. 지시문이 정한 글자수를 반드시 채웁니다.';

const extractJson = (text) => {
  const trimmed = String(text ?? '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw error;
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
};

// 설정한 모델이 붐비거나(503) 없어졌을 때(404) 차례로 바꿔 쓸 모델입니다.
const FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

// 무료 키는 구글 검색 연동 한도가 없는 경우가 많습니다. 한 번 막히면 이번 실행 동안은 검색을 건너뜁니다.
let searchBlocked = false;

const callGemini = async (input, { log = () => {} } = {}) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  const models = [...new Set([process.env.GEMINI_MODEL || FALLBACK_MODELS[0], ...FALLBACK_MODELS])];
  // 채팅 모드는 시스템 지시와 JSON 형식 없이 요청만 보내고 자유로운 글로 받습니다.
  const chat = Boolean(input.chatMode);
  const prompts = chat
    ? { search: buildChatPrompt(input), plain: buildChatPrompt(input) }
    : { search: buildPrompt(input, { search: true }), plain: buildPrompt(input, { search: false }) };

  const request = async (model, generationConfig, tools) => {
    const prompt = tools ? prompts.search : prompts.plain;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        ...(chat ? {} : { systemInstruction: { parts: [{ text: SYSTEM }] } }),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
        ...(tools ? { tools } : {}),
      }),
      signal: AbortSignal.timeout(tools ? 120000 : 90000),
    });
    if (!response.ok) {
      const error = new Error(`gemini ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((part) => !part.thought && part.text).map((part) => part.text).join('');
    if (!text) {
      throw new Error('gemini empty');
    }
    return chat ? parseChatText(text) : extractJson(text);
  };

  const base = { temperature: 0.8, maxOutputTokens: 8192 };
  const json = { ...base, responseMimeType: 'application/json' };

  // 모델마다 순서대로 시도합니다.
  // 1) 구글 검색으로 최신 자료를 찾아 반영합니다. 검색 도구는 JSON 전용 모드와 같이 못 써서
  //    일반 글로 받은 뒤 JSON 부분만 꺼냅니다.
  // 2) 검색이 막히거나 형식이 깨지면 검색 없이 JSON 모드로 다시 받습니다.
  // 모델이 붐비면(503) 다음 모델로 넘어갑니다.
  let lastError = null;
  for (let m = 0; m < models.length; m += 1) {
    const model = models[m];
    const attempts = [
      ...(searchBlocked ? [] : [{ search: true, run: () => request(model, base, [{ google_search: {} }]) }]),
      { search: false, run: () => request(model, chat ? base : json) },
    ];
    for (let index = 0; index < attempts.length; index += 1) {
      try {
        const draft = await attempts[index].run();
        if (draft && typeof draft === 'object') {
          log(`Gemini(${model})로 작성했습니다.${attempts[index].search ? ' 구글 검색으로 최신 자료를 반영했습니다.' : ' (최신 자료 검색 없이 작성)'}`);
          return draft;
        }
      } catch (error) {
        lastError = error;
        if (attempts[index].search && error.status === 429) {
          searchBlocked = true;
          log('이 Gemini 키는 구글 검색 연동 한도가 없어 검색 없이 작성합니다.');
        }
        // 모델이 없거나 붐비면 이 모델의 남은 시도는 건너뜁니다.
        if (!attempts[index].search && [404, 500, 503].includes(error.status)) {
          log(`Gemini(${model})가 지금 응답하지 않아 다른 모델로 바꿉니다.`);
          break;
        }
      }
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
};

export { callGemini };
