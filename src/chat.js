// 채팅 모드: chat.deepseek.com 에 직접 물어보는 것처럼, 긴 글쓰기 규칙 없이
// "키워드 + 화면에 쓴 AI 추가 요청" 만 보내고 AI 가 자유롭게 쓴 글을 받습니다.
// 받은 글은 이 파일이 제목·서론·소제목·결론·태그로 나눠, 원래 모드와 같은 모양으로 돌려줍니다.
// (그래야 사진·인사말·네이버 입력을 원래 모드와 똑같이 처리할 수 있습니다.)

const joinWords = (list) => (list || []).filter(Boolean).join(', ');

const buildChatPrompt = (input) => {
  const { keyword, subKeywords = [], related = [], title } = input;
  const ask = String(input.extraPrompt ?? '').trim() || `"${keyword}"에 대한 네이버 블로그 글을 써 주세요.`;
  return `${ask}

글 정보
- 메인 키워드: ${keyword}
${subKeywords.length ? `- 함께 다룰 키워드: ${joinWords(subKeywords)}\n` : ''}${title ? `- 제목: ${title} (이 제목을 그대로 쓰고, 글 내용도 이 제목이 묻는 것에 맞춰 써 주세요)\n` : ''}${related.length ? `- 사람들이 함께 찾는 말(참고): ${joinWords(related.slice(0, 8))}\n` : ''}
쓰는 형식 (프로그램이 네이버 블로그 에디터로 옮기기 위한 표시입니다)
- 첫 줄에 "# 제목"
- 소제목은 "## 소제목"
- 사진이 들어가면 좋은 자리에 한 줄로 "[사진: 한국어 설명 | english search words]" (사람이 나오면 영어 검색어 앞에 korean 을 붙입니다)
- 본문 마지막에 "## 결론" 소제목을 두고, 글 전체 내용을 처음부터 끝까지 이어지는 문장으로 정리
- 그 다음(태그 줄 바로 앞)에 "## 육박사의 간단 요약" 소제목을 두고, 그 아래에 이 글의 핵심을 "- " 로 시작하는 짧은 줄 3~4개로 정리
- 맨 마지막 줄에 "태그: 태그1, 태그2, 태그3, 태그4, 태그5"
- 인사말과 자기소개는 프로그램이 맨 앞에 넣으므로 쓰지 않습니다.`;
};

// 마크다운 꾸밈(굵게, 기울임, 링크, 코드)을 걷어 내고 글자만 남깁니다.
const plain = (text) => String(text ?? '')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1$2')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
  .replace(/\*\*/g, '')
  .trim();

const CLOSING = /마무리|마치며|맺음|결론|정리하며|끝으로|나가며/;
const PHOTO = /^\[\s*사진\s*[:：]/;
const SUMMARY = /간단\s*요약|핵심\s*요약|한눈에\s*정리|세줄\s*요약|세 줄 요약/;

// AI 가 자유롭게 쓴 글을 원래 모드의 초안 모양으로 바꿉니다.
const parseChatText = (text) => {
  const lines = String(text ?? '').replace(/\r/g, '').replace(/^```\w*\n?|```$/g, '').split('\n');
  let title = '';
  const tags = [];
  const intro = [];
  const sections = [];
  let current = null;
  let buffer = [];

  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    const paragraph = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (paragraph) {
      (current ? current.paragraphs : intro).push(paragraph);
    }
  };

  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) {
      flush();
      return;
    }
    // 구분선, 표 구분 줄은 버립니다.
    if (/^([-*_]\s*){3,}$/.test(line) || /^\|?\s*:?-{2,}/.test(line)) {
      flush();
      return;
    }
    const tagLine = /^(?:태그|해시태그|tags?)\s*[:：]\s*(.+)$/i.exec(plain(line));
    const hashOnly = /^(#[^\s#]+\s*){2,}$/.test(line);
    if (tagLine || hashOnly) {
      flush();
      // "아기 이유식, 이유식 시기" 처럼 띄어 쓴 태그는 쉼표로만 나눕니다. 쉼표가 없으면 # 이나 띄어쓰기로 나눕니다.
      const body = tagLine ? tagLine[1] : line;
      const pieces = /[,，]/.test(body) ? body.split(/[,，]+/) : body.split(/(?=#)|\s+/);
      pieces.map((tag) => tag.replace(/[#\s]+/g, '').trim()).filter(Boolean).forEach((tag) => tags.push(tag));
      return;
    }
    const titleLine = /^제목\s*[:：]\s*(.+)$/.exec(plain(line));
    if (!title && titleLine) {
      flush();
      title = plain(titleLine[1]);
      return;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    // 한 줄 전체가 굵은 글씨면 소제목으로 봅니다. (마크다운 # 대신 **소제목** 으로 쓰는 경우)
    const boldHeading = /^\*\*([^*]{2,40})\*\*:?$/.exec(line);
    if (heading || boldHeading) {
      flush();
      const level = heading ? heading[1].length : 2;
      const textOf = plain(heading ? heading[2] : boldHeading[1]).replace(/^\d+\s*[.)]\s*/, '');
      if (level === 1 && !title) {
        title = textOf;
        return;
      }
      current = { heading: textOf, paragraphs: [] };
      sections.push(current);
      return;
    }
    if (PHOTO.test(line)) {
      flush();
      (current ? current.paragraphs : intro).push(line);
      return;
    }
    // 목록 줄은 한 줄씩 따로 둡니다.
    const item = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      flush();
      buffer.push(`· ${plain(item[1])}`);
      flush();
      return;
    }
    // 표의 한 줄은 칸을 " · " 로 이어 한 문장으로 만듭니다.
    if (/^\|.*\|$/.test(line)) {
      flush();
      buffer.push(line.split('|').map((cell) => plain(cell)).filter(Boolean).join(' · '));
      flush();
      return;
    }
    buffer.push(plain(line));
  });
  flush();

  // 내용 없는 소제목(소제목만 있고 글이 없음)은 다음 소제목에 묻히지 않게 버립니다.
  const filled = sections.filter((section) => section.paragraphs.some((item) => !PHOTO.test(item)));
  // "간단 요약" 소제목은 육박사의 간단 요약(결론 다음)으로 옮깁니다.
  let summary = [];
  const summaryAt = filled.findIndex((section) => SUMMARY.test(section.heading));
  if (summaryAt !== -1) {
    summary = filled.splice(summaryAt, 1)[0].paragraphs.filter((item) => !PHOTO.test(item));
  }
  // 마지막 소제목이 "마무리" 류면 결론으로 옮깁니다. (네이버 글에는 "결론" 인용구로 들어갑니다)
  let conclusion = [];
  if (filled.length > 1 && CLOSING.test(filled[filled.length - 1].heading)) {
    conclusion = filled.pop().paragraphs;
  }
  // 소제목이 하나도 없으면 앞 두 문단만 서론으로 두고 나머지는 메인 키워드 소제목 하나로 묶습니다.
  if (filled.length === 0 && intro.length > 2) {
    filled.push({ heading: '', paragraphs: intro.splice(2) });
  }

  return {
    chat: true,
    titles: title ? [title] : [],
    intro: { paragraphs: intro, highlight: '' },
    sections: filled.map((section) => ({ ...section, highlight: '' })),
    conclusion: { paragraphs: conclusion, highlight: '', rating: '', question: '' },
    summary,
    tags,
  };
};

export { buildChatPrompt, parseChatText };
