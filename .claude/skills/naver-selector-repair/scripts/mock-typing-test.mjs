#!/usr/bin/env node
// 제목·본문이 "가끔" 안 들어가는 문제의 모의 검증. src/naver.js 의 실제 함수를 그대로 부릅니다.
//
// 간헐적 실패의 원인으로 보이는 상황을 흉내 냅니다.
//  A. 본문을 치는 도중 팝업이 떠서 키 입력을 가로챔
//  B. 사진 바로 뒤에서 커서를 찾을 때 사진 설명칸(캡션)이 마지막 문단인 상황
//  C. 에디터가 뜨고 1초 뒤에 늦게 뜨는 팝업 (작성 중 글 복구 안내)
//  D. 본문을 치는 동안 제목이 지워짐
//  E. 글 맨 끝에 사진을 넣은 뒤 첫 줄 — 사진 아래 문단이 없어 커서가 설명칸으로 감
//  F. 글을 쓰는 도중 "임시저장 글" 목록 창이 열림 — 어두운 덮개가 클릭을 막고 키보드 초점을 창 안에 가둠,
//     닫으면 초점이 여는 단추(임시저장된 글 보기)로 돌아가 다음 Enter 가 창을 다시 엶 (2026-10-23 실제 기록 naver-toolbar-1792686010126.json)
// 통과는 "알려진 구조에서 회귀가 없다"는 뜻이며 실제 네이버 동작 보장은 아닙니다.
//
// 사용법: node .claude/skills/naver-selector-repair/scripts/mock-typing-test.mjs [프로젝트루트]

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const { chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
const naver = await import(pathToFileURL(path.join(ROOT, 'src', 'naver.js')).href);
const t = naver.__test || {};
for (const name of ['typeBlocks', 'focusBodyEnd', 'waitForEditorSettled', 'checkTitleAfterBody']) {
  if (typeof t[name] !== 'function') {
    console.error(`src/naver.js 가 __test.${name} 을 내보내지 않습니다.`);
    process.exit(1);
  }
}

const EDITOR = (extra = '') => `
  <div class="se-component se-documentTitle"><div class="se-section-documentTitle">
    <p class="se-text-paragraph" contenteditable="true">가을 소풍 준비물</p></div></div>
  <div class="se-main" contenteditable="true">
    <div class="se-component se-text"><p class="se-text-paragraph"><br></p></div>
    ${extra}
  </div>`;

const POPUP = `
  window.showPopup = () => {
    const pop = document.createElement('div');
    pop.className = 'se-popup';
    pop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.3)';
    pop.innerHTML = '<input class="trap"><button class="se-popup-button-cancel">취소</button>';
    document.body.appendChild(pop);
    pop.querySelector('.se-popup-button-cancel').onclick = () => { window.popupClosedAt = performance.now(); pop.remove(); };
    pop.querySelector('.trap').focus();
  };
`;

const bodyText = (page) => page.evaluate(() => [...document.querySelectorAll('.se-main .se-text-paragraph')]
  .filter((p) => !p.closest('.se-caption, .se-image')).map((p) => p.textContent).join(' ').replace(/\s+/g, ' ').trim());

const LINES = ['첫째 줄 본문입니다.', '둘째 줄 본문입니다.', '셋째 줄 본문입니다.', '넷째 줄 본문입니다.'];
const blocks = LINES.map((text) => ({ type: 'text', text, size: 15, align: 'left' }));
const toolbar = { fontSize: null, fontColor: null, bold: null };

const SCENARIOS = [
  {
    id: 'A', name: '본문을 치는 도중 팝업이 키 입력을 가로챔',
    html: EDITOR(),
    script: `${POPUP} let shown = false; document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !shown && document.querySelectorAll('.se-main .se-text-paragraph').length >= 2) { shown = true; setTimeout(showPopup, 0); }
    }, true);`,
    run: async (page, frame, logs) => {
      await t.focusBodyEnd(frame);
      await t.typeBlocks({ page, frame, blocks, toolbar, log: (m) => logs.push(m) });
    },
    check: async (page) => {
      const text = await bodyText(page);
      return { ok: LINES.every((line) => text.includes(line)) && LINES.every((line) => text.split(line).length === 2), detail: text };
    },
  },
  {
    id: 'B', name: '사진 뒤 마지막 문단이 사진 설명칸일 때 본문에 커서 두기',
    html: EDITOR('<div class="se-component se-image" contenteditable="false"><div class="se-caption"><p class="se-text-paragraph" contenteditable="true"></p></div></div>'),
    script: '',
    run: async (page, frame) => {
      await t.focusBodyEnd(frame);
      await page.keyboard.type('본문 글자');
    },
    check: async (page) => {
      const caption = await page.locator('.se-caption p').textContent();
      const text = await bodyText(page);
      return { ok: !caption.includes('본문') && text.includes('본문 글자'), detail: `본문 "${text}" / 설명칸 "${caption}"` };
    },
  },
  {
    id: 'C', name: '에디터가 뜨고 1초 뒤에 늦게 뜨는 팝업',
    html: EDITOR(),
    script: `${POPUP} setTimeout(showPopup, 1000);`,
    run: async (page, frame, logs) => {
      await t.waitForEditorSettled(page, frame, (m) => logs.push(m));
      await page.evaluate(() => { window.typingAt = performance.now(); });
      await t.focusBodyEnd(frame);
      await t.typeBlocks({ page, frame, blocks: blocks.slice(0, 2), toolbar, log: (m) => logs.push(m) });
    },
    check: async (page) => {
      const popup = await page.locator('.se-popup').count();
      const text = await bodyText(page);
      // 늦게 뜬 팝업을 입력 시작 "전에" 닫았어야 합니다. 입력을 너무 일찍 시작하면 팝업이 입력 도중에 뜹니다.
      const order = await page.evaluate(() => ({ closed: window.popupClosedAt, typing: window.typingAt }));
      const before = order.closed !== undefined && order.closed < order.typing;
      return { ok: before && popup === 0 && text.includes(LINES[0]) && text.includes(LINES[1]), detail: `팝업을 입력 전에 닫음: ${before ? '예' : '아니오'}, 본문 "${text}"` };
    },
  },
  {
    id: 'D', name: '본문을 치는 동안 제목이 지워짐 → 끝에서 다시 넣기',
    html: EDITOR(),
    script: `document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const p = document.querySelector('.se-section-documentTitle p'); if (p.textContent) p.textContent = ''; }
    }, true);`,
    run: async (page, frame, logs) => {
      await t.focusBodyEnd(frame);
      await t.typeBlocks({ page, frame, blocks: blocks.slice(0, 2), toolbar, log: (m) => logs.push(m) });
      await page.evaluate(() => { document.onkeydown = null; });
      await page.evaluate(() => document.querySelectorAll('script').forEach((s) => s.remove()));
      await t.checkTitleAfterBody(page, frame, '가을 소풍 준비물', (m) => logs.push(m));
    },
    check: async (page) => {
      const title = (await page.locator('.se-section-documentTitle p').textContent()).trim();
      const text = await bodyText(page);
      return { ok: title === '가을 소풍 준비물' && text.includes(LINES[0]), detail: `제목 "${title}", 본문 "${text}"` };
    },
  },
  {
    id: 'E', name: '글 맨 끝에 사진을 넣은 뒤 첫 줄 (Ctrl+End 가 설명칸으로 감, 사진 아래 문단 없음)',
    html: `${EDITOR()}<button class="se-image-toolbar-button" onclick="document.getElementById('file').click()">사진</button><input type="file" id="file" style="display:none">`,
    script: `
      const main = document.querySelector('.se-main');
      main.style.paddingBottom = '200px';
      const caret = (p) => { const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
      document.getElementById('file').onchange = () => {
        const c = document.createElement('div');
        c.className = 'se-component se-image';
        c.setAttribute('contenteditable', 'false');
        c.innerHTML = '<div class="se-module-image"><img style="width:300px;height:120px;display:block;background:#ccc"></div><div class="se-caption"><p class="se-text-paragraph" contenteditable="true" style="min-height:1.2em"></p></div>';
        main.appendChild(c);
        c.querySelector('.se-caption p').focus();
      };
      document.addEventListener('keydown', (e) => {
        // 실제 에디터처럼: Ctrl+End 는 글의 맨 끝(마지막 사진의 설명칸)으로, 설명칸의 Enter 는 무시
        if (e.key === 'End' && e.ctrlKey) {
          const all = [...document.querySelectorAll('.se-main .se-text-paragraph')];
          const last = all[all.length - 1];
          e.preventDefault();
          if (last.closest('.se-caption')) { last.focus(); }
          caret(last);
        }
        const inCaption = getSelection().anchorNode && getSelection().anchorNode.parentElement && getSelection().anchorNode.parentElement.closest('.se-caption')
          || (getSelection().anchorNode && getSelection().anchorNode.closest && getSelection().anchorNode.closest('.se-caption'));
        if (e.key === 'Enter' && inCaption) { e.preventDefault(); }
      }, true);
      // 마지막 구성 요소 아래 빈 곳을 누르면 새 문단이 생김
      main.addEventListener('mousedown', (e) => {
        if (e.target !== main) return;
        e.preventDefault();
        const c = document.createElement('div');
        c.className = 'se-component se-text';
        c.innerHTML = '<p class="se-text-paragraph"><br></p>';
        main.appendChild(c);
        main.focus();
        caret(c.querySelector('p'));
      });`,
    run: async (page, frame, logs) => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const file = path.join(os.tmpdir(), 'mock-image.jpg');
      fs.writeFileSync(file, 'x');
      await t.focusBodyEnd(frame);
      await t.typeBlocks({ page, frame, toolbar, log: (m) => logs.push(m), blocks: [
        { type: 'image', filePath: file, caption: '사진 설명' },
        ...blocks.slice(0, 2),
      ] });
    },
    check: async (page, logs) => {
      const caption = await page.locator('.se-caption p').textContent();
      const order = await page.evaluate(() => {
        const image = document.querySelector('.se-image');
        return [...document.querySelectorAll('.se-main .se-text-paragraph')]
          .filter((p) => !p.closest('.se-caption') && p.textContent.includes('본문'))
          .map((p) => (image.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING ? '아래' : '위'));
      });
      const text = await bodyText(page);
      const ok = caption === '사진 설명' && order.length >= 2 && order.every((side) => side === '아래')
        && LINES.slice(0, 2).every((line) => text.split(line).length === 2) && !logs.some((m) => m.includes('다시 입력'));
      
      return { ok, detail: `설명칸 "${caption}", 본문 줄 위치 [${order.join(',')}], 본문 "${text}"` };
    },
  },
  {
    id: 'F', name: '글을 쓰는 도중 "임시저장 글" 목록 창이 열림 (덮개 + 초점 가둠, 닫으면 초점이 여는 단추로)',
    // 실제 구조: 상단 "저장 | 15" 단추, 목록 창은 layer_popup__… isShow__… + dimmed__… + data-focus-lock="popupLayer"
    html: `<div class="header"><button class="save_btn__FuUyN">저장</button><button class="save_count_btn__xxzDt" aria-label="임시저장된 글 보기, 15개">15</button></div>${EDITOR()}`,
    script: `
      const countButton = document.querySelector('.save_count_btn__xxzDt');
      let layer = null;
      const closeList = () => {
        if (!layer) return;
        layer.remove();
        layer = null;
        countButton.focus(); // react-focus-lock 처럼 닫으면 초점을 연 단추로 돌려줌
      };
      const openList = () => {
        if (layer) return;
        layer = document.createElement('div');
        layer.className = 'layer_popup__MFPwH isShow__KPrZB';
        layer.innerHTML = '<div class="dimmed__QzVgp" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:50"></div>'
          + '<div class="popup_container__lToCy" style="position:fixed;top:30px;right:30px;width:320px;z-index:51;background:#fff;padding:10px">'
          + '<div data-focus-guard="true" tabindex="0"></div><div data-focus-lock-disabled="false" data-focus-lock="popupLayer">'
          + '<div class="popup_content__W4t0D"><div class="header__js0_L"><strong class="title__tuVm3">임시저장 글</strong></div>'
          + '<ul class="list__EfNYH" tabindex="0" aria-label="임시저장된 글"><li class="item__k1QHQ"><button type="button" class="article_button__p0NRG">예전에 저장한 글</button>'
          + '<button type="button" class="delete_button__uksCg">삭제</button></li></ul>'
          + '<button type="button" class="close_button__ixLPl"><span>팝업닫기</span></button></div></div></div>';
        document.body.appendChild(layer);
        layer.querySelector('.article_button__p0NRG').addEventListener('click', () => { window.loadedOld = true; });
        layer.querySelector('.delete_button__uksCg').addEventListener('click', () => { window.deletedOld = true; });
        layer.querySelector('.close_button__ixLPl').addEventListener('click', closeList);
        layer.querySelector('.article_button__p0NRG').focus();
        window.listOpened = (window.listOpened || 0) + 1;
      };
      countButton.addEventListener('click', () => (layer ? closeList() : openList()));
      document.addEventListener('keydown', (e) => { if (layer && e.key === 'Escape') closeList(); }, true);
      // 초점 가둠: 창 밖으로 나간 초점은 창 안으로 되돌림
      document.addEventListener('focusin', (e) => { if (layer && !layer.contains(e.target)) layer.querySelector('.article_button__p0NRG').focus(); });
      // 첫 줄을 친 뒤 누군가 "임시저장 글 15" 를 누름
      let pressed = false;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !pressed && document.querySelectorAll('.se-main .se-text-paragraph').length >= 2) {
          pressed = true;
          setTimeout(() => { countButton.focus(); countButton.click(); }, 0);
        }
      }, true);`,
    run: async (page, frame, logs) => {
      await t.focusBodyEnd(frame);
      await t.typeBlocks({ page, frame, blocks, toolbar, log: (m) => logs.push(m) });
    },
    check: async (page) => {
      const text = await bodyText(page);
      const state = await page.evaluate(() => ({
        open: Boolean(document.querySelector('[class*="layer_popup"]')),
        opened: window.listOpened || 0,
        loaded: Boolean(window.loadedOld),
        deleted: Boolean(window.deletedOld),
      }));
      const ok = LINES.every((line) => text.split(line).length === 2) && !state.open && !state.loaded && !state.deleted;
      return { ok, detail: `목록 창 열린 횟수 ${state.opened}, 끝에 열려 있음 ${state.open ? '예' : '아니오'}, 예전 글 불러옴 ${state.loaded ? '예' : '아니오'}, 지움 ${state.deleted ? '예' : '아니오'}, 본문 "${text}"` };
    },
  },
];

const browser = await chromium.launch();
let failed = 0;
console.log('\n=== 모의 DOM 제목·본문 간헐 실패 검증 ===\n');
for (const scenario of SCENARIOS) {
  const page = await browser.newPage();
  // D 는 제목을 지우는 장난을 Enter 두 번까지만 합니다(그 뒤 제목 복구를 시험).
  const script = scenario.id === 'D'
    ? `let wipes = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && wipes < 2) { wipes += 1; const p = document.querySelector('.se-section-documentTitle p'); p.textContent = ''; } }, true);`
    : scenario.script;
  await page.setContent(`<!doctype html><meta charset="utf-8"><body>${scenario.html}<script>${script}</script></body>`);
  const logs = [];
  let result;
  try {
    await scenario.run(page, page.mainFrame(), logs);
    result = await scenario.check(page, logs);
  } catch (error) {
    result = { ok: false, detail: error.message };
  }
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? '[통과]' : '[실패]'} ${scenario.id}. ${scenario.name}\n         ${result.detail}${logs.length ? `\n         기록: ${logs.map((m) => m.slice(0, 50)).join(' | ')}` : ''}`);
  await page.close();
}
await browser.close();
console.log(`\n${SCENARIOS.length}건 중 ${SCENARIOS.length - failed}건 통과`);
console.log('통과는 "알려진 구조에서 회귀가 없다"는 뜻입니다. 실제 네이버 동작 보장은 아닙니다.');
process.exit(failed ? 1 : 0);
