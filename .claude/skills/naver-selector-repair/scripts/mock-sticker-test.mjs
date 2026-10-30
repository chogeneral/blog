#!/usr/bin/env node
// 글 맨 위 스티커 모의 검증. src/naver.js 의 실제 insertSticker 를 그대로 부릅니다.
//
// 스티커 창(위쪽에 ‹ 시계 묶음들 › 단추 줄, 아래에 3칸씩 스티커 목록)을 흉내 내고,
// 묶음 2번째 · 4줄 2칸 스티커가 들어가는지, 다음 글이 스티커 아래에 쓰이는지 확인합니다.
// 실제 네이버 스티커 창 구조는 로그인해야 볼 수 있어 이 모의 구조는 추정입니다(2026-10-02 사용자 화면 그림 기준).
// 통과는 "추정한 구조에서 코드가 의도대로 동작한다"는 뜻이며 실제 네이버 동작 보장은 아닙니다.
//
// 사용법: node .claude/skills/naver-selector-repair/scripts/mock-sticker-test.mjs [프로젝트루트]

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const { chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
const naver = await import(pathToFileURL(path.join(ROOT, 'src', 'naver.js')).href);
const { insertSticker, stickerState } = naver.__test || {};
if (typeof insertSticker !== 'function') {
  console.error('src/naver.js 가 __test.insertSticker 를 내보내지 않습니다.');
  process.exit(1);
}

const PACKS = ['recent', 'pink', 'simple', 'cloud', 'parenting', 'more'];
const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

// opts.start: 처음 열릴 때 골라져 있는 묶음, opts.after: 스티커 뒤에 빈 문단을 만들지(false 면 아래 빈 곳을 눌러야 생김)
const script = (opts) => `
  const PACKS = ${JSON.stringify(PACKS)};
  const main = document.querySelector('.se-main');
  const panel = document.querySelector('.se-sidebar-sticker');
  let current = ${JSON.stringify(opts.start)};
  const renderList = () => {
    const list = panel.querySelector('.se-sticker-list');
    list.innerHTML = '';
    for (let i = 1; i <= 12; i += 1) {
      const b = document.createElement('button');
      b.className = 'se-sticker-item';
      b.dataset.id = current + '-' + i;
      b.innerHTML = '<img src="${pixel}" width="60" height="40">';
      list.appendChild(b);
    }
  };
  document.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  document.querySelector('.se-sticker-toolbar-button').addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    renderList();
  });
  panel.addEventListener('click', (e) => {
    const tab = e.target.closest('.se-sticker-tab');
    if (tab) { current = tab.dataset.pack; renderList(); return; }
    const item = e.target.closest('.se-sticker-item');
    if (!item) return;
    // 스티커는 커서가 있던 빈 문단 자리에 들어갑니다(빈 문단은 사라짐).
    const sel = window.getSelection();
    const p = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest('.se-text-paragraph');
    const comp = document.createElement('div');
    comp.className = 'se-component se-sticker';
    comp.dataset.id = item.dataset.id;
    comp.innerHTML = '<img src="${pixel}" width="120" height="40">';
    // opts.keepEmpty: 실제 네이버처럼 커서가 있던 빈 문단을 그대로 두고 그 아래에 넣음(2026-10-03 사용자 그림)
    if (p && !p.textContent.trim() && !${opts.keepEmpty ? 'true' : 'false'}) { p.closest('.se-component').replaceWith(comp); } else if (p) { p.closest('.se-component').after(comp); } else { main.appendChild(comp); }
    if (${opts.after ? 'true' : 'false'}) {
      const next = document.createElement('div');
      next.className = 'se-component se-text';
      // opts.blockFirst: 스티커 바로 아래 빈 문단을 직접 누를 수 없음(다른 층이 덮음) → 커서가 더 아래로 감
      next.innerHTML = '<p class="se-text-paragraph" contenteditable="true"' + (${opts.blockFirst ? 'true' : 'false'} ? ' style="pointer-events:none"' : '') + '><br></p>';
      comp.after(next);
    }
  });
  // ↑ 는 바로 위 글 문단으로 갑니다(문단마다 따로 입력칸이라 브라우저 기본 동작으로는 안 넘어감).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp') return;
    const p = document.activeElement && document.activeElement.closest('.se-text-paragraph');
    if (!p) return;
    let prev = p.closest('.se-component').previousElementSibling;
    while (prev && !prev.querySelector('.se-text-paragraph')) prev = prev.previousElementSibling;
    if (!prev || prev.matches('.se-image')) return;
    e.preventDefault();
    const target = prev.querySelector('.se-text-paragraph');
    target.focus();
    const r = document.createRange(); r.selectNodeContents(target); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  // Delete 는 빈 문단 끝에서 바로 다음 빈 문단을 지웁니다(실제 에디터처럼 다음 문단을 끌어올림).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    const p = document.activeElement && document.activeElement.closest('.se-text-paragraph');
    if (!p) return;
    const next = p.closest('.se-component').nextElementSibling;
    if (next && next.matches('.se-text') && !next.textContent.trim()) { e.preventDefault(); next.remove(); }
  });
  // Backspace 는 빈 문단에서 그 문단을 지우고 위 글 문단 끝으로 갑니다.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace') return;
    const p = document.activeElement && document.activeElement.closest('.se-text-paragraph');
    if (!p || p.textContent.length) return;
    const comp = p.closest('.se-component');
    const prev = comp.previousElementSibling;
    if (!prev || !prev.matches('.se-text')) return;
    e.preventDefault();
    comp.remove();
    const target = prev.querySelector('.se-text-paragraph');
    target.focus();
    const r = document.createRange(); r.selectNodeContents(target); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  // Enter 는 실제 에디터처럼 새 문단을 만듭니다.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const p = document.activeElement && document.activeElement.closest('.se-text-paragraph');
    if (!p) return;
    if (p.closest('.se-caption')) { e.preventDefault(); return; }
    e.preventDefault();
    const next = document.createElement('div');
    next.className = 'se-component se-text';
    next.innerHTML = '<p class="se-text-paragraph" contenteditable="true"><br></p>';
    p.closest('.se-component').after(next);
    next.querySelector('p').focus();
  });
  // 마지막 구성 요소 아래 빈 곳을 누르면 새 문단이 생깁니다.
  // (opts.nearest: 새 문단이 생기지 않고, 브라우저처럼 가장 가까운 글칸 = 사진 설명칸으로 커서가 감)
  main.addEventListener('mousedown', (e) => {
    if (e.target !== main) return;
    if (${opts.nearest ? 'true' : 'false'}) {
      e.preventDefault();
      const caption = document.querySelector('.se-caption p');
      caption.focus();
      const r = document.createRange(); r.selectNodeContents(caption); r.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(r);
      return;
    }
    const next = document.createElement('div');
    next.className = 'se-component se-text';
    next.innerHTML = '<p class="se-text-paragraph" contenteditable="true"><br></p>';
    main.appendChild(next);
    setTimeout(() => next.querySelector('p').focus(), 0);
  });
`;

const tabs = `<button class="se-sticker-prev-button">‹</button>${PACKS.map((pack) => `<button class="se-sticker-tab" data-pack="${pack}"><img src="${pixel}" width="40" height="30"></button>`).join('')}<button class="se-sticker-next-button">›</button>`;
const STYLE = '<style>.se-main{min-height:400px;width:500px;padding-bottom:200px}.se-sidebar-sticker{position:fixed;right:0;top:0;width:280px}.se-sticker-tabs{display:flex}.se-sticker-list{display:grid;grid-template-columns:repeat(3,80px);gap:10px}</style>';

const VARIANTS = [
  { id: 'A', name: '스티커 뒤에 빈 문단이 생기는 구조', start: 'pink', after: true, button: true, want: 'pink-11' },
  { id: 'B', name: '창이 다른 묶음(구름)으로 열림 → 2번째 묶음으로 바꿔 고름', start: 'cloud', after: true, button: true, want: 'pink-11' },
  { id: 'C', name: '스티커 뒤에 문단이 없음 → 아래 빈 곳을 눌러 문단을 만듦', start: 'pink', after: false, button: true, want: 'pink-11' },
  { id: 'D', name: '스티커 버튼 없음 → 건너뛰고 한 번 알림', start: 'pink', after: true, button: false, want: null },
  { id: 'F', name: '5번째 묶음 · 3줄 1칸 (태그 앞 "읽어주셔서 감사합니다")', start: 'pink', after: true, button: true, want: 'parenting-7', pick: { pack: 5, row: 3, column: 1 } },
  { id: 'H', name: '스티커 뒤에 빈 문단이 생기는데 바로 아래를 누를 수 없어 더 아래로 감 → 사이 빈 줄 없애기(실제 그림 2026-10-03)', start: 'pink', after: true, blockFirst: true, button: true, want: 'pink-11' },
  { id: 'G', name: '맨 위 사진 다음 스티커 — 아래 빈 곳을 누르면 사진 설명칸으로 감(실제 오류 22:38 흉내)', start: 'pink', after: false, button: true, want: 'pink-11', nearest: true, image: true },
  { id: 'I', name: '서론 끝: 강조 문장 → Enter 로 생긴 빈 문단 아래에 스티커가 들어감 → 사이 빈 줄 없애기(사용자 그림 2026-10-03)', start: 'pink', after: true, button: true, want: 'pink-10', keepEmpty: true, lead: '강조 문장', pick: { pack: 2, row: 4, column: 1, tightAbove: true } },
  { id: 'E', name: '한 글에 두 번: 맨 위(4줄 2칸) → 제목·서론 → 서론 끝(4줄 1칸)', start: 'pink', after: false, button: true, twice: true },
];

const browser = await chromium.launch();
let failed = 0;
console.log('\n=== 모의 DOM 글 맨 위 스티커 검증 ===\n');
for (const variant of VARIANTS) {
  stickerState.failed = false;
  const page = await browser.newPage();
  const button = variant.button ? '<button class="se-sticker-toolbar-button" data-name="sticker">스티커</button>' : '';
  await page.setContent(`<!doctype html><meta charset="utf-8">${STYLE}<body><div class="toolbar">${button}<button class="se-toolbar-option-bold-button">굵게</button></div>`
    + `<div class="se-sidebar-sticker" style="display:none"><div class="se-sticker-tabs">${tabs}</div><div class="se-sticker-list"></div></div>`
    + `<div class="se-main">${variant.image ? '<div class="se-component se-image" contenteditable="false"><div class="se-module-image"><img src="' + pixel + '" width="300" height="120"></div><div class="se-caption"><p class="se-text-paragraph" contenteditable="true">사진 설명</p></div></div>' : ''}${variant.lead ? `<div class="se-component se-text"><p class="se-text-paragraph" contenteditable="true">${variant.lead}</p></div>` : ''}<div class="se-component se-text"><p class="se-text-paragraph" contenteditable="true"><br></p></div></div>`
    + `${variant.button ? `<script>${script(variant)}</script>` : ''}</body>`);
  await page.locator('.se-main > .se-text p').last().click();
  const logs = [];
  let ok;
  let detail;
  try {
    if (variant.twice) {
      const first = await insertSticker(page, page.mainFrame(), { type: 'sticker', pack: 2, row: 4, column: 2 }, (m) => logs.push(m));
      await page.keyboard.type('제목 첫 줄');
      await page.keyboard.press('Enter');
      await page.keyboard.type('서론 문단');
      await page.keyboard.press('Enter');
      const second = await insertSticker(page, page.mainFrame(), { type: 'sticker', pack: 2, row: 4, column: 1 }, (m) => logs.push(m));
      await page.keyboard.type('첫 소제목');
      const order = await page.evaluate(() => [...document.querySelectorAll('.se-sticker, .se-text-paragraph')]
        .map((node) => (node.classList.contains('se-sticker') ? node.dataset.id : node.textContent.trim()))
        .filter(Boolean).join(' → '));
      const want = 'pink-11 → 제목 첫 줄 → 서론 문단 → pink-10 → 첫 소제목';
      ok = first === true && second === true && order === want && logs.length === 0;
      detail = `순서: ${order}${logs.length ? `, 알림: ${logs[0]}` : ''}`;
      if (!ok) failed += 1;
      console.log(`${ok ? '[통과]' : '[실패]'} ${variant.id}. ${variant.name}
         ${detail}`);
      await page.close();
      continue;
    }
    const result = await insertSticker(page, page.mainFrame(), { type: 'sticker', ...(variant.pick || { pack: 2, row: 4, column: 2 }) }, (m) => logs.push(m));
    await page.keyboard.type('제목 첫 줄');
    const state = await page.evaluate(() => {
      const sticker = document.querySelector('.se-sticker');
      const holder = [...document.querySelectorAll('.se-text-paragraph')].find((p) => p.textContent.includes('제목 첫 줄'));
      return {
        id: sticker ? sticker.dataset.id : null,
        count: document.querySelectorAll('.se-sticker').length,
        below: Boolean(sticker && holder && (sticker.compareDocumentPosition(holder) & Node.DOCUMENT_POSITION_FOLLOWING)),
        // 스티커와 다음 글 사이 빈 문단 수 (0 이어야 함 — 사용자 요청: 스티커 바로 아래 제목)
        gap: (() => {
          if (!sticker || !holder) return -1;
          let count = 0;
          for (let node = sticker.nextElementSibling; node && !node.contains(holder); node = node.nextElementSibling) {
            if (node.matches('.se-text') && !node.textContent.trim()) count += 1;
          }
          return count;
        })(),
        // 스티커 바로 위 빈 문단 수 (앞 글이 있을 때만 셈, 0 이어야 함)
        gapAbove: (() => {
          if (!sticker) return -1;
          let count = 0;
          for (let node = sticker.previousElementSibling; node && node.matches('.se-text') && !node.textContent.trim(); node = node.previousElementSibling) count += 1;
          return count;
        })(),
        typed: Boolean(holder),
        panelOpen: document.querySelector('.se-sidebar-sticker').style.display !== 'none',
        caption: document.querySelector('.se-caption p')?.textContent ?? null,
      };
    });
    if (variant.want) {
      const captionOk = state.caption === null || state.caption === '사진 설명';
      ok = result === true && state.id === variant.want && state.count === 1 && state.below && state.gap === 0 && (!variant.lead || state.gapAbove === 0) && !state.panelOpen && logs.length === 0 && captionOk;
      detail = `스티커 ${state.id || '없음'}, 다음 글 ${state.below ? '스티커 아래' : '스티커 위/없음'}, 사이 빈 줄 ${state.gap},${variant.lead ? ` 위 빈 줄 ${state.gapAbove},` : ''} 스티커 창 ${state.panelOpen ? '열림' : '닫힘'}${state.caption !== null ? `, 사진 설명칸 "${state.caption}"` : ''}${logs.length ? `, 알림: ${logs[0]}` : ''}`;
    } else {
      ok = result === false && state.count === 0 && state.typed && logs.length === 1 && logs[0].includes('스티커 버튼을 찾지 못했습니다');
      detail = `알림 ${logs.length}번: ${(logs[0] || '').replace(/ \(스티커 창 기록.*$/, '')}, 다음 글 ${state.typed ? '들어감' : '안 들어감'}`;
    }
  } catch (error) {
    ok = false;
    detail = error.message;
  }
  if (!ok) failed += 1;
  console.log(`${ok ? '[통과]' : '[실패]'} ${variant.id}. ${variant.name}\n         ${detail}`);
  await page.close();
}
await browser.close();
console.log(`\n${VARIANTS.length}건 중 ${VARIANTS.length - failed}건 통과`);
console.log('통과는 "추정한 스티커 창 구조에서 코드가 의도대로 동작한다"는 뜻입니다. 실제 네이버 동작 보장은 아닙니다.');
process.exit(failed ? 1 : 0);
