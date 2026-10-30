#!/usr/bin/env node
// 글꼴·크기·색 확인과 제목 정렬의 모의 검증. src/naver.js 의 실제 함수를 그대로 부릅니다.
//
//  A. 빈 문단에 미리 켠 서식이 무시됨(출처 줄 11·회색, 태그 기본색, 글꼴 마루부리가 안 들어감) → 친 뒤 확인해 다시 맞춤
//  B. 서식이 처음부터 맞게 들어가면 아무것도 건드리지 않음
//  C. 제목 칸이 가운데 정렬·다른 글꼴 → 왼쪽 정렬·마루부리로 맞춤
// 모의 에디터의 구조(se-fs11, se-ff-nanummaruburi, se-section-align-*)는 기준 완성 글의 구조를 본뜬 것입니다.
// 통과는 "알려진 구조에서 회귀가 없다"는 뜻이며 실제 네이버 동작 보장은 아닙니다.
//
// 사용법: node .claude/skills/naver-selector-repair/scripts/mock-style-test.mjs [프로젝트루트]

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const { chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
const naver = await import(pathToFileURL(path.join(ROOT, 'src', 'naver.js')).href);
const t = naver.__test || {};
for (const name of ['typeBlocks', 'fixTitleStyle', 'readLineStyle', 'focusBodyEnd']) {
  if (typeof t[name] !== 'function') {
    console.error(`src/naver.js 가 __test.${name} 을 내보내지 않습니다.`);
    process.exit(1);
  }
}

const COLORS = ['#000000', '#333333', '#999999', '#00a84b', '#ffffff', '#c2f4db'];
// 실제 네이버 도구 모음 구조(2026-10-02 22:52 기록)를 본뜹니다: 위쪽(property)·옆(contents) 두 벌,
// 버튼 글자에 지금 값("마루부리서체 변경", "15글자 크기 변경"), 서체 메뉴는 열리면 검색칸이 커서를 가져가고 Escape 로 닫히지 않음.
const TOOLBAR = (group) => `
  <li class="se-toolbar-item se-toolbar-item-font-family"><button class="se-font-family-toolbar-button se-${group}-toolbar-label-select-button" data-name="font-family"><span class="label">마루부리</span>서체 변경</button></li>
  <li class="se-toolbar-item se-toolbar-item-font-size"><button class="se-font-size-code-toolbar-button se-${group}-toolbar-label-select-button" data-name="font-size"><span class="label">15</span>글자 크기 변경</button></li>
  <button class="se-bold-toolbar-button" data-name="bold">굵게</button>
  <button class="se-${group}-toolbar-color-picker-button se-font-color-toolbar-button" data-name="font-color">글자색</button>
  <button class="se-property-toolbar-drop-down-button se-align-center-toolbar-button" data-name="align-drop-down-with-justify">정렬</button>`;
const PAGE = (honor, startFont = 'nanumgothic') => `<!doctype html><meta charset="utf-8"><body>
<div class="toolbar" id="property">${TOOLBAR('property')}</div>
<div class="toolbar" id="contents" style="position:absolute;left:950px;top:200px">${TOOLBAR('contents')}</div>
<div class="se-toolbar-layer" id="layer" style="display:none"><input class="se-font-search" placeholder="서체 검색"><ul class="list"></ul></div>
<div class="se-toolbar-layer" id="align-layer" style="display:none">
  <button class="se-toolbar-option-align-left-button">왼쪽 정렬</button>
  <button class="se-toolbar-option-align-center-button">가운데 정렬</button>
</div>
<div class="se-component se-documentTitle"><div class="se-section se-section-documentTitle se-section-align-center">
  <p class="se-text-paragraph" contenteditable="true"><span class="se-fs32 se-ff-nanumgothic">어린이집 첫 등원 준비물</span></p></div></div>
<div class="se-main" contenteditable="true" style="width:900px">
  <div class="se-component se-text"><p class="se-text-paragraph se-text-paragraph-align-center"><br></p></div>
</div>
<script>
  const HONOR = ${honor};
  const FONT_NAME = { nanumgothic: '나눔고딕', nanummaruburi: '마루부리' };
  const pending = { size: 15, font: '${startFont}', color: '#000000' };
  if (HONOR) Object.assign(pending, { color: '#333333' });
  window.menuOpens = 0;
  const layer = document.getElementById('layer');
  let saved = null; // 메뉴를 여는 순간의 커서 위치(실제 에디터처럼 메뉴를 닫으면 되돌림)
  document.querySelectorAll('.toolbar, .se-toolbar-layer').forEach((node) => node.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'INPUT') e.preventDefault(); }));
  const paragraphOf = (node) => (node && (node.nodeType === 1 ? node : node.parentElement))?.closest('.se-text-paragraph');
  const spanAtCaret = () => { const a = getSelection().anchorNode; const el = a && (a.nodeType === 1 ? a : a.parentElement); return el && el.closest && el.closest('span[class*="se-fs"]'); };
  // 버튼 글자를 커서 위치(또는 선택 문단)의 서식으로 갱신합니다.
  const refresh = () => {
    const span = spanAtCaret();
    const font = span ? /se-ff-(\\w+)/.exec(span.className)[1] : pending.font;
    const size = span ? /se-fs(\\d+)/.exec(span.className)[1] : pending.size;
    document.querySelectorAll('.se-font-family-toolbar-button .label').forEach((n) => { n.textContent = FONT_NAME[font] || font; });
    document.querySelectorAll('.se-font-size-code-toolbar-button .label').forEach((n) => { n.textContent = String(size); });
  };
  document.addEventListener('selectionchange', refresh);
  refresh();
  // 선택한 문단의 글자 서식을 바꿉니다. 커서만 있을 때(빈 문단)는 HONOR 가 아니면 크기·색은 무시(실제 오류 흉내), 서체는 적용.
  const apply = (kind, value) => {
    const sel = getSelection();
    if (sel.isCollapsed || !paragraphOf(sel.anchorNode)) { if (HONOR || kind === 'font') pending[kind] = value; refresh(); return; }
    const p = paragraphOf(sel.anchorNode);
    p.querySelectorAll('span').forEach((span) => {
      if (kind === 'size') span.className = span.className.replace(/se-fs\\d+/, 'se-fs' + value);
      if (kind === 'font') span.className = span.className.replace(/se-ff-\\w+/, 'se-ff-' + value);
      if (kind === 'color') span.style.color = value;
    });
    refresh();
  };
  const restore = () => { if (saved) { const p = paragraphOf(saved.startContainer); if (p) p.focus(); getSelection().removeAllRanges(); getSelection().addRange(saved); } };
  const closeLayer = () => { layer.style.display = 'none'; restore(); };
  const open = (items, focusSearch) => {
    if (layer.style.display === 'block') { closeLayer(); return; } // 메뉴 버튼을 다시 누르면 닫힘
    window.menuOpens += 1;
    const sel = getSelection(); saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const list = layer.querySelector('.list');
    list.innerHTML = '';
    items.forEach(([label, attrs, run]) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      if (String(attrs['data-value'] || '').startsWith('fs')) {
        b.innerHTML = '<span class="se-toolbar-option-label">' + label + '</span><span class="se-toolbar-tooltip">' + label + '</span>';
      } else {
        b.textContent = label;
      }
      Object.entries(attrs).forEach(([k, v]) => b.setAttribute(k, v));
      b.onclick = () => { layer.style.display = 'none'; restore(); run(); };
      li.appendChild(b); list.appendChild(li);
    });
    layer.querySelector('input').style.display = focusSearch ? '' : 'none';
    layer.style.display = 'block';
    if (focusSearch) layer.querySelector('input').focus(); // 서체 메뉴는 검색칸이 커서를 가져감
  };
  document.querySelectorAll('.se-font-family-toolbar-button').forEach((b) => { b.onclick = () =>
    open([['나눔고딕', {}, () => apply('font', 'nanumgothic')], ['마루부리', {}, () => apply('font', 'nanummaruburi')]], true); });
  document.querySelectorAll('.se-font-size-code-toolbar-button').forEach((b) => { b.onclick = () =>
    open([11, 13, 15, 16, 19].map((n) => [String(n), { 'data-value': 'fs' + n, 'data-name': 'font-size', 'data-role': 'option', class: 'se-toolbar-option-text-button se-toolbar-option-font-size-code-fs' + n + '-button' }, () => apply('size', n)]), false); });
  document.querySelectorAll('.se-font-color-toolbar-button').forEach((b) => { b.onclick = () =>
    open(${JSON.stringify(COLORS)}.map((c) => ['', { 'data-value': c, class: 'se-color-palette-item', style: 'width:12px;height:12px' }, () => apply('color', c)]), false); });
  const alignLayer = document.getElementById('align-layer');
  document.querySelectorAll('[data-name="align-drop-down-with-justify"]').forEach((b) => { b.onclick = () => { alignLayer.style.display = alignLayer.style.display === 'block' ? 'none' : 'block'; }; });
  const align = (side) => {
    alignLayer.style.display = 'none';
    const p = paragraphOf(getSelection().anchorNode);
    if (!p) return;
    const section = p.closest('.se-section-documentTitle');
    if (section) section.className = section.className.replace(/se-section-align-\\w+/, 'se-section-align-' + side);
    else p.className = p.className.replace(/se-text-paragraph-align-\\w+/, '') + ' se-text-paragraph-align-' + side;
  };
  document.querySelector('.se-toolbar-option-align-left-button').onclick = () => align('left');
  document.querySelector('.se-toolbar-option-align-center-button').onclick = () => align('center');
  // 친 글자는 그때의 서식(pending)으로 span 에 담깁니다.
  document.addEventListener('input', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const p = paragraphOf(getSelection().anchorNode);
    if (!p) return;
    const loose = [...p.childNodes].filter((n) => n.nodeType === 3 && n.textContent);
    if (!loose.length) return;
    const span = document.createElement('span');
    span.className = 'se-fs' + pending.size + ' se-ff-' + pending.font;
    span.style.color = pending.color;
    span.textContent = loose.map((n) => n.textContent).join('');
    loose.forEach((n) => n.remove());
    p.querySelectorAll('br').forEach((br) => br.remove());
    p.appendChild(span);
    const r = document.createRange(); r.selectNodeContents(span); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  // Enter 는 새 문단을 만듭니다(앞 문단 정렬을 이어받음).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'INPUT') return;
    const p = paragraphOf(getSelection().anchorNode);
    if (!p || p.closest('.se-documentTitle')) return;
    e.preventDefault();
    const c = document.createElement('div');
    c.className = 'se-component se-text';
    c.innerHTML = '<p class="' + p.className + '"><br></p>';
    p.closest('.se-component').after(c);
    const r = document.createRange(); r.setStart(c.querySelector('p'), 0); r.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  }, true);
</script></body>`;

const CREDIT = '글, 사진, 영상 ©육박사';
const BODY = '어린이집 준비물은 원마다 달라요.';
const TAGS = '#어린이집준비물 #어린이집등원 #첫등원';
const BLOCKS = [
  { type: 'text', text: CREDIT, size: 11, color: '#999999', align: 'center' },
  { type: 'text', text: BODY, size: 15, align: 'center' },
  { type: 'text', text: TAGS, size: 15, align: 'center', nowrap: true },
];
const toolbar = { fontSize: true, fontColor: true, bold: null };

const lineStyle = (page, text) => page.evaluate((want) => {
  const p = [...document.querySelectorAll('.se-main .se-text-paragraph')].find((node) => node.textContent.includes(want));
  if (!p) return null;
  const spans = [...p.querySelectorAll('span')];
  return {
    count: document.querySelectorAll('.se-main .se-text-paragraph').length,
    size: [...new Set(spans.map((s) => /se-fs(\d+)/.exec(s.className)?.[1]))].join(','),
    font: [...new Set(spans.map((s) => /se-ff-(\w+)/.exec(s.className)?.[1]))].join(','),
    color: [...new Set(spans.map((s) => s.style.color))].join(','),
  };
}, text);

const RGB = { '#999999': 'rgb(153, 153, 153)', '#333333': 'rgb(51, 51, 51)' };
const check = async (page) => {
  const credit = await lineStyle(page, '©육박사');
  const body = await lineStyle(page, '원마다');
  const tags = await lineStyle(page, '#어린이집준비물');
  const ok = credit?.size === '11' && credit.color === RGB['#999999'] && credit.font === 'nanummaruburi'
    && body?.size === '15' && body.color === RGB['#333333'] && body.font === 'nanummaruburi'
    && tags?.size === '15' && tags.color === RGB['#333333'] && tags.font === 'nanummaruburi';
  return { ok, detail: `출처 ${JSON.stringify(credit)} / 본문 ${JSON.stringify(body)} / 태그 ${JSON.stringify(tags)}` };
};

const SCENARIOS = [
  {
    id: 'A', name: '미리 켠 서식이 무시됨 → 친 뒤 확인해 다시 맞춤', honor: false,
    run: async (page, frame, logs) => {
      await t.typeBlocks({ page, frame, blocks: BLOCKS, toolbar, log: (m) => logs.push(m) });
    },
    check,
  },
  {
    id: 'B', name: '서식이 처음부터 맞으면 다시 고치지 않음', honor: true,
    run: async (page, frame, logs) => {
      await t.typeBlocks({ page, frame, blocks: BLOCKS, toolbar, log: (m) => logs.push(m) });
    },
    check: async (page, logs) => {
      const result = await check(page);
      const refixed = logs.some((m) => m.includes('다시 맞췄습니다'));
      return { ok: result.ok && !refixed, detail: `${result.detail}${refixed ? ' / 불필요하게 다시 고침' : ''}` };
    },
  },
  {
    id: 'D', name: '블로그 기본 서체가 이미 마루부리 → 서체 메뉴를 열지 않고, 메뉴가 열린 채 남지 않음', honor: true, startFont: 'nanummaruburi',
    run: async (page, frame, logs) => {
      await t.typeBlocks({ page, frame, blocks: BLOCKS, toolbar, log: (m) => logs.push(m) });
    },
    check: async (page, logs) => {
      const result = await check(page);
      const state = await page.evaluate(() => ({
        opens: window.menuOpens,
        layerOpen: document.getElementById('layer').style.display === 'block',
        searchTyped: document.querySelector('.se-font-search').value,
      }));
      const missed = logs.some((m) => m.includes('다시 입력') || m.includes('찾지 못했습니다'));
      return {
        ok: result.ok && !state.layerOpen && !state.searchTyped && !missed,
        detail: `${result.detail} / 메뉴 연 횟수 ${state.opens}, 메뉴 ${state.layerOpen ? '열린 채 남음' : '닫힘'}, 검색칸 "${state.searchTyped}"`,
      };
    },
  },
  {
    id: 'C', name: '제목 칸 가운데 정렬·나눔고딕 → 왼쪽 정렬·마루부리', honor: false,
    run: async (page, frame, logs) => {
      await t.fixTitleStyle(page, frame, (m) => logs.push(m));
    },
    check: async (page) => {
      const state = await page.evaluate(() => ({
        align: /se-section-align-(\w+)/.exec(document.querySelector('.se-section-documentTitle').className)[1],
        font: /se-ff-(\w+)/.exec(document.querySelector('.se-section-documentTitle span').className)[1],
        text: document.querySelector('.se-section-documentTitle').textContent.trim(),
      }));
      return { ok: state.align === 'left' && state.font === 'nanummaruburi' && state.text === '어린이집 첫 등원 준비물', detail: JSON.stringify(state) };
    },
  },
];

const browser = await chromium.launch();
let failed = 0;
console.log('\n=== 모의 DOM 글꼴·크기·색·제목 정렬 검증 ===\n');
for (const scenario of SCENARIOS) {
  const page = await browser.newPage();
  await page.setContent(PAGE(scenario.honor, scenario.startFont));
  const logs = [];
  let result;
  try {
    await scenario.run(page, page.mainFrame(), logs);
    result = await scenario.check(page, logs);
  } catch (error) {
    result = { ok: false, detail: error.message };
  }
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? '[통과]' : '[실패]'} ${scenario.id}. ${scenario.name}\n         ${result.detail}${logs.length ? `\n         기록: ${logs.map((m) => m.slice(0, 60)).join(' | ')}` : ''}`);
  await page.close();
}
await browser.close();
console.log(`\n${SCENARIOS.length}건 중 ${SCENARIOS.length - failed}건 통과`);
console.log('통과는 "알려진 구조에서 회귀가 없다"는 뜻입니다. 실제 네이버 동작 보장은 아닙니다.');
process.exit(failed ? 1 : 0);
