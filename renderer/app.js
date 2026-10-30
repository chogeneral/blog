import { makeImage } from './imagelab.js';

const el = (id) => document.getElementById(id);
const api = window.api;

const state = {
  busy: false,
  ready: null,       // 미리보기에 보이는 글입니다.
  readyList: [],     // 글만 만든 뒤 네이버 입력을 기다리는 글들입니다. [{ row, post }]
  posts: {},         // 이번 실행에서 만든 모든 글입니다. { 줄 번호: post } — 임시저장 뒤에도 눌러서 미리보기를 볼 수 있습니다.
  env: {},
};

// 글 목록 줄 수입니다. 한 번 실행에 최대 이만큼 글을 쓰고 글마다 임시저장합니다.
// (사용자 요청 2026-10-03, 2026-10-10 에 30 으로 늘렸다가 2026-10-11 다시 10, 2026-10-22 에 20)
// 바꿀 때는 main.js readArgs 의 --kwN 개수와 글쓰기.bat 의 질문 수도 같이 바꿉니다.
const MAX_POSTS = 20;

// 글 목록 줄(번호 · 키워드 · 제목 · 상태)을 만듭니다.
// 제목을 넣으면 그 제목 그대로 쓰고 글도 제목에 맞춰 씁니다. 비우면 키워드를 조합해 자동으로 만듭니다.
// (2026-10-08 에 제목 칸을 뺐다가 2026-10-17 사용자 요청으로 다시 넣음)
const renderRows = () => {
  el('posts').innerHTML = Array.from({ length: MAX_POSTS }, (_, index) => {
    const n = index + 1;
    return `<div class="post-row">
      <span class="num">글 ${n}</span>
      <input id="post${n}Kw" type="text" placeholder="${n === 1 ? '키워드 예) 아기 기침, 밤 기침' : '키워드'}" autocomplete="off" aria-label="글 ${n} 키워드">
      <input id="post${n}Title" class="title" type="text" maxlength="100" placeholder="${n === 1 ? '제목 예) 아기 기침 3일째, 병원 가야 할까? (비우면 자동)' : '제목 (비우면 키워드로 자동)'}" autocomplete="off" aria-label="글 ${n} 제목">
      <span class="state" id="post${n}State"></span>
    </div>`;
  }).join('');
};

// 줄 상태를 표시합니다. kind: work(작성 중) · done(임시저장) · fail(실패) · ready(미리보기 준비)
const setRowState = (row, text, kind = '') => {
  const node = el(`post${row}State`);
  if (node) {
    // 만든 글이 있는 줄은 상태(작성 중 제외)를 누르면 그 글 미리보기를 보여 줍니다.
    const viewable = text && kind !== 'work' && state.posts[row];
    node.textContent = viewable && kind !== 'ready' ? `${text} (눌러서 보기)` : text;
    node.className = `state ${kind}${viewable ? ' viewable' : ''}`;
    // 글 목록이 길어 칸 안에서 스크롤되므로, 지금 쓰는 줄이 보이게 옮깁니다.
    if (kind === 'work') {
      node.closest('.post-row')?.scrollIntoView({ block: 'nearest' });
    }
  }
};

const clearRowStates = () => {
  for (let row = 1; row <= MAX_POSTS; row += 1) {
    setRowState(row, '');
  }
};

// 글 목록 줄 내용을 기억해 다음에 켤 때 그대로 보여 줍니다.
const saveRows = () => {
  try {
    const rows = Array.from({ length: MAX_POSTS }, (_, index) => ({
      kw: el(`post${index + 1}Kw`).value,
      title: el(`post${index + 1}Title`).value,
    }));
    localStorage.setItem('postRows', JSON.stringify(rows));
  } catch (error) {
    // 기억하지 못해도 이번 실행에는 그대로 쓰입니다.
  }
};

const loadRows = () => {
  try {
    const rows = JSON.parse(localStorage.getItem('postRows') || '[]');
    rows.slice(0, MAX_POSTS).forEach((row, index) => {
      el(`post${index + 1}Kw`).value = row?.kw || '';
      el(`post${index + 1}Title`).value = row?.title || '';
    });
  } catch (error) {
    // 기억한 내용이 없으면 빈칸으로 둡니다.
  }
};

// 키워드 칸을 쉼표·슬래시로 나눠 앞 3개를 씁니다. (첫 번째가 메인 키워드)
const splitKeywords = (text) => String(text || '').split(/[,，、/]/).map((item) => item.trim()).filter(Boolean).slice(0, 3);

// 제목 칸 글자를 다듬습니다. (main.js 도 100자로 자릅니다)
const cleanTitle = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 100);

// bat 에서 받은 글들을 줄마다 넣을 키워드·제목으로 바꿉니다. (--kwN·--titleN 여러 개, 또는 예전 --keywords·--title 하나)
const cliPosts = (cli) => {
  if (cli?.posts?.length) {
    return cli.posts.filter((post) => post?.kw).map((post) => ({ kw: post.kw, title: cleanTitle(post.title) })).slice(0, MAX_POSTS);
  }
  return cli?.keywords?.length ? [{ kw: cli.keywords.slice(0, 3).join(', '), title: cleanTitle(cli.title) }] : [];
};

// 진행 기록에 보여 줄 글 이름입니다. 예) 아기 기침+밤 기침 (제목: …)
const jobName = (keywords, title) => `${keywords.join('+')}${title ? ` (제목: ${title})` : ''}`;

// 글 목록을 1번 줄부터 채우고 나머지 줄은 비운 뒤 기억합니다.
const fillRows = (list) => {
  for (let row = 1; row <= MAX_POSTS; row += 1) {
    el(`post${row}Kw`).value = list[row - 1]?.kw || '';
    el(`post${row}Title`).value = list[row - 1]?.title || '';
  }
  saveRows();
};

const now = () => new Date().toTimeString().slice(0, 8);

const log = (message) => {
  const line = document.createElement('div');
  line.className = 'line';
  line.innerHTML = `<span class="time">${now()}</span>${String(message).replace(/</g, '&lt;')}`;
  el('log').appendChild(line);
  el('log').scrollTop = el('log').scrollHeight;
};

const setStatus = (message) => {
  el('status').textContent = message;
};

const setBar = (ratio) => {
  el('bar').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
};

const setBusy = (busy) => {
  state.busy = busy;
  ['runAll', 'runDraft'].forEach((id) => { el(id).disabled = busy; });
  el('runNaver').disabled = busy || state.readyList.length === 0;
};

const renderChips = (env) => {
  const items = [
    [env.ollamaModel ? `로컬 AI(${env.ollamaModel})` : '로컬 AI(Ollama)', env.ollama],
    ['AI 글쓰기(딥시크)', env.deepseek],
    ['AI 글쓰기(Gemini)', env.gemini],
    ['Pixabay', env.pixabay],
    ['Pexels', env.pexels],
    ['Unsplash', env.unsplash],
    ['네이버 검색 API', env.naverSearch],
  ];
  el('chips').innerHTML = items
    .map(([name, on]) => `<span class="chip ${on ? 'on' : ''}">${name} ${on ? '연결' : '미설정'}</span>`)
    .join('');
};

// 키워드 칸이 빈 줄은 건너뜁니다. row 는 화면의 줄 번호(1~MAX_POSTS)입니다.
// 제목 칸이 비어 있으면 title 이 '' 이고, 프로그램이 키워드를 조합해 제목을 만듭니다.
const readInputs = () => {
  const posts = [];
  const titleOnly = []; // 제목만 있고 키워드가 없는 줄 (키워드가 있어야 글을 씁니다)
  for (let row = 1; row <= MAX_POSTS; row += 1) {
    const keywords = splitKeywords(el(`post${row}Kw`).value);
    const title = cleanTitle(el(`post${row}Title`).value);
    if (keywords.length) {
      posts.push({ row, keywords, title });
    } else if (title) {
      titleOnly.push(row);
    }
  }
  return {
    posts,
    titleOnly,
    inputMode: document.querySelector('input[name="input"]:checked').value,
    engine: el('engine').value,
    prompt: el('prompt').value.trim(),
    chatMode: document.querySelector('input[name="style"]:checked')?.value === 'chat',
    useImage: el('useImage').checked,
    autoSave: el('autoSave').checked,
  };
};

const CLOSING_QUERIES = ['warm sunset calm sky', 'cozy evening light window', 'soft morning coffee'];

const shownNotices = new Set();

// 이미지 한 장을 받아 정사각형·고화질로 다듬고 파일로 저장합니다.
const buildImage = async ({ query, koQuery, caption, context, label, index, seed, parenting = true, thumbnail = false, overlay = [] }) => {
  let photo = { dataUrl: null };
  try {
    photo = await api.fetchImage({ query, koQuery, caption, context, index, seed, parenting, thumbnail });
  } catch (error) {
    photo = { dataUrl: null };
  }
  // 그림 실패 안내와 사진 기록 파일 안내는 같은 문구를 한 번만 보여 줍니다.
  [photo.notice, photo.record?.warning].forEach((notice) => {
    if (notice && !shownNotices.has(notice)) {
      shownNotices.add(notice);
      log(notice);
    }
  });
  // 썸네일이면 그림 아래쪽에 궁금증 문구를 얹습니다. 본문 사진에는 글씨를 넣지 않습니다.
  // 사진 보정 방식은 .env 의 BLOG_IMAGE_TONE (기본 밝고 화사하게)
  const edited = await makeImage({ dataUrl: photo.dataUrl, caption, label, seed: `${seed}-${index}`, overlay: thumbnail ? overlay : [], tone: state.env?.imageTone || 'bright' });
  const saved = await api.saveImage({ dataUrl: edited, name: `${seed}-${index}` });
  if (!saved.ok) {
    throw new Error(saved.message);
  }
  return { filePath: saved.filePath, credit: photo.credit || '프로그램 생성 이미지', license: photo.license || '', record: photo.record };
};

// 글 하나의 사진 출처와 GPT 그림 금액을 한 줄로 알립니다. 자세한 기록은 data/logs/사진기록.csv 에 있습니다.
const logPhotoUsage = (credits) => {
  const records = credits.map((item) => item.record).filter(Boolean);
  if (records.length === 0) {
    return;
  }
  const count = (kind) => records.filter((item) => item.kind === kind).length;
  const won = records.reduce((sum, item) => sum + (item.won || 0), 0);
  const parts = [
    count('gpt') ? `GPT 그림 ${count('gpt')}장(약 ${won.toLocaleString()}원)` : '',
    count('pollinations') ? `Pollinations 그림 ${count('pollinations')}장` : '',
    count('stock') ? `무료 사진 ${count('stock')}장` : '',
    count('none') ? `프로그램이 그린 사진 ${count('none')}장` : '',
  ].filter(Boolean);
  const last = records[records.length - 1];
  const totals = last.totalGpt
    ? ` / GPT 그림 오늘 ${last.todayGpt}장 약 ${last.todayWon.toLocaleString()}원, ${last.since} 부터 누적 ${last.totalGpt}장 약 ${last.totalWon.toLocaleString()}원`
    : '';
  log(`사진 기록: ${parts.join(' · ')}${totals} (자세한 기록: data\\logs\\사진기록.csv)`);
};

// 이미지 계획: 대표 이미지 1장 + 본문 사진(AI 가 [사진: 설명] 으로 표시한 자리마다 1장).
// 순서가 blocks.js 의 자리 번호와 같아야 하므로, 만들지 못한 사진도 자리는 비워 둡니다(null).
// 맨 위 썸네일은 기본으로 만들고, .env 의 BLOG_TOP_IMAGE=off 면 만들지 않습니다(skip 이면 자리만 비움).
// 썸네일은 제목의 궁금증을 부르는 장면을 그리고, 그 위에 궁금증 문구(draft.thumbnail.text)를 얹습니다. (사용자 요청 2026-10-08)
const imagePlan = (draft) => [
  {
    skip: !draft.topImage,
    query: draft.imageHint || draft.sections?.[0]?.imageQuery || CLOSING_QUERIES[0],
    koQuery: draft.mainKeyword,
    caption: draft.thumbnail?.scene || draft.mainKeyword,
    // 썸네일 그림은 제목과 글 전체 내용을 보고 궁금증을 부르는 장면을 고릅니다.
    context: draft.imageContext || '',
    label: '',
    parenting: draft.parenting !== false,
    thumbnail: true,
    overlay: draft.thumbnail?.text || [draft.title].filter(Boolean),
  },
  ...(draft.photos || []).map((photo) => ({
    query: photo.query || draft.imageHint || CLOSING_QUERIES[0],
    koQuery: draft.mainKeyword,
    caption: photo.caption,
    context: photo.context || '',
    label: '',
    parenting: draft.parenting !== false,
  })),
];

const escapeText = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const renderPreview = (draft, previewHtml, credits) => {
  const meta = [
    `글자수(공백 제외): ${draft.charCount}자${draft.charCountWithSpaces ? ` (공백 포함 ${draft.charCountWithSpaces}자)` : ''} · 소제목 ${draft.sections.length}개 · 이미지 ${credits.length}장`,
    `작성 엔진: ${draft.engineName || (draft.source === 'ai' ? 'AI' : '내장 글 틀')}`,
    `태그: ${(draft.tags || []).map((tag) => `#${tag}`).join(' ')}`,
    `이미지 출처: ${credits.map((item) => item.credit).join(' / ') || '없음'}`,
  ].join('<br>');
  // 제목은 프로그램이 고른 하나만 보여 줍니다(사용자 요청 2026-10-08: 미리보기에서 고르지 않음).
  el('preview').innerHTML = `<div class="meta">${meta}</div><h1 id="previewTitle">${escapeText(draft.title)}</h1>${previewHtml}`;
  showTab('preview');
};

const showTab = (name) => {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('on', tab.dataset.tab === name));
  el('preview').classList.toggle('hidden', name !== 'preview');
  el('log').classList.toggle('hidden', name !== 'log');
};

// 글 하나를 만듭니다. 조사 → 글 작성 → 이미지 → 블록 변환 → 로컬 저장 순서입니다.
const makePost = async ({ keywords, title, engine, prompt = '', chatMode = false, useImage }) => {
  const main = keywords[0];
  const subs = keywords.slice(1);
  setStatus(`${main} 연관 검색어를 조사합니다.`);
  log(`[${main}] 네이버 자동완성으로 연관 검색어를 찾습니다.`);

  const research = [];
  for (let index = 0; index < keywords.length; index += 1) {
    research.push(await api.research(keywords[index]));
  }
  const related = [...new Set(research.flatMap((item) => item.related))].slice(0, 12);
  const references = research.flatMap((item) => item.references).slice(0, 8);
  log(`연관 검색어 ${related.length}개를 찾았습니다. ${related.slice(0, 5).join(', ') || '(없음)'}`);
  setBar(0.15);

  setStatus('글을 작성합니다.');
  const created = await api.createDraft({ keyword: main, subKeywords: subs, related, references, title, engine, prompt, chatMode });
  if (!created.ok) {
    throw new Error(created.message);
  }
  const draft = created.draft;
  log(`글을 만들었습니다. 제목: ${draft.title}`);
  log(`글자수 공백 제외 ${draft.charCount}자, 소제목 ${draft.sections.length}개입니다.`);
  setBar(0.4);

  const plan = imagePlan(draft);
  const imageFiles = [];
  const credits = [];
  if (useImage) {
    const total = plan.filter((item) => !item.skip).length;
    let order = 0;
    for (let index = 0; index < plan.length; index += 1) {
      if (plan[index].skip) {
        imageFiles.push(null); // 만들지 않는 사진도 자리 번호가 밀리지 않게 빈 자리로 둡니다.
        continue;
      }
      order += 1;
      setStatus(`이미지 ${order}/${total}장을 만듭니다.`);
      try {
        const made = await buildImage({ ...plan[index], index, seed: `${Date.now()}-${main}`.replace(/\s/g, '') });
        imageFiles.push(made.filePath);
        credits.push(made);
      } catch (error) {
        imageFiles.push(null); // 자리 번호가 밀리지 않게 빈 자리로 둡니다.
        log(`이미지 ${order}장을 만들지 못했습니다. (${error.message})`);
      }
      setBar(0.4 + (0.35 * (index + 1)) / plan.length);
    }
    log(`이미지 ${credits.length}장을 준비했습니다.`);
    logPhotoUsage(credits);
  } else {
    log('이미지 없이 글만 준비합니다.');
  }

  const built = await api.buildBlocks({ draft, imageFiles });
  const saved = await api.saveDraft({ draft, previewHtml: built.previewHtml });
  log(`초안을 파일로 저장했습니다. ${saved.filePath}`);
  renderPreview(draft, built.previewHtml, credits);
  setBar(0.8);
  return { draft, blocks: built.blocks, previewHtml: built.previewHtml, credits, imageFiles };
};

const sendToNaver = async (post, inputMode) => {
  setStatus('네이버 블로그에 입력합니다.');
  log('브라우저를 띄워 글쓰기 화면에 입력을 시작합니다.');
  const result = await api.writeToNaver({ title: post.draft.title, blocks: post.blocks, mode: inputMode });
  log(result.message);
  setStatus(result.message);
  // ok: 입력을 끝까지 했는지, saved: 임시저장 버튼까지 눌렀는지
  return { ok: Boolean(result.ok), saved: Boolean(result.ok && result.saved), message: result.message };
};

// 네이버에 한 글을 넣고 줄 상태를 표시합니다.
const sendRow = async (row, post, inputMode, results) => {
  setRowState(row, '네이버에 입력하는 중…', 'work');
  const sent = await sendToNaver(post, inputMode);
  if (sent.ok && sent.saved) {
    setRowState(row, `임시저장 완료 — ${post.draft.title}`, 'done');
    results.push({ row, ok: true });
    return;
  }
  const reason = sent.ok ? '글은 넣었지만 임시저장 버튼을 못 찾음(직접 저장 필요)' : sent.message;
  setRowState(row, `실패 — ${reason}`, 'fail');
  results.push({ row, ok: false, reason });
};

// 여러 글 작업이 끝나면 몇 개가 임시저장됐는지 요약합니다.
const summarize = (results, total, toNaver) => {
  const done = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok);
  const head = toNaver
    ? `글 ${total}개 중 ${done}개를 임시저장했습니다.`
    : `글 ${total}개 중 ${done}개를 만들었습니다. 확인한 뒤 "네이버에 입력 + 임시저장" 을 눌러 주시기 바랍니다.`;
  const tail = failed.length ? ` 실패: ${failed.map((item) => `글 ${item.row}(${item.reason})`).join(', ')}` : '';
  log(head + tail);
  setStatus(head + (failed.length ? ` 실패 ${failed.length}개는 진행 기록을 확인해 주시기 바랍니다.` : ''));
};

// 채운 줄이 곧 작업입니다. (최대 MAX_POSTS 개)
const buildJobs = (input) => input.posts.slice(0, MAX_POSTS);

// 글 하나가 실패해도 다음 글로 계속하고, 끝에 결과를 요약합니다. (사용자 선택 2026-10-03)
const run = async ({ toNaver }) => {
  if (state.busy) {
    return;
  }
  const input = readInputs();
  if (input.posts.length === 0) {
    await api.alert(input.titleOnly.length
      ? `제목만 있고 키워드가 비어 있습니다. 글 ${input.titleOnly.join(', ')}번 줄의 키워드 칸에 키워드를 넣어 주시기 바랍니다.`
      : '글 목록에 키워드를 한 줄 이상 입력해 주시기 바랍니다.');
    return;
  }
  if (input.titleOnly.length) {
    log(`글 ${input.titleOnly.join(', ')}번 줄은 제목만 있고 키워드가 없어 건너뜁니다. 키워드를 넣으면 그 제목으로 씁니다.`);
  }
  saveRows();
  setBusy(true);
  setBar(0);
  state.ready = null;
  state.readyList = [];
  state.posts = {};
  clearRowStates();
  const jobs = buildJobs(input);
  jobs.forEach((job) => setRowState(job.row, '대기 중'));
  log(`작업 ${jobs.length}개를 시작합니다. (${jobs.map((job) => jobName(job.keywords, job.title)).join(' / ')})`);

  // 작업 중에 새로 채운 줄도 이어서 씁니다. (bat 이 1번 줄만으로 바로 시작한 뒤 나머지 줄을 채우는 경우,
  // 작업 중에 글쓰기.bat 을 또 실행해 새 키워드가 빈 줄로 넘어온 경우)
  // 글 하나를 마칠 때마다 확인하므로 마지막 글을 쓰는 동안 채운 줄도 빠지지 않습니다.
  const pickUpNewRows = () => {
    readInputs().posts.forEach((post) => {
      if (jobs.length < MAX_POSTS && !jobs.some((item) => item.row === post.row)) {
        jobs.push(post);
        setRowState(post.row, '대기 중');
        log(`새로 채운 글 ${post.row}도 이어서 씁니다. (${jobName(post.keywords, post.title)})`);
      }
    });
    saveRows();
  };

  const results = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    log(`${index + 1}/${jobs.length}번째 글(글 ${job.row})을 시작합니다. 키워드: ${job.keywords.join(', ')}${job.title ? ` / 지정 제목: ${job.title}` : ' / 제목: 자동'}`);
    setRowState(job.row, '글을 만드는 중…', 'work');
    try {
      const post = await makePost({ ...job, engine: input.engine, prompt: input.prompt, chatMode: input.chatMode, useImage: input.useImage });
      state.ready = post;
      state.posts[job.row] = post;
      if (toNaver) {
        await sendRow(job.row, post, input.inputMode, results);
      } else {
        state.readyList.push({ row: job.row, post });
        setRowState(job.row, `미리보기 준비 — ${post.draft.title} (눌러서 보기)`, 'ready');
        results.push({ row: job.row, ok: true });
      }
    } catch (error) {
      log(`글 ${job.row} 작업이 멈췄습니다. ${error.message} 다음 글로 넘어갑니다.`);
      setRowState(job.row, `실패 — ${error.message}`, 'fail');
      results.push({ row: job.row, ok: false, reason: error.message });
    }
    pickUpNewRows();
    setBar((index + 1) / jobs.length);
  }
  summarize(results, jobs.length, toNaver);
  setBusy(false);
};

// 개발 점검용입니다. 네이버에 접속하지 않고 글과 이미지까지만 만들어 결과를 알려 줍니다.
const runSelfTest = async (cli) => {
  try {
    const post = await makePost({
      keywords: cli.keywords.length ? cli.keywords : ['테스트 키워드'],
      title: cli.title,
      engine: 'auto',
      useImage: true,
    });
    await api.selftestDone({
      ok: true,
      title: post.draft.title,
      chars: post.draft.charCount,
      sections: post.draft.sections.length,
      images: post.credits.length,
      blocks: post.blocks.length,
      imageFiles: post.blocks.filter((block) => block.type === 'image').map((block) => block.filePath),
      source: post.draft.source,
    });
  } catch (error) {
    await api.selftestDone({ ok: false, message: error.message, stack: String(error.stack || '').slice(0, 400) });
  }
};

renderRows();
loadRows();
// 글을 쓰는 동안에는 화면을 새로 읽지 않습니다. 새로 읽으면 하던 작업을 잊고 1번 글부터 다시 시작했습니다.
window.addEventListener('beforeunload', (event) => {
  if (state.busy) {
    event.preventDefault();
    event.returnValue = false;
  }
});
// 칸을 고칠 때마다 기억합니다.
el('posts').addEventListener('input', saveRows);

el('runAll').addEventListener('click', () => run({ toNaver: true }));
el('runDraft').addEventListener('click', () => run({ toNaver: false }));
// 미리보기로 만든 글들을 차례로 네이버에 넣고 글마다 임시저장합니다. 실패한 글만 다시 누를 수 있게 남깁니다.
el('runNaver').addEventListener('click', async () => {
  if (state.readyList.length === 0 || state.busy) {
    return;
  }
  const list = state.readyList;
  setBusy(true);
  setBar(0);
  const results = [];
  const { inputMode } = readInputs();
  for (let index = 0; index < list.length; index += 1) {
    try {
      await sendRow(list[index].row, list[index].post, inputMode, results);
    } catch (error) {
      setRowState(list[index].row, `실패 — ${error.message}`, 'fail');
      results.push({ row: list[index].row, ok: false, reason: error.message });
    }
    setBar((index + 1) / list.length);
  }
  state.readyList = list.filter((item) => !results.some((result) => result.row === item.row && result.ok));
  summarize(results, list.length, true);
  setBusy(false);
});

// "미리보기 준비" 를 누르면 그 글을 미리보기에 보여 줍니다.
el('posts').addEventListener('click', (event) => {
  const node = event.target.closest('.state.viewable');
  if (!node) {
    return;
  }
  const row = Number(node.id.replace(/\D/g, ''));
  const post = state.posts[row];
  if (post) {
    state.ready = post;
    renderPreview(post.draft, post.previewHtml, post.credits || []);
    log(`글 ${row} 미리보기를 보여 줍니다. (${post.draft.title})`);
  }
});

el('openDrafts').addEventListener('click', () => api.openFolder('drafts'));
el('openImages').addEventListener('click', () => api.openFolder('images'));
el('openEnv').addEventListener('click', () => api.openEnv());
el('installAi').addEventListener('click', async () => {
  await api.openExternal('https://ollama.com/download');
  log('로컬 AI 설치 페이지를 열었습니다. 설치한 뒤 명령 프롬프트에서 ollama pull gemma3:4b 를 한 번 실행하시면 연결됩니다.');
});
el('closeBrowser').addEventListener('click', async () => {
  await api.closeBrowser();
  log('브라우저를 닫았습니다.');
});
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
});

api.onLog((message) => log(message));

// 프로그램이 켜져 있는 동안 글쓰기.bat 을 또 실행하면, 그 bat 에서 넣은 키워드가 이 창으로 넘어옵니다.
// 예전에는 새 키워드가 버려지고 옛 키워드가 남아 옛 글을 또 썼습니다. (사용자 보고 2026-10-09)
api.onCliInput(({ cli }) => {
  const incoming = cliPosts(cli);
  if (incoming.length === 0) {
    return;
  }
  if (state.busy) {
    // 지금 쓰는 글은 끝까지 쓰고, 빈 줄에 새 키워드·제목을 넣어 이어서 씁니다. 키워드와 제목이 모두 같은 글은 또 넣지 않습니다.
    const same = (kw, title) => `${splitKeywords(kw).join(',')}|${cleanTitle(title)}`;
    const rowKw = (row) => el(`post${row}Kw`).value;
    const rowTitle = (row) => el(`post${row}Title`).value;
    const listed = new Set();
    for (let row = 1; row <= MAX_POSTS; row += 1) {
      if (splitKeywords(rowKw(row)).length) {
        listed.add(same(rowKw(row), rowTitle(row)));
      }
    }
    const left = [];
    incoming.forEach((post) => {
      const name = jobName(splitKeywords(post.kw), post.title);
      if (listed.has(same(post.kw, post.title))) {
        log(`"${name}" 는 이미 글 목록에 있어 또 넣지 않습니다.`);
        return;
      }
      // 키워드도 제목도 빈 줄에 넣습니다. (제목만 쓰다 만 줄은 건드리지 않습니다)
      const row = Array.from({ length: MAX_POSTS }, (_, index) => index + 1)
        .find((n) => !splitKeywords(rowKw(n)).length && !cleanTitle(rowTitle(n)));
      if (!row) {
        left.push(name);
        return;
      }
      el(`post${row}Kw`).value = post.kw;
      el(`post${row}Title`).value = post.title;
      listed.add(same(post.kw, post.title));
      log(`지금 쓰는 글을 마친 뒤 글 ${row}(${name})도 이어서 씁니다.`);
    });
    saveRows();
    if (left.length) {
      log(`글 목록 ${MAX_POSTS}줄이 모두 차 있어 ${left.join(' / ')} 는 넣지 못했습니다. 지금 작업이 끝난 뒤 다시 실행해 주시기 바랍니다.`);
    }
    return;
  }
  // 쉬고 있으면 옛 글 목록·미리보기를 비우고 새 키워드로 바꿉니다. (만들어 둔 옛 초안은 data\drafts 에 그대로 있습니다)
  fillRows(incoming);
  state.ready = null;
  state.readyList = [];
  state.posts = {};
  clearRowStates();
  setBar(0);
  setBusy(false); // 옛 글이 "네이버에 입력" 으로 들어가지 않게 단추 상태를 다시 맞춥니다.
  el('preview').innerHTML = '';
  showTab('log');
  log(`글 목록을 새 키워드로 바꿨습니다. (${incoming.map((post) => jobName(splitKeywords(post.kw), post.title)).join(' / ')})`);
  if (cli.auto) {
    log('bat 파일에서 받은 키워드로 바로 시작합니다.');
    run({ toNaver: true });
  } else {
    setStatus('글 목록을 새 키워드로 바꿨습니다. 확인한 뒤 실행 단추를 눌러 주시기 바랍니다.');
  }
});
api.onProgress(({ index, total }) => {
  setStatus(`본문 입력 중입니다. ${index + 1}/${total}`);
  setBar(0.8 + (0.2 * (index + 1)) / total);
});

api.onBoot(({ cli, env }) => {
  state.env = env;
  renderChips(env);
  // bat 에서 받은 키워드·제목은 1번 줄부터 넣습니다. (bat 에서 제목을 비웠으면 제목 칸도 비워 자동으로 만듭니다)
  if (cli?.posts?.length) {
    // bat 에서 글 여러 개를 받았으면 1번 줄부터 차례로 채우고 나머지 줄은 비웁니다.
    fillRows(cliPosts(cli));
  } else if (cli?.keywords?.length) {
    el('post1Kw').value = cli.keywords.slice(0, 3).join(', ');
    el('post1Title').value = cleanTitle(cli.title);
    saveRows();
  }
  // 지난번에 쓴 AI 추가 요청을 불러옵니다.
  // 지난번에 고른 글 스타일도 불러옵니다.
  try {
    el('prompt').value = localStorage.getItem('extraPrompt') || '';
    const style = localStorage.getItem('writeStyle');
    const radio = document.querySelector(`input[name="style"][value="${style === 'chat' ? 'chat' : 'rules'}"]`);
    if (radio) {
      radio.checked = true;
    }
  } catch (error) {
    // 저장 공간을 못 쓰면 빈칸으로 둡니다.
  }
  document.querySelectorAll('input[name="style"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      try {
        localStorage.setItem('writeStyle', radio.value);
      } catch (error) {
        // 기억하지 못해도 이번 실행에는 그대로 쓰입니다.
      }
    });
  });
  el('prompt').addEventListener('input', () => {
    try {
      localStorage.setItem('extraPrompt', el('prompt').value);
    } catch (error) {
      // 기억하지 못해도 이번 실행에는 그대로 쓰입니다.
    }
  });
  // 이미지 넣기는 기본으로 켜 둡니다(GPT Image 2 그림). 끄면 그 선택을 기억합니다.
  // (예전 반자동 시절의 '꺼짐' 기억은 쓰지 않도록 저장 이름을 바꿨습니다.)
  try {
    el('useImage').checked = localStorage.getItem('useImageAi') !== 'off';
  } catch (error) {
    el('useImage').checked = true;
  }
  el('useImage').addEventListener('change', () => {
    try {
      localStorage.setItem('useImageAi', el('useImage').checked ? 'on' : 'off');
    } catch (error) {
      // 기억하지 못해도 이번 실행에는 그대로 쓰입니다.
    }
  });
  log('준비가 끝났습니다. 키워드와 제목(비우면 자동)을 넣고 실행해 주시기 바랍니다.');
  if (!env.deepseek && !env.gemini && !env.ollama) {
    log('AI 없이도 연관 검색어를 녹인 내장 글 틀로 1500자 이상 글을 만듭니다.');
    log('키 없이 AI 를 쓰시려면 로컬 AI 설치 버튼을 눌러 Ollama 를 설치하시기 바랍니다.');
  } else if (!env.deepseek && !env.gemini && env.ollama) {
    log(`로컬 AI(${env.ollamaModel})가 연결되어 있습니다. API 키 없이 AI 로 글을 씁니다.`);
  }
  if (cli?.selftest) {
    runSelfTest(cli);
    return;
  }
  if (cli?.auto && (cli?.posts?.length || cli?.keywords?.length)) {
    log('bat 파일에서 받은 키워드로 바로 시작합니다.');
    run({ toNaver: true });
  }
});

api.envStatus().then((env) => {
  state.env = env;
  renderChips(env);
});
