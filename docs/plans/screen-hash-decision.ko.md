# 화면 hash 결정

[English](screen-hash-decision.md)

이 제안은 F236-9를 결정한다. 화면 hash와 그 replay contract 중 core가 유지할 부분과, terminal sidecar의 엔진 규칙 또는 terminal plugin의 page 파서로서 core 밖으로 옮길 부분을 정한다. 승인된 내용이 [replay](../spec/replay.ko.md)에 들어가고 결정 기록이 changelog에 남으면 이 제안을 지운다.

## 범위

네 질문을 결정한다.

1. core가 화면 hash의 바이트 정의, 일반적인 screen 메시지 형식, 모든 구현이 재현하는 golden vector를 유지하는가?
2. 그려진 화면의 규칙(그려진 화면의 커서, 빈 칸, 선택 강조가 어떻게 계산되는지) 중 어떤 것이 일반적이고, 어떤 것이 terminal sidecar의 엔진 동작인가?
3. page 쪽 파서 `screenFromMessage`는 어디에 속하는가?
4. 결정 1에서 3을 증명하는 core 검사는 무엇이며, 각 제거는 어떻게 관찰 가능한 검사에 묶이는가?

- *core 반론*은 core의 문장이나 코드가 (a) terminal, plugin 또는 sidecar를 정의의 소유자나 생산자로 적는다, (b) terminal sidecar나 terminal page만 구현하는 동작을 정의한다, (c) 같은 것을 두 곳에서 정의하면서 core가 실행할 수 있는 동기화 검사가 없다, 중 하나에 해당하는 것이다.
- *범위 밖*: 어떤 구현도 다르게 해석하지 않는 표현, 모든 구현이 같게 해석하는 사례, 단위 시험이 정하는 세부.

## 사실

각 사실은 이 worktree에서 확인했다. 경로는 workspace 루트 기준이다. `packages/...`는 core이고, `plugins/...`와 `sidecars/...`는 형제 저장소(worktree에서 `../plugins/...`, `../sidecars/...`)다.

- F1. `packages/plugin-api/screen-hash.js`에서 `screenBytes`의 JSDoc은 41줄, 함수는 42줄이다. `screenHash`의 JSDoc은 89줄, 함수는 90줄이다. `screenFromMessage`의 JSDoc은 104~109줄, 함수는 110~134줄이다. 1줄은 "The hash of a terminal screen"이다. `screenFromMessage`는 `messageRefuse`, `shown`, `isObject`, `resolvedColor`와 `screenBytes`(133줄)를 호출한다.
- F2. 이 모듈은 import map으로 모든 page에 닿는다. `packages/plugin-api/index.js:55`(`PAGE_IMPORTS`), `packages/workbench/index.html:12`, `packages/workbench/overlay.html:25`, `packages/plugin-api/package.json:15`의 export `./screen-hash`다. 시험 `packages/plugin-api/test/validate.test.mjs:269`~`:270`이 그 항목을 검사한다.
- F3. core의 `sok`는 hash를 계산하지 않는다. `packages/sok/tauriv2/src/replay.rs:100`(`is_screen_hash`)과 `packages/sok/wailsv3/src/replay.go:26`(`screenHashText`)은 저장된 hash가 소문자 16진 64자일 때만 받는다. 재생된 hash는 sidecar가 `sidecar.json`에 선언한 replay 실행 파일에서 나온다(`docs/spec/replay.ko.md`의 "replay 실행 파일"). `sok`는 두 문자열을 비교한다.
- F4. terminal page `plugins/terminal/ui/terminal.js`는 2줄에서 `@soksak/plugin-api/screen-hash`의 `screenFromMessage`와 `screenHash`를 import하고, 1209줄에서 `screenFromMessage`를, 1218줄에서 `screenHash`를 호출한다. `plugins/terminal/package.json:26`은 `@soksak/plugin-api`를 `#v0.0.11`로 고정한다. core 밖에서 이 모듈을 import하는 다른 plugin이나 sidecar는 없다. `plugins/`와 `sidecars/vt`를 검색해 확인했다.
- F5. `sidecars/vt`의 sidecar는 hash의 두 번째 구현과 vector 사본을 가진다(`vt-core` 소스와 fixture README는 "Core owns all three; a change of the contract replaces the copies"라고 적는다). README는 `replay-inputs.json`(`packages/log-contract/fixtures/replay/inputs.json`의 사본)과 policy fixture의 사본도 나열한다. core는 이 사본들을 검사하지 않는다.
- F6. `docs/spec/replay.ko.md`의 절은 다음과 같다. "Records"(7줄), "Segments"(24), "Screen hash"(33), "Golden vectors"(56), "View state"(74~88), 그 하위 "Decision"(89~98), "Replay executable"(99), "Command"(105). 81줄은 "under one lock for all kinds"이고, 84줄은 scrollback 한계와 기본 theme이 replay 실행 파일에 속한다고 적는다. hash 내용을 정하는 규칙은 다음과 같다. 선택 강조는 칸에 들어 있다(76줄). theme에 따라 엔진이 잘라내는 빈 칸(80줄). 커서는 viewport의 커서이며 viewport 밖이면 `visible`이 `false`다(82줄).
- F7. `scripts/workspace-registry.json`은 plugin, sidecar, pack을 나열한다. 선언된 contract repository는 없다.
- F8. [logging](../spec/logging.ko.md)의 `plugin` 층(`docs/spec/logging.md:34`, 층 `native`, `host`, `page`, `plugin`, `sidecar`, `sok`)은 일반적인 logging 층 이름이다. 한국어 번역은 `docs/spec/logging.ko.md:35`에 같은 내용을 적는다.
- F9. `docs/spec/plugins.ko.md`의 42줄은 plugin과 sidecar의 버전이 자기 것이며 core 버전과 관계가 없다고 적는다. 따라서 설치된 terminal plugin은 core 버전이 바뀌어도 바뀌지 않는다. F4의 `#v0.0.11` 고정은 개발 의존성이다.
- F10. `scripts/check-test-parity.mjs`는 helper를 다음 항목에서 이름으로 부른다. `F160.25`(2621줄, `export async function screenHash`), `F160.34`(`expected` 글이 "the view-state inputs of a session"을 적고, 시험이 replay 입력 파일을 인용한다), `F160.35`(2651줄, `export function screenFromMessage`, 2655줄과 2656줄의 시험).
- F11. 이 결정이 옮기는 anchor를 가리키는 교차 참조는 모두 `scripts/check-docs.mjs`가 heading에 대해 검사한다. `docs/spec/replay.ko.md`의 20, 22, 26, 66줄(`view-state anchor`)과 83줄. `docs/spec/terminal-runtime.ko.md`의 117줄(`replay.mdview-state anchor`)과 135줄(`#screen-message`). `docs/features.md`의 880줄(`replay.mdview-state anchor`)과 885, 886줄(`terminal-runtime.md screen-message anchor`), 그리고 `docs/features.ko.md`의 같은 줄. `docs/plans/decouple-handoff.md`의 73줄과 그 한국어 번역. `CHANGELOG.md`의 538~550줄과 그 한국어 번역. 주석 `packages/plugin-api/test/validate.test.mjs:269`와 `packages/plugin-api/test/screen-hash.test.mjs:32`. 인용 `packages/sok/wailsv3/tests/replay_test.go:63`과 `packages/sok/tauriv2/tests/replay_test.rs:68`.

## 결정

1. **core는 바이트 정의, 일반적인 screen 메시지 형식, 모든 vector를 유지한다.** `docs/spec/replay.ko.md`는 "Screen hash", "Golden vectors", "Records"의 입력 종류 표(11~18줄)를 유지한다. vector 파일 `packages/log-contract/fixtures/replay/screen-hash.json`은 모든 vector를 유지한다. 그려진 화면을 보이는 세 vector(`scrolled viewport with the cursor outside it`, `selected cells with the highlight colors`, `the same text under another theme`)도 hash 형식의 화면이며 core의 hash 시험이 실행하므로 유지한다. `terminal-runtime.ko.md`의 "Screen message"에 있는 멤버 정의 표(`event`, `sequence`, `segment`, `rows`, `cols`, `cursor`, `cells`와 칸의 멤버)는 새 heading "### Hashed members" 아래 `replay.ko.md`로 옮긴다. 표는 plugin 이름을 적지 않는다.
2. **core는 `screenBytes`와 `screenHash`, 그리고 그 import 항목을 유지한다.** `packages/plugin-api/screen-hash.js`는 `screenBytes`와 `screenHash`를 유지하고, 1줄은 "The hash of a screen, a grid of cells with a cursor"로 바뀐다. `PAGE_IMPORTS`의 `@soksak/plugin-api/screen-hash` 항목(F2)은 남는다. terminal page가 그것에서 `screenHash`를 import하고(F4), 설치된 plugin 버전은 core 버전과 독립이므로(F9), 설치된 plugin이 import하는 동안에는 항목을 지울 수 없다. core의 시험 `packages/log-contract/test/screen-hash.test.mjs`와 `replay-vectors-named.test.mjs`가 core의 vector로 이 함수들을 실행한다.
3. **그려진 화면의 엔진 규칙은 sidecar로 옮기고, 일반 규칙은 남긴다.** "View state"에서 terminal 엔진이 그려진 화면을 계산하는 방식을 설명하는 문장은 sidecar 명세 `sidecars/vt/docs/spec/`로 옮긴다. 선택 기하와 그 반응(74~80줄의 선택 항목), viewport 이동과 offset에 미치는 영향(viewport 항목), theme이 잘림과 팔레트에 미치는 영향(theme 항목의 잘림 문장), viewport 밖이면 `visible`이 `false`라는 커서 규칙(82줄), 잠금과 엔진의 scrollback 및 기본 theme(81줄과 84줄), 하위 절 "Decision"(89~98줄)이다. `replay.ko.md`는 "### Hashed members" 아래 일반 문장 하나를 남긴다. hash되는 칸과 커서는 sidecar가 그려진 화면에 대해 보고하는 것이며, 각 sidecar가 자기 명세에서 계산 방식을 적는다. 97줄("The golden vectors that fix the drawn screen ...")은 vector가 남으므로 "Golden vectors"에 남는다.
4. **page 쪽 파서는 terminal plugin으로 옮긴다.** `screenFromMessage`(`screen-hash.js` 104~134줄), `packages/log-contract/fixtures/replay/screen-message.json`의 거부 목록과 그 실행자 `packages/log-contract/test/screen-message.test.mjs`, `packages/plugin-api/test/screen-hash.test.mjs`의 `screenFromMessage` 시험은 terminal plugin 저장소로 옮긴다. plugin의 사본은 `screenBytes`를 복사하지 않고, 이미 선언된 의존성인 `@soksak/plugin-api/screen-hash`에서 import한다. `terminal-runtime.ko.md`의 124줄(`screenFromMessage`와 그 거부 목록을 명세하는 문단)은 plugin의 명세로 옮긴다. 그 뒤 core는 파서의 거부 사례를 하나도 갖지 않는다.
5. **동기화와 gate.** 바이트 정의의 기준은 core의 vector 시험이다. vector를 가진 소유자들은 core tag에 고정한 사본으로 자기 시험에서 실행한다(AGENTS: 공유 계약 사례는 소유 package에서 실행한다. core는 다른 저장소의 파일을 읽을 수 없다). 결정 4의 제거는 다음에 묶인다. core는 registry를 통해 설치된 terminal plugin의 사본으로 `e2e/terminal-replay.test.mjs`가 통과할 때까지 `screenFromMessage`를 유지한다(설치 기반 window 검사에 대한 AGENTS 예외). 사본을 가진 plugin release tag와 gate를 적는 checklist 하위 항목이 `docs/features.ko.md`에 있다. 그 항목은 구현 단계에서 쓴다. core의 기록은 약속이 아니라 통과한 검사다.
6. **replay 입력 검증기는 sidecar 검사가 대체할 때까지 core에 남는다.** `replayInputProblem`과 `replaySessionProblem`(`packages/log-contract/index.js`), `packages/log-contract/fixtures/replay/inputs.json`, sidecar의 사본 `replay-inputs.json`(F5), `sok`의 사본(`packages/sok/tauriv2/src/replay_inputs.rs`, `packages/sok/wailsv3/src/replay_inputs.go`)은 terminal 엔진의 한계(grid에 대한 선택, theme 색)를 담는다. 이는 (b) 아래 core 반론이다. 제거하려면 계약 변경이 먼저다. `replay.ko.md`의 "replay 실행 파일"에 새 문장이 들어간다. 실행 파일은 검증기가 거부하는 `inputs.json`의 모든 입력을 같은 오류 글로 거부한다. 요구는 그것을 담는 sidecar release에 적용된다. 설치된 sidecar release가 잘못된 `inputs.json` 사례를 자기 실행 파일로 통과시키는 것이 window 검사로 확인될 때까지 core는 검증기를 유지하고, 명령은 `replaySessionProblem`(`replay.ko.md`의 85줄)을 유지한다. 그 뒤 같은 변경에서 sidecar의 사본과 `sok`의 사본을 지운다. `docs/features.ko.md`의 하위 항목은 owner(sidecar 저장소), release, gate를 적는다. 이 결정은 요구와 하위 항목을 추가하며 검증기를 지우지 않는다.
7. **용어를 바꾼다.** `packages/plugin-api/terms.json`의 "replay"(151줄)는 "Rebuilding the screen of a session from its stored inputs with the replay executable of its sidecar, to compare the stored hashes of the screens (docs/spec/replay.md)"가 된다. "screen hash"(170줄)는 "The SHA-256 of the canonical bytes of a screen, a grid of cells with a cursor, as docs/spec/replay.md defines it"가 된다. `replay.ko.md` 101줄의 "terminal 엔진을 가진다"는 "sidecar의 replay 엔진을 가진다"가 된다.
8. **응용 수준의 divergence 시험은 core에 남는다.** `e2e/terminal-replay.test.mjs`는 registry를 통해 설치된 plugin을 실행한다. AGENTS.md 33줄은 "Window checks are end-to-end checks of the application with the plugins its environment installs, not package tests, and this rule does not apply to them."라고 적는다. 이 시험의 검사는 terminal plugin 동작(scroll, 선택, theme이 있는 terminal session의 replay)에 의존하므로, 그 제거는 여기서 정하지 않고 결정 5의 gate에 맡긴다. 그 parity 항목(F160.25, F160.35)은 남는다.

## 변경

위에서 정한 문서와 이동이다. gate가 통과하기 전에는 동작을 바꾸지 않는다.

- `docs/spec/replay.ko.md`와 `replay.md`:
  - 11~18줄(입력 종류 표)과 7~10, 24~32, 56~72줄은 유지한다. 13, 14줄("pseudo terminal")은 장치를 가리키므로 유지한다.
  - 20줄(`[View state] (view-state anchor)` 연결)은 "### Hashed members"를 가리키도록 바꾼다.
  - 22줄과 26줄의 `[View state] (view-state anchor)` 연결은 "### Hashed members"를 가리키도록 바꾼다.
  - 28줄의 "[screen message] (terminal-runtime.md screen-message anchor)"는 "the screen message (the Hashed members section of this document)"로 바꾼다.
  - 54줄의 "(`@soksak/plugin-api/screen-hash`, the golden vectors)"는 "(the golden vectors)"로 바꾼다.
  - 66줄의 `view-state anchor` 연결은 "### Hashed members"로 바꾼다.
  - 66~68줄(세 그려진 화면 vector의 행)은 vector가 남으므로 유지한다.
  - 74~98줄은 결정 3대로 바뀐다. "### Hashed members"가 일반 문장과 함께 추가되고, 74~98줄의 나머지는 sidecar 명세로 옮긴다.
  - 83줄은 `terminal-runtime.md` 링크를 빼고 일반 page 규칙을 남긴다. page는 자기 plugin의 파서와 `screenHash`로 메시지의 hash를 계산한다.
  - 85줄(명령이 실행 파일 전에 `replaySessionProblem`을 실행하고 알 수 없는 종류를 거부한다)은 유지한다.
  - 87줄(`replayInputProblem`, `replaySessionProblem`)은 유지한다.
  - 101줄의 "terminal 엔진을 가진다"는 "sidecar의 replay 엔진을 가진다"로 바꾼다.
  - 103줄(실행 파일의 종료 규칙)은 유지하고, 결정 6의 거부 요구 문장을 더한다.
  - 105~109줄(명령)은 유지한다.
- `docs/spec/terminal-runtime.ko.md`와 `terminal-runtime.md`: "Screen message"의 멤버 정의 표와 문장은 `replay.md`로 옮긴다(결정 1). `terminal.screen.read`의 응답(109줄)과 커서 모양(117줄)은 terminal 명령을 설명하므로 남는다. 117줄의 `replay.mdview-state anchor` 연결은 "### Hashed members"로 바꾼다. 124줄(`screenFromMessage` 문단)은 plugin 명세로 옮긴다(결정 4). 135줄(`[Screen message] (screen-message anchor)`)은 `replay.md#hashed-members`로 바꾼다.
- `docs/features.md`와 `docs/features.ko.md`의 880, 885, 886줄, `docs/plans/decouple-handoff.md`와 `.ko.md`의 73줄: 연결을 새 anchor로 바꾼다. 각 이력 항목의 글은 그대로 둔다.
- `CHANGELOG.md`와 `CHANGELOG.ko.md`의 538~550줄: 연결만 바꾸고 글은 그대로 둔다.
- `packages/plugin-api/test/validate.test.mjs:269`와 `packages/plugin-api/test/screen-hash.test.mjs:32`의 주석: 연결을 바꾼다.
- `packages/sok/wailsv3/tests/replay_test.go:63`과 `packages/sok/tauriv2/tests/replay_test.rs:68`: 인용을 "### Hashed members" 또는 sidecar 문장으로 바꾼다.
- `docs/plans/decouple-handoff.md`와 `.ko.md`: 이 결정의 구현이 gate가 있는 항목 두 개를 더한다. (a) 그려진 화면의 엔진 규칙과 그 목적지 `sidecars/vt/docs/spec/`, (b) 결정 6의 sidecar gate가 있는 replay 입력 검증기. 그리고 결정 5의 gate가 있는 `screenFromMessage` 제거 항목 (c)를 더한다.
- `packages/plugin-api/terms.json` 151줄과 170줄: 결정 7.
- `packages/plugin-api/screen-hash.js`: 1줄(결정 2). `screenFromMessage`(104~134줄)는 결정 5의 gate가 통과할 때만 지운다.
- `packages/log-contract/test/replay-doc.test.mjs`(신규, core 소유): `docs/spec/replay.md`와 `packages/plugin-api/terms.json`을 읽고 다음을 검사한다. "### Hashed members" 절이 있다. "Golden vectors" 절의 어떤 줄도 `screenFromMessage`를 적지 않는다. `terms.json`의 "screen hash"와 "replay" 정의가 terminal을 적지 않는다. 변경 전 트리에서는 실패한다. `replay.md` 101줄이 "terminal 엔진"을 적고, `terms.json` 151줄이 "a terminal session"을 적기 때문이다. 편집 뒤에는 통과한다. 이 시험은 helper를 import하지 않으므로 파서 제거가 시험을 지우지 않는다.
- `packages/log-contract/test/screen-message.test.mjs`와 `packages/log-contract/fixtures/replay/screen-message.json`: 결정 4의 변경에서 gate 뒤에 core에서 지우고 plugin 저장소로 옮긴다.
- `scripts/check-test-parity.mjs`: F160.34의 `expected` 글을 입력 종류로 바꾼다(결정 3). F160.35의 2651, 2655, 2656줄 항목은 파서가 옮겨갈 때 plugin 항목으로 옮긴다. F160.25(2621줄)는 `screenHash`가 남으므로 유지한다.
- `docs/features.md`와 `docs/features.ko.md` 2014줄: F236-9는 이 결정으로 닫는다. 세 handoff 항목이 gate가 있는 후속 작업이다.
- `CHANGELOG.md`와 `CHANGELOG.ko.md`: 결정, 검토 라운드, 답변.

문서 검증: `make docs-check`(모든 fragment를 검사하므로 위 연결 변경이 모두 필요하다), `make parity-check`, `node --test packages/log-contract/test/*.test.mjs packages/plugin-api/test/*.test.mjs`. Red와 Green: 위의 `replay-doc.test.mjs`. sok 인용 편집의 소유자 검사: `packages/sok/wailsv3`에서 `go test ./tests`, `cargo test -p soksak-sok-tauriv2 --test replay_test`.

## 잔여

replay 입력 검증기(결정 6)와 page 파서(결정 4)는 gate가 통과할 때까지 core의 terminal 동작이다. core가 각각을 gate와 함께 유지하며, gate는 handoff와 checklist에 있다. 이 결정은 둘 중 어느 것도 제거되었다고 주장하지 않는다.

## 검토 기록

### 1차 검토

auditor 3명이 첫 판을 검토했다. 받아들인 것: "잔여" 주장이 틀렸다(hash 내용은 View state에 의존한다. `replay.md` 76, 80, 82줄). `screenFromMessage`는 terminal sidecar의 메시지를 파싱한다. helper의 plugin 소비자는 하나였다. 동기화 사본은 모든 후보에 있었다(F5). Red와 Green 시험은 가능하다. 편집 목록이 없는 대상을 적었다. F236-8과 F236-12는 owner가 가지기 전에 텍스트를 지웠다. import 명세자가 지켜져야 한다. 반박한 것: `plugin` 층 이름은 일반적이다(F8).

### 2차 검토

auditor 3명이 둘째 판을 검토했다(반론 26개). v3에서 답했다. core는 `screenBytes`, `screenHash`와 vector 시험을 유지한다. Red와 Green 시험은 문서만 읽는 core 파일로 옮겼다. e2e divergence 시험에 결정이 생겼다. 사본 gate는 검사할 수 있는 형태가 되었다. 검증기는 gate와 함께 남는다. Changes는 모든 줄과 anchor를 적는다. View state 이동 목적지는 sidecar다. screen 메시지는 일반적이다. handoff 항목은 구현 단계가 추가한다.

### 3차 검토

auditor 3명이 v3을 검토했다(반론 29개). v4에서 답했다.

- R3-H1(사본 gate가 텍스트 주장이었다): 받아들임. 결정 5는 registry로 설치된 사본의 e2e window 검사에 제거를 묶고, 하위 항목이 tag를 적는다.
- R3-H2, R3-I8(import 항목 제거가 설치된 plugin을 깨고 `screenHash`도 공급한다): 받아들임. import 항목과 `screenHash`는 남는다(결정 2). F9에 따라 설치된 plugin은 core 버전을 따르지 않는다. 파서만 옮긴다.
- R3-H3(사본의 함수 집합이 정해지지 않았다): 받아들임. 결정 4가 파서, 그 fixture와 실행자를 이름으로 적고, plugin이 `screenBytes`를 core에서 import한다고 적는다.
- R3-H4(검증기 gate가 관찰 불가능하고 owner와 날짜가 없다): 받아들임. 결정 6이 owner(sidecar 저장소), gate(설치된 실행 파일의 잘못된 사례 통과 검사), 하위 항목을 적는다.
- R3-H5(거부 요구가 이미 배포된 sidecar와 맞지 않는다): 받아들임. 결정 6은 요구를 그것을 담는 sidecar release에만 적용하고, gate가 통과할 때까지 core 명령이 검사를 유지한다.
- R3-H6, R3-G1(녹색 시험이 sidecar가 가지기 전에 sidecar 텍스트를 지운다): 받아들임. View state 텍스트는 sidecar 명세가 그것을 가질 때만 옮긴다(결정 5의 gate와 하위 항목 (a)). 그 전까지 core가 텍스트를 유지한다.
- R3-I1, R3-I2, R3-I3(Changes에 없는 anchor와 교차 참조): 받아들임. 연결 목록이 모든 출현을 적는다(F11, 변경 절).
- R3-I4, R3-G3(`replay.md` 83줄과 `terminal-runtime.md` 124줄이 제거될 파서를 적는다): 받아들임. 83줄은 함수 이름 없이 일반 page 규칙을 남긴다. 124줄은 파서와 함께 옮긴다.
- R3-I5(거부 요구가 `replay.md`에 없다): 받아들임. 결정 6이 추가하고 변경 절이 "Replay executable"에 적는다.
- R3-I6, R3-G6(81줄, 84줄, 일반 문장이 배정되지 않았다): 받아들임. 결정 3이 81, 84, 97줄과 일반 문장을 적는다.
- R3-I7(sidecar fixture 사본이 동기화에 없다): 받아들임. F5가 `replay-inputs.json`과 policy fixture를 나열하고, 결정 6이 사본을 다룬다.
- R3-I9(일반 문장 heading에 anchor가 없다): 받아들임. heading은 "### Hashed members"이며 모든 연결이 그것을 가리킨다.
- R3-I10(`terms.json` Red 사유): 받아들임. Red 사유는 시험이 검사하는 문자열을 적는다.
- R3-I12, R3-I13(F1과 F8의 줄 번호): 받아들임. F1은 JSDoc과 함수 줄을 함께 적고, F8은 `logging.ko.md:35`를 적는다.
- R3-I14(입력 종류 표의 줄, 경로 형식): 받아들임. 11~18줄과 workspace 루트 형식을 쓴다.
- R3-G2(`terminal.screen.read`의 응답과 커서 모양은 일반 절에 있으면 terminal 전용이다): 받아들임. 두 문장은 `terminal-runtime.md`에 남는다(변경 절).
- R3-G4(screen 메시지 fixture에 core 실행자가 없다): 받아들임. fixture는 파서와 함께 옮긴다(결정 4).
- R3-G5(plugin이 어떤 함수를 복사하는지): 받아들임. 결정 4.
- R3-G8(`validate.test.mjs`의 import map 검사가 gate에 없다): 답함. 항목이 남는 동안 그 검사도 남는다(결정 2). 어떤 gate도 항목을 지우지 않는다.
- R3-G9, R3-I8(결정 8이 AGENTS에 없는 문장을 인용했다): 받아들임. 결정 8은 AGENTS.md 33줄을 정확히 인용한다.
- R3-H3, R3-G7(sidecar 요구 문장이 Changes에 없다): 받아들임. 변경 절에 있다.

4차 auditor는 이전 판이 아니라 이 판을 검토한다.
