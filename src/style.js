// 문장 다듬기 규칙입니다. 해요체를 합니다체로 바꾸고 과장어를 걷어냅니다.

// 순서가 중요합니다. 긴(구체적인) 꼴을 먼저 바꿔야 "될 거예요"가 "될 거입니다"가 되지 않습니다.
// "~죠"·"~어요"·"~아요"는 앞 글자에 받침이 있을 때만 "~습니다"로 바꿉니다("중요하죠" → "중요하습니다" 방지, 아래 batchimRule).
const ENDINGS = [
  [/거예요([.!?]?)$/u, '것입니다$1'], [/거죠([.!?]?)$/u, '것입니다$1'], [/겠죠([.!?]?)$/u, '겠습니다$1'],
  [/하지요([.!?]?)$/u, '합니다$1'], [/하죠([.!?]?)$/u, '합니다$1'], [/되죠([.!?]?)$/u, '됩니다$1'],
  [/있죠([.!?]?)$/u, '있습니다$1'], [/없죠([.!?]?)$/u, '없습니다$1'], [/았죠([.!?]?)$/u, '았습니다$1'],
  [/었죠([.!?]?)$/u, '었습니다$1'], [/였죠([.!?]?)$/u, '였습니다$1'],
  [/이에요([.!?]?)$/u, '입니다$1'], [/예요([.!?]?)$/u, '입니다$1'],
  [/이죠([.!?]?)$/u, '입니다$1'], [/해요([.!?]?)$/u, '합니다$1'],
  [/돼요([.!?]?)$/u, '됩니다$1'], [/되어요([.!?]?)$/u, '됩니다$1'], [/봐요([.!?]?)$/u, '봅니다$1'],
  [/와요([.!?]?)$/u, '옵니다$1'], [/가요([.!?]?)$/u, '갑니다$1'], [/와주세요([.!?]?)$/u, '주시면 좋습니다$1'],
  [/주세요([.!?]?)$/u, '주시기 바랍니다$1'], [/세요([.!?]?)$/u, '시기 바랍니다$1'], [/있어요([.!?]?)$/u, '있습니다$1'],
  [/없어요([.!?]?)$/u, '없습니다$1'], [/같아요([.!?]?)$/u, '같습니다$1'], [/였어요([.!?]?)$/u, '였습니다$1'],
  [/았어요([.!?]?)$/u, '았습니다$1'], [/었어요([.!?]?)$/u, '었습니다$1'],
];

// 받침 있는 글자 뒤의 "~죠/~어요/~아요/~네요/~군요"만 "~습니다"로 바꿉니다. ("먹어요" → "먹습니다", "좋죠" → "좋습니다")
const hasBatchim = (char) => {
  const code = String(char || '').charCodeAt(0) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;
};
const batchimRule = (text) => text.replace(/([가-힣])(죠|어요|아요|네요|군요)([.!?]?)$/u, (match, before, ending, mark) => (
  hasBatchim(before) ? `${before}습니다${mark}` : match));

// "절대"는 바꾸지 않습니다. "절대 흔들지 마세요" 같은 육아 안전 경고가 "되도록"으로 약해지고,
// "절대적인"이 "되도록적인"이 되었습니다(2026-10-03).
const HYPE = [
  [/무조건/g, '대체로'], [/완벽한/g, '충실한'], [/완벽하게/g, '꼼꼼하게'],
  [/대박/g, '좋은 결과'], [/최고의/g, '손꼽히는'], [/백퍼/g, '대부분'],
  [/반드시 성공/g, '성공에 가까워짐'],
];

// 물음표로 끝나는 문장도 해요체면 격식 있게 바꿉니다.
// 바꿀 수 있는 형태만 담았고, 애매한 표현은 그대로 둡니다.
const QUESTION_ENDINGS = [
  [/이에요\?$/u, '입니까?'], [/예요\?$/u, '입니까?'], [/인가요\?$/u, '입니까?'], [/일까요\?$/u, '일까요?'],
  [/셨어요\?$/u, '셨습니까?'], [/으셨나요\?$/u, '으셨습니까?'], [/셨나요\?$/u, '셨습니까?'],
  [/있나요\?$/u, '있습니까?'], [/없나요\?$/u, '없습니까?'], [/되나요\?$/u, '됩니까?'],
  [/어떤가요\?$/u, '어떻습니까?'], [/하나요\?$/u, '합니까?'], [/한가요\?$/u, '합니까?'], [/할까요\?$/u, '할까요?'],
  [/하세요\?$/u, '하십니까?'], [/으세요\?$/u, '으십니까?'], [/세요\?$/u, '십니까?'],
  [/았어요\?$/u, '았습니까?'], [/었어요\?$/u, '었습니까?'], [/였어요\?$/u, '였습니까?'],
  [/해요\?$/u, '합니까?'], [/나요\?$/u, '습니까?'],
];

const TRAILING_PUNCT = /[.!?…]$/u;

// 문장 하나를 합니다체로 맞춥니다. 물음표로 끝나는 문장은 그대로 둡니다.
const toFormal = (sentence) => {
  let text = String(sentence ?? '').trim();
  if (!text) {
    return '';
  }
  HYPE.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });
  if (text.endsWith('?')) {
    QUESTION_ENDINGS.some(([pattern, replacement]) => {
      if (!pattern.test(text)) {
        return false;
      }
      text = text.replace(pattern, replacement);
      return true;
    });
    return text;
  }
  ENDINGS.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });
  text = batchimRule(text);
  if (!TRAILING_PUNCT.test(text)) {
    text = `${text}.`;
  }
  return text;
};

const splitSentences = (text) => String(text ?? '')
  .replace(/\s+/g, ' ')
  .split(/(?<=[.!?])\s+/)
  .map((item) => item.trim())
  .filter(Boolean);

// 문단 전체를 다듬습니다.
const polish = (text) => splitSentences(text).map(toFormal).filter(Boolean).join(' ');

// 구어체(~해요·~합니다·~죠 혼용) 글을 다듬습니다. 말끝은 바꾸지 않고, 과장어만 걷어내고
// 문장 끝 마침표만 채웁니다. AI 가 쓴 글에 씁니다.
const tidy = (text) => splitSentences(text).map((sentence) => {
  let out = sentence;
  HYPE.forEach(([pattern, replacement]) => {
    out = out.replace(pattern, replacement);
  });
  return TRAILING_PUNCT.test(out) || /[~)\]]$/.test(out) ? out : `${out}.`;
}).filter(Boolean).join(' ');

// 키워드 뒤에 붙는 조사를 받침에 맞게 고칩니다.
// 키워드처럼 "확실히 명사인 말" 뒤에서만 고치므로 다른 문장을 망가뜨리지 않습니다.
const PARTICLES = [
  ['을', '를'], ['은', '는'], ['이', '가'], ['과', '와'],
  ['이나', '나'], ['이라는', '라는'], ['이라고', '라고'], ['이라', '라'],
  ['이란', '란'], ['이며', '며'], ['이고', '고'],
];

const jongseongOf = (text) => {
  const char = String(text ?? '').trim().slice(-1);
  const code = char.codePointAt(0);
  if (!code || code < 0xac00 || code > 0xd7a3) {
    return null;
  }
  return (code - 0xac00) % 28;
};

const escapeRegex = (text) => String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const fixParticlesFor = (text, words = []) => {
  let out = String(text ?? '');
  words.filter(Boolean).forEach((word) => {
    const coda = jongseongOf(word);
    if (coda === null) {
      return;
    }
    const hasCoda = coda !== 0;
    const isRieul = coda === 8;
    PARTICLES.forEach(([withCoda, withoutCoda]) => {
      const pattern = new RegExp(`(${escapeRegex(word)})(${withCoda}|${withoutCoda})(?![가-힣])`, 'g');
      out = out.replace(pattern, (match, head) => `${head}${hasCoda ? withCoda : withoutCoda}`);
    });
    // 으로와 로는 받침이 ㄹ 일 때 로를 씁니다.
    const roPattern = new RegExp(`(${escapeRegex(word)})(으로|로)(?![가-힣])`, 'g');
    out = out.replace(roPattern, (match, head) => `${head}${hasCoda && !isRieul ? '으로' : '로'}`);
  });
  return out;
};

// 기본은 공백 제외로 셉니다(사용자 요청 2026-10-26: "2500자 정도인데 2000자 정도로" — 사용자가 말한 숫자가 공백 제외 글자수와 맞음).
// spaces 가 true 면 공백 포함으로 셉니다(화면에 함께 보여 줌). 단락 사이 줄바꿈은 세지 않고, 이어진 공백은 하나로 셉니다.
const countChars = (draft, { spaces = false } = {}) => {
  const parts = [
    draft.title,
    ...(draft.intro?.paragraphs || []),
    draft.intro?.highlight,
    ...(draft.sections || []).flatMap((section) => [section.heading, ...(section.paragraphs || []), section.highlight]),
    ...(draft.conclusion?.paragraphs || []),
    draft.conclusion?.highlight,
    draft.conclusion?.rating,
    draft.conclusion?.question,
    ...(draft.postList || []).flatMap((item) => [item.title, item.note]),
    ...(draft.doctor || []),
  ];
  // 사진 자리 표시(@@photo:0@@)는 글자수에 넣지 않습니다.
  const texts = parts.filter((part) => part && !/^@@photo:\d+@@$/.test(part))
    .map((part) => String(part).replace(/@@em@@/g, '').replace(/\s*\|\s*/g, ' '));
  return spaces
    ? texts.map((text) => text.replace(/\s+/g, ' ').trim()).join('').length
    : texts.join('').replace(/\s/g, '').length;
};

// AI 글 가운데 "~요/~죠"로 끝난 문장만 합니다체로 바꿉니다. 이미 "~다"로 끝난 문장은 건드리지 않습니다. (사용자 요청 2026-10-03)
const formalize = (text) => splitSentences(text)
  .map((sentence) => (/(요|죠)[.!?]?$/u.test(sentence) ? toFormal(sentence) : sentence))
  .join(' ');

export { formalize, toFormal, polish, tidy, splitSentences, countChars, fixParticlesFor };
