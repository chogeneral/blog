#!/usr/bin/env node
// 본문 정렬 모의 검증. src/naver.js 의 실제 finishAlign 을 그대로 부릅니다.
//
// 블로그 "기본 정렬"이 본문과 다른 상태(문단에 se-text-paragraph-align-* 클래스)를 흉내 내고,
// 정렬 버튼이 툴바에 바로 있는 경우 / 드롭다운 안에 있는 경우 / 아예 없는 경우를 시험합니다.
// 통과는 "알려진 구조에서 회귀가 없다"는 뜻이며 실제 네이버 동작 보장은 아닙니다.
//
// 사용법: node .claude/skills/naver-selector-repair/scripts/mock-align-test.mjs [프로젝트루트]

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const { chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
const naver = await import(pathToFileURL(path.join(ROOT, 'src', 'naver.js')).href);
const { finishAlign, countMisaligned } = naver.__test || {};
if (typeof finishAlign !== 'function') {
  console.error('src/naver.js 가 __test.finishAlign 을 내보내지 않습니다.');
  process.exit(1);
}

// 정렬 버튼을 누르면 선택 범위에 걸친 본문 문단(없으면 마지막 문단)의 정렬 클래스를 바꿉니다.
const SCRIPT = `
  const setSide = (side) => {
    const sel = window.getSelection();
    const all = [...document.querySelectorAll('.se-main .se-text-paragraph')];
    const hit = all.filter((p) => sel.rangeCount && sel.getRangeAt(0).intersectsNode(p));
    (hit.length ? hit : all.slice(-1)).forEach((p) => {
      p.className = p.className.replace(/\\s*se-text-paragraph-align-\\w+/g, '') + ' se-text-paragraph-align-' + side;
    });
  };
  document.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  document.querySelectorAll('[data-name="align"][data-value]').forEach((b) => b.addEventListener('click', () => setSide(b.dataset.value)));
  const toggle = document.querySelector('[data-name="align-drop-down-with-justify"]');
  if (toggle) toggle.addEventListener('click', () => { document.querySelector('.drop').style.display = 'block'; });
`;

const body = (n) => Array.from({ length: n }, (_, i) => `<div class="se-component se-text"><p class="se-text-paragraph se-text-paragraph-align-center"><span>본문 ${i + 1}</span></p></div>`).join('');
const title = '<div class="se-section-documentTitle"><p class="se-text-paragraph se-text-paragraph-align-center">제목</p></div>';
const dropdown = '<button data-name="align-drop-down-with-justify">정렬</button><div class="drop" style="display:none"><button data-name="align" data-value="left">왼쪽 정렬</button><button data-name="align" data-value="center">가운데 정렬</button></div>';

const VARIANTS = [
  {
    id: 'A', name: '툴바에 왼쪽 정렬 버튼이 바로 있음', expect: true,
    html: `<div class="toolbar"><button data-name="align" data-value="left" class="se-align-left-toolbar-button">왼쪽</button></div>${title}<div class="se-main" contenteditable="true">${body(4)}</div>`,
  },
  {
    id: 'B', name: '정렬 드롭다운 안에 왼쪽 정렬 버튼', expect: true,
    html: `<div class="toolbar">${dropdown}</div>${title}<div class="se-main" contenteditable="true">${body(4)}</div>`,
  },
  {
    id: 'C', name: '이미 왼쪽 정렬 (아무것도 누르지 않아야 함)', expect: true,
    html: `${title}<div class="se-main" contenteditable="true"><p class="se-text-paragraph">본문</p></div>`,
  },
  {
    id: 'E', name: '여는 부분(가운데 제목·출처)은 그대로, 본문만 왼쪽', expect: true,
    keep: ['41개월 아이 대근육 발달', '글, 사진, 영상 ©육박사'],
    html: `<div class="toolbar"><button data-name="align" data-value="left">왼쪽</button></div>${title}<div class="se-main" contenteditable="true"><p class="se-text-paragraph se-text-paragraph-align-center">41개월 아이 대근육 발달</p><p class="se-text-paragraph se-text-paragraph-align-center">글, 사진, 영상 ©육박사</p>${body(3)}</div>`,
    check: async (page) => (await page.locator('.se-main .se-text-paragraph-align-center').count()) === 2,
  },
  {
    id: 'F', name: '블로그 기본 정렬이 왼쪽 → 본문을 가운데로 (제목 칸은 그대로)', expect: true, side: 'center',
    html: `<div class="toolbar">${dropdown}</div>${title}<div class="se-main" contenteditable="true"><p class="se-text-paragraph">본문 1</p><p class="se-text-paragraph">본문 2</p><p class="se-text-paragraph se-text-paragraph-align-left">본문 3</p></div>`,
    check: async (page) => (await page.locator('.se-main .se-text-paragraph-align-center').count()) === 3,
  },
  {
    id: 'G', name: '이미 가운데 정렬 + 빈 줄 (아무것도 누르지 않아야 함)', expect: true, side: 'center',
    html: `${title}<div class="se-main" contenteditable="true">${body(3)}<p class="se-text-paragraph"></p></div>`,
  },
  {
    id: 'H', name: '본문은 가운데로, 세로선 인용구 소제목은 왼쪽 그대로', expect: true, side: 'center',
    html: `<div class="toolbar">${dropdown}</div>${title}<div class="se-main" contenteditable="true"><div class="se-component se-quotation se-l-quotation_line"><p class="se-text-paragraph">아이는 왜 코피가 자주 날까</p></div><p class="se-text-paragraph">본문 1</p></div>`,
    check: async (page) => !/align-center/.test(await page.locator('.se-quotation p').getAttribute('class'))
      && (await page.locator('.se-main > p.se-text-paragraph-align-center').count()) === 1,
  },
  {
    id: 'D', name: '정렬 버튼이 없음 → 실패를 알리고 멈추지 않아야 함', expect: false,
    html: `${title}<div class="se-main" contenteditable="true">${body(2)}</div>`,
  },
];

const browser = await chromium.launch();
let failed = 0;
console.log('\n=== 모의 DOM 본문 정렬 검증 ===\n');
for (const variant of VARIANTS) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><body>${variant.html}<script>${SCRIPT}</script></body>`);
  const logs = [];
  let detail;
  let ok;
  try {
    const keep = variant.keep || [];
    const side = variant.side || 'left';
    const result = await finishAlign(page, page.mainFrame(), (m) => logs.push(m), { side, keep });
    const left = await countMisaligned(page.mainFrame(), keep, side);
    const titleKept = await page.locator('.se-section-documentTitle p').getAttribute('class');
    ok = result === variant.expect && (variant.expect ? left === 0 : left > 0) && /align-center/.test(titleKept)
      && (!variant.check || await variant.check(page));
    detail = `목표 ${side}, 결과 ${result}, 남은 어긋난 문단 ${left}개, 제목 정렬 ${/align-center/.test(titleKept) ? '유지' : '바뀜'}${logs.length ? ` — ${logs.slice(-1)[0].slice(0, 60)}` : ''}`;
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
console.log('통과는 "알려진 구조에서 회귀가 없다"는 뜻입니다. 실제 네이버 동작 보장은 아닙니다.');
process.exit(failed ? 1 : 0);
