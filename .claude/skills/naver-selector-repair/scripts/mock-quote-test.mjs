#!/usr/bin/env node
// 소제목 인용구 모양(세로선) 모의 검증. src/naver.js 의 실제 insertQuote 를 그대로 부릅니다.
//
// 인용구 모양 메뉴가 툴바에 바로 있는 경우 / ▼ 버튼 안에 있는 경우 / 기본 인용구 버튼만 있는 경우를
// 흉내 내고, 세로선 인용구가 들어가는지, 못 고르면 기본 인용구로라도 들어가는지 확인합니다.
// 통과는 "알려진 구조에서 회귀가 없다"는 뜻이며 실제 네이버 동작 보장은 아닙니다.
//
// 사용법: node .claude/skills/naver-selector-repair/scripts/mock-quote-test.mjs [프로젝트루트]

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const { chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
const naver = await import(pathToFileURL(path.join(ROOT, 'src', 'naver.js')).href);
const { insertQuote, quoteState } = naver.__test || {};
if (typeof insertQuote !== 'function') {
  console.error('src/naver.js 가 __test.insertQuote 를 내보내지 않습니다.');
  process.exit(1);
}

// 버튼을 누르면 인용구 상자를 만들고 그 안에 커서를 둡니다. 아래 화살표를 누르면 상자 밖 새 문단으로 나갑니다.
const SCRIPT = `
  const main = document.querySelector('.se-main');
  const insert = (style) => {
    const box = document.createElement('div');
    box.className = 'se-component se-quotation se-l-' + style;
    box.innerHTML = '<p class="se-text-paragraph" contenteditable="true"></p>';
    main.appendChild(box);
    box.querySelector('p').focus();
    const drop = document.querySelector('.drop');
    if (drop) drop.style.display = 'none';
  };
  document.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  document.querySelectorAll('[data-quote]').forEach((b) => b.addEventListener('click', () => insert(b.dataset.quote)));
  const toggle = document.querySelector('.se-document-toolbar-select-option-button');
  if (toggle) toggle.addEventListener('click', () => { document.querySelector('.drop').style.display = 'block'; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    const box = document.activeElement.closest('.se-quotation');
    if (!box) return;
    e.preventDefault();
    const p = document.createElement('p');
    p.className = 'se-text-paragraph';
    p.contentEditable = 'true';
    main.appendChild(p);
    p.focus();
  });
`;

const defaultButton = '<button class="se-insert-quotation-default-toolbar-button" data-quote="default">인용구</button>';
const VARIANTS = [
  {
    id: 'A', name: '▼ 버튼을 눌러야 모양 메뉴가 열림 (스마트에디터 ONE 구조)', want: 'quotation_line', warn: false,
    toolbar: `${defaultButton}<button class="se-document-toolbar-select-option-button" data-name="quotation">인용구 열기</button><div class="drop" style="display:none"><button data-value="default" data-quote="default">기본</button><button data-value="quotation_line" data-quote="quotation_line">세로선</button><button data-value="quotation_bubble" data-quote="quotation_bubble">말풍선</button></div>`,
  },
  {
    id: 'B', name: '모양 버튼이 툴바에 바로 있음', want: 'quotation_line', warn: false,
    toolbar: `${defaultButton}<button class="se-toolbar-option-insert-quotation-quotation_line-button" data-quote="quotation_line">세로선</button>`,
  },
  {
    id: 'C', name: '기본 인용구 버튼만 있음 → 기본 인용구로 넣고 한 번 알림', want: 'default', warn: true,
    toolbar: defaultButton,
  },
  {
    // 2026-10-02 실제 오류("인용구 상자에서 빠져나오지 못해")를 재현한 구조:
    // 인용구가 커서 자리에 들어가고, 인용구 안에 "출처" 칸이 있어 아래 화살표를 누르면 출처 칸으로만 갑니다.
    // 출처 칸에서는 아래 화살표·Escape 가 아무 일도 하지 않고, 마지막 구성 요소 아래 빈 곳을 눌러도 문단이 안 생깁니다.
    id: 'D', name: '인용구에 출처 칸이 있고 글 맨 끝에 들어감 (실제 오류 재현)', want: 'quotation_line', warn: false, after: true,
    toolbar: `${defaultButton}<button class="se-document-toolbar-select-option-button" data-name="quotation">인용구 열기</button><div class="drop" style="display:none"><button data-value="quotation_line" data-quote="quotation_line">세로선</button></div>`,
    body: '<div class="se-component se-text"><p class="se-text-paragraph">앞 문단 본문</p><p class="se-text-paragraph"><br></p></div>',
    script: `
      const main = document.querySelector('.se-main');
      main.contentEditable = 'true';
      const insert = (style) => {
        const sel = window.getSelection();
        const p = (sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)).closest('p');
        const comp = p.closest('.se-component');
        const box = document.createElement('div');
        box.className = 'se-component se-quotation se-l-' + style;
        box.contentEditable = 'false';
        box.innerHTML = '<p class="se-text-paragraph se-quote-text" contenteditable="true"></p><p class="se-quote-cite" contenteditable="true"></p>';
        const rest = [];
        for (let n = p.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
        // window.EAT: 실제 에디터처럼 인용구를 넣으면서 바로 아래 빈 문단 하나를 먹어 버림
        if (window.EAT) { const i = rest.findIndex((r) => !r.textContent.trim()); if (i >= 0) rest.splice(i, 1)[0].remove(); }
        comp.after(box);
        // window.ALL_ABOVE: 실제 기록(2026-10-03 naver-quote-1790978384655)처럼 인용구가 글 맨 끝에 붙고 빈 문단은 모두 위에 남음
        if (window.ALL_ABOVE) { rest.length = 0; }
        if (rest.length) {
          const next = document.createElement('div');
          next.className = 'se-component se-text';
          rest.forEach((r) => next.appendChild(r));
          box.after(next);
        }
        if (!p.textContent.trim() && !window.ALL_ABOVE) p.remove();
        if (!comp.querySelector('p')) comp.remove();
        box.querySelector('.se-quote-text').focus();
        const drop = document.querySelector('.drop');
        if (drop) drop.style.display = 'none';
      };
      document.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
      document.querySelectorAll('[data-quote]').forEach((b) => b.addEventListener('click', () => insert(b.dataset.quote)));
      document.querySelector('.se-document-toolbar-select-option-button').addEventListener('click', () => { document.querySelector('.drop').style.display = 'block'; });
      // Backspace: 빈 문단에서 누르면 그 문단을 지우고 위 문단 끝으로 갑니다.
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Backspace') return;
        const sel = getSelection();
        const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        const p = node && node.closest('.se-text-paragraph');
        if (!p || p.textContent.length || p.closest('.se-quotation')) return;
        const prev = p.previousElementSibling;
        if (!prev) return;
        e.preventDefault();
        p.remove();
        const r = document.createRange(); r.selectNodeContents(prev); r.collapse(false);
        sel.removeAllRanges(); sel.addRange(r);
      });
      document.addEventListener('keydown', (e) => {
        const box = document.activeElement.closest('.se-quotation');
        if (!box) return;
        if (e.key === 'ArrowDown' || e.key === 'Escape') {
          e.preventDefault();
          if (document.activeElement.classList.contains('se-quote-text')) box.querySelector('.se-quote-cite').focus();
        }
      }, true);
    `,
  },
];
// E: D 와 같은 구조에서, 인용구를 넣을 때 아래 빈 문단 하나를 먹어 버림 (2026-10-03 인용구가 연달아 붙은 실제 그림)
VARIANTS.push({ ...VARIANTS.find((item) => item.id === 'D'), id: 'E', name: '인용구를 넣을 때 아래 빈 문단 하나가 사라짐 → 그래도 인용구 아래로 나와야 함', script: `window.EAT = true;
${VARIANTS.find((item) => item.id === 'D').script}` });

// F: 인용구가 글 맨 끝(아래 문단 없음), ↓ 는 출처 칸, 빈 곳 클릭도 소용없음 — 글 아래 "본문 추가" 단추만 새 문단을 만듦(실제 기록)
const CANVAS = `
  const bottom = document.createElement('button');
  bottom.className = 'se-canvas-bottom-button __edge-area';
  bottom.textContent = '본문 추가';
  document.body.appendChild(bottom);
  bottom.addEventListener('click', () => {
    const next = document.createElement('div');
    next.className = 'se-component se-text';
    next.innerHTML = '<p class="se-text-paragraph" contenteditable="true"><br></p>';
    document.querySelector('.se-main').appendChild(next);
    next.querySelector('p').focus();
  });
`;
const D = VARIANTS.find((item) => item.id === 'D');
VARIANTS.push({ ...D, id: 'F', gapAbove: 1, body: '<div class="se-component se-text"><p class="se-text-paragraph">앞 문단 본문</p><p class="se-text-paragraph"><br></p><p class="se-text-paragraph"><br></p></div>', name: '인용구가 글 맨 끝에 붙고 빈 문단은 위에 남음 → 글 아래 "본문 추가" 단추로 나옴 (실제 기록 2026-10-03)', script: 'window.ALL_ABOVE = true; ' + D.script + CANVAS });
VARIANTS.push({ ...D, id: 'F0', name: '(대조) F 와 같은데 "본문 추가" 단추가 없음 → 실제처럼 빠져나오지 못하는지 확인(실패해야 통과)', expectFail: true, script: 'window.ALL_ABOVE = true; ' + D.script });

const browser = await chromium.launch();
let failed = 0;
console.log('\n=== 모의 DOM 소제목 인용구 모양 검증 ===\n');
for (const variant of VARIANTS) {
  quoteState.disabled = false;
  quoteState.styleWarned = false;
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><body><div class="toolbar">${variant.toolbar}</div><div class="se-main">${variant.body || '<p class="se-text-paragraph" contenteditable="true">본문</p>'}</div><script>${variant.script || SCRIPT}</script></body>`);
  if (variant.body) {
    await page.locator('.se-main p').last().click();
  } else {
    await page.locator('.se-main p').first().focus();
  }
  const logs = [];
  let ok;
  let detail;
  try {
    const result = await insertQuote(page, page.mainFrame(), { text: '아이는 왜 코피가 자주 날까', ...(variant.gapAbove !== undefined ? { gapAbove: variant.gapAbove } : {}) }, (m) => logs.push(m));
    const quote = page.locator('.se-quotation').last();
    const className = await quote.getAttribute('class');
    const text = (await quote.textContent()).trim();
    const warned = logs.some((m) => m.includes('기본 인용구로'));
    ok = result === true && className.includes(`se-l-${variant.want}`) && text === '아이는 왜 코피가 자주 날까' && warned === variant.warn;
    detail = `모양 ${className.replace(/.*se-l-/, '')}, 글자 "${text}", 알림 ${warned ? '있음' : '없음'}`;
    if (variant.after) {
      // 인용구에서 빠져나온 뒤 친 본문이 인용구 밖, 인용구 아래에 들어가야 합니다.
      await page.keyboard.type('다음 본문');
      const placed = await page.evaluate(() => {
        const quote = document.querySelector('.se-quotation');
        const holder = [...document.querySelectorAll('.se-main p')].find((p) => p.textContent.includes('다음 본문'));
        // 인용구 바로 위에 이어진 빈 문단 수
        let above = 0;
        for (let node = quote.previousElementSibling; node && node.matches('.se-text'); node = node.previousElementSibling) {
          const ps = [...node.querySelectorAll('p')].reverse();
          const k = ps.findIndex((p) => p.textContent.trim());
          above += k < 0 ? ps.length : k;
          if (k >= 0) break;
        }
        return { above, inside: Boolean(holder && holder.closest('.se-quotation')), below: Boolean(holder && (quote.compareDocumentPosition(holder) & Node.DOCUMENT_POSITION_FOLLOWING)) };
      });
      const exitFailed = logs.some((m) => m.includes('빠져나오지 못'));
      ok = ok && !placed.inside && placed.below && !exitFailed && (variant.gapAbove === undefined || placed.above === variant.gapAbove);
      detail += `${variant.gapAbove !== undefined ? `, 인용구 위 빈 줄 ${placed.above}(원함 ${variant.gapAbove})` : ''}, 다음 본문 위치: ${placed.inside ? '인용구 안' : placed.below ? '인용구 아래' : '인용구 위/없음'}${exitFailed ? ', 빠져나오기 실패' : ''}`;
    }
  } catch (error) {
    ok = false;
    detail = error.message;
  }
  if (variant.expectFail) {
    ok = !ok; // 대조 변형: 실패해야 이 모의 구조가 실제 오류를 재현한 것입니다.
  }
  if (!ok) failed += 1;
  console.log(`${ok ? '[통과]' : '[실패]'} ${variant.id}. ${variant.name}\n         ${detail}`);
  await page.close();
}
await browser.close();
console.log(`\n${VARIANTS.length}건 중 ${VARIANTS.length - failed}건 통과`);
console.log('통과는 "알려진 구조에서 회귀가 없다"는 뜻입니다. 실제 네이버 동작 보장은 아닙니다.');
process.exit(failed ? 1 : 0);
