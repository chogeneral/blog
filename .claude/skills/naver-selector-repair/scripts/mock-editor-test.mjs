#!/usr/bin/env node
// 네이버 에디터 구조를 모방한 페이지에서 src/naver.js 의 실제 제목 입력 코드를 시험합니다.
//
// 실제 네이버 에디터는 로그인이 필요해 자동 검증이 불가능합니다. 그래서
// 네이버가 써 왔거나 쓸 수 있는 DOM 변형을 재현해 두고, src/naver.js 가 내보내는
// __test.typeTitle 을 그대로 호출해 제목이 실제로 들어가는지 확인합니다.
//
// 예전 버전은 naver.js 의 로직을 이 파일 안에 따로 베껴 두고 시험했습니다. 그 결과
// 실제 코드가 틀렸는데도 테스트는 통과했습니다. 지금은 실제 코드를 직접 부릅니다.
//
// 한계: 통과는 "알려진 구조에서 회귀가 없다"는 뜻입니다. 네이버가 완전히 새로운
// 구조를 쓰면 여기서 통과해도 실패할 수 있습니다. 실패하면 data/logs 의 덤프를 보고
// 아래 VARIANTS 에 그 구조를 추가하십시오. 변형은 지우지 말고 누적합니다.
//
// 사용법:
//   node .claude/skills/naver-selector-repair/scripts/mock-editor-test.mjs [프로젝트루트]
//   node ... --list          변형 목록만 출력
//   node ... --only=B,G      특정 변형만 실행
// 종료코드: 0 = 전부 통과, 1 = 실패 있음

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const ROOT = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim().toUpperCase()) : null;

const pwPath = path.join(ROOT, 'node_modules', 'playwright', 'index.mjs');
const naverPath = path.join(ROOT, 'src', 'naver.js');
if (!fs.existsSync(pwPath) || !fs.existsSync(naverPath)) {
  console.error(`프로젝트 루트가 아닙니다: ${ROOT}\n(node_modules/playwright 와 src/naver.js 가 있어야 합니다)`);
  process.exit(1);
}

// 같은 이름의 VARIANTS 는 아래에서 정의합니다. 먼저 목록만 보는 경우를 처리합니다.
const EDITABLE = 'style="min-height:40px;width:600px"';

// 스마트에디터 ONE 흉내: 제목 칸에는 contenteditable 이 없고, 화면 구석의 숨은
// 입력칸이 키를 받아 제목 칸에 그려 줍니다. (2026-10 실제 덤프 기준)
const SE_ONE_SCRIPT = `
<div id="se-hidden-input" contenteditable="true"
  style="position:fixed;right:0;top:0;width:17px;height:100%;opacity:0;overflow:hidden"></div>
<script>
(function () {
  var hidden = document.getElementById('se-hidden-input');
  var target = null;
  document.addEventListener('mousedown', function (event) {
    var module = event.target.closest && event.target.closest('.se-module-text');
    if (!module) { return; }
    event.preventDefault();
    target = module;
    hidden.textContent = '';
    hidden.focus();
  }, true);
  hidden.addEventListener('input', function () {
    if (!target) { return; }
    var paragraph = target.querySelector('.se-text-paragraph');
    var text = hidden.textContent;
    paragraph.innerHTML = text ? '' : '<span class="se-placeholder">제목</span>';
    if (text) { paragraph.appendChild(document.createTextNode(text)); }
    target.classList.toggle('se-is-empty', !text);
  });
})();
</script>`;

const SE_ONE_TITLE = `
<div class="se-component se-documentTitle se-l-default">
  <div class="se-section se-section-documentTitle se-l-default se-section-align-center">
    <div class="se-module se-module-text __se-unit se-is-empty se-title-text" style="width:886px;min-height:52px">
      <p class="se-text-paragraph" style="min-height:52px"><span class="se-placeholder">제목</span></p>
    </div>
  </div>
</div>
<div class="se-component se-text">
  <div class="se-section se-section-text">
    <div class="se-module se-module-text" style="min-height:40px">
      <p class="se-text-paragraph" style="min-height:40px"></p>
    </div>
  </div>
</div>`;

// 스마트에디터 ONE 실제 구조 2 (2026-10-01 20:54 덤프): 키를 받는 칸이 같은 문서가 아니라
// 높이 0 짜리 iframe 의 body(contenteditable) 입니다. 이 iframe 에 포커스가 가면
// 바깥 문서의 activeElement 는 IFRAME 요소가 되어 "편집칸에 포커스가 있나" 판정이 실패했습니다.
const SE_ONE_IFRAME_SCRIPT = `
<div contenteditable="true" style="position:fixed;right:0;top:0;width:17px;height:100%;opacity:0"></div>
<iframe id="se-input-buffer" style="position:absolute;left:0;top:0;width:720px;height:0;border:0"></iframe>
<script>
(function () {
  var frame = document.getElementById('se-input-buffer');
  var doc = frame.contentDocument;
  doc.open(); doc.write('<!doctype html><body contenteditable="true"></body>'); doc.close();
  var target = null;
  document.addEventListener('mousedown', function (event) {
    var module = event.target.closest && event.target.closest('.se-module-text');
    if (!module) { return; }
    event.preventDefault();
    target = module;
    document.querySelectorAll('.se-component').forEach(function (n) { n.classList.remove('se-is-selected'); });
    module.closest('.se-component').classList.add('se-is-selected');
    doc.body.textContent = '';
    doc.body.focus();
  }, true);
  doc.body.addEventListener('input', function () {
    if (!target) { return; }
    var paragraph = target.querySelector('.se-text-paragraph');
    var text = doc.body.textContent;
    paragraph.innerHTML = text ? '' : '<span class="se-placeholder">제목</span>';
    if (text) { paragraph.appendChild(document.createTextNode(text)); }
    target.classList.toggle('se-is-empty', !text);
  });
})();
</script>`;

const POPUP = `
<div class="se-popup-dimmed" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"></div>
<div class="se-popup" style="position:fixed;top:30%;left:25%;width:300px;height:150px;background:#fff">
  <p>작성 중이던 글이 있습니다.</p>
  <button class="se-popup-button-cancel">취소</button>
</div>
<script>
document.querySelectorAll('.se-popup-button-cancel').forEach(function (button) {
  button.onclick = function () {
    document.querySelectorAll('.se-popup, .se-popup-dimmed').forEach(function (node) { node.remove(); });
  };
});
</script>`;

const VARIANTS = [
  {
    id: 'A',
    name: '제목 칸 내부에 contenteditable 이 있는 구조',
    html: `<div class="se-section se-section-documentTitle"><div class="se-module se-module-text se-title-text">
      <div contenteditable="true" ${EDITABLE}></div></div></div>`,
  },
  {
    id: 'B',
    name: 'se-documentTitle 자체가 editable',
    html: `<div class="se-documentTitle" contenteditable="true" ${EDITABLE}></div>`,
  },
  {
    id: 'C',
    name: '레거시 textarea.se-title-input',
    html: '<textarea class="se-title-input" style="width:600px;height:40px"></textarea>',
  },
  {
    id: 'D',
    name: 'se-title-text 안의 editable 문단',
    html: `<div class="se-title-text"><p class="se-text-paragraph" contenteditable="true" ${EDITABLE}></p></div>`,
  },
  {
    id: 'E',
    name: '복구 팝업이 화면을 덮은 상태 (A 구조)',
    html: `<div class="se-section se-section-documentTitle"><div class="se-title-text">
      <div contenteditable="true" ${EDITABLE}></div></div></div>${POPUP}`,
  },
  {
    id: 'F',
    name: 'placeholder 만 들어 있는 빈 제목 칸 (A 구조)',
    html: `<div class="se-section se-section-documentTitle"><div class="se-title-text">
      <div contenteditable="true" ${EDITABLE}><span class="se-placeholder">제목</span></div></div></div>`,
  },
  {
    id: 'G',
    name: '스마트에디터 ONE 실제 구조 — 숨은 입력칸이 키를 받음 (2026-10 덤프)',
    html: `${SE_ONE_TITLE}${SE_ONE_SCRIPT}`,
  },
  {
    id: 'H',
    name: '스마트에디터 ONE 실제 구조 + 복구 팝업',
    html: `${SE_ONE_TITLE}${SE_ONE_SCRIPT}${POPUP}`,
  },
  {
    id: 'I',
    name: '스마트에디터 ONE — iframe 입력칸이 키를 받음 (2026-10-01 20:54 덤프)',
    html: `${SE_ONE_TITLE}${SE_ONE_IFRAME_SCRIPT}`,
  },
  {
    id: 'J',
    name: '스마트에디터 ONE — iframe 입력칸 + 복구 팝업',
    html: `${SE_ONE_TITLE}${SE_ONE_IFRAME_SCRIPT}${POPUP}`,
  },
];

if (args.includes('--list')) {
  VARIANTS.forEach((v) => console.log(`${v.id}. ${v.name}`));
  process.exit(0);
}

const targets = only ? VARIANTS.filter((v) => only.includes(v.id)) : VARIANTS;
if (targets.length === 0) {
  console.error(`--only 로 지정한 변형을 찾지 못했습니다: ${only.join(', ')}`);
  process.exit(1);
}

const { chromium } = await import(pathToFileURL(pwPath).href);
const naver = await import(pathToFileURL(naverPath).href);
if (!naver.__test || typeof naver.__test.typeTitle !== 'function') {
  console.error('src/naver.js 가 __test.typeTitle 을 내보내지 않습니다. 이 테스트는 실제 코드를 직접 부릅니다.');
  process.exit(1);
}
const { typeTitle, readTitleText } = naver.__test;

const SAMPLE = '가을 등산 준비물 체크리스트';

console.log(`\n실제 코드(src/naver.js 의 typeTitle)를 변형 ${targets.length}개에서 시험합니다.\n`);

const browser = await chromium.launch();
const results = [];

for (const variant of targets) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><body>${variant.html}</body>`);
  const logs = [];
  try {
    await typeTitle(page, page.mainFrame(), SAMPLE, (message) => logs.push(message));
    const text = await readTitleText(page.mainFrame());
    results.push(text.includes(SAMPLE)
      ? { variant, status: 'pass', detail: logs.find((m) => m.includes('제목 칸을 찾았습니다')) || '입력 확인' }
      : { variant, status: 'fail', detail: `에러는 없었지만 제목 칸 글자가 "${text.trim()}"` });
  } catch (error) {
    results.push({ variant, status: 'fail', detail: `${error.message} — ${logs.slice(-1)[0] || ''}` });
  }
  await page.close();
}

await browser.close();

console.log('=== 모의 DOM 제목 입력 검증 ===\n');
results.forEach(({ variant, status, detail }) => {
  console.log(`${status === 'pass' ? '[통과]' : '[실패]'} ${variant.id}. ${variant.name}`);
  console.log(`         ${detail}`);
});
const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length}건 중 ${results.length - failed.length}건 통과`);
console.log('\n통과는 "알려진 구조에서 회귀가 없다"는 뜻입니다. 실제 네이버 동작 보장은 아닙니다.');
process.exit(failed.length ? 1 : 0);
