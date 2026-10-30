import { formalize, polish, toFormal, tidy, splitSentences, countChars, fixParticlesFor } from './style.js';
import { buildTopicSection, categoryOf, topicImageHint, isParentingTopic } from './topics.js';

// 키워드만 입력했을 때 쓰는 제목 틀입니다. 핵심 키워드가 제목 앞에 오게 만듭니다.
const TITLE_FORMS = [
  (kw, m1, m2) => (m1 && m2 ? `${kw} 총정리, ${m1}부터 ${m2}까지 한 번에` : `${kw} 총정리, 핵심만 모아 정리합니다`),
  (kw, m1) => (m1 ? `${kw} ${m1} 정리, 확인 순서까지 담았습니다` : `${kw} 정리, 확인 순서까지 담았습니다`),
  (kw, m1) => (m1 ? `${kw} 알아보기｜${m1}과 놓치기 쉬운 부분` : `${kw} 알아보기｜놓치기 쉬운 부분까지`),
  (kw, m1) => (m1 ? `${kw} ${m1}, 처음이라면 이 순서대로 보시면 됩니다` : `${kw}, 처음이라면 이 순서대로 보시면 됩니다`),
];

const hashOf = (text) => {
  let value = 0;
  [...String(text ?? '')].forEach((char) => {
    value = (value * 31 + char.codePointAt(0)) % 100000;
  });
  return value;
};

const makeTitle = (keyword, subKeywords = [], modifiers = []) => {
  const form = TITLE_FORMS[hashOf(keyword) % TITLE_FORMS.length];
  const title = form(keyword, modifiers[0] || '', modifiers[1] || '');
  // 네이버 검색 결과에서 잘리지 않도록 길이를 맞춥니다.
  if (title.length <= 40) {
    return title;
  }
  const short = `${keyword} 총정리, 핵심만 모아 정리합니다`;
  return short.length <= 40 ? short : keyword;
};

const joinKeywords = (list) => list.filter(Boolean).join(', ');

const squeeze = (text) => String(text ?? '').replace(/\s+/g, '');

// 태그를 만듭니다(기본 7개). 입력 키워드와 조사한 연관 키워드를 섞습니다.
const makeTags = (keywords, related = [], limit = 7) => {
  const main = squeeze(keywords[0] || '정보');
  const base = keywords.filter(Boolean).map(squeeze);
  const extra = related.map(squeeze).filter((item) => item.length >= 2 && item.length <= 14);
  const tail = [`${main}정리`, `${main}방법`, `${main}가이드`, `${main}후기`, '생활정보', '정보공유', '꿀팁', '육박사'];
  const seen = new Set();
  const tags = [];
  // 연관 검색어 태그는 4개까지만 씁니다. 비슷한 태그가 너무 많으면 스팸처럼 보입니다.
  [...base, ...extra.slice(0, 4), ...tail].forEach((item) => {
    const key = item.toLowerCase();
    if (!item || seen.has(key) || tags.length >= limit) {
      return;
    }
    seen.add(key);
    tags.push(item);
  });
  return tags.slice(0, limit);
};

// 연관 검색어에서 뒤에 붙는 말(궁금해하는 부분)만 뽑아냅니다.
// 예) "아기 뒤집기 시기 100일" -> "100일", "아기 뒤집기 시기 침대" -> "침대"
const modifiersOf = (keyword, related = []) => {
  const tokens = String(keyword ?? '').split(/\s+/).filter(Boolean);
  const seen = new Set();
  const list = [];
  related.forEach((item) => {
    let rest = String(item ?? '');
    tokens.forEach((token) => {
      rest = rest.split(token).join(' ');
    });
    rest = rest.replace(/\s+/g, ' ').trim();
    const key = rest.replace(/\s/g, '');
    if (!rest || rest.length > 12 || seen.has(key)) {
      return;
    }
    seen.add(key);
    list.push(rest);
  });
  return list;
};

// 같은 성격의 연관 검색어만 뽑히지 않도록, 묻는 내용이 겹치지 않게 고릅니다.
const pickModifiers = (modifiers, limit = 3) => {
  const used = new Map();
  const picked = [];
  modifiers.forEach((item) => {
    if (picked.length >= limit) {
      return;
    }
    const id = categoryOf(item).id;
    const count = used.get(id) || 0;
    if (count >= 1 && id !== 'default') {
      return;
    }
    used.set(id, count + 1);
    picked.push(item);
  });
  // 종류가 모자라면 남은 것에서 채웁니다.
  modifiers.forEach((item) => {
    if (picked.length < limit && !picked.includes(item)) {
      picked.push(item);
    }
  });
  return picked;
};

// API 키가 없을 때도 1500자 이상 글이 나오도록 만든 기본 틀입니다.
const localDraft = ({ keyword, subKeywords = [], related = [], title }) => {
  const kw = keyword;
  const modifiers = pickModifiers(modifiersOf(keyword, related), 3);
  // 제목에는 언제, 어디처럼 단독으로 쓰면 어색한 말은 넣지 않습니다.
  const QUESTION_WORDS = ['언제', '어디', '얼마', '왜', '어떻게', '뭐', '무엇'];
  // 제목에는 조금 더 구체적인 말을 먼저 씁니다.
  const titleModifiers = modifiers
    .filter((item) => !QUESTION_WORDS.includes(item))
    .sort((left, right) => right.length - left.length);
  const sub1 = subKeywords[0] || (modifiersOf(keyword, related)[0] ? `${keyword} 관련 정보` : related[0]) || kw;
  const sub2 = subKeywords[1] || related[1] || sub1;
  const relatedText = related.slice(0, 4).join(', ') || `${kw} 관련 정보`;
  // 키워드를 그대로 반복하면 읽기 불편하므로 궁금해하는 말만 뽑아 씁니다.
  const askedText = modifiers.slice(0, 3).join(', ');

  const intro = {
    paragraphs: [
      `${kw}을 검색해 보셨다면 비슷한 경험을 하셨을 것입니다. 설명은 분명 많은데 내 상황에 딱 맞는 한 줄이 보이지 않아서, 창을 여러 개 띄워 두고 비교만 하다가 시간이 지나갑니다.`,
      askedText
        ? `실제로 ${kw}을 찾는 분들은 ${askedText} 같은 부분을 함께 검색합니다. 그래서 이 글은 그 질문들을 하나씩 짚는 순서로 정리했습니다. 읽는 순서가 곧 확인하는 순서입니다.`
        : `그래서 이 글은 ${kw}을 처음 찾아보는 분도 그대로 따라갈 수 있도록 개념, 확인 기준, 진행 순서, 자주 하는 실수 순으로 정리했습니다. 읽는 순서가 곧 확인하는 순서입니다.`,
      `끝까지 보시면 세 가지가 남습니다. 무엇을 먼저 확인해야 하는지, 내 상황이 기준에 맞는지, 그리고 다음에 다시 검색하지 않으려면 무엇을 적어 두어야 하는지입니다. 읽는 시간은 3분 정도입니다.`,
    ],
    highlight: `${kw}은 정보를 많이 모으는 것보다 확인하는 순서를 정하는 쪽이 결과를 더 크게 바꿉니다.`,
  };

  const sections = [
    {
      heading: `${kw}이 정확히 무엇인지부터 정리합니다`,
      paragraphs: [
        `${kw}을 다루는 글은 많지만 기준이 되는 개념 설명은 생각보다 찾기 어렵습니다. 먼저 ${kw}이 어떤 상황에서 필요한 내용인지, 어디까지를 범위로 보는지 선을 그어 두면 이후 정보를 판단할 기준이 생깁니다.`,
        `핵심은 세 가지로 나뉩니다. 첫째는 적용되는 대상과 조건입니다. 둘째는 진행할 때 필요한 준비물과 사전 확인 사항입니다. 셋째는 결과를 확인하고 기록해 두는 방법입니다.`,
        `이 세 가지를 구분해 두면 검색 결과가 서로 달라 보여도 당황하지 않습니다. 같은 주제를 설명하더라도 글마다 다루는 범위가 다를 뿐이라는 점을 알 수 있기 때문입니다.`,
      ],
      highlight: `개념을 먼저 정리해 두면 ${kw} 정보를 비교할 기준이 생깁니다.`,
      imageQuery: "open notebook soft morning light",
      imageCaption: `${kw} 기본 개념 정리`,
    },
    {
      heading: `${kw} 시작 전에 확인할 기준을 정리합니다`,
      paragraphs: [
        `준비 없이 시작하면 중간에 멈추고 다시 찾아보는 일이 반복됩니다. ${kw}을 진행하기 전에는 목적과 일정, 비용, 대체 방법 네 가지를 미리 적어 두는 방식이 도움이 됩니다.`,
        `목적은 한 문장으로 적어 두는 쪽이 좋습니다. 일정은 가능한 기간을 넉넉하게 잡고, 비용은 예상 금액과 최대 금액을 나누어 정리합니다. 대체 방법까지 메모해 두면 상황이 바뀌어도 처음부터 다시 알아볼 필요가 없습니다.`,
        `${sub1}을 함께 확인해 두는 것도 좋은 방법입니다. 같은 주제라도 조건에 따라 선택이 달라지기 때문에, 비교 대상을 하나 더 두면 판단이 훨씬 편해집니다.`,
      ],
      highlight: `목적과 일정, 비용, 대체 방법을 적어 두는 것만으로도 ${kw} 준비의 절반은 끝납니다.`,
      imageQuery: "checklist planner desk minimal",
      imageCaption: `${kw} 사전 확인 기준`,
    },
    {
      heading: `${kw} 진행 순서를 단계별로 정리합니다`,
      paragraphs: [
        `1단계는 정보 정리입니다. 공식 안내나 신뢰할 수 있는 자료를 먼저 확인하고, 후기 글은 보조 자료로 둡니다. 순서를 바꾸면 필요한 정보보다 분위기에 끌려가기 쉽습니다.`,
        `2단계는 조건 확인입니다. 본인 상황에 맞는 기준인지 하나씩 확인하고, 맞지 않는 항목은 따로 표시해 둡니다. 3단계는 실제 진행이며, 이때는 앞에서 정리한 메모를 그대로 따라가면 됩니다.`,
        `4단계는 기록과 점검입니다. 진행한 날짜와 결과, 다음에 바꿀 점을 짧게 남겨 두면 두 번째부터는 걸리는 시간이 크게 줄어듭니다. ${sub2}처럼 이어지는 주제를 다룰 때도 이 기록이 그대로 쓰입니다.`,
      ],
      highlight: `정보 정리, 조건 확인, 진행, 기록 네 단계만 지켜도 ${kw} 과정이 단순해집니다.`,
      imageQuery: "stairs sunlight step calm",
      imageCaption: `${kw} 단계별 진행 순서`,
    },
    {
      heading: `${kw}에서 자주 나오는 실수와 해결 방법입니다`,
      paragraphs: [
        `가장 흔한 실수는 정보를 너무 많이 모으는 것입니다. 검색 결과를 끝까지 보려다가 결정을 미루게 되고, 결국 처음 본 글로 돌아가는 경우가 많습니다. 자료는 세 곳 정도로 제한하는 편이 낫습니다.`,
        `두 번째 실수는 조건을 확인하지 않고 그대로 따라 하는 것입니다. 같은 주제라도 상황이 다르면 결과가 달라지므로, 글에 적힌 조건과 본인 상황이 같은지 먼저 맞춰 봐야 합니다.`,
        `세 번째 실수는 기록을 남기지 않는 것입니다. 기억에만 의존하면 다음에 다시 검색하게 되고 같은 고민을 반복합니다. 메모 한 줄이 다음 검색 시간을 아껴 줍니다.`,
      ],
      highlight: `자료는 세 곳으로 줄이고, 조건을 맞춰 보고, 결과를 한 줄로 기록하면 ${kw} 실수는 대부분 사라집니다.`,
      imageQuery: "person thinking window warm light",
      imageCaption: `${kw} 실수 줄이는 방법`,
    },
    {
      heading: modifiers.length > 0
        ? `${kw}과 함께 확인하면 좋은 정보입니다`
        : `${sub1} 함께 알아두면 도움이 되는 정보입니다`,
      paragraphs: [
        `${kw}을 찾는 분들은 ${relatedText} 같은 내용도 함께 확인하는 경우가 많습니다. 서로 이어지는 주제이기 때문에 한 번에 정리해 두면 나중에 다시 검색할 일이 줄어듭니다.`,
        `연관 주제를 볼 때는 공통된 기준이 있는지 살펴보는 것이 좋습니다. 기준이 같다면 하나의 메모로 묶어 관리할 수 있고, 기준이 다르다면 구분해서 적어 두면 혼동을 막을 수 있습니다.`,
        `마지막으로 체크리스트를 만들어 두시기 바랍니다. 목적, 조건, 준비물, 일정, 기록 다섯 항목만 있어도 ${kw}과 ${sub2}을 함께 관리하기에 충분합니다.`,
      ],
      highlight: `연관 주제를 하나의 메모로 묶어 두면 ${kw} 정보가 쌓일수록 검색 시간이 줄어듭니다.`,
      imageQuery: "tidy desk coffee warm tone",
      imageCaption: `${sub1} 함께 정리하기`,
    },
  ];

  // 연관 검색어가 잡히면 사람들이 실제로 찾는 소제목을 개념 설명 다음에 끼워 넣습니다.
  // 연관 검색어로 만든 소제목을 먼저 넣고, 모자라면 기본 소제목으로 채워 5개 이상을 맞춥니다.
  const usedIds = new Set(modifiers.map((item) => categoryOf(item).id));
  const fillers = [];
  if (!usedIds.has('standard')) {
    fillers.push(sections[1]);
  }
  if (!usedIds.has('method')) {
    fillers.push(sections[2]);
  }
  const middle = [...modifiers.map((item, index) => buildTopicSection(kw, item, index)), ...fillers];
  if (middle.length < 2) {
    middle.push(sections[1], sections[2]);
  }
  const middleSections = middle.slice(0, 4);
  const chosen = modifiers.length > 0
    ? [sections[0], ...middleSections, sections[3], sections[4]]
    : sections;
  // 사진이 주제에서 멀어지지 않도록 모든 소제목 검색어 앞에 주제 검색어를 붙입니다.
  // 예) 주제 "baby hands" + 소제목 "calendar planner" -> "baby hands calendar"
  // 결과가 없으면 사진 검색 쪽에서 단어를 줄여 주제어("baby hands")만 남깁니다.
  const hint = topicImageHint(keyword);
  const finalSections = chosen.map((section) => (
    hint ? { ...section, imageQuery: `${hint} ${String(section.imageQuery || '').split(/\s+/)[0]}`.trim() } : section
  ));

  const conclusion = {
    // 마무리는 본문 소제목마다 핵심 문장을 하나씩 이어 전체 내용을 요약합니다.
    paragraphs: [
      `지금까지 살펴본 ${kw} 이야기를 처음부터 짧게 되짚어 보겠습니다. ${finalSections.slice(0, 3).map((section) => section.highlight).join(' ')}`,
      `${finalSections.slice(3).map((section) => section.highlight).join(' ')} 내용이 많아 보이지만 결국 개념을 잡고, 내 조건을 맞춰 보고, 순서대로 진행한 뒤 기록하는 흐름 하나로 정리됩니다.`,
    ],
    highlight: `${kw}은 한 번 정리해 두면 다음부터는 확인만 하면 되는 주제입니다.`,
    question: `여러분은 ${kw}을 알아보면서 어떤 부분이 가장 어려우셨습니까? 궁금한 점이나 직접 겪은 경험을 댓글로 남겨 주시면 다음 글에서 더 자세히 다루겠습니다.`,
  };

  // 전체 글 목록도 실제 소제목 흐름에 맞춰 만듭니다.
  const postList = [
    { title: `${kw} 기본 개념 정리`, note: '처음 찾는 분이 가장 먼저 읽어야 하는 내용입니다.' },
    ...modifiers.slice(0, 2).map((item) => ({
      title: `${kw} ${item} 정리`,
      note: `${kw}과 함께 가장 많이 검색되는 부분입니다.`,
    })),
    { title: `${kw} 자주 하는 실수와 해결`, note: '검색 시간을 줄이는 세 가지 방법을 담았습니다.' },
    modifiers.length > 0
      ? { title: `${kw} 체크리스트와 마무리 정리`, note: '마지막에 한 번 더 확인하면 빠뜨리는 것이 없습니다.' }
      : { title: `${sub1} 연관 정보 모음`, note: '함께 확인하면 검색 시간을 줄일 수 있습니다.' },
  ].slice(0, 4);

  const doctor = [
    `${kw}은 정보량보다 확인 순서가 중요합니다.`,
    modifiers[0]
      ? `${kw} ${modifiers[0]}처럼 함께 검색되는 부분을 먼저 확인하시기 바랍니다.`
      : '시작 전에 목적과 일정, 비용, 대체 방법을 적어 두시기 바랍니다.',
    '정보 정리, 조건 확인, 진행, 기록 네 단계로 움직이면 실수가 줄어듭니다.',
    `${sub1}처럼 이어지는 주제는 하나의 메모로 묶어 관리하시기 바랍니다.`,
  ];

  return {
    title: title || makeTitle(keyword, subKeywords, titleModifiers),
    mainKeyword: keyword,
    subKeywords,
    intro,
    sections: finalSections,
    conclusion,
    postList,
    doctor,
    imageHint: topicImageHint(keyword),
    source: 'local',
  };
};

// 키워드 반복을 막습니다. 같은 키워드가 너무 많이 나오면 네이버가 도배·유사문서로 봅니다.
// 입력한 키워드마다 서론·본론·결론에서 각각 처음 한 번만 그대로 두고,
// 나머지는 줄인 말(어린이집 준비물 → 준비물)로 바꿉니다. 제목과 태그는 건드리지 않습니다.
const escapeRegex = (text) => String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const shortFormOf = (keyword) => {
  const tokens = String(keyword ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return '이 주제';
  }
  const last = tokens[tokens.length - 1];
  // "리눅스마스터 2급" 처럼 끝말에 숫자가 있으면 끝말만으로는 뜻이 안 통해 앞말을 씁니다.
  return /\d/.test(last) || [...last].length < 2 ? tokens[0] : last;
};

// 글 안에서 글자가 들어 있는 자리를 서론·본론·결론·부록·사진 설명 구역으로 나눕니다.
const zonesOf = (draft) => {
  const zone = (keepFirst) => ({ keepFirst, refs: [] });
  const intro = zone(true);
  const body = zone(true);
  const outro = zone(true);
  const extra = zone(true);
  const captions = zone(false);
  const add = (target, holder, key, heading = false) => {
    if (holder && typeof holder[key] === 'string') {
      target.refs.push({ holder, key, heading });
    }
  };
  (draft.intro?.paragraphs || []).forEach((item, index, list) => add(intro, list, index));
  add(intro, draft.intro, 'highlight');
  // 소제목은 입력 키워드별로 나눈 것이라(그 키워드가 들어가야 함) 반복 제한에서 뺍니다.
  // 단, 기본 틀은 소제목마다 키워드를 붙이는 문장 틀이라 소제목도 제한합니다.
  (draft.sections || []).forEach((section) => {
    if (draft.source !== 'ai') {
      add(body, section, 'heading', true);
    }
    (section.paragraphs || []).forEach((item, index, list) => add(body, list, index));
    add(body, section, 'highlight');
    add(captions, section, 'imageCaption', true);
  });
  (draft.photos || []).forEach((photo) => add(captions, photo, 'caption', true));
  (draft.conclusion?.paragraphs || []).forEach((item, index, list) => add(outro, list, index));
  add(outro, draft.conclusion, 'highlight');
  add(outro, draft.conclusion, 'rating');
  add(outro, draft.conclusion, 'question');
  (draft.postList || []).forEach((item) => {
    add(extra, item, 'title', true);
    add(extra, item, 'note');
  });
  (draft.doctor || []).forEach((item, index, list) => add(extra, list, index));
  return [intro, body, outro, extra, captions];
};

// 줄인 말(short)을 키워드로 되돌릴 자리를 찾습니다. 못 찾으면 null, 찾으면 { start, end } (바꿀 범위).
// 다른 키워드가 있는 자리와 이미 지켜 둔 키워드(\u0001n\u0002) 자리는 가리고, 그 바로 뒤에 붙은 말도 고르지 않습니다.
// 줄인 말 앞에 키워드의 앞부분이 이미 있으면("계란 알러지") 그 부분까지 바꿔 "계란 아기 계란 알러지"처럼 겹치지 않게 합니다.
const restorableAt = (text, short, others, keyword = '') => {
  const hide = (match) => '\u0003'.repeat(match.length);
  let masked = text.replace(/\u0001\d+\u0002/g, hide);
  others.forEach((other) => {
    masked = masked.replace(new RegExp(other.split(/\s+/).map(escapeRegex).join('\\s*'), 'g'), hide);
  });
  const pattern = new RegExp(`(^|[^가-힣\u0003])(${escapeRegex(short)})`, 'g');
  let found = pattern.exec(masked);
  const head = keyword.split(/\s+/).filter(Boolean).slice(0, -1);
  while (found) {
    const at = found.index + found[1].length;
    const before = masked.slice(0, at);
    // 키워드 앞말이 바로 붙어 있지 않고 낱말 하나를 사이에 두고 앞에 있으면("어린이집 첫 등원") 건너뜁니다.
    // 그대로 바꾸면 "어린이집 첫 어린이집 등원"처럼 겹칩니다. (바로 붙어 있으면 아래에서 그 부분까지 함께 바꿉니다)
    const attached = head.some((token, index) => new RegExp(`${head.slice(index).map(escapeRegex).join('\\s+')}\\s+$`).test(before));
    const nearHead = !attached && head.some((token) => before.slice(-(token.length + 6)).includes(token));
    // 바로 앞 낱말이 조사·어미 없이 끝나는 명사면("혈액 검사"의 "혈액") 다른 말을 꾸미는 자리라 건너뜁니다.
    const prevWord = /([가-힣]+)\s+$/.exec(before)?.[1] || '';
    const nounBefore = prevWord && !/[은는이가을를에의도와과로만며고서면요다죠까한된할던운인게히]$/.test(prevWord)
      && !head.some((token) => prevWord === token);
    if (!/\u0003\s*$/.test(before) && !nearHead && !nounBefore) {
      let start = at;
      // 키워드 앞말 중 가장 긴 꼬리부터 맞춰 봅니다. ("아기 계란" → "계란")
      for (let from = 0; from < head.length; from += 1) {
        const tail = new RegExp(`(^|[^가-힣])(${head.slice(from).map(escapeRegex).join('\\s+')}\\s+)$`).exec(before);
        if (tail) {
          start = at - tail[2].length;
          break;
        }
      }
      return { start, end: at + short.length };
    }
    found = pattern.exec(masked);
  }
  return null;
};

// 메인 키워드는 본론(소제목 아래 글)에 2~3번까지 둡니다. 서론 1 + 본론 2~3 + 결론 1 = 글 전체 4~5번. (사용자 요청 2026-10-14)
// 다른 구역과 서브 키워드는 구역마다 1번입니다.
const MAIN_BODY_MIN = 2;
const MAIN_BODY_MAX = 3;

const limitKeywords = (draft, keywords = []) => {
  // 구역에 키워드가 없을 때 줄인 말을 되살리는 것은 메인 키워드(첫 키워드)만 합니다.
  // 서브 키워드까지 되살리면 "혈액 검사" → "혈액 알러지 검사", "증상을" → "알러지 증상을"처럼 억지로 끼워 넣어 어색했습니다.
  const mainKeyword = String(keywords[0] ?? '').trim();
  const list = [...new Set(keywords.map((item) => String(item ?? '').trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length); // 긴 키워드부터 처리해야 짧은 키워드가 긴 키워드를 깨뜨리지 않습니다.
  const kept = [];
  const protect = (text) => {
    kept.push(text);
    return `\u0001${kept.length - 1}\u0002`;
  };
  list.forEach((keyword) => {
    const pattern = new RegExp(keyword.split(/\s+/).map(escapeRegex).join('\\s*'), 'g');
    const single = !/\s/.test(keyword);
    const short = shortFormOf(keyword);
    zonesOf(draft).forEach(({ keepFirst, refs }, zoneIndex) => {
      // 그 구역에서 그대로 둘 횟수입니다. (zonesOf 순서: 서론 0, 본론 1, 결론 2, 부록 3, 사진 설명 4)
      const limit = !keepFirst ? 0 : (keyword === mainKeyword && zoneIndex === 1 ? MAIN_BODY_MAX : 1);
      let count = 0;
      refs.forEach(({ holder, key, heading }) => {
        holder[key] = holder[key].replace(pattern, (match) => {
          if (count < limit) {
            count += 1;
            return protect(match);
          }
          // 소제목에서 한 낱말 키워드는 "이 주제" 대신 아예 뺍니다. ("제과기능사 합격 팁" → "합격 팁")
          return heading && single ? '' : short;
        });
      });
      // 서론·본론·결론에 키워드가 한 번도 없으면, 본문 문장 속 첫 줄인 말을 키워드로 되돌립니다.
      // (AI 가 "준비물"이라고만 쓴 자리 → "어린이집 준비물") 문장을 새로 끼워 넣지는 않습니다.
      // 단, 다른 키워드의 일부("알러지 검사"의 "알러지")나 이미 넣은 키워드 바로 뒤("…알러지 검사"의 "검사")는 건드리지 않습니다.
      // (예전에는 "알러지 검사" → "아기 계란 알러지 알러지 검사"처럼 낱말이 겹쳤습니다)
      if (limit > 0 && count === 0 && zoneIndex < 3 && !single && keyword === mainKeyword) {
        const others = list.filter((other) => other !== keyword);
        refs.some((ref) => {
          if (ref.heading) {
            return false;
          }
          const text = ref.holder[ref.key];
          const spot = restorableAt(text, short, others, keyword);
          if (!spot) {
            return false;
          }
          ref.holder[ref.key] = `${text.slice(0, spot.start)}${protect(keyword)}${text.slice(spot.end)}`;
          return true;
        });
      }
    });
  });
  // 키워드 낱말이 연달아 겹치면("알러지 알러지 검사") 하나로 합칩니다.
  const tokens = [...new Set(list.flatMap((keyword) => keyword.split(/\s+/)).filter((token) => [...token].length >= 2))];
  const dedupe = (text) => tokens.reduce((out, token) => out.replace(
    new RegExp(`(^|[^가-힣])${escapeRegex(token)}\\s+${escapeRegex(token)}(?![가-힣])`, 'g'),
    (match, before) => `${before}${token}`,
  ), text);
  zonesOf(draft).forEach(({ refs }) => {
    refs.forEach(({ holder, key }) => {
      holder[key] = dedupe(holder[key]
        .replace(/\u0001(\d+)\u0002/g, (match, index) => kept[Number(index)]))
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[\s,·]+/, '')
        .trim();
    });
  });
  return draft;
};

// 입력 키워드가 서론·본론·결론에 정한 횟수만큼(메인 키워드 본론은 2~3번, 나머지 1번), 서로 다른 문장에 들어갔는지 검사합니다. (사용자 요청 2026-10-03, 2026-10-14)
// 문제가 있으면 한국어 문장 목록을 돌려줍니다. main.js 가 이 목록을 AI 에게 주고 그 부분만 고치게 합니다.
// 긴 키워드부터 찾고 찾은 자리는 가려서, "다이어트 아침식단 그릭요거트" 안의 "다이어트 아침식단"을 따로 세지 않습니다.
const keywordIssues = (draft, keywords = []) => {
  const list = [...new Set(keywords.map((item) => String(item ?? '').trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  const plain = (items) => (items || []).filter((item) => typeof item === 'string' && !/^@@photo:/.test(item))
    .map((item) => item.split(EMPHASIS).join('').replace(/\[사진:[^\]]*\]/g, ''));
  const zones = [
    ['서론', plain((draft.intro?.paragraphs || []).filter((item) => item !== draft.intro?.greeting))],
    ['본론(소제목 아래 글)', plain((draft.sections || []).flatMap((section) => section.paragraphs || []))],
    ['결론', plain(draft.conclusion?.paragraphs)],
  ];
  const issues = [];
  const mainKeyword = String(keywords[0] ?? '').trim();
  zones.forEach(([name, paragraphs], zoneIndex) => {
    const counts = Object.fromEntries(list.map((keyword) => [keyword, 0]));
    paragraphs.flatMap((paragraph) => splitSentences(paragraph)).forEach((sentence) => {
      let masked = sentence;
      const found = [];
      list.forEach((keyword) => {
        const pattern = new RegExp(keyword.split(/\s+/).map(escapeRegex).join('\\s*'), 'g');
        masked = masked.replace(pattern, (match) => {
          found.push(keyword);
          return '\u0003'.repeat(match.length);
        });
      });
      found.forEach((keyword) => { counts[keyword] += 1; });
      const kinds = [...new Set(found)];
      if (kinds.length > 1) {
        issues.push(`${name}의 문장 "${sentence.slice(0, 80)}"에 키워드 ${kinds.map((item) => `"${item}"`).join(', ')}가 한 문장에 몰려 있습니다. 키워드마다 다른 문장으로 나눠 앞뒤 글과 자연스럽게 섞어 주십시오.`);
      }
    });
    list.forEach((keyword) => {
      // 메인 키워드는 본론에 2~3번, 나머지는 구역마다 1번입니다. (사용자 요청 2026-10-14: 메인 키워드 글 전체 4~5번)
      const mainBody = keyword === mainKeyword && zoneIndex === 1;
      const [min, max] = mainBody ? [MAIN_BODY_MIN, MAIN_BODY_MAX] : [1, 1];
      if (counts[keyword] === 0 && !mainBody) {
        issues.push(`${name}에 키워드 "${keyword}"가 없습니다. ${name}의 알맞은 문장 하나에 자연스럽게 1번 넣어 주십시오(다른 키워드와 같은 문장은 피함).`);
      } else if (counts[keyword] < min) {
        issues.push(`${name}에 메인 키워드 "${keyword}"가 ${counts[keyword]}번 있습니다. 서로 다른 소제목의 본문에 나눠 모두 ${min}~${max}번이 되게, 그 소제목 내용과 이어지는 문장 속에 자연스럽게 넣어 주십시오(다른 키워드와 같은 문장은 피하고, 키워드를 나열하지 않음).`);
      } else if (counts[keyword] > max) {
        issues.push(`${name}에 키워드 "${keyword}"가 ${counts[keyword]}번 있습니다. ${max}번만 남기고 나머지는 줄인 말이나 다른 표현으로 바꿔 주십시오.`);
      }
    });
  });
  return issues;
};

// 본문 소제목은 입력한 키워드(메인 + 서브)로 나눕니다. 3개보다 적으면 연관 검색어로 채우고, 4개까지만 씁니다.
const sectionKeywordsOf = ({ keyword, subKeywords = [], related = [] }) => {
  const list = [];
  const seen = new Set();
  const add = (item) => {
    const text = String(item ?? '').trim();
    const key = text.replace(/\s/g, '');
    if (text && !seen.has(key) && list.length < 4) {
      seen.add(key);
      list.push(text);
    }
  };
  [keyword, ...subKeywords].forEach(add);
  // 연관 검색어로 소제목을 채우지 않습니다. 제목과 동떨어진 곁가지(예: "아기 모유수유하는 꿈")가 소제목이 되어
  // 글이 제목·키워드와 맞지 않았습니다(2026-10-03). 모자란 소제목은 AI 가 제목의 질문에 답하도록 직접 정합니다.
  return list;
};

// | 는 줄바꿈 자리입니다. ("안녕하세요. 재쁜이 아빠" 다음에서 줄을 바꿈 — 사용자 요청)
const DEFAULT_GREETING = '안녕하세요. 재쁜이 아빠|육아박사 육박사입니다.';
const greetingText = () => String(process.env.BLOG_GREETING ?? DEFAULT_GREETING).trim();
// 인사말에서 글쓴이 소개만 뽑습니다. "안녕하세요. 재쁜이 아빠 육아박사 육박사입니다." → "재쁜이 아빠 육아박사 육박사"
const personaOf = () => greetingText().replace(/\s*\|\s*/g, ' ').replace(/^안녕하세요[.!,\s]*/, '').replace(/(입니다|이에요|예요)[.!\s]*$/, '').trim() || '이 블로그';
// 목표 글자수(공백 제외, 약)입니다. 기본 2000자이며 ±10%(1800~2200자)를 맞는 길이로 봅니다.
// (.env 의 BLOG_MIN_CHARS, 사용자 요청 2026-10-26: 글이 약 2500자라 2000자 정도로 — 2026-10-14 의 "공백 포함 3000자 이상"을 대체)
const targetChars = () => Math.max(800, Number(process.env.BLOG_MIN_CHARS) || 2000);
// AI 는 공백 포함 숫자를 더 잘 맞추므로 지시문에 함께 적습니다. 최근 초안 12편의 공백 포함/제외 비율 평균이 약 1.38 이었습니다.
const SPACE_RATIO = 1.38;
const targetRange = () => {
  const target = targetChars();
  const low = Math.round(target * 0.9);
  const high = Math.round(target * 1.1);
  const spaced = (count) => Math.round((count * SPACE_RATIO) / 100) * 100;
  return { target, low, high, spacedLow: spaced(low), spacedHigh: spaced(high) };
};

// AI 에 보낼 지시문입니다. 사용자가 정한 작성 규칙(2026-10-01)을 그대로 담았습니다.
// 2026-10-08: 10년차 마케터 역할 — 키워드를 조합한 호기심·공감형 제목, 도입부 첫 3문장 안에 훅(사용자 요청).
// 2026-10-14: 제목은 통념 뒤집기 + 직관적인 숫자 + 클릭을 부르는 말("믿었는데 알고 보니", "결국 ~하더라")을 함께(사용자 요청).
// 2026-10-14: 서론은 인사말 바로 다음 첫 문장부터 제목의 궁금증에 답함 — 예고·뜸 들이기 훅을 대체(사용자 요청).
// search 가 false 면 검색 도구 없이 쓰는 경우입니다(검색 한도가 없는 Gemini 키, Ollama, 딥시크).
// 이때는 "올해 기준 추세" 같은 최신성 주장을 지어내지 않도록 지시를 바꿉니다.
const buildPrompt = (input, { search = true } = {}) => {
  const { keyword, subKeywords = [], related = [], references = [], title } = input;
  const extraPrompt = String(input.extraPrompt ?? '').trim();
  // 최신 뉴스·글은 날짜를 붙여 AI 가 최신 내용을 골라 쓰게 합니다. (research.js — 네이버 검색 API 키가 있을 때)
  // main.js 가 키워드를 조합해 찾은 최신 기사를 최신순으로 맨 앞에 둡니다(research.js researchLatest, 2026-10-14).
  // 원문을 읽은 기사는 요약이 길어(최대 420자) 한 건에 480자까지 넣되, 로컬 AI(Ollama)가 한 번에 읽는 양을 넘지 않게
  // 참고 자료 전체는 약 4200자까지만 넣고 나머지는 날짜·제목만 넣습니다. (2026-10-26, 예전엔 한 건 260자)
  let referenceRoom = 4200;
  const referenceText = references.slice(0, 12)
    .map((item, index) => {
      const head = `${index + 1}. ${item.date ? `[${item.date}] ` : ''}${item.title}`;
      const line = `${head} :: ${item.snippet || ''}`.slice(0, 480);
      const fit = line.length <= referenceRoom ? line : head.slice(0, 120);
      referenceRoom -= fit.length;
      return fit;
    })
    .join('\n');
  const sectionKeywords = sectionKeywordsOf(input);
  const today = new Date().toISOString().slice(0, 10);
  const noAsOf = asOfRule(today.slice(0, 4));
  const persona = personaOf();
  // 서론은 인사말 바로 다음부터 제목의 궁금증을 풀어 줍니다(사용자 요청 2026-10-14). 지시문에 실제 인사말을 보여 줍니다.
  const greeting = greetingText().replace(/\s*\|\s*/g, ' ');
  const { target, low, high, spacedLow, spacedHigh } = targetRange();
  const lengthGoal = `공백 제외 ${low}~${high}자(공백 포함 약 ${spacedLow}~${spacedHigh}자)`;
  // 육아 주제가 아니면 아이·부모 이야기를 쓰지 않습니다(사용자 요청 2026-10-03). 독자도 그 주제에 관심 있는 일반 독자로 둡니다.
  const parenting = isParentingTopic(keyword, subKeywords, title);
  const readers = parenting ? '많은 부모' : '이 주제를 찾아보는 많은 사람';
  const readersGa = parenting ? '많은 부모가' : '이 주제를 찾아보는 많은 사람이';
  // 키워드 횟수(사용자 요청 2026-10-14): 메인 키워드는 본문 문장에 4~5번(서론 1·본론 2~3·결론 1), 서브 키워드는 구역마다 1번.
  const subList = subKeywords.map((item) => `"${item}"`).join(', ');
  const keywordRule = `메인 키워드("${keyword}")는 서론 1번, 본론(소제목을 뺀 본문, 서로 다른 소제목에 나눠) ${MAIN_BODY_MIN}~${MAIN_BODY_MAX}번, 결론 1번으로 글 전체에 ${MAIN_BODY_MIN + 2}~${MAIN_BODY_MAX + 2}번 씁니다.${subKeywords.length ? ` 서브 키워드(${subList})는 각각 서론·본론·결론에 1번씩 씁니다.` : ''}`;
  const notKids = parenting ? '' : `
0-1. 이 글은 육아 글이 아닙니다. 본문·사진 표시·요약·태그 어디에도 아이, 아기, 자녀, 육아, 부모, 엄마, 아빠 이야기를 쓰지 않습니다(글쓴이 인사말은 프로그램이 넣으므로 신경 쓰지 않음). 사진 표시에 사람이 나오면 성인만 넣습니다.`;
  // 교정 단계: 다 쓴 글을 주고 어색한 문장만 고쳐 같은 JSON 으로 돌려받습니다. (main.js, .env 의 BLOG_PROOFREAD)
  if (input.proofreadFrom) {
    return `아래 JSON 은 네이버 블로그 글 초안입니다. 꼼꼼한 한국어 교정 편집자로서 글 전체를 처음부터 끝까지 읽고, 아래 항목만 고쳐 같은 JSON 형식 그대로 출력합니다.

고칠 것
1. 어색하거나 뜻이 흐린 문장 (예: ${parenting ? '"아기마다 반응이 반복될 때 패턴이 달라서"' : '"사람마다 결과가 반복될 때 차이가 달라서"'} → 뜻이 분명하게)
2. 앞뒤 논리가 맞지 않는 문장 (예: "생각보다 흔해서, 대부분 병원에서 처음 듣는 진단" 같은 엇갈린 연결)
3. 조사·어미·맞춤법·띄어쓰기 오류 (예: "두드러기만 있어도 호흡이 편하고 기운이 있다면" → "두드러기만 있고 호흡이 편하며 기운이 있다면")
4. 같은 낱말이 연달아 겹치거나 한 문단에서 같은 표현이 되풀이되는 곳
5. 사진 설명([사진: 한국어 설명 | english words])의 한국어 설명에 섞인 영어
6. 오타와 말투 규칙에 어긋난 문장 끝
7. 키워드 횟수: ${keywordRule} 모자란 곳에는 그 자리 내용과 이어지는 문장 속에 자연스럽게 넣고, 넘치면 나머지는 줄인 말로 바꿉니다. 키워드끼리 붙여 쓰지 않고, 한 문장에 키워드가 둘 이상 있으면 문장을 나눠 키워드마다 다른 문장에 둡니다. 키워드를 나열하는 문장은 없앱니다.
8. 도입부(intro)에 답을 미루는 예고·뜸 들이기 문장("끝까지 읽으면 ~", "이 글에서는 ~을 정리할게요", "지금부터 알아볼게요")이 있으면, 그 문장을 제목의 궁금증에 대한 답이나 그 근거를 말하는 문장으로 바꿉니다(키워드가 들어 있던 문장이면 바꾼 문장에도 키워드를 그대로 둡니다). 글 어디든 "오늘은 ~에 대해 알아보겠습니다", "이번 포스팅에서는" 같은 AI 티 나는 상투적인 인사·도입 문구도 내용 있는 문장으로 바꿉니다.
9. 길게 늘어진 문장은 뜻을 그대로 두고 짧은 문장 둘로 나눕니다.
10. 기준 시점 문구("${today.slice(0, 4)}년 ○월 발표 기준", "${today.slice(0, 4)}년 기준으로", "최신 기준으로", "(○월 기준)")가 있으면 그 문구만 빼고 문장이 자연스럽게 이어지게 다듬습니다(내용·수치는 그대로).

지킬 것
- 내용, 순서, 소제목(heading), 단락 수, 글 길이는 그대로 둡니다(새 내용을 보태거나 빼지 않음).
- "★ " 로 시작하는 단락, "[사진: … | …]" 표시, 키워드("${keyword}"${subKeywords.length ? `, ${subKeywords.join(', ')}` : ''})는 그대로 둡니다.
- titles(제목)는 독자를 붙잡는 부분이므로 뜻과 힘을 그대로 두고 오류만 고칩니다.${title ? ` 다만 titles 첫 번째("${title}")는 사용자가 직접 정한 제목이므로 한 글자도 바꾸지 않습니다.` : ''} 도입부 첫 단락이 첫 문장부터 제목의 궁금증에 바로 답하는 구성도 그대로 두며, 밋밋한 설명문이나 예고("이 글에서는 ~")로 바꾸지 않습니다.
- ${formalTone() ? '모든 문장을 "~합니다/~습니다/~입니다"처럼 "다"로 끝냅니다. "~요/~죠/~네요"로 끝난 문장이 있으면 고칩니다.' : '말투(~해요·~합니다·~죠를 섞은 친근한 존댓말)를 유지합니다.'}
- 오타·맞춤법·띄어쓰기 오류를 모두 고칩니다.
- 댓글·공감을 부르는 질문은 conclusion.question 에만 두고 그대로 둡니다. 본문 단락에는 댓글·공감·이웃 추가를 부탁하는 문장을 넣지 않습니다.
${parenting ? '' : '- 육아 글이 아니므로 아이·아기·자녀·부모 이야기가 있으면 그 문장을 주제에 맞는 일반 독자 이야기로 바꿉니다.\n'}- 고칠 곳이 없으면 그대로 출력합니다. 설명 없이 JSON 만 출력합니다.

초안:
${JSON.stringify(input.proofreadFrom).slice(0, 16000)}`;
  }
  // 키워드 고치기: 키워드가 한 문장에 몰렸거나 빠진 곳만 고쳐 같은 JSON 으로 돌려받습니다. (main.js, keywordIssues)
  if (input.keywordFixFrom) {
    return `아래 JSON 은 네이버 블로그 글 초안입니다. 아래 "고칠 곳"만 고치고 나머지 글은 한 글자도 바꾸지 않은 채 같은 JSON 형식 그대로 출력합니다.

규칙
- ${keywordRule}
- 한 문장에는 키워드를 하나만 넣습니다. 키워드끼리 같은 문장에 나란히 쓰지 않습니다. (금지 예: "이 글에서는 A와 B, C를 정리합니다")
- 키워드는 그 키워드에 대한 구체적인 정보(기준·수치·방법·이유)를 전하는 문장 안에 넣어 앞뒤 글과 자연스럽게 섞습니다. 키워드를 넣으려고 내용 없는 문장을 만들지 않습니다.
- 문장을 나눌 때는 앞뒤 흐름이 이어지게 다듬고, 말투·단락 수·소제목·"★ " 단락·"[사진: … | …]" 표시는 그대로 둡니다. 도입부 첫 단락을 고칠 때는 첫 문장부터 제목의 궁금증에 바로 답하는 구성이 흐려지지 않게 합니다.
- 설명 없이 JSON 만 출력합니다.

고칠 곳
${input.keywordFixFrom.issues.map((item, index) => `${index + 1}. ${item}`).join('\n')}

초안:
${JSON.stringify(input.keywordFixFrom.raw).slice(0, 16000)}`;
  }
  // 앞서 쓴 글이 목표보다 짧으면, 그 글을 주고 사례·정보를 더 붙여 늘려 달라고 다시 요청합니다. (main.js)
  const expand = input.expandFrom ? `
앞서 쓴 아래 초안이 공백 제외 약 ${input.expandFrom.chars}자로 목표(공백 제외 약 ${target}자)보다 짧습니다.
이 초안의 제목(titles)·도입부 첫 단락의 답(제목의 궁금증 해소)·소제목 첫 단락의 훅·흐름·소제목·사진 표시·★ 핵심 단락·결론 끝 질문(question)은 그대로 두고, 소제목마다 ${readersGa} 흔히 겪는 상황, 다른 사람들의 경험담·팁이 녹아든 예시${parenting ? '(아이들의 반응 포함)' : ''}와 구체적인 정보를 짧은 문장으로 더 붙여 ${lengthGoal}로 늘린 전체 글을 같은 JSON 형식으로 다시 출력합니다. 메인 키워드 횟수(${MAIN_BODY_MIN + 2}~${MAIN_BODY_MAX + 2}번)는 늘리지 않습니다.
앞선 초안:
${JSON.stringify(input.expandFrom.raw).slice(0, 12000)}
` : '';
  // 앞서 쓴 글이 목표보다 많이 길면, 그 글을 주고 되풀이·군더더기를 덜어 줄여 달라고 다시 요청합니다. (main.js, 사용자 요청 2026-10-26)
  const shrink = input.shrinkFrom ? `
앞서 쓴 아래 초안이 공백 제외 약 ${input.shrinkFrom.chars}자로 목표(공백 제외 약 ${target}자)보다 깁니다.
이 초안의 제목(titles)·도입부 첫 단락의 답(제목의 궁금증 해소)·소제목 첫 단락의 훅·흐름·소제목 수와 heading·사진 표시·★ 핵심 단락·결론 끝 질문(question)·summary·tags 는 그대로 두고, 되풀이되는 내용, 군더더기 문장, 비슷한 예시를 덜어 내 ${lengthGoal}로 줄인 전체 글을 같은 JSON 형식으로 다시 출력합니다. 기준·수치·방법 같은 핵심 정보와 최근 소식은 빼지 않습니다. 키워드가 든 문장은 남겨 메인 키워드 횟수(${MAIN_BODY_MIN + 2}~${MAIN_BODY_MAX + 2}번)와 서브 키워드 횟수(구역마다 1번)를 줄이지 않습니다.
앞선 초안:
${JSON.stringify(input.shrinkFrom.raw).slice(0, 16000)}
` : '';
  const sectionCount = Math.max(3, sectionKeywords.length);
  const dated = references.some((item) => item.date);
  // 최신 기사가 있으면 그 내용을 먼저 쓰게 합니다(사용자 요청 2026-10-14: 제일 최신 정보로).
  // 기준 시점 문구("2026년 ○월 발표 기준")는 쓰지 않습니다(사용자 요청 2026-10-14, 같은 날 "기준 시점 밝힘"을 대체). AI 가 써 오면 dropAsOf 가 지웁니다.
  // 2026-10-26 사용자 요청("정보글은 최신정보나 최신뉴스를 검색해서 작성"): 주제와 맞는 최근 소식이 있으면 본문에 꼭 녹여 쓰게 하고,
  // "::" 뒤는 기사 원문 앞부분 요약(research.js readArticles)임을 알려 줍니다. 제목만 있는 기사는 제목에 드러난 사실만 씁니다.
  const latestRefs = dated ? `참고 자료는 키워드로 찾은 최근 기사이며 최신순입니다("::" 뒤는 기사 원문 앞부분 요약). 이 글 주제와 직접 관련된 것만 골라, 날짜가 가장 최근인 내용(바뀐 제도·금액·일정·지침·권고, 최근 유행·발표·새 수치)을 먼저 반영합니다. 주제와 직접 관련된 최근 소식이 있으면 도입부의 근거 단락이나 가장 관련 있는 소제목에 반드시 한 번 이상 자연스럽게 녹여 씁니다. 오래된 자료나 알고 있던 내용과 다르면 가장 최근 날짜의 내용을 따르고, 그 내용을 지금의 사실로 바로 씁니다. 참고 자료에 나온 최신 수치는 써도 됩니다. 요약 없이 제목만 있는 자료("○○ 보도")는 제목에 드러난 사실만 쓰고 내용을 지어내지 않습니다. 다른 나라 소식은 국내 기준처럼 쓰지 않고, 특정 지역(○○구 등)만의 소식은 전국 기준처럼 쓰지 않고 "예를 들어 ○○구는"처럼 예로만 씁니다. 발표한 기관(식약처·금융위원회 등)은 밝혀도 되지만 언론사 이름과 기사 제목은 쓰지 않고, 기사 문장을 그대로 베끼지 않습니다. ` : '';
  return `당신은 네이버 홈판(홈 피드)에 오르는 글을 10년 동안 기획해 온 마케터이며, 지금은 네이버 블로그 "${persona}"의 글쓴이로 ${parenting ? '육아 정보를' : '이 주제의 정보를'} 정확하고 전문적으로 전합니다. 마케터의 감각은 독자를 붙잡는 제목에 쓰고, 도입부는 인사말 바로 다음부터 그 제목의 궁금증을 시원하게 풀어 주며, 본문은 광고 느낌 없이 정보 중심으로 씁니다.
아래 내용으로 네이버 홈판과 검색(DIA+)에 맞는, ${readersGa} 공감하는 상황에서 출발해 전문적인 정보를 전하는 블로그 포스팅을 JSON으로 작성합니다.

오늘 날짜: ${today}
메인 키워드: ${keyword}
서브 키워드: ${joinKeywords(subKeywords) || '없음'}
본문 소제목 키워드(이 순서대로 소제목 하나씩): ${sectionKeywords.join(' / ')}${sectionKeywords.length < sectionCount ? ` (모자란 ${sectionCount - sectionKeywords.length}개는 제목의 질문에 답하는 데 꼭 필요한 내용으로 직접 정함)` : ''}
연관 검색어(참고만, 제목·키워드와 직접 관련된 것만 씀): ${joinKeywords(related.slice(0, 10)) || '없음'}
${title ? `지정 제목: ${title}
- 사용자가 직접 정한 제목입니다. 글자 하나 바꾸지 않고 그대로 쓰며, titles 첫 번째에도 그대로 넣습니다(프로그램도 이 제목을 그대로 씁니다).
- 글 전체를 이 제목에 맞춰 씁니다. 제목이 묻는 질문·약속한 내용에 도입부 첫 단락에서 바로 답하고, 본론에서 자세히 풀고, 결론에서 다시 답합니다.
- 제목에 나온 대상·상황·조건·숫자·비교(예: "3일째", "5가지", "A vs B", "30대 직장인")는 본문에서 빠짐없이 그대로 다룹니다. "5가지"처럼 개수를 말했으면 그 개수만큼 분명히 나눠 짚습니다(소제목 수와 다르면 소제목 안에서 나눔).
- 제목의 숫자·주장이 널리 확인된 사실과 다르면 지어내 맞추지 말고, 사실에 맞는 범위에서 그 뜻을 바르게 풀어 줍니다.
- 소제목은 위 "본문 소제목 키워드"를 앞쪽에 넣되, 내용은 이 제목의 질문을 나눠 답하는 흐름으로 짭니다. 제목과 다른 방향의 곁가지는 쓰지 않습니다.` : ''}
참고 자료(${dated ? '키워드를 조합해 찾은 최근 기사, 최신순. ' : ''}사실 확인용이며 그대로 베끼지 않는다):
${referenceText || '없음'}

작성 가이드라인 (반드시 준수)
1. 말투: ${formalTone() ? '전문적으로 보이도록 모든 문장을 "~합니다", "~습니다", "~입니다", "그렇습니다"처럼 "다"로 끝냅니다. "~요", "~죠", "~네요"로 끝나는 문장은 쓰지 않습니다(★ 핵심 단락과 요약도 같음). 반말("~한다", "~이다")은 쓰지 않습니다.' : '친근하고 몰입감 있는 구어체로, 옆에서 차근차근 이야기해 주듯 씁니다. "~해요", "~거든요", "~더라고요", "~죠"를 중심으로 "~합니다"를 가끔 섞고, 독자에게 말을 걸듯 묻기도 합니다(예: "이런 경험 한 번쯤 있으시죠?"). 반말("~한다", "~이다")과 딱딱한 보고서 말투는 쓰지 않습니다.'} 문장은 짧고 간결하게 끊어 씁니다(한 문장에 한 가지 내용, 길어지면 둘로 나눔). 어려운 말은 풀어 쓰고, 처음 읽는 ${parenting ? '부모' : '사람'}도 알기 쉽게 씁니다. 오타와 맞춤법 오류가 없게 씁니다.
1-1. AI 티 나는 딱딱한 인사·도입 문구는 쓰지 않습니다. 글 어디에도 "안녕하세요", "오늘은 ~에 대해 알아보겠습니다", "이번 포스팅에서는", "~에 대해 자세히 살펴보겠습니다" 같은 상투적인 말로 시작하지 않습니다(블로그 인사말은 프로그램이 넣음).
2. 가독성: paragraphs 의 한 항목이 한 단락이며, 한 단락은 최대 3문장입니다. 단락을 짧게 자주 나눕니다.
0. 주제 맞추기(가장 중요): 글 전체가 제목${title ? `("${title}")이` : '과 메인 키워드가'} 묻는 것에 정면으로 답합니다. 도입부(인사말 바로 다음)에서 제목의 질문에 대한 핵심 답을 먼저 말하고, 소제목들이 그 답의 근거·방법·주의점을 차례로 자세히 풀고, 결론에서 다시 정리합니다(예: "A와 B 중 무엇을 추천하나요"라면 둘의 장단점 비교와 상황별 추천을 분명히 씀). 제목·키워드와 상관없는 곁가지(꿈 해몽, 다른 주제 등)는 쓰지 않습니다.${notKids}
3. 본론 = 훅 + 경험담 + 전문 정보: 글 전체를 ${readersGa} 실제로 겪는 이야기를 따라가듯 몰입감 있게 씁니다. 글쓴이 개인의 경험담("저는", "저희 집은"${parenting ? ', "제 아이는"' : ''})은 쓰지 않습니다.
   - 훅: 소제목마다 사진 표시 다음 첫 3~4줄(첫 단락, 2~3문장) 안에 독자가 강하게 공감하거나 "어? 나도 이런데?" 하고 의문을 품게 하는 장면·질문을 둡니다(${formalTone() ? `예: "${parenting ? '밤마다 같은 시간에 깨서 우는 아이, 혹시 낮잠 탓이라고만 생각하셨습니까?' : '분명 열심히 했는데 결과는 그대로인 경우, 한 번쯤 겪어 보셨을 겁니다.'}"` : `예: "${parenting ? '밤마다 같은 시간에 깨서 우는 아이, 혹시 낮잠 탓이라고만 생각하셨죠?' : '분명 열심히 했는데 결과는 그대로, 이런 적 있으시죠?'}"`}). 소제목 첫머리를 "이번에는 ~을 알아볼게요" 같은 예고로 시작하지 않습니다.
   - 경험담·팁 예시: 단락 중간중간에 다른 사람들의 실제 경험담이나 팁이 녹아든 것처럼 자연스러운 예시를 넣습니다(${formalTone() ? `"${parenting ? '먼저 겪어 본 부모님들이 꼭 하는 말이 있습니다' : '먼저 해 본 분들이 꼭 하는 말이 있습니다'}", "이렇게 바꿨더니 훨씬 수월했다는 분이 많습니다"` : `"${parenting ? '먼저 겪어 본 엄마 아빠들이 꼭 하는 말이 있어요' : '먼저 해 본 분들이 꼭 하는 말이 있어요'}", "이렇게 바꿨더니 훨씬 수월했다는 분이 많더라고요"`}). 특정 인물·병원·상품 이름은 지어내지 않습니다.
   - 그 장면과 경험에 답하듯 전문 정보를 전합니다. 전문 정보에는 판단 기준, 구체적인 수치·횟수·시기, 장단점 비교, 단계별 방법, 주의할 점과 ${parenting ? '병원·' : ''}전문가 상담이 필요한 경우를 담고, ${parenting ? '소아청소년과·보건 당국' : '공식 기관·전문가'} 등에서 널리 안내하는 내용에 근거합니다.
3-1. 정보성: 광고 느낌을 빼고, 전문가가 정리해 주듯 정확하고 실용적인 정보를 담습니다. "검색해 보세요", "메모해 두세요" 같은 어떤 주제에나 붙는 일반론은 쓰지 않습니다.
4. 사진 위치: 사진이 들어가면 좋은 자리에 paragraphs 의 별도 항목으로 "[사진: 한국어 설명 | english search words]" 를 넣습니다. 소제목마다 딱 1개(소제목 바로 아래, 단락 맨 앞), 도입부에 1개(도입부 맨 앞), 결론에 1개(결론 맨 앞)입니다. 사진은 그 구역(도입부·소제목·결론) 내용을 최종적으로 정리해 보여 주는 실사 장면입니다. 한국어 설명은 그 구역에서 말한 핵심 물건 2~3가지와, 필요하면 그 내용대로 행동하는 사람을 함께 담아 25자 안팎으로 씁니다(예: ${parenting ? '"체온계와 해열제를 챙겨 아이 이마를 짚는 아빠"' : '"오답 노트와 기출문제집을 펼쳐 정리하는 수험생"'}). 구역마다 서로 다른 물건·장면으로 씁니다. 영어 검색어는 사진에 실제로 보이는 사물·장면 2~4단어이며, 사람이 나오면 영어 검색어 맨 앞에만 asian 을 붙이고 한국어 설명에는 영어를 쓰지 않습니다(예: ${parenting ? '[사진: 이름표를 붙인 아이 물통 | kids water bottle name label]' : '[사진: 책상 위에 펼친 수험서와 노트 | study desk open book notebook]'}). 이 표시는 프로그램이 실제 사진으로 바꾸므로, 본문 문장에서 "사진 위치", "아래 사진" 같은 말로 사진을 언급하지 않습니다.
5. 굵은 글씨, 별표(**), 마크다운 기호는 쓰지 않습니다.
${search
    ? `6. 최신 정보 위주: 먼저 검색 도구로 최신 자료를 찾아 반영하고, ${latestRefs}바뀌기 전의 옛 기준은 쓰지 않습니다. ${noAsOf}`
    : `6. 최신 정보 위주: 지금은 검색 도구를 쓸 수 없습니다. ${latestRefs}알고 있는 내용 중 가장 최근 기준(바뀐 제도·지침·권고)으로 쓰고, 이미 바뀐 옛 기준은 쓰지 않습니다. 확인하지 않은 "최근 추세" 같은 최신성 주장은 지어내지 않고, 해마다 바뀌는 내용은 확인할 곳(공식 누리집 등)을 함께 알려 줍니다. ${noAsOf}`}
7. 수치: 구체적인 수치, 장단점, 비교 분석을 넣되 널리 확인된 사실만 씁니다. 가격·일정·제도처럼 바뀌거나 곳마다 다른 수치는 지어내지 말고 "곳마다 다르다"고 밝힌 뒤 확인할 곳(안내문, 공식 누리집 등)을 알려 줍니다.

글의 구조
1. titles: 홈판에서 스크롤을 멈추게 하는 제목 후보 3개를 씁니다${title ? '(첫 번째는 지정 제목 그대로, 나머지 2개를 아래 규칙으로)' : ''}. 프로그램은 이 중 가장 좋은 제목 하나만 글에 씁니다. 지정한 키워드를 조합해 만듭니다. 모든 제목의 앞쪽에 메인 키워드("${keyword}")를 넣습니다.${subKeywords.length ? ` 서브 키워드(${subKeywords.map((item) => `"${item}"`).join(', ')}) 중 1~2개를 제목마다 자연스럽게 엮습니다(억지로 다 넣지 않음).` : ''}
   - 아래 세 장치를 한 제목 안에 함께 씁니다(제목마다 최소 2가지, 되도록 3가지 모두).
     ① 통념 뒤집기: 많은 사람이 당연하게 믿는 것과 다른 예외적인 상황·반전을 내세워 "왜 그렇지?" 하는 궁금증을 만듭니다(예: "1천억 부자가 말하는 절대 적금하지 말라는 이유" — 돈은 모아야 한다는 통념을 뒤집음). 반전은 사실이어야 하며, 흔한 오해를 바로잡는 쪽으로 씁니다.
     ② 직관적인 숫자: "120억 자산가", "48kg 유지", "1000만 원", "하루 10분", "3주"처럼 구체적인 숫자를 아라비아 숫자로 넣어 시선을 붙잡습니다. 숫자는 본문에서 실제로 다루는 기준·수치·기간·횟수·금액에서 가져오고, 본문에 없는 숫자나 확인되지 않은 통계는 지어내지 않습니다.
     ③ 클릭을 부르는 말: "믿었는데 알고 보니", "결국 ~하더라", "싹 다 무너짐", "장난 아니게", "~하지 말라는 이유" 같은 호기심·자극 문구를 하나 섞습니다. 세 후보는 서로 다른 문구를 씁니다.
   - 형식 예시(그대로 쓰지 말고 방식만 참고): ${parenting ? '"아기 열 내리는 법, 38도 넘으면 해열제부터 먹였는데 알고 보니" / "아기 열 내리는 법, 물수건 30분 닦아도 그대로더니 결국 답은 따로 있더라"' : '"리눅스마스터 2급 독학, 이론서 3번 읽고도 떨어진 진짜 이유" / "리눅스마스터 2급, 하루 2시간 기출만 돌렸더니 결국 붙더라"'}
   - 제목이 내세운 반전과 숫자는 도입부 첫 단락(인사말 바로 다음)에서 바로 풀어 주고, 본론에서 자세히 설명합니다(본문이 실제로 답하는 내용만 약속). 사실이 아닌 단정("100% 효과", "무조건 낫는")은 쓰지 않습니다. "~이 궁금하다면", "~총정리", "~에 대해 알아보기"처럼 어디에나 붙는 밋밋한 제목은 쓰지 않습니다.${title ? '' : ' 세 후보를 비교해 홈판에서 가장 많이 눌릴 제목을 반드시 첫 번째에 둡니다.'}
   - 띄어쓰기 포함 20~35자 안팎의 자연스러운 한 문장으로 쓰고, 한 제목 안에 같은 낱말을 겹쳐 쓰지 않습니다("알러지 증상 및 알러지 증상" 금지).
2. intro(도입부): ${greeting ? `인사말("${greeting}")은 프로그램이 맨 앞에 넣으므로 인사나 자기소개는 쓰지 않습니다. 도입부는 그 인사말 바로 다음에 이어지는 글이며` : '인사나 자기소개는 쓰지 않습니다. 도입부는'} 단락 3개 안팎입니다.
   - 궁금증 바로 해소(가장 중요): 사진 표시 다음 첫 단락의 첫 문장부터 제목이 던진 궁금증의 답을 바로 말합니다. 제목의 반전이 왜 그런지, 제목의 숫자가 무엇을 뜻하는지, 그래서 독자가 어떻게 하면 되는지를 2~3문장으로 분명히 풀어 줍니다(형식 예: ${formalTone() ? '"결론부터 말씀드리면 ○○는 △△입니다. □□ 때문입니다."' : '"결론부터 말하면 ○○는 △△예요. □□ 때문이거든요."'}).
   - 답을 미루는 말로 시작하거나 채우지 않습니다: "끝까지 읽으면 ~", "이 글에서는 ~을 알려 드릴게요", "그 이유는 아래에서", "지금부터 알아볼게요" 같은 예고·뜸 들이기, 정의("~란 ~입니다")나 배경 설명, "~하는 분이 많습니다" 같은 일반론은 쓰지 않습니다.
   - 둘째 단락부터는 그 답의 근거(왜 그런지, ${parenting ? '소아청소년과·보건 당국이' : '공식 기관·전문가가'} 안내하는 기준)와 흔히 하는 오해를 짧게 보탭니다. 자세한 방법·기준·주의점은 본론 소제목에서 풉니다.
3. sections(본문): 위 "본문 소제목 키워드"마다 소제목 하나씩, 총 ${sectionCount}개입니다. heading 은 그 키워드가 앞쪽에 들어간 짧은 소제목이며(키워드가 정해지지 않은 소제목은 제목의 질문에 답하는 내용으로), 프로그램이 인용구 상자로 꾸미므로 따옴표나 괄호, 번호는 붙이지 않습니다. 각 소제목 아래 단락 5개 안팎(사진 표시 제외)으로, 첫 단락은 훅, 경험담·팁 예시 단락 1개, 기준·수치·장단점·비교·방법 같은 전문 정보 단락 3개를 씁니다.
4. 키워드(SEO): ${keywordRule} 키워드는 앞뒤 문맥과 이어지는 문장 속에 자연스럽게 넣고, 키워드 나열(어뷰징)은 엄격히 금지합니다. 키워드끼리 붙여 쓰지 않고(예: ${parenting ? '"아기 계란 알러지 알러지 검사"' : '"리눅스마스터 2급 2급 시험"'} 금지) 서로 다른 문장에 나눠 문맥에 자연스럽게 녹입니다. 한 문장에는 키워드를 하나만 넣습니다(금지 예: "이 글에서는 A와 B, C를 정리합니다"처럼 키워드를 한 문장에 나열). 그 밖의 자리에서는 줄인 말이나 다른 표현을 씁니다. SEO 를 위해 키워드는 반드시 구체적인 정보(기준·방법·수치·이유)를 전달하는 문장 안에 넣고, 키워드만 나열하거나 키워드를 넣으려고 내용 없는 문장을 만들지 않습니다. 소제목(heading)에도 해당 키워드를 앞쪽에 넣어 검색에 잘 걸리게 합니다.
5. conclusion(결론): paragraphs 에 맨 앞 사진 표시 다음으로 글 전체 내용을 깔끔하게 요약하는 단락 2~3개를 씁니다. 도입부의 고민에서 시작해 소제목마다 다룬 핵심을 순서대로 짧게 이어 가며, 글을 다 읽은 독자가 무엇을 알게 되었는지 한눈에 보이게 정리합니다(summary 의 짧은 목록과 달리 이어지는 문장으로 씁니다). 총평·별점은 쓰지 않습니다.
5-1. question(결론 끝 질문): 글은 독자의 댓글 참여나 공감을 부르는 질문으로 끝맺습니다. conclusion.question 에 1~2문장으로 씁니다. 독자가 자기 경험이나 방법을 쉽게 답할 수 있는, 이 글 주제에 딱 맞는 구체적인 질문입니다(${formalTone() ? `예: "${parenting ? '여러분은 아이 열이 날 때 어떤 순서로 대처하셨습니까? 나만의 방법이 있다면 댓글로 나눠 주시기 바랍니다.' : '여러분은 어떤 방법으로 준비하고 계십니까? 나만의 팁이 있다면 댓글로 나눠 주시기 바랍니다.'}"` : `예: "${parenting ? '여러분은 아이 열이 날 때 어떤 순서로 대처하셨나요? 나만의 방법이 있다면 댓글로 나눠 주세요!' : '여러분은 어떤 방법으로 준비하고 계신가요? 나만의 팁이 있다면 댓글로 나눠 주세요!'}"`}). 질문은 여기에만 두고, 결론 paragraphs 와 본문 다른 곳에는 댓글·공감·이웃 추가를 부탁하는 문장을 쓰지 않습니다.
6. summary(육박사의 간단 요약): 결론 다음에 붙는 핵심 정리입니다. 이 글에서 꼭 기억할 내용을 한 줄에 하나씩 4~5줄 씁니다. 한 줄은 띄어쓰기 포함 37자 안팎(30~37자, 37자를 넘기지 않음)의 한 문장(말투 규칙과 같게 끝냄)이며, 구체적인 기준·수치·방법을 담고 기호(·, -, 번호)는 붙이지 않습니다.
7. tags: 네이버 블로그용 해시태그 10개(# 없이, 띄어쓰기 없이)를 추천합니다. 메인·서브 키워드와 검색에 잘 걸리는 연관 낱말로 고르고 서로 겹치지 않게 합니다.
8. 강조: 글 전체를 다 쓴 뒤 다시 읽어 보고, 독자가 꼭 기억해야 할 핵심 내용은 paragraphs 안에 따로 한 항목(단락)으로 쓰고 맨 앞에 "★ "를 붙입니다(프로그램이 초록 글씨로 강조). 도입부 1개, 소제목마다 1~2개, 결론 1개 정도이며, 핵심 단락은 1~2문장으로 앞뒤 단락과 자연스럽게 이어지게 씁니다. 주의·기준·수치·방법처럼 실제로 중요한 내용만 고르고, 아무 문장에나 붙이지 않습니다. highlight 는 빈 문자열로 둡니다.
10. 다 쓴 뒤 처음부터 다시 읽고, 어색하거나 뜻이 흐린 문장, 앞뒤 논리가 맞지 않는 문장, 조사·맞춤법 오류를 고친 다음 출력합니다.
11. thumbnail(맨 위 썸네일): 글 맨 위 대표 이미지(네이버 목록에 보이는 썸네일)에 프로그램이 얹을 문구(text)와 그림 장면(scene)입니다.
   - text: 첫 번째 제목을 본 독자의 궁금증을 한 번 더 키우는 짧은 문구입니다. 제목을 그대로 되풀이하지 않고, 답은 숨긴 채 질문·반전·의외의 사실로 끝까지 읽고 싶게 만듭니다. 두 줄 이내로 줄 사이는 \\n 으로 나누고, 한 줄은 띄어쓰기 포함 12자 안팎입니다. 메인 키워드의 핵심 낱말 하나를 넣고, 본문이 실제로 답하는 내용만 다룹니다(낚시·과장 금지). 형식 예시(그대로 쓰지 않음): ${parenting ? '"해열제 먹였는데\\n왜 열이 그대로일까?"' : '"양치를 해도\\n냄새가 나는 진짜 이유"'}
   - scene: 그 궁금증을 부르는 실사 장면 25자 안팎입니다. 답(해결책·결과)은 보여 주지 않고, 고민하거나 의아해하는 순간을 담습니다(예: ${parenting ? '"체온계를 들고 아이 곁에서 고민하는 아빠"' : '"입을 가리고 대화를 머뭇거리는 직장인"'}).
9. 분량은 공백 제외 약 ${target}자(${low}~${high}자, 공백 포함으로는 약 ${spacedLow}~${spacedHigh}자)로 맞춥니다. 이보다 길게 쓰지 않습니다. 사진 표시·인사말·요약·태그는 글자수에 넣지 않습니다. 같은 내용을 되풀이하거나 군더더기 문장으로 늘이지 말고, 짧은 문장으로 핵심 정보와 흔한 사례·구체적인 팁을 알차게 담습니다. 다른 블로그 문장을 베끼지 말고 이 글만의 표현과 예시로 씁니다(유사문서 방지).
${expand}${shrink}${extraPrompt ? `
글쓴이의 추가 요청 (위 가이드라인보다 우선합니다. 단, 아래 JSON 형식은 그대로 지킵니다)
${extraPrompt}
` : ''}
설명 없이 JSON 형식만 출력합니다.
{
  "titles": ["", "", ""],
  "intro": { "paragraphs": ["[사진: 설명 | english words]", "", "", "★ 핵심 문장"], "highlight": "" },
  "sections": [ { "keyword": "", "heading": "", "paragraphs": ["[사진: 설명 | english words]", "", "", "★ 핵심 문장", "", ""], "highlight": "" } ],
  "conclusion": { "paragraphs": ["[사진: 설명 | english words]", "", ""], "question": "" },
  "summary": ["", "", "", ""],
  "tags": ["", "", "", "", ""],
  "thumbnail": { "text": "", "scene": "" }
}`;
};

const asArray = (value, fallback = []) => (Array.isArray(value) && value.length > 0 ? value : fallback);

// 문단 목록을 다듬습니다.
// - 사진 표시는 따로 떼어 자리표(@@photo-tmp@@)로 바꾸고 사진 정보는 photos 에 모읍니다.
// - 글은 말투 규칙을 적용하고(AI 글은 구어체 유지, 기본 틀은 합니다체) 한 단락을 3문장 이하로 자릅니다.
// 문장 끝 말투입니다. 기본(casual)은 "~해요·~거든요·~죠"를 섞은 친근한 구어체, formal 은 "~합니다/~습니다/~입니다"(다로 끝냄)입니다. (.env 의 BLOG_TONE)
// 2026-10-03 합니다체 → 2026-10-08 다시 구어체(사용자 요청: 친근하고 몰입감 있는 구어체, 경험담 형태)
const formalTone = () => String(process.env.BLOG_TONE || 'casual').trim().toLowerCase() !== 'casual';
// AI 글을 다듬습니다. 합니다체면 "~요/~죠"로 끝난 문장을 바꿉니다.
const voice = (text) => (formalTone() ? formalize(tidy(text)) : tidy(text));

// 중요 문장 표시입니다. AI 가 단락 맨 앞에 ★ 를 붙인 핵심 문장은 이 표시를 달아 두고,
// blocks.js 가 그 단락을 초록 글씨(제목과 같은 색)로 넣습니다. (사용자 요청 — 기준 완성 글처럼 본문 중간 핵심 문장 강조)
const EMPHASIS = '@@em@@';
const EMPHASIS_MARK = /^\s*[★☆]\s*/;

// 댓글·공감·이웃 추가를 부탁하는 문장입니다. 지시문에서 금지했지만 AI 가 써 오면 그 문장만 지웁니다. (사용자 요청)
const ASK_FOR_COMMENT = /댓글|이웃\s*추가|공감\s*(버튼|꾹|눌러|부탁)|구독|여러분(의)?\s*(아이|집|경험)[^.?!]*\?/;
// 부탁 문장은 보통 단락 끝에 붙고 뒤에 "큰 도움이 될 거예요" 같은 맺음말이 따라오므로, 처음 나온 부탁 문장부터 단락 끝까지 지웁니다.
const dropAsks = (text) => {
  const sentences = splitSentences(text);
  const at = sentences.findIndex((sentence) => ASK_FOR_COMMENT.test(sentence));
  return (at < 0 ? sentences : sentences.slice(0, at)).join(' ');
};
// dropAsks 가 지우는 부분(처음 나온 부탁 문장부터 끝까지)입니다.
const asksOf = (text) => {
  const sentences = splitSentences(text);
  const at = sentences.findIndex((sentence) => ASK_FOR_COMMENT.test(sentence));
  return at < 0 ? '' : sentences.slice(at).join(' ');
};

// 기준 시점 문구("2026년 10월 발표 기준으로", "(2026년 기준)", "최신 기준으로는")는 쓰지 않습니다. (사용자 요청 2026-10-14)
// 지시문 6번에서 금지하고, AI 가 써 오면 그 문구만 지웁니다(문장은 남김).
const asOfRule = (year) => `기준 시점을 밝히는 문구("${year}년 ○월 발표 기준", "${year}년 기준으로", "최신 기준으로", "현재 기준", 괄호 안의 "(○월 기준)")는 제목·본문·요약 어디에도 쓰지 않습니다. 최신 내용은 기준 시점을 붙이지 않고 지금의 사실로 바로 씁니다.`;
// "1월 1일 기준 만 34세"처럼 날짜까지 정한 자격 기준과 "2026년 기준 중위소득" 같은 용어는 내용이므로 건드리지 않습니다.
const AS_OF_YEAR = '(?:20\\d{2}\\s*년(?:\\s*(?:상반기|하반기|\\d{1,2}\\s*월))?|올해|금년)';
const AS_OF_WHEN = `(?:${AS_OF_YEAR}(?:\\s*(?:발표|현재|고시|공고|개정|시행|최신))?|최신|현재|지금)`;
const AS_OF_AFTER = '(?:으로\\s*(?:보면|봤을\\s*때|볼\\s*때|따지면|하면|했을\\s*때)\\s*,?|으로는|으로|에서는|,)';
// 기준 뒤에 이어지면 용어가 되는 말입니다("기준 중위소득", "기준 금리").
const AS_OF_TERM = '(?:\\s|중위|금리|소득|금액|단가|환율|가격|요금|연령|나이|체중|점수|시간|연도|액|값|선|치|표|량|율)';
const AS_OF_PATTERNS = [
  // 괄호 안: "(2026년 10월 발표 기준)", "(10월 1일 기준)", "(최신 기준)"
  new RegExp(`\\s*[(（]\\s*(?:${AS_OF_WHEN}|\\d{1,2}\\s*월)(?:\\s*\\d{1,2}\\s*일)?\\s*기준\\s*[)）]`, 'g'),
  // 뒤에 "으로·으로는·에서는·," 가 붙은 꼴: "2026년 기준으로 ", "최신 기준으로 보면 ", "올해 기준, "
  new RegExp(`${AS_OF_WHEN}\\s*기준\\s*${AS_OF_AFTER}\\s*`, 'g'),
  // 발표·고시·공고를 밝힌 꼴: "2026년 10월 발표 기준 지원금은"
  new RegExp(`${AS_OF_YEAR}\\s*(?:발표|고시|공고)\\s*기준\\s+(?!${AS_OF_TERM})`, 'g'),
  // 해·달만 붙은 꼴: "2026년 기준 최저임금은", "최신 기준 지원 대상은" (뒤가 용어면 그대로 둠)
  new RegExp(`(?:${AS_OF_YEAR}|최신|현재)\\s*기준\\s+(?!${AS_OF_TERM})`, 'g'),
  // "2026년 현재 청년미래적금은", "2026년 10월 현재, "
  new RegExp(`20\\d{2}\\s*년(?:\\s*\\d{1,2}\\s*월)?\\s*현재\\s*,?\\s*`, 'g'),
  // 끝에 홀로 남은 꼴: 썸네일 줄 "2026년 기준", "…10,320원, 2026년 기준."
  new RegExp(`\\s*${AS_OF_WHEN}\\s*기준\\s*(?=$|[.!?])`, 'g'),
];
const dropAsOf = (text) => {
  const source = String(text ?? '');
  const out = AS_OF_PATTERNS.reduce((value, pattern) => value.replace(pattern, ''), source);
  if (out === source) {
    return source;
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/,([.!?])/g, '$1')
    .replace(/^\s*,\s*/, '').replace(/([.!?])\s*,\s*/g, '$1 ').trim();
};
// 글 전체(제목·서론·소제목·결론·요약·썸네일 문구)에 dropAsOf 를 씁니다. 키워드에 "기준"이 들어 있으면 주제 자체이므로 건드리지 않습니다.
const dropAsOfDraft = (draft, keywords) => {
  if (keywords.some((item) => String(item).includes('기준'))) {
    return;
  }
  const list = (items) => (items || []).map(dropAsOf).filter(Boolean);
  draft.titles = list(draft.titles);
  draft.title = draft.titles[0] || dropAsOf(draft.title);
  draft.intro.paragraphs = list(draft.intro.paragraphs);
  draft.intro.highlight = dropAsOf(draft.intro.highlight);
  draft.sections.forEach((section) => {
    section.heading = dropAsOf(section.heading);
    section.paragraphs = list(section.paragraphs);
    section.highlight = dropAsOf(section.highlight);
    section.imageCaption = dropAsOf(section.imageCaption);
  });
  // 사진 설명은 사진 아래 글씨로 들어갑니다(소제목으로 만든 설명 포함).
  (draft.photos || []).forEach((photo) => {
    if (photo) {
      photo.caption = dropAsOf(photo.caption);
    }
  });
  draft.conclusion.paragraphs = list(draft.conclusion.paragraphs);
  draft.conclusion.highlight = dropAsOf(draft.conclusion.highlight);
  draft.conclusion.question = dropAsOf(draft.conclusion.question);
  draft.doctor = list(draft.doctor);
  if (Array.isArray(draft.thumbnail?.text)) {
    const lines = list(draft.thumbnail.text);
    draft.thumbnail.text = lines.length ? lines : [draft.title].filter(Boolean);
  }
};

// 결론은 댓글·공감을 부르는 질문으로 끝맺습니다(사용자 요청 2026-10-14 — 2026-10-02 "CTA 뺌"을 대체).
// 질문은 conclusion.question 한 곳에만 두고(blocks.js 가 결론 끝에 넣음), 본문 단락의 부탁 문장은 dropAsks 가 계속 지웁니다.
// AI 가 question 을 안 주면 결론 마지막 단락에서 지워질 부탁 문장을 옮겨 쓰고, 그것도 없으면 기본 질문을 씁니다.
const questionOf = (raw, base, chat) => {
  if (!raw) {
    return base.conclusion?.question || '';
  }
  const given = String(raw.conclusion?.question ?? '').replace(/\*\*/g, '').trim();
  const last = [...(Array.isArray(raw.conclusion?.paragraphs) ? raw.conclusion.paragraphs : [])].reverse()
    .find((item) => typeof item === 'string' && item.trim() && !/^\s*\[\s*사진/.test(item));
  const asked = last ? asksOf(String(last).replace(EMPHASIS_MARK, '')) : '';
  const fallback = chat ? '' : (formalTone()
    ? '여러분은 어떤 경험이 있으셨습니까? 나만의 방법이나 궁금한 점이 있다면 댓글로 함께 나눠 주시기 바랍니다.'
    : '여러분은 이런 경험 있으셨나요? 나만의 방법이나 궁금한 점이 있다면 댓글로 편하게 나눠 주세요!');
  const text = given || asked || fallback;
  return text ? voice(text) : '';
};

const shapeParagraphs = (items, { casual, photos, fallbackQuery = '' }) => {
  const out = [];
  items.forEach((item) => {
    String(item ?? '').split(/(\[\s*사진\s*[:：][^\]]+\])/).forEach((piece) => {
      // ★ 핵심 문장은 3문장 나누기 없이 한 단락으로 두고 강조 표시를 붙입니다.
      if (EMPHASIS_MARK.test(piece)) {
        const text = (casual ? voice : polish)(piece.replace(EMPHASIS_MARK, ''));
        if (text) {
          out.push(`${EMPHASIS}${text}`);
        }
        return;
      }
      const mark = /^\[\s*사진\s*[:：]\s*([^\]]+?)\s*\]$/.exec(piece.trim());
      if (mark) {
        const [caption, query] = mark[1].split('|').map((part) => part.trim());
        // 한국어 설명에 AI 가 영어 검색용 "Asian" 을 섞어 쓰면 사진 아래에 그대로 보이므로 지웁니다.
        const koCaption = String(caption || '').replace(/\b(asian|korean)\b\s*/gi, '').trim();
        photos.push({ caption: koCaption.slice(0, 28), query: query || fallbackQuery });
        out.push(`@@photo-tmp:${photos.length - 1}@@`);
        return;
      }
      const text = casual ? voice(dropAsks(piece)) : polish(piece);
      const sentences = splitSentences(text);
      for (let start = 0; start < sentences.length; start += 3) {
        out.push(sentences.slice(start, start + 3).join(' '));
      }
    });
  });
  return out.filter(Boolean);
};

const cleanTags = (list, input) => {
  const main = String(input.keyword ?? '').replace(/\s+/g, '');
  const seen = new Set();
  const tags = [];
  [main, ...(Array.isArray(list) ? list : [])].forEach((item) => {
    const tag = String(item ?? '').replace(/^#+/, '').replace(/\s+/g, '').trim();
    if (tag && tag.length <= 20 && !seen.has(tag.toLowerCase()) && tags.length < 10) {
      seen.add(tag.toLowerCase());
      tags.push(tag);
    }
  });
  // 10개가 안 되면 기본 태그로 채웁니다. (사용자 요청: 태그 10개 한 줄)
  makeTags([input.keyword, ...(input.subKeywords || [])], input.related || [], 12).forEach((tag) => {
    if (tags.length < 10 && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      tags.push(tag);
    }
  });
  return tags;
};

// 육박사의 간단 요약 줄을 만듭니다. 기호·번호·굵은 글씨를 떼고 3~4줄로 맞춥니다.
const cleanSummaryLine = (line) => (String(line ?? '')
  .replace(/\*\*/g, '')
  .replace(/^\s*(?:[-*·•✔✓☑▶]|\d+[.)])\s*/, '')
  .replace(/\s+/g, ' ').trim());

const summaryOf = (raw, base) => {
  if (!raw) {
    return (base.doctor || []).slice(0, 5).map(toFormal);
  }
  const given = (Array.isArray(raw.summary) ? raw.summary : Array.isArray(raw.doctor) ? raw.doctor : [])
    .map(cleanSummaryLine).filter(Boolean).map((line) => (formalTone() ? formalize(line) : line));
  if (given.length > 0) {
    return given.slice(0, 5);
  }
  // AI 가 요약을 빠뜨리면 소제목마다 본문 첫 문장을 하나씩 뽑습니다. (사진 표시는 건너뜀)
  return (raw.sections || [])
    .map((section) => (section.paragraphs || []).find((item) => item && !/^\s*\[\s*사진/.test(item) && !/^@@photo/.test(item)))
    .map((item) => item && String(item).replace(EMPHASIS, ''))
    .filter(Boolean)
    .map((paragraph) => cleanSummaryLine(splitSentences(String(paragraph))[0] || ''))
    .filter(Boolean)
    .slice(0, 4);
};

// 맨 위 썸네일에 얹을 문구와 그림 장면입니다. (사용자 요청 2026-10-08: 이미지로 제목의 궁금증을 한 번 더 키움)
// text 는 줄마다 나눈 배열(최대 2줄)이며 renderer/imagelab.js 가 그림 아래쪽에 크게 씁니다.
// AI 가 문구를 안 주거나 너무 길면 제목을 대신 씁니다(채팅 모드·기본 틀 포함).
const thumbnailOf = (raw, title) => {
  const clean = (value) => String(value ?? '').replace(/\*\*/g, '').replace(/["“”'‘’#]/g, '').trim();
  // AI 가 줄바꿈을 글자 그대로 "\n" 으로 쓰거나 " / " 로 나눠 써도 줄로 나눕니다.
  const lines = clean(raw?.thumbnail?.text).replace(/\\n/g, '\n').split(/\n|\s+\/\s+/).map((line) => line.trim()).filter(Boolean).slice(0, 2);
  const tooLong = lines.join('').length > 32;
  return {
    text: lines.length && !tooLong ? lines : [clean(title)].filter(Boolean),
    scene: clean(raw?.thumbnail?.scene).replace(/\b(asian|korean)\b\s*/gi, '').slice(0, 40),
  };
};

// 그림(GPT Image)이 담을 글 내용을 사진마다 붙입니다. (사용자 요청)
// - 서론·소제목·결론 사진: 그 구역 이름 + 정리할 핵심 + 그 구역 글
// - 맨 위 대표 사진: 글 전체(제목·서론·소제목·요약·결론)
const PHOTO_MARK = /^@@photo:(\d+)@@$/;
const textOf = (paragraphs = []) => paragraphs.filter((item) => !PHOTO_MARK.test(item)).map((item) => item.replace(EMPHASIS, '')).join(' ').replace(/\s+/g, ' ').trim();
// 그 구역을 최종 정리하는 문장: ★ 핵심 단락 + 마지막 단락. 그림이 이 내용을 물건·사람 장면으로 담습니다.
// (사용자 요청 2026-10-05: 서론·소제목·결론마다 내용을 최종 정리하는 물건·사람 실사 사진)
// 글 내용 앞쪽에 두어, 긴 소제목 글이 1100자에서 잘려도 핵심은 빠지지 않습니다.
const keyPointsOf = (paragraphs = []) => {
  const texts = paragraphs.filter((item) => item && !PHOTO_MARK.test(item));
  const starred = texts.filter((item) => item.startsWith(EMPHASIS)).map((item) => item.replace(EMPHASIS, ''));
  const last = texts.length ? texts[texts.length - 1].replace(EMPHASIS, '') : '';
  return [...new Set([...starred, last].filter(Boolean))].join(' ').replace(/\s+/g, ' ').trim().slice(0, 320);
};
const attachImageContext = (draft) => {
  const whole = [
    '구역: 글 전체(맨 위 대표 사진)',
    `제목: ${draft.title}`,
    `서론: ${textOf((draft.intro?.paragraphs || []).filter((item) => item !== draft.intro?.greeting)).slice(0, 200)}`,
    `소제목: ${(draft.sections || []).map((section) => section.heading).join(' / ')}`,
    (draft.doctor || []).length ? `핵심: ${draft.doctor.join(' / ')}` : '',
    `결론: ${textOf(draft.conclusion?.paragraphs).slice(0, 200)}`,
  ].filter(Boolean).join('\n').slice(0, 1100);
  // 글쓴이(예: 재쁜이 아빠)를 알려 주어, 부모가 나오면 글쓴이처럼 그리게 합니다.
  // 육아 주제가 아니면 넣지 않습니다. "아빠 육아박사"를 보고 아빠와 아이를 그리곤 했습니다(2026-10-03 "aws 자격증" 글).
  const writer = isParentingTopic(draft.mainKeyword, draft.subKeywords, draft.title) ? `글쓴이: ${personaOf()}\n` : '';
  draft.imageContext = writer + whole;
  const mark = (paragraphs, context) => (paragraphs || []).forEach((item) => {
    const slot = PHOTO_MARK.exec(item);
    if (slot && draft.photos?.[Number(slot[1])]) {
      draft.photos[Number(slot[1])].context = context;
    }
  });
  // 서론·결론 사진은 글 전체 요약이 아니라 그 구역의 글을 담습니다. 셋 다 같은 요약을 받아
  // 비슷하고 막연한 그림(또는 "한눈에 보는 정리" 같은 설명만 보고 엉뚱한 그림)이 나오곤 했습니다. (2026-10-05)
  const introParagraphs = (draft.intro?.paragraphs || []).filter((item) => item !== draft.intro?.greeting);
  const introText = textOf(introParagraphs);
  mark(draft.intro?.paragraphs, `${writer}구역: 서론
제목: ${draft.title}
정리할 핵심: ${keyPointsOf(introParagraphs)}
서론 내용: ${introText}`.slice(0, 1100));
  (draft.sections || []).forEach((section) => {
    mark(section.paragraphs, `${writer}구역: 본론 소제목
소제목: ${section.heading}
정리할 핵심: ${keyPointsOf(section.paragraphs)}
내용: ${textOf(section.paragraphs)}`.slice(0, 1100));
  });
  // 소제목 사진 설명이 다른 사진과 거의 같으면(예: 소제목마다 "유산균 캡슐과 물컵") 같은 그림이 되풀이돼
  // 그 소제목 내용과 안 맞았습니다. 겹치거나 비었으면 설명 앞에 소제목을 붙입니다. (2026-10-05)
  const wordsOf = (text) => new Set(String(text || '').split(/\s+/).map((w) => w.replace(/(과|와|의|을|를|이|가|은|는|에|위)$/, '')).filter((w) => [...w].length >= 2));
  const seen = [];
  (draft.sections || []).forEach((section) => {
    (section.paragraphs || []).forEach((item) => {
      const slot = PHOTO_MARK.exec(item);
      const photo = slot && draft.photos?.[Number(slot[1])];
      if (!photo) return;
      const words = wordsOf(photo.caption);
      const dup = seen.some((other) => words.size && other.size
        && [...words].filter((w) => other.has(w)).length / Math.min(words.size, other.size) >= 0.6);
      seen.push(words);
      if (dup || !words.size) {
        const head = String(section.heading || '').replace(/[,.].*$/, '').trim();
        photo.caption = photo.caption ? `${head} — ${photo.caption}` : head;
      }
    });
  });
  const closingText = textOf(draft.conclusion?.paragraphs);
  // 결론 사진의 정리할 핵심에는 간단 요약(육박사의 간단 요약) 줄도 함께 넣습니다.
  const closingKey = [keyPointsOf(draft.conclusion?.paragraphs), ...(draft.doctor || []).slice(0, 3)].filter(Boolean).join(' / ');
  mark(draft.conclusion?.paragraphs, `${writer}구역: 결론
제목: ${draft.title}
정리할 핵심: ${closingKey.slice(0, 400)}
결론 내용: ${closingText}`.slice(0, 1100));
  // 결론 사진 설명이 막연한 기본값이면 결론 첫 문장을 장면 설명으로 씁니다.
  (draft.conclusion?.paragraphs || []).forEach((item) => {
    const slot = PHOTO_MARK.exec(item);
    const photo = slot && draft.photos?.[Number(slot[1])];
    if (photo && photo.caption === '한눈에 보는 정리' && closingText) {
      photo.caption = splitSentences(closingText)[0].slice(0, 80);
    }
  });
};

// AI 응답이든 기본 틀이든 같은 모양으로 정리하고 문장 규칙을 적용합니다.
const normalizeDraft = (raw, input) => {
  const base = localDraft(input);
  const casual = Boolean(raw);
  // 채팅 모드 글은 AI 가 쓴 그대로 둡니다. 비어 있는 곳을 기본 틀 문장으로 채우지 않습니다.
  const chat = Boolean(raw?.chat);
  const photos = [];
  const hint = base.imageHint || '';

  // 제목 후보: 직접 넣은 제목 + AI 추천 3개. 둘 다 없을 때만 기본 틀 제목을 씁니다.
  const cleanTitle = (item) => String(item ?? '').replace(/\*\*/g, '').trim();
  // 같은 낱말(2글자 이상)이 두 번 넘게 나오거나 조사가 띄어 쓰인("증상 이랑") 어색한 제목은 추천 순서에서 뒤로 보냅니다.
  // (예: "아기 계란 알러지 증상 및 알러지 증상 이랑 알러지 검사가 궁금하다면")
  const awkward = (title) => {
    const words = title.split(/\s+/).map((word) => word.replace(/(이|가|을|를|은|는|과|와|의|도|이랑|랑)$/, '')).filter((word) => [...word].length >= 2);
    const counts = words.reduce((map, word) => map.set(word, (map.get(word) || 0) + 1), new Map());
    return [...counts.values()].some((count) => count >= 3) || [...counts.values()].filter((count) => count >= 2).length >= 2
      || /\s(이랑|랑|이나|으로|에서)(\s|$)/.test(title);
  };
  // 제목은 하나만 씁니다(사용자 요청 2026-10-08: 미리보기에서 고르지 않고 제일 괜찮은 것 1개).
  // AI 는 후보 3개를 가장 좋은 순서로 주므로 그 순서를 따르되, 규칙에 어긋난 후보는 뒤로 미룹니다.
  // 어색함(낱말 겹침) > 본문에 없는 숫자 > 메인 키워드 빠짐 > 밋밋한 꼴("~궁금하다면", "총정리") > 숫자 없음·길이(15~40자 밖) 순으로 무겁게 봅니다.
  const compact = (text) => String(text ?? '').replace(/\s+/g, '');
  // 제목에는 직관적인 숫자를 넣되(사용자 요청 2026-10-14), 그 숫자("3주", "1000만 원")가 본문에 한 번도 안 나오면
  // 지어낸 숫자일 수 있어 숫자 없는 제목보다도 뒤로 미룹니다.
  const bodyDigits = JSON.stringify([raw?.intro, raw?.sections, raw?.conclusion, raw?.summary]).replace(/,/g, '');
  const unbacked = (title) => (title.match(/\d[\d,.]*/g) || [])
    .some((num) => !bodyDigits.includes(num.replace(/[,.]+$/, '').replace(/,/g, '')));
  const penalty = (title) => (awkward(title) ? 10 : 0)
    + (compact(title).includes(compact(input.keyword)) ? 0 : 4)
    + (/궁금하다면|총정리|알아보기|알아보자|에 대해/.test(title) ? 3 : 0)
    + (/\d/.test(title) ? (unbacked(title) ? 5 : 0) : 2)
    + ([...title].length < 15 || [...title].length > 40 ? 2 : 0);
  const aiTitles = [...new Set([...(Array.isArray(raw?.titles) ? raw.titles : []), raw?.title].map(cleanTitle).filter(Boolean))].slice(0, 3)
    .map((title, index) => ({ title, score: penalty(title) + index }))
    .sort((a, b) => a.score - b.score)
    .map((item) => item.title);
  // 직접 넣은 제목이 있으면 그 제목을, 없으면 가장 나은 AI 제목을 씁니다. 둘 다 없을 때만 기본 틀 제목입니다.
  const candidates = [...new Set([cleanTitle(input.title), ...aiTitles].filter(Boolean))];
  const titles = candidates.length ? candidates.slice(0, 1) : [base.title];

  const shapeSection = (section, fallback) => {
    const heading = String(section.heading || fallback.heading).replace(/\*\*/g, '').trim()
      // AI 가 소제목 앞에 번호나 괄호·따옴표를 붙여도 지웁니다. (인용구 상자로 꾸밉니다)
      .replace(/^\d+\s*[.)]\s*/, '').replace(/^[[「『"']+|[\]」』"']+$/g, '').replace(/\.$/, '')
      .trim();
    // AI 글은 기본 틀의 사진 검색어가 주제와 동떨어질 수 있어 주제 검색어를 먼저 씁니다.
    const query = String(section.imageQuery || (casual ? hint : '') || fallback.imageQuery || hint).trim();
    let paragraphs = shapeParagraphs(asArray(section.paragraphs, fallback.paragraphs), { casual, photos, fallbackQuery: query });
    // 소제목마다 사진은 한 장만, 소제목 바로 아래에 둡니다. (사용자 요청 — 기준 완성 글과 같은 순서)
    // AI 가 사진 표시를 여러 개 넣었으면 첫 사진만 남겨 맨 앞으로 옮기고, 없으면 새로 한 장 넣습니다.
    const firstPhoto = paragraphs.find((item) => item.startsWith('@@photo-tmp:'));
    paragraphs = paragraphs.filter((item) => !item.startsWith('@@photo-tmp:'));
    if (firstPhoto) {
      paragraphs = [firstPhoto, ...paragraphs];
    } else {
      photos.push({ caption: String(section.imageCaption || heading).slice(0, 28), query });
      paragraphs = [`@@photo-tmp:${photos.length - 1}@@`, ...paragraphs];
    }
    return {
      heading,
      keyword: String(section.keyword || '').trim(),
      paragraphs,
      highlight: casual ? voice(section.highlight ?? '') : toFormal(section.highlight ?? fallback.highlight),
      imageQuery: query,
      imageCaption: String(section.imageCaption || heading).trim().slice(0, 28),
    };
  };

  const draft = {
    title: titles[0] || base.title,
    titles,
    // 고르지 않은 나머지 후보는 저장 파일에만 남깁니다(화면에는 안 보임).
    titleCandidates: candidates,
    mainKeyword: input.keyword,
    subKeywords: input.subKeywords || [],
    intro: {
      paragraphs: shapeParagraphs(chat ? (raw.intro?.paragraphs || []) : asArray(raw?.intro?.paragraphs, base.intro.paragraphs), { casual, photos, fallbackQuery: hint }),
      highlight: casual ? voice(raw?.intro?.highlight ?? '') : toFormal(base.intro.highlight),
    },
    sections: (chat ? (raw.sections || []) : asArray(raw?.sections, base.sections))
      .slice(0, 4)
      .map((section, index) => shapeSection(section, base.sections[index % base.sections.length])),
    conclusion: {
      paragraphs: shapeParagraphs(chat ? (raw.conclusion?.paragraphs || []) : asArray(raw?.conclusion?.paragraphs, base.conclusion.paragraphs), { casual, photos, fallbackQuery: hint }),
      highlight: casual ? voice(raw?.conclusion?.highlight ?? '') : toFormal(base.conclusion.highlight),
      // 총평·별점은 넣지 않습니다. 글은 댓글·공감을 부르는 질문으로 끝맺습니다. (사용자 요청 2026-10-14, questionOf)
      rating: '',
      question: questionOf(raw, base, chat),
    },
    // 새 글 구조에는 전체 글 목록이 없습니다.
    postList: [],
    // 육박사의 간단 요약(결론 다음). AI 가 summary 를 안 주면 소제목마다 첫 문장을 뽑아 만듭니다.
    doctor: summaryOf(raw, base),
    tags: casual ? cleanTags(raw?.tags, input) : makeTags([input.keyword, ...(input.subKeywords || [])], input.related || [], 7),
    thumbnail: thumbnailOf(raw, titles[0] || base.title),
    imageHint: hint,
    source: raw ? 'ai' : 'local',
  };

  // AI 가 소제목을 3개보다 적게 주면 기본 틀의 소제목으로 채웁니다.
  let guard = 0;
  while (!chat && draft.sections.length < 3 && guard < base.sections.length) {
    const extra = base.sections[guard];
    if (!draft.sections.some((section) => section.heading === extra.heading)) {
      draft.sections.push(shapeSection({ ...extra, highlight: toFormal(extra.highlight) }, extra));
    }
    guard += 1;
  }

  // 서론도 사진 한 장으로 시작합니다(인사말 바로 다음, 기준 완성 글과 같은 순서). 여러 장이면 첫 장만 남깁니다.
  // 맨 위 대표 사진(스티커 위)은 따로이며 app.js 의 imagePlan 첫 장입니다.
  {
    const first = draft.intro.paragraphs.find((item) => item.startsWith('@@photo-tmp:'));
    const rest = draft.intro.paragraphs.filter((item) => !item.startsWith('@@photo-tmp:'));
    if (first) {
      draft.intro.paragraphs = [first, ...rest];
    } else {
      photos.push({ caption: String(draft.title || input.keyword).slice(0, 28), query: hint });
      draft.intro.paragraphs = [`@@photo-tmp:${photos.length - 1}@@`, ...rest];
    }
  }

  // 결론도 소제목처럼 "결론" 인용구 바로 아래에 사진 한 장으로 시작합니다. (기준 완성 글과 같은 순서)
  // AI 가 결론 중간에 사진 표시를 넣었으면 그 사진을 맨 앞으로 옮기고, 없으면 새로 한 장 넣습니다.
  const closing = draft.conclusion.paragraphs;
  if (closing.some((item) => !item.startsWith('@@photo-tmp:'))) {
    const at = closing.findIndex((item) => item.startsWith('@@photo-tmp:'));
    if (at > 0) {
      closing.unshift(...closing.splice(at, 1));
    } else if (at < 0) {
      // 무료 사진으로 대신할 때의 검색어: 마지막 소제목 사진의 검색어를 빌려 쓰고, 없으면 주제 힌트를 씁니다.
      // (빈 검색어·주제 힌트("tea rest")로 찾아 향수병·찻잔 같은 엉뚱한 사진이 나왔습니다. 2026-10-05)
      const lastSection = /^@@photo-tmp:(\d+)@@$/.exec(draft.sections[draft.sections.length - 1]?.paragraphs?.[0] || '');
      const borrowed = lastSection ? photos[Number(lastSection[1])]?.query : '';
      photos.push({ caption: '한눈에 보는 정리', query: borrowed || hint });
      closing.unshift(`@@photo-tmp:${photos.length - 1}@@`);
    }
  }

  // 사진 번호를 글에 나오는 순서(도입부 → 소제목 → 결론)대로 다시 매깁니다.
  // 대표 이미지(제목 사진)는 따로이며, 여기 photos 는 본문 사진만입니다.
  const ordered = [];
  const renumber = (list) => list.map((item) => {
    const match = /^@@photo-tmp:(\d+)@@$/.exec(item);
    if (!match) {
      return item;
    }
    ordered.push(photos[Number(match[1])]);
    return `@@photo:${ordered.length - 1}@@`;
  });
  draft.intro.paragraphs = renumber(draft.intro.paragraphs);
  draft.sections.forEach((section) => {
    section.paragraphs = renumber(section.paragraphs);
  });
  draft.conclusion.paragraphs = renumber(draft.conclusion.paragraphs);
  draft.photos = ordered;

  // 서론은 항상 블로그 인사말로 시작합니다. (.env 의 BLOG_GREETING 으로 바꿀 수 있습니다)
  // AI 가 따로 인사를 써 왔으면 겹치지 않게 그 인사 문장은 지웁니다.
  const greeting = greetingText();
  if (greeting) {
    // AI 가 쓴 인사는 첫 글 문단에서 지웁니다. (서론 맨 앞은 사진 자리라 그다음 문단입니다)
    const firstText = draft.intro.paragraphs.findIndex((item) => !PHOTO_MARK.test(item));
    const rest = draft.intro.paragraphs
      .map((item, index) => (index === firstText ? item.replace(/^\s*안녕하세요[^.!?。]*[.!?。]?\s*([^.!?。]*(입니다|이에요|예요|이랍니다)[.!?。]?\s*)?/, '').trim() : item))
      .filter(Boolean);
    draft.intro.paragraphs = [greeting, ...rest];
    draft.intro.greeting = greeting; // blocks.js 가 인사말을 두 줄로 고르게 나누는 데 씁니다.
  }

  // 키워드 뒤 조사를 받침에 맞게 고칩니다. (예: 리눅스마스터 2급을 → 2급을, 뒤집기 시기을 → 시기를)
  // 그 전에 키워드 반복을 줄입니다. 줄인 말 뒤 조사도 같이 고치도록 단어 목록에 넣습니다.
  const inputKeywords = [input.keyword, ...(input.subKeywords || [])].filter(Boolean);
  // AI 글에 남은 기준 시점 문구("2026년 ○월 발표 기준")를 지웁니다. (사용자 요청 2026-10-14)
  if (casual) {
    dropAsOfDraft(draft, inputKeywords);
  }
  limitKeywords(draft, inputKeywords);
  const words = [
    input.keyword,
    ...(input.subKeywords || []),
    ...(input.related || []),
    ...modifiersOf(input.keyword, input.related || []),
    ...inputKeywords.map(shortFormOf),
  ];
  const fixDeep = (value) => {
    if (typeof value === 'string') {
      // AI 가 굵은 글씨 표시(**)를 넣어도 글에는 나오지 않게 지웁니다.
      return fixParticlesFor(value.replace(/\*\*/g, ''), words);
    }
    if (Array.isArray(value)) {
      return value.map(fixDeep);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fixDeep(item)]));
    }
    return value;
  };
  const fixed = fixDeep(draft);
  // 직접 넣은 제목은 글자 하나 바꾸지 않습니다. 조사 고치기·기준 시점 지우기를 거치지 않게 마지막에 되돌려 둡니다. (2026-10-17)
  const ownTitle = cleanTitle(input.title);
  if (ownTitle) {
    fixed.title = ownTitle;
    fixed.titles = [ownTitle];
  }
  attachImageContext(fixed);
  fixed.charCount = countChars(fixed);
  fixed.charCountWithSpaces = countChars(fixed, { spaces: true });
  return fixed;
};

export { EMPHASIS, keywordIssues, localDraft, buildPrompt, targetChars, targetRange, normalizeDraft, makeTitle, makeTags, limitKeywords, sectionKeywordsOf, dropAsOf };
