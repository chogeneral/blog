---
name: electron-ipc-wiring
description: "Electron 앱 껍데기와 Windows 실행 환경 수정 절차. IPC 채널 3단 배선(main.js 핸들러 + preload.cjs 브릿지 + renderer 호출), 에러 메시지 한국어화, 글쓰기.bat 인코딩, .env 설정, 파일 경로를 다룸. bat 파일이 실행 안 됨, 프로그램이 안 켜짐, 한글이 깨짐, 버튼을 눌러도 아무 일이 없음, 에러 메시지가 영어로 나옴, is not recognized as an internal or external command, IPC 채널 추가, 화면에 기능 추가, 새 설정값 추가 요청 시 반드시 이 스킬을 사용할 것. main.js, preload.cjs, renderer/, 글쓰기.bat, src/config.js, .env 수정 시 사용. 후속 작업: bat 다시 고쳐줘, 아직 안 켜진다, 그 버튼만 다시 요청에도 사용."
---

# Electron 앱 껍데기와 실행 환경

IPC 배선, 사용자 노출 메시지, Windows 실행 스크립트를 다룬다.

## bat 파일은 반드시 CP949 로 저장한다

가장 먼저 다룰 내용이다. 이 프로젝트에서 실제로 프로그램이 **시작조차 못 하는** 장애를 일으킨 원인이다.

### 왜 UTF-8 로 저장하면 안 되는가

CMD 는 배치 파일을 **바이트 오프셋으로 위치를 기억하면서** 한 줄씩 읽어 실행한다. 한국어 Windows 의 기본 콘솔 코드페이지는 CP949 다. 파일이 UTF-8 인데 CP949 로 해석하면 한글 한 글자의 바이트 수가 달라 위치 계산이 어긋나고, CMD 는 다음 줄의 **중간 지점**부터 명령으로 해석한다.

실제로 나타난 증상:

```
't' is not recognized as an internal or external command,
'et' is not recognized as an internal or external command,
'[Y' is not recognized as an internal or external command,
```

`set` 의 뒷부분(`et`), `[Y=바로실행...` 의 조각이 명령어로 실행되면서 실제 프로그램 실행 줄까지 도달하지 못했다.

### chcp 로 해결하려 하면 더 나빠진다

`chcp 65001` 을 파일 안에 넣는 것이 흔한 오해다. **파싱 중에 코드페이지를 바꾸는 것이 바로 위치 어긋남의 직접 원인이다.** 2번째 줄에서 코드페이지를 바꾸면 그 이후 모든 줄의 바이트 계산이 틀어진다.

### 올바른 저장 방법

```bash
# UTF-8 → CP949 변환 + chcp 줄 제거
python - <<'EOF'
import pathlib
p = pathlib.Path('글쓰기.bat')
lines = [l for l in p.read_text(encoding='utf-8').splitlines() if not l.lstrip().lower().startswith('chcp ')]
p.write_bytes(('\r\n'.join(lines) + '\r\n').encode('cp949'))
EOF
```

**수정 전에 `.bak` 으로 백업한다.** 인코딩 실수는 파일을 읽을 수 없게 만든다.

검증:

```bash
node .claude/skills/boundary-audit/scripts/boundary-check.mjs
```

bat 인코딩 항목이 UTF-8 한글, BOM, `chcp` 줄을 모두 바이트 단위로 검사한다.

**에디터 설정:** VS Code 우측 하단 인코딩을 `Korean (Windows 949)` 로 맞춘다. 메모장은 "ANSI" 로 저장한다. UTF-8 로 저장하면 같은 증상이 재발한다.

## IPC 는 3단 경계면이다

```
main.js                preload.cjs              renderer/app.js
ipcMain.handle('채널')  ←→  invoke('채널')   ←→   api.메서드()
```

**세 곳의 이름이 모두 맞아야 동작하고, 하나만 틀려도 런타임에 조용히 실패한다.** 버튼을 눌러도 아무 일이 없는 증상의 1순위 원인이다. 채널을 추가·변경할 때는 반드시 세 파일을 함께 수정한다.

채널 추가 체크리스트:

1. `main.js` 에 `ipcMain.handle('채널', async (event, payload) => {...})` 추가
2. `preload.cjs` 의 `exposeInMainWorld` 객체에 `메서드: (payload) => ipcRenderer.invoke('채널', payload)` 추가
3. `renderer/app.js` 에서 `await api.메서드(...)` 호출
4. 대조 스크립트 실행

```bash
node .claude/skills/boundary-audit/scripts/boundary-check.mjs
```

**이름 대조는 통과해도 데이터 모양은 검사되지 않는다.** 핸들러의 `return` 문과 renderer 의 소비 코드를 직접 같이 읽는다. 핸들러가 `{ ok, saved, message }` 를 돌려주는데 renderer 가 `result.success` 를 읽으면 `undefined` 가 된다.

## renderer 는 Node 를 쓸 수 없다

`contextIsolation: true`, `nodeIntegration: false` 가 설정되어 있다. 이것은 보안 설정이므로 **끄지 않는다.**

| 환경 | 쓸 수 있는 것 | 쓸 수 없는 것 |
|---|---|---|
| `main.js`, `src/*.js` | `fs`, `path`, `node:*`, Playwright | DOM, Canvas, `window` |
| `renderer/*.js` | DOM, Canvas, `window`, `api.*` | `fs`, `path`, `require` |

renderer 에서 파일을 읽어야 하면 IPC 채널을 추가한다. 이미지는 base64 dataURL 로 주고받는다 — `renderer/imagelab.js` 가 캔버스로 보정한 결과를 `api.saveImage({ dataUrl })` 로 넘기는 구조다.

## 에러 코드는 한국어로 번역해야 쓸모가 있다

`src/` 모듈이 던지는 `error.message` 는 `main.js` 의 messages 맵에서 한국어 안내로 바뀐다:

```js
const messages = {
  'login-timeout': '네이버 로그인 대기 시간이 지났습니다. ...',
  'editor-not-found': '글쓰기 화면을 열지 못했습니다. ...',
};
const message = messages[error.message] || `네이버 입력에 실패했습니다. (${error.message})`;
```

**맵에 없는 코드는 영어 코드가 그대로 사용자 화면에 노출된다.** 다른 에이전트가 새 에러 코드를 던지면 즉시 맵에 추가한다. 이것이 `app-shell` 로 들어오는 가장 빈번한 요청이다.

대조:

```bash
node .claude/skills/boundary-audit/scripts/boundary-check.mjs
```

## 사용자는 개발자가 아니다

이 프로그램의 사용자는 `글쓰기.bat` 을 더블클릭해서 쓴다. 터미널도, Node 도, Playwright 도 모른다.

**에러 메시지는 무엇을 해야 하는지 알려 준다.**

| 나쁨 | 좋음 |
|---|---|
| `editor-not-found` | `글쓰기 화면을 열지 못했습니다. .env 파일의 NAVER_BLOG_ID 에 블로그 아이디를 적어 주시기 바랍니다.` |
| `ENOENT` | `파일을 찾지 못했습니다. 프로그램을 다시 설치해 주시기 바랍니다.` |
| `title-focus-failed` | `제목 칸을 눌렀지만 커서가 들어가지 않았습니다. 브라우저에 안내 팝업이 떠 있는지 확인하고 닫은 뒤 다시 실행해 주시기 바랍니다.` |

모든 사용자 노출 문장은 `합니다 / 습니다 / 시기 바랍니다` 체로 쓴다. 이것은 글 본문 규칙과 같은 기조다.

**IPC 핸들러는 예외를 던지지 말고 `{ ok: false, message: '한국어 안내' }` 를 돌려준다.** renderer 에서 던진 예외는 사용자에게 보이지 않고 콘솔에만 남는다.

## .env 는 없어도 동작해야 한다

모든 키가 선택 사항이라는 것이 이 앱의 설계다. AI 키가 없으면 내장 글 틀로, 이미지 키가 없으면 Openverse/Picsum 으로 동작한다.

새 환경변수를 추가할 때:

1. 코드에 **기본값**을 둔다 — `Number(process.env.TYPE_DELAY || 8)`
2. `.env.example` 에 주석과 함께 추가한다
3. `.env` 에도 추가해 두 파일을 동기화한다
4. 키 존재 여부를 화면에 표시해야 하면 `config.js` 의 `envStatus()` 에 추가한다

**문서화하지 않은 환경변수는 존재하지 않는 것과 같다.** 사용자가 조절할 수 있는 값인데 `.env.example` 에 없으면 알 길이 없다. 대조 스크립트가 이것을 검사한다.

`loadEnv` 는 이미 `process.env` 에 있는 값을 덮어쓰지 않는다. CLI 인자나 상위 환경이 우선이다.

## 파일 경로는 PATHS 를 쓴다

`src/config.js` 의 `PATHS` 가 모든 경로의 단일 출처다: `root`, `data`, `images`, `drafts`, `profile`, `logs`, `env`.

**하드코딩한 경로는 `글쓰기.bat` 을 다른 폴더에서 실행할 때 깨진다.** `PATHS` 는 모듈 위치 기준(`import.meta.url`)으로 계산하므로 작업 디렉토리와 무관하게 동작한다.

새 폴더를 추가하면 `ensureDirs()` 의 생성 목록에도 넣는다. `main.js` 의 `openFolder(which)` 가 PATHS 키를 인자로 받으므로, 폴더 열기 버튼을 추가할 때 키 이름이 일치해야 한다.

## 검증 절차

```bash
# 1. 문법 (ESM 모듈이므로 import 로 확인)
node -e "import('./src/naver.js').then(()=>console.log('OK')).catch(e=>{console.error(e.message);process.exit(1)})"
node --check main.js

# 2. 경계면 대조 (IPC 3단, 에러 코드, bat 인코딩, 환경변수)
node .claude/skills/boundary-audit/scripts/boundary-check.mjs

# 3. 파이프라인 전체 (브라우저 자동화 없이 글 + 이미지까지)
npx electron . --selftest     # 결과: data/selftest.json

# 4. 앱 화면 구동
npm start
```

`--selftest` 는 글과 이미지를 만들고 결과를 `data/selftest.json` 에 남기고 종료한다. 네이버 로그인 없이 파이프라인을 검증할 수 있는 유일한 경로이므로, renderer 쪽 변경을 확인할 때 활용한다.

**bat 수정은 가능하면 실제로 실행해 파싱 오류가 없는지 본다.** 파싱이 깨지면 메뉴가 출력되는 대신 `is not recognized` 가 쏟아진다.

## 이전 산출물이 있을 때

`_workspace/` 의 이전 산출물을 읽는다. IPC 채널을 이미 추가했다면 중복 추가하지 않는다. 사용자가 화면 문구를 지적했으면 **해당 문장만** 고친다.
