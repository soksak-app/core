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

상태: 라운드 4에서 닫힘. 라운드 4 감사자 두 명 모두 반론이 없었다. 필요한 변경은 `docs/features.md`의 하위 항목 F238-d-1부터 F238-d-4까지다.

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

상태: 라운드 4에서 닫힘. 라운드 4 감사자 두 명 모두 D8에 반론이 없었다. 부모는 D8.2부터 D8.5까지를 코드에서 확인했다(아래). 필요한 변경은 `docs/features.md`의 하위 항목 F238-d-5부터 F238-d-8까지다.

라운드 4 기록의 D8.2~D8.5 부모 확인:

- D8.1 가림: `groupResults`(`check-host-contract.mjs:91-100`)는 실행과 이름으로만 묶고, `statusOf`(`:103-114`)는 `host.runs`의 모든 일치를 취한다. `host.runs`에는 wailsv3의 sok 실행이 든다(`GO_RUNS`, `:173-179`). 확인됨: 호스트의 통과가 sok 선언을 덮는다.
- D8.2: `packages/host/tauriv2`(테스트 601개)와 `packages/sok/tauriv2`(테스트 139개)의 `#[test]` 잎 이름을 훑어 두 크레이트 모두 중복 잎이 없었다. 새 규칙은 현재 트리를 깨지 않는다. `discoverRust`가 실행 파일마다 목록을 내므로(`test-discovery.mjs:79-84`) 합산 검사가 모든 타겟을 덮는다.
- D8.3: `parseDeclarations`는 모든 `#[` 줄에서 반환한다(`check-host-contract.mjs:78`). 그래서 선언 위나 선언과 `fn` 사이의 `#[should_panic]`과 `#[ignore]`는 조용히 통과한다. Rust 선언 752개를 훑어 허용 집합 밖의 속성이 없었다. `endpoint_test.rs:176-178`과 `sok_test.rs:333-334`의 `cfg(feature)`와 `cfg(not(feature))` 줄이 Green 사례다.
- D8.4: `docs/spec/host-contract.md:22`은 `packages/host/...` 경로만 나열하므로 sok 경로가 빠져 있다고 한 말이 맞다.
- D8.5: `scripts/test/check-host-contract.test.mjs`는 있으나 소유자 규칙, 잎 규칙, 속성 규칙의 사례가 없다. 사례는 새 작업이다.

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

상태: 확정되지 않았다. 아래 배치는 라운드 9의 제안이다. 소유자가 D9.F의 세 전제를 정해야 확정된다. 라운드 9 반론에 답하고 본문을 고쳤다. 구현 발견은 하위 항목 F238-d-9~F238-d-24(`docs/features.md`)다.

결정(배치만):

- D9.A files 사이드바: 카드 view가 없다. files 섹션은 선언형 UI이며 왼쪽 또는 오른쪽 사이드바에 세로로 놓인다(방향은 사이드바 면을 따른다, `docs/spec/plugins.md:97`). 원천은 files 플러그인 호스트다. 호스트가 원천인 이유는 `docs/spec/plugin-processes.md:26`이다. view가 없는 동안 값을 보여야 하는 섹션은 그 플러그인의 호스트가 필요하다. 사이드카는 현재 명세에서 원천이 아니다. status는 page가 `page.exposure.register`로 등록하며(`docs/spec/declared-ui.md:145`), 사이드카에는 page가 없다. 이 배제는 현재 명세의 규칙이며 개정으로 바뀔 수 있다. 사이드카의 사실이 아니다.
  - `docs/spec/plugin-host.md:5`와 `plugin-processes.md:28`의 호스트 생성 검사(view도 사이드카도 가질 수 없는 DOM 없는 로직)는 로직으로는 충족되지 않는다. 목록, git 상태, 선택은 사이드카에 둘 수 있고 호스트는 아무 로직도 갖지 않는다. 그래서 호스트는 `:26`에 따라서만 생성되며, 이를 위해 `:5`와 `:28`의 소유자 면제가 필요하다(D9.F.1). 면제를 거부하면 대안은 D9.A′이며, 이것은 D9.A의 변형이 아니라 다른 배치다.
  - 사이드카는 호스트에 보낼 수 없다. `docs/spec/plugin-host.md:59`가 "no sidecar send"를 금한다(D9.F.2, F238-d-23).
  - 북마크는 프로젝트 데이터에 있다(`docs/spec/plugins.md:126`). 호스트가 프로젝트 데이터에 닿으려면 `plugin-host.md:59`의 개정이 필요하다(D9.F.2). 상태 모듈은 선언형 status를 제공하지 못한다(`declared-ui.md:145`).
  - 펼친 상태는 워크벤치에 남는다(`declared-ui.md:3-11`). 사이드카는 목록, git 상태, 플러그인 자신의 값을 준다.
  - 조건(F238-d-24): files 섹션 view(`ui/sections/tree.js`, `bookmarks.js`)에 이름 바꾸기, 끌어 놓기, 포인터 컨텍스트 메뉴, 텍스트 입력이 없어야 한다. 있으면 카드 표면이 필요하다(`plugin-processes.md:25`).
  - `plugins/files/ui/state.js`(`./events.js`만 가져옴)는 사이드카로 옮긴다. F229의 결정(F238-d-20)은 호스트 표현에만 해당한다.
- D9.A′ 대안, 다른 배치: files 목록, 북마크, 선택을 files 카드 view로 옮긴다. 이 view는 자기 탭, 수명, unload를 가진다. 사이드바에는 그 카드를 여는 선언형 open 항목만 남는다(`docs/spec/plugin-processes.md:26`: view가 필요한 섹션은 카드 표면이 된다. 카드 표면 규칙은 `docs/spec/declared-ui.md:161`이다. `:9`는 view가 별도 web view라는 것만 말한다). open 항목의 status 원천은 `declared-ui.md:145`가 카드 사이드바에 대해 말하는 대로 정한다. 첫 원천은 files 탭의 view이며, 그 탭이 활성이 아니면 섹션이 비워진다. D9.D가 shell에 기록한 비움과 같은 기준으로 두 대안을 비교한다. 대가: files의 새 카드 view와 탭 수명, files 탭의 unload, 사이드바의 선언형 open 항목. D9.A의 사이드바 섹션과 D9.E의 세로 방향은 files 목록에 더 이상 적용되지 않는다.
- D9.B shell 카드: view로 남는다. 세 섹션(`shell.history`, `shell.cwd`, `shell.jobs`)은 플러그인이 선언한 섹션이며, Settings 배정(`docs/spec/example-model.md:20`) 또는 집합이 명시되지 않을 때 `data.sidebars`가 파생하는 플러그인 기본(`:24`)으로 카드 왼쪽 사이드바에 놓인다. shell의 선언된 기본 집합은 매니페스트에 있으며, 이 worktree에는 없고 shell 저장소에서 확인한다(F238-d-21). 원천은 그 카드에서 shell 탭의 view다(`declared-ui.md:145`, 첫 원천). 기본 배치에서는 shell 플러그인 호스트가 없다.
- D9.C 실행 중인 작업: `context.tab.keep("busy", on)`(`plugins/shell/ui/shell.js:56-60`)은 실행 중에 탭을 적재 상태로 둔다(`docs/spec/plugins.md:203`). 이는 보호이지 원천이 아니다. 카드의 활성 탭이 shell 탭이 아니면 `declared-ui.md:145`가 활성 탭의 view에서 섹션을 가져오므로, 활성이 아닌 shell 탭의 실행 중 작업은 보이지 않는다.
- D9.D 기본 경로의 비용, 전부 적는다: 카드의 활성 탭이 더 이상 shell 탭이 아니거나 카드가 닫히면 섹션은 비워진다(`declared-ui.md:145`, `:149-150`). 플러그인 기본 경로에서는 집합이 활성 탭을 따르므로(`example-model.md:24`), 카드를 다른 플러그인의 탭으로 바꾸면 섹션이 사라진다. Settings에서 명시 배정하면 집합은 탭 변경 뒤에도 남지만(`example-model.md:22`), 활성 탭이 shell 탭이 아니면 원천이 비므로 그때도 비어 있다. 두 경로 모두 비활성 탭의 실행 중 작업을 비운다(D9.C). unload는 `history`, `jobs`, cwd의 view 상태를 지운다(`shell.js:56`). 다만 실행이 있으면 탭은 적재 상태를 유지한다(D9.C). cwd는 다음 적재 때 탭 상태에서 복원된다(`shell.js:119`, `:146-154`).
  - 창 사이드바 배정: `docs/spec/example-model.md:20`은 Settings가 섹션 집합을 창의 왼쪽 또는 오른쪽 사이드바에 배정하게 한다. 고정 창 사이드바는 플러그인 override가 적용될 때만 포커스된 카드의 활성 탭을 첫 원천으로 쓰고, 적용되지 않으면 그 단계를 건너뛴다(`declared-ui.md:145`). 그래서 override 없이 창 사이드바에 배정된 shell 집합은 원천이 없고 항상 비워진다. 이 배정은 허용된다(`example-model.md:20`). 창 사이드바는 고정 열을 빈 내용으로 유지하므로(`external-sidebars.md:9`), `declared-ui.md:145`에 따라 집합은 항상 비어 있다. override와 shell 호스트가 없기 때문이다. shell 기본은 카드 왼쪽뿐이다.
  - 대안(소유자 결정): shell 탭이 활성이 아닐 때도 history와 cwd가 보여야 한다면, `plugin-processes.md:26`에 따라 shell에 플러그인 호스트가 필요하고 D9.B는 대체된다. 명세의 어떤 요구도 그렇게 하지 않는다. 기본값을 기록하며, shell 소유자가 확인하기 전까지 확정으로 보지 않는다(F238-d-21).
- D9.E 방향: files 섹션은 왼쪽 또는 오른쪽 사이드바에 있으므로 세로 module과 세로 선언형 tree가 적용된다. 지금의 가로 `files.tree` module(`plugins/files/plugin.json:10`)은 다른 module 형식과 함께 F212.11이 지운다. 소유자가 files를 위나 아래 사이드바에 요구하면 가로 tree 규칙(F238-d-9)이 필요하며, 그 요구가 이유다.
- D9.F 확정 전에 소유자가 정할 전제:
  1. 면제: files 호스트에 대해 `docs/spec/plugin-host.md:5`와 `docs/spec/plugin-processes.md:28`을 면제하고, 호스트를 `:26`에 따라 만든다. 또는 대안: files 카드 표면(새 작업).
  2. 개정: `docs/spec/plugin-host.md:59`가 호스트의 사이드카 중계와 북마크용 프로젝트 데이터 호출을 허용한다(F238-d-23).
  3. 뷰 검사: F238-d-24가 files 섹션 view에서 view 수준의 상호작용을 찾지 못한다.
  1의 소유자 결정이 필요하며, 이 기록은 그것을 정하지 않는다.

배치의 근거:

- `plugins/files/plugin.json`: `files.tree`와 `files.bookmarks`는 module 형식이고, `files.tree`에는 가로 module이 있다(`:10`). 카드 표면이 없고(`:4`), `@soksak/sidecar-files` 의존이 있다(`:27-28`).
- files UI 상호작용: tree(펼치기, 선택, 열기)와 list(북마크 추가와 제거). `ui/sections/tree.js`, `tree-horizontal.js`, `bookmarks.js`. 1라운드의 검색은 `ui/sections/*.js`와 `ui/state.js`에서 `contextmenu`, `rename`, `drag`를 찾지 못했다. F238-d-24가 저장소에서 다시 확인한다.
- `plugins/shell/plugin.json`은 카드 view `ui/index.html`과 `status` 형식의 세 섹션을 선언한다. 텍스트 입력은 view가 필요한 이유다(`plugin-processes.md:24-25`).
- `shell.js:56-60`은 실행이 있는 동안 탭을 적재 상태로 둔다. `shell.js:119`, `:146-154`는 cwd를 복원한다.
- 한계: `plugins/`는 이 worktree에도 나열된 브랜치에도 없다(`git ls-tree`가 항목을 내지 않았다). `plugin.json`과 `shell.js` 줄은 메인 체크아웃에서만 읽었고 여기서 검증하지 않았다.

라운드 9 답변(감사자 A와 B, claude-haiku-5-5, 읽기 전용):

- A1과 B1(`:5`/`:28`으로는 호스트가 정당화되지 않고 호스트는 로직이 없다): 수락. 호스트는 `:26`으로만 정당화되며, 면제는 소유자 전제다(D9.F.1). 대안은 카드 표면이다.
- B2와 A2(`:59`가 사이드카에서 호스트로의 경로와 북마크 호출을 막는다): 수락. 개정 F238-d-23은 전제다(D9.F.2). 상태 모듈은 status를 제공하지 못하고(`declared-ui.md:145`), `plugins.md:126`은 북마크를 말하지 않으므로 호스트의 접근 근거로 더 인용하지 않는다.
- B3(사이드카 배제는 현재 명세의 규칙이지 사실이 아니다): 수락. 본문에 그렇게 적었다.
- B4와 A3(인용): 수락. `example-model.md:22`가 명시 배정의 생존 규칙이고, `:24`는 플러그인 기본이다. shell의 기본 집합은 이 worktree에 없는 `plugins/shell/plugin.json`에서 확인한다.
- A4(`state.js` 배치): 일부 수락. `state.js`는 사이드카로 옮기며, F229는 호스트 표현만 정한다.
- D9.B부터 D9.E까지의 일관성 검사: 두 감사자 모두 반론이 없었다.

라운드 10 답변(감사자 A와 B, claude-haiku-5-5, 읽기 전용):

- A: 배치 반론 없음. 층 규칙, 원천 순서, 호스트 규칙, Settings 규칙의 인용이 파일과 맞다.
- B1(대안이 `:7`로 인용되고 비용이 없음): 수락. 대안은 D9.A′, 다른 배치이며 `:26`과 `:9`를 인용하고 비용을 적는다.
- B2(D9.D에 창 사이드바 배정이 없음): 수락. D9.D가 그 경로가 항상 빈 집합이 된다는 점을 적는다.
- B 참고(사이드카 배제는 현재 명세의 규칙이며 사이드카 등록 경로가 명세에 없다): D9.A와 일관된다.

라운드 11 질문: 전제 D9.F와 대안 D9.A′가 붙은 고친 배치가 틀렸는가? 구현 발견은 질문에 들어가지 않는다.

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

## 라운드 2 답변과 수정된 본문

라운드 2 감사자(새 하위 에이전트 두 명, 읽기 전용): 감사자 C는 일곱 개(D2: 1, D8: 2, D9: 4), 감사자 D는 아홉 개(D9)의 반론을 냈다. 각 반론은 파일에서 확인했다. 이 절과 앞의 본문이 다르면 이 절이 우선한다.

### 답변

- C-D2-1, `environment.json`의 settings: 수락. 확인: `apps/wailsv3/environment.json`에 플러그인 `terminal`을 이름으로 가리키는 `settings` 키가 있다. R2.3 문장은 이제 "`environment.json` names plugins as tab references (`workspace`), sidebar link references (`sidebars`) and per-plugin settings keys (`settings`); it does not install them."이다.
- C-D8-2, `#[cfg(not(feature))]`: 수락. 확인: `packages/sok/tauriv2/tests/sok_test.rs:333-334`에 선언과 `#[test]` 사이 `#[cfg(not(feature = "diagnostics"))]`가 있다. D8.3 참고.
- C-D8-3, 선언 위의 속성: 수락. 확인: `scripts/check-host-contract.mjs:78`은 모든 `#[` 줄에서 반환하고, 선언은 나중에 보일 때만 붙으므로 선언 위의 `#[should_panic]`이 조용히 통과한다. D8.3 참고.
- D-D9-1과 C-D9-5, 호스트의 사이드카 경로: 수락. 확인: `sidecars.md:41`은 각 요청에 `{surface, root}`를 요구하고, `:46`은 표면에 처음 보낸 창에만 메시지를 전달하며, `:65`는 `sidecar-failure`를 소유 창에 보낸다. 표면이 없는 호스트에는 경로가 없으므로 스펙에 경로를 추가해야 한다. D9.2 참고.
- D-D9-2와 C-D9-4, 항목별 검토: 수락. 각 항목을 아래 본문에서 검토했고, 사이드카 대안에는 그 결과로 답했다.
- D-D9-3, Enter와 두 번 누르기: 수락. 확인: `declared-ui.md:130`은 선언형 요소에 키 처리가 없다고 하므로 Enter는 네이티브 `click`으로 전달된다. D9.1b 참고.
- D-D9-4, 폴더 롤업: 수락. 사이드카가 각 디렉터리의 `detail`을 자손 상태에서 계산한다. D9.1d 참고.
- D-D9-5와 C-D9-7, 목록 오류와 열기 실패: 수락. `AGENTS.md:44`는 사용자에게 보이는 오류를 로그를 쓰는 한 표시 경로로 보내야 한다고 하고, `declared-ui.md:70`은 상태 줄이 오류를 그릴 수 없다고 한다. 따라서 열기 실패와 목록 오류는 선언형 tree를 떠나 그 표시 경로로 간다. D9.1f 참고.
- D-D9-6, 화살표 키 탐색: 기록된 비용으로 수락. 어휘에 키 처리가 없으므로(`declared-ui.md:130`) 행 사이 화살표 탐색은 사라진다. D9.9 참고.
- D-D9-7, 잘라내기 규칙: 수락. tree는 선언된 한도로 자른다. D9.1h 참고.
- D-D9-8, 채널 문장: 수락. `plugin-host.md`(Channel)와 view 채널 문장을 바꿔야 한다. D9.3 참고.
- D-D9-9, 헤더 별의 `params`: 수락. 선언된 값은 플러그인이 작성한다(`declared-ui.md:5`, `:27`). 플러그인이 자기 선택으로 `params`를 쓰며 호스트는 설정하지 않는다. D9.1g 참고.
- C-D9-6, shell 배치: 수락. 배치를 아래에 명시한다.

### 수정된 본문

- D8.3(속성 규칙 대체): 허용되는 속성 줄은 `#[test]`, `#[tokio::test]`, `#[cfg(feature = "...")]`, `#[cfg(not(feature = "..."))]`이다. 각 `cfg`는 테스트가 컴파일되는 구성을 고른다. 검사는 `fn` 바로 위의, 선언의 위든 아래든 연속된 속성·주석 줄 블록 전체를 본다. 그 블록의 다른 속성은 오류다. 변경 전 코드에서 선언 위의 `#[should_panic]`은 통과하므로 Red이고, 변경 후 Green이다. `sok_test.rs:333-334`의 `cfg(not(feature))` 줄은 Green 사례다.
- D9.1b(Enter와 두 번 누르기 대체): `declared-ui.md:130`에 키보드 규칙을 더한다. 초점이 있는 tree 노드의 Enter keydown은 `open`을 실행하고 네이티브 `click`을 막는다. 두 번 누르기는 `event.detail === 2`인 `click`이며, 그 두 번째 click은 `command` 대신 `open`을 실행한다. 첫 click은 `command`를 실행한다. Red와 Green 사례: 두 번 누르기는 `files.select` 한 번과 `open` 한 번, Enter는 `open`만 실행한다.
- D9.1d(git 표시 대체): tree 노드는 500 코드 포인트 이하의 평문 `detail`을 선언할 수 있다. files 사이드카가 계산한다. 파일의 detail은 그 git 상태이고, 디렉터리의 detail은 자손 중 가장 중요한 상태다(`ui/vendor/trees.js`가 바뀐 자식을 `data-item-contains-git-change`로 표시하는 것과 같다). 테스트: 수정된 자손이 하나인 디렉터리는 `detail`을 가진다.
- D9.1f(알림 대체): 열기 실패와 목록 오류는 선언된 status가 아니다. 핵심 오류 표시 경로로 가며, 그 경로는 표시 순간 `error: <where>: <text>`를 로그에 쓴다. 선언형 tree는 오류를 그리지 않는다(`declared-ui.md:70`). files tree에 남는 것은 프로젝트 없음 문구뿐이다. 이는 오류가 아니다. `root`가 null이면 값은 "프로젝트 없음" `status-line` 하나를 가진다. 행이 없는 목록은 tree의 `empty` 문구를 보인다.
- D9.1g(헤더 대체): `files.tree` 값은 `tree` 앞에 `button` 루트 요소를 둘 수 있다. 새로고침은 한 버튼이다. 헤더 별의 `params`는 플러그인이 자기 선택으로 만든 `{path}`이며, 선택이 바뀌면 플러그인이 새 값을 보낸다.
- D9.1h(잘라내기 규칙, 새로): files tree는 보이는 행 최대 5000개, 최대 16 단계를 보인다(`declared-ui.md:56`, `:84`). 한도를 넘는 행은 잘리며, tree 뒤에 빠진 행 수를 적은 `status-line`이 온다. 큰 프로젝트의 다시 그리기 시간은 하위 항목으로 측정한다. F212.8-7이 tree를 측정한 것과 같다(`plugin-processes-handoff.md:143`).
- D9.2(사이드카와 호스트 문장 대체): 호스트 경로. `docs/spec/plugin-host.md:59`는 호스트의 사이드카 전송을 허용하도록 바뀐다. 호스트는 경로 키 `plugin-host:<plugin id>`를 `{surface, root}`의 `surface`로 쓴다(`sidecars.md:41`). 플러그인 호스트 web view를 가진 창이 그 `sidecar-message`와 `sidecar-failure`를 받으며(`sidecars.md:46`, `:65`), 호스트 재시작 뒤에도 소유를 유지한다(`sidecars.md:67`). 사례 `plugin-host.sidecar.send`와 `plugin-host.sidecar.failure`를 두 호스트에서 실행한다. 항목별 검토:
  - 목록, git 상태와 롤업 `detail`: files 사이드카가 이미 만든다(`files.tree` 설명). 사이드카에 남는다.
  - 펼친 집합과 선택: 프로젝트 루트별. 사이드카로 옮기고, 사이드카는 루트 키로 보관하며 호스트는 중계한다. 사이드카가 가질 수 있으므로 호스트 로직이 아니다.
  - 북마크: 플러그인 데이터 저장소(`plugins/files/plugin.json`의 `data.bookmarks`). core가 저장하며, 호스트는 데이터 호출로 읽고 쓴다. 호스트는 북마크 로직을 갖지 않는다.
  - 결과: 호스트는 DOM 없는 로직을 갖지 않는다. 역할은 선언된 status를 제공하는 것이며, 사이드카는 그것을 할 수 없다(`declared-ui.md:145`). 이는 플러그인 호스트의 목적(`plugin-host.md:5`)과 층 규칙(`plugin-processes.md:26-28`)을 바꾼다. 호스트는 view 없이 프로세스가 필요한 status를 제공하려고 만들어지며 중계만 가진다. 층 규칙의 이 변경도 결정이므로 이 라운드에서 적대적 검토로 보낸다.
- D9.3(채널 문장, 새로): `plugin-host.md`(Channel)에 D9.2의 사이드카 경로를 더한다. 호스트는 호스트 source에 `declared-ui.expanded` 메시지(D9.3 펼침 규칙)를 보내고, `native-surfaces.md`는 view source에 같은 메시지를 더한다. 사례 `declared-ui.expanded`를 두 호스트와 `packages/workbench`에서 실행한다.
- D9.8(shell 배치, 명시): shell 섹션은 shell 카드의 사이드바에 있다. 원천은 카드의 활성 탭 view다(`declared-ui.md:145`, 첫 원천). 이 결정은 플러그인 override를 정하지 않는다. override 없는 고정 창 사이드바는 그 섹션의 원천이 없으므로 지워진다(`declared-ui.md:145`). 받아들이는 비용이며 D9.9에 적었다.
- D9.9(받아들이는 비용, 확장): 위의 비용(unload 시 history와 jobs 삭제, 탭 상태로 cwd 복원, 카드가 닫히거나 비활성인 동안 섹션 삭제)에 더해 tree 행 사이 화살표 키 탐색의 손실(D9.1과 `declared-ui.md:130`)이다. 화살표 탐색은 F212.8 아래 후속 항목으로 기록해 선언형 동작이 될지 정한다. 그 결정은 적대적 검토로 보낸다. 현재 어휘에 키 처리가 없고 이 변경은 이동의 비용으로 기록하므로 낮춘 기준이 아니다.

## 라운드 3 답변과 수정된 본문

라운드 3 감사자(새 하위 에이전트 두 명, 읽기 전용): 감사자 E는 여섯 개(D9.2와 D9.3), 감사자 F는 아홉 개(D8: 2, D9: 7 에 나눈 항목)를 냈다. 각 항목은 파일에서 확인했다. 이 절과 앞의 본문이 다르면 이 절이 우선한다. 라운드 3에서 D2는 감사자가 다시 검토하지 않았으므로 이 라운드로 D2는 닫히지 않는다.

### 답변

- F-D8.1, 선언 측 소유자: 수락. `parseDeclarations`는 파일만 받고(`check-host-contract.mjs:50`) 소유자를 저장하지 않는다(`:73`). D8.1 참고.
- F-D8.2, 실행 파일 간 잠 이름 중복: 수락. `discoverRust`는 실행 파일마다 `--list`를 돌리고(`test-discovery.mjs:79-84`), 크레이트에는 여러 실행 파일이 있다. D8.2 참고.
- F-D9.1e와 E-D9.2(라우트 키): 수락. 창마다 하나의 키 `plugin-host:<plugin id>:<window id>`가 필요하다. `plugin-host.md:31`이 창마다 플러그인 호스트 web view를 만들고, `sidecars.md:46`이 같은 표면에 두 번째 창을 거부하기 때문이다. D9.2 참고.
- F-D9.2 root와 E-D9.2 root: 수락. `sidecars.md:41`이 프로젝트 변경 후에도 첫 root를 유지한다. D9.2 참고.
- E-D9.2 호스트 페이지로의 전달 경로: 수락. `sidecars.md:46`과 `:65`는 메인 페이지로만 전달하고, `plugin-processes.md` 규칙 1은 플러그인 코드를 그 페이지에 두지 않는다. D9.3 참고.
- E-D9.4와 F-D9.4(호스트 로직): 수락. 선택지 하나: 사이드카가 완전한 선언값을 만들고, 호스트 페이지는 그것을 바꾸지 않고 중계한다. D9.2 참고.
- E-D9.5와 F-D9.6(층 규칙 문장): 수락. 대체 문장은 D9.2에 있다.
- F-D9.7와 E-D9.6(사이드카 정지, 작업, 재시작): 수락. D9.2와 D9.9 참고.
- F-D9.8(동작 주소): 수락. `declared-ui.md:126`과 `:128`은 역할로 `label`과 `expand`만 허용한다. D9.1e 참고.
- F-D9.9(다른 자식이 있는 가지): 수락. D9.1h 참고.
- F-D9.10(오류 호출): 수락. tree에는 플러그인 오류를 보이는 호출이 없으므로 오류는 메인 페이지의 표시 경로를 통한다. D9.1f 참고.
- F-D9.11(키 규칙): 수락. `declared-ui.md:130`은 아직 선언형 요소에 키 처리가 없다고 한다. D9.1b 참고.
- F-D9.12(펼침 권한): 수락. 두 저장소가 한 상태를 결정할 수 없다. D9.3 참고.

### 수정된 본문

- D8.1(소유자 대응, 수정): 선언의 소유자는 파일에서 계산하고 `parseDeclarations`가 반환한다. Go는 파일의 디렉터리(절대 패키지 디렉터리로 정규화), Rust는 파일에서 가장 가까운 `Cargo.toml`을 포함하는 조상 디렉터리. `statusOf`는 정규화된 소유자를 비교한다.
- D8.2(잠 이름 중복, 수정): 검사는 크레이트의 모든 실행 파일의 `--list` 출력을 각 구성 실행마다 합친다(`tauriv2-tests`, `tauriv2-diagnostics-tests`, sok 실행). 잠 이름이 그 합에서 두 번 나오면 둘이 어느 실행 파일에 있든 실패한다. D8.5 3번 사례는 같은 크레이트의 다른 타겟에 두 잠을 둔다.
- D9.1b(키, 수정): `declared-ui.md:130`은 "A tree node with `open` has a key handler: Enter keydown on the focused node runs `open` and prevents the native `click`; no other element has a key handler."로 바꾼다. `open`을 가진 트리 노드는 `command`도 가져야 하며, 그래야 네이티브 버튼이 있고 Enter가 누를 수 있는 노드에 닿는다. 두 번 누르기는 `event.detail === 2`인 `click`이며, 그 click은 `command` 대신 `open`을 실행한다.
- D9.1e(동작, 수정): 동작은 역할 `action`과 그 노드의 동작 사이에서 유일한 `key`로 주소를 갖는다. `declared-ui.md:126`과 `:128`에 `action` 역할과 `key` 필드를 더한다. `open` 컨트롤은 노드의 `label` 주소를 공유한다(노드에 누르는 컨트롤이 하나를 넘지 않음).
- D9.1f(오류, 수정): 열기 실패는 사용자가 보는 오류다. 코어 `core.file.open` 명령이 자체 실패를 코어 표시 경로로 이미 보여준다. 목록 오류는 호스트 채널을 통해 `pluginHostEvent {kind: "error", text}`로 메인 페이지에 가고, 메인 페이지는 `error: plugin <id>: <text>`를 한 표시 경로로 쓴다. `plugin-host.md` Channel에 `kind: "error"` 이벤트를 더한다. 프로젝트 없음 문구는 값 안의 `status-line`이다.
- D9.1h(잘라내기와 분기, 수정): 트리 노드는 값에 보내지 않은 하위 노드가 있을 때 `branch: true`를 선언할 수 있다. `declared-ui.md:62`는 바뀌어, `branch: true` 노드는 `children`이 없더라도 분기이며 펼침 컨트롤을 그린다. 사이드카는 펼친 분기의 자식만 보낸다. 값은 최대 5000 노드(`declared-ui.md:91`)이고, 한도를 넘는 값은 거부되므로 사이드카가 보내기 전에 행을 자르고 잘린 행 수를 밝히는 `status-line`을 다는다.
- D9.2(호스트 라우트와 호스트 역할, 수정):
  - 라우트: 호스트 라우트 키는 `plugin-host:<plugin id>:<window id>`이며 `{surface, root}`의 `surface`로 쓴다(`sidecars.md:41`). 창마다 라우트가 하나라 두 창이 충돌하지 않는다.
  - root: 창의 프로젝트가 바뀌면 호스트는 라우트에 `closed`를 보내고 새 root로 새 라우트를 연다. `plugin-host.md`에 그 규칙과 사례 `plugin-host.sidecar.project-switch`를 둔다. 호스트의 폐기도 `closed`를 보낸다(`plugin-host.md:46`).
  - 로직: 사이드카가 완전한 선언값(행, 평탄화, 한도 처리, `detail`, `actions`, 헤더 버튼, 프로젝트 없음 status, 북마크 목록)를 만든다. 호스트 페이지는 그 값을 수정 없이 메인 페이지에 전달한다. 호스트는 각 status의 마지막 값만 유지한다(`status.get` 응답, `plugin-host.md:68`). 마지막 값 캐시는 로직이 아니다.
  - 북마크: 북마크 목록은 files 사이드카가 프로젝트 루트별 상태로 보관한다. 기존 `data.bookmarks` 값은 저장형식 규칙에 따라 마이그레이션 정의와 함께 files 저장소로 옵니다.
  - 명령: 호스트 페이지는 플러그인의 선언된 명령(`files.bookmarks.add`, `files.bookmarks.remove`, `files.tree.toggle`, `files.select`, `files.refresh`)을 사이드카에 요청으로 전달한다. 사이드카가 로직을 수행하고 새 값으로 답한다.
  - 정지: 사용자가 `files.refresh`를 누르면 플러그인 `dependencies`에 있는 사이드카의 정지를 해제한다. files 플러그인에는 열 표면이 없기 때문이다(`plugin-host.md:80`). 정지의 결과는 섹션 비움과 로그 한 줄이며, `plugin-host.sidecar.failure`가 이를 시험한다.
  - 층 규칙 문장, `plugin-processes.md:28`(규칙을 대체): "**Plugin host:** created only when a declared sidebar status that must show values while no view of the plugin is open cannot be served by a view. A host relays the messages of its plugin's sidecars and the commands of its declared statuses, serves its declared statuses, and keeps the last value of each; it holds no logic that a view or a sidecar can hold."
  - 층 규칙 문장, `plugin-host.md:5`(문장을 대체): "A plugin host is a process of a plugin, with a platform web view attached to the window, that relays its plugin's sidecar messages and command requests and serves its declared statuses; it exists only when the contract requires it."
  - Channel, `plugin-host.md`에 추가: 호스트는 각 사이드카 메시지를 `{sok: 1, sidecar, body}`로, 각 사이드카 실패를 `{sok: 1, sidecar, failure}`로 메인 페이지에 보내고, 명령 요청은 사이드카에 보낸다. 두 호스트에 사례를 둔다.
- D9.3(펼침, 수정): 플러그인 값이 원천인 tree에서는 플러그인의 `expanded` 값이 권한을 가진다. `declared-ui.md:137-144`에 그 경우를 더한다. 펼침 명령은 `declared-ui.expanded`를 원천에 보내고, 사이드카는 펼친 집합을 갱신하고 새 값을 보낸다. tree는 그 왕복 후에 새 상태를 보인다. 유지된 상태는 플러그인 값이 아닌 tree에만 쓴다. 사례 `declared-ui.expanded`는 두 호스트에서 실행한다.
- D9.9(비용, 수정): files 사이드카를 재시작하면 펼친 집합과 선택이 초기화된다(`sidecars.md:67`). 북마크는 사이드카 상태에 있어 잃지 않는다. 새 사이드카 작업 `expand`, `collapse`, `select`(답 포함)는 files 사이드카 프로토콜에 그 저장소에 추가한다. 화살표 키 탐색의 손실은 이전과 같다.

라운드 4 감사자는 이 본문, 새 층 규칙, 사이드카 프로토콜 변경을 검토한다.

## 라운드 4 답변과 수정된 본문

라운드 4 감사자(새 하위 에이전트 두 명, 읽기 전용): 감사자 G는 열두 개(D9만, D2와 D8은 읽었으나 검토한 범위에서 반론 없음, D8.2~D8.5는 깊이 재확인하지 않음), 감사자 H는 일곱 개(D9.2와 D9.7)를 냈고 D2와 D8에는 반론이 없었다. 각 항목은 파일에서 확인했다. 이 절과 앞의 본문이 다르면 이 절이 우선한다.

### 답변

- H-D9.2-1과 H-D9.2-2, 북마크와 마이그레이션: 수락. `installation.md:120`은 플러그인이 값을 `projects.json`의 키로 저장한다고 하고, `plugins.md:126`은 프로젝트 데이터를 id로 준다. 목록을 사이드카로 옮기면 마이그레이션 정의 없이 files 경계를 넘는다. 북마크 목록은 프로젝트 데이터에 남고, 키가 바뀌지 않으므로 마이그레이션은 필요 없다.
- G-D9.2-6, 사이드카 영속성: 위 북마크 답변과 함께 수락. 표준 IO 사이드카에는 상태 디렉터리가 없으므로 가정하지 않는다.
- H-D9.2-3과 G-D9.2-3, 정지 해제: 수락. `sidecars.md:67`은 사람이 표면을 여는 것만 정지를 푼다고 말한다. 프로젝트 변경에 따른 라우트 생성은 사람의 열기가 아니므로 정지를 풀지 않는다. 새로 고침도 정지를 풀지 않는다. 정지된 사이드카는 앱을 재시작할 때까지 정지된 채 있다. 이는 D9.9에 적은 비용이다.
- H-D9.2-4, 사이드카가 만드는 표현: 수락. 표현(라벨, 프로젝트 없음 문구, 잘라내기, 동작 배치)은 플러그인 기능이다. AGENTS는 플러그인 기능을 core로 옮기지 않으며, 사이드카는 한 도메인의 네이티브 기능을 담는다. 사이드카는 데이터만 주고 호스트 페이지가 선언값을 만든다. 따라서 호스트는 표현 로직을 가진다. 이는 기준 변경이므로 D9.2에 이유와 함께 기록하고 이번 라운드에서 검토한다.
- H-D9.2-5와 G의 층 규칙 기준: 일부 수락. 원래 기준(뷰나 사이드카가 로직을 가질 수 없을 때만 호스트)을 기반으로 둔다. 호스트는 뷰가 열려 있지 않을 때도 제공되어야 하는 status를 위해 필요하다. 뷰는 그것을 제공할 수 없고, 사이드카는 status를 등록할 수 없다(`declared-ui.md:145`). 호스트는 그 status를 제공하는 DOM 없는 표현을 가진다. 새 문장이 두 사실을 모두 말한다.
- H-D9.2-6과 G-D9.2-9, 누락된 명세 문장: 수락. `plugins.md:58`, `:154`, `:259`, `:264`와 `installation.md:134`에 `surface`나 `state`를 적은 곳마다 `host`를 더한다. "no sidecar send" 문장은 본문에 있다. `plugin-host.md:59`는 "A plugin host has no `tab.state` call, no region operation, no sidecar send, and no clipboard or link call"이라고 적는다. D9.2가 호스트의 사이드카 전송을 허용하도록 그 절을 바꾼다(라운드 4 기록의 검증 참고).
- H-D9.7, DOM 테스트 대상: 수락. 대상은 D9.2가 이제 이름 붙인 호스트 페이지 표현 모듈이다.
- G-D9.1e, 동작 키 충돌: 수락. `declared-ui.md:128`은 주소를 다섯 필드로 고정하며 `key`는 루트 키다. 동작은 역할 `action`이 필요로 하는 `action` 필드로 주소를 갖는다.
- G-D9.1b, keydown 바인딩: 수락. 바인더는 `click`만 허용한다(`declared-ui.md:103`). `exposure.md`에 선언형 tree 노드의 keydown 이벤트를 더한다. 빨간 사례는 `open`이 없는 노드에서 Enter를 누르면 아무 일도 없어야 함이다.
- G-D9.1h, `branch` 용어: 수락. `declared-ui.md:62`와 `packages/plugin-api/terms.json:304`는 분기를 자식으로 정의한다. 용어를 둘로 나눈다. `branch`(자식이 있음)와 `unloaded branch`(새 용어, 사용 전에 `terms.json`에 추가). `branch` 필드 행을 표에 더하고, boolean이 아닌 `branch`는 거부한다.
- G-D9.1a, `:230`: 수락. `declared-ui.md:230`은 변경 목록에 있다.
- G-D9.2-5, 라우트 생성: 수락. 라우트 키는 `plugin-host:<plugin>:<window>:<n>`이며, `n`은 root 세대다. 각 root는 새 표면이다.
- G-D9.2-7, 정지: 위에서 답했다.
- G-D9.2-8, 재시작 뒤 스냅샷: 수락. 사이드카 요청 `snapshot`이 전체 데이터를 돌려주고, 호스트는 라우트가 열릴 때마다, 호스트 페이지가 시작할 때마다 이를 보낸다.
- G-D9.2-9, 채널: 수락. 네이티브 호스트는 `plugin-host:` 사이드카 메시지를 메인 페이지가 아니라 호스트 web view로 보낸다. 호스트 페이지는 `sidecar.send {sidecar, body, cids}`로 보낸다.
- G-D9.2-10, 실패 경고: 수락. `sidecars.md:85`는 핸들러가 없으면 앱 오류 경고를 보인다. 워크벤치는 `plugin-host:` 라우트용 핸들러를 등록해 `{sok: 1, sidecar, failure}`를 호스트 페이지로 전달하고, 이 경우 경고를 보이지 않는다.
- G-D9.2-11, 명령 응답: 수락. 명령 요청은 `cids`를 가진다. 사이드카는 이를 자신의 값에 되돌려 주고, 호스트는 일치하는 값에서 명령을 완료한다.
- G-D9.2-12, 상태 키: 수락. 펼친 집합과 선택은 라우트(창과 root 세대별)로 키를 둔다. 한 프로젝트의 두 창은 별도 상태를 가진다. 그 비용은 D9.9에 적고 시험한다.

### 수정된 본문

- D9.1e: 동작 주소는 `{sidebar, section, key, path?, role?, action?}`이다. `action`은 역할이 `action`일 때 필수이며, 노드의 동작들 사이에서 유일한 동작 키를 이름으로 준다. `declared-ui.md:126`과 `:128`에 `action` 필드를 더한다.
- D9.1b: 바인더는 선언형 tree 노드에 `keydown` 이벤트를 선언한다(`exposure.md`와 바인더, `declared-ui.md:103`). `open`이 있는 노드에서 Enter keydown은 `open`을 실행하고 네이티브 click을 막는다. `open`이 없는 노드에서 Enter는 아무 일도 하지 않는다. 빨간 사례와 초록 사례는 워크벤치 테스트에 둔다.
- D9.1h: `branch: true`는 tree 노드의 boolean 필드다. `declared-ui.md:59-62`에 행을 더한다. `:62`는 분기를 자식이 있는 노드, 또는 `branch: true`인 노드로 정의한다. `packages/plugin-api/terms.json`에 용어 `unloaded branch`(`branch: true`이고 자식이 없는 노드)를 더하고, `branch`는 자식이 있는 노드에 둔다.
- D9.1a: `declared-ui.md:56`, `:171`, `:230`을 모두 바꿔 가로 tree를 허용하므로, 표와 규칙이 맞는다.
- D9.2(라운드 4 문장, 우선함):
  - 라우트: `plugin-host:<plugin id>:<window id>:<n>`이며 `n`은 root 세대다. 프로젝트 변경은 라우트를 닫고 `n+1`을 연다. 각 root는 새 표면이며, `sidecars.md:41`이 표면별로 적용된다.
  - 정지: 라우트 생성과 새로 고침은 사이드카 정지를 풀지 않는다(`sidecars.md:67`, `plugin-host.md:80`). 정지된 사이드카는 앱을 재시작할 때까지 정지된 채다. 사례 `plugin-host.sidecar.project-switch-after-stop`는 네 번째 실패 뒤 프로젝트 전환이 사이드카를 다시 시작하지 않음을 보인다.
  - 데이터: files 사이드카는 데이터만 준다. 목록, 경로별 git 상태, 펼친 집합, 선택, 디렉터리 `detail` 값이다. `snapshot` 요청에 전체 데이터로 답하며, 각 라우트 열기와 호스트 페이지 시작 때 요청된다. 각 명령 요청에 새 데이터로 답하고 `cids`를 되돌린다.
  - 표현: 호스트 페이지가 데이터로 선언값을 만든다. 행, 평탄화, 잘라내기, `detail`, `actions`, 헤더 버튼, 프로젝트 없음 status, 북마크 목록이다. 호스트 페이지는 그 값을 declared snapshot으로 메인 페이지에 수정 없이 보낸다. 이는 표현을 플러그인 코드(플러그인 자신의 페이지)로 옮기는 것이며 core가 아니다. 기준은 위 답변에서 말한 것이고, 이는 이번 라운드에서 검토할 기준 변경이다.
  - 북마크: 목록은 프로젝트 id별 프로젝트 데이터에 남고(`plugins.md:126`), 호스트 페이지는 프로젝트 데이터 호출로 읽고 쓴다. `plugin-host.md:59`에 그 호출을 served call로 더하고, 두 호스트에 사례를 둔다. 키가 바뀌지 않으므로 마이그레이션은 필요 없다.
  - 채널: 네이티브 호스트는 `plugin-host:` 사이드카 메시지를 메인 페이지가 아니라 호스트 web view로 보낸다. 호스트 페이지는 명령을 `sidecar.send {sidecar, body, cids}`로 보낸다. `plugin-host.md:59`는 확인하며, "no sidecar send" 문장이 있으면 교체한다. 두 호스트에 사례를 둔다.
  - 실패: 워크벤치는 `plugin-host:` 실패를 `{sok: 1, sidecar, failure}`로 호스트 페이지에 전달하므로 이 경우 앱 오류 경고를 보이지 않는다(`sidecars.md:85`).
  - 층 규칙(라운드 3 문장을 대체), `plugin-processes.md:28`: "**Plugin host:** created only when a declared sidebar status must be served while no view of the plugin is open. The host serves its declared statuses and holds the DOM-free presentation of them, and it relays its plugin's sidecar messages and command requests; it holds no logic that a sidecar can hold." `plugin-host.md:5`도 같은 조건을 받는다.
- D9.3: 라운드 3과 같다. 라우트 키는 D9.2의 것을, 상태는 라우트별 키를 쓴다.
- D9.7(테스트 대상): DOM 없는 테스트는 D9.2의 호스트 페이지 표현 모듈(선언값을 만드는 모듈)을 읽는다. 빨간 사례: `document.createElement("div")`를 더한 사본에서 실패. 초록: 쓴 그대로의 모듈에서 통과.
- D9.9(비용, 수정): 정지된 files 사이드카는 앱을 재시작할 때까지 정지된 채다. 창마다 펼침과 선택 상태는 따로 둔다. 화살표 키 탐색은 여전히 잃는다. 사이드카 재시작은 펼침과 선택을 초기화한다.

라운드 5 감사자는 이 본문, 표현 배치의 기준 변경, 층 규칙 문장을 검토한다.

## 미확인 주장의 검증 (라운드 4 기록)

라운드 5 검토 전에 이 worktree의 파일에서 확인했다. 아래 각 주장은 틀렸던 곳을 바로잡았다.

- `packages/plugin-api/terms.json:304`에 용어 `branch`가 있으며, "A tree node with a children array that is not empty, which the workbench draws with an expand control"로 정의된다. 용어 `unloaded branch`는 없다. 라운드 4 본문(G-D9.1h)은 `branch`가 자식으로 정의된다는 점에서 옳다. 새 용어는 쓰기 전에 추가한다.
- `docs/spec/exposure.md`에는 선언형 요소의 keydown 규칙이 없다. "Keyboard shortcuts" 절(`:61`)은 워크벤치와 view 단축키만 나열한다. 키 처리에 관한 유일한 문장은 `docs/spec/declared-ui.md:130`의 "A declared UI element has no key handler of its own."이다. 그러므로 D9.1b의 keydown 규칙은 기존 규칙의 변경이 아니라 새 규칙이다.
- `docs/spec/plugin-host.md:59`에는 "A plugin host has no `tab.state` call, no region operation, no sidecar send, and no clipboard or link call" 문장이 그대로 있다. 라운드 4는 이 문장이 없다고 적었는데 틀렸으며, 여기서 바로잡는다. "no sidecar send" 절은 D9.2가 바꾼다.

## 다른 곳에 기록할 것

이 검토는 아래를 바꾸지 않는다. 각 항목은 소유 저장소나 브랜치에 기록된다. D2와 D8 항목은 하위 항목 F238-d-1~F238-d-8(`docs/features.md`)이고, D9 구현 항목은 F238-d-9~F238-d-22다. 아래 라운드 2 목록은 기록으로 남기며, D9에 관해서는 하위 항목이 대신한다:
`docs/spec/plugin-host.md`(Channel, D9.2 경로, `:5`의 층 문장), `docs/spec/plugin-processes.md:26-28`(D9.2의 호스트 규칙), `docs/spec/native-surfaces.md`(D9.3의 view `declared-ui.expanded` 메시지), `docs/spec/sidecars.md:41,46,65,67`(호스트 경로 키).

- `AGENTS.md:32-33`과 `AGENTS.ko.md:32-33`(R2.3): 소유자는 사람이다. `AGENTS.md`는 사람의 파일이기 때문이다. 정확한 본문은 다음 문단에 있다. `docs/spec/plugins.md`(R2.1, R2.2), `scripts/test/workspace-registry.test.mjs`(R2.4): core main.

R2.3의 정확한 본문(영문 `AGENTS.md` 32줄): "`environment.json` lists plugins, `plugin.json` lists"를 "`environment.json` names plugins only as references in `workspace`, `sidebars` and `settings`, and does not install them; `plugin.json` lists"로 바꾼다. 33줄: "manifests such as `environment.json`, `settings`, and `plugin.json` list what is installed at which version"을 "manifests such as `plugin.json` list what is installed at which version; `plugins/installed.json` lists the installed plugins, and `scripts/workspace-registry.json` declares the sibling folders that `make boundaries` and `make registry` read"로 바꾼다.
- `../core-host-routes-F229/docs/plans/plugin-host-routes.md:55`에 이름만 있는 F230 백로그 항목은 `feat/host-routes-F229`에 커밋되지 않았다. 하위 항목 F238-d-10이다(소유자: F229 브랜치).
- `plugins/files` 저장소: F238-d-15~F238-d-17. `plugins/shell` 저장소: F238-d-21(`plugin.json`의 `shell.history` 설명과 체크리스트 P10).
- F229가 층 규칙, 표현 위치, 자르기 위치를 정한다: F238-d-20.

## 하위 항목

D2와 D8의 하위 항목 F238-d-1~F238-d-8은 `docs/features.md`(+ko)의 F212 아래에 등록되어 있다. D9 구현 하위 항목 F238-d-9~F238-d-22도 거기에 등록한다. 소유자는 위 목록과 각 항목에 있다. 라운드 5는 D9의 배치만 정한다.
