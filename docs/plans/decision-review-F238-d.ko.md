# F238-d 결정 검토: 레지스트리 목록, 호스트 계약 소스, 플러그인 배치

[English](decision-review-F238-d.md)

이 기록은 적대적 검토 없이 내려진 F238의 세 결정을 검토한다: D2(core의 레지스트리 목록), D8(호스트 계약 검사의 sok 소스), D9(files와 shell의 플러그인 배치). 각 결정은 결정 내용, 파일과 줄 번호의 근거, 필요한 정확한 변경을 적는다. 새 감사자는 결정이 틀리거나 불완전하면 반론을 내고 해결책을 제시한다. 부모는 각 반론에 근거로 답하거나 결정을 바꾼다. 한 라운드의 두 감사자가 실질적 반론이 없을 때까지 라운드를 반복한다. 각 라운드의 본문은 git 이력에 있고, 이 파일은 현재 본문과 답변을 담는다.

## 범위

- 대상: 각 결정이 옳은지, 무엇이 빠졌는지, 그 결정을 옳게 만드는 변경.
- 제외: 문구, 인용 정확도, 모든 구현이 같은 방식으로 해결하는 사례. 결정에 적힌 단위 테스트가 세부를 정한다.
- 기준은 증거가 있을 때만 바뀌며, 테스트가 도달하지 못한다는 이유로 낮추지 않는다.

## 방법

- 코드는 소유 worktree에서 읽고, 다른 브랜치는 `git show <branch>:<path>`로 읽는다. 다른 브랜치를 checkout하지 않는다.
- 라운드마다 새 감사자 두 명(claude-haiku-5-5, 읽기 전용)이 결정 본문과 코드 경로를 받는다. 실질적 반론과 구체적 해결책만 반환한다.
- 각 반론은 파일에서 확인한 뒤 수락(결정 본문 변경)하거나 반박(근거 제시, 같은 감사자에게 반환)한다.

## D2. core의 레지스트리 목록

결정: core는 `scripts/workspace-registry.json`을 core 도구가 읽는 형제 저장소의 선언으로 유지하고, `docs/spec/plugins.md`의 저장소 표를 문서로 유지하며, CI에서 형제 checkout을 유지한다. 코드와 맞지 않는 세 문장을 바로잡는다.

근거:

- `scripts/workspace-registry.json`은 플러그인 `browser`, `editor`, `files`, `hwp`, `terminal`, 사이드카 `files`(폴더 `.`)와 `vt-alacritty`, 팩 `starter`(`browser`, `terminal`, `files`)를 선언한다.
- `docs/spec/plugins.md`의 Repositories 단락: "none reads the files of another."는 거짓이다. `scripts/check-boundaries.mjs:27-42`는 선언된 모든 폴더의 `package.json` 이름과 의존 키, `plugin.json`의 id를 읽고, 형제가 없으면 `readJson`이 던진다. `Makefile:374-375`(`registry`)와 `Makefile:382-388`(`install-plugins`)은 선언된 형제 저장소를 읽어 패키징하고 설치한다.
- 저장소 표는 "The plugins are `browser`, `terminal`, `files` and `shell`"이라고 쓴다. 레지스트리는 `editor`와 `hwp`를 선언하고 `shell`은 선언하지 않는다.
- `AGENTS.md:32`는 "`environment.json` lists plugins"라고 쓰고, `AGENTS.md:33`은 `environment.json`을 "설치된 버전을 나열하는" 매니페스트에 넣는다. `CHANGELOG.md:1023`(R1-2-3-3)은 `environment.json`이 더 이상 플러그인을 나열하지 않는다고 기록한다. 그러나 탭은 여전히 플러그인을 이름으로 가리킨다: `apps/wailsv3/environment.json:47`(`"plugin": "terminal"`), `:60`과 `:115`(`"plugin": "browser"`). 설치 목록은 `plugins/installed.json`에 있다(`Makefile:385`가 그 `plugins` 키를 읽는다).
- `.github/workflows/ci.yml:19-46`은 `plugins/browser`, `plugins/editor`, `plugins/files`, `plugins/hwp`, `plugins/terminal`, `sidecars/files`, `sidecars/vt`를 checkout한다. `ci.yml:73`은 Structure 작업에서 `make boundaries`를 실행한다. `window-checks.yml`은 `make install-plugins`를 위해 같은 형제를 checkout한다.
- `scripts/check-registry-manifests.mjs`는 네트워크로 플러그인 릴리스를 내려받는다. `release-check`(`Makefile:35`)에서 실행되며 `push-check`에서는 실행되지 않고, 형제 파일을 읽지 않는다.
- `scripts/check-test-parity.mjs`는 `scripts/workspace-registry.mjs`를 lane 파일로만 언급한다. 레지스트리 json을 읽지 않는다.

필요한 변경:

- R2.1 `docs/spec/plugins.md`(Repositories 단락, `.ko.md`도 동일): "none reads the files of another."를 다음으로 바꾼다: "`make boundaries`는 `scripts/workspace-registry.json`이 선언한 각 폴더의 `package.json` 이름과 의존 키, `plugin.json`의 id를 읽고, 선언된 폴더가 없으면 실패한다. `make registry`와 `make install-plugins`는 선언된 형제 저장소를 읽어 패키징하고 설치한다."
- R2.2 `docs/spec/plugins.md` 저장소 표(`.ko.md`도 동일): "The plugins are `browser`, `terminal`, `files` and `shell`"을 "The declared plugins are `browser`, `editor`, `files`, `hwp` and `terminal`, the same as `scripts/workspace-registry.json`. `shell` has a repository, is not published and is not declared."로 바꾼다. 사이드카 행은 선언된 폴더로 `vt-alacritty`를 적는다.
- R2.3 `AGENTS.md:32-33`과 `AGENTS.ko.md:32-33`: "`environment.json` lists plugins"를 "`environment.json` names plugins only as tab and sidebar references in `workspace` and `sidebars`; it does not install them."로 바꾼다. 33행의 설치 버전 매니페스트 목록에서 `environment.json`을 뺀다. `plugins/installed.json`이 설치된 플러그인을 나열하고, `scripts/workspace-registry.json`이 `make boundaries`와 `make registry`가 읽는 형제 폴더를 선언한다는 점을 적는다.
- R2.4 Red와 Green: `scripts/test/workspace-registry.test.mjs`에 사례를 추가한다. `docs/spec/plugins.md` 저장소 표의 선언된 플러그인 이름과 `scripts/workspace-registry.json`의 `plugins`가 같은지 단언한다. 변경 전 표는 `shell`을 나열하고 `editor`와 `hwp`를 빠뜨리므로 실패한다. R2.2 후 Green.
- R2.5 CI: `ci.yml`은 바꾸지 않는다. 스펙은 Structure 작업과 window 검사가 `make boundaries`와 `make install-plugins`를 위해 형제 checkout을 필요로 한다고 적는다.

범위 밖: 레지스트리 선언을 registry 저장소로 옮기는 일.

## D8. 호스트 계약 검사의 sok 소스

결정: 호스트 계약 검사는 sok 선언(`packages/sok/wailsv3/tests`, `packages/sok/wailsv3/src/*_test.go`, `packages/sok/tauriv2/tests`, `packages/sok/tauriv2/src`)을 계속 읽고, 선언을 결과와 맞추는 방식을 바꾼다. F218-2.4-1 변경은 이미 `origin/main`에 있으며 수정(amend)하지 않는다. 수정은 새 변경이다.

근거:

- `scripts/check-host-contract.mjs:166-167`은 각 호스트 선언을 위해 sok 테스트 폴더와 소스 폴더를 읽는다.
- 같은 테스트 이름이 두 패키지에 있다: `packages/host/wailsv3/tests/plugins_test.go:92-93`은 `TestPluginsStateReportsTheRegistryAndTheInstallation`에 `plugins.state.reports-registry-and-installed`를 선언하고, `packages/sok/wailsv3/tests/plugins_test.go:296-297`은 같은 이름에 `cli.plugin.state-reads-registry-and-installed`를 선언한다.
- 가려짐: `groupResults`(`check-host-contract.mjs:91-100`)는 결과를 실행(run)과 테스트 이름으로만 묶는다. `statusOf`(`:103-114`)는 호스트의 모든 실행에서 이름이 같은 모든 결과를 가져간다. `wailsv3`에서는 호스트 실행과 sok 실행이 모두 `host.runs`에 들어간다(`:173-179`). 그래서 호스트 통과가 sok 선언의 통과로 계산되고, `auditHostContract`(`:132-138`)는 sok 사례를 충족으로 센다. 이 기록의 검증 실행에서 재현했다.
- Rust: `statusOf` 107행은 `name.endsWith('::' + test.name)`로 맞춘다. 같은 크레이트의 서로 다른 모듈에 같은 잎 이름의 테스트 함수가 둘 있으면 한 선언이 둘 다에 맞는다. libtest `--list` 이름은 모듈 경로다(`test-discovery.mjs:83`).
- 속성: `parseDeclarations`(`:78`)는 모든 `#[` 줄을 건너뛴다. `packages/host/tauriv2/tests/endpoint_test.rs:176-178`은 선언과 `#[test]` 사이에 `#[cfg(feature = "diagnostics")]`를 둔다. 이 사례는 검사가 요구하는 diagnostics 구성에서 실행된다. 같은 자리의 `#[should_panic]`이나 `#[ignore]`는 보고되는 결과를 바꾸는데도 보고 없이 통과한다.
- `docs/spec/host-contract.md:22`는 호스트 경로만 적는다.
- sok lock 테스트는 sok 크레이트에 컴파일된다: `packages/sok/tauriv2/src/event_log.rs:1307-1309`는 `#[cfg(test)] #[path = "event_log_lock_test.rs"] mod lock_test;`를 선언하고, `packages/sok/tauriv2/src/sok.rs:19`는 `pub mod event_log`를 선언한다.

결정 본문:

- D8.1 소유자 대응: 선언된 테스트는 자신의 소유자 항목에서만 결과를 얻는다. 소유자는 Go에서 패키지 디렉터리(발견된 패키지의 `pkg.dir`, 즉 테스트 파일의 디렉터리)이고, Rust에서는 크레이트 디렉터리(빌드 메시지의 `dirname(manifest_path)`)다. 발견된 항목은 소유자를 가진다. `groupResults`는 결과를 실행, 소유자, 테스트 이름으로 묶고, `statusOf`는 선언의 소유자를 받아 그 소유자의 항목만 본다. 호스트와 sok 결과는 합치지 않는다.
- D8.2 Rust 잎 이름: 선언은 잎 함수 이름을 적는다. 한 크레이트에 대해 `--list`가 보고한 테스트(선언 여부와 무관) 중 같은 잎 이름이 두 번 나오면 검사는 실패한다. 선언은 마지막 경로 세그먼트가 잎과 같은 단 하나의 항목에 맞는다. 검사는 모듈 경로를 풀지 않는다. `mod` 사슬과 `#[path]`를 풀려면 검사가 구현하지 않는 해석이 필요하다.
- D8.3 속성: `// contract:` 선언과 `fn` 사이에 허용되는 속성 줄은 `#[test]`, `#[tokio::test]`, `#[cfg(feature = "...")]`다. `cfg` 줄은 테스트가 컴파일되는 구성을 고르며 보고되는 결과를 바꾸지 않는다. 그 밖의 `#[` 줄은 파일, 줄, 속성 이름을 적은 오류다(예: `#[should_panic]`, `#[ignore]`).
- D8.4 스펙: `docs/spec/host-contract.md:22`(`.ko.md:22`도 동일)는 모든 선언 경로를 적는다: `packages/host/wailsv3/tests/`, `packages/host/wailsv3/src/*_test.go`, `packages/sok/wailsv3/tests/`, `packages/sok/wailsv3/src/*_test.go`, `packages/host/tauriv2/tests/`, `packages/host/tauriv2/src/`, `packages/sok/tauriv2/tests/`, `packages/sok/tauriv2/src/`. "Check" 절은 D8.1의 소유자 규칙과 D8.3의 속성 규칙을 적는다.
- D8.5 Red와 Green: 소유 모듈인 `scripts/test/check-host-contract.test.mjs`에 합성 입력으로 `auditHostContract`를 호출하는 사례를 추가한다.
  1. 한 소유자에 호스트 통과가 있고 같은 이름의 sok 소유자 결과가 없으면, sok 선언은 `did not run`을 보고한다. 변경 전 코드에서는 오류가 없어 Red이고, D8.1 후 Green이다.
  2. 같은 실행에서 같은 이름이 두 소유자에 있고 하나는 실패, 하나는 통과하면, 각 선언은 자기 상태를 보고하며 실패한 소유자의 선언은 `fail`을 보고한다. 변경 전 코드에서는 통과로 합쳐져 Red이고, D8.1 후 Green이다.
  3. 한 크레이트에 같은 잎 이름의 Rust 테스트 둘이 있으면 검사가 실패한다(D8.2).
  4. 선언과 `#[test]` 사이의 `#[cfg(feature = "diagnostics")]` 줄은 통과한다(D8.3 Green). 그 자리의 `#[should_panic]` 줄은 실패한다(D8.3 Red, 변경 전 코드는 조용히 통과시킨다).

## D9. 플러그인 배치: files와 shell

결정: files 사이드바는 선언형 UI로 옮긴다. `files.tree`는 `tree`와 알림을 담는 값을 가진 status 섹션이 되고, `files.bookmarks`는 `list`를 가진 status 섹션이 된다. 그들의 상태는 files 플러그인 호스트가 보유하며, 호스트가 status를 제공한다. shell 카드는 view로 남고, 그 세 사이드바 섹션은 그 view가 제공하는 선언된 status다.

### files: 근거

- `plugins/files/plugin.json`은 섹션 `files.tree`와 `files.bookmarks`를 각각 `module` 형태(`horizontal`과 `vertical`)로 선언하고, `state.module`로 `ui/state.js`를 선언한다. 설명은 카드 표면이 없다고 말한다. 그 status인 `files.tree`, `files.bookmarks`, `files.git`, `files.selection`, `files.open`은 module 시대의 스키마를 가진다(예: `files.tree`는 `root`, `error`, `entries`).
- files UI가 쓰는 것: 펼침 토글; 누르면 선택(`tree.js`와 `tree-horizontal.js:59`); 두 번 누르면 열기(`tree-horizontal.js:61`, `dblclick`의 `core.file.open`)와 선택된 파일에서 Enter(`tree.js:124`); 행마다 북마크 추가(`tree-horizontal.js:65`); 행마다 git 표시(`tree-horizontal.js:62`, `data-part="git"`의 `marker`); 열기 실패를 헤더 제목 옆에 보이는 알림(`tree-horizontal.js:15-17`, `:29`); 선택한 경로를 북마크에 넣는 헤더 별(`tree.js:82-85`, `:119`); 새로고침(`tree-horizontal.js:17`); 북마크 삭제(`bookmarks.js:39`); 아이콘 `star`와 `rotate-cw`(`tree.js:85`, `:90`)는 core 아이콘 표의 이름이다(`packages/workbench/icons.js:6`).
- 컨텍스트 메뉴, 이름 바꾸기, 끌어 놓기는 없다: `ui/sections/*.js`와 `ui/state.js`에서 `contextmenu`, `rename`, `drag`를 찾으면 일치가 없다. `context`라는 단어는 `context.bind`와 `context.icon`에만 맞는다.
- `ui/state.js`는 `./events.js`(3행)만 가져오고 DOM 참조가 없다(플러그인 저장소의 작업 트리에서 `document`, `window`, `innerHTML`, `createElement`, `querySelector`, `appendChild`를 찾으면 일치가 없다. 커밋 이력은 여기서 확인하지 않는다).
- `docs/spec/declared-ui.md:145`: "A registration by a state module does not serve a declared UI status." 선언된 status는 카드의 view 또는 플러그인 호스트가 제공한다(`docs/spec/plugin-processes.md:28`). files 플러그인은 카드 표면이 없으므로 플러그인 호스트가 유일한 경로다.
- `docs/spec/declared-ui.md:56`과 `:171`: `tree`는 가로 섹션에 그려지지 않는다. files 플러그인은 가로 tree module을 가진다(`tree-horizontal.js`).
- `docs/spec/declared-ui.md:17-22`: 선언된 status는 `exposes.status`의 스키마를 노출 스펙이 받는 부분집합 `{"type":"object","properties":{"elements":{"type":"array"}}}`로 선언한다. 현재 files 스키마는 이 형태가 아니다.
- `docs/spec/declared-ui.md:117`: 펼침 명령은 플러그인에 "닿지 않는다". 플러그인은 펼침을 알아야 한다. 그 `files.tree` status가 펼친 디렉터리의 자식을 나열하기 때문이다(`plugin.json`의 `files.tree` 설명).
- `docs/spec/declared-ui.md:111-112`: `command`는 누를 때 실행된다. 두 번 누름을 위한 요소는 없다.
- 가로 tree의 백로그 항목 F230은 `../core-host-routes-F229/docs/plans/plugin-host-routes.md:55`에 이름만 있다. 그 파일은 커밋되지 않았다. `git show feat/host-routes-F229:docs/plans/plugin-host-routes.md`는 실패하고, 그 브랜치의 `docs/features.md`에는 F230이 없다. 이 기록은 F230을 예정된 항목으로 보지 않는다.
- files 나열과 git 상태는 files 사이드카에서 온다. 플러그인은 사이드카가 변경을 알리면 다시 나열한다(`files.tree` 설명). `docs/spec/plugin-host.md:5`는 플러그인 호스트가 view도 사이드카도 보유할 수 없는 DOM 없는 로직을 실행한다고 말한다. `main`의 `plugin-host.md`는 호스트에서 플러그인 사이드카 이벤트로 가는 채널을 정의하지 않는다. 한 감사자가 인용한 "no sidecar send"라는 문구는 그 문서에서 찾지 못했다.
- 사이드카 메시지 중계의 기존 경로: 호스트는 각 사이드카 메시지를 그 표면에 처음 보낸 창에 `sidecar-message` 이벤트 `{sidecar, surface, body}`로 전달한다(`docs/spec/sidecars.md:46`). 중계는 표면 단위이므로, 표면이 없는 플러그인 호스트는 오늘 사이드카 이벤트로 가는 경로가 없다.

### files: 결정 본문

- D9.1 어휘. 각 빈틈은 view가 아니라 `declared-ui.md`의 스펙 변경으로 닫는다:
  - (a) 가로 tree: 가로 섹션의 `tree`는 보이는 행(루트 노드와 펼친 가지의 자식을 순서대로)을 섹션 너비에서 줄바꿈하는 한 줄로 그린다. 세로 형태의 노드 컨트롤을 쓰고 들여쓰기는 없다. tree의 요소 한도는 그대로 적용된다. `declared-ui.md`의 `:56`과 `:171`은 이 규칙을 가리키도록 바뀐다.
  - (b) `open` 노드 필드: 트리 노드는 `open`을 선언할 수 있다. 이는 `command`의 규칙(`<plugin>.<name>` 형식, `params` 한도, 선언된 명령 검사)을 따르는 명령이다. 노드의 두 번 누르기에서 두 번째 누름은 `command` 대신 `open`을 실행한다. 두 번 누르기의 첫 누름은 `command`를 실행하고, 두 번째는 `open`만 실행한다. 두 번 누르기는 플랫폼의 두 번 클릭 간격 안의 두 번 누름이다. 초점이 있는 노드에서 Enter는 `open`을 실행한다(두 번 누르기의 키보드 대응). 스펙이 쓰기 전에 새 제스처 용어는 `packages/plugin-api/terms.json`에 넣는다.
  - (c) 선택: `files.select`는 누를 때 실행되고, 플러그인은 다음 값에서 `selected`를 정한다. 클릭마다 왕복이 생기며, 선언형 tree의 비용으로 받아들인다.
  - (d) git 표시: 트리 노드는 라벨 뒤에 그려지는 평문 문자열 `detail`(최대 500 코드 포인트)을 선언할 수 있다. 호스트가 files 사이드카의 git 상태로 값을 정한다. `files.git` status를 대체한다.
  - (e) 행 동작: 트리 노드는 `actions`를 선언할 수 있다. `button` 객체의 배열(최대 2개)이며 `button`의 규칙(`command`, `params`, `icon`, `enabled`)을 따르고, 라벨 뒤에 그려진다. 행별 북마크 추가가 한 동작이다. 노드의 `command`(누름)와 `actions`는 서로 다른 컨트롤이다.
  - (f) 알림: `files.tree` 값은 `tree` 앞에 `status-line` 요소를 둘 수 있으며, 열기 실패 문구를 그린다. `files.open` status를 대체한다. 오류 색은 `AGENTS.md`가 로그 경로에만 허용하므로, 이 문구는 평문 상태 줄이다. 오류 자체는 나타나는 순간 로그에 쓴다(`AGENTS.md`의 표시 규칙).
  - (g) 헤더: `files.tree` 값은 `tree` 앞에 `button` 루트 요소를 둘 수 있다. 새로고침은 한 버튼이다. 헤더 별은 `params`를 호스트가 선택 경로로 정하는 `button`이므로, 선택이 바뀌면 값이 바뀐다. 플러그인은 선택을 받아들일 때 새 값을 보낸다.
- D9.2 플러그인 호스트와 사이드카. files 나열과 git 상태는 files 사이드카가 만들며, 호스트는 사이드카 이벤트 없이 그것을 가질 수 없다. 사이드카 데이터가 필요 없는 DOM 없는 로직(펼친 집합, 선택, 북마크 목록)은 호스트가 가질 수 있다. 결정: `docs/spec/plugin-host.md`에 표면 없는 중계를 추가한다. 플러그인 호스트는 자기 플러그인의 사이드카 이벤트를 view가 쓰는 것과 같은 중계로 받고, 실패는 사이드카 실패 계약(`docs/spec/sidecars.md#failure`)을 따른다. 두 호스트에 사례 `plugin-host.sidecar.events-delivered`를 둔다. 중계는 표면 키이므로, 표면 없는 호스트를 위한 키(플러그인 호스트 소유 키)를 정하는 것이 스펙 본문의 일부다. 대안인 나열을 view에 두는 것은 거부한다. files 플러그인에는 카드 표면이 없고, 카드 표면을 만들면 `plugin-processes.md:26`의 배치 규칙에 따른 배치 변경이 되기 때문이다.
- D9.3 펼침. 펼침 명령은 status 원천에 닿는다. `declared-ui.md:117`에 규칙이 추가된다. 펼침 명령은 원천이 view 또는 플러그인 호스트일 때, `{status, tree, path, expanded}`를 메시지 `declared-ui.expanded`로 status 원천에 보낸다. 같은 변경이 `:137`을 갱신한다. 그 줄은 유지되는 상태가 `core.declared-ui.tree.expand`로만 정해진다고 말한다. 사례 `declared-ui.expanded`는 두 호스트의 테스트 집합과 `packages/workbench` 테스트에 추가된다.
- D9.4 스키마. 각 files status는 `declared-ui.md:17-22`의 선언 부분집합으로 다시 쓰거나 제거한다:
  - `files.tree`: `files.tree` 값의 스키마(요소: 알림, 헤더 버튼, `tree`). 옛 `root`, `error`, `entries` 형태는 제거한다.
  - `files.bookmarks`: `list` 요소를 가진 값의 status.
  - `files.git`: status로서 제거한다. 내용은 D9.1d의 노드 `detail`이다.
  - `files.selection`: status로서 제거한다. 호스트 상태이며 헤더 별과 Enter가 쓴다.
  - `files.open`: status로서 제거한다. 내용은 D9.1f의 알림이다.
  이동과 함께 `files.git`, `files.selection`, `files.open`의 `exposes.status` 항목은 `plugin.json`에서 빠진다.
- D9.5 순서와 재개 작업. `F212.8`은 `[o]`(`plugin-processes-handoff.md:143`)이며 `[o]`로 남는다. D9.1a, D9.1b, D9.1d부터 D9.1g, D9.3의 후속 항목은 F212.8 아래 새 ID로, 이 검토가 닫힐 때 `docs/features.md`(+ko)의 F212 아래에 적는다. D9.2는 F212.9 아래 새 항목이다. 그다음 F212.9-4-1(상태 호출, `plugin-processes.md`의 규칙 5), 그다음 files 이동(F212.10-files, files 저장소), 그리고 F212.11이 남은 섹션의 module 형태를 제거한다.
- D9.6 이동 전까지 `files.tree`와 `files.bookmarks`의 module 형태는 남는다. `plugin-processes.md:27`("Module section (today)")이 그렇게 말한다. 이는 현재 형태이며 낮춘 기준이 아니다. 이동은 F212.11보다 먼저 온다.
- D9.7 DOM 검사: `plugins/files/test/`에 이동의 호스트 로직 모듈을 읽고 DOM 참조(`document`, `window`, `innerHTML`, `createElement`, `querySelector`, `appendChild`)가 있으면 실패하는 테스트를 둔다. Red: `ui/state.js` 사본에 `document.createElement("div")`를 넣으면 실패한다. 변경 없는 state 모듈과 이동 후의 호스트 로직 모듈에서 Green이다.

### shell: 근거

- `plugins/shell/plugin.json`은 카드 표면 `ui/index.html`을 `view`로 선언하고, 섹션 `shell.history`, `shell.cwd`, `shell.jobs`를 `status` 형태로 선언한다. `surface.unload`는 format 1과 `maxBytes` 8192를 선언한다.
- 카드는 텍스트 입력을 가진다(`plugins/shell/ui/shell.js:6`). `plugin-processes.md:24-26`의 층 규칙은 이를 view에 둔다("IME가 필요한 텍스트 입력").
- `shell.history`는 페이지 배열 `history`(`shell.js:31`)이며, 페이지가 덧붙인다(`:71`). `shell.jobs`는 페이지의 `runs` 맵으로 만든다(`:32`, `:48-49`, `:59`). `shell.js:56`은 unload가 셸 세션을 끝낸다고 말하고, 실행 중인 명령은 탭을 적재된 채로 둔다. `shell.js:119`와 `:146-154`는 탭 상태에서 cwd를 복원한다.
- 호스트를 요구하는 조건은 `plugin-processes.md:27-28`이다. 플러그인의 어떤 view도 열려 있지 않은 동안 값을 보여야 하는 사이드바 섹션은 플러그인 호스트가 필요하다. shell 섹션에는 그런 요구가 없다. 그 값은 열린 셸 세션의 상태이고, 카드의 view가 그 원천이다(`declared-ui.md:145`). 원천이 없으면 섹션은 지워진다(`declared-ui.md:145`, 단계 (b)).

### shell: 결정 본문

- D9.8 shell은 자기 view를 원천으로 하는 선언된 status 섹션 셋을 가진 view로 남는다. shell의 층은 F212.10 표의 view 층이다. shell에는 호스트를 만들지 않는다. 호스트 규칙의 전제는 명시한다: shell 섹션은 shell view가 열려 있지 않은 동안 값을 보여야 하는 것이 아니다.
- D9.9 받아들이는 비용을 전부 적는다:
  - `shell.history`와 `shell.jobs`는 페이지의 세션 상태다. 탭의 unload(메모리 세이버)는 셸 세션을 끝내고, 두 목록은 그와 함께 지워진다. `plugin.json`의 `shell.history` 설명은 "the nonblank lines written to the shell session ... oldest first"에서 "the nonblank lines written to the current shell session through shell.write, oldest first, cut to the last 1000; an unload of the tab ends the session and clears the list"로 바뀐다. 같은 변경을 shell 저장소에도 한다.
  - `cwd`는 unload 뒤 탭 상태에서 복원된다(`shell.js:119`, `:146-154`).
  - 카드가 닫혀 있거나 자기 카드의 활성 탭이 아닌 동안 세 섹션은 지워진다(`declared-ui.md:145`). `shell.jobs`의 중단 컨트롤은 페이지가 적재된 동안에만 실행된다.
- D9.10 shell 항목 `F212.10-shell-layer`는 이 결정으로 닫힌다. shell 저장소 체크리스트 P10에 기록한다(다른 곳에 기록할 항목 참고).

## 검증 실행 (부모, 이 worktree)

- `/tmp/d8-probe.mjs`(임시 probe이며 수락 근거가 아니다)는 `auditHostContract`를 호출한다. 입력은 `wailsv3` 선언 하나(`TestPluginsStateReportsTheRegistryAndTheInstallation`, 파일 `packages/sok/wailsv3/tests/plugins_test.go`, 사례 `cli.plugin.state-reads-registry-and-installed`)와, 같은 이름이 통과했고 sok 실행이 없는 호스트 실행 하나다. 출력: `errors: []`, `covered: ["cli.plugin.state-reads-registry-and-installed"]`, 종료 코드 0. 이것이 D8의 가려짐이다.
- 초안이나 감사자의 문장이 아니라 파일에서 확인한 사실: `scripts/workspace-registry.json`, `scripts/check-boundaries.mjs:27-42`, `Makefile:374-388`, `.github/workflows/ci.yml:19-46,73`, `apps/wailsv3/environment.json:47,60,110,115`, `scripts/check-host-contract.mjs:91-114`, `packages/host/tauriv2/tests/endpoint_test.rs:176-178`, `docs/spec/declared-ui.md:17-22,56,111-117,145,171`, `docs/spec/plugin-processes.md:24-28`, `docs/spec/sidecars.md:46`, `packages/sok/tauriv2/src/event_log.rs:1307-1309`, `packages/sok/tauriv2/src/sok.rs:19`, `plugins/files/plugin.json`, `plugins/files/ui/sections/tree.js:82-124`, `plugins/files/ui/sections/tree-horizontal.js:15-65`, `plugins/shell/plugin.json`, `plugins/shell/ui/shell.js:6,31-71,119,146-154`.

## 라운드 1

감사자: 새 하위 에이전트 두 명, 각자 세 결정 전체를 검토. 반론은 열세 개였다(D2: 각 감사자 1개씩 두 건, 같은 내용; D8: 3; D9: 9개의 서로 다른 반론). 각 반론과 답변:

- A-D2-1(R2.3이 부분적으로 거짓, environment 탭이 플러그인을 이름으로 가리킴): 수락. `apps/wailsv3/environment.json:47,60,110,115`로 확인. R2.3 교체.
- D2의 다른 반론 없음. 두 감사자 모두 레지스트리 내용, `check-boundaries.mjs:27-42`, Makefile 대상, CI와 `shell` 불일치를 확인했다.
- A-D8-2와 cfg 사례(D8.3이 `#[cfg(feature)]` 선언을 깬다): 수락. `endpoint_test.rs:176-178`로 확인. D8.3은 `cfg(feature)`를 허용하고 결과를 바꾸는 속성을 거부한다.
- A-D8-3과 B-D8-7(`groupResults`가 `statusOf` 전에 소유자를 합친다): 수락. `check-host-contract.mjs:91-100`로 확인. D8.1은 실행, 소유자, 이름으로 묶고 D8.5에 사례를 추가한다.
- B-D9-1(플러그인 호스트가 목록에 필요한 사이드카 이벤트를 받을 수 없다): 필요한 스펙 변경으로 수락. 인용된 "no sidecar send" 문구는 main의 `plugin-host.md`에 없다. 실질 지적은 확인되었다: 스펙은 플러그인 사이드카 이벤트로 가는 호스트 채널을 정의하지 않는다. D9.2가 중계를 추가한다. view 경로 확인은 라운드 2 항목으로 처리했다. view 채널 대안은 D9.2에서 거부했다.
- B-D9-2(펼침이 플러그인에 닿지 않는다): 수락. `declared-ui.md:117`("does not reach the plugin")로 확인. D9.3이 `declared-ui.expanded` 메시지를 추가한다.
- A-D9-4와 B-D9-3(어휘 빈틈: git 표시, 행 북마크 동작, 열기 알림, 헤더 별, Enter로 열기): 수락. `tree-horizontal.js:15-17,29,62,65`와 `tree.js:82-85,119,124`로 확인. D9.1(d)부터 (g)가 추가한다. Enter로 열기는 D9.1b다.
- A-D9-4(컨텍스트 검색 문구를 재현할 수 없다): 수락. 이제 `contextmenu`, `rename`, `drag`를 적는다.
- A-D9-5와 B-D9-5(D9.1a와 D9.4가 충돌): 수락. D9.5가 하나의 문구다: 새 ID, F212.8은 `[o]`.
- A-D9-6(두 번 누르기에서 select가 두 번 실행): 수락. D9.1b는 두 번째 누름을 `open`만으로 정한다.
- B-D9-4(스키마가 다시 쓰이지 않음, status마다 처리가 없음): 수락. `declared-ui.md:17-22` 규칙과 module 시대 스키마를 확인했다. D9.4가 status마다 처리를 준다.
- A-D9-7과 B-D9-6(shell의 층 규칙과 기록 손실): 부분 수락. unload에서 기록이 사라지는 것은 실제다. `shell.js:56`은 unload가 세션을 끝낸다고 말한다. 이제 비용을 전부 적고 `shell.history` 설명을 바꾼다(D9.9). 층 규칙은 어기지 않는다. `plugin-processes.md:27-28`은 플러그인 view가 모두 닫혀 있는 동안 값을 보여야 하는 섹션에만 호스트를 요구하고, shell 섹션에는 그 요구가 없다. 이 전제를 D9.8에 명시했다. 감사자의 shell 호스트 제안은 이 근거로 반박했고, 라운드 2에서 감사자에게 돌아간다.

## 라운드 2 검사 (부모가 수행)

- view가 쓰는 중계: 호스트는 각 사이드카 메시지를 표면에 처음 보낸 창에 `sidecar-message` 이벤트 `{sidecar, surface, body}`로 전달한다(`docs/spec/sidecars.md:46`). 중계는 표면 키이므로, 표면이 없는 플러그인 호스트는 오늘 사이드카 이벤트로 가는 경로가 없다. D9.2는 따라서 기존 경로가 아니라 필요한 스펙 변경이다.
- `main`의 `docs/spec/plugin-host.md`(Declaration부터 State까지 절)는 사이드카 채널을 정의하지 않는다. `git show feat/plugin-host-F212.9:docs/spec/plugin-host.md`에는 `sidecar` 문구가 없다.

(라운드 2 감사자 답변: 대기 중.)

## 다른 곳에 기록할 것

이 검토는 아래를 바꾸지 않는다. 각 항목은 소유 저장소나 브랜치에 기록된다.

- core main(F218-2.4-1의 후속): `scripts/check-host-contract.mjs`, `scripts/test/check-host-contract.test.mjs`, `docs/spec/host-contract.md`(+ko)의 D8.1~D8.5. F218-2.4-1 변경 뒤의 새 변경으로 한다.
- core main(F212.8 후속 ID): `docs/spec/declared-ui.md`(+ko)와 어휘 표의 D9.1a~D9.1g 및 D9.3. 테스트는 `packages/workbench`에 둔다.
- core main(F212.9 후속): `docs/spec/plugin-host.md`(+ko)의 D9.2 표면 없는 사이드카 중계와 두 호스트의 사례.
- `AGENTS.md:32-33`과 `AGENTS.ko.md:32-33`(R2.3), `docs/spec/plugins.md`(R2.1, R2.2), `scripts/test/workspace-registry.test.mjs`(R2.4): core main.
- `../core-host-routes-F229/docs/plans/plugin-host-routes.md:55`에 이름만 있는 F230 백로그 항목은 `feat/host-routes-F229`에 커밋되지 않았다. 그 소유자가 브랜치에 기록하거나 참조를 버린다. D9.1a가 가로 tree 규칙을 정한다.
- `plugins/files` 저장소: D9.4 스키마와 D9.7 테스트, core F212.9-4-1 뒤의 항목 F212.10-files.
- `plugins/shell` 저장소: `plugin.json`의 `shell.history` 설명(D9.9), 체크리스트 P10을 D9.8과 D9.10으로 닫는다.

## 하위 항목

결정이 닫힐 때 `docs/features.md`(+ko)의 F212 아래에 등록한다.
