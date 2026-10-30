// 키워드별로 "검색"을 담당하는 모듈입니다.
// 1) 네이버 자동완성에서 실제 검색되는 연관 키워드를 모읍니다.
// 2) 네이버 검색 API 키가 있으면 뉴스/백과 요약문을 소재로 모읍니다. 네이버 블로그는 찾지 않습니다(사용자 요청 2026-10-26).
// 3) 키워드를 조합한 검색어로 최신 기사를 모읍니다(researchLatest — 키 없이 Bing·Google 뉴스, 키가 있으면 네이버 뉴스도).
//    앞쪽 기사 몇 건은 원문을 열어 요약 문장을 읽습니다(readArticles, 2026-10-26).

const AC_URL = 'https://ac.search.naver.com/nx/ac';
const BAN_WORDS = ['성인', '야동', '도박', '카지노', '대출', '토토'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const compact = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();

const uniqueList = (items) => {
  const seen = new Set();
  const out = [];
  items.forEach((item) => {
    const key = compact(item);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(String(item).trim());
  });
  return out;
};

// 기사 원문에 자주 나오는 이름 붙은 기호입니다. (&amp; 는 맨 끝에 바꿔 "&amp;lt;" 가 "<" 로 두 번 풀리지 않게 합니다)
const NAMED_ENTITIES = {
  quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', middot: '·', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', bull: '•',
};
const stripTags = (value) => String(value ?? '')
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/<[^>]+>/g, '')
  .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const fetchSuggestions = async (query) => {
  const url = new URL(AC_URL);
  const params = {
    q: query, con: '1', frm: 'nx', ans: '2', r_format: 'json', r_enc: 'UTF-8',
    r_unicode: '0', t_koreng: '1', run: '2', rev: '4', q_enc: 'UTF-8', st: '100',
  };
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  const rows = data?.items?.[0];
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((row) => (Array.isArray(row) ? String(row[0] ?? '') : String(row ?? '')))
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 24)
    .filter((item) => !BAN_WORDS.some((word) => item.includes(word)));
};

// 검색 결과의 날짜를 2026-10-08 꼴로 맞춥니다. 뉴스는 pubDate("Wed, 08 Oct 2026 09:00:00 +0900"), 블로그는 postdate("20261008")입니다.
const dateOf = (item) => {
  if (/^\d{8}$/.test(item.postdate || '')) {
    return `${item.postdate.slice(0, 4)}-${item.postdate.slice(4, 6)}-${item.postdate.slice(6, 8)}`;
  }
  const time = Date.parse(item.pubDate || '');
  return Number.isNaN(time) ? '' : new Date(time + 9 * 3600000).toISOString().slice(0, 10);
};

// type: news(뉴스) 또는 encyc(백과). 네이버 블로그(blog)는 쓰지 않습니다(사용자 요청 2026-10-26).
// sort: sim(정확도순, 기본) 또는 date(최신순)
const fetchNaverSearch = async (query, type = 'news', display = 5, sort = 'sim') => {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) {
    return [];
  }
  const url = new URL(`https://openapi.naver.com/v1/search/${type}.json`);
  url.searchParams.set('query', query);
  url.searchParams.set('display', String(display));
  // 백과사전 검색에는 정렬 항목이 없어, 최신순일 때만 붙입니다(기본값은 정확도순).
  if (sort !== 'sim') {
    url.searchParams.set('sort', sort);
  }
  const response = await fetch(url, {
    headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return (data?.items || []).map((item) => ({
    title: stripTags(item.title),
    snippet: stripTags(item.description),
    date: dateOf(item),
    // 기사 원문 주소(요약을 더 읽을 때 씀). 네이버 뉴스에 실린 기사는 모양이 일정한 n.news.naver.com 주소를 먼저 씁니다.
    url: type === 'news' ? (/n\.news\.naver\.com/.test(item.link || '') ? item.link : (item.originallink || item.link || null)) : null,
  })).filter((item) => item.title);
};

// 키워드 하나를 조사합니다. 실패해도 입력 키워드만으로 진행합니다.
const researchKeyword = async (keyword) => {
  const seed = String(keyword ?? '').trim();
  const queries = uniqueList([seed, `${seed} 방법`, `${seed} 시기`, `${seed} 추천`]).slice(0, 4);
  const suggestions = [];
  for (let index = 0; index < queries.length; index += 1) {
    try {
      suggestions.push(...await fetchSuggestions(queries[index]));
    } catch (error) {
      // 자동완성이 막혀도 글은 작성합니다.
    }
  }
  const related = uniqueList(suggestions)
    .filter((item) => compact(item) !== compact(seed))
    .filter((item) => compact(item).includes(compact(seed)) || compact(seed).includes(compact(item)));

  let references = [];
  try {
    // 최신 정보 위주로 쓰도록 최신 뉴스(최신순)를 맨 앞에 둡니다. (사용자 요청 2026-10-08)
    // 네이버 블로그 글은 소재로 쓰지 않습니다(사용자 요청 2026-10-26 "네이버 블로그는 검색해주지마세요").
    const [news, encyc] = await Promise.all([
      fetchNaverSearch(seed, 'news', 4, 'date'),
      fetchNaverSearch(seed, 'encyc', 3),
    ]);
    references = [...news.slice(0, 4), ...encyc.slice(0, 3)].filter((item) => !isNaverBlog(item.url)).slice(0, 8);
  } catch (error) {
    references = [];
  }

  return {
    keyword: seed,
    related: related.slice(0, 12),
    longTail: uniqueList(related.filter((item) => item.length > seed.length)).slice(0, 6),
    references,
  };
};

// ── 키워드를 조합해 최신 기사 찾기 (사용자 요청 2026-10-14: "키워드 조합해서 제일 최신 정보로")
// 키 없이 되는 Bing 뉴스(요약문 있음)·Google 뉴스(제목·언론사)와, 네이버 검색 API 키가 있으면 네이버 뉴스(최신순)를 씁니다.
// 네이버 블로그는 찾지 않고, 다른 검색에 섞여 온 네이버 블로그 주소도 버립니다(사용자 요청 2026-10-26).
// 뉴스 검색은 느슨해 엉뚱한 기사가 섞이므로(예: "아기 열 내리는 법" → 게임·농구 기사) 메인 키워드의 핵심 낱말이 모두 든 기사만 남깁니다.
const MAX_AGE_DAYS = 730;
// 핵심 낱말에서 빼는 말입니다. "입냄새 원인" → 입냄새, "아기 열 내리는 법" → 아기
const LOOSE_WORDS = /^(방법|원인|추천|후기|종류|정리|총정리|비교|차이|기간|시기|비용|가격|효과|증상|이유|순서|기준|하는법|만드는법)$/;
const coreTokens = (keyword) => {
  const tokens = String(keyword ?? '').trim().split(/\s+/)
    .filter((token) => [...token].length >= 2 && !LOOSE_WORDS.test(token) && !/[는은을]$/.test(token));
  return tokens.length ? tokens.map(compact) : [compact(keyword)].filter(Boolean);
};

// 아기·아이 글: 기사는 "아기" 대신 "소아·영유아·어린이"로 쓰는 경우가 많아 이 말들도 같은 낱말로 봅니다.
// (2026-10-26 "아기 폐렴 증상" 최근 기사 2건 → 넓혀 찾으니 23건, 10/23 "환절기 영유아 RSV 비상" 등)
// "아이"는 아이폰·아이돌에도 들어 있어 같은 말 목록에는 넣지 않고, 키워드에 "아이"가 있을 때만 그대로 찾습니다.
const KID_WORDS = ['아기', '영유아', '영아', '소아', '신생아', '유아', '어린이', '아동'];
const isKidWord = (token) => token === '아이' || KID_WORDS.includes(token);
// text 는 compact 한 글입니다.
const hasToken = (text, token) => text.includes(token) || (isKidWord(token) && KID_WORDS.some((word) => text.includes(word)));
// 아기·아이 키워드는 기사에서 많이 쓰는 말로 바꾼 검색어도 씁니다.
// "아기 폐렴 증상" → "소아 폐렴 증상", "영유아 폐렴 증상" / "아이 한글공부" → "어린이 한글공부", "유아 한글공부"
const KID_QUERY_WORDS = { 아기: ['소아', '영유아'], 아이: ['어린이', '유아'] };
const kidQueries = (keyword) => {
  const words = String(keyword ?? '').trim().split(/\s+/);
  const at = words.findIndex((word) => KID_QUERY_WORDS[word]);
  return at < 0 ? [] : KID_QUERY_WORDS[words[at]].map((word) => words.map((item, index) => (index === at ? word : item)).join(' '));
};

// RSS 링크에서 실제 기사 주소를 꺼냅니다. Bing 링크는 실제 주소를 url= 에 품고 있습니다.
// Google 뉴스 링크는 열어도 기사로 바로 가지 않아(자바스크립트로 이동) 쓰지 않습니다.
const articleUrlOf = (link) => {
  try {
    const url = new URL(String(link ?? '').trim());
    if (/(^|\.)bing\.com$/.test(url.hostname)) {
      return url.searchParams.get('url') || null;
    }
    if (/(^|\.)google\.com$/.test(url.hostname) || !/^https?:$/.test(url.protocol)) {
      return null;
    }
    return url.href;
  } catch (error) {
    return null;
  }
};

// 네이버 블로그 글 주소(blog.naver.com, m.blog.naver.com)입니다. 참고 자료에서 뺍니다(사용자 요청 2026-10-26).
const isNaverBlog = (url) => /^https?:\/\/(m\.)?blog\.naver\.com\//i.test(String(url ?? ''));

const xmlTag = (block, name) => (new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block) || [])[1] || '';
// RSS 의 <item> 을 { title, snippet, date, source, url } 로 바꿉니다. 날짜는 한국 시각 2026-10-14 꼴입니다.
const parseRss = (xml) => String(xml ?? '').split(/<item[\s>]/).slice(1).map((block) => {
  const time = Date.parse(stripTags(xmlTag(block, 'pubDate')));
  return {
    title: stripTags(xmlTag(block, 'title')),
    snippet: stripTags(stripTags(xmlTag(block, 'description'))), // Google 은 설명 안에 HTML 을 한 번 더 감싸 보냅니다.
    source: stripTags(xmlTag(block, 'source')),
    date: Number.isNaN(time) ? '' : new Date(time + 9 * 3600000).toISOString().slice(0, 10),
    url: articleUrlOf(stripTags(xmlTag(block, 'link'))),
  };
}).filter((item) => item.title);

// ── 기사 원문 읽기 (2026-10-26 사용자 요청 "최신정보나 최신뉴스를 검색해서"): 제목과 언론사 이름만으로는 AI 가 쓸 내용이 거의 없어,
// 앞쪽 기사 몇 건은 원문을 열어 요약(og:description)과 본문에서 키워드가 든 문장을 몇 개 읽어 snippet 에 넣습니다.
const fetchPage = async (url) => {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko' },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      return '';
    }
    const type = response.headers?.get?.('content-type') || '';
    if (type && !/html/i.test(type)) {
      return '';
    }
    if (!response.arrayBuffer) {
      return await response.text();
    }
    // 아직 EUC-KR 로 된 언론사 누리집이 있어, 머리글이나 <meta charset> 의 글자 방식으로 읽습니다.
    const bytes = new Uint8Array(await response.arrayBuffer());
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
    const charset = (/charset=["']?([\w-]+)/i.exec(type) || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || 'utf-8';
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch (error) {
      return new TextDecoder('utf-8').decode(bytes);
    }
  } catch (error) {
    return '';
  }
};

const metaOf = (html, name) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (key && key.toLowerCase() === name) {
      const content = /content\s*=\s*"([^"]*)"/i.exec(tag) || /content\s*=\s*'([^']*)'/i.exec(tag);
      return stripTags(content?.[1] || '');
    }
  }
  return '';
};

// 기사 첫머리의 "(서울=뉴스1) 김정은 기자 =", "[헬스조선]" 같은 언론사·기자 표시를 뗍니다(언론사 이름은 글에 쓰지 않음).
const cleanLead = (text) => String(text ?? '')
  .replace(/^\s*(?:[\[(【<][^\])】>]{1,30}[\])】>]\s*)+/, '')
  .replace(/^\s*[가-힣]{2,4}\s*(?:기자|특파원|객원기자|선임기자)\s*=\s*/, '')
  .trim();

// 본문 문장: 기사 문장은 "~다." 로 끝납니다. 저작권·기자 이름·구독 안내 같은 머리말·꼬리말은 뺍니다.
const BOILERPLATE = /무단|전재|재배포|저작권|copyright|구독|기자\s*=|[\w.-]+@[\w-]+\.|댓글|로그인|ⓒ|©|사진\s*=|제공\s*=/i;
const articleSentences = (html) => String(html ?? '')
  .replace(/<(script|style|noscript|iframe|svg|header|footer|nav|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|h\d|td|section|article|figcaption)>/gi, '\n')
  .split('\n')
  .map(stripTags)
  .flatMap((line) => line.split(/(?<=다\.)\s+/))
  .map(cleanLead)
  .filter((sentence) => sentence.length >= 25 && sentence.length <= 220 && /[가-힣]/.test(sentence)
    && /다\.["'”’)]*$/.test(sentence) && !BOILERPLATE.test(sentence));

// 기사 요약을 만듭니다. 요약(og:description)과 본문 문장 가운데 키워드 핵심 낱말이 든 것만 씁니다(다른 기사 소개·광고 문장이 섞이지 않게).
const EXCERPT_CHARS = 420;
const articleExcerpt = (html, core = []) => {
  // 아기 같은 낱말만 맞는 문장(아기 이야기 전반)보다, 주제 낱말("폐렴")이 든 문장을 고릅니다.
  const strong = core.filter((token) => !isKidWord(token));
  const need = strong.length ? strong : core;
  const related = (text) => !need.length || need.some((token) => hasToken(compact(text), token));
  const parts = [];
  const seen = new Set();
  const add = (text) => {
    const key = compact(text).slice(0, 24);
    if (!text || seen.has(key)) {
      return;
    }
    seen.add(key);
    parts.push(text);
  };
  // 키워드 핵심 낱말이 처음 나오는 본문 문장부터 이어서 읽습니다. 그 뒤 문장은 낱말이 없어도 같은 기사 본문이라 그대로 씁니다
  // (예: "기침이 사흘 넘게 이어지면 진료를 받으라고 권고했다"). 앞쪽의 다른 기사 소개·메뉴 문장은 건너뜁니다.
  const all = articleSentences(html);
  const start = all.findIndex(related);
  const sentences = start < 0 ? [] : all.slice(start);
  // 본문 문장이 둘 이상 있으면 본문만 씁니다. 요약(og:description)은 대개 첫 문단을 중간에서 자른 것("…차..")이라 본문과 겹칩니다.
  if (sentences.length < 2) {
    const summary = cleanLead(metaOf(html, 'og:description') || metaOf(html, 'description')).replace(/\.{2,}$|…$/, '').slice(0, 220);
    if (related(summary)) {
      add(summary);
    }
  }
  // 문장 중간에서 잘리지 않게, 420자를 넘기기 전까지 문장을 통째로 붙입니다.
  for (const sentence of sentences) {
    if (parts.join(' ').length + sentence.length + 1 > EXCERPT_CHARS) {
      break;
    }
    add(sentence);
  }
  return parts.join(' ').slice(0, EXCERPT_CHARS).trim();
};

// 앞쪽 기사 count 건의 원문을 함께 열어(한 건에 6초까지) 요약이 더 길면 snippet 을 바꿉니다. 실패한 기사는 그대로 둡니다.
const READ_ARTICLES = 6;
const readArticles = async (items, count = READ_ARTICLES) => {
  const targets = items.filter((item) => item.url).slice(0, count);
  await Promise.all(targets.map(async (item) => {
    const excerpt = articleExcerpt(await fetchPage(item.url), item.core);
    if (excerpt.length > String(item.snippet || '').length) {
      item.snippet = excerpt;
      item.read = true;
    }
  }));
  return items;
};

const fetchText = async (url) => {
  const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko' }, signal: AbortSignal.timeout(8000) });
  return response.ok ? response.text() : '';
};

const fetchBingNews = async (query) => parseRss(await fetchText(
  `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setmkt=ko-KR&setlang=ko`,
));

// Google 뉴스는 설명이 제목 반복이라 버리고, 제목 끝 " - 언론사" 를 떼어 출처로 씁니다.
const fetchGoogleNews = async (query) => parseRss(await fetchText(
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`,
)).map((item) => {
  const title = item.source && item.title.endsWith(` - ${item.source}`) ? item.title.slice(0, -(item.source.length + 3)) : item.title;
  return { ...item, title, snippet: item.source ? `${item.source} 보도` : '' };
});

// 날짜가 있는 것은 최신순, 날짜 없는 것(백과 등)은 뒤로. 제목이 같은 기사는 하나만 둡니다.
const mergeReferences = (...lists) => {
  const seen = new Set();
  const all = lists.flat().filter((item) => item && item.title).filter((item) => {
    const key = compact(item.title).slice(0, 24);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return [...all.filter((item) => item.date).sort((a, b) => b.date.localeCompare(a.date)), ...all.filter((item) => !item.date)];
};

const researchLatest = async (keyword, subKeywords = [], { now = Date.now(), limit = 10 } = {}) => {
  const main = String(keyword ?? '').trim();
  if (!main) {
    return [];
  }
  // 메인 + 서브 키워드 조합을 먼저, 그 다음 메인 키워드만. (예: "임신 초기 검사 임신 검사 지원" → "임신 초기 검사")
  const combine = (sub) => [...new Set(`${main} ${String(sub ?? '').trim()}`.split(/\s+/).filter(Boolean))].join(' ');
  // 아기 키워드는 "소아·영유아"로 바꾼 검색어도 함께 찾습니다(kidQueries).
  const queries = uniqueList([...subKeywords.slice(0, 3).map(combine), main, ...kidQueries(main)]);
  const oldest = new Date(now - MAX_AGE_DAYS * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
  // 검색어 하나로 찾고, 핵심 낱말(core)이 모두 든 2년 안 기사만 최신순으로 4건까지 남깁니다(한 검색어 기사로 참고 자료가 채워지지 않게).
  // core 는 기사 원문에서 요약 문장을 고를 때 다시 씁니다(readArticles).
  const search = async (query, core) => {
    const settled = await Promise.allSettled([
      fetchBingNews(query),
      fetchGoogleNews(query),
      fetchNaverSearch(query, 'news', 5, 'date'),
    ]);
    return mergeReferences(...settled.map((result) => (result.status === 'fulfilled' ? result.value : [])))
      .filter((item) => {
        const text = compact(`${item.title} ${item.snippet}`);
        return item.date && item.date >= oldest && !isNaverBlog(item.url) && core.every((token) => hasToken(text, token));
      })
      .slice(0, 4)
      .map((item) => ({ ...item, core }));
  };
  const mainCore = coreTokens(main);
  let found = mergeReferences(...await Promise.all(queries.map((query) => search(query, mainCore))));
  // "아기 열 내리는 법"처럼 방법형 키워드는 뉴스가 거의 없어, 3건이 안 되면 서브 키워드만으로도 찾아 봅니다.
  if (found.length < 3 && subKeywords.length) {
    const subs = uniqueList(subKeywords.slice(0, 3).map((sub) => String(sub ?? '').trim()))
      .filter((sub) => compact(sub) !== compact(main));
    found = mergeReferences(found, ...await Promise.all(subs.map((sub) => search(sub, coreTokens(sub)))));
  }
  // 앞쪽 기사는 원문을 열어 요약을 더 읽습니다. (.env 의 BLOG_READ_ARTICLES=off 로 끔)
  found = found.slice(0, limit);
  if (String(process.env.BLOG_READ_ARTICLES || 'on').toLowerCase() !== 'off') {
    await readArticles(found);
  }
  return found.map(({ core, ...item }) => item);
};

const researchAll = async (keywords) => {
  const list = [];
  for (let index = 0; index < keywords.length; index += 1) {
    list.push(await researchKeyword(keywords[index]));
  }
  return list;
};

export { researchKeyword, researchAll, researchLatest, mergeReferences, parseRss, coreTokens, uniqueList, stripTags, articleExcerpt, articleUrlOf, hasToken, kidQueries };
