import { buildPrompt } from './content.js';
import { buildChatPrompt, parseChatText } from './chat.js';

// 내 컴퓨터에서 도는 무료 AI(Ollama)를 씁니다. API 키도, 가입도, 인터넷도 필요 없습니다.
// https://ollama.com/download 에서 설치한 뒤 모델을 한 번 내려받으면 바로 연결됩니다.

const BASE_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const SYSTEM = '당신은 네이버 홈판에 오르는 글을 10년 동안 기획해 온 마케터이자, 주제에 맞는 정보를 정확하고 전문적으로 전하는 네이버 블로그의 한국어 글쓴이입니다. 지정한 키워드를 조합해 통념을 뒤집는 반전·직관적인 숫자·클릭을 부르는 말("믿었는데 알고 보니", "결국 ~하더라")로 궁금증을 자극하는 제목을 짓고(제목의 반전과 숫자는 본문에서 실제로 풀어 줌), 인사말 바로 다음 도입부 첫 문장부터 제목이 던진 궁금증의 답을 예고나 뜸 들이기 없이 바로 풀어 줍니다. 제목이 묻는 것에 정면으로 답하며, 글쓴이 개인 경험담 대신 그 주제의 독자가 흔히 겪는 경험을 이야기처럼 생생하게 보여 주며 공감을 얻은 뒤(육아 주제가 아니면 아이·부모 이야기를 쓰지 않음) 주제에 대한 구체적이고 최신인 정보를 기승전결로 풀어 씁니다. 확인되지 않은 수치는 지어내지 않고, 키워드를 반복해 도배하지 않습니다. 말투는 지시문의 말투 규칙을 그대로 따르며(기본: ~해요·~거든요·~죠를 섞은 친근하고 몰입감 있는 구어체) 반말 평서체는 쓰지 않습니다. 지시문이 정한 글자수를 반드시 채웁니다. 반드시 JSON 만 출력합니다.';

// 한국어 품질과 속도를 같이 보고 고른 순서입니다. 앞쪽일수록 먼저 씁니다.
const PREFERRED = [
  'gemma3:4b', 'gemma3:12b', 'qwen3:4b', 'qwen3:8b',
  'qwen2.5:7b', 'llama3.1:8b', 'gemma2:9b', 'exaone3.5:7.8b',
];

const listModels = async (timeout = 2500) => {
  try {
    const response = await fetch(`${BASE_URL}/api/tags`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    return (data?.models || []).map((item) => item.name).filter(Boolean);
  } catch (error) {
    return [];
  }
};

const pickModel = (models) => {
  const wanted = String(process.env.OLLAMA_MODEL || '').trim();
  if (wanted && models.some((name) => name === wanted || name.startsWith(`${wanted}:`))) {
    return models.find((name) => name === wanted || name.startsWith(`${wanted}:`));
  }
  const preferred = PREFERRED.find((name) => models.includes(name))
    || PREFERRED.map((name) => models.find((item) => item.startsWith(`${name.split(':')[0]}:`))).find(Boolean);
  return preferred || models[0] || '';
};

// 프로그램이 뜰 때 상태를 확인합니다. 켜져 있지 않아도 오류를 내지 않습니다.
const ollamaStatus = async () => {
  const models = await listModels();
  return {
    ready: models.length > 0,
    model: pickModel(models),
    models,
  };
};

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

// 글 한 편을 만듭니다. 컴퓨터 사양에 따라 1분에서 5분 정도 걸립니다.
const callOllama = async (input, { log = () => {} } = {}) => {
  const status = await ollamaStatus();
  if (!status.ready) {
    return null;
  }
  log(`로컬 AI(${status.model})로 글을 작성합니다. 컴퓨터에서 직접 계산하므로 컴퓨터 성능에 따라 몇 분 걸립니다.`);
  // stream: true 로 받습니다. 한 번에 받으면(stream: false) 글이 다 써질 때까지 응답이 없어서,
  // Node 의 기본 대기 한도(5분)에 걸려 OLLAMA_TIMEOUT 과 상관없이 끊깁니다.
  const response = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: status.model,
      stream: true,
      // 채팅 모드는 JSON 형식을 강제하지 않고 자유로운 글로 받습니다.
      ...(input.chatMode ? {} : { format: 'json' }),
      options: { temperature: 0.8, num_ctx: 8192, num_predict: 4096 },
      messages: [
        ...(input.chatMode ? [] : [{ role: 'system', content: SYSTEM }]),
        { role: 'user', content: input.chatMode ? buildChatPrompt(input) : buildPrompt(input, { search: false }) },
      ],
    }),
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT || 600000)),
  });
  if (!response.ok || !response.body) {
    throw new Error(`ollama ${response.status}`);
  }
  // 한 줄에 하나씩 오는 조각(JSON)을 이어 붙입니다. 1분마다 진행 상황을 알려 줍니다.
  const decoder = new TextDecoder();
  const started = Date.now();
  let nextNotice = started + 60000;
  let buffer = '';
  let text = '';
  const take = (line) => {
    if (!line.trim()) {
      return;
    }
    const piece = JSON.parse(line);
    if (piece.error) {
      throw new Error(`ollama ${piece.error}`);
    }
    text += piece?.message?.content || '';
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(take);
    if (Date.now() >= nextNotice) {
      log(`로컬 AI가 글을 쓰는 중입니다. (${Math.round((Date.now() - started) / 60000)}분 경과, ${text.length}자)`);
      nextNotice += 60000;
    }
  }
  take(buffer + decoder.decode());
  if (!text) {
    return null;
  }
  return input.chatMode ? parseChatText(text) : extractJson(text);
};

export { callOllama, ollamaStatus, listModels, PREFERRED };
