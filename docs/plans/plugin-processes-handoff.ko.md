# Plugin 프로세스: 남은 작업

[English](plugin-processes-handoff.md)

이 문서는 F212(plugin 코드를 main page 밖으로)와 그 옆의 열린 항목에서 남은 작업을 나열한다. 각 항목을 어떻게 하고 어떻게 검증하는지도 적는다. 다른 맥락 없이 이 문서와 AGENTS.md, 그리고 이 문서가 가리키는 파일만으로 작업을 시작할 수 있다. F212.15가 release되면 이 문서를 지운다.

## 정본

| 주제 | 파일 | 위치 |
|---|---|---|
| 작업 규칙, checklist 규칙, Red/Green, commit 형식 | `AGENTS.md` (+ `.ko.md`) | main |
| main의 checklist | `docs/features.md` (+ `.ko.md`) | main |
| F212 작업의 checklist | branch `feat/view-kind-F212.7`의 `docs/features.md` | branch |
| F212의 확정 설계: 층, 규칙 1~10, 통과값 (i)~(viii), 검증 기록 | `docs/plans/plugin-processes.md` (+ `.ko.md`) | branch, main에는 이전 사본 |
| 선언 UI 계약(list, tree, button, status-line, section, 주소, 거부) | `docs/spec/declared-ui.md` (+ `.ko.md`) | branch |
| exposure 계약(명령, status, dom, `address`, 오류) | `docs/spec/exposure.md` | branch가 최신 |
| build, test parity, 창 검사, 진단 | `docs/operations/examples.md` | 양쪽 |
| 비공개 WebKit API와 호출 조건 | `docs/operations/private-native-apis.md` | 양쪽 |

branch에 사본이 있는 파일은 항상 branch의 것을 읽는다. F212 작업 대부분은 branch에 있고, branch를 합치기 전까지 main에는 보이지 않는다.

## 저장소 상태

### Branch와 worktree

| Branch | Worktree | 상태 | 다음 |
|---|---|---|---|
| `main` | `core` | push됨, 깨끗함 | — |
| `feat/view-kind-F212.7` | `../core-view-kind-F212.7` | origin에 공개됨. F212 view와 선언 UI 작업 전부 | 아래 항목을 이어 한다. F212 core 항목과 F212.7-9가 끝난 뒤에만 main에 합친다 |
| `fix/lock-drops-F218-2-2` | `../core-lock-drops-F218-2-2` | F218-2.2 커밋, main 위로 rebase, `make push-check` 통과 | 아래의 실패 시험을 해결하고 main에 합친 뒤 worktree와 branch를 지운다 |
| `feat/settings-G1.4-87-1` | `../core-settings-G1.4-87-1` | 보류 항목 | 건드리지 않는다 |
| `fix/background-launch-V5-117-1-3-4-7-1-8` | 없음 | 보류 항목 | 건드리지 않는다 |

대체된 두 branch의 커밋은 annotated tag 두 개가 보관한다. `git tag -l`로 볼 수 있다.

### `../core-view-kind-F212.7`의 커밋하지 않은 작업

작업이 멈출 때 F212.8-6-3(선언 section의 출처와 전이)을 진행 중이었다.

- 새 파일, 추적 안 됨: `packages/workbench/declared-section.js`, `packages/workbench/test/declared-section.test.mjs`(시험 10개, `node --test`로 통과)
- 바뀌었으나 커밋 안 됨: `CHANGELOG.md`, `CHANGELOG.ko.md`, `docs/features.md`, `docs/features.ko.md`, `docs/operations/examples.md`, `docs/operations/examples.ko.md`(기록 줄과 기록된 시험 수)

이 작업은 Red 기록이 없고 `make push-check`를 거치지 않았다. declared-ui.md의 "Status mapping"과 전이 (a)~(d)에 비추어 검토한다. 동작을 뺀 module로 시험을 돌려 Red를 기록한 뒤 마무리하고 커밋, push한다. 아니면 새 파일 둘을 지우고 바뀐 파일은 `git restore`로 되돌린다.

### F218-2.2를 막는 실패 시험

`fix/lock-drops-F218-2-2`에서 `make rust-repeat PACKAGE=soksak-host-tauriv2 COUNT=1` 전체 실행이 load average 27~42에서 `tests/sidecars_test.rs`의 시험 하나를 한 번 실패했다.

```
surface_open_clears_the_restart_limit
the opened surface recorded no host.trace.sidecar.restart-reset
```

같은 시험은 단독으로 세 번 모두 통과한다(`make rust-repeat PACKAGE=soksak-host-tauriv2 COUNT=3 TEST=surface_open_clears_the_restart_limit`). 이 시험은 F212.8a의 것이고, F218-2.2는 `sidecars.rs`(sidecar state lock 복구)를 바꿨다. 항목을 등록한 뒤 다음을 한다.

1. main과 branch에서 `make rust-tests-alone PACKAGE=soksak-host-tauriv2`와 `make rust-repeat PACKAGE=soksak-host-tauriv2 COUNT=3`을 돌린다. 실패가 시험 순서 때문인지 F218-2.2 때문인지 가린다.
2. 이 시험은 공유 event log에서 trace 기록을 읽는다. 같은 binary의 다른 시험이 같은 log에 쓰거나 log를 비우는지 확인한다. Go 시험의 `useEventLog`가 격리된 형태다.
3. 원인을 고친다. Red는 실패 assertion을 보이는 가장 가벼운 실행으로, Green은 바꾼 것의 소유 시험으로 기록한다. 전체 모음 판정 실행은 지금이 아니라 체크리스트 전체가 완료된 뒤 한 번 돌린다. 그다음 F218-2.2를 합친다.

### Sidecar 저장소

| 저장소 | 열린 항목 | 비고 |
|---|---|---|
| `../sidecars/files` (origin `soksak-app/sidecar-files`) | S31: 다른 준비보다 먼저, 프로세스의 첫 동작으로 log 기록을 쓴다 | F212.1-2-2의 12.4초 공백(spawn에서 `log.open`까지)을 잰다. S26~S30은 커밋됨 |
| `../sidecars/shell` (remote 없음) | 없음 | S10~S15는 커밋됨 |

두 sidecar release는 core release(F212.15) 뒤에 한다. F212.1-2-2-3-1은 둘이 모두 공개될 때까지 열어 둔다.

## 작업 방법

### 모든 항목

1. `git fetch` 후 origin의 checklist를 먼저 읽는다.
2. 요청을 분류하고 항목을 등록한다(EN과 KO). 계약이 바뀌면 명세를 먼저 고친다.
3. 소유 module에 시험을 쓴다. 바꾸지 않은 코드에서 돌려 실패한 assertion을 기록한다(Red). module이 없거나 compile 오류, link 오류는 Red가 아니다. 코드가 이미 그 동작을 하면, 사본에서 그 동작을 끄고 assertion 실패를 본 뒤 파일을 되돌린다.
4. 구현하고 같은 시험을 돌린다(Green).
5. 소유 시험과 변경이 닿는 구조 검사를 돌린 뒤, 커밋된 tree에서 `make push-check`를 돌린다.
6. 항목을 Red와 Green과 함께 `[o]`로 표시하고 CHANGELOG에 EN과 KO 항목을 더한다.
7. author `min-0-max <max@blue.tools>`, `type(scope): Subject (#ID)` 형식으로 커밋한다. 제목은 50자 이하다. 본문은 무엇을 왜 바꿨는지 72열로 감싸 적는다. footer와 trailer는 없다. commit-msg hook이 다른 형식을 거부한다. 경로를 명시해 stage하고 `git add -A`는 쓰지 않는다.

### Branch와 worktree

- 기본은 `main`에서 직접 작업한다. 격리가 필요하면 branch `{type}/{shortname}-{ID}`와 worktree `../core-{shortname}-{ID}`를 쓴다.
- main에 합치기가 성공한 직후 worktree와 branch를 지운다. 합치지 않은 것은 지우지 않는다.
- 새 worktree에서는 시험 전에 `make hooks`, `make native-darwin`, `make frontend-tauriv2`를 돌린다.
- `feat/view-kind-F212.7`은 공개된 branch다. `git merge origin/main`으로 맞추고 rebase나 force-push는 하지 않는다. push 전마다 `git rev-list --count HEAD..origin/main`을 돌려, 0이 아니면 먼저 합친다.
- CHANGELOG 충돌은 양쪽 항목을 모두 남긴다. `docs/operations/examples.md`의 기록된 수가 충돌하면 합친 tree에서 `make parity-check`가 출력하는 수를 쓴다.
- worktree를 옮기면 Tauri build cache가 옛 경로를 갖고 있어 clippy가 실패한다. 그 worktree에서 `cargo clean -p tauri -p soksak-tauriv2`를 돌린다.
- 명령은 `&&`로 잇는다. pipe나 grep은 이어진 명령을 멈추지 않는다.
- 계약 case나 `packages/host`, `packages/sok`의 시험을 더하거나 건드리는 변경은 `make host-contract-check`를 돌린다. 어떤 push 관문도 이 검사를 돌리지 않아서 돌리지 않으면 CI가 실패한다(F220).

### 시험 파일을 더할 때

- `scripts/check-test-parity.mjs`의 lane에 등록하고, `docs/operations/examples.md`(+ko)의 기록된 수를 `make parity-check` 출력에 맞춘다.
- Go 짝이 없는 Rust 시험은 `docs/spec/hosts.md`(+ko)와 `scripts/check-hosts.mjs`에 허용된 차이 행이 필요하다. 행 H13이 lock 시험을 나열한다.
- 완료된 기능은 `scripts/check-test-parity.mjs`에 feature link가 필요하다.

### 시험 명령

| 무엇 | 명령 |
|---|---|
| Node 시험 파일 하나 | `node --test packages/<pkg>/test/<file>.test.mjs` |
| Node 시험 반복 | `make node-repeat FILE=<file> NAME=<pattern> COUNT=<n>` |
| Go 시험 | `make go-repeat PACKAGE=./packages/host/wailsv3/tests COUNT=1 [TEST=<regexp>]` (`./packages/sok/wailsv3/tests`, `./packages/host/wailsv3/src`도) |
| Rust 시험 | `make rust-repeat PACKAGE=soksak-host-tauriv2 COUNT=1 [TEST=<name>]`, `PACKAGE=soksak-sok-tauriv2` |
| Rust 순서 의존 | `make rust-tests-alone PACKAGE=<package>` |
| Native 시험 | `make -C native/darwin repeat TEST=<name>_test COUNT=<n>` |
| 문서, link, 번역, 기록 | `make docs-check` |
| exposure 이름 | `make exposure-check` |
| event catalog | `make events-check` |
| host 파일 짝과 허용된 차이 | `make hosts-check` |
| 시험 목록 | `make parity-check` |
| core가 plugin 이름을 쓰지 않음 | `make boundaries` |
| census 규칙 | `make census-check` |
| push 관문(기록, 구조, 형식, clippy, 관문 시험) | `make push-check` |
| view 프로세스 benchmark | `make -C native/darwin benchmark-view-processes` |

전체 suite(`pnpm test`, `make native-test`, `make host-contract-check`, `make verify`, 창 suite)는 항목 완료에 쓰지 않고 체크리스트 전체가 완료된 뒤 배포 전에 한 번 돌린다. 개발 중에는 바꾼 것의 단위 시험만 돌리고, 간헐 실패의 반복 대상도 그 마지막 통과까지 기다린다.

### 창 검사와 측정

창 검사는 plugin이 설치된 application의 end-to-end 검사다. `docs/operations/examples.md`의 "Window checks"가 방법을 적는다. 두 application을 build하고, 일회용 설정에서 `--config-dir`와 `--registry-ca`로 띄우고, `pnpm -F @soksak/e2e verify`나 파일 하나를 돌린다. 규칙은 다음과 같다.

- `<config-dir>/endpoint.json`으로 연결한다. 선언된 exposure 항목과 native 입력만 쓴다. timer가 아니라 status 알림을 기다린다.
- 창을 활성화하거나 focus하지 않는다. `diagnostics.capture.still`로 캡처하고 `diagnostics.capture.start`와 `diagnostics.capture.stop`으로 녹화한다. 이미지는 원래 해상도로 본다. 이미지는 관찰이지 통과 결과가 아니다.
- 화면이나 시간 동작은 gesture 전체를 녹화하고, 잰 frame 간격과 좌표를 추적되는 증거로 만든다.
- 검사 중 application 오류는 검사가 `expectError`로 선언하지 않으면 모두 실패다.
- 입력기 검사(`make -C native/darwin test-activation`, `pnpm -F @soksak/e2e verify:activation`)는 사람의 승인을 받고만 돌린다.
- 부하가 걸린 컴퓨터에서 기대 시간의 100배 안쪽으로 넘긴 시간 한도는 부하다. 부하와 시간을 기록하고 항목을 완료한다.

### 검증이 필요한 결정

새 논거에 기대는 결정은 agent의 반대 검증을 거친다.

1. 첫 차례 전에 범위를 적는다. 문서가 정해야 할 것, 핵심 반론으로 볼 것, 범위 밖인 것(문구, 어떤 구현이든 같게 처리하는 경우, 단위 시험이 정할 세부)이다.
2. 반론마다 고칠 문장(파일, 줄, 인용)과 바꿀 내용을 낸다.
3. 반론마다 파일에서 근거를 직접 확인하고 받아들이거나 반박한다. 반박은 이유와 함께 같은 감사자에게 돌려보내고, 양쪽이 합의할 때까지 묻는다.
4. 차례마다 새 감사자를 쓰고, 최대 5차례다. 반론과 답은 관련 문서에 적는다.

## 남은 항목

아래 순서는 의존 관계를 따른다. ID는 checklist ID다.

### 1. F212 옆의 main 항목

**F218-2.2** — 위의 실패 시험을 해결한 뒤 합친다.

**F218-2.3** — Rust host와 sok crate에서 poisoned lock을 오류로 바꾸는 lock 결과 100곳(`map_err`, `ok()`, `?`).
- 변경: 각 곳을 `PoisonError::into_inner`로 복구하고, 호출 바로 위 줄에 `// default:` 이유를 적는다. 이유는 먼저 설치된 panic hook이 panic을 기록한다는 것이다(`docs/spec/logging.md`). 커밋 하나에 module 하나씩 묶는다.
- 시험: seam이 있는 module마다, spawn한 thread에서 lock을 poison한 뒤 연산이 값을 돌려주는지 보인다. Red는 예전의 오류 결과다.
- 대상은 `make census-check`(규칙 `rs.lock-result`)로 찾는다.

**F218-2.4** — `unwrap`이나 `expect`를 부르는 lock 결과 86곳. 변경과 시험은 같고, Red는 호출 thread의 panic이다.

**F218-2.5** — `rs.lock-result`를 찾은 곳 0으로 켜고 `scripts/census.json`의 pending 항목을 지운다. Green은 `make census-check`가 0을 보고하는 것이다. 그다음 F218-2를 `[o]`로 표시한다.

**F212.1-2-2** — fixture 답이 files sidecar의 첫 답을 12.4초 기다렸다. `host.trace.sidecar.ready`(F212.1-2-2-6)가 spawn에서 첫 답까지를 잰다. files sidecar의 S31을 먼저 한다. 그다음 trace를 켜고 F212.1-2의 창 검사를 되풀이하고, `host.trace.sidecar.ready`와 sidecar의 첫 기록을 읽는다. 공백이 sidecar의 첫 기록 이전이면 원인은 프로세스 시작(binary 실행)이다. 잰 시간과 그 원인을 기록한다. 공백이 sidecar 안이면 거기서 고친다.

**F212.1-3** — 통과값 (iii)의 녹화 기반 DOM mount 기준값. 설치된 surface plugin마다, surface 시작 요청부터 첫 내용 frame까지 main page를 녹화하고(`diagnostics.capture.start/stop`) 5회의 중앙값을 load average와 함께 잡는다. `e2e/` 아래 추적되는 창 검사로 만들고, 결과를 계획의 "F212.1-2" 표에 적는다.

**F212.6a-1-3-2-2** — Tauri host의 2.4초 main thread 멈춤 원인. 찾은 내용은 항목에 있다. 2초 이상 stall dump는 이제 기본으로 저장된다(F212.6a-1-3-2-1). 다음 dump가 나오면 `atos -o /System/Library/Frameworks/WebKit.framework/Versions/A/WebKit -l <load address> <addresses>`로 WebKit frame을 symbol화한다. OS build가 dump와 같으면 dyld shared cache로 풀린다. 그다음 `IPC::Connection`의 `m_incomingMessagesLock`과 run loop lock을 잡은 thread를 밝힌다. 상위 F212.6a-1-3은 하위가 끝나면 표시한다.

### 2. Branch `feat/view-kind-F212.7`: checklist 상태

여러 상위 항목이 하위가 모두 `[o]`인데 `[ ]`로 남아 있다: F212.3, F212.4, F212.6, F212.7(열린 하위는 F212.7a, F212.7b-1, F212.7c, F212.7d-1, F212.7-9). 각 상위의 하위를 읽고 규칙대로 표시한다. 모든 하위가 완료되고 검증되었을 때만 `[o]`, 하위가 `[~]`인 동안만 `[~]`다.

### 3. 선언 UI (F212.8)

완료: F212.8-0(명세, 20차례 뒤 닫음), F212.8-1(list), F212.8-1-1(key 기반 다시 그리기), F212.8-2(tree), F212.8-4(button), F212.8-5(status-line), F212.8-6-1(manifest의 `status` section), F212.8-6-2(`dom.rect`와 `dom.act`의 `address`). 코드는 `packages/workbench/declared-ui.js`, 시험은 `test/declared-ui.test.mjs`(56개)다.

**F212.8-6-3** — 선언 section의 출처와 전이. 위의 "커밋하지 않은 작업"을 본다.
- 출처는 그 status를 등록한 card의 활성 tab view, 그다음 plugin host, 아니면 비운다. state module의 등록은 출처가 아니다.
- 전이 (a)~(d)이며, plugin override의 시작과 끝을 포함한다.
- pull은 main page load, 출처 변경, 방향 변경 때 한다.
- 고른 출처가 아닌 짝의 snapshot이나 pull 응답, 그리고 seq가 낮은 pull 응답은 버린다.
- 출처 변경, 프로세스 종료, surface 닫힘 때 hideError를 부른다.
- 등록은 fake로 시험한다. 실제 통로가 아직 없는 곳은 항목에 적는다.

**F212.8-6-4** — section을 그리고 보고한다. 요소와 머리(`core.sidebar.section.header`), `showError`의 거부 글, 가로 배치, 방향 재검사, `core.sidebars` field `mounted`, `error`, `text`, `controls`가 들어간다. 그다음 F212.8-6을 표시한다.

**F212.8-7** — tree 노드 5000개와 list 항목 1000개의 workbench 그리기 시간을 재는 추적 benchmark. 결과가 다른 한도를 요구하면 새 항목에서 declared-ui.md를 고친다.

### 4. Plugin host (F212.9)

F212.9는 필요하다. view가 하나도 열려 있지 않을 때 sidebar section에 값을 보여 주는 plugin은 plugin host가 있어야 하기 때문이다(declared-ui.md, 출처 순서). 계획은 첫 사례로 files state를 든다.
- 명세 먼저: 계획의 native 빈칸 3(surface host가 아니라 창에 붙는 plugin host web view를 만드는 platform 연산), 빈칸 7(owner key `plugin:<id>`), 규칙 5(한도 (vi) 안의 재시작, 마지막 저장값에서 state 복원).
- F212.9a: F212.10 전에 숨은 host web view의 footprint와 throttle을 잰다.
- native/darwin과 두 host에 구현하고, 계약 case, Go와 Rust 시험, native 시험을 둔다. F212.7-2의 view 통로 코드가 host 통로의 본보기다.

### 5. 계획을 명세로 (F212.7-9)

branch를 합치기 전에 `docs/plans/plugin-processes.md`의 확정 계약을 새 `docs/spec/plugin-processes.md`(+ko)로 옮긴다. `packages/plugin-api/terms.json`과 `docs/spec/declared-ui.md` 11행을 포함한 모든 link를 바꾸고 계획을 지운다. 검증 기록을 어디에 둘지 정한다. 명세에는 이력이 없으므로 changelog 항목으로 옮기거나 버린다.

### 6. Plugin 이전 (F212.10)

각 이전은 그 plugin 저장소의 항목이며, branch에 맞춰 한다. 계획의 "층과 배치" 표가 plugin마다 대상을 정한다.

| Plugin | 표면 | Section | State | Sidecar |
|---|---|---|---|---|
| editor | view(글 입력, IME) | — | — | files |
| flowmark | view | — | — | 자기 것 |
| shell | 선언 어휘로 표현되면 선언 UI, 아니면 view | — | — | shell |
| files | — | 선언 tree, 이름 바꾸기·끌기·context menu가 필요하면 view | files sidecar, 아니면 plugin host | files |
| hwp | 문서 region이 있는 view | — | — | files |
| browser | 문서 region이 있는 view | section 4개를 선언 UI 또는 card 표면으로 | — | — |
| terminal | image region이 있는 view | — | — | vt |

- core는 코드와 시험에서 plugin 이름을 쓰지 않는다(`make boundaries`). 각 plugin 저장소가 자기 source를 검사한다.
- 각 plugin 항목은 release 전에 자기 view를 잰다. (iii) 첫 표시, (v) 배치 변경 뒤 표시, (viii) 끌기다. plugin release는 core release 뒤다.
- F212.10-editor가 먼저이고, F212.7a가 그 첫 editor view로 통과값 (i), (ii), (iii), (iii-b), (v), (viii)를 잰다.

### 7. 창 측정과 검사

- F212.7b-1: view가 있는 card의 전체 화면 전환과 tab 전환을 녹화하고 presentation wait가 모두 끝나는지 보인다.
- F212.7c: view가 있는 card를 끄는 동작을 녹화해 (viii)를 잰다. native frame과 card 경계 차이는 2pt 이하다. 내용 frame 간격은 33ms 이하다. 내용 크기 불일치는 gesture 끝 뒤 2 frame 안에 사라진다.
- F212.7d-1: view 첫 frame의 색을 card token 색과 비교한다.
- F212.12: view 창 검사를 기능마다 항목 하나로 한다. 표시, 입력과 focus, 끌기, 재시작이다.
- F212.13: view의 입력기 activation 검사를 승인을 받고 돌린다.
- F212.14: 모든 plugin view를 (i), (ii), (iii), (iii-b), (v), (viii)에 비추어 마지막으로 잰다.

통과값은 계획의 "통과값" 절에 있다. 기구 값 (v), (vi), (viii)이 실패하면 기구 항목을 멈춘다. plugin 값이 실패하면 그 plugin만 멈추고, 비용을 받아들일지 층을 바꿀지는 사람이 정한다.

### 8. 제거, 합치기, release

- F212.11: plugin surface의 page mount, parking, `dom` 구성, module section과 state module의 page mount를 지운다. 그 뒤 manifest는 새 형식만 받는다.
- 위 core 항목이 모두 끝나면 `feat/view-kind-F212.7`을 main에 합친다. 합친 뒤 main에서 `make push-check`를 돌리고 worktree와 branch를 지운다.
- F212.15: 열린 개발 항목이 없을 때만 core를 release한다. 먼저 열린 항목을 나열한다. 그다음 각 plugin과 files, shell sidecar를 release한다.

## 보류 항목

지시 없이는 다음 항목을 작업하지 않는다: G1.4-87-1, G1.4-101-1-1, V5 background launch branch, R2-7, F54, F161.22, F161.30, F160.29.2. 상위 F160, F160.29, F161은 이 항목들과 함께 열려 있다.
