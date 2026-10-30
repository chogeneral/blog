import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { PATHS } from './config.js';

// 네이버 블로그 글쓰기 화면을 열고 키보드로 글을 입력한 뒤 임시저장까지 진행합니다.
// 로그인 정보는 data/naver-profile 폴더에 남으므로 처음 한 번만 직접 로그인하면 됩니다.

const MY_BLOG_URL = 'https://blog.naver.com/MyBlog.naver';
const WRITE_URLS = [
  (id) => `https://blog.naver.com/${id}?Redirect=Write`,
  (id) => `https://blog.naver.com/${id}/postwrite`,
];
const LOGIN_WAIT_MS = 300000;
const LOGIN_NOTICE = '네이버 로그인 화면입니다. 열린 브라우저에서 로그인해 주시기 바랍니다. "로그인 상태 유지"를 켜 두면 다음부터는 로그인하지 않아도 됩니다. 최대 5분 기다립니다.';
const TYPE_DELAY = Number(process.env.TYPE_DELAY || 8);

let contextPromise = null;
let cachedBlogId = null;
let closeCount = 0; // 브라우저가 닫힌 횟수. 입력 도중 닫혔는지 알아내는 데 씁니다.

const noop = () => {};

const getContext = async () => {
  if (!contextPromise) {
    fs.mkdirSync(PATHS.profile, { recursive: true });
    const launching = chromium.launchPersistentContext(PATHS.profile, {
      headless: false,
      locale: 'ko-KR',
      viewport: { width: 1440, height: 940 },
      args: ['--disable-blink-features=AutomationControlled'],
    }).then((context) => {
      // 사용자가 브라우저 창을 X 로 닫으면 기억해 둔 브라우저를 잊습니다.
      // 잊지 않으면 다음 실행 때 닫힌 브라우저에 새 탭을 열려다 "has been closed" 오류가 납니다.
      context.on('close', () => {
        closeCount += 1;
        if (contextPromise === launching) {
          contextPromise = null;
        }
      });
      return context;
    }).catch((error) => {
      contextPromise = null;
      throw error;
    });
    contextPromise = launching;
  }
  return contextPromise;
};

const isClosedError = (error) => /has been closed|Target closed|browser has disconnected/i.test(String(error?.message || error));

// 쓸 수 있는 탭을 하나 돌려줍니다. 브라우저가 닫혀 있었으면 새로 띄워 한 번 더 시도합니다.
const openPage = async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const context = await getContext();
    try {
      const page = context.pages().find((item) => !item.isClosed()) || await context.newPage();
      return page;
    } catch (error) {
      if (attempt > 0 || !isClosedError(error)) {
        throw error;
      }
      contextPromise = null;
    }
  }
  throw new Error('browser-closed');
};

// 글마다 새 탭을 엽니다. 앞 글을 쓴 탭을 다시 쓰면, 글쓰기 화면 이동이 조용히 실패했을 때
// 첫 번째 글 에디터에 두 번째 글을 덧쓰고 임시저장해 "첫 번째 글만 작성"되는 일이 생길 수 있습니다.
// 떠나기 확인 창(beforeunload)은 자동으로 '떠나기'를 눌러 이동이 막히지 않게 합니다.
const openFreshPage = async () => {
  const page = await openPage();
  const context = page.context();
  const fresh = await context.newPage();
  fresh.on('dialog', (dialog) => (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(noop));
  const others = context.pages().filter((item) => item !== fresh && !item.isClosed());
  for (let index = 0; index < others.length; index += 1) {
    await others[index].close({ runBeforeUnload: false }).catch(noop);
  }
  return fresh;
};

const closeBrowser = async () => {
  if (!contextPromise) {
    return;
  }
  const context = await contextPromise.catch(() => null);
  contextPromise = null;
  if (context) {
    await context.close().catch(noop);
  }
};


// 제목 칸을 가리킬 수 있는 선택자들입니다. 네이버가 클래스 이름을 바꿔도 하나는 걸리도록 넓게 적었습니다.
// 앞쪽이 더 정확한 선택자이고, 뒤로 갈수록 범위가 넓습니다.
const TITLE_SELECTORS = [
  '.se-section-documentTitle [contenteditable="true"]',
  '.se-documentTitle [contenteditable="true"]',
  '.se-title-text [contenteditable="true"]',
  '.se-section-documentTitle .se-text-paragraph',
  '.se-documentTitle .se-text-paragraph',
  '.se-title-text .se-text-paragraph',
  'textarea.se-title-input',
  '.se-title-input',
  '.se-section-documentTitle',
  '.se-documentTitle',
  '.se-title-text',
];

// 제목 칸이 있는지만 확인할 때 쓰는 선택자입니다. contenteditable 조건을 걸지 않습니다.
const TITLE_PROBE = '.se-section-documentTitle, .se-documentTitle, .se-title-text, .se-title-input, textarea.se-title-input';

// 글쓰기 화면이 들어 있는 프레임을 찾습니다.
const editorFrame = async (page) => {
  const frames = page.frames();
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const count = await frame.locator(TITLE_PROBE).count().catch(() => 0);
    if (count > 0) {
      return frame;
    }
  }
  return null;
};

// 작성 중 글 복구 안내, 도움말 패널 같은 팝업을 닫습니다.
// 이 팝업이 열려 있으면 화면 전체를 덮어서 제목 칸을 눌러도 클릭이 가로막힙니다.
// 그래서 닫기 버튼을 넓게 찾고, 남아 있는 덮개가 있으면 Escape 까지 눌러 봅니다.
// 네이버 상단 "저장 | 15" 의 숫자를 누르면 뜨는 "임시저장 글" 목록 창입니다(2026-10-23 실제 기록 naver-toolbar-1792686010126.json:
// layer_popup__… isShow__… 안에 dimmed__… 덮개와 data-focus-lock="popupLayer"). 덮개가 도구 모음 클릭을 막고 키보드 초점을 창 안에 가둬,
// 열려 있는 28분 동안 본문이 들어가지 않고 글자 크기·색도 바뀌지 않았습니다. 창 안에서 Enter 가 눌리면 예전 임시저장 글을 불러올 수도 있습니다.
const LAYER_POPUP = '[class*="layer_popup"][class*="isShow"]';

const POPUP_CLOSE_SELECTORS = [
  '.se-popup-button-cancel',
  '.se-popup-button-close',
  '.se-popup-close-button',
  '.se-popup-alert-button-confirm',
  '.se-help-panel-close-button',
  '.se-guide-popup-button-close',
  'button.se-popup-button[class*="cancel"]',
  'button[class*="popup"][class*="close"]',
  `${LAYER_POPUP} button[class*="close"]`,
];

// 화면을 덮고 있는 팝업이 아직 보이는지 확인합니다.
// 목록 창은 바깥 틀의 크기가 0 이라 덮개(dimmed)와 창 본체로 봅니다.
const hasBlockingPopup = async (frame) => frame.evaluate((layer) => {
  const layers = [...document.querySelectorAll(`.se-popup, .se-popup-dimmed, .se-dimmed, .se-help-panel, ${layer} [class*="dimmed"], ${layer} [class*="popup_container"]`)];
  return layers.some((node) => {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const box = node.getBoundingClientRect();
    return box.width > 50 && box.height > 50;
  });
}, LAYER_POPUP).catch(() => false);

const dismissPopups = async (page) => {
  const frames = page.frames();
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    for (let round = 0; round < 3; round += 1) {
      let clicked = false;
      for (let which = 0; which < POPUP_CLOSE_SELECTORS.length; which += 1) {
        const cancel = frame.locator(POPUP_CLOSE_SELECTORS[which]);
        const count = await cancel.count().catch(() => 0);
        for (let button = 0; button < count; button += 1) {
          const target = cancel.nth(button);
          if (await target.isVisible().catch(() => false)) {
            await target.click({ timeout: 3000, force: true }).catch(noop);
            clicked = true;
          }
        }
      }
      if (!clicked) {
        break;
      }
      await page.waitForTimeout(350);
    }
    if (await hasBlockingPopup(frame)) {
      await page.keyboard.press('Escape').catch(noop);
      await page.waitForTimeout(300);
    }
  }
};

const isLoginPage = (url) => /nid\.naver\.com|nidlogin/.test(String(url));

// 로그인 상태를 확인하고 내 블로그 아이디를 알아냅니다.
// .env 의 NAVER_BLOG_ID 가 있으면 그 값을 먼저 씁니다.
const resolveBlogId = async (page, log = noop) => {
  const fixed = String(process.env.NAVER_BLOG_ID || '').trim();
  if (fixed) {
    return fixed;
  }
  // 한 번 확인한 아이디는 기억해 둡니다. 다시 실행할 때마다 내 블로그로 이동하지 않게 하기 위해서입니다.
  if (cachedBlogId) {
    return cachedBlogId;
  }
  await page.goto(MY_BLOG_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const deadline = Date.now() + LOGIN_WAIT_MS;
  let noticed = false;
  let strayFrom = 0;
  while (Date.now() < deadline) {
    const current = page.url();
    if (isLoginPage(current)) {
      if (!noticed) {
        log(LOGIN_NOTICE);
        noticed = true;
      }
      strayFrom = 0;
      await page.waitForTimeout(1500);
      continue;
    }
    const match = /blog\.naver\.com\/([A-Za-z0-9_-]+)/.exec(current);
    if (match && !/^(MyBlog|PostWriteForm|PostList)/i.test(match[1])) {
      if (noticed) {
        log('로그인을 확인했습니다.');
      }
      cachedBlogId = match[1];
      return cachedBlogId;
    }
    // 로그인한 뒤 네이버가 내 블로그가 아니라 네이버 첫 화면 같은 다른 곳으로 보내는 경우가 있습니다.
    // 예전에는 여기서 블로그 주소가 나오기만 기다리다 5분을 넘겼습니다. 3초 넘게 다른 곳이면 내 블로그로 다시 갑니다.
    strayFrom = strayFrom || Date.now();
    if (Date.now() - strayFrom > 3000) {
      await page.goto(MY_BLOG_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(noop);
      strayFrom = 0;
    }
    await page.waitForTimeout(1200);
  }
  throw new Error('login-timeout');
};

// 에디터가 뜨기를 기다립니다. 로그인 화면에 있는 동안은 25초 제한에 넣지 않고 최대 5분 기다립니다.
// (예전에는 두 번째 실행부터 로그인할 시간이 25초뿐이라 "글쓰기 화면을 열지 못했습니다"로 끝나곤 했습니다)
const waitForEditor = async (page, log = noop, waitMs = 25000) => {
  let deadline = Date.now() + waitMs;
  const loginDeadline = Date.now() + LOGIN_WAIT_MS;
  let noticed = false;
  while (Date.now() < deadline) {
    if (isLoginPage(page.url())) {
      if (!noticed) {
        log(LOGIN_NOTICE);
        noticed = true;
      }
      if (Date.now() > loginDeadline) {
        throw new Error('login-timeout');
      }
      deadline = Date.now() + waitMs; // 로그인을 마친 뒤부터 다시 25초를 셉니다.
      await page.waitForTimeout(1500);
      continue;
    }
    await dismissPopups(page);
    const frame = await editorFrame(page);
    if (frame) {
      return frame;
    }
    await page.waitForTimeout(1000);
  }
  return null;
};

// 글쓰기 화면을 엽니다. 주소 형식이 두 가지라 차례대로 시도합니다.
const openWriteForm = async (page, blogId, log = noop) => {
  for (let index = 0; index < WRITE_URLS.length; index += 1) {
    const url = WRITE_URLS[index](blogId);
    log(`글쓰기 화면을 엽니다. (${url})`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const frame = await waitForEditor(page, log);
    if (frame) {
      return frame;
    }
    log('이 주소에서는 에디터를 찾지 못했습니다. 다른 주소로 다시 시도합니다.');
  }
  throw new Error('editor-not-found');
};

// 에디터 도구 모음의 버튼들을 읽어 글자 크기, 글자색, 굵게 버튼 위치를 찾습니다.
// 네이버가 클래스 이름을 바꿔도 라벨이나 data 속성으로 다시 찾을 수 있게 만들었습니다.
const discoverToolbar = async (frame) => frame.evaluate(() => {
  const describe = (node, index) => ({
    index,
    className: node.className || '',
    dataName: node.getAttribute('data-name') || '',
    dataValue: node.getAttribute('data-value') || '',
    dataLog: node.getAttribute('data-log') || '',
    label: (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim().slice(0, 40),
  });
  const buttons = [...document.querySelectorAll('button, .se-toolbar-item')].map(describe);
  const match = (patterns) => buttons.find((item) => patterns.some((pattern) => pattern.test(
    `${item.className} ${item.dataName} ${item.dataLog} ${item.label}`,
  )));
  return {
    total: buttons.length,
    bold: match([/bold/i, /굵게/]) || null,
    fontSize: match([/font-?size/i, /글자\s*크기/]) || null,
    fontColor: match([/font-?color/i, /text-?color/i, /글자\s*색/]) || null,
    image: match([/se-image-toolbar-button/, /data-name="image"/, /사진/]) || null,
  };
});

const clickSelector = async (scope, selectors) => {
  for (let index = 0; index < selectors.length; index += 1) {
    const target = scope.locator(selectors[index]).first();
    if (await target.count().catch(() => 0)) {
      if (await target.isVisible().catch(() => false)) {
        await target.click({ timeout: 4000 }).catch(noop);
        return true;
      }
    }
  }
  return false;
};

// 글 맨 아래 "본문 추가" 단추입니다. 마지막 구성 요소(인용구·사진·스티커) 아래에 새 글 문단을 만듭니다.
// 실제 기록(naver-toolbar-1790978384654.json, 2026-10-03): button.se-canvas-bottom-button "본문 추가", 인용구에서 못 빠져나올 때도 화면에 보였음.
// 인용구가 글 맨 끝이면 ↓ 는 "출처" 칸으로 들어가고 아래 빈 곳 클릭은 문단을 만들지 않아 빠져나오지 못했습니다.
const CANVAS_BOTTOM_BUTTONS = [
  'button.se-canvas-bottom-button',
  'button[aria-label*="본문 추가"]',
  'button[title*="본문 추가"]',
];

// 글의 맨 끝 구성 요소가 selector 요소일 때만 "본문 추가" 단추를 누릅니다. (중간에서 누르면 글 끝으로 가 순서가 뒤바뀜)
const addBodyBelowLast = async (frame, selector) => {
  const isLast = await frame.evaluate((target) => {
    const components = [...document.querySelectorAll('.se-component')].filter((node) => !node.closest('.se-documentTitle') && !node.matches('.se-documentTitle'));
    const found = [...document.querySelectorAll(target)];
    const own = found[found.length - 1]?.closest('.se-component');
    return Boolean(own) && components[components.length - 1] === own;
  }, selector).catch(() => false);
  if (!isLast) {
    return false;
  }
  return clickSelector(frame, CANVAS_BOTTOM_BUTTONS);
};

// 실제 네이버 도구 모음 구조(2026-10-02 22:52 기록 naver-toolbar-1790949142436.json):
// 서체 button.se-font-family-toolbar-button[data-name=font-family] "마루부리서체 변경",
// 크기 button.se-font-size-code-toolbar-button[data-name=font-size] "15글자 크기 변경",
// 굵게 button.se-bold-toolbar-button[data-name=bold], 글자색 [data-name=font-color], 배경색 [data-name=background-color].
// 위쪽 도구 모음(property)과 글 옆 떠 있는 도구 모음(contents)에 같은 버튼이 두 벌 있습니다.
const BOLD_SELECTORS = [
  'button.se-bold-toolbar-button',
  'button.se-toolbar-option-bold-button',
  'button[data-name="bold"]',
  'button[aria-label*="굵게"]',
  'button[title*="굵게"]',
];

const FONT_SIZE_TOGGLE = [
  'button.se-font-size-code-toolbar-button',
  'button[data-name="font-size"]',
  'button.se-toolbar-option-font-size-code-toggle-button',
  'button[data-name="font-size-code"]',
  'button[aria-label*="글자 크기"]',
  'button[title*="글자 크기"]',
];

// 글자 배경색 버튼. 네이버가 쓸 법한 이름을 넓게 적었습니다. ("제목 배경 사진" 버튼과 헷갈리지 않게 "배경 사진"은 피합니다)
const BACKGROUND_COLOR_TOGGLE = [
  'button.se-toolbar-option-background-color-toggle-button',
  'button.se-background-color-toolbar-button',
  'button[data-name="background-color"]',
  'button[data-name="bg-color"]',
  'button[data-log*="bgcolor"]',
  'button[class*="background-color"]',
  'button[aria-label*="배경색"]',
  'button[title*="배경색"]',
  'button[aria-label*="글자 배경"]',
];

const FONT_COLOR_TOGGLE = [
  'button.se-toolbar-option-font-color-toggle-button',
  'button.se-font-color-toolbar-button',
  'button[data-name="font-color"]',
  'button[aria-label*="글자색"]',
  'button[title*="글자색"]',
];

// 본문 정렬. 네이버 블로그 "기본 정렬" 설정이 가운데로 되어 있으면 글이 가운데로 들어가므로,
// 문단을 원하는 정렬(기본 가운데)로 바꿉니다. 정렬 버튼은 툴바에 바로 있거나, 정렬 드롭다운 안에 있습니다.
const ALIGN_NAMES = { left: '왼쪽', center: '가운데' };
const alignButtons = (side) => [
  `button[data-name="align"][data-value="${side}"]`,
  `button.se-toolbar-option-align-${side}-button`,
  `button[class*="align-${side}"]`,
  `button[aria-label*="${ALIGN_NAMES[side]} 정렬"]`,
  `button[title*="${ALIGN_NAMES[side]} 정렬"]`,
];

const ALIGN_TOGGLE = [
  'button[data-name^="align-drop-down"]',
  'button[class*="align-drop-down"]',
  'button.se-toolbar-button-align',
  'button[aria-label="정렬"]',
  'button[title="정렬"]',
  'button[aria-label*="정렬 열기"]',
];

// 문단 정렬은 se-text-paragraph-align-center 같은 클래스로 드러납니다. 클래스가 없으면 왼쪽입니다.
const ALIGN_CLASS = 'se-text-paragraph-align-(\\w+)';

// 커서가 있는 문단(없으면 마지막 문단)의 정렬을 봅니다. 모르면 null 입니다.
const caretSide = (frame) => frame.evaluate((pattern) => {
  const anchor = window.getSelection()?.anchorNode;
  const element = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
  const paragraph = element?.closest?.('.se-text-paragraph')
    || [...document.querySelectorAll('.se-text-paragraph')].pop();
  return paragraph ? (new RegExp(pattern).exec(paragraph.className)?.[1] || 'left') : null;
}, ALIGN_CLASS).catch(() => null);

// 본문 문단 중 원하는 정렬(side)이 아닌 문단의 순번을 찾습니다.
// 제목 칸, 인용구 소제목, 일부러 다르게 정렬한 글(keep)은 뺍니다.
const misalignedIndexes = (frame, keep = [], side = 'left') => frame.evaluate(({ pattern, keepTexts, want }) => [...document.querySelectorAll('.se-text-paragraph')]
  .map((node, index) => ({ node, index }))
  .filter(({ node }) => !node.closest('.se-section-documentTitle, .se-documentTitle, .se-quotation'))
  .filter(({ node }) => node.textContent.trim() && !keepTexts.includes(node.textContent.trim()))
  .filter(({ node }) => (new RegExp(pattern).exec(node.className)?.[1] || 'left') !== want)
  .map(({ index }) => index), { pattern: ALIGN_CLASS, keepTexts: keep, want: side }).catch(() => []);

const countMisaligned = async (frame, keep = [], side = 'left') => (await misalignedIndexes(frame, keep, side)).length;

// 지금 커서가 있는 문단(또는 선택한 범위)을 원하는 쪽으로 정렬합니다.
const alignTo = async (frame, side) => {
  if (await clickSelector(frame, alignButtons(side))) {
    return true;
  }
  if (await clickSelector(frame, ALIGN_TOGGLE)) {
    await frame.page().waitForTimeout(200);
    if (await clickSelector(frame, alignButtons(side))) {
      return true;
    }
    await frame.page().keyboard.press('Escape').catch(noop);
  }
  return false;
};

// 이미지·인용구 다음 새 문단은 블로그 기본 정렬로 시작하므로, 글을 치기 전에 확인해 맞춥니다.
const ensureAlign = async (frame, side) => {
  if ((await caretSide(frame)) !== side) {
    await alignTo(frame, side);
  }
};

// 다 쓴 뒤 정렬이 어긋난 문단을 하나씩 눌러 원하는 정렬(side)로 바꿉니다.
// 일부러 다르게 정렬한 글(keep)은 건드리지 않습니다.
const finishAlign = async (page, frame, log = noop, { side = 'left', keep = [] } = {}) => {
  const name = `${ALIGN_NAMES[side] || side} 정렬`;
  if ((await countMisaligned(frame, keep, side)) === 0) {
    return true;
  }
  let before = Number.MAX_SAFE_INTEGER;
  for (let round = 0; round < 80; round += 1) {
    const indexes = await misalignedIndexes(frame, keep, side);
    if (indexes.length === 0 || indexes.length >= before) {
      break;
    }
    before = indexes.length;
    await frame.locator('.se-text-paragraph').nth(indexes[0]).click({ timeout: 4000 }).catch(noop);
    await alignTo(frame, side);
  }
  await focusBodyEnd(frame);
  const left = await countMisaligned(frame, keep, side);
  if (left === 0) {
    log(`본문을 ${name}로 맞췄습니다.`);
    return true;
  }
  const file = await dumpToolbar(frame, `align-${side}-failed`);
  log(`${name}이 되지 않은 문단이 ${left}개 남았습니다. 임시저장 뒤 브라우저에서 그 문단을 선택하고 툴바의 ${name}을 눌러 주시기 바랍니다.${file ? ' (정렬 버튼 정보를 data\\logs 에 남겼습니다)' : ''}`);
  return false;
};

// 서체·크기 버튼에는 지금 값이 적혀 있습니다("마루부리서체 변경", "15글자 크기 변경"). 보이는 첫 버튼의 글자를 읽습니다.
const toggleText = async (frame, selectors) => {
  for (let index = 0; index < selectors.length; index += 1) {
    const target = frame.locator(selectors[index]).first();
    if (await target.count().catch(() => 0) && await target.isVisible().catch(() => false)) {
      return String(await target.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
    }
  }
  return null;
};

// 열린 메뉴에서 글자가 맞는 항목을 찾아 표시(data-auto-pick)합니다.
// 메뉴 버튼(위·옆 도구 모음 두 벌)에도 "마루부리" 같은 지금 값이 적혀 있어, 버튼 자체와 그 안팎은 뺍니다.
// (예전에는 이 버튼을 메뉴 항목으로 잘못 눌러 메뉴가 열린 채 남고, 다음 글이 본문에 들어가지 않았습니다)
const markMenuOption = (frame, toggles, wanted, exact) => frame.evaluate(({ toggleSelectors, want, isExact }) => {
  document.querySelectorAll('[data-auto-pick]').forEach((node) => node.removeAttribute('data-auto-pick'));
  // 실제 크기 메뉴의 항목(11·13·15…)도 메뉴 버튼과 같은 data-name="font-size" 를 달고 있어, 그 선택자로 찾으면 항목까지
  // 메뉴 버튼으로 잡혀 모두 빠졌습니다(2026-10-03 실제 기록: "11을 찾지 못했습니다" → 출처 줄이 15 그대로). 메뉴 항목은 빼고 셉니다.
  const isOption = (node) => node.getAttribute('data-role') === 'option' || Boolean(node.closest('[role="listbox"], .se-toolbar-option'));
  const toggleNodes = toggleSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter((node) => !isOption(node));
  const visible = (node) => Boolean(node.offsetWidth || node.offsetHeight) && getComputedStyle(node).visibility !== 'hidden';
  const text = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();
  // 크기 메뉴 단추는 보이는 숫자와 툴팁이 겹쳐 "11"이 "1111"로 읽힙니다. 보이는 글자와 data-value(fs11)로 고릅니다.
  const shown = (node) => {
    const label = node.querySelector?.('.se-toolbar-option-label');
    return label ? text(label) : text(node);
  };
  const hit = (node) => {
    const value = node.getAttribute?.('data-value') || '';
    if (value === want || value === `fs${want}`) {
      return true;
    }
    const face = shown(node);
    return isExact ? new RegExp(`^${want}(px)?$`).test(face) : face.includes(want);
  };
  const found = [...document.querySelectorAll('button, li, a, [role="option"], [role="menuitem"]')]
    .filter((node) => visible(node) && hit(node))
    .filter((node) => !toggleNodes.some((toggle) => toggle === node || toggle.contains(node) || node.contains(toggle)));
  // 같은 글자를 담은 바깥 요소(li)보다 안쪽 단추를 누릅니다. 바깥 요소 가운데를 누르면 단추를 비껴갈 수 있습니다.
  const inner = found.filter((node) => !found.some((other) => other !== node && node.contains(other)))
    .sort((a, b) => text(a).length - text(b).length);
  if (!inner.length) {
    return false;
  }
  inner[0].setAttribute('data-auto-pick', 'option');
  return true;
}, { toggleSelectors: toggles, want: wanted, isExact: exact }).catch(() => false);

// 메뉴가 열린 채 남지 않게 닫고(Escape, 그래도 열려 있으면 메뉴 버튼을 한 번 더 눌러 닫음) 본문에 입력할 수 있게 합니다.
const closeMenu = async (frame, toggles, openProbe) => {
  await frame.page().keyboard.press('Escape').catch(noop);
  await frame.page().waitForTimeout(150);
  if (openProbe && await openProbe()) {
    await clickSelector(frame, toggles);
    await frame.page().waitForTimeout(150);
  }
};

// 메뉴를 눌렀지만 값이 안 바뀐 기록(…-not-applied)을 이미 남긴 이유입니다. 글마다 typeBlocks 가 비웁니다.
const menuDumps = new Set();

// 메뉴에서 값을 고르고, 메뉴 버튼에 적힌 값이 바뀌었는지로 확인합니다. 실패하면 메뉴를 닫습니다.
// report 를 넘기면 어느 단계에서 실패했는지(toggle = 버튼 없음, option = 메뉴에 그 값 없음, verify = 눌렀지만 안 바뀜) 적어 줍니다.
const chooseFromMenu = async (frame, toggles, wanted, { exact, isSet, reason, report = null }) => {
  if (isSet(await toggleText(frame, toggles))) {
    return true; // 이미 그 값이면 메뉴를 열지 않습니다.
  }
  if (!await clickSelector(frame, toggles)) {
    if (report) {
      report.step = 'toggle';
    }
    return false;
  }
  await frame.page().waitForTimeout(300);
  const optionOpen = () => markMenuOption(frame, toggles, wanted, exact);
  if (!await optionOpen()) {
    if (report) {
      report.step = 'option';
      report.dump = await dumpToolbar(frame, `${reason}-option-not-found`); // 메뉴가 열린 상태 그대로 남깁니다.
    }
    await closeMenu(frame, toggles, null);
    return false;
  }
  await frame.locator('[data-auto-pick="option"]').first().click({ timeout: 4000 }).catch(noop);
  await frame.page().waitForTimeout(250);
  if (isSet(await toggleText(frame, toggles))) {
    return true;
  }
  if (report) {
    report.step = 'verify';
    // 같은 이유의 기록은 글 하나에 한 번만 남깁니다. (2026-10-23 글 하나에 154개가 쌓였고, 그때마다 몇 초씩 걸렸습니다)
    if (!menuDumps.has(reason)) {
      menuDumps.add(reason);
      report.dump = await dumpToolbar(frame, `${reason}-not-applied`);
    }
  }
  await closeMenu(frame, toggles, optionOpen);
  return false;
};

// 글자 크기를 바꿉니다. 드롭다운에서 숫자가 적힌 항목을 누릅니다.
const setFontSize = async (frame, size, report = null) => chooseFromMenu(frame, FONT_SIZE_TOGGLE, String(size), {
  exact: true,
  // 버튼 글자가 "15글자 크기 변경"처럼 지금 크기로 시작합니다.
  isSet: (text) => Boolean(text) && new RegExp(`^${size}([^0-9]|$)`).test(text),
  reason: 'font-size',
  report,
});

// 글꼴입니다. 기준 완성 글처럼 제목·본문을 나눔마루부리로 맞춥니다. (.env 의 BLOG_FONT, off 면 고르지 않음)
// .env 는 이 파일을 불러온 뒤에 읽히므로 쓸 때마다 읽습니다.
const fontName = () => String(process.env.BLOG_FONT || 'nanummaruburi').trim().toLowerCase();
const FONT_LABELS = { nanummaruburi: '마루부리', nanumgothic: '나눔고딕', nanummyeongjo: '나눔명조', nanumbarungothic: '나눔바른고딕', nanumsquare: '나눔스퀘어', system: '기본서체' };
const FONT_TOGGLE = [
  'button.se-font-family-toolbar-button',
  'button[data-name="font-family"]',
  'button.se-toolbar-option-font-family-code-toggle-button',
  'button[class*="font-family"][class*="toggle"]',
  'button[data-name="font-family"]',
  'button[aria-label*="글꼴"]',
  'button[title*="글꼴"]',
];

// 블로그 기본 서체가 이미 마루부리면 메뉴를 열지 않습니다(버튼에 "마루부리서체 변경"이라고 적혀 있음).
const setFontFamily = async (frame, font = fontName(), report = null) => {
  if (font === 'off') {
    return false;
  }
  const label = FONT_LABELS[font] || font;
  return chooseFromMenu(frame, FONT_TOGGLE, label, {
    exact: false,
    isSet: (text) => Boolean(text) && text.includes(label),
    reason: 'font-family',
    report,
  });
};

// 방금 친 본문 문단(사진 설명·인용구·제목 제외, 글자가 있는 마지막 문단)의 실제 글꼴·크기·색을 읽습니다.
// 크기 표시가 se-fs- 처럼 숫자가 없으면 블로그 기본 크기(15)입니다.
const readLineStyle = (frame, selector = null) => frame.evaluate(({ notBody, only }) => {
  const list = only ? [...document.querySelectorAll(only)] : [...document.querySelectorAll('.se-text-paragraph')]
    .filter((node) => !node.closest(notBody));
  const paragraph = list.filter((node) => node.textContent.replace(/[\s​]/g, '')).pop();
  if (!paragraph) {
    return null;
  }
  const hex = (value) => {
    const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value || '');
    return rgb ? `#${[1, 2, 3].map((group) => Number(rgb[group]).toString(16).padStart(2, '0')).join('')}` : '';
  };
  // 글자를 직접 담은 가장 안쪽 요소들만 봅니다.
  const leaves = [...paragraph.querySelectorAll('span, b, i, u')]
    .filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.replace(/[\s​]/g, '')));
  const holders = leaves.length ? leaves : [paragraph];
  const classOf = (node, pattern) => {
    for (let at = node; at && at !== paragraph.parentElement; at = at.parentElement) {
      const found = new RegExp(pattern).exec(String(at.className || ''));
      if (found) {
        return found[1];
      }
    }
    return null;
  };
  const index = [...document.querySelectorAll('.se-text-paragraph')].indexOf(paragraph);
  return {
    index,
    text: paragraph.textContent.trim().slice(0, 30),
    fonts: [...new Set(holders.map((node) => classOf(node, 'se-ff-([a-z0-9]+)') || ''))],
    sizes: [...new Set(holders.map((node) => {
      const size = classOf(node, 'se-fs(\\d*)');
      return size === null ? null : (Number(size) || 15);
    }))],
    colors: [...new Set(holders.map((node) => hex(getComputedStyle(node).color)))],
  };
}, { notBody: NOT_BODY, only: selector }).catch(() => null);

const hexToRgb = (hex) => {
  const value = String(hex).replace('#', '');
  return [0, 2, 4].map((start) => Number.parseInt(value.slice(start, start + 2), 16) || 0);
};

const colorDistance = (left, right) => {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
};

// 글자색을 바꿉니다. 색상판에서 원하는 색과 가장 가까운 칸을 누릅니다.
// 색상표 칸. 숨어 있는 다른 색상표(글자색 ↔ 배경색)의 칸을 누르지 않도록 보이는 칸만 고릅니다.
// 색을 끌 때 돌아갈 본문 기본 글자색입니다. 블로그 기본 서체 설정(나눔마루부리 · 15 · #333333)과 맞춥니다.
// 예전에는 검정(#000000)으로 돌려 본문이 블로그 기본색보다 진하게 들어갔습니다.
const BODY_COLOR = String(process.env.BLOG_TEXT_COLOR || '#333333').trim();
const SWATCHES = '.se-color-palette button, .se-toolbar-layer button[data-value], button.se-color-item, [class*="color-palette"] button, button[data-color]';

// report 를 넘기면 어느 단계에서 실패했는지(toggle = 버튼 없음, palette = 색상표 없음) 적어 줍니다.
const setFontColor = async (frame, hex, toggle = FONT_COLOR_TOGGLE, report = null) => {
  if (!await clickSelector(frame, toggle)) {
    if (report) {
      report.step = 'toggle';
    }
    return false;
  }
  await frame.page().waitForTimeout(250);
  const swatches = await frame.evaluate((selector) => [...document.querySelectorAll(selector)]
    .map((node, index) => ({
      index,
      visible: Boolean(node.offsetWidth || node.offsetHeight),
      value: node.getAttribute('data-value') || node.getAttribute('data-color') || node.style.backgroundColor || '',
    }))
    .filter((item) => item.value && item.visible), SWATCHES).catch(() => []);
  if (swatches.length === 0) {
    if (report) {
      report.step = 'palette';
      // 색상표가 열린 상태 그대로 구조를 남깁니다.
      report.dump = await dumpToolbar(frame, 'color-palette-not-found');
    }
    await frame.page().keyboard.press('Escape').catch(noop);
    return false;
  }
  const normalize = (value) => {
    const rgb = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(value);
    if (rgb) {
      return `#${[1, 2, 3].map((group) => Number(rgb[group]).toString(16).padStart(2, '0')).join('')}`;
    }
    return value.startsWith('#') ? value : `#${value}`;
  };
  let best = swatches[0];
  let bestScore = Number.MAX_SAFE_INTEGER;
  swatches.forEach((item) => {
    const score = colorDistance(hex, normalize(item.value));
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  });
  const target = frame.locator(SWATCHES).nth(best.index);
  await target.click({ timeout: 4000 }).catch(noop);
  await frame.page().waitForTimeout(200);
  return true;
};

// 친 줄의 글꼴·크기·색이 원하는 대로 들어갔는지 확인하고, 틀리면 그 문단을 선택해 다시 적용합니다.
// (빈 문단에 서식을 미리 켜 두는 방식은 가끔 무시되어, 출처 줄이 11 이 아니거나 태그에 앞 글의 색이 남았습니다)
// 같은 항목을 두 번 고치지 못하면 더는 시도하지 않고 한 번 알린 뒤 구조를 남깁니다.
const STYLE_NAMES = { font: '글꼴', size: '글자 크기', color: '글자색' };
const styleFix = { failed: {}, warned: {}, fixed: 0 };

const lineProblems = (style, want) => {
  const problems = [];
  // 글꼴 표시가 없는 글자는 블로그 기본 글꼴이므로 틀린 것으로 보지 않습니다.
  if (want.font && style.fonts.some((font) => font && font !== want.font)) {
    problems.push('font');
  }
  if (style.sizes.some((size) => size !== null && size !== want.size)) {
    problems.push('size');
  }
  if (style.colors.some((color) => color && colorDistance(color, want.color) > 30)) {
    problems.push('color');
  }
  return problems;
};

const sameStart = (left, right) => {
  const a = String(left || '').replace(/[\s​]/g, '');
  const b = String(right || '').replace(/[\s​]/g, '');
  return Boolean(a && b) && (a.startsWith(b.slice(0, 12)) || b.startsWith(a.slice(0, 12)));
};

// 방금 친 줄 바로 위 문단이 비어 있으면 그 빈 문단을 지웁니다(출처 줄을 제목 바로 아래에 붙임, 사용자 요청 2026-10-03).
// 서식(크기 11·회색)을 바꾸는 사이 빈 문단이 하나 끼어드는 경우가 있었습니다. 빈 문단만 하나 줄었는지 확인하고, 아니면 되돌립니다.
const removeBlankAbove = async (page, frame) => {
  const look = () => frame.evaluate(() => {
    const node = window.getSelection()?.anchorNode;
    const own = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.se-text-paragraph');
    const all = [...document.querySelectorAll('.se-text-paragraph')];
    const index = all.indexOf(own);
    const above = index > 0 ? all[index - 1] : null;
    const text = all.map((p) => p.textContent.replace(/[\s​]/g, '')).join('|');
    return { index, blankAbove: Boolean(above) && !above.closest('.se-documentTitle') && !above.textContent.replace(/[\s​]/g, ''), count: all.length, text, mine: own?.textContent || '' };
  }).catch(() => ({ index: -1 }));
  const before = await look();
  if (before.index < 0 || !before.blankAbove) {
    return false;
  }
  await frame.locator('.se-text-paragraph').nth(before.index - 1).click({ timeout: 3000 }).catch(noop);
  await page.keyboard.press('End');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  const after = await look();
  const ok = after.count === before.count - 1 && after.text === before.text.replace(/\|\|/, '|');
  if (!ok) {
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(200);
  }
  await page.keyboard.press('End');
  return ok;
};

const fixLineStyle = async (page, frame, block, log = noop) => {
  const want = { font: fontName() === 'off' ? null : fontName(), size: block.size || 15, color: block.color || BODY_COLOR };
  const style = await readLineStyle(frame);
  // 방금 친 줄이 아니면(줄이 빠진 경우) 다른 줄을 건드리지 않습니다.
  if (!style || !sameStart(style.text, block.text)) {
    return;
  }
  const problems = lineProblems(style, want).filter((item) => (styleFix.failed[item] || 0) < 2);
  if (problems.length === 0) {
    return;
  }
  // 막 친 줄 끝에 커서가 있으므로 키보드(Shift+Home)로 그 줄을 선택합니다.
  // 마우스 세 번 클릭 선택은 실제 네이버 에디터가 서식을 바꿀 선택으로 받아들이지 않았습니다(2026-10-03 기록: 바꾼 뒤에도 "지금: 15", "#000000").
  // 한 줄이 화면에서 두 줄로 넘어가는 긴 줄(태그)은 위 줄까지 넓힙니다.
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  for (let extra = Math.ceil([...block.text].length / 30) - 1; extra > 0; extra -= 1) {
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+Home');
  }
  if (problems.includes('font')) {
    await setFontFamily(frame, want.font);
  }
  if (problems.includes('size')) {
    await setFontSize(frame, want.size);
  }
  if (problems.includes('color')) {
    await setFontColor(frame, want.color);
  }
  await page.keyboard.press('End');
  const after = await readLineStyle(frame);
  const left = after && sameStart(after.text, block.text) ? lineProblems(after, want) : problems;
  for (const item of problems) {
    if (!left.includes(item)) {
      styleFix.fixed += 1;
      continue;
    }
    styleFix.failed[item] = (styleFix.failed[item] || 0) + 1;
    if (styleFix.failed[item] >= 2 && !styleFix.warned[item]) {
      styleFix.warned[item] = true;
      // 글자색은 색상표를 연 상태로 남겨야 칸 구조를 알 수 있습니다.
      let dump;
      if (item === 'color' && await clickSelector(frame, FONT_COLOR_TOGGLE)) {
        await page.waitForTimeout(300);
        dump = await dumpToolbar(frame, 'style-color-failed-palette-open');
        await closeMenu(frame, FONT_COLOR_TOGGLE, null);
        await page.keyboard.press('End').catch(noop);
      } else {
        dump = await dumpToolbar(frame, `style-${item}-failed`);
      }
      const now = { font: after?.fonts.join(','), size: after?.sizes.join(','), color: after?.colors.join(',') }[item];
      log(`${STYLE_NAMES[item]}이 원하는 값(${{ font: want.font, size: want.size, color: want.color }[item]})으로 바뀌지 않습니다. (지금: ${now || '알 수 없음'}, "${block.text.slice(0, 15)}…") 임시저장 뒤 확인해 주시기 바랍니다.${dump ? ` (도구 모음 기록: ${dump})` : ''}`);
    }
  }
};

// 제목 칸을 기준 완성 글처럼 왼쪽 정렬·나눔마루부리로 맞춥니다. (.env 의 BLOG_TITLE_ALIGN)
// 블로그 기본 정렬이 가운데라 제목 칸도 가운데(se-section-align-center)로 들어가 있었습니다.
const titleAlign = () => (String(process.env.BLOG_TITLE_ALIGN || 'left').trim().toLowerCase() === 'center' ? 'center' : 'left');
const TITLE_PARAGRAPH = '.se-section-documentTitle .se-text-paragraph, .se-documentTitle .se-text-paragraph';

const titleSide = (frame) => frame.evaluate(() => {
  const section = document.querySelector('.se-section-documentTitle');
  return section ? (/se-section-align-(\w+)/.exec(section.className)?.[1] || 'left') : null;
}).catch(() => null);

const fixTitleStyle = async (page, frame, log = noop) => {
  const title = frame.locator(TITLE_PARAGRAPH).first();
  const side = await titleSide(frame);
  if (side && side !== titleAlign()) {
    await title.click({ timeout: 4000 }).catch(noop);
    await page.keyboard.press('End');
    await alignTo(frame, titleAlign());
    await page.waitForTimeout(200);
    const now = await titleSide(frame);
    if (now === titleAlign()) {
      log(`제목을 ${ALIGN_NAMES[titleAlign()] || titleAlign()} 정렬로 맞췄습니다.`);
    } else {
      const dump = await dumpToolbar(frame, 'title-align-failed');
      log(`제목 정렬을 ${ALIGN_NAMES[titleAlign()] || titleAlign()}으로 바꾸지 못했습니다. (지금: ${now || '알 수 없음'}) 임시저장 뒤 제목을 누르고 정렬 버튼으로 바꿔 주시기 바랍니다.${dump ? ` (도구 모음 기록: ${dump})` : ''}`);
    }
  }
  if (fontName() === 'off') {
    return;
  }
  const style = await readLineStyle(frame, TITLE_PARAGRAPH);
  if (style && style.fonts.some((font) => font && font !== fontName())) {
    // 제목 끝을 누르고 키보드로 제목 줄을 선택합니다(세 번 클릭 선택은 실제 에디터에서 서식이 안 바뀜).
    await title.click({ timeout: 4000 }).catch(noop);
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await setFontFamily(frame, fontName());
    await page.keyboard.press('End');
    const after = await readLineStyle(frame, TITLE_PARAGRAPH);
    if (after && after.fonts.some((font) => font && font !== fontName())) {
      log(`제목 글꼴을 ${FONT_LABELS[fontName()] || fontName()}로 바꾸지 못했습니다. 임시저장 뒤 확인해 주시기 바랍니다.`);
    }
  }
};

// 본문 문단만 고르는 조건입니다. 제목 칸, 사진 설명(캡션), 인용구 안의 문단은 뺍니다.
// 예전에는 "마지막 문단"을 그냥 눌러서, 사진 바로 뒤에는 사진 설명칸이 눌려 본문이 그 안에 들어가곤 했습니다.
const NOT_BODY = '.se-documentTitle, .se-section-documentTitle, .se-caption, .se-image, .se-module-image, .se-quotation';

const focusBodyEnd = async (frame) => {
  const index = await frame.evaluate((notBody) => {
    const all = [...document.querySelectorAll('.se-text-paragraph')];
    for (let at = all.length - 1; at >= 0; at -= 1) {
      if (!all[at].closest(notBody)) {
        return at;
      }
    }
    return all.length - 1;
  }, NOT_BODY).catch(() => -1);
  if (index < 0) {
    return;
  }
  await frame.locator('.se-text-paragraph').nth(index).click({ timeout: 5000 }).catch(noop);
  await frame.page().keyboard.press('Control+End').catch(noop);
};

// 지금 에디터에 들어 있는 본문 글자(제목·사진 설명·인용구 제외)와 제목 글자를 읽습니다.
const readEditorText = (frame) => frame.evaluate((notBody) => {
  const clean = (text) => String(text || '').replace(/[ ​]/g, ' ').replace(/\s+/g, ' ').trim();
  const paragraphs = [...document.querySelectorAll('.se-text-paragraph')];
  return {
    body: clean(paragraphs.filter((node) => !node.closest(notBody)).map((node) => node.textContent).join(' ')),
    title: clean([...document.querySelectorAll('.se-documentTitle .se-text-paragraph, .se-section-documentTitle .se-text-paragraph')]
      .map((node) => node.textContent).join(' ')),
  };
}, NOT_BODY).catch(() => null);

// 제목 칸을 찾지 못했을 때 화면의 실제 구조를 파일로 남깁니다.
// 네이버가 구조를 또 바꾸면 이 파일을 보고 선택자를 고칠 수 있습니다.
const dumpEditorDom = async (page, frame, reason) => {
  const report = { reason, when: new Date().toISOString(), url: page.url(), frames: [] };
  const frames = page.frames();
  for (let index = 0; index < frames.length; index += 1) {
    const info = await frames[index].evaluate((layer) => {
      const describe = (node) => {
        const box = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return {
          tag: node.tagName.toLowerCase(),
          className: String(node.className || '').slice(0, 200),
          editable: node.getAttribute('contenteditable') || '',
          placeholder: node.getAttribute('placeholder') || '',
          width: Math.round(box.width),
          height: Math.round(box.height),
          display: style.display,
          visibility: style.visibility,
          text: (node.textContent || '').trim().slice(0, 60),
        };
      };
      const pick = (selector) => [...document.querySelectorAll(selector)].slice(0, 12).map(describe);
      return {
        url: location.href,
        titleish: pick('[class*="documentTitle"], [class*="title-input"], [class*="se-title"]'),
        editables: pick('[contenteditable="true"]'),
        popups: pick(`.se-popup, .se-dimmed, .se-popup-dimmed, .se-help-panel, ${layer}`),
        // 본문 끝 구성 요소 3개, 커서(선택)가 있는 구성 요소, 선택된 요소, 보이는 도구 모음 버튼
        // — 스티커·사진이 선택된 상태였는지, 커서가 사진 설명칸에 있었는지 확인하는 데 씁니다.
        lastComponents: [...document.querySelectorAll('.se-component')].slice(-3).map((node) => ({
          className: String(node.className || '').slice(0, 160),
          text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        })),
        activeElement: document.activeElement ? `${document.activeElement.tagName}.${String(document.activeElement.className || '').slice(0, 80)}` : null,
        caretIn: (() => {
          const anchor = window.getSelection()?.anchorNode;
          const element = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
          const component = element?.closest?.('.se-component');
          return component ? { component: String(component.className).slice(0, 160), caption: Boolean(element.closest('.se-caption')) } : null;
        })(),
        selected: [...document.querySelectorAll('.se-component[class*="selected"], .se-component[class*="focus"]')].slice(0, 3)
          .map((node) => String(node.className).slice(0, 160)),
        toolbarButtons: [...document.querySelectorAll('button[class*="toolbar"]')].filter((node) => node.offsetWidth || node.offsetHeight)
          .slice(0, 60).map((node) => String(node.className).split(' ')[0]),
      };
    }, LAYER_POPUP).catch(() => null);
    if (info && (info.titleish.length || info.editables.length)) {
      report.frames.push(info);
    }
  }
  const file = path.join(PATHS.logs, `naver-dom-${Date.now()}.json`);
  try {
    fs.mkdirSync(PATHS.logs, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  } catch (error) {
    return null;
  }
  return file;
};

// 제목 칸으로 쓸 수 있는 요소를 차례대로 찾습니다.
// 보이고, 크기가 있고, 실제로 화면에 올라온 것만 고릅니다.
const findTitleBox = async (frame) => {
  for (let index = 0; index < TITLE_SELECTORS.length; index += 1) {
    const candidate = frame.locator(TITLE_SELECTORS[index]).first();
    if (!await candidate.count().catch(() => 0)) {
      continue;
    }
    if (!await candidate.isVisible().catch(() => false)) {
      continue;
    }
    const box = await candidate.boundingBox().catch(() => null);
    if (box && box.width > 20 && box.height > 5) {
      return { locator: candidate, selector: TITLE_SELECTORS[index] };
    }
  }
  return null;
};

// 스마트에디터 ONE 은 제목 칸 자체가 아니라, 화면 구석의 숨은 입력칸(contenteditable)으로
// 키 입력을 받아 제목 칸에 그려 줍니다. 그래서 "커서가 제목 칸 안에 있는가"로는
// 성공을 판단할 수 없습니다. 에디터 입력칸 어디든 포커스가 갔는지만 보고,
// 실제 성공 여부는 입력한 뒤 제목 칸의 글자를 읽어 확인합니다.
// 실제 에디터는 키를 받는 칸이 높이 0 짜리 iframe 안에 있어서, 바깥 문서에서 보면
// 포커스가 IFRAME 요소에 가 있습니다. 그래서 iframe 안쪽 문서까지 따라 들어가 확인합니다.
// 제목 칸이 "선택됨(se-is-selected)" 표시를 받은 경우도 눌림에 성공한 것으로 봅니다.
const editorHasFocus = (frame) => frame.evaluate(() => {
  const isEditable = (node) => Boolean(node)
    && (node.isContentEditable || node.tagName === 'TEXTAREA' || node.tagName === 'INPUT');
  let active = document.activeElement;
  for (let depth = 0; active && active.tagName === 'IFRAME' && depth < 3; depth += 1) {
    let inner = null;
    try {
      inner = active.contentDocument;
    } catch (error) {
      inner = null;
    }
    if (!inner) {
      return true; // 다른 출처의 iframe 이라 들여다볼 수 없지만, 포커스는 에디터 쪽에 있습니다.
    }
    active = inner.activeElement;
    if (active && active.tagName === 'BODY' && inner.body && inner.body.isContentEditable) {
      return true;
    }
  }
  if (isEditable(active)) {
    return true;
  }
  return Boolean(document.querySelector('.se-documentTitle.se-is-selected, .se-section-documentTitle.se-is-selected'));
}).catch(() => false);

// 제목 칸에 지금 들어 있는 글자를 읽습니다. "제목" 같은 안내 문구(placeholder)는 뺍니다.
const readTitleText = (frame, probe = TITLE_PROBE) => frame.evaluate((probe) => [...document.querySelectorAll(probe)].map((node) => {
  if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') {
    return node.value || '';
  }
  const copy = node.cloneNode(true);
  // 제목 칸 안의 단추(위치이동·제목 배경 사진 삭제·취소·확인) 글자도 뺍니다. 빈 칸을 글이 있다고 오판하던 원인입니다.
  copy.querySelectorAll('.se-placeholder, [class*="placeholder"], button, [role="button"], .se-blind').forEach((item) => item.remove());
  return copy.textContent || '';
}).join(' '), probe).catch(() => '');

// 새 글 화면인지 볼 때는 실제 제목 글자 칸만 읽습니다(제목 칸 둘레의 단추·배경 사진 글자 제외).
const readTitleOnly = (frame) => readTitleText(frame, '.se-title-text, textarea.se-title-input, input.se-title-input');

// 제목 칸을 눌러 에디터가 입력을 받게 합니다. 덮개 때문에 막히면
// force 클릭, 그래도 안 되면 자바스크립트 포커스까지 차례로 시도합니다.
const focusTitleBox = async (frame, found) => {
  await found.locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(noop);

  await found.locator.click({ timeout: 5000 }).catch(noop);
  if (await editorHasFocus(frame)) {
    return 'click';
  }

  await found.locator.click({ timeout: 5000, force: true }).catch(noop);
  if (await editorHasFocus(frame)) {
    return 'force-click';
  }

  // 마지막 수단입니다. 편집 가능한 요소에 직접 포커스를 주고 커서를 끝으로 보냅니다.
  const focused = await found.locator.evaluate((node) => {
    const host = node.getAttribute('contenteditable') === 'true' || node.tagName === 'TEXTAREA'
      ? node
      : node.querySelector('[contenteditable="true"]') || node.closest('[contenteditable="true"]');
    if (!host || typeof host.focus !== 'function') {
      return false;
    }
    host.focus();
    const selection = host.ownerDocument.defaultView.getSelection();
    if (selection && host.childNodes.length) {
      const range = host.ownerDocument.createRange();
      range.selectNodeContents(host);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return host.ownerDocument.activeElement === host;
  }).catch(() => false);
  return focused ? 'js-focus' : null;
};

const enterTitle = async (page, title) => {
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(title, { delay: TYPE_DELAY });
  await page.waitForTimeout(300);
};

// 에디터가 다 뜨고 늦게 나오는 팝업(작성 중 글 복구, 도움말)까지 정리될 때까지 기다립니다.
// 에디터가 보이자마자 입력을 시작하면, 1~2초 뒤에 뜬 팝업이 키 입력을 가로채거나
// 팝업을 닫는 순간 에디터가 다시 그려져 이미 친 제목·본문이 사라질 수 있습니다.
// 팝업이 없는 상태가 연달아 세 번(약 2초) 확인되면 준비된 것으로 봅니다. 최대 12초 기다립니다.
const waitForEditorSettled = async (page, frame, log = noop) => {
  const deadline = Date.now() + 12000;
  let calm = 0;
  while (Date.now() < deadline && calm < 3) {
    await dismissPopups(page);
    const blocked = await hasBlockingPopup(frame);
    const ready = await frame.locator(TITLE_PROBE).count().catch(() => 0) > 0;
    calm = !blocked && ready ? calm + 1 : 0;
    await page.waitForTimeout(650);
  }
  if (calm < 3) {
    log('에디터 화면이 아직 안정되지 않았지만 입력을 시작합니다. 글이 빠지면 다시 실행해 주시기 바랍니다.');
  }
};

const typeTitle = async (page, frame, title, log = noop) => {
  await dismissPopups(page);

  // 에디터가 막 열린 직후에는 제목 칸이 아직 안 그려져 있을 수 있어 잠깐 기다립니다.
  let found = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    found = await findTitleBox(frame);
    if (found) {
      break;
    }
    await dismissPopups(page);
    await page.waitForTimeout(700);
  }

  if (!found) {
    const dump = await dumpEditorDom(page, frame, 'title-box-not-found');
    log(dump
      ? `제목 칸을 찾지 못했습니다. 화면 구조를 ${dump} 에 남겼습니다.`
      : '제목 칸을 찾지 못했습니다.');
    throw new Error('title-box-not-found');
  }

  const how = await focusTitleBox(frame, found);
  const sample = title.replace(/\s+/g, ' ').trim().slice(0, 6);
  if (!how) {
    // 포커스 판정은 네이버 구조가 바뀌면 틀릴 수 있습니다. 판정만 믿고 멈추지 말고
    // 제목 칸을 다시 누른 뒤 실제로 입력해 보고, 글자가 들어갔으면 성공으로 봅니다.
    await found.locator.click({ timeout: 5000, force: true }).catch(noop);
    await enterTitle(page, title);
    if ((await readTitleText(frame)).includes(sample)) {
      log(`제목 칸을 찾았습니다. (${found.selector} / 입력 확인)`);
      return;
    }
    const dump = await dumpEditorDom(page, frame, 'title-focus-failed');
    log(dump
      ? `제목 칸에 커서를 올리지 못했습니다. 화면 구조를 ${dump} 에 남겼습니다.`
      : '제목 칸에 커서를 올리지 못했습니다.');
    throw new Error('title-focus-failed');
  }
  log(`제목 칸을 찾았습니다. (${found.selector} / ${how})`);

  await enterTitle(page, title);

  // 제목이 실제로 들어갔는지 제목 칸의 글자를 읽어 확인합니다. 안 들어갔으면 한 번 더 시도합니다.
  if ((await readTitleText(frame)).includes(sample)) {
    return;
  }
  log('제목이 들어가지 않아 다시 시도합니다.');
  await dismissPopups(page);
  await focusTitleBox(frame, found);
  await enterTitle(page, title);
  if ((await readTitleText(frame)).includes(sample)) {
    return;
  }
  const dump = await dumpEditorDom(page, frame, 'title-input-failed');
  log(dump
    ? `제목 칸을 눌렀지만 글자가 들어가지 않았습니다. 화면 구조를 ${dump} 에 남겼습니다.`
    : '제목 칸을 눌렀지만 글자가 들어가지 않았습니다.');
  throw new Error('title-input-failed');
};

// ===== 인용구(소제목) =====
// 소제목을 네이버 에디터의 인용구 상자로 넣습니다. 인용구 버튼을 못 찾거나 상자에서 빠져나오지
// 못하면 그 뒤로는 인용구를 쓰지 않고 소제목 글자(19px 네이비)로 넣습니다.
// .env 에 QUOTE_HEADINGS=off 를 넣으면 처음부터 인용구를 쓰지 않습니다.
const QUOTE_BUTTONS = [
  'button.se-insert-quotation-default-toolbar-button',
  'button[data-name="quotation"]',
  'button[aria-label*="인용구"]',
  'button[title*="인용구"]',
];
const QUOTE_COMPONENT = '.se-component.se-quotation';

// 인용구 모양. 기본은 왼쪽 세로선 + 회색 글씨(quotation_line)입니다. .env 의 QUOTE_STYLE 로 바꿉니다.
// (default = 큰따옴표, quotation_line = 세로선, quotation_bubble = 말풍선, quotation_underline = 밑줄,
//  quotation_postit = 포스트잇, quotation_corner = 프레임)
const QUOTE_STYLE = String(process.env.QUOTE_STYLE || 'quotation_line').trim();
const QUOTE_STYLE_NAMES = {
  quotation_line: '세로선', quotation_bubble: '말풍선', quotation_underline: '밑줄', quotation_postit: '포스트잇', quotation_corner: '프레임',
};
const quoteStyleButtons = (style) => [
  `button[data-value="${style}"]`,
  `button.se-toolbar-option-insert-quotation-${style}-button`,
  `button[class*="${style}"]`,
  ...(QUOTE_STYLE_NAMES[style] ? [`button[aria-label*="${QUOTE_STYLE_NAMES[style]}"]`, `button[title*="${QUOTE_STYLE_NAMES[style]}"]`] : []),
];
// 인용구 버튼 옆의 모양 고르기(▼) 버튼입니다. 정렬 버튼이 "정렬 열기" 인 것처럼 "인용구 열기" 로 보입니다.
const QUOTE_STYLE_TOGGLE = [
  'button.se-document-toolbar-select-option-button[data-name="quotation"]',
  'button[data-name="quotation"][class*="select-option"]',
  'button[class*="quotation"][class*="select-option"]',
  'button[aria-label*="인용구 열기"]',
  'button[title*="인용구 열기"]',
  'button[aria-label*="인용구 선택"]',
];

const quoteState = {
  disabled: String(process.env.QUOTE_HEADINGS || 'on').toLowerCase() === 'off',
  styleWarned: false,
  exitFails: 0, // 인용구에서 못 빠져나온 횟수. 두 번째부터 일반 글자 소제목으로 바꿉니다.
};

// 원하는 모양의 인용구를 넣습니다. 모양 메뉴를 못 찾으면 기본 인용구 버튼을 누릅니다.
// 돌려주는 값: 'styled' = 원하는 모양, 'plain' = 기본 모양, null = 못 넣음
const clickQuote = async (page, frame) => {
  if (QUOTE_STYLE !== 'default') {
    if (await clickSelector(frame, quoteStyleButtons(QUOTE_STYLE))) {
      return 'styled';
    }
    if (await clickSelector(frame, QUOTE_STYLE_TOGGLE)) {
      await page.waitForTimeout(250);
      if (await clickSelector(frame, quoteStyleButtons(QUOTE_STYLE))) {
        return 'styled';
      }
      await page.keyboard.press('Escape').catch(noop);
    }
  }
  if (await clickSelector(frame, QUOTE_BUTTONS) || await clickSelector(page, QUOTE_BUTTONS)) {
    return QUOTE_STYLE === 'default' ? 'styled' : 'plain';
  }
  return null;
};

// 인용구 버튼을 못 찾았을 때 도구 모음 버튼 목록을 파일로 남깁니다. 다음 수정의 증거로 씁니다.
const dumpToolbar = async (frame, reason) => {
  const buttons = await frame.evaluate(() => [...document.querySelectorAll('button')].map((node) => ({
    className: String(node.className || '').slice(0, 120),
    dataName: node.getAttribute('data-name') || '',
    dataValue: node.getAttribute('data-value') || '',
    dataLog: node.getAttribute('data-log') || '',
    label: (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim().slice(0, 30),
    visible: Boolean(node.offsetWidth || node.offsetHeight),
  })).filter((item) => item.className || item.dataName || item.label)).catch(() => []);
  // 색상표 칸은 button 이 아닐 수 있어, 클래스에 color·palette 가 들어간 보이는 요소도 따로 남깁니다.
  const colorItems = await frame.evaluate(() => [...document.querySelectorAll('[class*="color"], [class*="palette"]')]
    .filter((node) => node.offsetWidth || node.offsetHeight)
    .slice(0, 80)
    .map((node) => ({
      tag: node.tagName.toLowerCase(),
      className: String(node.className || '').slice(0, 120),
      data: [...node.attributes].filter((attr) => attr.name.startsWith('data-') || attr.name === 'aria-label' || attr.name === 'title')
        .map((attr) => `${attr.name}=${attr.value}`).join(' ').slice(0, 120),
      bg: window.getComputedStyle(node).backgroundColor,
    }))).catch(() => []);
  // 열려 있는 메뉴·색상표(layer, picker, palette, list)의 구조도 남깁니다.
  const layers = await frame.evaluate(() => [...document.querySelectorAll('[class*="layer"], [class*="picker"], [class*="palette"], [class*="option-list"], [role="listbox"]')]
    .filter((node) => (node.offsetWidth || node.offsetHeight) && node.querySelectorAll('button, li').length >= 3)
    .slice(0, 6)
    .map((node) => node.outerHTML.replace(/\s+/g, ' ').slice(0, 4000))).catch(() => []);
  const file = path.join(PATHS.logs, `naver-toolbar-${Date.now()}.json`);
  try {
    fs.mkdirSync(PATHS.logs, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ reason, when: new Date().toISOString(), buttons, colorItems, layers }, null, 2), 'utf8');
    return file;
  } catch (error) {
    return null;
  }
};

// 인용구를 빠져나오지 못했을 때, 인용구 상자와 앞뒤 구성 요소의 구조를 남깁니다.
const dumpQuoteArea = async (frame, reason, selector = QUOTE_COMPONENT, prefix = 'naver-quote') => {
  const area = await frame.evaluate((quoteSelector) => {
    const quotes = [...document.querySelectorAll(quoteSelector)];
    const quote = quotes[quotes.length - 1];
    const brief = (node) => (node ? node.outerHTML.replace(/\s+/g, ' ').slice(0, 3000) : null);
    return {
      quote: brief(quote),
      previous: brief(quote?.previousElementSibling),
      next: brief(quote?.nextElementSibling),
      activeElement: document.activeElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : null,
    };
  }, selector).catch((error) => ({ error: error.message }));
  const toolbarFile = await dumpToolbar(frame, reason);
  const file = path.join(PATHS.logs, `${prefix}-${Date.now()}.json`);
  try {
    fs.mkdirSync(PATHS.logs, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ reason, when: new Date().toISOString(), toolbarFile, ...area }, null, 2), 'utf8');
    return file;
  } catch (error) {
    return toolbarFile;
  }
};

// 인용구 위 빈 줄을 block.gapAbove 개(소제목 위 1개, 스티커 바로 아래면 0개)만 남기고, 다시 인용구 아래로 갑니다.
// 인용구를 넣으려고 미리 만든 빈 문단들이 실제 에디터에서는 모두 인용구 위에 남았습니다(2026-10-03 실제 기록·사용자 그림).
const fixGapAboveQuote = async (page, frame, block) => {
  if (!Number.isInteger(block.gapAbove)) {
    return;
  }
  // 지운 뒤나 지우다 되돌린 뒤 모두 커서가 인용구 위에 있을 수 있어, 늘 인용구 아래로 다시 갑니다.
  await closeGapAbove(page, frame, QUOTE_COMPONENT, block.gapAbove);
  await moveBelowLast(page, frame, QUOTE_COMPONENT);
};

const insertQuote = async (page, frame, block, log = noop) => {
  if (quoteState.disabled) {
    return false;
  }
  const before = await frame.locator(QUOTE_COMPONENT).count().catch(() => 0);
  // 앞 단계(서식 메뉴)에서 커서가 본문을 벗어났을 수 있어 본문 끝으로 되돌린 뒤 시작합니다.
  // (2026-10-03 기록: 메뉴를 여닫다 커서를 잃은 채 인용구를 넣어 빠져나오지 못했음)
  await backToText(page, frame);
  // 인용구를 넣기 전에 아래쪽에 빈 문단을 하나 만들어 둡니다(Enter 후 위로 한 칸).
  // 인용구가 글의 맨 끝이면 아래로 나갈 곳이 없고, 아래 화살표는 인용구의 "출처" 칸으로 들어가
  // 상자를 빠져나오지 못했습니다. 아래에 문단이 있으면 그 문단을 직접 눌러 확실히 나올 수 있습니다.
  // 빈 문단을 두 개 만들어 둡니다. 네이버가 인용구를 넣으며 하나를 먹어도 빠져나올 자리가 남습니다(남는 것은 나온 뒤 closeGapBelow 가 지움).
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  const clicked = await clickQuote(page, frame);
  await page.waitForTimeout(600);
  const after = await frame.locator(QUOTE_COMPONENT).count().catch(() => 0);
  if (!clicked || after <= before) {
    quoteState.disabled = true;
    const dump = await dumpToolbar(frame, clicked ? 'quote-not-inserted' : 'quote-button-not-found');
    log(`인용구 버튼을 찾지 못해 소제목을 일반 글자로 넣습니다.${dump ? ` (도구 모음 기록: ${dump})` : ''}`);
    return false;
  }
  // 원하는 모양이 들어갔는지 새 인용구의 클래스(se-l-quotation_line 등)로 확인합니다.
  if (QUOTE_STYLE !== 'default' && !quoteState.styleWarned) {
    const className = await frame.locator(QUOTE_COMPONENT).last().getAttribute('class').catch(() => '');
    if (clicked === 'plain' || !String(className).includes(QUOTE_STYLE)) {
      quoteState.styleWarned = true;
      const dump = await dumpToolbar(frame, 'quote-style-not-found');
      log(`${QUOTE_STYLE_NAMES[QUOTE_STYLE] || QUOTE_STYLE} 모양 인용구를 고르지 못해 기본 인용구로 넣습니다.${dump ? ` (도구 모음 기록: ${dump})` : ''}`);
    }
  }

  await page.keyboard.type(block.text, { delay: TYPE_DELAY });
  await page.waitForTimeout(200);

  // 인용구 상자 밖으로 나옵니다. 아래 방법을 차례로 써 보고 빠져나왔는지 확인합니다.
  const exits = [
    async () => {
      // 1순위: 방금 넣은 인용구 바로 다음 구성 요소의 본문 문단을 직접 누릅니다.
      const index = await frame.evaluate(({ quoteSelector, notBody }) => {
        const quotes = [...document.querySelectorAll(quoteSelector)];
        const quote = quotes[quotes.length - 1];
        let next = quote?.nextElementSibling;
        while (next && !next.matches('.se-component')) {
          next = next.nextElementSibling;
        }
        const target = next?.querySelector('.se-text-paragraph');
        if (!target || target.closest(notBody)) {
          return -1;
        }
        return [...document.querySelectorAll('.se-text-paragraph')].indexOf(target);
      }, { quoteSelector: QUOTE_COMPONENT, notBody: NOT_BODY }).catch(() => -1);
      if (index >= 0) {
        await frame.locator('.se-text-paragraph').nth(index).click({ timeout: 4000 });
      } else if (!await addBodyBelowLast(frame, QUOTE_COMPONENT)) {
        await page.keyboard.press('ArrowDown');
      }
    },
    async () => {
      // 인용구가 글 맨 끝이면 글 아래 "본문 추가" 단추로 새 문단을 만듭니다(실제 에디터에서 확인된 단추).
      if (!await addBodyBelowLast(frame, QUOTE_COMPONENT)) {
        await page.keyboard.press('ArrowDown');
      }
    },
    async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('ArrowDown');
    },
    async () => {
      // 마지막 구성 요소 바로 아래 빈 곳을 누르면 새 문단이 생깁니다.
      const box = await frame.locator('.se-component').last().boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + Math.min(40, box.width / 2), box.y + box.height + 24);
      }
    },
  ];
  // 빠져나왔는지는 표시 글자(‸)를 하나 쳐 보고, 그 글자가 인용구 상자 안에 들어갔는지로 판단합니다.
  // 입력칸이 iframe 에 있어 커서 위치를 직접 읽을 수 없기 때문입니다. 확인 뒤 표시 글자는 지웁니다.
  const PROBE = '‸';
  const quoteText = () => frame.locator(QUOTE_COMPONENT).last().textContent().catch(() => '');
  for (let index = 0; index < exits.length; index += 1) {
    await exits[index]().catch(noop);
    await page.waitForTimeout(250);
    await page.keyboard.type(PROBE);
    await page.waitForTimeout(150);
    const inside = (await quoteText()).includes(PROBE);
    // 표시 글자가 어디에도 안 보이면 입력할 곳을 잃은 것입니다(빈 곳을 눌러 커서가 사라진 경우).
    const landed = await frame.evaluate((probe) => document.body.innerText.includes(probe), PROBE).catch(() => false);
    if (landed) {
      await page.keyboard.press('Backspace');
    }
    if (landed && !inside) {
      // 인용구와 다음 글(사진) 사이에 빈 문단이 남지 않게 정리합니다. ("소제목 바로 아래 사진" — 사용자 요청)
      await closeGapBelow(page, frame, QUOTE_COMPONENT);
      await fixGapAboveQuote(page, frame, block);
      return true;
    }
  }
  // 마지막으로 사진·스티커와 같은 방법(아래 문단 클릭 → 본문 추가 단추 → 아래 빈 곳 클릭 → ↓, 표시 글자로 확인)을 써 봅니다.
  if (await moveBelowLast(page, frame, QUOTE_COMPONENT)) {
    await fixGapAboveQuote(page, frame, block);
    return true;
  }
  // 한 번 실패했다고 뒤의 소제목·"결론"까지 모두 일반 글자로 바꾸지 않습니다. 두 번째 실패부터 바꿉니다.
  // (2026-10-03: 한 번 실패한 뒤 "결론"이 인용구가 아닌 파란 글자로 들어갔음)
  quoteState.exitFails += 1;
  quoteState.disabled = quoteState.exitFails >= 2;
  // 다음 수정의 증거로 인용구 상자와 그 주변 구조, 도구 모음을 남깁니다.
  const dump = await dumpQuoteArea(frame, 'quote-exit-failed');
  // 커서를 본문으로 되돌립니다. 본문 마지막 글 문단은 인용구 "위"에 있어 그리로 가면 소제목 본문이 인용구 위에 들어가므로
  // (2026-10-03 사용자 그림: 인용구 두 개가 연달아 붙음), 글 끝이 인용구면 인용구 아래로 갑니다(backToText).
  await backToText(page, frame);
  log(`인용구 상자에서 빠져나오지 못했습니다.${quoteState.disabled ? ' 다음 소제목부터는 일반 글자로 넣습니다.' : ' 다음 소제목은 다시 인용구로 시도합니다.'} 이 소제목 아래 본문이 인용구 안에 들어갔는지 확인해 주시기 바랍니다.${dump ? ` (인용구 구조 기록: ${dump})` : ''}`);
  return true;
};

// 버튼이 화면에 보이는지만 확인합니다(누르지 않음).
const hasVisible = async (scope, selectors) => {
  for (let index = 0; index < selectors.length; index += 1) {
    const target = scope.locator(selectors[index]).first();
    if (await target.count().catch(() => 0) && await target.isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
};

// 사진·스티커를 넣기 전에 아래쪽에 빈 문단을 하나 만들어 둡니다(Enter 후 위로 한 칸).
// 그림 요소가 글 맨 끝에 붙으면 아래로 나갈 문단이 없어, 아래 빈 곳을 눌러도 커서가 사진 설명칸이나
// 요소 자체로 가곤 했습니다(실제 오류 2026-10-02 22:38 — 스티커 다음 첫 줄 누락 + 글자 크기 버튼 없음).
// 인용구에서 효과가 확인된 방법과 같습니다.
const makeRoomBelow = async (page) => {
  await page.keyboard.press('Enter').catch(noop);
  await page.keyboard.press('ArrowUp').catch(noop);
};

const IMAGE_PARTS = '.se-module-image, .se-image-container';
const IMAGE_BUTTONS = ['button.se-image-toolbar-button', 'button[data-name="image"]', 'button[aria-label*="사진"]'];

const insertImage = async (page, frame, block, log = noop) => {
  await focusBodyEnd(frame);
  if (await hasVisible(frame, IMAGE_BUTTONS) || await hasVisible(page, IMAGE_BUTTONS.slice(0, 2))) {
    await makeRoomBelow(page);
  }
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 });
  const opened = await clickSelector(frame, IMAGE_BUTTONS) || await clickSelector(page, IMAGE_BUTTONS.slice(0, 2));
  if (!opened) {
    log('사진 버튼을 찾지 못해 이미지 한 장을 건너뛰었습니다.');
    return false;
  }
  const chooser = await chooserPromise.catch(() => null);
  if (!chooser) {
    log('사진 선택창이 열리지 않아 이미지 한 장을 건너뛰었습니다.');
    await page.keyboard.press('Escape').catch(noop);
    return false;
  }
  await chooser.setFiles(block.filePath);
  await frame.locator('.se-image-container, .se-module-image').last().waitFor({ timeout: 30000 }).catch(noop);
  await page.waitForTimeout(900);
  // 사진 설명란이 열려 있으면 캡션을 적습니다.
  if (block.caption) {
    const caption = frame.locator('.se-caption-input, .se-caption [contenteditable="true"]').last();
    if (await caption.count().catch(() => 0) && await caption.isVisible().catch(() => false)) {
      await caption.click({ timeout: 3000 }).catch(noop);
      await page.keyboard.type(block.caption, { delay: TYPE_DELAY }).catch(noop);
    }
  }
  // 인용구 소제목 바로 아래 사진은 사이에 남은 빈 문단을 지워 붙입니다.
  if (block.tightAbove) {
    await closeGapAbove(page, frame, IMAGE_PARTS);
  }
  if (!await moveBelowLast(page, frame, IMAGE_PARTS)) {
    // 예전 방식으로라도 본문 끝에 커서를 둡니다. 뒤에서 본문 줄이 빠지면 다시 입력하며 알립니다.
    await focusBodyEnd(frame);
    await page.keyboard.press('Enter').catch(noop);
    if (!imageState.warned) {
      imageState.warned = true;
      const dump = await dumpEditorDom(page, frame, 'image-exit-failed');
      log(`사진 아래로 커서를 옮기지 못했습니다. 사진 설명칸이나 사진 위에 본문이 들어갔는지 확인해 주시기 바랍니다.${dump ? ` (구조 기록: ${dump})` : ''}`);
    }
  } else if (block.tightAbove && await closeGapAbove(page, frame, IMAGE_PARTS)) {
    // 사진 아래로 나가는 동안 네이버가 인용구와 사진 사이에 빈 문단을 다시 만들었으면 한 번 더 지우고 사진 아래로 돌아갑니다.
    await moveBelowLast(page, frame, IMAGE_PARTS);
  }
  return true;
};

const imageState = { warned: false };

// 표시 글자(‸)를 쳐서 커서가 selector 요소(의 마지막) 아래 본문 문단에 있는지 확인하고 지웁니다.
// gap = 요소와 커서 문단 사이의 빈 문단 수, tail = 커서 문단 바로 뒤에 이어진 빈 문단 수.
const probeBelow = async (page, frame, selector) => {
  const PROBE = '‸';
  await page.keyboard.type(PROBE);
  await page.waitForTimeout(150);
  const where = await frame.evaluate(({ probe, target, notBody }) => {
    const holder = [...document.querySelectorAll('.se-text-paragraph')].find((node) => node.textContent.includes(probe));
    if (!holder) {
      return { kind: document.body.innerText.includes(probe) ? 'elsewhere' : 'none' };
    }
    const found = [...document.querySelectorAll(target)];
    const last = found[found.length - 1];
    const below = !last || Boolean(last.compareDocumentPosition(holder) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (holder.closest(notBody) || !below) {
      return { kind: 'wrong' };
    }
    const isEmptyText = (node) => node.matches('.se-component') && node.querySelector('.se-text-paragraph')
      && !node.querySelector(notBody) && !node.textContent.replace(/[\s​]/g, '');
    const own = holder.closest('.se-component');
    const anchor = last?.closest('.se-component');
    let gap = 0;
    for (let node = anchor?.nextElementSibling; node && node !== own; node = node.nextElementSibling) {
      gap += isEmptyText(node) ? 1 : 0;
    }
    let tail = 0;
    for (let node = own?.nextElementSibling; node && isEmptyText(node); node = node.nextElementSibling) {
      tail += 1;
    }
    return { kind: 'body', gap, tail };
  }, { probe: PROBE, target: selector, notBody: NOT_BODY }).catch(() => ({ kind: 'none' }));
  if (where.kind !== 'none') {
    await page.keyboard.press('Backspace');
  }
  return where;
};

// 요소와 커서 사이에 빈 문단이 남았으면(네이버가 요소 뒤에 빈 문단을 따로 만든 경우) 그 첫 빈 문단까지 올라가고,
// 뒤에 남은 빈 문단은 지웁니다. 스티커와 초록 제목 사이, 인용구 소제목과 사진 사이에 빈 줄이 생기던 문제(2026-10-03 사용자 그림)입니다.
// where 를 안 주면 먼저 확인합니다.
const closeGapBelow = async (page, frame, selector, where = null) => {
  const spot = where || await probeBelow(page, frame, selector);
  if (spot.kind !== 'body' || (spot.gap === 0 && spot.tail === 0)) {
    return;
  }
  // 요소 바로 아래 첫 빈 문단을 직접 누릅니다. 예전엔 ↑ 로 올라갔는데, ↑ 가 사진을 건너뛰어 사진 "위" 글 줄로 가서
  // Delete 가 위 두 줄을 합쳤습니다("재쁜이 아빠육아박사", 2026-10-03 사용자 그림 — 인사말 줄바꿈이 사라지고 빈 줄은 남음).
  const first = await frame.evaluate(({ target, notBody }) => {
    const found = [...document.querySelectorAll(target)];
    const anchor = found[found.length - 1]?.closest('.se-component');
    for (let node = anchor?.nextElementSibling; node; node = node.nextElementSibling) {
      const paragraph = node.matches('.se-component') && !node.querySelector(notBody) && node.querySelector('.se-text-paragraph');
      if (paragraph) {
        return [...document.querySelectorAll('.se-text-paragraph')].indexOf(paragraph);
      }
    }
    return -1;
  }, { target: selector, notBody: NOT_BODY }).catch(() => -1);
  if (first < 0) {
    return;
  }
  await frame.locator('.se-text-paragraph').nth(first).click({ timeout: 3000 }).catch(noop);
  const landed = await frame.evaluate((index) => {
    const node = window.getSelection()?.anchorNode;
    const own = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.se-text-paragraph');
    return [...document.querySelectorAll('.se-text-paragraph')].indexOf(own) === index;
  }, first).catch(() => false);
  if (!landed) {
    if (selector === IMAGE_PARTS) {
      // 사진은 ↑ 가 사진을 건너뛰어 위 글 줄을 합칠 수 있어 그대로 둡니다.
      return;
    }
    for (let step = 0; step < Math.min(spot.gap, 3); step += 1) {
      await page.keyboard.press('ArrowUp');
    }
  }
  await page.keyboard.press('End');
  for (let step = 0; step < Math.min(spot.gap + spot.tail, 4); step += 1) {
    await page.keyboard.press('Delete');
  }
  await page.waitForTimeout(150);
  await probeBelow(page, frame, selector);
};

// 마지막 selector 요소 바로 위에 붙은 빈 문단을 지웁니다. 글 줄·인용구 다음 빈 문단 위에 네이버가 스티커·사진을
// (그 문단을 쓰지 않고) 아래에 넣어, 강조 문장과 서론 끝 스티커 사이, 인용구 소제목과 사진 사이가 벌어졌습니다(2026-10-03 사용자 그림).
// 빈 문단 위가 글 문단이나 인용구일 때만 그 빈 문단에서 Backspace 를 누릅니다(위가 사진·스티커면 그 요소가 지워질 수 있어 건드리지 않음).
// 누른 뒤 구성 요소 목록을 비교해 빈 문단 하나만 사라진 게 아니면(인용구가 지워지거나 합쳐짐 등) 되돌리고 멈춥니다.
const closeGapAbove = async (page, frame, selector, keep = 0) => {
  const snapshot = () => frame.evaluate(({ target, notBody, quote, keepCount }) => {
    const found = [...document.querySelectorAll(target)];
    const component = found[found.length - 1]?.closest('.se-component');
    const isEmptyText = (node) => node?.matches('.se-component') && node.querySelector('.se-text-paragraph') && !node.querySelector(notBody)
      && !node.textContent.replace(/[\s​]/g, '');
    const isText = (node) => node?.matches('.se-component') && node.querySelector('.se-text-paragraph') && !node.querySelector(notBody);
    const above = component?.previousElementSibling;
    const parts = [...document.querySelectorAll('.se-component')].map((node) => `${node.className}|${node.querySelectorAll('.se-text-paragraph').length}|${node.textContent.replace(/[\s​]/g, '')}`);
    // 요소 바로 위에 이어진 빈 문단 수를 셉니다(여러 구성 요소·한 요소 안 여러 문단 모두). keep 개까지는 남깁니다.
    const blank = (p) => !p.textContent.replace(/[\s​]/g, '');
    let run = 0;
    for (let node = above; node && isText(node); node = node.previousElementSibling) {
      const list = [...node.querySelectorAll('.se-text-paragraph')].reverse();
      const empties = list.findIndex((p) => !blank(p));
      run += empties < 0 ? list.length : empties;
      if (empties >= 0) {
        break;
      }
    }
    // 글 구성 요소 안의 마지막 문단이 빈 경우(여러 문단을 한 요소에 담는 경우)도 봅니다.
    let index = -1;
    if (above && isText(above) && run > keepCount) {
      const paragraphs = [...above.querySelectorAll('.se-text-paragraph')];
      const last = paragraphs[paragraphs.length - 1];
      const before = above.previousElementSibling;
      if (!last.textContent.replace(/[\s​]/g, '') && (paragraphs.length > 1 || isText(before) || before?.matches(quote))) {
        index = [...document.querySelectorAll('.se-text-paragraph')].indexOf(last);
      }
    }
    return { index, parts, whole: isEmptyText(above) ? found.length && [...document.querySelectorAll('.se-component')].indexOf(above) : -1 };
  }, { target: selector, notBody: NOT_BODY, quote: QUOTE_COMPONENT, keepCount: keep }).catch(() => ({ index: -1, parts: [], whole: -1 }));
  for (let step = 0; step < 4; step += 1) {
    const before = await snapshot();
    if (before.index < 0) {
      return step > 0;
    }
    // 빈 구성 요소 하나가 통째로 빠졌거나, 같은 요소에서 빈 문단 하나만 줄었으면 정상입니다.
    const expected = before.whole >= 0 ? before.parts.filter((_, i) => i !== before.whole) : null;
    const same = (a, b) => a.length === b.length && a.every((part, i) => part === b[i]);
    const textOf = (parts) => parts.map((part) => part.split('|').slice(2).join('|')).join('');
    // Backspace 가 안 먹으면(인용구 바로 아래 빈 문단에서 Backspace 는 인용구 쪽을 건드려 되돌려짐) Delete 로 한 번 더 해 봅니다.
    // 2026-10-04 사용자 그림: 인용구 소제목과 사진 사이 빈 줄이 그대로 남음.
    let ok = false;
    for (const key of ['Backspace', 'Delete']) {
      await frame.locator('.se-text-paragraph').nth(before.index).click({ timeout: 4000 }).catch(noop);
      await page.keyboard.press(key === 'Backspace' ? 'End' : 'Home');
      await page.keyboard.press(key);
      await page.waitForTimeout(200);
      const after = await snapshot();
      // 아무것도 안 바뀌었으면 성공이 아닙니다(예전엔 이것도 성공으로 봐 빈 줄이 남았습니다).
      ok = !same(after.parts, before.parts) && (expected ? same(after.parts, expected) : (after.parts.length === before.parts.length && textOf(after.parts) === textOf(before.parts)));
      if (ok) {
        break;
      }
      if (!same(after.parts, before.parts)) {
        await page.keyboard.press('Control+Z');
        await page.waitForTimeout(200);
      }
    }
    if (!ok) {
      return false;
    }
  }
  return true;
};

// 마지막 사진(또는 스티커) 바로 아래 본문 문단으로 커서를 옮깁니다. selector 는 그 요소(의 일부)를 고르는 선택자입니다.
// 사진이 글 맨 끝에 붙으면 그 아래에 문단이 없어, Ctrl+End 가 사진 설명칸으로 들어가
// 다음 본문 줄이 설명칸에 쳐졌습니다(실제 오류 "본문 한 줄이 들어가지 않아 다시 입력합니다").
// 아래 방법을 차례로 써 보고, 표시 글자(‸)가 그 요소 아래 본문 문단에 찍혔는지로 확인합니다.
const moveBelowLast = async (page, frame, selector) => {
  const componentOf = () => frame.locator(selector).last().locator('xpath=ancestor-or-self::*[contains(@class,"se-component")][1]');
  const clickBelow = async (gap) => {
    const box = await componentOf().boundingBox().catch(() => null);
    if (!box) {
      return false;
    }
    await page.mouse.click(box.x + Math.min(40, box.width / 2), box.y + box.height + gap);
    return true;
  };
  const exits = [
    async () => {
      // 1순위: 바로 다음 구성 요소의 본문 문단을 직접 누릅니다. (미리 만들어 둔 빈 문단)
      const index = await frame.evaluate(({ target, notBody }) => {
        const found = [...document.querySelectorAll(target)];
        const component = found[found.length - 1]?.closest('.se-component');
        let next = component?.nextElementSibling;
        while (next && !next.matches('.se-component')) {
          next = next.nextElementSibling;
        }
        const paragraph = next?.querySelector('.se-text-paragraph');
        if (!paragraph || paragraph.closest(notBody)) {
          return -1;
        }
        return [...document.querySelectorAll('.se-text-paragraph')].indexOf(paragraph);
      }, { target: selector, notBody: NOT_BODY }).catch(() => -1);
      if (index < 0) {
        return false;
      }
      await frame.locator('.se-text-paragraph').nth(index).click({ timeout: 4000 });
      await page.keyboard.press('End');
      return true;
    },
    // 요소가 글 맨 끝이면 글 아래 "본문 추가" 단추로 새 문단을 만듭니다.
    () => addBodyBelowLast(frame, selector),
    // 바로 아래 빈 곳을 누르면 새 문단이 생깁니다.
    () => clickBelow(24),
    async () => {
      // 요소가 선택된 상태면 선택을 풀고 조금 더 아래를 누릅니다.
      await page.keyboard.press('Escape');
      return clickBelow(60);
    },
    async () => {
      // 설명칸에서 아래 화살표로 나옵니다.
      await page.keyboard.press('ArrowDown');
      return true;
    },
  ];
  for (let index = 0; index < exits.length; index += 1) {
    if (!await exits[index]().catch(() => false)) {
      continue;
    }
    await page.waitForTimeout(250);
    const where = await probeBelow(page, frame, selector);
    if (where.kind !== 'body') {
      continue;
    }
    await closeGapBelow(page, frame, selector, where);
    return true;
  }
  return false;
};

// 스티커는 스티커 창(오른쪽 옆 창)에서 고릅니다. 스티커는 그림이라 이름으로 고를 수 없어,
// 창 위쪽 묶음 단추를 왼쪽부터 센 순서(block.pack)와 목록의 줄·칸(block.row, block.column)으로 고릅니다.
// 줄·칸은 화면에 보이는 위치로 셉니다. 실패하면 스티커를 건너뛰고 창 구조를 naver-sticker-*.json 에 남깁니다.
const STICKER_BUTTONS = [
  'button.se-sticker-toolbar-button',
  'button[data-name="sticker"]',
  'button[aria-label*="스티커"]',
  'button[title*="스티커"]',
];
const STICKER_COMPONENT = '.se-component[class*="sticker"]';
const stickerState = { failed: false, exitWarned: false };

// 스티커 창에서 묶음 단추(tab)나 스티커(item)를 찾아 data-auto-pick 표시를 붙입니다. 못 찾으면 이유를 돌려줍니다.
const markStickerTarget = (scope, want) => scope.evaluate(({ kind, pack, row, column }) => {
  document.querySelectorAll('[data-auto-pick]').forEach((node) => node.removeAttribute('data-auto-pick'));
  const visible = (node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && window.getComputedStyle(node).visibility !== 'hidden';
  };
  const pictures = (node) => node.querySelectorAll('img, svg, [style*="background-image"]').length;
  // 스티커 창: 클래스에 sticker 가 들어간 보이는 요소 중 그림이 가장 많이 든 것(같으면 더 작은 것)
  const panels = [...document.querySelectorAll('[class*="sticker" i]')]
    .filter((node) => visible(node) && !node.closest('.se-component') && !node.matches('button') && pictures(node) >= 4)
    .sort((a, b) => pictures(b) - pictures(a)
      || (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight));
  const panel = panels[0];
  if (!panel) {
    return { ok: false, reason: 'panel-not-found' };
  }
  const clickable = [...panel.querySelectorAll('button, a, li, [role="tab"], [role="button"]')]
    .filter((node) => visible(node) && !node.querySelector('button, a, li, [role="tab"], [role="button"]'));
  const groupRows = (nodes) => {
    const rows = [];
    nodes.map((node) => ({ node, box: node.getBoundingClientRect() }))
      .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)
      .forEach((item) => {
        const last = rows[rows.length - 1];
        if (last && Math.abs(last[0].box.top - item.box.top) < Math.max(10, item.box.height / 2)) {
          last.push(item);
        } else {
          rows.push([item]);
        }
      });
    return rows.map((items) => items.sort((a, b) => a.box.left - b.box.left));
  };
  // 묶음 단추 줄: 창 안에서 가장 위에 있는, 단추가 3개 이상 가로로 늘어선 줄
  const rows = groupRows(clickable);
  const tabRow = rows.find((items) => items.length >= 3);
  if (!tabRow) {
    return { ok: false, reason: 'pack-tabs-not-found' };
  }
  if (kind === 'tab') {
    // 좌우 넘기기 화살표(그림 없는 작은 단추)는 묶음이 아니므로 뺍니다.
    const arrow = /prev|next|arrow|scroll|이전|다음/i;
    const tabs = tabRow.filter((item) => !arrow.test(`${item.node.className} ${item.node.getAttribute('aria-label') || ''} ${item.node.title || ''}`)
      && (pictures(item.node) > 0 || item.node.textContent.trim().length > 1));
    const target = tabs[pack - 1];
    if (!target) {
      return { ok: false, reason: 'pack-out-of-range', count: tabs.length };
    }
    target.node.setAttribute('data-auto-pick', 'sticker');
    return { ok: true, count: tabs.length };
  }
  // 스티커 목록: 묶음 단추 줄보다 아래에 있는, 그림이 든 단추들
  const tabBottom = Math.max(...tabRow.map((item) => item.box.bottom));
  const items = clickable.filter((node) => pictures(node) > 0 && node.getBoundingClientRect().top >= tabBottom - 2);
  const grid = groupRows(items);
  const target = grid[row - 1]?.[column - 1];
  if (!target) {
    return { ok: false, reason: 'sticker-out-of-range', rows: grid.length, columns: grid[row - 1]?.length || 0 };
  }
  target.node.setAttribute('data-auto-pick', 'sticker');
  return { ok: true };
}, want);

// 스티커 창 구조를 남깁니다. 다음 수정의 증거로 씁니다.
const dumpStickerPanel = async (frame, reason, detail) => {
  const panels = await frame.evaluate(() => [...document.querySelectorAll('[class*="sticker" i]')]
    .filter((node) => node.offsetWidth || node.offsetHeight)
    .slice(0, 5)
    .map((node) => node.outerHTML.replace(/\s+/g, ' ').slice(0, 6000))).catch(() => []);
  const toolbarFile = await dumpToolbar(frame, reason);
  const file = path.join(PATHS.logs, `naver-sticker-${Date.now()}.json`);
  try {
    fs.mkdirSync(PATHS.logs, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ reason, detail, when: new Date().toISOString(), toolbarFile, panels }, null, 2), 'utf8');
    return file;
  } catch (error) {
    return toolbarFile;
  }
};

const insertSticker = async (page, frame, block, log = noop) => {
  if (stickerState.failed) {
    return false;
  }
  const fail = async (reason, detail) => {
    stickerState.failed = true;
    const dump = await dumpStickerPanel(frame, reason, detail);
    const why = {
      'button-not-found': '스티커 버튼을 찾지 못했습니다',
      'panel-not-found': '스티커 버튼은 눌렀지만 스티커 창을 찾지 못했습니다',
      'pack-tabs-not-found': '스티커 창에서 묶음 단추를 찾지 못했습니다',
      'pack-out-of-range': `스티커 묶음 ${block.pack}번째가 없습니다`,
      'sticker-out-of-range': `스티커 ${block.row}줄 ${block.column}칸이 없습니다`,
      'not-inserted': '스티커를 눌렀지만 글에 들어가지 않았습니다',
    }[reason] || '스티커를 넣지 못했습니다';
    log(`${why}. 스티커 없이 계속 씁니다.${dump ? ` (스티커 창 기록: ${dump})` : ''}`);
    await page.keyboard.press('Escape').catch(noop);
    await focusBodyEnd(frame);
    return false;
  };

  const before = await frame.locator(STICKER_COMPONENT).count().catch(() => 0);
  if (await hasVisible(frame, STICKER_BUTTONS) || await hasVisible(page, STICKER_BUTTONS)) {
    await makeRoomBelow(page);
  }
  const opened = await clickSelector(frame, STICKER_BUTTONS) || await clickSelector(page, STICKER_BUTTONS);
  if (!opened) {
    return fail('button-not-found');
  }
  await page.waitForTimeout(800);
  // 스티커 창은 에디터 틀 안에 있을 수도, 바깥 화면에 있을 수도 있어 둘 다 찾아봅니다.
  const pick = async (want) => {
    for (const scope of frame === page.mainFrame() ? [frame] : [frame, page.mainFrame()]) {
      const marked = await markStickerTarget(scope, want).catch((error) => ({ ok: false, reason: 'panel-not-found', error: error.message }));
      if (marked.ok) {
        await scope.locator('[data-auto-pick="sticker"]').first().click({ timeout: 4000 });
        return marked;
      }
      if (marked.reason !== 'panel-not-found' || scope !== frame) {
        return marked;
      }
    }
    return { ok: false, reason: 'panel-not-found' };
  };
  // 묶음 단추는 한 화면에 일부만 보입니다. 13번째처럼 화면 밖이면 다음(›)을 눌러 그 묶음이 맨 오른쪽에 오게 합니다.
  let visiblePack = block.pack;
  const scopes = frame === page.mainFrame() ? [frame] : [frame, page.mainFrame()];
  let shown = 0;
  for (const scope of scopes) {
    const probe = await markStickerTarget(scope, { kind: 'tab', pack: 1 }).catch(() => null);
    shown = Math.max(shown, probe?.count || 0);
  }
  if (shown > 0 && block.pack > shown) {
    const clicks = block.pack - shown;
    for (let step = 0; step < clicks; step += 1) {
      let moved = false;
      for (const scope of scopes) {
        const next = scope.locator('button.se-sticker-next-button, button[class*="sticker-next"]').last();
        if (await next.count().catch(() => 0) && await next.isVisible().catch(() => false)) {
          const disabled = await next.evaluate((node) => node.disabled || node.getAttribute('aria-disabled') === 'true' || /disabled/.test(node.className)).catch(() => true);
          if (!disabled) {
            await next.click({ timeout: 2000 }).catch(() => {});
            moved = true;
            break;
          }
        }
      }
      if (!moved) {
        break;
      }
      await page.waitForTimeout(200);
    }
    visiblePack = shown;
  }
  const tab = await pick({ kind: 'tab', pack: visiblePack });
  if (!tab.ok) {
    return fail(tab.reason, tab);
  }
  await page.waitForTimeout(800);
  const item = await pick({ kind: 'item', row: block.row, column: block.column });
  if (!item.ok) {
    return fail(item.reason, item);
  }
  await page.waitForTimeout(800);
  const after = await frame.locator(STICKER_COMPONENT).count().catch(() => 0);
  if (after <= before) {
    return fail('not-inserted');
  }

  // 스티커 창을 닫습니다(열려 있으면 스티커 버튼을 다시 누르면 닫힙니다).
  const stillOpen = await markStickerTarget(frame, { kind: 'tab', pack: 1 }).then((marked) => marked.reason !== 'panel-not-found').catch(() => false);
  if (stillOpen) {
    await clickSelector(frame, STICKER_BUTTONS) || await clickSelector(page, STICKER_BUTTONS);
    await page.waitForTimeout(300);
  }

  // 위 글과의 간격을 정한 스티커는 사이 빈 문단을 block.gapAbove 개(없으면 0개)만 남기고 지웁니다.
  if (block.tightAbove) {
    await closeGapAbove(page, frame, STICKER_COMPONENT, block.gapAbove || 0);
  }

  // 다음 글이 스티커 아래에 오도록, 스티커 아래 본문 문단에 커서를 두고 실제로 그 자리인지 확인합니다.
  // (예전에는 아래 빈 곳을 한 번 누르고 확인하지 않아, 커서가 사진 설명칸이나 스티커에 남으면 다음 줄이 빠졌습니다)
  if (!await moveBelowLast(page, frame, STICKER_COMPONENT)) {
    await focusBodyEnd(frame);
    await page.keyboard.press('Enter').catch(noop);
    if (!stickerState.exitWarned) {
      stickerState.exitWarned = true;
      const dump = await dumpEditorDom(page, frame, 'sticker-exit-failed');
      log(`스티커 아래로 커서를 옮기지 못했습니다. 스티커 다음 글이 제자리에 들어갔는지 확인해 주시기 바랍니다.${dump ? ` (구조 기록: ${dump})` : ''}`);
    }
  }
  return true;
};

// 글의 맨 끝 구성 요소가 사진이나 스티커면 그 선택자를 돌려줍니다. 본문 마지막 문단은 그 위에 있어,
// 그리로 가면 글 순서가 뒤바뀌므로 이때는 moveBelowLast 로 요소 아래로 갑니다.
const lastComponentKind = (frame) => frame.evaluate(({ image, sticker, quote }) => {
  const components = [...document.querySelectorAll('.se-component')].filter((node) => !node.closest('.se-documentTitle') && !node.matches('.se-documentTitle'));
  const last = components[components.length - 1];
  if (!last) {
    return null;
  }
  if (last.querySelector(image)) {
    return image;
  }
  if (last.matches(quote)) {
    return quote;
  }
  return last.matches(sticker) ? sticker : null;
}, { image: IMAGE_PARTS, sticker: STICKER_COMPONENT, quote: QUOTE_COMPONENT }).catch(() => null);

// 서식 버튼(글자 크기 등)이 안 보이면 커서가 글 문단이 아닌 곳(사진·스티커 선택, 사진 설명칸)에 있는 것입니다.
// 커서를 본문 끝 글 문단으로 되돌립니다.
const backToText = async (page, frame) => {
  const lastPart = await lastComponentKind(frame);
  if (!(lastPart && await moveBelowLast(page, frame, lastPart))) {
    await focusBodyEnd(frame);
  }
};

// 목록 창이 열려 있거나, 키보드 초점이 본문 밖 단추(상단 "임시저장된 글 보기" 등)에 가 있는지 봅니다.
// 목록 창을 닫으면 초점이 그 창을 연 단추로 돌아가, 다음 Enter·띄어쓰기가 창을 다시 열었습니다(2026-10-23 실제 기록에서 닫혔다 다시 열림).
// 본문 입력칸(숨은 iframe·contenteditable)과 화면 몸통(BODY)은 정상으로 봅니다.
const focusState = (frame) => frame.evaluate((layer) => {
  const open = [...document.querySelectorAll(layer)].some((node) => [...node.querySelectorAll('*')]
    .some((child) => child.offsetWidth > 50 && child.offsetHeight > 50));
  const active = document.activeElement;
  const inLayer = Boolean(active?.closest?.(`${layer}, [data-focus-lock]`));
  const control = Boolean(active) && ['BUTTON', 'A', 'SELECT'].includes(active.tagName)
    || (active?.tagName === 'INPUT' && !active.closest('.se-component'));
  return { open, lost: inLayer || control, active: active ? `${active.tagName}.${String(active.className || '').slice(0, 60)}` : null };
}, LAYER_POPUP).catch(() => ({ open: false, lost: false, active: null }));

// 한 줄(사진·스티커·인용구 포함)을 넣기 전에 부릅니다. 목록 창은 닫고, 초점이 본문 밖이면 본문 끝으로 되돌립니다.
// focusGuard.warned 는 글마다 typeBlocks 가 비웁니다.
const focusGuard = { warned: false };
const keepFocusInBody = async (page, frame, log = noop) => {
  const state = await focusState(frame);
  if (!state.open && !state.lost) {
    return false;
  }
  let dump = null;
  if (!focusGuard.warned) {
    dump = await dumpEditorDom(page, frame, state.open ? 'layer-popup-open' : 'focus-outside-body');
  }
  if (state.open) {
    await dismissPopups(page);
    if ((await focusState(frame)).open) {
      await page.keyboard.press('Escape').catch(noop);
      await page.waitForTimeout(300);
    }
  }
  await backToText(page, frame);
  if (!focusGuard.warned) {
    focusGuard.warned = true;
    const what = state.open ? '네이버 "임시저장 글" 목록 창이 열려 있어(열려 있으면 글이 본문에 들어가지 않습니다) 닫고' : `키보드 초점이 본문 밖(${state.active})에 있어`;
    log(`${what} 본문으로 돌아와 이어서 씁니다. 자동 입력 중에는 브라우저 화면을 누르지 말아 주시기 바랍니다.${dump ? ` (구조 기록: ${dump})` : ''}`);
  }
  return true;
};

// 키스트로크 방식입니다. 서식을 먼저 켜고 글자를 입력한 뒤 서식을 끕니다.
const typeBlocks = async ({ page, frame, blocks, toolbar, log = noop, onProgress = noop }) => {
  let currentSize = null;
  let bold = false;
  let colored = false;
  const warned = { size: false, color: false, font: false };
  // 첫 문단과 이미지·인용구 바로 다음 문단은 정렬을 확인합니다. (Enter 로 만든 문단은 앞 문단 정렬을 이어받습니다)
  let checkAlign = true;
  let currentAlign = null;
  // 본문 줄이 빠진 기록입니다. title 은 본문 글이 제목 칸으로 들어간 흔적이 있었는지입니다.
  const missed = { count: 0, recovered: 0, lost: [], title: false, dumped: false };
  Object.assign(styleFix, { failed: {}, warned: {}, fixed: 0 });
  focusGuard.warned = false;
  menuDumps.clear();
  let backed = false;
  let warnedBack = false;
  // 글자 배경색(여는 부분 제목의 민트 배경)을 켜고 끕니다. 끌 때는 흰색으로 돌립니다.
  const setBackground = async (hex) => {
    const report = {};
    const changed = await setFontColor(frame, hex || '#ffffff', BACKGROUND_COLOR_TOGGLE, report);
    if (!changed && hex && !warnedBack) {
      warnedBack = true;
      // 다음 수정의 증거로 도구 모음 구조를 남깁니다. (색상표 단계 실패면 setFontColor 가 이미 남겼습니다)
      const dump = report.dump || await dumpToolbar(frame, 'background-color-not-found');
      log(`${report.step === 'palette' ? '글자 배경색 버튼은 눌렀지만 색상표를 찾지 못했습니다' : '글자 배경색 버튼을 찾지 못했습니다'}. 제목은 배경색 없이 초록 글씨로 넣습니다.${dump ? ` (도구 모음 기록: ${dump})` : ''}`);
    }
    return changed;
  };

  await focusBodyEnd(frame);

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    onProgress({ index, total: blocks.length });

    // 목록 창이 열렸거나 초점이 본문 밖이면, 키를 누르기 전에(Enter 가 그 단추를 누르지 않게) 본문으로 돌아갑니다.
    // 빈 문단을 눌러 커서를 옮기면 미리 켜 둔 크기·정렬이 풀릴 수 있어 다시 맞춥니다.
    if (await keepFocusInBody(page, frame, log)) {
      currentSize = null;
      checkAlign = true;
    }

    if (block.type === 'image') {
      if (bold) {
        await clickSelector(frame, BOLD_SELECTORS);
        bold = false;
      }
      if (backed) {
        await setBackground(null);
        backed = false;
      }
      await insertImage(page, frame, block, log);
      checkAlign = true;
      continue;
    }
    if (block.type === 'sticker') {
      // 스티커는 가운데에 둡니다. 스티커가 들어갈 문단을 먼저 가운데로 맞춥니다.
      await ensureAlign(frame, 'center');
      await insertSticker(page, frame, block, log);
      checkAlign = true;
      continue;
    }
    if (block.type === 'blank') {
      await page.keyboard.press('Enter');
      continue;
    }
    if (block.type === 'quote') {
      // 인용구는 커서가 있는 빈 줄을 제목으로 씁니다. 앞에 둔 빈 줄이 사라지지 않게 한 칸 더 내려갑니다.
      if (blocks[index - 1]?.type === 'blank') {
        await page.keyboard.press('Enter');
      }
      // 인용구 상자에 들어가기 전에 굵게·색을 꺼 둡니다. 상자 안은 인용구 기본 서식을 씁니다.
      if (bold) {
        await clickSelector(frame, BOLD_SELECTORS);
        bold = false;
      }
      if (colored) {
        await setFontColor(frame, BODY_COLOR);
        colored = false;
      }
      if (backed) {
        await setBackground(null);
        backed = false;
      }
      if (await insertQuote(page, frame, block, log)) {
        currentSize = null; // 인용구 다음 새 문단은 기본 크기로 시작하므로 다시 맞춥니다.
        checkAlign = true;
        continue;
      }
      // 인용구를 못 넣으면 아래에서 소제목 글자(19px 네이비)로 입력합니다.
    }

    if (block.size !== currentSize && toolbar.fontSize !== null) {
      const report = {};
      let changed = await setFontSize(frame, block.size, report);
      if (!changed) {
        await backToText(page, frame);
        changed = await setFontSize(frame, block.size, report);
      }
      if (changed) {
        currentSize = block.size;
      } else if (!warned.size && report.step !== 'verify') {
        // 'verify'(눌렀지만 빈 줄에서는 안 바뀜)는 글을 친 뒤 fixLineStyle 이 줄을 선택해 다시 맞추므로 알리지 않습니다.
        warned.size = true;
        const dump = report.dump || await dumpEditorDom(page, frame, 'font-size-not-found');
        log(`${report.step === 'option' ? `글자 크기 메뉴는 열었지만 ${block.size}을 찾지 못했습니다` : '글자 크기 버튼을 찾지 못했습니다'}. 네이버 기본 크기로 입력합니다.${dump ? ` (기록: ${dump})` : ''}`);
      }
      // 메뉴를 여닫다 커서가 본문을 벗어나면 다음 줄이 빠지므로(2026-10-03 기록), 실패하면 커서를 본문 끝으로 되돌립니다.
      if (!changed) {
        await backToText(page, frame);
      }
    }

    // colored 에는 지금 켜 둔 글자색이 들어 있습니다. 색이 바뀌면 (꾸밈 줄 연두 → 제목 초록) 다시 고릅니다.
    if (block.color && block.color !== colored) {
      let changed = await setFontColor(frame, block.color);
      if (!changed) {
        await backToText(page, frame);
        changed = await setFontColor(frame, block.color);
      }
      colored = changed ? block.color : false;
      if (!changed && !warned.color) {
        warned.color = true;
        log('글자색 버튼을 찾지 못했습니다. 굵게 강조만 적용합니다.');
      }
      if (!changed) {
        await backToText(page, frame);
      }
    } else if (!block.color && colored) {
      if (!await setFontColor(frame, BODY_COLOR)) {
        await backToText(page, frame);
      }
      colored = false;
    }

    const wantBold = Boolean(block.bold);
    if (wantBold !== bold) {
      const toggled = await clickSelector(frame, BOLD_SELECTORS);
      if (!toggled) {
        await page.keyboard.press('Control+B');
      }
      bold = wantBold;
    }

    // 블록마다 정한 정렬(blocks.js 의 BLOG_ALIGN, 기본 가운데)로 맞춥니다.
    const side = block.align === 'center' ? 'center' : 'left';
    // 사진·인용구·스티커 다음 새 문단은 기본 글꼴로 돌아갈 수 있어 글꼴도 다시 고릅니다.
    if (checkAlign && fontName() !== 'off' && !warned.font) {
      const report = {};
      let picked = await setFontFamily(frame, fontName(), report);
      if (!picked) {
        await backToText(page, frame);
        picked = await setFontFamily(frame, fontName(), report);
      }
      if (!picked) {
        warned.font = true;
        const dump = report.dump || await dumpToolbar(frame, 'font-button-not-found');
        const label = FONT_LABELS[fontName()] || fontName();
        log(`${report.step === 'option' ? `글꼴 메뉴는 열었지만 ${label}을 찾지 못했습니다` : '글꼴 버튼을 찾지 못했습니다'}. 블로그 기본 글꼴로 입력합니다.${dump ? ` (도구 모음 기록: ${dump})` : ''}`);
        await backToText(page, frame);
      }
    }
    if (checkAlign || side !== currentAlign) {
      await ensureAlign(frame, side);
      currentAlign = side;
      checkAlign = false;
    }
    if (block.background && !backed) {
      backed = await setBackground(block.background);
    } else if (!block.background && backed) {
      await setBackground(null);
      backed = false;
    }
    // 한 줄 치고 나서 본문에 실제로 들어갔는지 확인합니다. (팝업이 키를 가로채거나 커서가 엉뚱한 곳에 있던 경우)
    // 본문 글자가 하나도 늘지 않았을 때만 다시 칩니다. 조금이라도 들어갔으면 다시 치면 글이 겹치므로 그대로 둡니다.
    const before = await readEditorText(frame);
    await page.keyboard.type(block.text, { delay: TYPE_DELAY });
    if (block.tightAbove) {
      await removeBlankAbove(page, frame);
    }
    await fixLineStyle(page, frame, block, log);
    await page.keyboard.press('Enter');
    const after = await readEditorText(frame);
    if (before && after && after.body.length <= before.body.length) {
      missed.count += 1;
      if (after.title !== before.title) {
        missed.title = true;
      }
      if (!missed.dumped) {
        missed.dumped = true;
        const dump = await dumpEditorDom(page, frame, 'body-line-missed');
        log(`본문 한 줄이 들어가지 않아 다시 입력합니다. ("${block.text.slice(0, 15)}…")${dump ? ` 화면 구조를 ${dump} 에 남겼습니다.` : ''}`);
      }
      await dismissPopups(page);
      // 글의 맨 끝이 사진이면 사진 아래로 갑니다. 본문 마지막 문단은 사진 위에 있어 그리로 가면 순서가 뒤바뀝니다.
      const lastPart = await lastComponentKind(frame);
      if (!(lastPart && await moveBelowLast(page, frame, lastPart))) {
        await focusBodyEnd(frame);
        // 마지막 문단이 이미 비어 있으면 Enter 를 치지 않습니다. 쳤더니 문단 중간에 빈 줄이 하나 끼었습니다(2026-10-03 사용자 보고).
        const lastEmpty = await frame.evaluate((notBody) => {
          const all = [...document.querySelectorAll('.se-text-paragraph')].filter((node) => !node.closest(notBody));
          const last = all[all.length - 1];
          return Boolean(last) && !last.textContent.replace(/[\s​]/g, '');
        }, NOT_BODY).catch(() => false);
        if (!lastEmpty) {
          await page.keyboard.press('Enter');
        }
      }
      await page.keyboard.type(block.text, { delay: TYPE_DELAY });
      // 다시 친 줄도 크기·색을 확인합니다. (2026-10-23 출처 줄을 다시 칠 때는 11·회색을 맞추지 않았습니다)
      await fixLineStyle(page, frame, block, log);
      await page.keyboard.press('Enter');
      const retry = await readEditorText(frame);
      if (retry && retry.body.length > after.body.length) {
        missed.recovered += 1;
      } else {
        missed.lost.push(block.text);
      }
      checkAlign = true; // 커서를 옮겼으니 정렬을 다시 확인합니다.
    }
  }

  if (styleFix.fixed > 0) {
    log(`서식(글꼴·크기·색)이 다르게 들어간 곳 ${styleFix.fixed}군데를 다시 맞췄습니다.`);
  }
  if (missed.count > 0) {
    log(missed.lost.length === 0
      ? `본문 ${missed.count}줄이 처음에 빠져 다시 입력했습니다.`
      : `본문 ${missed.lost.length}줄을 끝내 넣지 못했습니다. 임시저장 뒤 확인해 주시기 바랍니다. (예: "${missed.lost[0].slice(0, 20)}")`);
  }

  if (bold) {
    await clickSelector(frame, BOLD_SELECTORS);
  }
  if (colored) {
    await setFontColor(frame, BODY_COLOR);
  }
  if (backed) {
    await setBackground(null);
  }
};

// 빠른 모드입니다. 서식이 담긴 HTML 을 클립보드에 넣고 Ctrl+V 로 붙입니다.
const pasteBlocks = async ({ page, frame, blocks, writeClipboard, log = noop, onProgress = noop }) => {
  await focusBodyEnd(frame);
  let buffer = [];

  const flush = async () => {
    if (buffer.length === 0) {
      return;
    }
    const html = buffer.join('\n');
    const text = buffer.join('\n').replace(/<[^>]+>/g, '');
    buffer = [];
    await writeClipboard({ html, text });
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(500);
    await dismissPopups(page);
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    onProgress({ index, total: blocks.length });
    if (block.type === 'image') {
      await flush();
      await insertImage(page, frame, block, log);
      continue;
    }
    if (block.type === 'sticker') {
      // 스티커는 붙여넣기로 넣을 수 없어 스티커 창에서 고릅니다.
      await flush();
      await insertSticker(page, frame, block, log);
      continue;
    }
    if (block.type === 'blank') {
      buffer.push('<p><br></p>');
      continue;
    }
    if (block.type === 'quote') {
      // 인용구는 붙여넣기로 만들 수 없어 버튼으로 넣습니다. 못 넣으면 아래에서 소제목 글자로 붙입니다.
      await flush();
      if (blocks[index - 1]?.type === 'blank') {
        await page.keyboard.press('Enter');
      }
      if (await insertQuote(page, frame, block, log)) {
        continue;
      }
    }
    const styles = [`font-size:${block.size}px`, 'line-height:1.9', `text-align:${block.align === 'center' ? 'center' : 'left'}`];
    if (block.color) {
      styles.push(`color:${block.color}`);
    }
    if (block.bold) {
      styles.push('font-weight:bold');
    }
    const safe = block.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inner = block.background ? `<span style="background-color:${block.background}">${safe}</span>` : safe;
    buffer.push(`<p style="${styles.join(';')}">${inner}</p>`);
  }
  await flush();
};

const clickNamedButton = async (page, frame, name) => {
  const scopes = [frame, page];
  for (let index = 0; index < scopes.length; index += 1) {
    const button = scopes[index].getByRole('button', { name, exact: true });
    const count = await button.count().catch(() => 0);
    if (count === 0) {
      continue;
    }
    const target = button.last();
    if (await target.isVisible().catch(() => false)) {
      await target.click({ timeout: 5000 }).catch(noop);
      return true;
    }
  }
  return false;
};

const saveDraft = async (page, frame) => {
  const frames = page.frames();
  for (let index = 0; index < frames.length; index += 1) {
    const target = frames[index].locator('button[class*="save_btn"]').first();
    if (await target.count().catch(() => 0) && await target.isVisible().catch(() => false)) {
      await target.click({ timeout: 5000 }).catch(noop);
      await page.waitForTimeout(1200);
      await clickNamedButton(page, frame, '확인');
      return true;
    }
  }
  if (await clickNamedButton(page, frame, '임시저장') || await clickNamedButton(page, frame, '저장')) {
    await page.waitForTimeout(1200);
    await clickNamedButton(page, frame, '확인');
    return true;
  }
  return false;
};

// 글 하나를 에디터에 넣고 임시저장합니다.
// 본문까지 다 친 뒤 제목이 그대로 있는지 다시 봅니다. 늦게 뜬 팝업을 닫으면서 제목이 지워지는 경우가 있습니다.
// 제목 칸이 비어 있으면 다시 넣습니다. (전체 선택 후 지우기는 본문까지 지울 수 있어 쓰지 않습니다)
// 제목 칸에 다른 글이 섞여 있으면 고치지 않고 알리기만 합니다.
const checkTitleAfterBody = async (page, frame, title, log = noop) => {
  const sample = title.replace(/\s+/g, ' ').trim().slice(0, 6);
  const current = (await readTitleText(frame)).replace(/\s+/g, ' ').trim();
  if (current.includes(sample)) {
    return true;
  }
  if (current) {
    log(`제목 칸에 다른 글("${current.slice(0, 20)}")이 들어가 있습니다. 임시저장 뒤 제목을 확인해 주시기 바랍니다.`);
    return false;
  }
  log('본문을 넣는 동안 제목이 지워져 다시 넣습니다.');
  await dismissPopups(page);
  const found = await findTitleBox(frame);
  if (found) {
    await focusTitleBox(frame, found);
    await page.keyboard.type(title, { delay: TYPE_DELAY });
  }
  const ok = (await readTitleText(frame)).includes(sample);
  if (!ok) {
    log('제목을 다시 넣지 못했습니다. 임시저장 뒤 제목을 직접 입력해 주시기 바랍니다.');
  }
  await focusBodyEnd(frame);
  return ok;
};

const writeToNaverOnce = async ({ title, blocks, mode = 'type', writeClipboard, log = noop, onProgress = noop }) => {
  stickerState.failed = false; // 스티커는 글마다 다시 시도합니다.
  stickerState.exitWarned = false;
  // 인용구도 글마다 처음 상태로 되돌립니다. 앞 글에서 실패했다고 다음 글의 소제목까지 일반 글자로 넣지 않습니다.
  quoteState.disabled = String(process.env.QUOTE_HEADINGS || 'on').toLowerCase() === 'off';
  quoteState.exitFails = 0;
  imageState.warned = false;
  const page = await openFreshPage();
  await page.bringToFront();
  log('네이버 로그인 상태와 블로그 아이디를 확인합니다.');
  const blogId = await resolveBlogId(page, log);
  log(`블로그 아이디를 확인했습니다. (${blogId})`);
  let frame = await openWriteForm(page, blogId, log);
  await waitForEditorSettled(page, frame, log);
  // 새 글 화면이면 제목 칸이 비어 있어야 합니다. 앞 글(또는 이어쓰기로 불러온 글)이 남아 있으면 한 번 다시 열고,
  // 그래도 남아 있으면 덧쓰지 않고 멈춥니다. (앞 글 임시저장본을 덮어쓰는 것을 막기 위해서입니다)
  if ((await readTitleOnly(frame)).trim()) {
    log('글쓰기 화면에 앞 글이 남아 있어 새 글 화면을 다시 엽니다.');
    frame = await openWriteForm(page, blogId, log);
    await waitForEditorSettled(page, frame, log);
    if ((await readTitleOnly(frame)).trim()) {
      throw new Error('editor-not-empty');
    }
  }

  const toolbar = await discoverToolbar(frame).catch(() => ({ bold: null, fontSize: null, fontColor: null }));
  log(`에디터 준비가 끝났습니다. 제목을 입력합니다. (서식 버튼 인식: 크기 ${toolbar.fontSize ? 'O' : 'X'} / 색 ${toolbar.fontColor ? 'O' : 'X'})`);

  await typeTitle(page, frame, title, log);
  log(`본문을 입력합니다. 블록 ${blocks.length}개를 ${mode === 'paste' ? '붙여넣기' : '키보드 입력'} 방식으로 넣습니다.`);

  if (mode === 'paste' && typeof writeClipboard === 'function') {
    await pasteBlocks({ page, frame, blocks, writeClipboard, log, onProgress });
  } else {
    await typeBlocks({ page, frame, blocks, toolbar, log, onProgress });
  }
  await checkTitleAfterBody(page, frame, title, log);
  // 본문 정렬(가장 많이 쓴 정렬)로 마지막 확인을 합니다. 다르게 정렬한 글은 그대로 둡니다.
  const textBlocks = blocks.filter((block) => block.text && block.type !== 'quote');
  const centered = textBlocks.filter((block) => block.align === 'center').length;
  const side = centered * 2 >= textBlocks.length ? 'center' : 'left';
  const keep = textBlocks.filter((block) => (block.align === 'center' ? 'center' : 'left') !== side).map((block) => block.text);
  await finishAlign(page, frame, log, { side, keep });
  await fixTitleStyle(page, frame, log);

  log('임시저장을 누릅니다.');
  const saved = await saveDraft(page, frame);
  return {
    saved,
    message: saved
      ? '글을 넣고 임시저장했습니다. 네이버 블로그 임시저장 목록에서 확인하고 발행하시기 바랍니다.'
      : '글은 모두 넣었지만 임시저장 버튼을 찾지 못했습니다. 브라우저 오른쪽 위 저장 버튼을 직접 눌러 주시기 바랍니다.',
  };
};

// 입력 도중 브라우저 창이 닫히면 영어 오류 대신 browser-closed 로 알려, 화면에 한국어 안내가 나오게 합니다.
// 창이 닫힐 때 나는 오류 문구는 그때그때 다르므로(ERR_ABORTED, has been closed 등) 실제로 닫혔는지로 판단합니다.
const writeToNaver = async (options) => {
  const closesBefore = closeCount;
  try {
    return await writeToNaverOnce(options);
  } catch (error) {
    if (closeCount !== closesBefore || isClosedError(error)) {
      contextPromise = null;
      throw new Error('browser-closed');
    }
    throw error;
  }
};

// 모의 DOM 검증 스크립트가 실제 코드를 그대로 시험하도록 내부 함수를 열어 둡니다.
const __test = { closeGapAbove, setFontSize, chooseFromMenu, fixLineStyle, fixTitleStyle, readLineStyle, setFontFamily, resolveBlogId, waitForEditor, getContext, openPage, closeBrowser, waitForEditorSettled, checkTitleAfterBody, focusBodyEnd, typeTitle, findTitleBox, dismissPopups, readTitleText, insertQuote, quoteState, insertSticker, stickerState, finishAlign, countMisaligned, typeBlocks };

export { writeToNaver, closeBrowser, getContext, __test };
