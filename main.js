import { app, BrowserWindow, ipcMain, clipboard, shell, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS, ensureDirs, loadEnv, envStatus } from './src/config.js';
import { researchKeyword, researchLatest, mergeReferences } from './src/research.js';
import { normalizeDraft, makeTitle, targetRange, EMPHASIS, keywordIssues } from './src/content.js';
import { callDeepSeek } from './src/deepseek.js';
import { callGemini } from './src/gemini.js';
import { callOllama, ollamaStatus } from './src/ollama.js';
import { fetchPhoto, saveImage } from './src/images.js';
import { isParentingTopic } from './src/topics.js';
import { buildBlocks, blocksToHtml, draftToText } from './src/blocks.js';
import { writeToNaver, closeBrowser } from './src/naver.js';

const here = path.dirname(fileURLToPath(import.meta.url));

loadEnv();
ensureDirs();

// bat 파일에서 넘겨준 키워드와 제목을 읽습니다.
// argv 를 받으면 그 실행 줄을 읽습니다(이미 떠 있는 창이 두 번째 실행의 키워드를 받을 때).
const readArgs = (argv = process.argv) => {
  const args = argv.slice(1);
  const value = (name) => {
    const found = args.find((item) => item.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : '';
  };
  // 여러 글: --kw1= --title1= ... --kw20= --title20= (bat 에서 글마다 받은 키워드·제목, 최대 20개 — 화면 MAX_POSTS 와 같게)
  // 제목을 비우면 --titleN= 이 빈 값으로 오고, 제목은 AI 가 키워드를 조합해 만듭니다. (2026-10-08 에 제목 질문을 뺐다가 2026-10-17 다시 넣음)
  const posts = Array.from({ length: 20 }, (_, i) => i + 1)
    .map((n) => ({ kw: value(`kw${n}`).trim(), title: value(`title${n}`).trim() }))
    .filter((post) => post.kw);
  return {
    posts,
    keywords: value('keywords').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 3),
    title: value('title').trim(),
    auto: args.includes('--auto'),
    selftest: args.includes('--selftest'),
  };
};

const cliInput = readArgs();
let mainWindow = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 880,
    minWidth: 960,
    title: '네이버 블로그 글쓰기 자동화',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(here, 'renderer', 'index.html'));
  // bat 에서 받은 키워드·바로 실행(--auto)은 처음 화면을 열 때 한 번만 씁니다.
  // 화면이 다시 읽히면 1번 글부터 다시 시작해, 두 번째 글 자리에 첫 번째 글을 또 쓰는 일이 있었습니다(2026-10-03 사용자 보고).
  let booted = false;
  mainWindow.webContents.on('did-finish-load', () => {
    const cli = booted ? { posts: [], keywords: [], title: '', auto: false, selftest: false } : cliInput;
    booted = true;
    mainWindow.webContents.send('boot', { cli, env: envStatus() });
  });
  // 작업 중에 화면이 다른 곳으로 넘어가거나 새 창이 열리지 않게 합니다. (미리보기의 링크 등)
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
};

const log = (message) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', String(message));
  }
};

const clip = (value, max) => String(value ?? '').trim().slice(0, max);

// 화면 위쪽 상태 표시에 쓰입니다. 로컬 AI 는 실제로 켜져 있는지 확인합니다.
ipcMain.handle('env:status', async () => {
  const ollama = await ollamaStatus();
  return { ...envStatus(), ollama: ollama.ready, ollamaModel: ollama.model };
});

ipcMain.handle('research:keyword', async (event, keyword) => {
  try {
    return await researchKeyword(clip(keyword, 40));
  } catch (error) {
    return { keyword: clip(keyword, 40), related: [], longTail: [], references: [] };
  }
});

ipcMain.handle('draft:create', async (event, payload) => {
  const input = {
    keyword: clip(payload?.keyword, 40),
    subKeywords: (payload?.subKeywords || []).map((item) => clip(item, 40)).filter(Boolean).slice(0, 4),
    related: (payload?.related || []).map((item) => clip(item, 40)).filter(Boolean).slice(0, 12),
    references: (payload?.references || []).slice(0, 8),
    title: clip(payload?.title, 100),
    // 화면의 "AI 추가 요청" 칸에 쓴 내용입니다. AI 지시문 끝에 붙습니다.
    extraPrompt: clip(payload?.prompt, 2000),
    // 채팅 모드: 글쓰기 규칙 없이 키워드와 추가 요청만 보내 AI 가 자유롭게 씁니다.
    chatMode: Boolean(payload?.chatMode),
  };
  if (!input.keyword) {
    return { ok: false, message: '키워드를 한 개 이상 입력해 주시기 바랍니다.' };
  }
  // 글쓰기 엔진을 고릅니다. auto 는 딥시크 키 -> Gemini 키 -> 로컬 AI -> 내장 틀 순서로 씁니다.
  const engine = ['deepseek', 'gemini', 'ollama', 'local'].includes(payload?.engine) ? payload.engine : 'auto';
  // 최신 정보: 키워드를 조합한 검색어로 최신 기사를 찾아 참고 자료 맨 앞에 둡니다(사용자 요청 2026-10-14).
  // 딥시크는 검색을 못 하고, Gemini 구글 검색은 키 한도(429)로 막혀 있어 이 기사들이 최신 정보의 출처입니다. (.env 의 BLOG_LATEST_NEWS=off 로 끔)
  // 찾은 기사는 초안 파일(latestNews)에도 남겨, 어떤 최신 소식을 참고했는지 나중에 확인할 수 있게 합니다. (2026-10-26)
  let latestNews = [];
  if (engine !== 'local' && !input.chatMode && String(process.env.BLOG_LATEST_NEWS || 'on').toLowerCase() !== 'off') {
    try {
      log('키워드를 조합해 최신 기사를 찾고, 앞쪽 기사는 원문을 열어 읽습니다. (10초 안팎)');
      const latest = await researchLatest(input.keyword, input.subKeywords);
      input.references = mergeReferences(latest, input.references).slice(0, 12);
      latestNews = latest.map(({ date, title, source, url, read }) => ({ date, title, source: source || '', url: url || '', read: Boolean(read) }));
      if (latest.length) {
        const read = latest.filter((item) => item.read).length;
        log(`최신 기사 ${latest.length}건을 찾아 글에 반영합니다. (가장 최근 ${latest[0].date}${read ? `, 원문까지 읽은 기사 ${read}건` : ''})`);
        latest.slice(0, 3).forEach((item) => log(`  · ${item.date} ${item.title.slice(0, 50)}`));
      } else {
        log('키워드에 맞는 최근 2년 안 기사를 찾지 못해, AI 가 알고 있는 가장 최근 기준으로 씁니다.');
      }
    } catch (error) {
      log(`최신 기사 찾기에 실패해 그대로 작성합니다. (${error.message})`);
    }
  }
  let raw = null;
  let engineName = '내장 글 틀';

  const tryDeepSeek = async (from = input) => {
    if (!process.env.DEEPSEEK_API_KEY) {
      return null;
    }
    log('딥시크(DeepSeek)로 글을 작성합니다. 1분에서 3분 정도 걸립니다.');
    const result = await callDeepSeek(from, { log });
    engineName = '딥시크 AI';
    return result;
  };

  const tryGemini = async (from = input) => {
    if (!process.env.GEMINI_API_KEY) {
      return null;
    }
    log('AI(Gemini)로 글을 작성합니다. 20초에서 60초 정도 걸립니다.');
    const result = await callGemini(from, { log });
    engineName = 'Gemini AI';
    return result;
  };

  const tryOllama = async (from = input) => {
    const status = await ollamaStatus();
    if (!status.ready) {
      return null;
    }
    const result = await callOllama(from, { log });
    engineName = `로컬 AI(${status.model})`;
    return result;
  };

  if (engine !== 'local') {
    const orders = {
      deepseek: [tryDeepSeek],
      gemini: [tryGemini],
      ollama: [tryOllama],
      auto: [tryDeepSeek, tryGemini, tryOllama],
    };
    const order = orders[engine];
    let used = null;
    for (let index = 0; index < order.length && !raw; index += 1) {
      try {
        raw = await order[index]();
        used = raw ? order[index] : null;
      } catch (error) {
        log(`AI 작성이 실패해 다음 방법으로 넘어갑니다. (${error.message})`);
        raw = null;
      }
    }
    // 글 길이는 공백 제외 약 2000자(1800~2200자)입니다(사용자 요청 2026-10-26, .env 의 BLOG_MIN_CHARS).
    // 1800자보다 짧으면 같은 AI 에게 앞선 글을 주고 경험담·팁을 더 붙여 늘려 달라고, 2300자보다 길면 되풀이·군더더기를 덜어 줄여 달라고 한 번 더 요청합니다.
    if (raw && used && !input.chatMode) {
      const { target, low, high } = targetRange();
      const before = normalizeDraft(raw, input);
      const chars = before.charCount;
      if (chars > Math.round(target * 1.15)) {
        log(`글이 공백 제외 ${chars}자로 길어 되풀이되는 내용을 덜어 줄입니다. (목표 약 ${target}자, 1~2분 더 걸립니다)`);
        try {
          const shorter = await used({ ...input, shrinkFrom: { raw, chars } });
          const after = shorter ? normalizeDraft(shorter, input) : null;
          // 줄었고, 너무 짧아지지 않았고(목표의 80% 이상), AI 가 쓴 소제목 수가 같을 때만 바꿉니다.
          // (normalizeDraft 는 모자란 소제목을 기본 틀로 채우므로 AI 가 돌려준 글에서 직접 셉니다.)
          const sectionsOf = (draft) => (Array.isArray(draft?.sections) ? draft.sections.length : 0);
          if (after && after.charCount < chars && after.charCount >= Math.round(target * 0.8)
            && sectionsOf(shorter) === sectionsOf(raw) && after.sections.length === before.sections.length) {
            raw = shorter;
            log(`줄인 글로 바꿨습니다. (${chars}자 → ${after.charCount}자)`);
          } else {
            log(`줄인 글이 알맞지 않아 처음 글을 그대로 씁니다.${after ? ` (${after.charCount}자)` : ''}`);
          }
        } catch (error) {
          log(`글 줄이기에 실패해 처음 글을 그대로 씁니다. (${error.message})`);
        }
      }
      if (chars < low) {
        log(`글이 공백 제외 ${chars}자로 짧아 경험담과 팁을 더 붙여 늘려 씁니다. (목표 ${low}~${high}자, 1~2분 더 걸립니다)`);
        try {
          const longer = await used({ ...input, expandFrom: { raw, chars } });
          const longerChars = longer ? normalizeDraft(longer, input).charCount : 0;
          if (longerChars > chars) {
            raw = longer;
            log(`늘려 쓴 글로 바꿨습니다. (${chars}자 → ${longerChars}자)`);
          } else {
            log('늘려 쓴 글이 더 길지 않아 처음 글을 그대로 씁니다.');
          }
        } catch (error) {
          log(`글 늘려 쓰기에 실패해 처음 글을 그대로 씁니다. (${error.message})`);
        }
      }
    }
    // 교정 단계: 같은 AI 에게 다 쓴 글을 다시 읽혀 어색한 문장·논리가 안 맞는 문장·조사 오류만 고치게 합니다.
    // 구조(소제목 수)·길이(±15%)·★ 강조가 크게 바뀌면 교정본을 버리고 원래 글을 씁니다. (.env 의 BLOG_PROOFREAD=off 로 끔)
    if (raw && used && !input.chatMode && String(process.env.BLOG_PROOFREAD || 'on').toLowerCase() !== 'off') {
      log('다 쓴 글을 한 번 더 읽어 어색한 문장을 다듬습니다. (1~2분 더 걸립니다)');
      try {
        const before = normalizeDraft(raw, input);
        const fixed = await used({ ...input, proofreadFrom: raw });
        const after = fixed ? normalizeDraft(fixed, input) : null;
        const stars = (draft) => [draft.intro, ...draft.sections, draft.conclusion]
          .flatMap((part) => part?.paragraphs || []).filter((item) => String(item).startsWith(EMPHASIS)).length;
        const sameShape = after && after.sections.length === before.sections.length
          && Math.abs(after.charCount - before.charCount) <= before.charCount * 0.15
          && stars(after) >= stars(before) - 1;
        if (sameShape) {
          raw = fixed;
          log(`글을 다듬었습니다. (${before.charCount}자 → ${after.charCount}자)`);
        } else {
          log('다듬은 글의 모양이 처음 글과 많이 달라 처음 글을 그대로 씁니다.');
        }
      } catch (error) {
        log(`글 다듬기에 실패해 처음 글을 그대로 씁니다. (${error.message})`);
      }
    }
    // 키워드 확인: 메인 키워드는 서론 1·본론 2~3·결론 1번(글 전체 4~5번), 서브 키워드는 구역마다 1번, 서로 다른 문장에 들어갔는지 봅니다.
    // 한 문장에 몰렸거나 빠진 곳이 있으면 같은 AI 에게 그 부분만 고치게 합니다(최대 2번). (사용자 요청 2026-10-03)
    if (raw && used && !input.chatMode) {
      const keywords = [input.keyword, ...(input.subKeywords || [])];
      for (let round = 0; round < 2; round += 1) {
        const issues = keywordIssues(normalizeDraft(raw, input), keywords);
        if (issues.length === 0) {
          log('키워드가 정한 횟수만큼(메인 키워드 4~5번) 자연스럽게 들어갔는지 확인했습니다.');
          break;
        }
        log(`키워드가 한 문장에 몰렸거나 빠진 곳 ${issues.length}군데를 고칩니다. (1분쯤 더 걸립니다)`);
        try {
          const fixed = await used({ ...input, keywordFixFrom: { raw, issues } });
          const before = normalizeDraft(raw, input);
          const after = fixed ? normalizeDraft(fixed, input) : null;
          const better = after && after.sections.length === before.sections.length
            && Math.abs(after.charCount - before.charCount) <= before.charCount * 0.15
            && keywordIssues(after, keywords).length < issues.length;
          if (!better) {
            log('고친 글이 더 낫지 않아 앞의 글을 그대로 씁니다.');
            break;
          }
          raw = fixed;
        } catch (error) {
          log(`키워드 고치기에 실패해 앞의 글을 그대로 씁니다. (${error.message})`);
          break;
        }
      }
    }
  }
  if (!raw) {
    engineName = '내장 글 틀';
    log('AI 가 연결되어 있지 않아 기본 글 틀로 작성합니다. 기본 틀에는 주제에 대한 전문 내용이 들어가지 않습니다. .env 에 딥시크(DEEPSEEK_API_KEY)나 Gemini(GEMINI_API_KEY) 키를 넣으면 AI 가 전문 글로 작성합니다.');
  }
  const draft = normalizeDraft(raw, input);
  // 육아 주제인지 표시합니다. 그림을 그릴 때 육아 주제가 아니면 아이·부모를 넣지 않습니다. (사용자 요청 2026-10-03)
  draft.parenting = isParentingTopic(input.keyword, input.subKeywords, input.title);
  // 글 맨 위(스티커 위) 썸네일 사진입니다. 그림 위에 제목의 궁금증을 키우는 문구를 얹습니다(draft.thumbnail).
  // 2026-10-05 끔 → 2026-10-08 켬 → 끔 → 켬 → 끔 → 2026-10-29 다시 켬(사용자 요청). BLOG_TOP_IMAGE=off 일 때만 만들지 않습니다.
  draft.topImage = String(process.env.BLOG_TOP_IMAGE || 'on').trim().toLowerCase() !== 'off';
  draft.engineName = raw && input.chatMode ? `${engineName} · 채팅 모드` : engineName;
  // 내장 글 틀은 기사를 쓰지 않으므로 AI 가 쓴 글에만 남깁니다.
  draft.latestNews = raw ? latestNews : [];
  if (!input.title) {
    draft.title = draft.title || makeTitle(input.keyword, input.subKeywords);
  }
  return { ok: true, draft };
});

ipcMain.handle('image:fetch', async (event, payload) => fetchPhoto({
  query: clip(payload?.query, 180),
  koQuery: clip(payload?.koQuery, 40),
  caption: clip(payload?.caption, 80),
  // 그림이 담을 글 내용(소제목 글 전체, 또는 글 전체 요약)
  context: clip(payload?.context, 1200),
  // 육아 주제가 아니면 false (아이·부모를 그리지 않음)
  parenting: payload?.parenting !== false,
  // 맨 위 썸네일이면 제목의 궁금증을 부르는 장면으로 그립니다(아래쪽은 문구 자리로 비움)
  thumbnail: payload?.thumbnail === true,
  index: Number(payload?.index) || 0,
  seed: clip(payload?.seed, 40) || String(Date.now()),
}));

ipcMain.handle('image:save', async (event, payload) => {
  try {
    const filePath = saveImage(payload?.dataUrl, payload?.name);
    return { ok: true, filePath };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle('draft:blocks', async (event, payload) => {
  const blocks = buildBlocks(payload?.draft || {}, payload?.imageFiles || []);
  return {
    blocks,
    previewHtml: blocksToHtml(blocks, { forPreview: true }),
  };
});

ipcMain.handle('draft:save', async (event, payload) => {
  const draft = payload?.draft || {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = String(draft.mainKeyword || 'post').replace(/[^\w가-힣]/g, '').slice(0, 20);
  const base = path.join(PATHS.drafts, `${stamp}-${safe}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(draft, null, 2), 'utf8');
  fs.writeFileSync(`${base}.txt`, draftToText(draft), 'utf8');
  fs.writeFileSync(`${base}.html`, `<!doctype html><meta charset="utf-8"><title>${draft.title || ''}</title><body style="max-width:760px;margin:40px auto;font-family:'Malgun Gothic',sans-serif"><h1 style="font-size:24px">${draft.title || ''}</h1>${payload?.previewHtml || ''}</body>`, 'utf8');
  return { ok: true, filePath: `${base}.html` };
});

let writing = false;

ipcMain.handle('naver:write', async (event, payload) => {
  if (writing) {
    return { ok: false, message: '이미 글을 쓰고 있습니다. 끝난 뒤에 다시 눌러 주시기 바랍니다.' };
  }
  writing = true;
  try {
    const result = await writeToNaver({
      title: clip(payload?.title, 100),
      blocks: payload?.blocks || [],
      mode: payload?.mode === 'paste' ? 'paste' : 'type',
      writeClipboard: async ({ html, text }) => {
        clipboard.write({ html, text });
      },
      log,
      onProgress: ({ index, total }) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('progress', { index, total });
        }
      },
    });
    return { ok: true, ...result };
  } catch (error) {
    const messages = {
      'login-timeout': '네이버 로그인 대기 시간이 지났습니다. 브라우저에서 로그인한 뒤 다시 실행해 주시기 바랍니다.',
      'editor-not-found': '글쓰기 화면을 열지 못했습니다. .env 파일의 NAVER_BLOG_ID 에 블로그 아이디를 적어 주시기 바랍니다.',
      'title-box-not-found': '제목 칸을 찾지 못했습니다. 네이버 에디터 구조가 바뀐 것 같습니다. data\\logs 폴더의 naver-dom 파일을 확인해 주시기 바랍니다.',
      'title-focus-failed': '제목 칸을 눌렀지만 커서가 들어가지 않았습니다. 브라우저에 안내 팝업이 떠 있는지 확인하고 닫은 뒤 다시 실행해 주시기 바랍니다.',
      'browser-closed': '입력하는 도중에 브라우저 창이 닫혀 멈췄습니다. 다시 실행하면 브라우저를 새로 띄워 처음부터 입력합니다. 입력이 끝날 때까지 브라우저 창은 닫지 말아 주시기 바랍니다.',
      'editor-not-empty': '새 글쓰기 화면에 앞 글이 그대로 남아 있어, 앞 글을 덮어쓰지 않도록 이 글은 넣지 않았습니다. 브라우저에서 작성 중인 글을 정리한 뒤 이 글만 다시 실행해 주시기 바랍니다.',
      'title-input-failed':'제목 칸을 눌렀지만 글자가 들어가지 않았습니다. 브라우저를 닫고 다시 실행해 주시고, 같은 문제가 반복되면 data\\logs 폴더의 naver-dom 파일을 알려 주시기 바랍니다.',
    };
    const message = messages[error.message] || `네이버 입력에 실패했습니다. (${error.message})`;
    return { ok: false, message };
  } finally {
    writing = false;
  }
});

ipcMain.handle('browser:close', async () => {
  await closeBrowser();
  return { ok: true };
});

// 로컬 AI 설치 안내 페이지를 엽니다.
ipcMain.handle('open:external', async (event, url) => {
  const allowed = ['https://ollama.com/download', 'https://aistudio.google.com/apikey', 'https://pixabay.com/api/docs/'];
  if (allowed.includes(url)) {
    await shell.openExternal(url);
  }
  return { ok: true };
});

ipcMain.handle('open:folder', async (event, which) => {
  const target = which === 'images' ? PATHS.images : PATHS.drafts;
  await shell.openPath(target);
  return { ok: true };
});

ipcMain.handle('env:open', async () => {
  if (!fs.existsSync(PATHS.env)) {
    const sample = path.join(here, '.env.example');
    fs.copyFileSync(sample, PATHS.env);
  }
  await shell.openPath(PATHS.env);
  return { ok: true };
});

// 개발 점검용입니다. --selftest 로 실행하면 글과 이미지까지 만들고 결과를 출력한 뒤 종료합니다.
ipcMain.handle('selftest:done', (event, payload) => {
  console.log(`SELFTEST ${JSON.stringify(payload)}`);
  fs.writeFileSync(path.join(PATHS.data, 'selftest.json'), JSON.stringify(payload, null, 2), 'utf8');
  setTimeout(() => app.quit(), 300);
  return { ok: true };
});

ipcMain.handle('dialog:message', async (event, message) => {
  await dialog.showMessageBox(mainWindow, { message: String(message), buttons: ['확인'] });
  return { ok: true };
});

// 프로그램은 한 번에 하나만 띄웁니다. 실행 중에 글쓰기.bat 을 또 누르면 두 번째 창이 1번 글부터 다시 써서
// 첫 번째 창이 쓰는 글과 겹쳤습니다(2026-10-03 사용자 보고: 두 번째 글 자리에 첫 번째 글을 씀). 이미 떠 있으면 그 창을 앞으로 가져옵니다.
// 두 번째 실행에서 bat 으로 넣은 새 키워드는 첫 창으로 넘깁니다. 예전에는 새 키워드를 버려
// 첫 창에 남은 옛 키워드로 옛 글을 또 썼습니다(2026-10-09 사용자 보고: 새 키워드를 넣었는데 기존 글이 남음).
// 넘긴 뒤 두 번째 실행은 종료 번호 3 으로 끝나고, 글쓰기.bat 이 그 번호를 보고 "켜져 있는 창으로 넘겼다"고 안내합니다.
const HANDED_OFF_EXIT = 3;
if (!app.requestSingleInstanceLock({ cli: cliInput })) {
  app.exit(HANDED_OFF_EXIT);
} else {
  app.on('second-instance', (event, commandLine, workingDirectory, additionalData) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    const cli = additionalData?.cli || readArgs(commandLine);
    const count = cli.posts?.length || (cli.keywords?.length ? 1 : 0);
    if (!count) {
      log('프로그램이 이미 실행 중이라 새로 띄우지 않았습니다. 이 창에서 계속 진행해 주시기 바랍니다.');
      return;
    }
    log(`프로그램이 이미 실행 중이라 새로 띄우지 않고, bat 에서 새로 넣은 키워드·제목(글 ${count}개)을 이 창으로 받았습니다.`);
    const send = () => mainWindow.webContents.send('cli:input', { cli });
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', send);
    } else {
      send();
    }
  });
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', async () => {
  await closeBrowser();
  app.quit();
});
