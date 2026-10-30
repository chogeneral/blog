import { buildPrompt } from './content.js';
import { buildChatPrompt, parseChatText } from './chat.js';

// 딥시크(DeepSeek) API 로 글을 씁니다. 유료지만 글 한 편 비용이 아주 적고 한국어 품질이 좋습니다.
// 키가 없으면 null 을 돌려주고, 프로그램은 다음 엔진(Gemini → 로컬 AI → 내장 틀)으로 넘어갑니다.
// 키 발급: https://platform.deepseek.com/api_keys

const BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

const SYSTEM = '당신은 네이버 홈판에 오르는 글을 10년 동안 기획해 온 마케터이자, 주제에 맞는 정보를 정확하고 전문적으로 전하는 네이버 블로그의 한국어 글쓴이입니다. 지정한 키워드를 조합해 통념을 뒤집는 반전·직관적인 숫자·클릭을 부르는 말("믿었는데 알고 보니", "결국 ~하더라")로 궁금증을 자극하는 제목을 짓고(제목의 반전과 숫자는 본문에서 실제로 풀어 줌), 인사말 바로 다음 도입부 첫 문장부터 제목이 던진 궁금증의 답을 예고나 뜸 들이기 없이 바로 풀어 줍니다. 제목이 묻는 것에 정면으로 답하며, 글쓴이 개인 경험담 대신 그 주제의 독자가 흔히 겪는 경험을 이야기처럼 생생하게 보여 주며 공감을 얻은 뒤(육아 주제가 아니면 아이·부모 이야기를 쓰지 않음) 주제에 대한 구체적이고 최신인 정보를 기승전결로 풀어 씁니다. 확인되지 않은 수치는 지어내지 않고, 키워드를 반복해 도배하지 않습니다. 말투는 지시문의 말투 규칙을 그대로 따르며(기본: ~해요·~거든요·~죠를 섞은 친근하고 몰입감 있는 구어체) 반말 평서체는 쓰지 않습니다. 지시문이 정한 글자수를 반드시 채웁니다. 지시문 끝에 글쓴이의 추가 요청이 있으면 그것을 우선해 따릅니다. 반드시 JSON 만 출력합니다.';

const extractJson = (text) => {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
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

// 설정한 모델 이름이 바뀌었거나 없어졌을 때, 이 키로 쓸 수 있는 모델 목록에서 하나를 고릅니다.
const availableModels = async (apiKey) => {
  try {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    return (data?.data || []).map((item) => item.id).filter(Boolean);
  } catch (error) {
    return [];
  }
};

const callDeepSeek = async (input, { log = () => {} } = {}) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return null;
  }
  // 채팅 모드는 chat.deepseek.com 처럼 시스템 지시 없이 요청만 보내고 자유로운 글로 받습니다.
  const chat = Boolean(input.chatMode);
  const prompt = chat ? buildChatPrompt(input) : buildPrompt(input, { search: false });

  let lastUsage = null;
  const request = async (model) => {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          ...(chat ? [] : [{ role: 'system', content: SYSTEM }]),
          { role: 'user', content: prompt },
        ],
        ...(chat ? {} : { response_format: { type: 'json_object' } }),
        temperature: chat ? 1.0 : 0.8,
        // 생각하는 데 쓰는 분량도 이 한도에 포함되어, 8192 로는 글이 중간에 잘렸습니다.
        max_tokens: 32768,
        stream: false,
      }),
      signal: AbortSignal.timeout(240000),
    });
    if (!response.ok) {
      const error = new Error(`deepseek ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    const choice = data?.choices?.[0] || {};
    const text = choice.message?.content || '';
    if (!text) {
      throw new Error('deepseek empty');
    }
    if (choice.finish_reason === 'length') {
      throw new Error('deepseek cut');
    }
    lastUsage = data?.usage || null;
    return chat ? parseChatText(text) : extractJson(text);
  };

  const wanted = String(process.env.DEEPSEEK_MODEL || DEFAULT_MODEL).trim();
  try {
    const draft = await request(wanted);
    log(`딥시크(${wanted})로 작성했습니다.${chat ? ' (채팅 모드)' : ''}`);
    return draft;
  } catch (error) {
    // 401 = 키가 틀림, 402 = 잔액 부족. 모델을 바꿔도 소용없으므로 바로 알립니다.
    if (error.status === 401) {
      log('딥시크 키가 올바르지 않습니다. .env 의 DEEPSEEK_API_KEY 를 확인해 주시기 바랍니다.');
      throw error;
    }
    if (error.status === 402) {
      log('딥시크 계정 잔액이 부족합니다. platform.deepseek.com 에서 충전해 주시기 바랍니다.');
      throw error;
    }
    if (![400, 404, 422].includes(error.status)) {
      throw error;
    }
    // 모델 이름 문제일 수 있으니 쓸 수 있는 모델로 한 번 더 시도합니다.
    const models = await availableModels(apiKey);
    const fallback = models.find((id) => id === DEFAULT_MODEL) || models.find((id) => /flash|chat/.test(id)) || models[0];
    if (!fallback || fallback === wanted) {
      throw error;
    }
    log(`딥시크 모델(${wanted})을 쓸 수 없어 ${fallback} 모델로 바꿉니다.`);
    const draft = await request(fallback);
    log(`딥시크(${fallback})로 작성했습니다.`);
    return draft;
  }
};

export { callDeepSeek };
