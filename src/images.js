import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import { recordPhoto } from './usage.js';

// 저작권 걱정 없는 무료 이미지를 찾아 내려받습니다.
// 키가 없어도 Openverse(CC 라이선스)와 Picsum 으로 실제 사진을 받을 수 있습니다.
// 모든 소재가 막히면 프로그램이 직접 감성 카드 이미지를 그립니다(renderer 담당).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NaverBlogWriter/1.0';
const FALLBACK_QUERIES = [
  'soft morning light interior', 'calm desk notebook', 'warm sunlight window',
  'minimal workspace plant', 'quiet cafe table', 'pastel sky cloud',
];

const asciiWords = (text) => String(text ?? '')
  .replace(/[^a-zA-Z0-9 ]/g, ' ')
  .split(/\s+/)
  .filter((word) => word.length >= 2);

// 한글이 섞인 검색어는 영어 단어만 남깁니다. 남는 게 없으면 감성 키워드를 돌려 씁니다.
const toImageQuery = (query, index = 0) => {
  const words = asciiWords(query).slice(0, 4);
  if (words.length > 0) {
    return words.join(' ');
  }
  return FALLBACK_QUERIES[index % FALLBACK_QUERIES.length];
};

const pickRandom = (list, seed) => list[Math.abs(seed) % list.length];

// 검색어 단어 수를 줄입니다. 단어가 많으면 결과가 0건이 되는 서비스가 있습니다.
const trimWords = (query, count) => String(query ?? '').split(/\s+/).filter(Boolean).slice(0, count).join(' ');

const searchPixabay = async (query, lang = 'en') => {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) {
    return [];
  }
  const url = new URL('https://pixabay.com/api/');
  url.searchParams.set('key', key);
  url.searchParams.set('lang', lang);
  url.searchParams.set('q', trimWords(query, 3));
  url.searchParams.set('image_type', 'photo');
  url.searchParams.set('orientation', 'horizontal');
  url.searchParams.set('safesearch', 'true');
  url.searchParams.set('per_page', '20');
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return (data?.hits || []).map((hit) => ({
    url: hit.largeImageURL || hit.webformatURL,
    credit: `Pixabay / ${hit.user}`,
    license: 'Pixabay License (상업적 이용 가능, 출처 표기 불필요)',
    tags: String(hit.tags || ''),
  }));
};

const searchPexels = async (query) => {
  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    return [];
  }
  const url = new URL('https://api.pexels.com/v1/search');
  url.searchParams.set('query', trimWords(query, 3));
  // 블로그 이미지를 정사각형으로 만들기 때문에 처음부터 정사각형 사진을 찾습니다.
  url.searchParams.set('orientation', 'square');
  url.searchParams.set('per_page', '20');
  const response = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return (data?.photos || []).map((photo) => ({
    // 원본에서 1400px 정사각형으로 잘라 받아 화질을 지킵니다.
    url: photo.src?.original
      ? `${photo.src.original}?auto=compress&cs=tinysrgb&fit=crop&w=1400&h=1400`
      : (photo.src?.large2x || photo.src?.large),
    credit: `Pexels / ${photo.photographer}`,
    license: 'Pexels License (상업적 이용 가능, 출처 표기 불필요)',
    tags: String(photo.alt || ''),
  }));
};

const searchUnsplash = async (query) => {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) {
    return [];
  }
  const url = new URL('https://api.unsplash.com/search/photos');
  url.searchParams.set('query', trimWords(query, 3));
  url.searchParams.set('orientation', 'squarish');
  url.searchParams.set('per_page', '20');
  const response = await fetch(url, {
    headers: { Authorization: `Client-ID ${key}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return (data?.results || []).map((photo) => ({
    url: photo.urls?.raw
      ? `${photo.urls.raw}&w=1400&h=1400&fit=crop&q=90`
      : photo.urls?.regular,
    credit: `Unsplash / ${photo.user?.name}`,
    license: 'Unsplash License (상업적 이용 가능)',
    tags: `${photo.alt_description || ''} ${(photo.tags || []).map((tag) => tag.title).join(' ')}`,
  }));
};

// Openverse 의 Flickr 공공 저작물에는 미국 정부 기관 사진(군대, 농무부 행사)이 많이 섞여
// "asian family" 같은 검색에 엉뚱한 사진이 나옵니다. 제목에 이런 흔적이 있으면 뺍니다.
const OFF_TOPIC_TITLE = /\b(army|navy|soldiers?|military|marines?|usda|corps|air force|veterans?|ceremony|nasa)\b|^\d{6,}|\d{6,8}-[A-Z]{2,}/i;

// 키가 필요 없는 소재입니다.
// 저작권 걱정이 없도록 출처 표기도 필요 없는 CC0·퍼블릭 도메인 사진만 찾습니다.
// (CC BY 는 출처를 밝혀야 하므로 블로그에 그냥 쓰면 문제가 될 수 있어 뺍니다.)
// includeFlickr 가 false 면 정돈된 스톡 사진(StockSnap, Rawpixel 등)만 봅니다.
// Flickr 에는 글씨가 박힌 그래픽이나 행사 사진이 많아, 스톡에서 못 찾았을 때만 씁니다.
const searchOpenverse = async (query, includeFlickr = false) => {
  const search = async (excludeFlickr) => {
    const url = new URL('https://api.openverse.org/v1/images/');
    // Openverse 는 단어를 모두 포함하는 사진만 찾기 때문에 두 단어까지만 보냅니다.
    url.searchParams.set('q', trimWords(query, 2));
    url.searchParams.set('license', 'cc0,pdm');
    url.searchParams.set('category', 'photograph');
    url.searchParams.set('page_size', '20');
    url.searchParams.set('mature', 'false');
    if (excludeFlickr) {
      url.searchParams.set('excluded_source', 'flickr');
    }
    const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    return (data?.results || [])
      .filter((item) => !OFF_TOPIC_TITLE.test(String(item.title || '')))
      // 정사각형으로 자르면 짧은 쪽이 결과 크기가 되므로, 짧은 쪽이 900px 이상인 사진만 씁니다.
      .filter((item) => !item.width || !item.height || Math.min(item.width, item.height) >= 900)
      .map((item) => ({
        url: item.url,
        credit: `${item.source} / ${item.creator || '작자 미상'}`,
        license: `${String(item.license || '').toUpperCase()} (출처 표기 불필요)`,
        tags: `${item.title || ''} ${(item.tags || []).map((tag) => tag.name).join(' ')}`,
      }));
  };
  return search(!includeFlickr);
};

// 사람이 나오는 장면인지 봅니다. 사람 사진이면 아시아인 사진을 먼저 찾습니다.
const PEOPLE_WORDS = /\b(person|people|woman|women|man|men|girl|boy|child|children|kids?|bab(y|ies)|infant|toddler|family|mother|father|mom|dad|parents?|students?|couple|workers?|office|business\w*|teen\w*|elderly|senior|doctor|nurse|teacher|friends|portrait|pregnant|hands?|face|meeting|patient)\b/i;

const isPeopleQuery = (query) => PEOPLE_WORDS.test(String(query ?? ''));

// 사진 설명(태그)에 아시아인이라는 흔적이 있는지 봅니다.
// 사진 사이트는 검색어를 느슨하게 맞추기 때문에, "asian student exam" 으로 찾아도
// 상위 20장 중 아시아인 사진은 2~3장뿐입니다. 그래서 받은 뒤 태그로 한 번 더 거릅니다.
// 아시아 흔적만 보면 "asian hornet"(장수말벌) 같은 엉뚱한 사진이 걸리므로,
// 검색어의 나머지 낱말(student, business 등)도 태그에 하나 이상 있어야 통과시킵니다.
// 한국인·일본인·중국인(동아시아) 사진만 씁니다. 동남아·남아시아 흔적이 있으면 뺍니다.
const ASIAN_TAGS = /\b(asian?|east asian|korean?|korea|chinese|china|japanese|japan|taiwanese|taiwan)\b/i;
const NOT_EAST_ASIAN_TAGS = /\b(indian|india|vietnamese|vietnam|thai|thailand|filipino|filipina|philippines|indonesian|indonesia|malay\w*|cambodian|cambodia|burmese|myanmar|nepal\w*|bangladesh\w*|pakistan\w*|sri lanka\w*|hindu|sari|saree|turban|hijab|muslim|african|black|arab\w*|latin\w*|hispanic)\b/i;
// 사람 사진을 찾는 중이므로 태그에 사람을 가리키는 낱말도 있어야 합니다.
// ("asian business" 로 찾았더니 지폐로 접은 나비가 나온 적이 있습니다.)
const PERSON_TAGS = /\b(woman|women|man|men|girl|boy|people|person|student|child|children|kid|baby|infant|toddler|mother|father|mom|dad|family|couple|businessman|businesswoman|worker|teen\w*|portrait|lady|guy|female|male)\b/;
const looksAsian = (item, query) => {
  const tags = String(item.tags || '').toLowerCase();
  if (!ASIAN_TAGS.test(tags) || NOT_EAST_ASIAN_TAGS.test(tags) || !PERSON_TAGS.test(tags)) {
    return false;
  }
  const words = String(query ?? '').toLowerCase().split(/\s+/)
    .filter((word) => word.length >= 3 && !NATION_WORD.test(word));
  return words.length === 0 || words.some((word) => tags.includes(word));
};

// 검색어에서 사람을 가리키는 낱말을 뽑아 "asian ___" 두 단어 검색에 쓸 말로 바꿉니다.
// 두 단어("asian student", "asian baby")로 찾으면 상위 20장 중 거의 전부가 아시아인 사진입니다.
// 회사 장면은 "business" 만으로 찾으면 미용실·가게 사진도 걸려서, 사람을 콕 집는
// businessman / businesswoman 을 사진 순서(index)에 따라 번갈아 씁니다.
const personCore = (query, index = 0) => {
  const word = String(PEOPLE_WORDS.exec(String(query ?? ''))?.[1] || 'people').toLowerCase();
  const rules = [
    [/^(office|business\w*|meeting|workers?)$/, index % 2 === 0 ? 'businesswoman' : 'businessman'],
    [/^(bab(y|ies)|infant|toddler)$/, 'baby'],
    [/^(kids?|child|children|boy|girl)$/, 'child'],
    [/^students?$/, 'student'],
    [/^hands?$/, 'hands'],
    [/^(mom|mother|parents?)$/, 'mother'],
    [/^(dad|father)$/, 'father'],
    [/^women$/, 'woman'],
    [/^men$/, 'man'],
    [/^(elderly|senior)$/, 'elderly'],
    [/^(person|portrait|face|friends|teen\w*)$/, 'people'],
  ];
  const found = rules.find(([pattern]) => pattern.test(word));
  return found ? found[1] : word;
};

// 사진 순서(index)에 따라 한국인 → 일본인 → 중국인 순으로 돌려 가며 찾습니다.
const NATIONS = ['korean', 'japanese', 'chinese'];
const NATION_WORD = /^(asian|east|korean?|japanese|chinese)$/;

// 한 소재에서 차례로 시도할 검색어 목록을 만듭니다. 각 항목은 { q, asian } 입니다.
// asian 이 true 인 단계는 받은 사진 중 한·중·일 사람 태그가 있는 것만 남깁니다.
// 1) 국적 + 구체적인 검색어  2) asian + 구체적인 검색어
// 3) 국적 + 사람 낱말(두 단어)  4) asian + 사람 낱말  5) 원래 검색어  6) 줄인 검색어
// "korean student" 처럼 국적으로 찾으면 음식 사진이 섞이지만, 사람 태그 거름망이 걸러 냅니다.
const queryLadder = (query, { people = false, index = 0 } = {}) => {
  // AI 가 이미 asian/korean 등을 붙여 보냈으면 떼어 내고 다시 붙입니다. (asian asian 방지)
  const base = String(query ?? '').replace(/^((east\s+)?asian|korean|japanese|chinese)\s+/i, '').trim();
  const short = trimWords(base, 2);
  const nation = NATIONS[index % NATIONS.length];
  const core = personCore(base, index);
  const list = people
    ? [
      { q: `${nation} ${short}`, asian: true },
      { q: `asian ${short}`, asian: true },
      { q: `${nation} ${core}`, asian: true },
      { q: `asian ${core}`, asian: true },
      { q: base, asian: false },
      { q: short, asian: false },
    ]
    : [{ q: base, asian: false }, { q: short, asian: false }];
  const seen = new Set();
  return list.filter((item) => item.q && !seen.has(item.q) && seen.add(item.q));
};

// 마지막 안전망입니다. 저작권 걱정 없는 무료 사진을 주제 없이 받아 옵니다.
const picsumPhoto = (seed) => ([{
  url: `https://picsum.photos/seed/${encodeURIComponent(seed)}/1200/1200`,
  credit: 'Picsum Photos',
  license: '무료 사용 (Unsplash 기반 공개 이미지)',
}]);

const downloadImage = async (imageUrl) => {
  const response = await fetch(imageUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    throw new Error(`download ${response.status}`);
  }
  const type = response.headers.get('content-type') || '';
  if (!type.startsWith('image/')) {
    throw new Error('not an image');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 10000) {
    throw new Error('too small');
  }
  return { buffer, type };
};

// OpenAI 키가 있으면 GPT Image 2 가 사진 자리 설명대로 그림을 새로 그립니다.
// 키 발급: https://platform.openai.com/api-keys (sk-proj- 로 시작하는 키)
// 키 오류·잔액 부족·조직 인증처럼 다시 해도 안 되는 실패는 이번 실행 동안 OpenAI 를 쉬고 무료 사진을 씁니다.
let openaiBlocked = '';
let openaiBlockedReason = '';

// 충전 잔액이 없을 때의 응답입니다. 상태는 429(요청 한도와 같음)라 기다려도 소용없습니다.
// 2026-10 부터 code 가 'credit_balance_exhausted'("You have no credits remaining")로 바뀌어,
// 요청 한도로 착각해 사진마다 30초씩 기다리다 무료 사진으로 넘어갔습니다. (2026-10-05 실제 응답으로 확인)
const isOutOfCredit = (body) => /insufficient_quota|credit|billing/i.test(`${body?.error?.code || ''} ${body?.error?.type || ''} ${body?.error?.message || ''}`);

// reason 은 사진 기록(사진기록.csv)에 남기는 짧은 이유입니다. OpenAI 가 보낸 오류 코드를 괄호에 붙입니다.
const openaiNotice = (status, body) => {
  const code = `${body?.error?.code || ''} ${body?.error?.type || ''} ${body?.error?.message || ''}`.toLowerCase();
  const raw = ` (${body?.error?.code || body?.error?.type || `응답 ${status}`})`;
  if (status === 401) {
    return { stop: true, reason: `키 오류${raw}`, message: 'OpenAI 키가 맞지 않아 무료 사진으로 대신합니다. .env 의 OPENAI_API_KEY 를 확인해 주세요.' };
  }
  if (isOutOfCredit(body)) {
    return { stop: true, reason: `충전 잔액 없음${raw}`, message: 'OpenAI 충전 잔액이 없어 무료 사진으로 대신합니다. platform.openai.com 의 Billing 에서 충전해 주세요.' };
  }
  if (code.includes('verif')) {
    return { stop: true, reason: `조직 인증 필요${raw}`, message: 'OpenAI 조직 인증이 필요해 무료 사진으로 대신합니다. platform.openai.com 의 Settings → Organization → Verify 에서 인증한 뒤 15분쯤 기다려 주세요.' };
  }
  if (code.includes('moderation') || code.includes('safety')) {
    return { stop: false, reason: `안전 규칙에 걸림${raw}`, message: '사진 설명 하나가 OpenAI 안전 규칙에 걸려, 순한 장면으로 세 번 다시 그려도 안 되어 그 사진만 무료 사진으로 대신했습니다.' };
  }
  if (status === 403 || status === 404) {
    return { stop: true, reason: `모델 사용 권한 없음${raw}`, message: `이 OpenAI 키로는 ${process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2'} 를 쓸 수 없어 무료 사진으로 대신합니다.` };
  }
  return { stop: false, reason: `그림 실패${raw}`, message: `GPT Image 2 그림을 만들지 못해 무료 사진으로 대신했습니다. (응답 ${status})` };
};

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 모든 그림에 붙이는 공통 규칙입니다.
// - 콜라주 금지: "글 전체를 한눈에"라고 하면 여러 칸으로 나눈 그림이 나오곤 했습니다.
// - 아이의 맨살·질병 증상을 가까이 그리지 않기: 아기 + 두드러기·구토 같은 내용은 OpenAI 안전 규칙에 걸려
//   그 사진만 엉뚱한 무료 사진으로 바뀌었습니다(2026-10-02 "볼에 두드러기가 난 아기").
// 육아 주제가 아니면 아이·아기·부모를 그리지 않습니다. (사용자 요청 2026-10-03)
const IMAGE_RULES_COMMON = `자연광, 정사각형(1:1) 구도, 카메라로 찍은 듯한 실사 사진 한 장(그림·만화·3D 렌더링 느낌 금지).
여러 칸으로 나눈 콜라주, 인포그래픽, 도표, 일러스트 판넬은 만들지 않습니다. 여러 물건과 사람은 한 장소의 한 장면 안에 함께 둡니다.
글자, 숫자, 로고, 워터마크, 말풍선은 넣지 않습니다. 이름표·안내문·체크리스트처럼 글씨가 있을 물건도 글씨 없이 빈 칸이나 그림 표시로만 그립니다.`;
const imageRules = (parenting) => (parenting
  ? `사람이 나오면 한국인으로, 부모가 나오면 글쓴이(예: 아빠)로 그립니다.
아이의 맨살, 상처, 피, 발진, 구토 같은 질병 증상은 가까이 보여 주지 않고, 걱정스럽게 아이를 살피는 부모의 모습이나 관련 물건으로 분위기만 전합니다.
${IMAGE_RULES_COMMON}`
  : `육아 글이 아닙니다. 아이, 아기, 어린이, 부모와 아이가 함께 있는 가족 장면은 그리지 않습니다. 사람이 나오면 한국인 성인만 그립니다.
상처, 피 같은 장면은 가까이 보여 주지 않고 관련 물건이나 분위기로만 전합니다.
${IMAGE_RULES_COMMON}`);

// 안전 규칙에 걸리면 차례로 더 순한 지시로 다시 그립니다. 그래도 안 되면 그때만 무료 사진을 씁니다.
// 1번째 지시: 서론·소제목·결론마다 그 구역 내용을 최종 정리하는 물건·사람 장면 (사용자 요청 2026-10-05)
// 글 내용(context)은 content.js 가 "구역: …", "정리할 핵심: …", 그 구역 글 순서로 붙여 보냅니다.
const SUMMARY_SCENE = `이 사진은 아래 '구역'의 글 내용을 최종적으로 정리해 보여 주는 장면입니다. 글을 읽은 사람이 사진 한 장만 보고도 그 구역의 결론('정리할 핵심')을 떠올릴 수 있어야 합니다.
- 글에 실제로 나온 구체적인 물건(도구·제품·음식·서류·기기 등) 2~4가지를 골라 한 장면에 함께 보이게 놓습니다. 글에 없는 물건은 넣지 않습니다.
- 정리할 핵심이 행동·방법·상담이면 그대로 하고 있는 사람을 함께 넣습니다(예: 방법을 실천하는 모습, 전문가에게 확인받는 모습). 사람과 물건은 그 내용에 어울리는 실제 장소(욕실, 진료실, 부엌, 책상 등) 한 곳에 함께 있습니다.
- 구역이 서론이면 독자가 겪는 고민 상황과 이 글이 풀어 줄 해결의 실마리를, 본론 소제목이면 그 소제목의 결론(방법·기준·선택)을, 결론이면 글이 권하는 대로 실천하는 모습과 핵심 물건을, 글 전체면 글 주제를 한눈에 담습니다.
- 다른 구역 사진과 겹치지 않게 그 구역에만 나온 물건·행동을 가운데에 둡니다.
- 장면 힌트가 글 내용과 어긋나거나 막연하면 글 내용을 따릅니다. 글과 상관없는 풍경·꽃·일반적인 분위기 사진은 만들지 않습니다.`;

// 맨 위 썸네일: 제목의 궁금증을 키우는 장면. 아래쪽에는 renderer/imagelab.js 가 문구를 얹습니다. (사용자 요청 2026-10-08)
const THUMBNAIL_SCENE = `이 사진은 블로그 글 맨 위 썸네일(네이버 목록에 작게 보이는 대표 사진)입니다. 제목을 본 사람이 "왜 그럴까?" 하고 궁금해지는 순간을 한 장면으로 담습니다.
- 답(해결책·결과)은 보여 주지 않고, 그 주제로 고민하거나 의아해하는 사람의 표정·몸짓, 또는 궁금증을 부르는 핵심 물건을 가까이 보여 줍니다.
- 작게 보여도 무엇인지 알아볼 수 있게 주인공과 핵심 물건을 크게 담고 배경은 단순하게 둡니다.
- 아래쪽 3분의 1에는 프로그램이 문구를 얹으므로, 얼굴과 핵심 물건은 위쪽 3분의 2 안에 두고 아래쪽은 탁자·바닥·벽처럼 단순한 면으로 둡니다.
- 장면 힌트가 글 내용과 어긋나면 글 내용을 따릅니다.`;

const openaiPrompts = ({ scene, topic, context, heading, parenting = true, thumbnail = false }) => [
  context && thumbnail
    ? `블로그 글 맨 위에 넣을 썸네일 사진 한 장을 만들어 주세요.
${THUMBNAIL_SCENE}
글 내용:
${context}
장면 힌트: ${scene}.${topic}
${imageRules(parenting)}`
    : context
    ? `블로그 글의 한 구역에 넣을 사진 한 장을 만들어 주세요.
${SUMMARY_SCENE}
글 내용:
${context}
장면 힌트: ${scene}.${topic}
${imageRules(parenting)}`
    : `블로그에 넣을 이미지. 장면: ${scene}.${topic}
${imageRules(parenting)}`,
  // 2번째: 글 내용 없이 편안한 장면으로 (육아면 부모가 아이를 돌보는 장면, 아니면 성인이 주제와 관련된 일을 하는 장면)
  parenting
    ? `육아 블로그 글 "${heading || scene}"에 넣을 이미지 한 장.${topic} 집 안에서 부모가 아이를 다정하게 돌보거나 살피는 편안한 일상 장면.
${imageRules(parenting)}`
    : `블로그 글 "${heading || scene}"에 넣을 이미지 한 장.${topic} 한국인 성인이 주제와 관련된 일을 차분하게 하고 있는 편안한 일상 장면.
${imageRules(parenting)}`,
  // 3번째: 사람 없이 관련 물건만
  `${parenting ? '육아 ' : ''}블로그 글 "${heading || scene}"에 넣을 이미지 한 장.${topic} 사람은 나오지 않고, 주제와 관련된 물건(${parenting ? '음식, 그릇, 수첩, 육아용품 등' : '책, 노트, 도구, 기기 등'})만 책상이나 식탁 위에 정갈하게 놓인 정물 사진.
${imageRules(parenting)}`,
];

const isSafetyBlock = (body) => /moderation|safety/i.test(`${body?.error?.code || ''} ${body?.error?.type || ''} ${body?.error?.message || ''}`);

const generateOpenAI = async ({ query, koQuery, caption, context = '', parenting = true, thumbnail = false }) => {
  const key = process.env.OPENAI_API_KEY;
  // 그림을 안 그린 까닭(reason)은 사진 기록에 남깁니다. 안내(notice)가 없으니 화면 기록에는 나오지 않습니다.
  if (!key) {
    return { reason: 'OpenAI 키 없음' };
  }
  if (openaiBlocked) {
    return { reason: `${openaiBlockedReason} — 이번 실행 동안 OpenAI 쉼` };
  }
  // 설명이 문장이면 끝 마침표를 떼어 "장면 힌트: ….." 처럼 겹치지 않게 합니다.
  const scene = (String(caption || '').trim() || String(koQuery || '').trim() || String(query || '').trim()).replace(/[.。\s]+$/, '');
  if (!scene) {
    return { reason: '사진 설명 없음' };
  }
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const topic = koQuery && koQuery !== scene ? ` 글 주제: ${koQuery}.` : '';
  // 소제목 사진의 글 내용은 "소제목: …" 줄로 시작합니다. 순한 지시에서는 그 소제목만 씁니다.
  const heading = /소제목:\s*([^\n]+)/.exec(context)?.[1]?.split(' / ')[0] || /제목:\s*([^\n]+)/.exec(context)?.[1] || '';
  const prompts = openaiPrompts({ scene, topic, context, heading, parenting, thumbnail });
  let safetyNotice = '';
  let safetyReason = '';
  for (let level = 0; level < prompts.length; level += 1) {
    const prompt = prompts[level];
    // 처음 결제한 계정은 1분에 5장까지라, 한도에 걸리면 알려 준 시간만큼 기다렸다가 두 번까지 다시 합니다.
    let result = null;
    for (let attempt = 0; attempt < 3 && !result; attempt += 1) {
      let response;
      try {
        response = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt,
            n: 1,
            size: process.env.OPENAI_IMAGE_SIZE || '1024x1024',
            quality: process.env.OPENAI_IMAGE_QUALITY || 'low',
          }),
          signal: AbortSignal.timeout(180000),
        });
      } catch (error) {
        return { reason: '시간 초과', notice: 'GPT Image 2 그림이 너무 오래 걸려 무료 사진으로 대신했습니다.' };
      }
      const body = await response.json().catch(() => null);
      if (response.ok) {
        const b64 = body?.data?.[0]?.b64_json;
        if (!b64) {
          return { reason: '그림 없는 응답', notice: 'GPT Image 2 가 그림을 돌려주지 않아 무료 사진으로 대신했습니다.' };
        }
        const buffer = Buffer.from(b64, 'base64');
        const type = buffer[0] === 0x89 ? 'image/png' : buffer[0] === 0xff ? 'image/jpeg' : 'image/webp';
        return {
          ok: true,
          dataUrl: `data:${type};base64,${b64}`,
          credit: `OpenAI / ${model}`,
          license: 'AI 생성 이미지',
          query: scene,
          // 사진 기록의 금액 계산용 사용량(토큰)입니다.
          usage: body?.usage,
          reason: level > 0 ? `안전 규칙에 걸려 순한 장면으로 ${level}번 다시 그림` : '',
          // 순한 지시로 다시 그렸으면 화면 기록에 한 번 알립니다.
          notice: level > 0 ? '사진 설명 하나가 OpenAI 안전 규칙에 걸려, 그 사진은 증상 없이 순한 장면으로 다시 그렸습니다.' : undefined,
        };
      }
      const quota = isOutOfCredit(body);
      if (response.status === 429 && !quota && attempt < 2) {
        const seconds = Number(response.headers.get('retry-after')) || 15;
        await wait(Math.min(seconds, 60) * 1000);
        continue;
      }
      if (response.status === 429 && !quota) {
        return { reason: `요청 한도 초과 (${body?.error?.code || 429})`, notice: 'OpenAI 요청 한도에 계속 걸려 무료 사진으로 대신했습니다. 잠시 뒤 다시 해 주세요.' };
      }
      if (isSafetyBlock(body)) {
        // 안전 규칙: 다음(더 순한) 지시로 넘어갑니다.
        ({ message: safetyNotice, reason: safetyReason } = openaiNotice(response.status, body));
        result = 'next';
        break;
      }
      const { stop, message, reason } = openaiNotice(response.status, body);
      if (stop) {
        openaiBlocked = message;
        openaiBlockedReason = reason;
      }
      return { reason, notice: message };
    }
  }
  return { reason: safetyReason ? `${safetyReason} — 순한 장면도 모두 걸림` : '그림 실패', notice: safetyNotice || 'GPT Image 2 그림을 만들지 못해 무료 사진으로 대신했습니다.' };
};

// 구독 키가 있으면 Pollinations 가 주제 그림을 새로 그립니다.
// 키 발급: https://enter.pollinations.ai
const generatePollinations = async ({ query, koQuery, caption, index }) => {
  const key = process.env.POLLINATIONS_API_KEY;
  if (!key) {
    return null;
  }
  const model = process.env.POLLINATIONS_MODEL || 'flux';
  const subject = [koQuery, caption, query].map((item) => String(item || '').trim()).filter(Boolean).join(', ');
  if (!subject) {
    return null;
  }
  const prompt = `Photorealistic photo, natural light, square frame, no text, no letters, no watermark, no logo. Subject: ${subject}`;
  const url = new URL(`https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}`);
  url.searchParams.set('model', model);
  url.searchParams.set('width', '1024');
  url.searchParams.set('height', '1024');
  url.searchParams.set('nologo', 'true');
  url.searchParams.set('seed', String(index + 1));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    throw new Error(`pollinations ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 8000) {
    throw new Error('pollinations too small');
  }
  const headerType = (response.headers.get('content-type') || '').split(';')[0];
  const type = headerType.startsWith('image/') ? headerType : (buffer[0] === 0x89 ? 'image/png' : 'image/jpeg');
  return {
    ok: true,
    dataUrl: `data:${type};base64,${buffer.toString('base64')}`,
    credit: `Pollinations / ${model}`,
    license: 'AI 생성 이미지',
    query: subject,
  };
};

// 소재를 순서대로 돌며 쓸 수 있는 사진 하나를 내려받아 base64 로 돌려줍니다.
const fetchPhoto = async (options) => {
  // 1순위 GPT Image 2 → 2순위 Pollinations → 무료 사진. 그림 실패 안내(notice)는 무료 사진 결과에 붙여 돌려줍니다.
  const generated = await generateOpenAI(options);
  const photo = generated?.dataUrl ? generated : await fetchStockPhoto(options);
  // 사진마다 출처·GPT 를 못 쓴 이유·금액을 data/logs/사진기록.csv 에 남기고, 요약(record)을 화면에 돌려줍니다.
  let kind = 'stock';
  if (generated?.dataUrl) {
    kind = 'gpt';
  } else if (!photo.dataUrl) {
    kind = 'none';
  } else if (/^Pollinations/.test(photo.credit || '')) {
    kind = 'pollinations';
  }
  const record = recordPhoto({
    topic: options.koQuery,
    caption: options.caption,
    kind,
    credit: photo.credit,
    reason: generated?.reason || '',
    usage: generated?.usage,
  });
  const { usage, reason, ...rest } = photo;
  return { ...rest, notice: generated?.notice || photo.notice, record };
};

// 육아 주제가 아니면 무료 사진 검색어에서 아이·아기·부모 낱말을 뺍니다. (다 빠지면 원래 검색어의 나머지로 찾음)
const CHILD_QUERY_WORDS = /\b(bab(y|ies)|infants?|toddlers?|kids?|child(ren)?|boys?|girls?|newborns?|mom|mother|dad|father|parents?|family|nursery)\b/gi;

const fetchStockPhoto = async (options) => {
  const adultQuery = String(options.query || '').replace(CHILD_QUERY_WORDS, ' ').replace(/\s+/g, ' ').trim();
  return fetchStockPhotoBy(options.parenting === false
    ? { ...options, query: adultQuery || 'desk notebook' }
    : options);
};

const fetchStockPhotoBy = async ({ query, koQuery = '', caption = '', index = 0, seed = Date.now() }) => {
  if (process.env.POLLINATIONS_API_KEY) {
    try {
      const generated = await generatePollinations({ query, koQuery, caption, index });
      if (generated?.dataUrl) {
        return generated;
      }
    } catch (error) {
      // 구독 그림이 실패하면 아래 무료 사진으로 넘어갑니다.
    }
  }
  const searchQuery = toImageQuery(query, index);
  const people = isPeopleQuery(searchQuery);
  // 각 소재마다 검색어 사다리를 차례로 내려가며, 결과가 나오는 첫 검색어를 씁니다.
  const ladder = queryLadder(searchQuery, { people, index });
  const attempts = [];
  // 사진마다 붙은 영어 설명(예: tongue cleaner toothbrush)으로 먼저 찾습니다.
  // 예전에는 한국어 주제어(글 전체 같은 낱말)로 Pixabay 를 먼저 찾았는데, 느슨하게 맞춰
  // "입냄새원인"에 가오리·꽃·카레 사진이 나오고 사진마다 비슷해졌습니다. (2026-10-05 실제 검색으로 확인)
  // 한국어 주제어 검색은 영어로 찾은 사진이 하나도 없을 때만, 분위기 사진 바로 앞에서 씁니다.
  const finders = [
    { source: searchPixabay, lang: 'en' },
    { source: searchPexels },
    { source: searchUnsplash },
    { source: (q) => searchOpenverse(q, false) },
    { source: (q) => searchOpenverse(q, true) },
  ];
  // 사람 사진은 모든 사이트에서 한·중·일 사진을 먼저 찾아본 뒤에야 거름망 없는 검색으로 넘어갑니다.
  // (한 사이트의 거름망 없는 검색이 다음 사이트의 한·중·일 검색보다 앞서면 서양인 사진이 걸립니다.)
  const eastAsian = ladder.filter((rung) => rung.asian);
  const plain = ladder.filter((rung) => !rung.asian);
  if (eastAsian.length > 0) {
    attempts.push(...finders.map((finder) => ({ ...finder, ladder: eastAsian })));
  }
  attempts.push(...finders.map((finder) => ({ ...finder, ladder: plain })));
  if (koQuery && !people && process.env.PIXABAY_API_KEY) {
    attempts.push({ source: searchPixabay, ladder: [{ q: koQuery, asian: false }], lang: 'ko' });
  }
  attempts.push(
    // 주제 사진을 못 찾으면 분위기 사진이라도 찾습니다. 무작위 사진보다 글과 어울립니다.
    { source: (q) => searchOpenverse(q, false), ladder: [{ q: FALLBACK_QUERIES[index % FALLBACK_QUERIES.length], asian: false }] },
  );
  for (let finderIndex = 0; finderIndex < attempts.length; finderIndex += 1) {
    const { source, ladder: rungs, lang } = attempts[finderIndex];
    let candidates = [];
    let usedQuery = searchQuery;
    for (let rung = 0; rung < rungs.length && candidates.length === 0; rung += 1) {
      try {
        const found = (await source(rungs[rung].q, lang)).filter((item) => item.url);
        candidates = rungs[rung].asian ? found.filter((item) => looksAsian(item, rungs[rung].q)) : found;
        usedQuery = rungs[rung].q;
      } catch (error) {
        candidates = [];
      }
    }
    // 같은 글 안에서 사진이 겹치지 않도록 순서를 섞어 고릅니다.
    for (let step = 0; step < Math.min(candidates.length, 5); step += 1) {
      const candidate = candidates[(index * 3 + step) % candidates.length];
      try {
        const { buffer, type } = await downloadImage(candidate.url);
        return {
          ok: true,
          dataUrl: `data:${type};base64,${buffer.toString('base64')}`,
          credit: candidate.credit,
          license: candidate.license,
          query: usedQuery,
        };
      } catch (error) {
        // 다음 후보로 넘어갑니다.
      }
    }
  }
  const fallback = picsumPhoto(`${seed}-${index}`)[0];
  try {
    const { buffer, type } = await downloadImage(fallback.url);
    return {
      ok: true,
      dataUrl: `data:${type};base64,${buffer.toString('base64')}`,
      credit: fallback.credit,
      license: fallback.license,
      query: searchQuery,
    };
  } catch (error) {
    return { ok: false, dataUrl: null, credit: '', license: '', query: searchQuery };
  }
};

const saveImage = (dataUrl, name) => {
  const match = /^data:(image\/\w+);base64,(.+)$/s.exec(String(dataUrl ?? ''));
  if (!match) {
    throw new Error('bad data url');
  }
  const ext = match[1] === 'image/png' ? 'png' : 'jpg';
  const safe = String(name || 'image').replace(/[^\w가-힣-]/g, '').slice(0, 40) || 'image';
  const filePath = path.join(PATHS.images, `${safe}.${ext}`);
  fs.mkdirSync(PATHS.images, { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  return filePath;
};

export { fetchPhoto, saveImage, toImageQuery, pickRandom, isPeopleQuery, queryLadder };
