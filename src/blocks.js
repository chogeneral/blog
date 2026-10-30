import { splitSentences } from './style.js';

// content.js 의 EMPHASIS 와 같은 값입니다. ★ 로 고른 핵심 단락 표시입니다.
const EMPHASIS = '@@em@@';

// 글 초안을 에디터에 넣을 블록 목록으로 바꿉니다.
// 이미지는 서론 위 1장, 각 소제목 밑 1장, 결론 밑 1장으로 들어갑니다.

const COLORS = {
  heading: '#1f4e79',   // 소제목 네이비
  accent: '#00a84b',    // 중요 문장 초록 (제목과 같은 색, 굵게 쓰지 않고 색으로만 강조)
  point: '#1b6ec2',     // 보조 강조 파랑
  soft: '#6b7280',      // 캡션 회색
};

const SIZES = {
  body: 15,
  heading: 19,
  caption: 13,
};

// 글 맨 처음 여는 부분(가운데 정렬, 본문 정렬 설정과 상관없이 가운데): 스티커 → 제목 두 줄(초록 글씨 + 민트 배경) → 출처 한 줄.
// 스티커는 네이버 에디터 스티커 창에서 고릅니다. 자리는 아래 readSticker 설명을 보십시오.
//   묶음: 스티커 창 위쪽 묶음 단추를 왼쪽부터 센 순서(맨 왼쪽 시계 = 1), 줄·칸: 스티커 목록에서 위·왼쪽부터 센 순서
// .env 의 BLOG_OPENING=off 로 끄고, BLOG_CREDIT 으로 출처 문구를 바꿉니다.
const OPENING = {
  titleColor: '#00a84b',
  titleBackground: '#c2f4db',
  creditColor: '#999999',
  credit: '글, 사진, 영상 ©육박사',
};

// 스티커 자리 설정("묶음,줄,칸")을 읽습니다. off 거나 잘못 적으면 넣지 않습니다.
//   BLOG_STICKER: 글 맨 위(기본 1,4,2), BLOG_STICKER_INTRO: 서론 끝(기본 1,4,1),
//   BLOG_STICKER_SUMMARY: 간단 요약 바로 앞(기본 1,4,2), BLOG_STICKER_TAGS: 태그 바로 앞(기본 5,3,1)
const readSticker = (name, fallback) => {
  const raw = String(process.env[name] ?? fallback).trim();
  if (!raw || raw.toLowerCase() === 'off') {
    return null;
  }
  const [pack, row, column] = raw.split(/[,\s]+/).map(Number);
  return [pack, row, column].every((value) => Number.isInteger(value) && value > 0) ? { pack, row, column } : null;
};

// 본문 정렬(.env 의 BLOG_ALIGN = center 또는 left, 기본 가운데)과
// 한 줄 글자수(BLOG_LINE_CHARS, 띄어쓰기 포함, 기본 20자, 0 이면 줄바꿈 안 함)입니다.
// 간단 요약 제목 양옆 그림 글자(학사모 쓴 사람)와 요약 줄 정리. AI 가 줄 앞에 붙인 ·, ✓, - 같은 표시는 지웁니다.
const SUMMARY_ICON = '👨‍🎓';
const summaryLines = (draft) => (draft.doctor || [])
  .map((line) => String(line ?? '').replace(/^\s*(?:[·•✓✔\-*]|\d+[.)])\s*/, '').trim())
  .filter(Boolean);

const bodyAlign = () => (String(process.env.BLOG_ALIGN || 'center').toLowerCase() === 'left' ? 'left' : 'center');
const lineChars = () => {
  const value = Number(process.env.BLOG_LINE_CHARS ?? 20);
  return Number.isFinite(value) && value > 0 ? Math.max(10, Math.floor(value)) : 0;
};

// 낱말 단위로 앞에서부터 채워 max 자 이하의 줄로 나눕니다.
// 한 낱말이 max 자보다 길 때만 그 낱말을 잘라 넣습니다.
const greedyWrap = (value, max) => {
  const lines = [];
  let line = '';
  value.split(' ').forEach((word) => {
    let rest = word;
    while (rest.length > max) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    if (!rest) {
      return;
    }
    if (!line) {
      line = rest;
    } else if (line.length + 1 + rest.length <= max) {
      line = `${line} ${rest}`;
    } else {
      lines.push(line);
      line = rest;
    }
  });
  if (line) {
    lines.push(line);
  }
  return lines;
};

// 긴 문장은 줄 길이가 고르게 나눕니다. (예: 22자 + 4자 대신 13자 + 13자)
const balancedWrap = (sentence, max) => {
  if (sentence.length <= max) {
    return [sentence];
  }
  const fewest = greedyWrap(sentence, max).length;
  for (let width = Math.ceil(sentence.length / fewest); width < max; width += 1) {
    const lines = greedyWrap(sentence, width);
    if (lines.length <= fewest) {
      return lines;
    }
  }
  return greedyWrap(sentence, max);
};

// 문단을 띄어쓰기 포함 max 자 이하의 줄로 나눕니다.
// 문장 끝(. ? ! ~)에서 먼저 끊고, 짧은 문장끼리는 max 자 안에서 한 줄로 붙이며,
// 긴 문장은 낱말 사이에서 고르게 나눕니다. 낱말 중간에서는 자르지 않습니다.
// 문장이 끝나면(다. ? !) 항상 다음 줄에서 새 문장을 시작합니다. (사용자 요청 2026-10-03, .env 의 BLOG_SENTENCE_BREAK=off 면 예전처럼 짧은 문장끼리 합침)
// 서론·본론·결론에서 문장이 끝나면("~예요.", "~경우죠.", "~다.", "~나요?") 빈 줄을 하나 둡니다(문단 끝은 문단 사이 빈 줄 1개 그대로).
// 2026-10-26 사용자 요청(그림: "세 가지예요." "경우죠." 뒤에 엔터 한 번) — 2026-10-03 "~다." 뒤에만·기본 끔을 대체.
// 말투가 구어체(~요·~죠)로 바뀌어 "~다." 만 보던 예전 규칙은 켜도 걸리지 않았습니다. .env 의 BLOG_SENTENCE_GAP=off 면 문단 끝에만 빈 줄.
const sentenceGap = () => String(process.env.BLOG_SENTENCE_GAP || 'on').trim().toLowerCase() !== 'off';
// 한글 바로 뒤의 . ! ? 로 끝난 줄을 문장 끝으로 봅니다. ("1." 같은 번호, 말줄임 "…" 은 문장 끝으로 보지 않음)
const SENTENCE_END = /[가-힣][.!?]+["'”’)\]]*$/;
const sentenceBreak = () => String(process.env.BLOG_SENTENCE_BREAK || 'on').trim().toLowerCase() !== 'off';
const wrapLine = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  // 빈 글(AI 가 비운 강조 문장·별점 등)은 줄을 만들지 않습니다. 빈 줄 블록이 생기면 naver.js 가 "본문 줄이 빠졌다"고 보고
  // 다시 입력하며 Enter 를 더 눌러 빈 줄이 늘고 "본문 7줄을 끝내 넣지 못했습니다 (예: "")" 가 떴습니다(2026-10-03 실제 기록).
  if (!value) {
    return [];
  }
  if (!max || (value.length <= max && !sentenceBreak())) {
    return value ? [value] : [];
  }
  const lines = [];
  let lastWhole = false;
  value.split(/(?<=[.!?~…])\s+/).forEach((sentence) => {
    const pieces = sentence.length <= max ? [sentence] : balancedWrap(sentence, max);
    const whole = pieces.length === 1;
    const last = lines[lines.length - 1];
    if (!sentenceBreak() && whole && lastWhole && last && last.length + 1 + sentence.length <= max) {
      lines[lines.length - 1] = `${last} ${sentence}`;
    } else {
      lines.push(...pieces);
    }
    lastWhole = whole;
  });
  return lines;
};

// 제목을 길이가 비슷한 두 줄로 나눕니다. 짧은 제목은 한 줄로 둡니다.
// 예) "41개월 아이 대근육 발달 신체놀이 미끄럼틀 놀이" → "41개월 아이 대근육 발달" / "신체놀이 미끄럼틀 놀이"
const splitTitle = (title) => {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim();
  const words = text.split(' ');
  if (text.length <= 16 || words.length < 2) {
    return text ? [text] : [];
  }
  let best = 1;
  let bestScore = Number.MAX_SAFE_INTEGER;
  for (let cut = 1; cut < words.length; cut += 1) {
    const left = words.slice(0, cut).join(' ');
    const right = words.slice(cut).join(' ');
    // 쉼표·물음표 같은 끊는 자리 뒤에서 나누면 더 자연스럽습니다.
    const score = Math.abs(left.length - right.length) - (/[,:!?|·]$/.test(left) ? 6 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = cut;
    }
  }
  return [words.slice(0, best).join(' ').replace(/[,:|·]$/, ''), words.slice(best).join(' ')];
};

// 이미지 자리: 대표 이미지 1장 + 본문 사진(AI 가 [사진: …] 으로 표시한 자리마다 1장).
const imageSlots = (draft) => 1 + (draft.photos?.length || 0);

// 서론·본론·결론에서 문단과 문단 사이 빈 줄 수입니다. (.env 의 BLOG_PARAGRAPH_GAP, 기본 1)
// .env 는 이 파일을 불러온 뒤에 읽히므로 쓸 때마다 읽습니다.
const paragraphGap = () => {
  const value = Number.parseInt(process.env.BLOG_PARAGRAPH_GAP ?? '1', 10);
  return Number.isNaN(value) ? 1 : Math.min(4, Math.max(0, value));
};
const PHOTO_SLOT = /^@@photo:(\d+)@@$/;

// imageFiles[0] 은 대표 이미지, imageFiles[1 + n] 은 본문 n 번째 사진입니다.
// 만들지 못한 사진 자리는 null 로 들어오며, 그 자리는 건너뜁니다.
const buildBlocks = (draft, imageFiles = []) => {
  const blocks = [];

  const pushImage = (slot, caption) => {
    const filePath = imageFiles[slot];
    if (!filePath) {
      return;
    }
    // 사진 바로 위가 글이면 사이에 빈 줄을 하나 둡니다(Enter 한 번). 이미 빈 줄이면 더 넣지 않고,
    // 인용구 소제목·스티커 바로 아래 사진은 붙여 넣습니다. (사용자 요청 2026-10-03)
    if (blocks.length && blocks[blocks.length - 1].type === 'text') {
      blocks.push({ type: 'blank' });
    }
    // 인용구 바로 아래 사진은 naver.js 가 입력할 때 사이에 남은 빈 문단까지 지웁니다. (2026-10-03 사용자 그림)
    const tightAbove = blocks.length > 0 && blocks[blocks.length - 1].type === 'quote';
    blocks.push({ type: 'image', filePath, caption: caption || '', ...(tightAbove ? { tightAbove: true } : {}) });
  };

  // 글 한 문단을 넣습니다. 한 줄 글자수를 넘으면 여러 줄(줄마다 블록 하나)로 나눕니다.
  // nowrap 이면 줄바꿈하지 않습니다. 해시태그는 한 줄로 넣습니다.
  const pushText = (text, style = {}) => {
    const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
    // chars 가 있으면 그 글자수로 줄바꿈합니다(간단 요약 15자).
    let lines = style.nowrap ? (raw ? [raw] : []) : wrapLine(text, style.chars || lineChars());
    // balanced 면 문장 끝과 상관없이 줄 길이를 고르게 나눕니다. (인사말: "안녕하세요. 재쁜이 아빠 / 육아박사 육박사입니다.")
    if (style.balanced && !style.nowrap && lineChars() && raw.length > lineChars()) {
      lines = balancedWrap(raw, lineChars());
    }
    lines.forEach((line, at) => {
      // sentenceGap: 문장이 끝난 줄 다음에 빈 줄을 하나 둡니다(문단 마지막 줄은 문단 사이 빈 줄이 따로 들어가므로 제외).
      if (style.sentenceGap && at > 0 && SENTENCE_END.test(lines[at - 1])) {
        pushBlank();
      }
      blocks.push({
        type: 'text',
        text: line,
        size: style.size || SIZES.body,
        color: style.color || null,
        bold: Boolean(style.bold),
        align: style.align || bodyAlign(),
        background: style.background || null,
        ...(style.tightAbove && at === 0 ? { tightAbove: true } : {}),
      });
    });
  };

  const pushBlank = () => {
    blocks.push({ type: 'blank' });
  };

  // 스티커를 넣습니다. 앞에 쌓인 빈 줄을 걷어 내고, 스티커 앞뒤 빈 줄 수를 before·after 로 정확히 맞춥니다.
  // (빈 줄 수는 2026-10-02 사용자가 완성한 글 https://blog.naver.com/ymckh1005/224428041052 기준)
  // tightAbove 면 naver.js 가 입력할 때 스티커 바로 위에 남은 빈 문단까지 지웁니다(바로 위 글과 붙임).
  const pushSticker = (sticker, { before = 0, after = 0, tightAbove = false } = {}) => {
    if (!sticker) {
      return;
    }
    while (blocks.length && blocks[blocks.length - 1].type === 'blank') {
      blocks.pop();
    }
    for (let count = 0; count < before; count += 1) {
      pushBlank();
    }
    // gapAbove: 입력할 때 스티커 위에 남길 빈 줄 수(= before)
    blocks.push({ type: 'sticker', ...sticker, ...(tightAbove ? { tightAbove: true, gapAbove: before } : {}) });
    for (let count = 0; count < after; count += 1) {
      pushBlank();
    }
  };

  // 소제목은 네이버 에디터의 인용구 상자로 넣습니다. (naver.js 가 인용구 버튼을 못 찾으면 소제목 글자로 넣습니다)
  const pushQuote = (text) => {
    const value = String(text ?? '').trim();
    if (value) {
      // gapAbove: 인용구 바로 위에 둘 빈 줄 수. 네이버가 인용구를 넣으며 미리 만든 빈 문단을 위에 남기므로,
      // naver.js 가 넣은 뒤 이 수만큼만 남기고 지웁니다. (2026-10-03 사용자 그림: "결론" 위에 빈 줄이 잔뜩)
      let gapAbove = 0;
      for (let at = blocks.length - 1; at >= 0 && blocks[at].type === 'blank'; at -= 1) {
        gapAbove += 1;
      }
      blocks.push({ type: 'quote', text: value, size: SIZES.heading, color: COLORS.heading, gapAbove });
    }
  };

  // 글과 제목(소제목·결론) 사이는 빈 줄 하나만 둡니다. 스티커 바로 아래 제목은 붙입니다.
  const blankBeforeHeading = () => {
    while (blocks.length && blocks[blocks.length - 1].type === 'blank') {
      blocks.pop();
    }
    if (blocks.length && blocks[blocks.length - 1].type !== 'sticker') {
      pushBlank();
    }
  };

  // 단락을 넣습니다. 사진 자리표(@@photo:n@@)는 그 자리에 사진을 넣습니다.
  // 사진 바로 위(제목)와는 빈 줄을 두지 않고, 사진 바로 아래 글 앞에만 빈 줄을 하나 둡니다.
  const pushParagraphs = (paragraphs = []) => {
    paragraphs.forEach((paragraph) => {
      const slot = PHOTO_SLOT.exec(String(paragraph));
      if (slot) {
        const index = Number(slot[1]);
        const before = blocks.length;
        pushImage(1 + index, draft.photos?.[index]?.caption);
        if (blocks.length > before) {
          pushBlank();
        }
        return;
      }
      // AI 가 ★ 로 고른 핵심 단락은 초록 글씨로 강조합니다(굵게 아님, 기준 완성 글과 같음).
      if (String(paragraph).startsWith(EMPHASIS)) {
        pushText(String(paragraph).slice(EMPHASIS.length), { color: COLORS.accent, sentenceGap: sentenceGap() });
      } else {
        pushText(paragraph, { sentenceGap: sentenceGap() });
      }
      // 문단이 끝나면 빈 줄을 BLOG_PARAGRAPH_GAP 개(기본 1개) 둡니다. (사용자 요청)
      for (let gap = 0; gap < paragraphGap(); gap += 1) {
        pushBlank();
      }
    });
  };

  // 여는 부분 (제목·출처 줄은 가운데)
  // 맨 위에 글 전체를 담은 대표 사진, 그 아래 여는 부분(스티커·제목·출처) (기준 완성 글과 같은 순서)
  // 대표 사진(썸네일)은 기본으로 만들어 imageFiles[0] 이 채워집니다. BLOG_TOP_IMAGE=off 로 비어 있으면 스티커부터 시작합니다.
  pushImage(0, draft.title);
  if (String(process.env.BLOG_OPENING || 'on').toLowerCase() !== 'off') {
    const credit = String(process.env.BLOG_CREDIT ?? OPENING.credit).trim();
    // 맨 위 스티커 바로 아래에 제목 (빈 줄 없음)
    pushSticker(readSticker('BLOG_STICKER', '1,4,2'));
    splitTitle(draft.title).forEach((line) => pushText(line, {
      size: 16, color: OPENING.titleColor, background: OPENING.titleBackground, bold: true, align: 'center',
    }));
    // 출처 줄은 제목 바로 아래에 붙입니다(빈 줄 없음, 사용자 요청 2026-10-03).
    pushText(credit, { size: 11, color: OPENING.creditColor, align: 'center', tightAbove: true });
    // 출처 줄과 인사말 사이는 빈 줄 3개입니다.
    pushBlank();
    pushBlank();
    pushBlank();
  }

  // 도입부: 인사말 → 서론 사진(서론 문단 맨 앞의 사진 자리) → 나머지 서론
  const introParagraphs = draft.intro?.paragraphs || [];
  const hasGreeting = Boolean(draft.intro?.greeting) && introParagraphs[0] === draft.intro.greeting;
  if (hasGreeting) {
    // 인사말에 | 가 있으면 그 자리에서 줄을 바꿉니다(.env 의 BLOG_GREETING). 없으면 길이를 고르게 두 줄로 나눕니다.
    const greetingLines = String(introParagraphs[0]).split(/\s*\|\s*/).filter(Boolean);
    if (greetingLines.length > 1) {
      greetingLines.forEach((line) => pushText(line, { nowrap: true }));
    } else {
      pushText(introParagraphs[0], { balanced: true });
    }
    pushBlank();
  }
  pushParagraphs(hasGreeting ? introParagraphs.slice(1) : introParagraphs);
  pushText(draft.intro?.highlight, { color: COLORS.accent, sentenceGap: sentenceGap() });
  pushBlank();
  // 서론이 끝나면 강조 문장 바로 아래에 스티커, 그 바로 아래 첫 소제목 (빈 줄 없음, 2026-10-03 사용자 그림)
  pushSticker(readSticker('BLOG_STICKER_INTRO', '1,4,1'), { tightAbove: true });

  // 본문 (소제목 = 인용구)
  (draft.sections || []).forEach((section) => {
    blankBeforeHeading();
    pushQuote(section.heading);
    // 소제목 인용구 바로 아래에는 빈 줄을 두지 않습니다(위에는 하나). (사용자 요청 2026-10-03)
    pushParagraphs(section.paragraphs);
    pushText(section.highlight, { color: COLORS.accent, sentenceGap: sentenceGap() });
    pushBlank();
  });

  // 결론: 글 전체 정리 → 끝에 댓글·공감을 부르는 질문(conclusion.question, 2026-10-14). 총평·별점은 넣지 않습니다.
  // (채팅 모드에서 AI 가 따로 결론을 쓰지 않았으면 "결론" 소제목도 넣지 않습니다)
  const conclusion = draft.conclusion || {};
  if ((conclusion.paragraphs || []).length || conclusion.highlight || conclusion.rating || conclusion.question) {
    blankBeforeHeading();
    pushQuote('결론');
  }
  pushParagraphs(draft.conclusion?.paragraphs);
  pushText(draft.conclusion?.highlight, { color: COLORS.accent, sentenceGap: sentenceGap() });
  if (draft.conclusion?.highlight) {
    pushBlank();
  }
  pushText(draft.conclusion?.rating, { color: COLORS.point });
  if (draft.conclusion?.rating) {
    pushBlank();
  }
  // 결론 끝 CTA(댓글·공감 유도)는 본문과 같은 기본 글자색으로 넣습니다.
  pushText(draft.conclusion?.question, { sentenceGap: sentenceGap() });
  pushBlank();

  // 육박사의 간단 요약 (결론 다음): 가운데 굵은 제목 "👨‍🎓 육박사의 간단 요약 👨‍🎓" + 빈 줄 + "✔ " 목록(항목마다 빈 줄 하나)
  // .env 의 BLOG_SUMMARY_TITLE 로 제목을 바꾸고, 비워 두면 요약을 넣지 않습니다.
  const summaryTitle = String(process.env.BLOG_SUMMARY_TITLE ?? '육박사의 간단 요약').trim();
  const summary = summaryLines(draft);
  if (summaryTitle && summary.length > 0) {
    // 결론 마지막 줄 바로 아래(빈 줄 없음, 2026-10-03 사용자 그림) 스티커 → 빈 줄 하나 → 요약 제목
    pushSticker(readSticker('BLOG_STICKER_SUMMARY', '1,4,2'), { after: 1, tightAbove: true });
    pushText(`${SUMMARY_ICON} ${summaryTitle} ${SUMMARY_ICON}`, { bold: true, nowrap: true });
    // 제목 아래 Enter 한 번 더(빈 줄 2개, 사용자 요청 2026-10-03)
    pushBlank();
    pushBlank();
    // 요약 항목은 띄어쓰기 포함 17자 안팎에서 줄바꿈합니다. (BLOG_SUMMARY_CHARS, 사용자 요청 2026-10-03)
    const summaryChars = Number(process.env.BLOG_SUMMARY_CHARS) || 17;
    summary.forEach((line) => {
      pushText(`✔ ${line}`, { chars: summaryChars });
      pushBlank();
    });
  }

  // 태그 바로 앞 스티커("읽어주셔서 감사합니다"): 스티커 → 바로 아래 태그.
  // 간단 요약 마지막 줄 바로 아래에 붙입니다(빈 줄 없음, 2026-10-03 사용자 그림 — 예전엔 앞에 빈 줄 2개).
  // 간단 요약 다음에 빈 줄 하나를 두고 스티커를 넣습니다. (사용자 요청 2026-10-03, 그 전엔 빈 줄 없이 붙였음)
  pushSticker(readSticker('BLOG_STICKER_TAGS', '5,3,1'), { before: 1, tightAbove: true });

  // 해시태그 (본문 20자 줄바꿈을 적용하지 않고 한 줄로, 본문과 같은 기본 글자색으로 넣습니다)
  pushText((draft.tags || []).map((tag) => `#${tag}`).join(' '), { nowrap: true });

  return blocks;
};

const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// 미리보기 화면과 붙여넣기 모드에서 함께 쓰는 HTML 입니다.
const blocksToHtml = (blocks, { forPreview = false } = {}) => blocks.map((block) => {
  if (block.type === 'blank') {
    return '<p><br></p>';
  }
  if (block.type === 'quote') {
    // 네이버 "세로선" 인용구 모양: 왼쪽 굵은 회색 세로선 + 회색 글씨, 배경 없음
    return `<blockquote style="margin:28px 0;padding:4px 0 4px 16px;border-left:6px solid #555555;background:none;text-align:left;font-size:${block.size}px;color:#666666">${escapeHtml(block.text)}</blockquote>`;
  }
  if (block.type === 'sticker') {
    // 스티커는 붙여넣기로 넣을 수 없어(naver.js 가 스티커 창에서 고릅니다) 미리보기에만 비슷한 물결 줄을 보여 줍니다.
    return forPreview
      ? `<p style="text-align:center;color:#9db989;font-size:19px;line-height:1.9" title="네이버 스티커 (묶음 ${block.pack}, ${block.row}줄 ${block.column}칸)">˚ ‿︵‿︵‿︵‿︵‿ ˚</p>`
      : '';
  }
  if (block.type === 'image') {
    if (!forPreview) {
      return '';
    }
    const src = `file:///${String(block.filePath).replace(/\\/g, '/')}`;
    const caption = block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : '';
    return `<figure><img src="${src}" alt="${escapeHtml(block.caption)}">${caption}</figure>`;
  }
  const styles = [`font-size:${block.size}px`, 'line-height:1.9', `text-align:${block.align || 'left'}`];
  if (block.color) {
    styles.push(`color:${block.color}`);
  }
  if (block.bold) {
    styles.push('font-weight:700');
  }
  const text = block.background
    ? `<span style="background-color:${block.background}">${escapeHtml(block.text)}</span>`
    : escapeHtml(block.text);
  return `<p style="${styles.join(';')}">${text}</p>`;
}).join('\n');

const draftToText = (draft) => {
  const lines = [draft.title, ''];
  if ((draft.titles || []).length > 1) {
    lines.push('추천 제목', ...draft.titles.map((item, index) => `${index + 1}) ${item}`), '');
  }
  const photo = (item) => {
    const slot = /^@@photo:(\d+)@@$/.exec(String(item));
    return slot ? `[사진: ${draft.photos?.[Number(slot[1])]?.caption || ''}]` : String(item).replace(EMPHASIS, '★ ').replace(/\s*\|\s*/g, '\n');
  };
  (draft.intro?.paragraphs || []).forEach((item) => lines.push(photo(item), ...Array(Math.max(1, paragraphGap())).fill('')));
  if (draft.intro?.highlight) {
    lines.push(draft.intro.highlight, '');
  }
  (draft.sections || []).forEach((section) => {
    lines.push(`❝ ${section.heading} ❞`, '');
    (section.paragraphs || []).forEach((item) => lines.push(photo(item), ...Array(Math.max(1, paragraphGap())).fill('')));
    if (section.highlight) {
      lines.push(section.highlight, '');
    }
  });
  lines.push('❝ 결론 ❞', '');
  (draft.conclusion?.paragraphs || []).forEach((item) => lines.push(photo(item), ...Array(Math.max(1, paragraphGap())).fill('')));
  [draft.conclusion?.highlight, draft.conclusion?.rating, draft.conclusion?.question].filter(Boolean).forEach((item) => lines.push(item, ''));
  const summaryTitle = String(process.env.BLOG_SUMMARY_TITLE ?? '육박사의 간단 요약').trim();
  if (summaryTitle && (draft.doctor || []).length > 0) {
    lines.push(`${SUMMARY_ICON} ${summaryTitle} ${SUMMARY_ICON}`, '', ...summaryLines(draft).map((item) => `✔ ${item}`), '');
  }
  lines.push((draft.tags || []).map((tag) => `#${tag}`).join(' '));
  return lines.join('\n');
};

export { buildBlocks, blocksToHtml, draftToText, imageSlots, splitTitle, wrapLine, COLORS, SIZES, splitSentences };
