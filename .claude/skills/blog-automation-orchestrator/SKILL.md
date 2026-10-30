---
name: blog-automation-orchestrator
description: "네이버 블로그 자동화 앱(D:\\블로그\\자동화)의 개발·유지보수 에이전트 팀을 조율하는 오케스트레이터. 이 앱이 안 켜진다, 실행이 안 된다, 에러가 난다, 고쳐줘, 기능 추가해줘, 글이 이상하다, 사진이 안 맞다, 네이버 입력 실패, 버튼이 동작 안 함, 임시저장 안 됨, 여러 모듈을 같이 손봐야 하는 작업 요청 시 반드시 이 스킬을 사용할 것. 후속 작업: 다시 실행, 재실행, 또 깨졌어, 아직 안 된다, 업데이트, 수정, 보완, 이전 결과 개선, 그 부분만 다시, 검증만 다시 요청에도 반드시 사용. 코드를 읽지 않고 답할 수 있는 단순 질문은 직접 응답해도 된다."
---

# 블로그 자동화 앱 개발 오케스트레이터

## 실행 모드: 에이전트 팀

2명 이상이 협업하고, **경계면 이슈를 생산자·소비자 양쪽 에이전트에게 동시 통보**해야 하므로 팀 모드를 쓴다. 한쪽만 고치면 반대쪽이 다시 깨진다.

아키텍처 패턴: **전문가 풀 + 생성-검증** (복합). 작업마다 영향 영역이 다르므로 영향 범위를 먼저 진단해 해당 전문가만 팀에 투입하고, `qa-verifier` 는 항상 포함한다.

## 에이전트 구성

| 팀원 | 타입 | 담당 영역 | 스킬 |
|---|---|---|---|
| `naver-automation` | 커스텀 | `src/naver.js` — Playwright, 셀렉터, 임시저장 | `naver-selector-repair` |
| `content-engine` | 커스텀 | `src/content.js`, `topics.js`, `style.js`, `blocks.js`, `gemini.js`, `ollama.js`, `research.js` | `blog-content-rules` |
| `image-pipeline` | 커스텀 | `src/images.js`, `renderer/imagelab.js` | (에이전트 정의에 인라인) |
| `app-shell` | 커스텀 | `main.js`, `preload.cjs`, `renderer/`, `글쓰기.bat`, `src/config.js`, `.env` | `electron-ipc-wiring` |
| `qa-verifier` | 커스텀 | 경계면 교차 검증, 모의 DOM, 회귀 — **항상 포함** | `boundary-audit` |

모든 `Agent` / `TeamCreate` 호출에 `model: "opus"` 를 명시한다.

## 워크플로우

### Phase 0: 컨텍스트 확인

`_workspace/` 존재 여부로 실행 모드를 가른다.

| 상태 | 모드 | 행동 |
|---|---|---|
| `_workspace/` 없음 | **초기 실행** | Phase 1 로 진행 |
| 있음 + 사용자가 부분 수정 요청 ("아직 어색하다", "그 부분만 다시") | **부분 재실행** | 해당 에이전트만 재호출. 이전 산출물 경로를 프롬프트에 포함해 읽고 개선하도록 지시 |
| 있음 + 새 증상/새 요청 | **새 실행** | `_workspace/` → `_workspace_{YYYYMMDD_HHMMSS}/` 로 이동한 뒤 Phase 1 |

부분 재실행에서는 **이전에 시도했다가 실패한 접근을 반복하지 않도록** 이전 `_workspace/*_fix.md` 와 `*_qa-verifier_report.md` 를 에이전트에게 함께 읽히게 한다. 이전 리포트의 **실패** 항목이 해결되었는지, **검증 불가** 항목이 여전히 검증 불가인지 확인한다.

### Phase 1: 영향 범위 진단

**팀을 만들기 전에 리더가 직접 진단한다.** 전문가를 전원 투입하면 조율 오버헤드만 늘고 품질은 오르지 않는다.

1. 증상과 에러 메시지 전문을 수집한다. 사용자가 에러를 일부만 붙였으면 전문을 요청한다 — 타임아웃 값과 스택이 실패 지점을 특정한다
2. 증거를 찾는다:
   - `data/logs/naver-dom-*.json` — 셀렉터 실패 시점의 실제 DOM
   - `data/drafts/` — 직전 초안 (글 품질 문제)
   - `data/images/` — 직전 이미지 (사진 문제)
   - `data/selftest.json` — 파이프라인 자체 점검 결과
3. 베이스라인을 기록한다. **수정 전에 현재 상태를 먼저 측정한다** — 무엇이 이미 깨져 있었고 무엇을 이번에 깨뜨렸는지 구분하기 위해서다:

```bash
node .claude/skills/boundary-audit/scripts/boundary-check.mjs
node .claude/skills/naver-selector-repair/scripts/mock-editor-test.mjs
```

4. `_workspace/` 를 만들고 `_workspace/00_input/` 에 증상·에러 전문·베이스라인 결과를 저장한다

### 영향 범위 → 팀 구성 매핑

| 증상 | 투입 전문가 |
|---|---|
| `locator.click Timeout`, `editor-not-found`, `title-*-failed`, 임시저장 실패, 서식 안 들어감 | `naver-automation` |
| 글이 짧다/반복적/문체 어색, 소제목 겹침, 태그·색·크기 틀림 | `content-engine` |
| 사진이 주제와 안 맞음, 이미지 안 받아짐, 어둡다 | `image-pipeline` |
| bat 실행 안 됨, 한글 깨짐, 안 켜짐, 버튼 무반응, 에러가 영어로 나옴 | `app-shell` |
| 새 에러 코드가 추가되는 모든 작업 | `app-shell` **추가 투입** (한국어 메시지 맵) |
| 블록 타입·초안 shape 이 바뀌는 작업 | `content-engine` + `naver-automation` **동시 투입** |
| 증상이 모호하거나 어디서 깨졌는지 모를 때 | `qa-verifier` 먼저 단독 투입 → 리포트로 범위 확정 후 재구성 |

팀 크기는 **전문가 1~4 + `qa-verifier` 1 = 2~5명.** 3명의 집중된 팀원이 5명의 산만한 팀원보다 낫다.

### Phase 2: 팀 구성

```
TeamCreate(
  team_name: "blog-automation-team",
  members: [
    { name: "<전문가>", agent_type: "<해당 커스텀 타입>", model: "opus",
      prompt: "증상: ... / 증거 파일: _workspace/00_input/... / 담당: <파일> / 수정 후 반드시 <스킬>의 검증 절차를 거치고 qa-verifier 에게 검증 요청" },
    { name: "qa-verifier", agent_type: "qa-verifier", model: "opus",
      prompt: "베이스라인: _workspace/00_input/baseline.txt / 각 전문가 수정 직후 점진적으로 검증 / 리포트는 통과·실패·검증불가 세 갈래" }
  ]
)
```

작업 등록:

```
TaskCreate(tasks: [
  { title: "<영역> 진단", assignee: "<전문가>" },
  { title: "<영역> 수정", assignee: "<전문가>", depends_on: ["<영역> 진단"] },
  { title: "<영역> 경계면 검증", assignee: "qa-verifier", depends_on: ["<영역> 수정"] },
  { title: "회귀 확인", assignee: "qa-verifier", depends_on: [<모든 수정>] }
])
```

### Phase 3: 수정 + 점진 검증

팀원들이 공유 작업 목록에서 작업을 요청해 수행한다.

**통신 규칙:**

| 발신 | 수신 | 내용 |
|---|---|---|
| `naver-automation` | `app-shell` | 신규 에러 코드 → 한국어 메시지 맵 추가 요청 |
| `content-engine` | `naver-automation` | `block.type` 변경 |
| `content-engine` | `app-shell` | `normalizeDraft` 출력 shape 변경 |
| `image-pipeline` | `content-engine` | `TOPIC_HINTS` 수정 (공유 파일, 충돌 방지) |
| 모든 전문가 | `qa-verifier` | 수정 완료 + 검증 요청 (변경 파일 + 자체 검증 결과 첨부) |
| `qa-verifier` | 생산자·소비자 **양쪽** | 경계면 불일치 (파일:라인 + 수정 방법) |

**`qa-verifier` 는 전체 완성 후가 아니라 각 수정 직후에 검증한다.** 버그가 누적되면 수정 비용이 커지고 초기 불일치가 후속 수정에 전파된다.

**산출물:**

| 팀원 | 경로 |
|---|---|
| 전문가 | `_workspace/{phase}_{팀원}_fix.md` |
| `qa-verifier` | `_workspace/{phase}_qa-verifier_report.md` |

**리더 모니터링:** 팀원 유휴 알림을 받으면 `TaskGet` 으로 진행률을 확인한다. 막힌 팀원에게는 증거를 더 주거나(DOM 덤프 등) 작업을 재할당한다.

### Phase 4: 통합 검증

1. `TaskGet` 으로 모든 작업 완료를 확인한다
2. 각 산출물을 `Read` 로 수집한다
3. 리더가 직접 전체 검증을 돌려 **Phase 1 베이스라인과 비교한다**:

```bash
node .claude/skills/boundary-audit/scripts/boundary-check.mjs
node .claude/skills/naver-selector-repair/scripts/mock-editor-test.mjs
node -e "import('./src/naver.js').then(()=>console.log('OK')).catch(e=>{console.error(e.message);process.exit(1)})"
```

4. 베이스라인에 없던 실패가 생겼으면 **회귀다.** 해당 에이전트에게 돌려보낸다
5. 최종 보고를 작성한다

### Phase 5: 정리

1. 팀원에게 종료 요청 → `TeamDelete`
2. `_workspace/` 는 **보존한다** (사후 검증·감사 추적)
3. 사용자에게 보고한다

## 사용자 보고 원칙

사용자는 개발자가 아니다. `글쓰기.bat` 을 더블클릭해 쓰는 사람이다.

**반드시 포함할 것:**
- 원인을 한 문단으로 — 무엇이 어긋나 있었는지
- 조치 목록 — 파일별로 무엇을 바꿨는지
- 검증 결과 — 실제 실행한 명령과 그 출력
- **검증하지 못한 것** — 명시적으로. 이 프로젝트에는 구조적으로 검증 불가인 영역이 있다 (실제 네이버 DOM: 로그인 필요 / 캔버스 보정 품질: 눈으로만 판단 / 외부 API 응답: 네트워크·키 의존)

**하지 말 것:**
- 모의 DOM 통과를 "실제로 동작합니다"로 바꿔 쓰기. 그것은 "회귀가 없다"는 뜻이다
- 검증 안 한 항목을 보고에서 생략하기. 통과한 것처럼 읽힌다
- 영어 에러 코드를 그대로 보여 주기

## 데이터 흐름

```
[리더: 영향 범위 진단 + 베이스라인 측정]
        ↓ TeamCreate / TaskCreate
[전문가 1..N] ←── SendMessage (경계면 통보) ──→ [qa-verifier]
        ↓                                            ↓
  *_fix.md                                   *_report.md
        └──────────── Read ──────────────────────────┘
                       ↓
        [리더: 베이스라인 대비 회귀 확인]
                       ↓
                 사용자 보고
```

## 에러 핸들링

| 상황 | 전략 |
|---|---|
| 전문가 1명 실패/중지 | `SendMessage` 로 상태 확인 → 1회 재시작. 재실패 시 그 영역 미수정으로 진행하고 보고에 명시 |
| 전문가 과반 실패 | 사용자에게 알리고 진행 여부를 확인 |
| 증거(DOM 덤프) 없음 | 추측으로 고치지 않는다. 사용자에게 재현을 요청하고, 덤프가 필요 없는 다른 영역을 먼저 진행 |
| 검증 스크립트 실패 | 스크립트 자체의 버그일 수 있다. 수동 대조로 교차 확인 후 판정 |
| 수정이 회귀를 만듦 | 되돌리지 말고 해당 에이전트에게 회귀 내용을 보내 재수정. 되돌리면 원래 증상이 돌아온다 |
| 두 에이전트가 같은 파일 수정 | `TOPIC_HINTS` 가 대표적. 한쪽을 먼저 끝내고 다음에게 결과를 읽히게 순서를 강제 |
| 계약 충돌 (어느 쪽이 옳은지 불명) | `qa-verifier` 가 임의로 정하지 않는다. 리더가 사용자에게 의도를 확인 |
| 타임아웃 | 수집된 부분 결과로 진행. 미완료 영역을 보고에 명시 |

## 테스트 시나리오

### 정상 흐름 — 셀렉터 드리프트

1. 사용자: "네이버 입력에 실패했습니다. (locator.click: Timeout 15000ms exceeded.)"
2. Phase 1: 타임아웃 15000ms → `typeTitle` 실패로 특정. `data/logs/naver-dom-*.json` 확보. 베이스라인 측정 (경계면 8/8 통과, 모의 DOM 6/6 통과)
3. Phase 2: `naver-automation` + `app-shell`(새 에러 코드 대비) + `qa-verifier` → 3명 팀
4. Phase 3: `naver-automation` 이 덤프에서 실제 클래스명을 읽어 `TITLE_SELECTORS` 에 추가 → 모의 테스트 통과 → 새 에러 코드를 `app-shell` 에 통보 → `app-shell` 이 메시지 맵 추가 → `qa-verifier` 가 즉시 경계면 검증
5. Phase 4: 베이스라인 대비 회귀 없음 확인
6. Phase 5: 팀 정리. 보고에 "모의 DOM 통과 = 회귀 없음, 실제 네이버는 검증 불가" 명시
7. 예상 산출물: `_workspace/` 에 `*_fix.md` 2개 + `*_report.md` 1개, 수정된 `src/naver.js`, `main.js`

### 에러 흐름 — 증거 없음 + 팀원 중지

1. 사용자: "글이 이상해요" (에러 메시지 없음, 초안 파일 없음)
2. Phase 1: 증상이 모호 → `qa-verifier` 단독 투입해 범위 확정 시도. `data/drafts/` 가 비어 있어 판정 불가
3. 리더가 사용자에게 구체화를 요청한다 — 어떤 부분이 이상한지, `data/drafts/` 의 파일, 또는 `npx electron . --selftest` 실행 결과
4. 사용자가 "소제목이 다 비슷하다"로 구체화 → `content-engine` + `qa-verifier` 재구성
5. Phase 3 에서 `content-engine` 이 중지 → `SendMessage` 로 확인 → 1회 재시작
6. 재시작 실패 → 그 영역 미수정으로 Phase 4 진행
7. 보고: "소제목 중복은 `pickModifiers` 문제로 특정했으나 수정을 완료하지 못했습니다" + 다음 단계 제시
