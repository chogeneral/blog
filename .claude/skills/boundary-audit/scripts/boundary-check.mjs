#!/usr/bin/env node
// 모듈 경계면을 자동 대조합니다.
// 생산자와 소비자가 "같은 것을 가리키는지"만 봅니다. 존재 여부는 확인하지 않습니다.
//
// 사용법: node .claude/skills/boundary-audit/scripts/boundary-check.mjs [프로젝트루트]
// 종료코드: 0 = 전부 통과, 1 = 불일치 있음

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || process.cwd();
const read = (rel) => {
  const file = path.join(ROOT, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};
const all = (text, re) => [...String(text ?? '').matchAll(re)].map((m) => m[1]);
const uniq = (list) => [...new Set(list)].sort();
const diff = (a, b) => a.filter((item) => !b.includes(item));

const results = [];
const check = (name, { left, right, leftLabel, rightLabel, note }) => {
  if (left.length === 0 && right.length === 0) {
    results.push({ name, status: 'skip', detail: '양쪽 모두 비어 있어 건너뜀' });
    return;
  }
  const onlyLeft = diff(left, right);
  const onlyRight = diff(right, left);
  if (onlyLeft.length === 0 && onlyRight.length === 0) {
    results.push({ name, status: 'pass', detail: `${left.length}개 일치`, note });
    return;
  }
  const lines = [];
  if (onlyLeft.length) lines.push(`${leftLabel} 에만 있음: ${onlyLeft.join(', ')}`);
  if (onlyRight.length) lines.push(`${rightLabel} 에만 있음: ${onlyRight.join(', ')}`);
  results.push({ name, status: 'fail', detail: lines.join(' / '), note });
};

const mainSrc = read('main.js') || '';
const preloadSrc = read('preload.cjs') || '';
const rendererSrc = read('renderer/app.js') || '';

// ---------- 1. IPC 채널: main.js 핸들러 ↔ preload.cjs invoke ----------
check('IPC 채널 (main.js 핸들러 ↔ preload.cjs invoke)', {
  left: uniq(all(mainSrc, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)),
  right: uniq(all(preloadSrc, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)),
  leftLabel: 'main.js(핸들러)',
  rightLabel: 'preload.cjs(invoke)',
  note: 'preload 에만 있으면 핸들러가 없어 런타임 실패. main 에만 있으면 죽은 핸들러',
});

// ---------- 2. preload 노출 API ↔ renderer 사용 ----------
const bridgeBlock = /exposeInMainWorld\([^,]+,\s*\{([\s\S]*?)\n\}\s*\)/.exec(preloadSrc);
const exposed = bridgeBlock ? uniq(all(bridgeBlock[1], /^\s*([A-Za-z_$][\w$]*)\s*:/gm)) : [];
const usedInRenderer = uniq([
  ...all(rendererSrc, /\bapi\.([A-Za-z_$][\w$]*)\s*\(/g),
  ...all(read('renderer/imagelab.js') || '', /\bapi\.([A-Za-z_$][\w$]*)\s*\(/g),
]);
check('화면 API (preload.cjs 노출 ↔ renderer 사용)', {
  left: exposed,
  right: usedInRenderer,
  leftLabel: 'preload.cjs(노출)',
  rightLabel: 'renderer(사용)',
  note: 'renderer 에만 있으면 undefined 호출로 즉시 실패. preload 에만 있으면 미사용 API',
});

// ---------- 3. 에러 코드: src throw ↔ main.js 한국어 메시지 맵 ----------
// kebab-case 한 덩어리만 코드로 봅니다. 한국어 문장은 사용자 메시지이므로 제외합니다.
const srcDir = path.join(ROOT, 'src');
const srcFiles = fs.existsSync(srcDir)
  ? fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`)
  : [];
const thrownCodes = uniq(srcFiles.flatMap((rel) => all(
  read(rel) || '',
  /throw new Error\(\s*['"]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)['"]\s*\)/g,
)));
const messagesBlock = /const messages = \{([\s\S]*?)\n\s*\};/.exec(mainSrc);
const mappedCodes = messagesBlock ? uniq(all(messagesBlock[1], /['"]([a-z][a-z0-9-]*)['"]\s*:/g)) : [];
check('에러 코드 (src throw ↔ main.js 한국어 메시지 맵)', {
  left: thrownCodes,
  right: mappedCodes,
  leftLabel: 'src(던지는 코드)',
  rightLabel: 'main.js(맵)',
  note: '맵에 없는 코드는 영어가 그대로 사용자 화면에 노출됨',
});

// ---------- 4. 블록 타입: blocks.js 생산 ↔ 소비자 ----------
// 'text' 는 기본 분기로 처리되므로 명시적 비교가 없어도 정상입니다.
const blocksSrc = read('src/blocks.js') || '';
const naverSrc = read('src/naver.js') || '';
const IMPLICIT = ['text'];
const producedTypes = diff(uniq(all(blocksSrc, /\btype:\s*['"]([a-z]+)['"]/g)), IMPLICIT);
check('블록 타입 (blocks.js 생산 ↔ naver.js 입력)', {
  left: producedTypes,
  right: uniq(all(naverSrc, /block\.type\s*===\s*['"]([a-z]+)['"]/g)),
  leftLabel: 'blocks.js(생산)',
  rightLabel: 'naver.js(처리)',
  note: '처리 누락 시 블록이 에러 없이 조용히 사라짐',
});
check('블록 타입 (blocks.js 생산 ↔ blocksToHtml 미리보기)', {
  left: producedTypes,
  right: uniq(all(blocksSrc, /block\.type\s*===\s*['"]([a-z]+)['"]/g)),
  leftLabel: 'blocks.js(생산)',
  rightLabel: 'blocksToHtml(처리)',
  note: '미리보기와 붙여넣기 HTML 이 같은 함수를 쓰므로 누락 시 양쪽이 틀어짐',
});

// ---------- 5. 폴더 키: main.js openFolder → config.js PATHS ----------
const configSrc = read('src/config.js') || '';
const pathsBlock = /const PATHS = \{([\s\S]*?)\n\};/.exec(configSrc);
const pathKeys = pathsBlock ? uniq(all(pathsBlock[1], /^\s*([a-z][\w]*)\s*:/gm)) : [];
const openFolderBlock = /ipcMain\.handle\(\s*['"]open:folder['"][\s\S]*?\n\}\);/.exec(mainSrc);
const usedPathKeys = openFolderBlock ? uniq(all(openFolderBlock[0], /PATHS\.([a-z][\w]*)/g)) : [];
const badPathKeys = diff(usedPathKeys, pathKeys);
results.push(badPathKeys.length === 0
  ? {
    name: '폴더 경로 키 (main.js openFolder → config.js PATHS)',
    status: 'pass',
    detail: `${usedPathKeys.length}개 모두 PATHS 에 존재`,
  }
  : {
    name: '폴더 경로 키 (main.js openFolder → config.js PATHS)',
    status: 'fail',
    detail: `PATHS 에 없는 키 참조: ${badPathKeys.join(', ')}`,
    note: '폴더 열기 버튼이 undefined 경로로 실패',
  });

// ---------- 6. 환경변수: src 참조 ↔ .env.example ----------
const envExample = read('.env.example');
if (envExample === null) {
  results.push({ name: '환경변수 (src 참조 ↔ .env.example)', status: 'skip', detail: '.env.example 없음' });
} else {
  const exampleKeys = uniq(all(envExample, /^\s*([A-Z][A-Z0-9_]*)\s*=/gm));
  const referenced = uniq([...srcFiles, 'main.js'].flatMap((rel) => all(read(rel) || '', /process\.env\.([A-Z][A-Z0-9_]*)/g)));
  const missing = diff(referenced, exampleKeys);
  results.push(missing.length === 0
    ? {
      name: '환경변수 (src 참조 ↔ .env.example)',
      status: 'pass',
      detail: `참조 ${referenced.length}개 모두 .env.example 에 문서화됨`,
    }
    : {
      name: '환경변수 (src 참조 ↔ .env.example)',
      status: 'fail',
      detail: `.env.example 에 없음: ${missing.join(', ')}`,
      note: '사용자가 설정 가능한 값이면 .env.example 에 추가',
    });
}

// ---------- 7. bat 파일 인코딩 ----------
// CP949 한글은 0xB0-0xC8 대역, UTF-8 한글은 0xEA-0xED 선행 바이트입니다.
const batName = fs.readdirSync(ROOT).find((f) => f.toLowerCase().endsWith('.bat'));
if (!batName) {
  results.push({ name: 'bat 인코딩', status: 'skip', detail: '.bat 파일 없음' });
} else {
  const bytes = fs.readFileSync(path.join(ROOT, batName));
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let utf8Hangul = 0;
  for (let i = 0; i < bytes.length - 2; i += 1) {
    const lead = bytes[i];
    const mid = bytes[i + 1];
    const tail = bytes[i + 2];
    if (lead >= 0xea && lead <= 0xed && mid >= 0x80 && mid <= 0xbf && tail >= 0x80 && tail <= 0xbf) {
      utf8Hangul += 1;
    }
  }
  const hasChcp = /^[ \t]*chcp[ \t]/mi.test(bytes.toString('latin1'));
  const problems = [];
  if (utf8Hangul > 0) {
    problems.push(`UTF-8 한글 ${utf8Hangul}자 감지 — CP949 로 저장해야 함`);
  }
  if (hasBom) {
    problems.push('UTF-8 BOM 있음');
  }
  if (hasChcp) {
    problems.push('chcp 줄 있음 — 파싱 중 코드페이지 변경은 바이트 위치 어긋남을 유발');
  }
  results.push(problems.length === 0
    ? { name: `bat 인코딩 (${batName})`, status: 'pass', detail: 'CP949 저장, chcp 없음' }
    : {
      name: `bat 인코딩 (${batName})`,
      status: 'fail',
      detail: problems.join(' / '),
      note: 'CMD 가 줄 중간부터 실행해 프로그램이 시작조차 못 함',
    });
}

// ---------- 출력 ----------
const mark = { pass: '[통과]', fail: '[실패]', skip: '[건너뜀]' };
console.log('\n=== 경계면 교차 검증 ===\n');
results.forEach((item) => {
  console.log(`${mark[item.status]} ${item.name}`);
  console.log(`         ${item.detail}`);
  if (item.status === 'fail' && item.note) {
    console.log(`         -> ${item.note}`);
  }
});
const failed = results.filter((item) => item.status === 'fail');
const passed = results.filter((item) => item.status === 'pass');
const skipped = results.filter((item) => item.status === 'skip');
console.log(`\n통과 ${passed.length} / 실패 ${failed.length} / 건너뜀 ${skipped.length}`);
console.log('\n이 스크립트는 알려진 경계면만 봅니다. 이번 변경이 새 경계면을 만들었는지는 직접 읽어 확인하십시오.');
process.exit(failed.length ? 1 : 0);
