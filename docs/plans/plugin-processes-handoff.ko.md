# Plugin 프로세스: 남은 작업

[English](plugin-processes-handoff.md)

이 문서는 F212(plugin 코드를 main page 밖으로)와 그 옆의 열린 항목에서 남은 작업을 나열한다. 각 항목을 어떻게 하고 어떻게 검증하는지도 적는다. 다른 맥락 없이 이 문서와 AGENTS.md, 그리고 이 문서가 가리키는 파일만으로 작업을 시작할 수 있다. F212.15가 release되면 이 문서를 지운다.

## 정본

| 주제 | 파일 |
|---|---|
| 작업 규칙, checklist 규칙, Red/Green, commit 형식, branch와 worktree | `AGENTS.md` (+ `.ko.md`) |
| checklist | `docs/features.md` (+ `.ko.md`) |
| F212의 계약: 층, 통과값 (i)~(viii), 규칙 1~10, 메시지와 event, plugin host | `docs/spec/plugin-processes.md` (+ `.ko.md`) |
| 선언 UI 계약(list, tree, button, status-line, section, 주소, 거부) | `docs/spec/declared-ui.md` (+ `.ko.md`) |
| exposure 계약(명령, status, dom, `address`, 오류) | `docs/spec/exposure.md` |
| build, test parity, 창 검사, 진단 | `docs/operations/examples.md` |
| 비공개 WebKit API와 호출 조건 | `docs/operations/private-native-apis.md` |

view branch `feat/view-kind-F212.7`은 2026-10-21에 main에 합쳐지고 지워졌다. 위의 정본은 모두 main에 있다.

## 저장소 상태

### Branch와 worktree

2026-10-22 기준이다. push하는 것은 main뿐이고, 다른 branch는 공개하지 않는다.

| Branch | Worktree | 상태 | 다음 단계 |
|---|---|---|---|
| `main` | `core` | push됨. F212 view와 선언 UI 작업, F212.7-10~F212.7-13, F224~F227을 담는다 | — |
| `fix/host-contract-F220` | `../core-host-contract-F220` | F220 진행 중 | F220을 마치고 main에 합친 뒤 worktree와 branch를 지운다 |
| `feat/settings-G1.4-87-1` | `../core-settings-G1.4-87-1` | 보류 항목 | 건드리지 않는다 |
| `fix/background-launch-V5-117-1-3-4-7-1-8` | 없음 | 보류 항목 | 건드리지 않는다 |

대체된 두 branch의 커밋은 annotated tag 두 개가 보관한다. `git tag -l`로 볼 수 있다.

### Sidecar 저장소

| 저장소 | 열린 항목 | 비고 |
|---|---|---|
| `../sidecars/files` (origin `soksak-app/sidecar-files`) | 없음 | S31(프로세스의 첫 동작으로 log 기록)은 커밋되고 push됨. S26~S30은 커밋됨 |
| `../sidecars/shell` (remote 없음) | 없음 | S10~S15는 커밋됨 |

두 sidecar release는 core release(F212.15) 뒤에 한다. F212.1-2-2-3-1은 둘이 모두 공개될 때까지 열어 둔다.

## 작업 방법

### 모든 항목

개발이 먼저다. 항목은 바꾼 것의 소유 검사만 돌린다. 단위 시험(Red와 Green)과 그 항목이 건드리는 구조 검사다. 그다음 `[o]`로 표시하고 다음 항목으로 넘어간다. main에 합칠 때는 충돌 해결의 소유 검사와 pre-push hook이 도는 push 관문(`make push-check`)을 돌린다. 전체 모음(`pnpm test`, `make native-test`, `make host-contract-check`, `make verify`), 창 검사, 측정(F212.1-2-2, F212.1-3, F212.7a, F212.7b-1, F212.7c, F212.7d-1, F212.12~F212.14)은 활성 체크리스트의 모든 항목이 끝났을 때 한 번 돌린다. 항목마다, 수정마다, 재귀적으로 돌리지 않는다.

시험 시간 한도와 긴 실행의 진행 출력은 [AGENTS.ko.md](../../AGENTS.ko.md)(검증)의 규칙을 따른다.

1. `git fetch` 후 origin의 checklist를 먼저 읽는다.
2. 요청을 분류하고 항목을 등록한다(EN과 KO). 계약이 바뀌면 명세를 먼저 고친다.
3. 소유 module에 시험을 쓴다. 바꾸지 않은 코드에서 돌려 실패한 assertion을 기록한다(Red). module이 없거나 compile 오류, link 오류는 Red가 아니다. 코드가 이미 그 동작을 하면, 사본에서 그 동작을 끄고 assertion 실패를 본 뒤 파일을 되돌린다.
4. 구현하고 같은 시험을 돌린다(Green).
5. 커밋된 tree에서 변경이 닿는 소유 시험과 구조 검사를 돌린다. 전체 모음과 push 관문은 여기서 돌리지 않는다. push 관문은 main에 합칠 때, 전체 모음은 체크리스트 완료 때 한 번 돌린다.
6. 항목을 Red와 Green과 함께 `[o]`로 표시하고 CHANGELOG에 EN과 KO 항목을 더한다.
7. author `min-0-max <max@blue.tools>`, `type(scope): Subject (#ID)` 형식으로 커밋한다. 제목은 50자 이하다. 본문은 무엇을 왜 바꿨는지 72열로 감싸 적는다. footer와 trailer는 없다. commit-msg hook이 다른 형식을 거부한다. 경로를 명시해 stage하고 `git add -A`는 쓰지 않는다.

### 결합 금지

- Core, plugin, sidecar, kit, specification, contract는 서로 다른 repository(workspace의 폴더)이고, 어느 것도 다른 것의 구현을 알지 않는다.
- Registry(`environment.json`, settings, `plugin.json`)는 무엇이 어떤 version으로 설치되는지를 말한다. package 사이의 관계는 manifest의 `dependencies`로만 선언한다.
- Package는 contract의 wire와 노출된 command, DOM, status로만 주고받는다. 공통 기능은 core에, 기능은 plugin에 둔다. plugin 기능은 core로 옮기지 않는다.
- Package A의 시험은 package B의 구현을 검증하지 않는다. A는 fake와 fixture로 자기 경계만 시험하고, B는 자기 repository에서 자신을 시험하며, 공통 case는 contract가 정의하고 B가 실행한다. B의 경로, SDK, build, 실제 이름을 읽는 A의 시험은 금지다. fixture는 probe 이름(`probe`, `@scope/plugin-probe`, `@scope/sidecar-probe`)을 쓴다.
- 예외: core의 설치 기반 창 검사(`e2e/`)는 실제 plugin과 sidecar를 설치하고 그 관계와 동작을 함께 검사할 수 있다. 이것은 통합 수준이다. 설치는 registry와 manifest로만 하고, repository 경로나 build로 하지 않는다. 위 규칙은 core의 나머지 모두, 즉 unit test, script, product code, specification에 적용된다.

### Branch와 worktree

- 기본은 `main`에서 직접 작업한다. agent나 상황 때문에 격리가 필요하면 branch `{type}/{shortname}-{ID}`와 worktree `../core-{shortname}-{ID}`를 쓴다.
- branch는 push하지 않는다. 모든 branch는 main에 합치고, push하는 것은 main뿐이다.
- main에 합치기가 성공한 직후 worktree와 local branch를 지운다. 합치기가 실패했거나 아직 합치지 않은 것은 지우지 않는다. 지우는 조건은 합치기의 성공이다.
- main에 합칠 수 없는 시험 코드나 탐색 코드는 커밋 전에, 의미가 있으면 cherry-pick하고 아니면 버린다. 바로 지울 수 없으면 지울 조건을 적은 하위 checklist 항목을 등록한다.
- main에 합치기 전에 main에서 `git fetch`와 `git rev-list --count HEAD..origin/main`을 돌려, 0이 아니면 origin/main을 먼저 합친다. 합친 뒤 main에서 충돌 해결의 소유 검사를 돌린다. main을 push하면 pre-push hook이 `make push-check`를 돌린다.
- 새 worktree에서는 시험 전에 `make hooks`, `make native-darwin`, `make frontend-tauriv2`를 돌린다.
- CHANGELOG 충돌은 양쪽 항목을 모두 남긴다. `docs/operations/examples.md`의 기록된 수가 충돌하면 합친 tree에서 `make parity-check`가 출력하는 수를 쓴다.
- worktree를 옮기면 Tauri build cache가 옛 경로를 갖고 있어 clippy가 실패한다. 그 worktree에서 `cargo clean -p tauri -p soksak-tauriv2`를 돌린다.
- 관문 명령은 `&&`로 잇고, pipe로 잇지 않는다(`make x | tail && ...`). pipe는 마지막 명령의 상태를 돌려주므로 실패해도 이어진 명령이 멈추지 않는다. 출력은 log 파일에 쓰고 종료 상태로 판정하거나 `pipefail`을 켠다.
- 계약 case나 `packages/host`, `packages/sok`의 시험을 더하거나 건드리는 변경은 개발 중에 소유 Go 또는 Rust 시험을 돌린다. `make host-contract-check`는 체크리스트 완료 때 다른 전체 모음과 함께 한 번 돌린다. 어떤 push 관문도 이 검사를 돌리지 않으므로, merge 뒤 이 검사가 처음 도는 곳은 CI다(F220).

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

전체 suite(`pnpm test`, `make native-test`, `make host-contract-check`, `make verify`, 창 suite)는 항목 완료에 쓰지 않고 활성 체크리스트의 모든 항목이 완료된 뒤 배포 전에 한 번 돌린다. 개발 중에는 바꾼 것의 단위 시험만 돌리고, 간헐 실패의 반복 대상도 그 마지막 통과까지 기다린다.

### 창 검사와 측정

창 검사는 plugin이 설치된 application의 end-to-end 검사다. `docs/operations/examples.md`의 "Window checks"가 방법을 적는다. 두 application을 build하고, 일회용 설정에서 `--config-dir`와 `--registry-ca`로 띄우고, `pnpm -F @soksak/e2e verify`나 파일 하나를 돌린다. 규칙은 다음과 같다.

- `<config-dir>/endpoint.json`으로 연결한다. 선언된 exposure 항목과 native 입력만 쓴다. timer가 아니라 status 알림을 기다린다.
- 창을 활성화하거나 focus하지 않는다. `diagnostics.capture.still`로 캡처하고 `diagnostics.capture.start`와 `diagnostics.capture.stop`으로 녹화한다. 이미지는 원래 해상도로 본다. 이미지는 관찰이지 통과 결과가 아니다.
- 화면이나 시간 동작은 gesture 전체를 녹화하고, 잰 frame 간격과 좌표를 추적되는 증거로 만든다.
- 검사 중 application 오류는 검사가 `expectError`로 선언하지 않으면 모두 실패다.
- 입력기 검사(`make -C native/darwin test-activation`, `pnpm -F @soksak/e2e verify:activation`)는 사람의 승인을 받고만 돌린다.
- 시간 한도는 [AGENTS.md](../../AGENTS.ko.md)(검증)를 따른다.

### 검증이 필요한 결정

새 논거에 기대는 결정은 agent의 반대 검증을 거친다.

1. 첫 차례 전에 범위를 적는다. 문서가 정해야 할 것, 핵심 반론으로 볼 것, 범위 밖인 것(문구, 어떤 구현이든 같게 처리하는 경우, 단위 시험이 정할 세부)이다.
2. 반론마다 고칠 문장(파일, 줄, 인용)과 바꿀 내용을 낸다.
3. 반론마다 파일에서 근거를 직접 확인하고 받아들이거나 반박한다. 반박은 이유와 함께 같은 감사자에게 돌려보내고, 양쪽이 합의할 때까지 묻는다.
4. 차례마다 새 감사자를 쓰고, 최대 5차례다. 반론과 답은 관련 문서에 적는다.

## 남은 항목

아래 순서는 의존 관계를 따른다. ID는 checklist ID다.

### 1. F212 옆의 main 항목

main에서 완료: F218-2.1, F218-2.2, F218-2.3(F218-2.2를 막던 순서 의존 sidecar 시험은 F219가 하나씩 돌게 했다), F212.8a-4(계속 연결하는 service의 재시작 한도, 이로써 F212.8a 완료), F212.6a-1-3-2-2(멈춤은 main thread에서 WebKit과 시스템이 하는 page close 작업이라 host 변경은 없다).

**F218-2.4** — `fix/lock-unwraps-F218-2-4`에서 진행 중. `unwrap`이나 `expect`를 부르는 lock 결과 86곳. 변경과 시험은 같고, Red는 호출 thread의 panic이다.

**F218-2.5** — `rs.lock-result`를 찾은 곳 0으로 켜고 `scripts/census.json`의 pending 항목을 지운다. Green은 `make census-check`가 0을 보고하는 것이다. 그다음 F218-2를 `[o]`로 표시한다.

**F212.1-2-2** — fixture 답이 files sidecar의 첫 답을 12.4초 기다렸다. `host.trace.sidecar.ready`(F212.1-2-2-6)가 spawn에서 첫 답까지를 잰다. files sidecar의 S31은 커밋되었다. trace를 켜고 F212.1-2의 창 검사를 되풀이하고, `host.trace.sidecar.ready`와 sidecar의 첫 기록을 읽는다. 공백이 sidecar의 첫 기록 이전이면 원인은 프로세스 시작(binary 실행)이다. 잰 시간과 그 원인을 기록한다. 공백이 sidecar 안이면 거기서 고친다.

**F212.1-3** — 통과값 (iii)의 녹화 기반 DOM mount 기준값. 설치된 surface plugin마다, surface 시작 요청부터 첫 내용 frame까지 main page를 녹화하고(`diagnostics.capture.start/stop`) 5회의 중앙값을 load average와 함께 잡는다. `e2e/` 아래 추적되는 창 검사로 만들고, plugin마다 중앙값을 plugin 버전, load average와 함께 `docs/features.md`(+ `.ko.md`)의 F212.1-3 결과에 적는다. F212.1-2가 trace 중앙값을 적은 방식과 같다. 기준값의 정의는 `docs/spec/plugin-processes.md`의 통과값 (iii)이다.

### 2. Checklist 상태

완료: F212.3, F212.4, F212.6은 `[o]`다. F212.7은 F212.7a, F212.7b-1, F212.7c, F212.7d-1이 열려 있는 동안 `[ ]`로 둔다.

### 3. 선언 UI (F212.8)

완료: F212.8과 모든 하위. F212.8-6-3(선언 section의 출처와 전이), F212.8-6-4(그리기와 보고), F212.8-7(jsdom 그리기 시간: tree 중앙값 501.2 ms, list 중앙값 116.4 ms, declared-ui.md의 한도는 그대로)을 포함한다.

### 4. Plugin host (F212.9)

F212.9-1(명세 `docs/spec/plugin-host.md`)과 F212.9-2(native 연산)는 `feat/plugin-host-F212.9`에 커밋되었고, F212.9-3과 F212.9-4가 그곳에서 진행 중이다.

F212.9는 필요하다. view가 하나도 열려 있지 않을 때 sidebar section에 값을 보여 주는 plugin은 plugin host가 있어야 하기 때문이다(declared-ui.md, 출처 순서). 첫 사례는 files state다.
- 명세 먼저: `docs/spec/plugin-processes.md`의 "plugin host" 절(surface host가 아니라 창에 붙는 plugin host web view를 만드는 platform 연산, owner key `plugin:<id>`)과 규칙 5(한도 (vi) 안의 재시작, 마지막 저장값에서 state 복원).
- F212.9a: F212.10 전에 숨은 host web view의 footprint와 throttle을 잰다.
- native/darwin과 두 host에 구현하고, 계약 case, Go와 Rust 시험, native 시험을 둔다. F212.7-2의 view 통로 코드가 host 통로의 본보기다.

### 5. 계획을 명세로 (F212.7-9)

완료: 계획의 확정 계약은 `docs/spec/plugin-processes.md`(+ko)이며 계획은 지웠다. 계획의 검토 기록은 옮기지 않는다. 받아들인 각 해결은 `docs/spec/plugin-processes.md`나 `docs/spec/declared-ui.md`의 규칙이나 근거이고, F212.2, F212.5-1, F212.8-0부터 F212.8-0-23까지의 changelog 항목이 각 검토와 그것이 바꾼 것을 적는다. 계약이 아니라 작업인 계획의 부분은 이 문서에 있다. 6절의 배치, 7절의 통과값 규칙, 8절의 명세 변경, 되돌림 순서, 위험이다. 다른 branch의 `docs/plans/plugin-processes.md` link는 그 branch가 main을 합칠 때 `docs/spec/plugin-processes.md`로 바꾼다.

### 6. Plugin 이전 (F212.10)

각 이전은 그 plugin 저장소의 항목이며, main에 맞춰 한다. 아래 표가 `docs/spec/plugin-processes.md`의 층 규칙에 따라 plugin마다 대상을 정한다.

| Plugin | 표면 | Section | State와 로직 | 확장점 | Sidecar |
|---|---|---|---|---|---|
| editor | view(CodeMirror, 글 입력, IME) | — | — | 기여 plugin이 선언한 module을 core root에서 import | files |
| flowmark | view(자유 DOM) | — | — | — | 자기 것 |
| shell | 선언 어휘로 표현되면 선언 UI, 아니면 view. shell 이전 전에 항목 F212.10-shell-layer가 정한다 | — | — | — | shell |
| files | — | 선언 tree, 이름 바꾸기·끌기·context menu가 필요하면 view | files sidecar로 옮긴다. 불가하면 plugin host | — | files |
| hwp | 문서 region이 있는 view | — | — | — | files |
| browser | 문서 region이 있는 view | section 4개는 각각 선언 UI 또는 card 표면이 되며, browser 이전 전에 항목 F212.10-browser-sections가 정한다 | — | — | — |
| terminal | image region과 겹침 화면이 있는 view | — | — | — | vt |

- 항목 F212.10-shell-layer와 F212.10-browser-sections는 shell과 browser plugin 저장소의 checklist에 올리며, 표의 어느 칸도 그런 항목 없이 비워 두지 않는다.
- modal page는 범위에서 뺀다. 이를 쓰는 plugin이 없기 때문이다.
- files state를 sidecar로 옮기는 일은 files plugin과 files sidecar 저장소의 항목이다. editor buffer를 옮길지는 통과값 (iv)로 editor 저장소에서 정한다.
- `engines.soksak` 범위를 가진 plugin release는 F212.15의 core release 뒤에 발행한다. 각 release는 그 plugin 저장소의 항목이며, F212.15가 요구하는 core 버전을 발행할 때까지 미배포로 기록한다.

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

통과값은 `docs/spec/plugin-processes.md`의 "통과값" 절에 있다. 값을 만족하지 못하면 잰 값을 checklist에 적는다. 기구 값 (v), (vi), (viii)이 실패하면 기구 항목(F212.7b, F212.7c, F212.8a)과 그것에 기대는 항목을 멈춘다. plugin 값 (i), (ii), (iii), (iii-b)가 실패하면 그 plugin만 멈추고, 비용을 받아들일지 adversarial review에 올리는 명세 개정판에서 층을 바꿀지는 사람이 정한다. (iv)의 editor view footprint가 50 MB를 넘으면 F212.9 뒤에 editor buffer와 분석을 sidecar로 옮기는 항목을 더한다. F212의 완료에는 (i), (ii), (iii), (iii-b), (v), (vi), (viii)의 통과와 (iv)의 측정이 필요하다.

### 8. 제거와 release

- F212.11: plugin surface의 page mount, parking, `dom` 구성, module section과 state module의 page mount를 지운다. 그 뒤 manifest는 새 형식만 받는다. 같은 항목이 page mount를 적는 명세 문장을 바꾼다. plugin이 mount한 DOM을 소유하는 app DOM WebView 하나(`docs/spec/plugins.md`의 "표면 모듈 소유권" 절과 "DOM 탭" 문단), 단일 application DOM과 mount된 plugin 문서를 바꾸는 reload(`docs/spec/surface-composition.md`), 공유 application DOM 안의 plugin module 좌표(`docs/spec/exposure.md`)이며, 번역도 바꾼다.
- 되돌림: core 단계는 그것을 요구하는 plugin release를 이전 `engines` 범위로 되돌려 release한 뒤에만 되돌린다. F212.10은 각 plugin을 이전 `engines` 범위로 release해 되돌린다. F212.11은 옛 경로를 지우므로 F212.10을 되돌린 뒤에만 그 commit을 되돌린다. 각 단계의 되돌림 순서는 그 checklist 항목에 적는다.
- 위험: IME, 끌기와 배치, 프로세스 수와 첫 표시 시간, Wails 호출 통로.
- F212.15: 열린 개발 항목이 없을 때만 core를 release한다. 먼저 열린 항목을 나열한다. 그다음 각 plugin과 files, shell sidecar를 release한다.

## 보류 항목

지시 없이는 다음 항목을 작업하지 않는다: G1.4-87-1, G1.4-101-1-1, V5 background launch branch, R2-7, F54, F161.22, F161.30, F160.29.2. 상위 F160, F160.29, F161은 이 항목들과 함께 열려 있다.
