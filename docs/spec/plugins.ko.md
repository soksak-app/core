# 플러그인과 애플리케이션 환경

[English](plugins.md)

독립 창 선언·배치·연결·레일 경계선 계약은 [외부 창 사이드바](external-sidebars.ko.md)에 정의한다. 카드 내부 변 계약은 독립적으로 유지한다.

워크벤치는 특정 플러그인을 참조하지 않는다. 각 애플리케이션은 `environment.json`에 플러그인과 기본값을 선언한다. `environment.json`은 `workspace`, `sidebars`, `settings`에서 플러그인을 참조로만 이름 붙이며 플러그인을 설치하지 않는다. 각 플러그인은 `plugin.json`에 자신을 선언한다. [`@soksak/plugin-api`](../../packages/plugin-api/index.js)가 두 형식, `sidecar.json` 형식, 스테이징 파일 배치, 페이지 import map을 정의한다. 워크벤치, 플러그인, 애플리케이션은 이 함수로 자기 파일을 검사한다.

## 작업 공간 구조

| 디렉터리 | 내용 |
| --- | --- |
| `packages/soksak` | 헤드리스 배치 라이브러리 |
| `packages/workbench` | 워크벤치 프런트엔드(코어): 프로젝트, 스페이스, 카드, 탭, 사이드바, 설정, 플러그인 로드, `sok-copy-frontend` |
| `packages/plugin-api` | 선언 형식, 스테이징 배치, 페이지 import map, 플러그인 페이지 도구 |
| `packages/client` | 로컬 엔드포인트 클라이언트와 지연 시간 벤치마크 |
| `packages/host/<name>` | [네이티브 호스트](hosts.ko.md) 라이브러리(코어): Go의 `wailsv3`와 Rust의 `tauriv2` |
| `apps/<name>` | 애플리케이션 하나: `environment.json`, `runtime/`, 네이티브 진입점과 프레임워크 설정, 테스트 |
| `native/darwin` | 네이티브 호스트가 사용하는 macOS 공용 라이브러리 |
| `e2e` | 실행 중인 네이티브 애플리케이션의 창 검사 |

Plugin과 sidecar는 자기 repository에 있다([Repository](#repository)).

공통 기능은 워크벤치나 네이티브 호스트에 두어 플러그인이 다시 구현하지 않게 한다. 플러그인 기능은 워크벤치로 옮기지 않는다. 사이드카는 한 영역의 네이티브 기능을 담고 여러 플러그인에 제공할 수 있다. 메시지 전달 같은 일반 기능은 호스트에 둔다.

## Repository

Core, 각 plugin, 각 sidecar는 core checkout의 sibling 폴더에 있는 별도 git repository다. 각각 자기 test, 자기 `docs/features.md` checklist, 자기 build를 가진다. Core의 어떤 build, 검사, gate도 plugin이나 sidecar repository를 build, pack, 설치하거나 이름하지 않는다. `make check-boundaries`는 다른 repository를 읽지 않고 어떤 plugin도 알지 않으므로 core checkout만으로 실행되며, core의 window check는 `e2e/fixtures`의 fixture plugin만 설치한다([검증 경계](plugin-processes.ko.md#검증-경계)).

| 폴더 | Repository | GitHub |
| --- | --- | --- |
| `core` | Layout library, workbench, plugin-api, client, command line, host, 애플리케이션, spec, window check | `soksak-app/core` |
| `../registry` | 공개 registry: 항목마다 파일 하나, 그 검사와 게시([공개 registry](registry.ko.md)) | `soksak-app/registry` |
| `../plugins/<id>` | Plugin 하나: `plugin.json`, page, `engines.soksak`을 가진 `package.json`, test. Plugin은 `browser`, `editor`, `files`, `hwp`, `terminal`, `term`이다. `shell`은 repository가 있으나 게시하지 않는다 | `soksak-app/plugin-<id>`. `shell`은 게시하지 않는다 |
| `../sidecars/vt` | Terminal engine: crate `vt-core`, `vt-alacritty`, 그리고 `vt-alacritty`의 sidecar `@soksak/sidecar-vt-alacritty` | `soksak-app/sidecar-vt` |
| `../sidecars/alacritty` | 바뀐 행만 다시 그리는 terminal engine: crate `alacritty-core`, `alacritty`, 그리고 `alacritty`의 sidecar `@soksak/sidecar-alacritty`. 이 sidecar는 frame을 lease 방식으로 보이고 screen은 요청할 때 답한다 | `soksak-app/sidecar-alacritty` |
| `../sidecars/files` | Sidecar `@soksak/sidecar-files` | `soksak-app/sidecar-files` |
| `../sidecars/shell` | Sidecar `@soksak/sidecar-shell`. repository가 있으나 게시하지 않는다 | `shell`은 게시하지 않는다 |

이름이 `@soksak/plugin-`으로 시작하는 `@soksak` scope의 package는 plugin이고(core의 `@soksak/plugin-api`는 제외), `@soksak/sidecar-`로 시작하는 package는 sidecar다. core source와 test는 이 중 어느 것도 부르지 않고, fixture는 `@scope/plugin-probe`, `@scope/sidecar-probe` 같은 다른 scope를 쓴다. core 이름은 core checkout에서 추적되는 모든 `package.json`의 이름이며, 애플리케이션, `e2e`, workbench test runtime을 포함한다. `@soksak/shared`도 core 이름이다. core가 import-map 접두사 `soksak://core/shared/`로 제공하며 `package.json`은 없다. Core source나 test가 `@soksak/` package를 이름이 정확한 core package 이름이 아니게 쓰면, 선언 여부와 관계없이 `make check-boundaries`에서 실패한다. `@soksak/` 밖의 이름은 검사하지 않는다.

Core, plugin, sidecar, kit은 소스 수준에서 결합하지 않는다. 어떤 저장소도 의존, build, 검사, workflow에서 다른 저장소의 release, revision, 소스 경로를 가리키지 않으며, 한 저장소의 release가 다른 저장소의 release를 강제하지 않는다. 서로를 아는 것은 설치가 쓰는 선언(`installed.json`, `plugin.json`, `sidecar.json`, `environment.json`)과 명세의 계약뿐이다. Plugin은 `@soksak/plugin-api`를 실행 중에만 import하며, 애플리케이션이 페이지의 import map으로 그것을 해석한다([스테이징 배치](#스테이징-배치)). Plugin의 test는 그 인터페이스에서 실제 입력의 규칙([test 종류](../operations/examples.ko.md#test-종류))을 따르고, plugin은 그것에 대한 의존을 선언하지 않는다. Plugin repository에서 `make test`는 plugin의 test를, `make check`는 그 repository의 검사를 실행한다. 애플리케이션은 plugin을 설치할 때 `plugin.json`, `engines.soksak` 범위, 선언을 검증하고 그것을 어기는 plugin을 거부한다([설치](installation.md)). 여러 repository가 검사나 release에서 실행하는 도구는 kit repository에 있고 그 kit의 게시된 release로 소비된다. kit은 application의 층이 아닌 repository의 도구이므로, kit의 release 파일은 manifest가 가리키는 다른 repository의 release이다. 다른 하나는 plugin repository가 창 검사를 위해 가리키는 core의 `@soksak/window-check` release 파일이다([plugin의 창 검사](#plugin의-창-검사)). kit `soksak-app/kit`는 commit message 검사(`sok-check commits`), record 검사(`sok-check docs`), release gate(`sok-check release`), checklist reader, term 목록을 담는다. native process identity library는 sidecar의 공통 기능이므로 core에 있다([process identity](process-identity.md)). core는 그것을 자기 release의 release 파일로 게시하고, sidecar는 그 파일을 build 입력으로 pin해 static link하므로 sidecar 실행 파일은 core에 대한 run-time 의존이 없다.

core release 하나가 예외다: `exposes.dom`을 `exposes.element`로 바꾸어 거부하는 release는 이를 선언하는 각 plugin의 release를 요구한다. 그 core가 그런 plugin을 거부하기 때문이다. 그 core release가 먼저 게시되고 각 plugin release가 뒤따르며, registry pull request 하나가 그 core version을 plugin version과 함께 올린다([registry](registry.ko.md)).

로컬 checkout은 repository를 이 sibling 폴더에 둔다. 한 repository의 어떤 build, 검사, workflow도 이 폴더를 거쳐 workspace의 다른 repository를 읽지 않으며, 어떤 workflow도 workspace의 다른 repository를 checkout하지 않는다.

Plugin이나 sidecar의 version은 자기 것이며 core version과 관계가 없다. Plugin의 `engines.soksak` 범위가 그 plugin을 설치하는 core version을 정하며, 한 core release에서 끝나는 범위가 plugin이 다음 release에 설치되는 것을 막지 않는다. Plugin이나 sidecar repository의 release workflow는 `main`으로의 push에서 시작해 자기 `ci.yml`을 검사로 실행하고 kit의 release gate를 실행한다. Gate가 release하면 release job은 run commit이 `main`의 head이고 tag `v<version>`이 없음을 요구하고, 자기 생태계의 표준 package 도구로 release를 쓰고 release 파일과 함께 `v<version>`을 만든다. Plugin이나 sidecar repository의 어떤 workflow도 core나 다른 plugin, sidecar repository를 checkout하거나 그곳에서 내려받지 않는다. Plugin repository는 build에서 sidecar에 의존하지 않는다. `plugin.json`의 `dependencies`가 설치를 위해 sidecar와 그 범위를 적는다. `make install`은 plugin이나 sidecar repository의 설치 단계다. 잠긴 의존과 build가 필요로 하는 외부 소스를 받고, build, test, pack은 설치하지 않고 그것이 설치한 것을 쓴다. `make test`는 plugin repository의 test를 실행하고, `make pack OUT=<folder>`는 release가 필요로 하는 것을 build하고 `pnpm pack`으로 release를 쓴다([plugin release](installation.md#plugin-release)). Sidecar repository는 `make test`, `sidecar.json`이 적는 실행 파일을 쓰는 `make build`, sidecar를 build하고 `npm pack`으로 현재 platform의 release를 쓰는 `make release OUT=<folder>`를 갖는다([sidecar release](installation.md)). Registry repository `../registry`는 새 plugin, sidecar, version을 제3자의 것도 entry 파일을 바꾸는 pull request로 받는다. 그 workflow는 pull request를 검사하고 merge하고 index를 게시하며([공개 registry](registry.md)), 그 `make build`는 `index.json`을 쓰기 전에 모든 release를 그 entry와 대조한다.

Core window check는 fixture registry에서 plugin을 설치한다. `make build-fixture-registry`는 `e2e/fixtures`의 fixture plugin을 pack하고 그 fixture sidecar를 release해 `target/fixture-registry`에 두며, check의 각 설정은 `sok registry use`로 그것을 정한다([검증 경계](plugin-processes.ko.md#검증-경계)). `shell` plugin과 `@soksak/sidecar-shell`은 repository가 있지만 게시하지 않으므로, 두 애플리케이션의 새 space layout은 shell card 자리에 terminal card를 둔다.

## Plugin의 창 검사

plugin 동작의 창 검사는 그 plugin의 repository에서 실행된다([검증 경계](plugin-processes.ko.md#검증-경계)). plugin repository는 `@soksak/window-check`를 version 이 자기 `engines.soksak` 범위 안에 있는 core release 에서 설치한다. 그 `package.json`은 release file `https://github.com/soksak-app/core/releases/download/v<version>/soksak-window-check-<version>.tgz`를 development dependency로 가리키고, 그 release file은 자기 dependency `@soksak/client`, `@soksak/log-contract`, `@soksak/plugin-api`를 담으므로(`bundleDependencies`, 같은 core release의 그 release file 내용이 `node_modules/<name>`에 있다) pnpm은 URL로 지정한 dependency의 dependency를 거부하는 기본 설정으로 그것을 설치한다([release](../operations/examples.ko.md#release)). 검사는 그 release의 게시된 core application, 곧 application zip `soksak-<version>-<platform>-<host>.zip`의 bundle을 이 package로 시작한다. `<platform>`은 검사를 실행하는 컴퓨터의 release platform이며, core는 `darwin-arm64`의 zip만 게시한다. 검사는 `@soksak/window-check`의 `package.json` `exports`가 가리키는 module과, core와 자기 plugin이 expose한 command, element entry, status만 쓴다([exposure](exposure.ko.md)). core의 source 경로는 읽지 않는다.

이 package는 모든 plugin repository가 그 검사에 쓰는 것을 담으므로 plugin repository는 그 사본을 두지 않는다.

- bin `sok-test-app`(plugin repository의 root에서 `pnpm exec sok-test-app`)은 설치된 package의 core release에서 게시된 application으로 검사를 실행한다. 실행의 각 application(`--app <host>`, `SOKSAK_APP`, 또는 셋 모두)의 `soksak-<version>-<platform>-<host>.zip`을 `build/app-cache/<version>/`에 한 번 내려받아 푼다. release platform, 풀린 zip의 application과 그 두 실행 파일, 풀기, quit key, configuration 폴더 lock의 대기, process 목록은 실행의 platform operation이며, package가 실행하는 platform으로 고르고 의도로 이름 짓는다. macOS가 이를 구현한다. 곧 platform `darwin-<arch>`, `Contents/MacOS/sok-<host>`와 `Contents/MacOS/sok`을 가진 bundle `soksak.app`, `ditto -x -k`, Command+Q, `lockf`, `ps`이다. Linux와 Windows에는 application artifact가 선언되지 않았으므로([hosts](hosts.ko.md)) 거기서 실행의 operation은 실행이 그것을 부를 때 어떤 download보다 먼저 `PlatformOperationNotImplemented`(`<operation> is not implemented on <platform>`)로 거부하며, 대체 결과를 내지 않는다. `build/test-app/` 아래 새 configuration root에 검사 registry를 만든다. 곧 `--pack <command>`가 쓰는 repository의 release(기본은 `make pack OUT={out}`, `{out}`은 release 폴더), package의 start probe와 `e2e/fixtures` 아래 각 plugin 폴더의 `pnpm pack` release, 그리고 이 plugin들이 가리키는 sidecar의 entry를 공개 registry index `https://soksak-app.github.io/registry/index.json`에서 복사한 것이며, bundle의 `sok registry build`가 그 index를 쓴다. 이 plugin들 가운데 둘이 같은 plugin id를 가지면 실행은 실패한다. 각 bundle의 `sok`이 `registry use`와 모든 plugin의 `plugin install`을 실행한다. registry의 `make build`가 쓰는 것과 같은 built registry index를 `--index <file URL or path>`로 주면 실행은 검사 registry를 만들지 않고 plugin을 설치하지 않는다. 각 bundle의 `sok`이 그 index로 `registry use`를 실행하고, 각 application의 first run이 자기 `environment.json`이 가리키는 starter pack을 그 index에서 설치한다([first run](installation.md#first-run)). index가 없거나 읽을 수 없으면 그것을 말하는 step이 실패하며, `--index`는 `--pack`을 받지 않는다. 실행은 각 application을 시작해 `SOKSAK_CONFIG_ROOT`, `SOKSAK_RUN_FOLDER`, `SOKSAK_BINARY_<HOST>`, 그리고 `registry use`가 기록한 file URL인 `SOKSAK_REGISTRY_INDEX`로 검사에 `node --test`를 실행하며, 각 application을 application menu로, 마지막 것은 quit key로 끝내고, 실행의 process가 남으면 실패한다. 검사는 주어진 경로이거나, 아니면 `e2e/fixtures/` 밖의 `e2e/` 아래 test file이다. 모든 검사는 host가 application 안에서 emulate하는 입력으로 application을 움직이므로, 어떤 검사도 window server에 입력을 보내거나 application을 앞으로 가져오지 않는다. 모든 download와 command에는 시간 제한이 있고(검사는 `--check-timeout <seconds>`) interrupt에 끝나며, 각 실패는 자기 step을 말한다. 통과한 실행은 root를 지우고 실패한 실행은 남긴다.
- `@soksak/window-check/catalog.mjs`는 `recordCatalog(configDir)`를 export한다. package가 `core-events.json`으로 담은 core의 event catalog, 곧 같은 release의 [core catalog](events.json) 사본을 configuration 폴더에 설치된 plugin과 sidecar의 catalog와 합친 것이다. 검사는 이를 `prepareFixture`와 `Session.transcript`에 넘긴다.
- `@soksak/window-check/start.mjs`는 검사의 시작 상태를 export한다. `fresh(s, {startPlugin, startEntries, placeholderPlugin, addPluginTab, settings, performanceTrace, log, reads})`는 fixture를 준비하고, 새 space layout의 각 placeholder tab을 `placeholderPlugin`(기본은 `startPlugin`)의 tab으로 바꾸며, focused card의 active tab이 `startEntries`와 함께 ready인 `startPlugin`의 tab이 될 때까지 기다린다. `startPlugin`의 기본은 package의 start probe `startprobe`이고 그 view는 status `startprobe.view` `{started: true}`를 보고하며, 검사는 대신 자기 registry의 fixture plugin을 지정할 수 있다. 새 space layout이 직접 이름을 대는 plugin은 자기 검사에서 설치되어 있으므로 그 tab은 placeholder로 열리지 않는다. 그 검사는 그 plugin을 `startPlugin`으로, start probe를 `placeholderPlugin`으로 지정한다. `addPluginTab`이 없으면 검사 대상 plugin의 tab은 없다. `addPluginTab: {plugin, ready}`는 focused card에 `plugin`의 tab을 더하고 `ready(s, tab)`을 기다린다. `fresh`는 시작 tab `{surface, plugin}`을, `addPluginTab`이 있으면 그 `pluginTab`과 함께 돌려준다. `cardSidebar(s, {plugin, set, sections, layout})`은 active tab이 `plugin`의 것인 card에 card-left sidebar를 둔다. `sections`가 있으면 그것의 common set을 직접 저장하는데, application의 environment가 plugin의 set을 대신하는 sidebar set을 선언하기 때문이다. 없으면 `set`을 link한다. `reading(app, records)`는 record를 기다리는 선언 `{catalog, records}`이고, `useRegistry`, `restoreRegistry`, `placeholderTabs`, `replacePlaceholders`, `startTab`, `startLayout`(교체와 시작 tab)은 `fresh`의 step이다.
- `@soksak/window-check/view-content.mjs`는 view가 보여 주는 것을 읽는다. `readViewContent(s, surface, {command, document})`는 host가 view의 document region `document`(기본은 root document `""`)를 보여 주는지 확인하고, view가 자기 namespace에 expose한 content read `command`의 text를 돌려준다. `valueProof(expected, actual, owner)`는 그 text가 `expected`를 담는지 확인하고 측정의 proof `{method: "value", expected, actual}`를 돌려주며, `viewContentProof(s, surface, expected, read)`는 둘을 함께 한다. `visibleDocument(s, surface, document)`는 그 보이는 region 의 `host.window` row 이며, content read 가 text 가 아닌 형태로 답하는 view 가 쓴다.
- `@soksak/window-check/view-process-footprint.mjs`는 `host.window`에서 view의 process와 그 footprint를 읽는다. `viewRootProcessPids`, `allViewRootProcessPids`, `viewProcessGroup`, `viewProcessPids`, `viewProcessSurfaces`, `viewProcessDocuments`, `viewDocumentHistoryInventory`, `measureProcessGroup`, `physicalFootprintBytes`, `parsePhysicalFootprint`, `processGroupReclaimEvidence`.
- `@soksak/window-check/view-metrics-collection.mjs`는 view descriptor로 view를 열고 trace하고 잰다. placement `TAB_PLACEMENT`, `viewCardWithDifferentPluginTab`, `rightEdgeWidthDragPlan`, readiness와 clock `waitForViewReadiness`, `monotonicTimeMs`, content trace `withViewContentTrace`, `withDragTraceMode`, `viewStartClockBracket`, `viewContentFrameEvents`, 그리고 start, memory, reclaim 측정 `openRecordedView`, `processStartSamples`, `viewFootprints`, `collectViewProcessGroups`, `collectViewStartAndMemory`, `collectViewReclaimMeasurements`, `collectViewLifecycleMeasurements`, `closeVerifiedRecordedViewGroup`, `closeViewGroup`.
- `@soksak/window-check/drag-measurement.mjs`는 drag의 layout transaction cadence `transactionCadence`를 export한다.
- `@soksak/window-check/chains.mjs`는 `log.query`로 event log를 읽는다. `allRows(s, query)`는 query의 모든 page를, `tailOf(s)`는 지금 log의 tail을 읽고, `chainOf(s, chains, name, since, fields)`는 operation chain의 모든 event가 첫 event의 correlation identifier를 가질 때까지 기다린다([작업 사슬](logging.ko.md#작업-사슬)).
- `@soksak/window-check/project-resource.mjs`는 session이 cleanup에서 닫고 지우는 임시 project 폴더 `temporaryProject(s, prefix)`와, project의 window를 한 번 닫는 `ownProjectWindow(session, child)`를 export한다.
- `@soksak/window-check/platform/platform.mjs`는 [process table](verification.ko.md#process-table)의 행 `processes(fields)`를 export하고, `@soksak/window-check/region-raster.mjs`는 native image region의 presented raster가 그 frame 크기인지를 말하는 `presentsFrame(region, scale)`을 export한다.
- `@soksak/window-check/accessibility.mjs`는 그 수를 세는 benchmark를 위해 application window의 accessibility element를 읽는다(`trusted`, `windowElementsOf`, `readWindowElements`). 입력을 보내지 않고 window를 앞으로 가져오지 않는다.

## plugin.json

| 필드 | 필수 | 의미 |
| --- | --- | --- |
| `id` | 예 | `[a-z][a-z0-9-]*` 형식의 소문자 식별자. 탭과 설정이 참조한다. `core`는 core root가 예약하므로 거부한다 |
| `name` | 예 | 표시 이름 |
| `description` | 예 | 플러그인이 하는 일을 말하는 1자에서 200자 사이의 한두 문장. [설정 탭](settings.ko.md#플러그인)이 보여 주고, 설정 탭이 검색한다 |
| `surface` | 아니오 | `{ "composition": ... }`: 필수 [표면 합성](surface-composition.ko.md). `view` 합성은 페이지를 합성 안에 선언한다([view 표면](#view-표면)). 표면에는 `module`이 없다 |
| `surface.unload` | 아니오. `background`와 함께 쓰면 거부 | 코어가 탭을 unload하고 탭이 쓴 상태로 restore할 수 있는 plugin의 `{ "format": <양의 정수>, "maxBytes": <양의 정수> }`([메모리 절약](#메모리-절약)). `background`와 함께 쓰면 거부한다. 선언이 없는 표면은 unload하지 않는다(`undeclared`) |
| `mark` | `surface`가 있으면 | 추가 메뉴와 새 탭 제목에 표시하는 짧은 텍스트 |
| `icon` | `surface`가 있으면 | 16×16 뷰박스용 SVG 요소 |
| `sections` | 아니오 | 사이드바 섹션 `{ "id": "<플러그인 id>.<이름>", "name", "composition", "height", "unload"?, "actions"? }`. 각 섹션은 [section surface](#섹션), 즉 사이드바에 그려지는 plugin의 view다. `composition`은 `view` 합성이고, `height`는 `"fill"` 또는 포인트 단위 양의 정수다 |
| `dialogs` | 아니오 | `{ "<name>": { "page": "<path>", "regions"?: [ ... ] } }`: plugin의 view가 [dialog](#dialogs)로 여는 page. `name`은 `[a-z0-9][a-z0-9-]{0,63}` 형식이고, `page`는 view composition의 `page`와 같은 page 경로이며, `regions`는 view composition의 `regions`와 같은 dialog page의 region이다. `surface`나 `sections`가 필요하다 |
| `sidebars` | 아니오 | 로컬 기본 세트와 선택적인 네 변 `card` 연결([기본 사이드바 세트](#기본-사이드바-세트)) |
| `preview` | 아니오 | `{ "ink": "--<토큰>" }`: 프로젝트 홈 미리보기에서 플러그인 카드의 색을 정하는 테마 토큰 이름. `surface`가 필요하다 |
| `dependencies` | 아니오 | `{ "<package>": "<version range>" }`: plugin이 필요로 하는 sidecar와 plugin, 그리고 plugin이 함께 동작하는 그 version의 범위([version과 범위](installation.ko.md#version과-범위)). 의존은 plugin의 view나 상태 모듈이 쓰는 [사이드카](sidecars.ko.md)를 가리키며 그때 `surface`, `sections`나 `state`가 필요하거나, plugin이 기여하는 [확장 지점](#확장-지점)을 가진 plugin이나, 그 plugin의 선언된 status나 프로젝트 데이터를 plugin의 view가 따라가거나 읽는 plugin을 가리키며 plugin을 설치하면 그것도 설치된다. status를 위해 가리킨 plugin은 `exposes.status`에 선언한 status만 plugin의 view에 준다([view calls](native-surfaces.ko.md#view-표면)). command, element나 다른 항목은 주지 않는다. 프로젝트 데이터를 위해 가리킨 plugin은 `data`에 선언한 key만 plugin의 view에 준다([프로젝트 데이터](#프로젝트-데이터)). registry index나 `installed.json`의 plugin이 그 package 이름을 가지면 의존은 plugin을 가리키고, 아니면 sidecar를 가리킨다. Plugin 의존의 key는 그 plugin의 package(예: `@soksak/plugin-agents`)이며 plugin id가 아니다. 각 host는 key를 그 package의 load된 plugin id로 풀고, 의존을 읽거나 따라가는 view call은 그 plugin id(예: `agents`)를 명명한다. plugin이 다른 sidecar와 plugin에 요구하는 것의 유일한 선언이다 |
| `events` | 아니오 | plugin의 event catalog 파일의 패키지 안 경로([logging](logging.ko.md#catalog)). 릴리스는 그 파일을 담는다 |
| `extends` | 아니오 | `{ "<point>": { "version": "x.y.z", "schema": <스키마>, "modules"?: { "<bare specifier>": "<경로>" } } }`: 다른 plugin이 기여하는 [확장 지점](#확장-지점). `surface` 또는 `sections`가 필요하다 |
| `contributes` | 아니오 | `{ "<plugin id>.<point>": [ { "range": "<version range>", "module": "<경로>", ... } ] }`: plugin이 다른 plugin의 확장 지점에 기여하는 항목 |
| `data` | 아니오 | `{ "<키>": { "schema": <스키마>, "default": <값>, "format"?: <양의 정수> } }`: plugin의 view가 프로젝트마다 읽고 쓰는 [프로젝트 데이터](#프로젝트-데이터). `surface` 또는 `sections`가 필요하다 |
| `sessions` | 아니오 | `true`: 플러그인의 표면이 소유 세션을 열 수 있음을 선언한다([소유 세션](#소유-세션)). 표면과 `dependencies`에 선언한 사이드카 하나가 필요하며, 이 사이드카가 `transport: "persistent"`인지는 세션 요청마다 host가 확인한다. `background`는 이 선언으로 바뀌지 않는다 |
| `background` | 아니오 | `{ "sidecar": "<선언한 사이드카>", "operation": "<동작 이름>", "settings"?: { "<요청 필드>": "<선언한 설정>" }, "directory"?: "<요청 필드>", "params"?: { "<요청 필드>": "<탭 매개변수>" } }`: 표면이 마운트되지 않은 비활성 탭마다 네이티브 표면을 만들지 않고 선언한 사이드카 세션 하나를 유지한다. 워크벤치는 대응한 플러그인 설정의 현재 값을 요청 필드에 넣고, 탭의 시작 디렉터리를 `directory`가 가리키는 필드에, 탭이 가진 대응 탭 매개변수의 값을 그 요청 필드에 넣는다([background sessions](#background-sessions)). `settings`, `directory`, `params`는 `operation`을 가리킬 수 없고, `settings`는 선언하지 않은 설정을 가리킬 수 없으며, `directory`와 `params`는 `settings`의 필드를 가리킬 수 없고, `params`의 각 탭 매개변수는 비어 있지 않은 이름이다. `surface`와 `dependencies`가 필요하다 |
| `programs` | 아니오 | `{ "<name>": { "program": "<text>", "args"?: [ <slot>, ... ] } }`: plugin의 페이지가 이름으로 실행할 수 있는 외부 프로그램([프로그램 실행](native-surfaces.ko.md#프로그램-실행))이다. `name`은 `[a-z][a-z0-9-]*` 형식이다. `program`은 1~255 byte이며 제어 문자가 없는 text다. PATH에서 찾는 bare name, 프로젝트 폴더를 기준으로 하는 구분자가 있는 상대 경로, 절대 경로, 또는 plugin 자신의 파일을 가리키는 `plugin:<path>` 중 하나다. `<path>`는 `/`로 구분한 상대 경로이며, 빈 segment, `.`, `..` segment가 없고 backslash가 없다. slot은 인자가 같아야 하는 text이거나, 인자 전체가 맞아야 하는 `{ "pattern": "<정규 표현식>" }`(512 byte 이하)다. `args`는 최대 16개 slot이며 인자를 받지 않는 프로그램은 생략한다. `surface`나 `sections`가 필요하며, plugin의 모든 view surface, 곧 tab, section, dialog surface가 이 선언을 담는다 |
| `accounts` | 아니오 | `{ "kinds": [ { "value": "<kind>", "label": "<text>" }, ... ], "programs": { "status": "<program>", "login": "<program>", "logout": "<program>" } }`: 설정 탭의 plugin page가 그리는 plugin의 [계정](#accounts)이다. 이름이 붙은 프로그램을 가진 `programs`와 scope가 `plugin`인 data key `accounts`가 필요하다 |
| `categories` | 아니오 | `[ "<category>", ... ]`: 플러그인의 [plugin categories](#plugin-categories)이며, 각각 core의 plugin category이고 한 번씩 나열한다. `surface`가 필요하다 |
| `requires` | 아니오 | `[ "<category>", ... ]`: 플러그인이 요구하는 [plugin categories](#plugin-categories)이며, 각각 core의 plugin category이고 플러그인이 `categories`에 나열하지 않은 것이며 한 번씩 나열한다. `surface` 또는 `sections`가 필요하다 |

이 표에 없는 manifest member는 알 수 없는 member이며 그 manifest는 거부된다. 제거된 member `host`와 `hostOperations`는 `plugin <id>: <member> is removed; a section is a view of the plugin`으로 거부된다. 0.0.x release version인 동안은 저장 데이터 마이그레이션을 싣지 않으므로 어떤 manifest도 migration member를 선언하지 않는다.

`programs` 항목은 manifest를 읽을 때 검증한다. Workbench 검증기([`@soksak/plugin-api`](../../packages/plugin-api/index.js))는 알 수 없는 member, 형식에 맞지 않는 `name`, 한도를 넘는 `program`, text가 아니고 `pattern` member 하나만 가진 객체도 아닌 slot을 `plugin <id>: programs.<name> <reason>`으로 거부한다. `sok plugin install`은 각 pattern을 host의 정규 표현식 library로 컴파일하며, 컴파일되지 않는 pattern은 `plugin <id>: programs.<name> pattern does not compile: <reason>`으로 거부한다. Host는 실행마다 같은 pattern을 컴파일하며, 컴파일되지 않는 pattern의 실행은 같은 문장으로 거부된다([프로그램 실행](native-surfaces.ko.md#프로그램-실행)).

`plugin:<path>` 형식의 `program`도 같은 방식으로 검사한다. Workbench 검증기와 `sok plugin install`은 `<path>`가 `/`로 구분한 상대 경로가 아니면(빈 segment, `.`, `..`가 있거나 backslash가 있으면) `plugin <id>: programs.<name> program plugin path must be a relative path of / separated segments that are not empty, . or .., without a backslash`로 거부한다. 릴리스를 풀어 놓은 뒤 `sok plugin install`은 설치된 version 폴더의 `<path>` 파일이 있고 실행 권한 bit가 있는 일반 파일인지 검사하며, 아니면 `plugin <id>: programs.<name> program <program> is not found` 또는 `plugin <id>: programs.<name> program <program> is not a regular executable file`로 설치를 거부한다. `<program>`은 선언한 text다. Host는 실행마다 같은 파일을 해석한다([프로그램 실행](native-surfaces.ko.md#프로그램-실행)).

플러그인은 `surface`, `sections`, `contributes` 중 하나 이상이 필요하며, `data`를 가진 플러그인은 `surface` 또는 `sections`가 필요하다. 표면이 있는 플러그인만 추가 메뉴에 표시되고 레일을 갖는다. 워크벤치는 표면에 대해 아무것도 import하지 않으며, 페이지는 view가 불러온다([view 표면](#view-표면)). 표면 식별자는 URL 쿼리가 아닌 명시적인 context 멤버다. 기존 `page` 선언은 거부하며 별도 구현 경로를 선택하지 않는다. 정의되지 않은 필드는 거부한다.

`surface.params`가 있으면 plugin의 탭 인자의 schema이며, `type`이 `object`인 exposure 선언 schema 부분집합이다. `core.card.add-tab {card, plugin, params}`와 `core.layout.open {card, plugin, params, side}`([레이아웃에 동작하기](cli.ko.md#레이아웃에-동작하기))는 `params`를 그것으로 검사하고 space layout에 새 탭과 함께 저장하며, 맞지 않으면 `params do not match <plugin> surface.params`로, `properties`가 이름하지 않은 code point 순서의 첫 member가 있으면 command 인자처럼 `params do not match <plugin> surface.params: unknown parameter <name>`으로, `surface.params`가 없는 plugin이면 `plugin <plugin> declares no tab params`로 실패한다. surface context는 그것을 복사본 `tab.params`로 주고, 인자가 없는 탭이면 `null`이다. 저장된 탭의 인자가 불러온 plugin의 선언과 맞지 않으면 그 탭은 이유와 함께 `<plugin> <version> 탭의 인자가 선언과 맞지 않습니다`를 보이는 placeholder로 열리며, 인자는 변환하지 않는다.

`surface.opens`가 있으면 `{ "extensions": [...] }`이며, plugin이 여는 파일의 점 없는 파일 이름 확장자이며 소문자와 숫자로 쓴다. 각 plugin은 자기가 여는 확장자를 선언하며, 모든 파일을 뜻하는 항목은 없다. 문자열 property `path`를 가진 `surface.params`가 필요하다. `core.file.open {path, card}`는 창이 보이는 project의 root 기준 상대 경로 `path`의 파일을 정규형으로, 곧 `.` 마디, 빈 마디, 끝의 `/` 없이 Unicode NFC로 바꾸어 탭의 `path`로 저장하고 비교하며, 그 확장자를 선언한 plugin에서 연다. 이름에 확장자가 없거나 그 확장자를 선언한 불러온 plugin이 없는 파일은 여는 plugin이 없다. space에 같은 `path`를 가진 그 plugin의 탭이 있으면 명령은 그 탭을 활성화하고, 없으면 `params` `{path}`를 가진 탭을 `card`에, `card`가 없으면 포커스된 카드에 더한다. 명령은 확장자를 선언한 불러온 plugin이 없으면 페이지가 오류로 보이는 `no plugin opens <path>`로, 그 확장자를 불러온 plugin 둘 이상이 선언하면 `<path> is opened by <plugin> and <plugin>`으로, 절대 경로나 `..` 구간이 있는 경로는 `path must be relative to the project root: <path>`로, project가 없는 창에서는 `this window shows no project`로 실패한다.

`core.file.place {name}`은 project의 새 문서를 어디에 저장할지 사람에게 묻는다. host call `filePlace({name})`이 창의 project root 폴더에서 `name`을 파일 이름으로 창의 save panel을 보이거나, client 가 창의 `host.dialog` 를 watch 하는 동안에는 그 client 에게 대신 묻는다([dialog](exposure.ko.md#dialog)). 명령은 고른 파일을 project root 기준 상대 path로 `{path}`에 답하거나 취소되면 `{path: null}`로 답한다. host는 파일 이름이 아닌 `name`(빈 글, `.`, `..`, `/`나 `\`를 담은 글)을 `file place: name <name> is not a file name`으로, project가 없는 창을 `file place: the window shows no project`로, symbolic link를 푼 뒤 project root 안에 있지 않은 위치를 `file place: <path> is outside the project <root>`로 거부한다. plugin은 `params.path` 없는 tab에 빈 문서를 열고 첫 저장 때 이 명령을 호출한다.

`surface.menu`가 있으면 표면의 context menu다: 최대 16개 항목 `{ "command": "<exposes의 명령>", "title": "<글>" }`의 비지 않은 배열이며, 각 제목은 1~40자이고 명령은 서로 다르다. 표면에서 오른쪽 click은 `core.surface.menu {surface, x, y}`를 실행하고, 이는 plugin 이름을 제목으로 창의 그 위치에 선택 레이어로 항목을 연다. 고른 항목은 그 표면에서 매개변수 없이 자기 명령을 실행한다. menu를 선언하지 않은 plugin의 표면이나 표면 밖에서 오른쪽 click은 page의 menu를 연다.

`surface.drop`이 있으면 파일이 표면에 놓였을 때 페이지가 그 표면에서 실행할 `exposes`의 명령을 가리키며, `{urls}`에 놓인 파일 URL을 담는다([네이티브 표면](native-surfaces.ko.md#네이티브-뷰-위의-입력)).

`surface.program`이 있으면 plugin의 `exposes.status` 중 탭의 프로그램 상태를 값으로 담는 status를 가리킨다. 값은 `{state, pid, app}`이거나 `null`이며, `state`는 `idle`, `working`, `blocked`, `pid`는 foreground 프로그램의 process id 또는 `null`, `app`은 프로그램의 이름 또는 `null`이고, 각 창은 그것을 탭마다 `core.grid`에 보고한다([프로그램 상태](program-state.ko.md)).

`surface.composition`은 `{ "kind": "view", "page": "<path>" }` 선언이며 `regions`와 `overlays`를 추가로 가질 수 있다([view 표면](#view-표면)). 그림 영역은 `dependencies`에 이미 나열한 사이드카를 지정하고 표시 방식 `present`를 `copy`나 `lease`로 선언한다([그림 영역](native-surfaces.ko.md#그림-영역)). manifest 선언은 호스트에 전달하는 권한 데이터다. 페이지 코드는 선언에 없는 영역, 공급자, 입력 소유자, 쌓임 항목을 추가할 수 없다. `kind: "hybrid"`와 `kind: "dom"`은 제거되었다. reader는 두 종류를 plugin과 필드 `surface.composition`을 밝힌 오류로 거부하며, `surface.module`은 `plugin <id>: surface module is removed; a surface is a view`로 거부한다.

## 기본 사이드바 세트

플러그인의 선택 필드 `sidebars`는 `sets`와 선택 필드 `card`, `window` 매핑을 포함한다. 각 세트는 로컬 소문자 식별자를 가진 `{id, title, sections, layout}`이며 `layout`은 `list` 또는 `tabs`다. 섹션 ID는 설치된 어느 플러그인도 참조할 수 있다. `card` 매핑은 표면이 있어야 하며 `top`, `bottom`, `left`, `right`를 로컬 세트 ID에 연결한다. 없는 변은 기본 연결을 선언하지 않는다. 알 수 없는 필드, 중복·예약 로컬 ID, 없는 세트와 설치되지 않은 섹션은 명시적으로 실패한다. `sections`에 같은 섹션 ID를 두 번 나열한 세트는 세트와 그 ID를 밝힌 오류로 명시적으로 실패한다.

`window` 매핑은 `left`, `right`, `top`, `bottom` 로컬 세트 ID를 받고 표면을 요구하지 않는다. `card`와 독립적이며 잘못된 매핑과 없는 로컬 세트는 명시적으로 실패한다.

코어는 로컬 세트 ID를 `<plugin>.<local>`로, 카드 매핑을 `{place: "card-<side>", plugin, set}`으로, 창 매핑을 `{place: "window-<side>", plugin, set}`으로 정규화한다. 환경의 `sidebars`가 없으면 정규화한 기본값을 사용한다. 명시적 환경 `sidebars`는 `sets`와 `links`를 모두 제공하고 두 목록 전체를 교체한다. 저장된 공통·프로젝트 목록은 [설정](settings.ko.md#저장되는-세트와-연결)의 규칙으로 각 유효 목록을 덮어쓴다. 덮어쓰기가 제거한 기본값은 복원하지 않는다. 환경이 출력을 덮어써도 플러그인 선언은 검증한다.

창 연결은 등록된 플러그인을 요구하지만 표면은 요구하지 않고, 카드 연결은 표면을 요구한다. 변(`left`, `right`, `top`, `bottom`) 연결은 일반 선택이며 `plugin: null`을 요구한다. 플러그인별 창 연결은 `window-left`, `window-right`, `window-top`, `window-bottom`을 쓴다.

## 섹션
section id와 plugin id는 한 번 공개되면 불변이다. tab·저장된 settings·저장된 project data가 그것들을 참조하고, 이름을 바꾸면 저장된 참조가 해석되지 않는다([저장 데이터 형식](installation.ko.md#저장-데이터-형식)).

섹션은 `composition`을 선언한다. `composition`은 페이지, 영역, 쌓임 항목을 가진 `surface.composition`의 형태인 `view` 합성이다([view surface](#view-표면)). 섹션은 `height`를 선언하고, 선택 항목 `unload`를 선언할 수 있다. `unload`는 `surface.unload`의 형태이며 [메모리 절약](#메모리-절약)이 section surface를 unload할 수 있게 한다. `status`, `module`이나 `fill`을 가진 섹션은 manifest를 읽을 때 `plugin <id>: section <section id> <field> is removed; a section takes composition and height`로 거부한다. `composition`이나 `height`가 없는 섹션은 `plugin <id>: section <section id> requires <field>`로 거부하며, `"fill"`도 양의 정수도 아닌 `height`는 `plugin <id>: section <section id> height must be "fill" or a positive integer`로 거부한다. 섹션은 `actions`를 선언할 수 있다. `actions`는 최대 4개의 `{icon, label, command}` 객체 배열이다. `icon`은 `plus`, `settings`, `more` 중 하나이고, `label`은 버튼의 접근성 이름이자 툴팁인 1자 이상 40자 이하의 문자열이다. `command`는 같은 plugin이 `exposes.commands`에 선언한 command이며, 그 `params`는 빈 객체를 받아야 하므로 필수 parameter가 없다. `actions`가 배열이 아니거나 4개를 넘거나, action이 객체가 아니거나 알 수 없는 필드를 가지거나, `icon`이 네 값 중 하나가 아니거나, `label`이 비었거나 40자를 넘거나, `command`가 선언되지 않았거나, command에 필수 parameter가 있으면 manifest는 plugin, 섹션, action 번호를 밝힌 오류로 거부된다.

Section surface는 창 스페이스의 사이드바에 있는 각 섹션마다 하나 있다. 그것은 자기 plugin의 view surface이며, view를 하나 가진다. tab surface가 view를 하나 가지는 것과 같다. plugin은 그 view에서 섹션의 본문을 어떤 방법으로든 그리며, 코어는 view의 [exposure](exposure.ko.md) 계약만 요구한다. 표면 id는 `<space id>/<sidebar id>/<section id>`이며, 예를 들어 `spc-2wcnnb/left/files.tree`나 `spc-2wcnnb/card-3:right/browser.dom`이다. 사이드바는 섹션을 한 번만 가지므로, 두 사이드바에 연결된 세트는 section surface를 두 개 만든다. space id는 id가 host 안의 surface 하나를 가리키게 한다. project는 창 하나에 보이고, 창은 space 하나를 보이며, space id는 유일하다. 그런데 sidecar 계약은 소유 창과 sidecar의 session을 surface id로 구별하고([sidecar](sidecars.ko.md)), 탭 상태 저장소와 tab session도 항목을 그것으로 구별한다. sidebar id만으로는 반복된다. 모든 project 창은 사이드바 `left`, `right`, `top`, `bottom`을 가지며, 카드 id는 space마다 다시 시작한다(`card-1`). project가 아니라 space가 id를 한정하는 이유는 사이드바의 세트가 space마다 저장되고([project](projects.ko.md#저장)) section surface는 그 space가 보이는 동안만 있으므로, 규칙 하나가 창 사이드바와 카드 사이드바를 함께 다루기 때문이다. 그 tab session 파일은 `tab-sessions/<name>.json`이며, `<name>`은 unreserved 문자를 유지한 채 표면 id를 RFC 3986 percent 인코딩한 값이다. 그래서 `spc-2wcnnb/left/files.tree`는 `spc-2wcnnb%2Fleft%2Ffiles.tree.json`으로 저장된다([host 계약](host-contract.ko.md)의 `workspace.tab-session.section-surface-file`). `core.surfaces`는 각 section surface를 `kind` `section`과 그 `sidebar`로 나열하며, tab surface는 `kind` `tab`으로 함께 나열한다. section view의 시작 값은 `section` `{id, sidebar, card}`를 담는다. `card`는 사이드바를 담은 카드의 id이며 창 사이드바이면 `null`이다. `params`는 `null`이고 `origin`은 `{directory: null}`이다([start values](native-surfaces.ko.md#view-표면)).

section surface는 보이는 스페이스의 사이드바가 그 섹션을 가지는 동안 존재한다. 그 사이드바는 그려진 사이드바이거나, 선택이 있는 변의 창 사이드바로서 표시 스위치가 꺼져 있거나 전체화면 카드가 가린 것이다. 접힌 섹션, `tabs` 세트에서 선택되지 않은 탭의 섹션, 스위치나 전체화면 카드가 숨긴 창 사이드바의 모든 섹션은 비활성 탭이 숨겨지듯 숨겨진다. compositor는 그 자리를 `visible` false로 host에 주므로 host는 그 view를 숨긴 채 두고 그 process를 끝내지 않으며, [메모리 절약](#메모리-절약)은 section surface를 탭과 함께 관찰하고, 숨겨진 section surface를 숨겨진 탭의 규칙으로 unload하고, 그 섹션이 다시 보일 때 restore한다. 사이드바를 다시 보이는 스위치는 남은 view를 그 자리에 놓고 view를 새로 시작하지 않는다. 그 표시의 layout은 남은 섹션 자리의 prediction이 아니다. 그 draw 전의 문서가 그 섹션을 숨긴 채 두기 때문이고, draw 뒤의 commit이 그 자리를 잰다([native surfaces](native-surfaces.ko.md#배치-트랜잭션)). 창 사이드바의 카드를 닫고 다시 삽입하는 배치는 다시 놓는 모든 사이드바의 section surface를 유지한다. 섹션이 사이드바의 세트에서 빠지거나, 사이드바가 제거되거나(창 사이드바는 그 변의 모든 선택을 잃을 때, 카드 사이드바는 그 변이 제거될 때), 사이드바를 가진 카드가 닫히거나, 창이 다른 스페이스나 library를 보이면 section surface를 놓는다. 사이드바의 세트는 그 프로젝트의 설정에 따르고 창은 보이는 프로젝트의 설정만 풀기 때문에, 보이지 않는 스페이스는 section surface를 갖지 않는다. drawing이나 place가 빼 버린 surface, 곧 그려진 사이드바가 섹션을 가지지 않는 section surface나 place가 host에서 뺀 surface는 commit이 해제할 때까지 존재한다. 그동안 main page는 그 surface로 요청을 보내지 않고 그 view에 event를 보내지 않는다. host가 view에 직접 route하는 sidecar message([sidecar route](native-surfaces.ko.md#view-표면))는 host가 그 view를 닫을 때까지 도착한다. host가 그 view를 이미 닫았거나 닫을 것이기 때문이다. 같은 drawing이 다시 그린 섹션은 다음 event를 받는다. 놓인 section surface는 그 상태, session, 표시를 tab state store에 section surface id로 남기므로([프로젝트](projects.ko.md#저장)), 그 섹션을 다시 그리는 사이드바가 그것을 복원한다. 페이지 reload는 모든 section surface를 폐기하고, tab surface와 같이 다시 불러온 페이지의 섹션을 다시 만든다.

`core.sidebars`는 각 섹션마다 그 섹션이 따르는 `surface`를 보고한다. 값은 사이드바를 가진 카드의 활성 탭이며, 창 사이드바이면 포커스된 카드의 활성 탭이고, 없으면 `null`이다. section view는 이 값을 읽고 [view calls](native-surfaces.ko.md#view-표면)의 `runtime.status.watch {name, surface}`로 그 surface의 자기 plugin status를 따른다. 보고된 surface가 바뀌면 이전 surface를 unwatch하고 새 surface를 watch한다. 카드와 창 layout은 위·아래 사이드바에 `horizontal`, 왼쪽·오른쪽 사이드바에 `vertical`을 선택하며([외부 창 사이드바](external-sidebars.ko.md)), `core.sidebars`는 사이드바마다 방향을 보고하고, section view는 그 방향에 따라 내용을 배치한다. 가로 `list`는 섹션을 좌우로 배치하고 세로 `list`는 상하로 배치한다.

세트는 어느 플러그인의 섹션이든 순서대로 묶고, 세트를 만들 때 고른 `layout`을 가진다. `list`에서 사이드바는 세트의 모든 섹션을 세로 방향에서는 위에서 아래로, 가로 방향에서는 왼쪽에서 오른쪽으로 보이며, 각 섹션은 이름 머리 아래에 있고 머리로 접고 편다. `tabs`에서 사이드바는 섹션 이름의 탭 줄과 고른 탭의 섹션 하나만 보인다. 고른 탭과 접은 섹션은 사이드바마다 유지되고 스페이스와 함께 저장되므로([프로젝트](projects.ko.md#저장)) 다시 불러오기와 다시 시작 뒤에도 그대로 보인다.

코어는 사이드바의 틀만 그린다. 틀은 섹션 머리와 그 이름, 접기, 탭, 높이, 상태 줄이다. 사이드바는 세트 제목이나 자리 이름을 보이지 않으며 섹션은 사이드바 맨 위에서 시작한다. 창 사이드바는 자리를 말하고 끝에 접기 컨트롤(`core.sidebar.fold`)을 둔 상태 줄로 끝난다. 접기 컨트롤은 `core.settings.set`(`left`, `right`, `top`, `bottom` 중 하나를 false로)으로 사이드바를 끄고, 그 변의 창 머리 컨트롤이 다시 켠다([창 컨트롤](external-sidebars.ko.md#창-도구)). 카드 안 사이드바는 자기 면과 세트를 말하는 상태 줄로 끝난다([카드 배치](example-model.ko.md)). 접은 섹션은 머리만 남는다. 정수 `height`를 가진 펼친 섹션은 그 높이를 가지며, `height`가 `"fill"`인 펼친 섹션은 다른 섹션이 쓰고 남은 사이드바 높이를 나눠 갖는다. 접힌 fill 섹션은 그 자리를 다른 fill 섹션에 준다. 높이를 선언으로 정하는 이유는 코어가 section view의 내용 높이를 읽지 않으므로, 내용이 바뀌어도 사이드바의 레이아웃이 시작되지 않기 때문이다. 사이드바가 머리와 선언된 높이보다 작으면 섹션을 줄이지 않고 세트 전체를 스크롤한다. 섹션 머리는 카드 머리의 높이, 상태 줄은 카드 발의 높이를 가져 선이 이웃 카드의 선과 한 줄에 놓인다. 코어는 섹션의 action마다 버튼 하나를 `actions` 순서대로 섹션 header의 오른쪽 끝에 그린다. 버튼을 누르면 그 action의 command를 shared binder로 실행하며, 그 섹션 view의 surface를 `--surface`로 넘긴다. 각 버튼은 접근성 이름이 `label`인 `core.sidebar.section.action` element로 노출된다.

정수 높이의 section은 sidebar가 section들보다 짧으면 줄어든다. view는 overflow가 잘라내지 않는 native view이기 때문이다. fill section은 head와 최소 높이 32 point를 유지한다.

세로 `list` sidebar에서는 이웃한 두 열린 section 사이마다 divider가 있고, 사람은 그것을 끌어 크기를 바꾼다. divider를 끌면 divider가 움직이고 그 옆의 두 section만 바뀐다. 위 section이 끈 거리만큼 커지고 아래 section이 그만큼 작아지거나 그 반대이며, 다른 모든 section은 높이를 유지한다. 끌기는 움직일 때마다 `core.sidebar.section.size {sidebar, heights}`를 실행한다. `heights`는 크기를 정하는 각 section의 id를 높이에 대응시키며, 높이는 끌기를 시작할 때 두 section의 높이에서 계산한다. 끌기는 두 section 모두의 크기를 정한다. 다만 두 section 밖의 열린 section 중 fill이 없으면, 두 section 중 fill인 section은 계속 fill로 남아 변화를 받고, 둘 다 fill이면 위 section의 크기를 정한다. 각 높이는 32에서 4096 pixel의 정수이고, 끌기는 두 section 중 하나가 32 pixel보다 낮아지는 곳에서 멈춘다. 명령은 `heights`의 모든 높이를 한 번에 정하며, `list` layout을 쓰지 않는 sidebar, 빈 `heights`, sidebar가 갖지 않은 section, 다른 높이를 거부한다. 크기를 바꾼 section은 `fill` section도 선언된 `height` 대신 저장된 높이를 가지며, 저장된 높이는 선택된 tab과 접힌 section처럼 sidebar마다 유지되어 space와 함께 저장된다([프로젝트](projects.ko.md#저장)). 접힌 section 옆의 divider와 가로 list의 section에는 divider가 없고, 가로 list는 너비를 똑같이 나눈다. `core.sidebars`는 각 section의 저장된 `size`나 `null`을 보고한다. section 선택과 크기는 plane을 다시 배치하므로 compositor가 section surface의 자리를 publish한다.

사이드바는 그것을 담은 카드의 id로 식별한다. `left`, `right`, `top`, `bottom`, 또는 카드 내부 사이드바의 `카드id:변`(`top`, `bottom`, `left`, `right`)이다. 섹션 머리를 접고 펴면 `core.sidebar.section.fold`를, 탭을 고르면 `core.sidebar.section.select`를 `{sidebar, section}`으로 실행한다. status `core.sidebars`는 그려진 모든 사이드바의 세트, 레이아웃, 방향, 고른 탭, 각 섹션의 접힘 상태, surface id, 따르는 `surface`를 알린다. 컴포지터는 각 섹션의 본문을 그 section surface의 [섹션 자리](native-surfaces.ko.md#섹션-자리)로 측정한다.

## Dialogs

plugin의 view는 자기 plugin의 page를 창 전체 위의 dialog로 연다. 그래서 section이나 tab에 맞지 않는 form을 창의 content 위에 그린다. dialog는 plugin의 view surface인 dialog surface다. 그 seat는 창의 content, 곧 title bar 아래의 plane 전체이며 sidebar를 포함한다([dialog seat](native-surfaces.ko.md#dialog-seat)). 창은 dialog를 많아야 하나 가지며, dialog와 [native modal](native-modals.ko.md)은 함께 열리지 않는다.

`plugin.json`의 `dialogs`는 각 dialog page를 `{<name>: {page, regions?}}`로 선언한다. dialog surface는 선언의 composition `{kind: "view", page, regions}`를 가지며, 선언에 `regions`가 없으면 `regions`도 없다. 그래서 dialog page는 dialog가 실행하는 program의 sign-in page 같은 web document를 자기 element의 document region에 보여 준다([document regions](native-surfaces.md#document-regions)). `@soksak/plugin-api`, Go `sok`, Rust `sok`의 reader는 name을 정렬된 순서로 읽고 다음을 거부한다.
- object가 아닌 `dialogs`: `plugin <id>: dialogs must be an object`
- 다른 형식의 name: `plugin <id>: dialogs.<name> is not a dialog name`
- member `page`가 있고 `page`와 `regions` 외의 member가 없는 object가 아닌 항목: `plugin <id>: dialogs.<name> must be {page, regions?}`
- plugin release 안의 경로이고 `.html`로 끝나는 경로가 아닌 page: `plugin <id>: dialogs.<name> page must be a path inside the plugin release that ends in .html`
- 비어 있지 않은 array가 아닌 `regions`: `plugin <id>: dialogs.<name> composition: regions must be a non-empty array`
- view composition의 region과 같은 거부를 받는 region. 그 text는 `plugin <id>: dialogs.<name> composition`으로 시작한다.
- `surface`나 `sections`가 없는 `dialogs`: `plugin <id>: dialogs requires a surface or sections`. view만 dialog를 열기 때문이다.

installer는 view page가 없는 release를 거부하듯 dialog page가 없는 release를 `plugin.json: dialog page <path> is not in the release`로 거부한다. case table `docs/spec/cases/manifest-validation.json`이 모든 reader를 위한 이 case를 가진다.

- **열기.** view는 `runtime.dialog.open {name, params}`를 호출한다. SDK는 `runtime.dialog(name, params)`에 이 호출을 보내며, `params`는 dialog의 page가 검사하는 JSON 값이다. main page는 다음 셋을 거부한다.
  - plugin이 선언하지 않은 name: `view call runtime.dialog.open <name> is not a dialog of <plugin>`
  - dialog가 열려 있는 동안의 열기: `view call runtime.dialog.open: the window shows the dialog <name> of <plugin>`
  - native modal이 보이는 동안의 열기: `view call runtime.dialog.open: the window shows the modal <id>`

  그 밖에는 dialog surface `dialog/<plugin>/<name>`을 창의 layout에 더한다. 그 start value는 view의 start value다. `params`는 `params`, `origin`은 `{directory: null}`, `project`는 창의 project, `section`은 `null`이다. 여기에 start value `dialog` `{name, opener}`가 더해지며, `opener`는 호출한 view의 surface다([start value](native-surfaces.ko.md#view-표면)).
- **Page.** dialog의 문서는 투명하다. 모든 host에서 start value에 `dialog`가 있는 page는 `@soksak/plugin-api`가 50% 불투명도의 검정 backdrop을 root element에 둔다. page는 자기 card를 직접 그린다. 닫는 방법은 page가 정한다. 닫기 button이나 Escape가 그 예이며, page는 그때 스스로 닫는다.
- **닫기.** dialog view는 `runtime.dialog.close {result}`를 호출하며, SDK는 `runtime.dialog.close(result)`에 이 호출을 보낸다. main page는 dialog surface를 지우고 열기 호출에 `result`로 답한다. 다른 view의 close 호출은 `view call runtime.dialog.close is served only to a dialog`로 거부된다. cancel을 포함해 답이 아닌 열기 호출의 모든 끝은 dialog surface를 지운다.
- **끝.** 열기 호출은 [plugin processes](plugin-processes.ko.md) 규칙 3에 따라 끝난다.
  - opener surface가 닫히면 호출은 `surface-closed`로 끝나고 dialog surface가 지워진다.
  - opener process가 끝나면 호출은 `process-ended`로 끝난다.
  - main page가 끝나면 두 view가 모두 끝난다.

  dialog view는 process가 끝나면 모든 view처럼 자기 start value로 다시 시작하고, 열기 호출은 열린 채로 남는다. 재시작이 [view 표면](#view-표면)의 한도에 이른 dialog surface는 지워진다. 그때 오류 표시는 place `dialog <plugin> <name>`으로 `the view failed 4 times within 300 seconds and is created again when its dialog is opened again`을 보이고, 열기 호출은 그 text로 실패한다.
- **Id.** id `dialog/<plugin>/<name>`에는 `/`가 있으므로, surface를 정하지 않은 요청은 tab처럼 dialog를 고르지 않는다([표면 선택](exposure.ko.md#표면-선택)). id가 `dialog`인 space는 없으므로 이 id는 section surface를 가리키지 않는다.
- **Exposure.** dialog의 page는 view처럼 자기 status와 element를 등록한다([view 표면](native-surfaces.ko.md#view-표면)). registry는 열린 dialog의 plugin으로 dialog surface를 알므로, dialog surface를 지정한 요청은 dialog가 열려 있는 동안 그 element에 전달된다.
- **Status.**
  - `core.modal`은 열린 dialog를 `{id, mode: "dialog", document: null, plugin}`로 알린다. `id`는 dialog surface이고 `plugin`은 그 plugin이다([exposure](exposure.ko.md#모달-문서)).
  - `core.surfaces`는 dialog surface를 자기 plugin, `kind` `dialog`, `sidebar` `null`, `dialog` `{name, opener}`로 나열하고, 다른 모든 surface는 `dialog` `null`을 보고한다.

규칙의 이유는 다음과 같다.
- seat가 sidebar를 덮으므로, dialog 뒤의 section view는 pointer를 받지 않는다.
- `addSubview:`는 새 host를 맨 위에 두므로, native container는 나중의 surface host를 dialog host 아래에 넣는다.
- host의 dialog 상태는 native modal과 workbench의 flag만 읽으므로, host는 배치된 dialog surface에서 blur를 끌어낸다.
- view는 그리기 전인 document start에 `view.ready`를 알리고, 대기가 풀어 주는 key는 마지막 keyboard 이동으로 가므로, key 대기는 dialog의 첫 placement가 present된 뒤 dialog의 keyboard 호출에서 끝난다.
- dialog에는 다시 열 tab이 없으므로, dialog의 재시작 한도는 자기 text를 가진다.

기각한 방법은 넷이다.
- plugin page를 load하는 modal web view: page에 view channel도, 호출을 위한 surface identity도, placement sequence 안의 자리도 주지 않는다.
- document region을 통해 native modal의 복사된 문서 안에 두는 page: document region은 surface의 web document를 보여 주며, view channel을 가진 page를 보여 주지 않는다.
- dialog surface 아래에 main page가 그리는 backdrop: surface는 main web view 위에 있다.
- 호출에서 경로로 지정하는 dialog page: 선언된 page는 호출이 실행되기 전에 reader가 검사하는 계약이다.

## Accounts

agent CLI처럼 프로그램이 사람의 login을 필요로 하는 plugin은 `plugin.json`에 `accounts`를 선언하고, 설정 탭의 plugin page는 core의 control로 그 계정을 그린다([설정 탭](settings.ko.md#플러그인)). plugin은 설정 탭에 자기 page를 보이지 않는다. plugin의 모든 설정은 core가 그리는 선언이며, 그래서 모든 plugin page는 같은 모양, 하나의 scroll, 하나의 keyboard 경로를 가진다. 없앤 member `settingsView`가 있는 manifest는 `plugin <id>: settingsView is removed; a plugin declares its settings`로 거부된다.

`accounts`는 `{ "kinds": [ { "value": "<kind>", "label": "<text>" }, ... ], "programs": { "status": "<program>", "login": "<program>", "logout": "<program>" } }`다.

- `kinds`는 비어 있지 않은 목록이다. 각 `value`는 `[a-z][a-z0-9-]*` 형식이고 유일하며, 각 `label`은 1~40자다.
- 각 프로그램은 plugin의 `programs` 항목을 가리킨다. 그 항목의 `program`은 `plugin:` 경로나 bare name이고, `args`는 정확히 pattern slot 두 개다. workbench가 계정의 종류와 home folder를 넘기기 때문이다.
- plugin은 data key `accounts`를 `"scope": "plugin"`과 기본값 `[]`로 선언한다([plugin data](#plugin-데이터)). workbench는 그 기록을 아래 형식으로 검사한다.
- `@soksak/plugin-api`의 validator와 Go, Rust의 `sok`은 다른 형식을 `plugin <id>: accounts <reason>`로 거부한다. `<reason>`은 `must be {kinds, programs}`, `kinds must be a non-empty list of {value, label}`, `kind <value> is not of the form [a-z][a-z0-9-]*`, `kind <value> repeats`, `kind <value> label must be 1 to 40 characters`, `programs must be {status, login, logout}`, `program <name> is not declared`, `program <name> must take two pattern arguments`, `requires the data key accounts with the scope plugin and the default []` 중 하나다.

**기록.** plugin key `accounts`의 값은 다른 member가 없는 `{id, name, kind}`의 배열이다.

- `id`는 `account-<n>` 형식이며, `n`은 어떤 기록도 갖지 않고 plugin data folder의 `accounts/`에 folder도 없는 가장 작은 양수다. 또는 저장된 계정이 이미 가진 `^[a-z][a-z0-9-]{0,39}$` 형식의 식별자다. `id`는 바뀌지 않으므로, plugin의 기록은 계정을 `id`로 가리키고 이름 변경은 그 기록과 home을 유지한다.
- `name`은 제어 문자가 없는 1~40자이고 기록 사이에서 유일하다. 사람이 보고 바꾸는 식별자다.
- `kind`는 선언된 종류다.

다른 형식의 기록은 error display를 통해 `plugin <id> data accounts: <reason>`로 page를 실패시킨다. 계정의 home은 plugin data folder의 folder `accounts/<id>`다. workbench는 계정을 저장하기 전에 mode 0700으로 그것을 만들고, 계정과 함께 지운다. CLI가 home에 login을 두며, core는 token을 갖지 않는다.

**프로그램.** workbench는 설정 탭을 위해 surface와 project 없이 `accounts`의 프로그램을 실행한다. host 명령 `accountRun`([계정 실행](native-surfaces.ko.md#계정-실행))으로, 인자 `<kind>`와 home의 절대 경로 `<home>`을 주고, plugin data folder를 작업 folder로 쓴다.

- `status`는 JSON object 하나 `{login, until, usage}`를 출력하고 0으로 끝난다. `login`은 `true`, `false`, 또는 login 상태가 없는 종류의 `null`이다. `until`은 login이 끝나는 시각의 ISO 8601 text 또는 `null`이다. `usage`는 `{label, used, resets}`의 목록이다. `label`은 1~40자, `used`는 한도 중 쓴 비율인 0~100의 수, `resets`는 다음 초기화 시각의 ISO 8601 text 또는 `null`이다.
- `login`은 home에서 CLI의 login을 실행하며, CLI는 system 기본 browser를 연다. 0으로 끝나면 login이 끝난 것이다. 취소가 실행을 취소한다.
- `logout`은 home의 login을 끝내고 0으로 끝난다.

다른 종료 상태, 잘린 출력, 다른 형식의 출력은 place `settings <plugin>`의 error display에 `account <name>: <program> <reason>`로 보인다. workbench는 plugin page가 보일 때, 추가, login, logout, 이름 변경 뒤, 그리고 창이 key window가 될 때 각 계정의 `status`를 실행하며, 한 plugin에서 한 번에 하나씩 실행한다. terminal에서나 그 끝에 맞아 애플리케이션 밖에서 바뀐 login은 event를 보내지 않으므로, key window가 되는 창이 다시 읽는다. timer는 읽지 않는다.

**Plugin page.** plugin page는 머리 아래, 그룹 설정 위에 그룹 계정을 계정 목록의 [control](settings.ko.md#컨트롤)로 보인다.

- `name` 순서로 계정마다 행 하나: 이름, 종류의 label, login, 그리고 `usage` 항목마다 줄 하나. login은 `until`이 `null`이 아니면 `· <until>까지`가 붙은 `로그인됨`, `로그인 필요`, login이 실행되는 동안 `로그인 중`, 또는 `null`의 `-`다. usage 줄은 `<label> <used>%`이고, `resets`가 `null`이 아니면 `· <resets> 초기화`가 붙는다.
- 행의 버튼: login `false`의 로그인, login이 실행되는 동안의 취소, login `true`의 로그아웃, 이름 변경, 삭제. 이름 변경은 이름을 text field에 저장, 취소 버튼과 함께 보인다.
- 행 새 계정: 이름 field, label로 보이는 종류 select, 버튼 추가.
- field의 글자는 설정 탭이 가진다. 이름 field는 `core.settings-tab.account-name {name}`을, select는 처음 선언된 종류에서 시작하는 `core.settings-tab.account-kind {kind}`를 실행하고, 추가는 그 값으로 `core.accounts.add`를 실행한다. 이름 변경은 `core.settings-tab.account-edit {id}`를, 그 field는 `core.settings-tab.account-edit-name {name}`을 실행하며, 저장은 그 글자로 `core.accounts.rename`을, 취소는 `core.settings-tab.account-edit {id: null}`을 실행한다. 끝난 추가는 이름을 비우고, 끝난 이름 변경은 편집을 끝내며, 다른 page는 둘 다 비운다. 창은 card의 사본을 native view에 그리고, 사본의 field는 글자가 바뀔 때, 곧 Enter나 focus를 잃을 때 글자를 보내므로 글자는 다음 버튼을 누르기 전에 온다.
- 누른 버튼의 명령이 실패하면 place `settings <plugin>`의 error display에 그 error가 보인다.

**명령.** 각 버튼은 core 명령을 실행한다. 각 명령은 저장된 값을 base로 plugin key를 바꾸고([plugin data](#plugin-데이터)), 다른 창이 먼저 저장했으면 `runtime.data.change`의 한도까지 다시 읽는다.

- `core.accounts.add {plugin, name, kind}`는 home을 만들고 계정을 저장하며 `{id}`로 답한다.
- `core.accounts.rename {plugin, id, name}`, home을 지우는 `core.accounts.remove {plugin, id}`, `core.accounts.login {plugin, id}`, `core.accounts.login-cancel {plugin, id}`, `core.accounts.logout {plugin, id}`는 `null`로 답한다.
- 거부: `plugin <plugin> declares no accounts`, `account name must be 1 to 40 characters without a control character`, `account name <name> is already used`, `account kind <kind> is not declared by <plugin>`, `account <id> is not defined`, login이 실행되는 동안의 login, logout, 이름 변경, 삭제에 `the login of account <name> is running`, 취소에 `no login of account <name> is running`.
- status `core.accounts`는 보이는 page의 plugin에 대한 `{plugin, accounts: [{id, name, kind, login, until, usage, running}]}`, 또는 `accounts`가 있는 plugin의 page가 보이지 않는 동안 `null`이다. `running`은 login이 실행되는 동안 `true`이고, `login`, `until`, `usage`는 첫 `status` 실행 전까지 `null`, `null`, `[]`이다.

이유: 행 동작이 있는 계정 목록은 설정 형식이 다루지 않는 유일한 plugin 설정이고, login이 있는 CLI를 실행하는 모든 plugin이 필요로 하므로 core가 한 번 정하고, 각 CLI를 아는 부분은 plugin이 프로그램에 둔다. plugin은 설정 탭에서 코드를 실행하지 않으므로, CLI가 필요한 동작은 선언된 프로그램이다. CLI가 login을 home 경로에 묶을 수 있고 plugin의 기록이 계정을 가리키므로 `id`는 바뀌지 않는다. owner의 열린 실행 수에 한도가 있으므로 plugin의 실행은 차례로 이어진다.

## 프로젝트 데이터
per-key 형식은 코어가 소유한 file 안의 값마다 형태를 정하며, 다른 형태의 값은 변환되지 않고 거부된다([저장 데이터 형식](installation.ko.md#저장-데이터-형식)).

`data`는 plugin의 view가 프로젝트마다 읽고 쓰는 키를 선언한다. view는 [view calls](native-surfaces.ko.md#view-표면)의 `runtime.data.get {key}`와 `runtime.data.set {key, value}`로 이 키를 읽고 쓴다. `runtime.data.set`은 key의 값 전체를 자기가 실은 값으로 덮어쓴다. 값을 읽지도 합치지도 않는다. 메인 페이지는 호출한 view의 시작 값에 있는 프로젝트에 대해 답한다. 그러므로 창이 더 이상 보여 주지 않는 프로젝트의 숨은 view는 자기 프로젝트만 읽고 쓰며, 표시되지 않는 프로젝트에 대한 쓰기는 그 프로젝트에 저장된다. `schema`는 공개 선언의 스키마 부분 집합(`type`, `enum`, `properties`, `items`)을 쓰고 `default`는 그 스키마에 맞아야 한다. 선택 항목 `format`은 양의 정수이며 없으면 1이다. 플러그인은 키의 저장 형태를 바꿀 때 이 값을 올린다. 워크벤치는 각 값을 `projects.json`에서 그 프로젝트의 `plugins.<플러그인 id>.<키>` 항목에 `{ "format": <format>, "value": <value> }`로 저장한다([저장](projects.ko.md#저장)). `runtime.data.get`은 저장된 값이나 기본값을 반환하고, 저장된 값이 스키마에 맞지 않으면 실패한다. `runtime.data.set`은 값이 맞지 않거나 선언하지 않은 키이면 쓰지 않고 실패하며, 선언한 format으로 저장하고, 저장소가 쓰기를 받아들인 뒤 끝난다.

저장된 항목은 정확히 양의 정수 `format`과 `value`만 가진 객체일 때 현재 형태다. 워크벤치는 창이 프로젝트를 표시할 때 그 프로젝트에 저장된 선언 키를 확인한다. 선언한 format과 다른 format으로 저장된 항목, format 없이 저장된 값, 스키마에 맞지 않는 값은 바꾸지 않고 두며, 그 키의 `runtime.data.get`은 프로젝트, 플러그인, 키, format이나 스키마 불일치를 적은 message로 실패한다. 워크벤치는 저장된 값을 변환하지 않는다.

view는 `runtime.data.on`으로 자기 시작 프로젝트의 프로젝트 데이터 변경을 따라간다. SDK는 `runtime.data.on(listener)`에 이 call을 보낸다. 메인 페이지는 이 창의 view가 쓴 값이 저장된 뒤, 그리고 다른 창이 쓴 그 키의 저장 값을 창이 읽은 뒤 view에 event `data` `{key}`를 보내고, view는 `runtime.data.get`으로 값을 다시 읽는다. 그래서 한 프로젝트에 대한 plugin의 두 view(두 section 등)가 같은 값을 본다. 시작 값에 프로젝트가 없는 view는 `view call runtime.data.on requires a project`로 거부된다.

View는 plugin이 `dependencies`에 적은 의존 plugin의 프로젝트 데이터를 `runtime.data.get {key, plugin}`으로 읽고, `runtime.data.on {plugin}`으로 그 변경을 따라간다. `plugin`은 의존 plugin의 plugin id이며, `dependencies`는 그 package를 명명한다([`dependencies`](#pluginjson)). Key는 의존 plugin이 자기 `data`에 선언한 key이며, plugin 자신의 key와 같은 검사, 저장 형식과 실패를 따른다. Plugin의 `dependencies`에 없는 `plugin`과 view의 plugin 자신은 `view call <command> <plugin> is not a dependency of <plugin of the view>`로 실패하고, 빈 `plugin`은 `view call <command> requires a non-empty plugin`으로 실패한다. 의존 plugin의 변경 event는 `data:<plugin>` `{key}`이며, plugin 자신의 데이터 변경 event는 `data`로 그대로 둔다. 의존 plugin의 데이터는 그 plugin의 view가 계속 쓰며, 다른 plugin의 view는 어떤 call로도 바꾸지 않는다. `runtime.data.set`, `runtime.data.replace`, `runtime.data.change`는 `plugin`을 받지 않는다. `plugin`을 명명한 이 call은 `view call <command> <plugin> is read-only for <plugin of the view>: a view changes only the project data of its own plugin`로 실패하고 아무것도 저장하지 않는다.

창은 view의 쓰기를 store가 확인하기 전에 들고 있고, 한 프로젝트의 쓰기를 앞선 쓰기를 포함한 채 하나씩 차례로 store에 보낸다. 그래서 연달아 쓴 두 값의 키가 모두 남는다. 그런 쓰기보다 앞선 store 읽기는 그 프로젝트의 데이터를 창이 들고 있는 그대로 두고, host는 그 쓰기에 `workspace-changed`로 다시 답한다. store가 쓰기를 거부하면 view에 이유를 답하고 값을 되돌린다. 단, 뒤의 쓰기가 그 값 위에 있으면 되돌리지 않는다.

읽은 값으로 다음 값을 만드는 view는 SDK의 `runtime.data.change(key, next)`를 쓴다. `runtime.data.get` 뒤의 `runtime.data.set`은 그 사이에 온 다른 view의 쓰기를 덮어쓰고도 `null`을 답하기 때문이다. `change`는 값을 읽어 그 복사본을 `next`에 넘기고, `next`가 돌려준 값을 view call `runtime.data.replace {key, base, value}`로 저장한다. 이 호출은 key의 값이 아직 `base`와 같을 때만 `value`를 저장하고 `true`를 답하며, 다르면 아무것도 저장하지 않고 `false`를 답한다. `next`가 `undefined`를 돌려주면 아무것도 쓰지 않고, `next`가 throw하면 change가 실패하며, change의 결과는 남아 있는 값이다.

`base`와 저장된 값은 모든 호스트에서 JSON 값으로 비교한다. object member의 순서, 숫자의 표기, 문자열의 escape는 차이를 만들지 않으며, 숫자는 배정밀도 숫자로 비교한다. 그러므로 `runtime.data.get`이 답한 값은, key가 그 값을 가지는 동안 `runtime.data.replace`가 받아들이는 `base`다.

`change`는 다른 writer가 있을 때만 새 읽기부터 다시 시작한다. 새 읽기가 직전 읽기와 같으면 값을 바꾼 writer가 없다는 뜻이므로 change는 `runtime.data.change <key>: the store refused the value that it answered`로 실패한다. 64번 읽은 뒤에는 `runtime.data.change <key>: other writers changed the value 64 times`로 실패한다. 각 실패는 change를 부른 쪽에 전달되어 view가 보여 주고, 값은 다른 writer가 남긴 대로 있다.

## Plugin 데이터
`"scope": "plugin"`인 `data` key는 project 대신 plugin에 속한다. 그 값은 모든 project와 project 없는 window에서 같다. plugin의 계정이 그런 예다. `scope`는 선택이고, 생략했을 때의 값 `"project"`는 key를 [프로젝트 데이터](#프로젝트-데이터)의 key로 둔다. 다른 값은 plugin을 `data <key> scope must be project or plugin`으로 실패시킨다. plugin key는 project key와 같은 schema, default, per-key format, 저장 entry `{ "format": <format>, "value": <value> }`, check와 실패를 가진다. 실패는 project key가 `project <id> plugin <plugin> data <key>`를 말하는 자리에 `plugin <plugin> data <key>`를 말한다.

host는 plugin key를 설정 directory의 `plugin-data.json`에 `{ "format": 1, "plugins": { "<plugin id>": { "<key>": <entry> } } }`로 저장한다. 없는 file은 key를 갖지 않는다. workspace snapshot은 그것을 plugin id의 object인 `pluginData`로 싣고, 거부된 file은 `pluginData` 없이 그 오류를 `pluginDataError`로 싣는다. snapshot의 project와 settings는 그것에 의존하지 않는다. workspace operation `pluginData {plugin, key, entry}`는 현재 형태의 entry 하나를 저장하고 다른 key는 그대로 둔다. 함께 오는 `base`와 `default`가 있으면, key의 저장된 값이, key에 entry가 없으면 `default`가 JSON 값으로 `base`와 같을 때만 entry를 저장하고([프로젝트 데이터](#프로젝트-데이터)), 아니면 아무것도 저장하지 않는다. entry를 저장하면 `true`, 아니면 `false`로 답한다. `plugin`과 `key`는 비어 있지 않은 text이고, 다른 요청은 `pluginData requires <member>`로 거부된다. 거부된 file은 각 operation을 그 오류로 거부한다. host는 저장된 각 entry에 registry의 쓰기처럼 모든 window에 `workspace-changed`로 답한다([저장](projects.ko.md#저장)).

project가 있든 없든 어느 window의 view든 project data의 view call로 자기 plugin의 plugin key를 읽고, 쓰고, replace하고, 따르며, dependency의 plugin key를 읽는다. workbench는 `runtime.data.set`을 `base` 없는 operation으로, `runtime.data.replace`를 `base`와 선언된 default가 있는 operation으로 보내므로, store가 모든 window의 쓰기에 대해 replace를 결정한다. window는 store가 받아들인 저장 entry를 자기가 가진 key에 넣고 변경을 알린다. 이 window의 entry가 저장되기 전에 시작한 store 읽기는 plugin key를 window가 가진 대로 둔다. host가 그 entry에 다시 `workspace-changed`로 답하기 때문이다. 다른 window가 값을 바꾼 key는 window가 snapshot을 읽을 때 window의 view에 알려진다. project 없는 view의 `runtime.data.on`은 plugin key만 따르고, project 있는 view는 두 종류를 모두 따른다. project 없는 view의 project key는 `view call <command> requires a project`로 실패한다. plugin을 제거해도 project data처럼 그 entry는 남는다.

Rejected: `settings.json`의 member. 거부된 `settings.json`은 window에 common settings를 남기지 않고, plugin의 key는 설정 탭에 속하지 않기 때문이다. project마다 key의 사본 하나. project 없는 window는 그것을 갖지 못하고 사본이 서로 달라지기 때문이다. window만의 `base` 비교. 두 window가 같은 값에 대한 replace를 둘 다 받아들이기 때문이다.

## 확장 지점

plugin은 다른 plugin이 선언한 확장 지점으로 그 plugin을 확장한다. 제공자는 `extends`에 지점을 선언하고, 기여자는 `contributes`에 항목을 선언하며, workbench는 이 선언만으로 둘을 잇는다. 어떤 plugin도 코드에서 다른 plugin의 이름을 쓰지 않는다.

- **이름과 version.** plugin `<id>`의 지점 `<name>`은 `<id>.<name>`이다. `version`은 지점 interface의 version이고, 기여한 각 항목은 `range`로 함께 동작하는 version을 적는다. 이전 version에 맞춰 쓴 항목이 실패할 수 있으면 제공자는 `version`의 major를 올리고, interface에 더하면 minor를 올린다.
- **항목.** 각 항목은 `range`, 기여자 plugin 안의 JavaScript 경로 `module`, 그리고 지점의 `schema`가 exposure 선언의 schema 부분집합으로 선언한 필드를 갖는다. workbench는 모든 항목을 schema로 검증한다.
- **공유 module.** `modules`는 bare import specifier를 제공자 plugin의 파일에 대응한다. page import map은 `@soksak/shared/`를 `/shared/`에 대응하고, `/shared/<plugin id>.<point>/<specifier>.js`는 그 specifier의 제공자 파일을 내보낸다([설치된 plugin 제공](installation.ko.md#설치된-plugin-제공)). Tauri host의 webview는 module의 MIME type을 경로 끝에서 정하므로 경로는 `.js`로 끝난다. 제공자 page는 contributor가 연결되지 않아도 자신이 선언한 module을 모두 불러올 수 있다. Contributor는 item의 range가 enabled provider point의 version을 포함할 때만 같은 URL을 불러올 수 있고, item schema는 workbench가 따로 확인한다. 제공자와 기여자는 공유 library를 `@soksak/shared/<plugin id>.<point>/<specifier>.js`로 import하므로 한 URL에서 불러와 instance 하나를 함께 쓴다. 각자 그 library를 그 external import로 번들한다.
- **연결.** page를 불러올 때 workbench는 설치되고 켜진 plugin의 기여를 해석한다. 항목은 제공자가 설치되고 켜져 있고 그 `range`가 지점의 `version`을 포함하면 `connected`, 제공자가 설치되지 않았거나 켜져 있지 않으면 `provider-missing`, 범위가 version을 포함하지 않으면 `version-mismatch`, 항목이 schema와 맞지 않거나 그 module을 불러오거나 확장하다 실패하면 `invalid`다. status `core.contributions`가 모든 항목을 `{plugin, point, state, reason}`으로 보고한다. `connected`가 아닌 상태는 애플리케이션의 오류가 아니며, `invalid`는 오류 표시로 보인다.
- **설치.** `dependencies`에 제공자를 적은 기여자는 제공자와 함께 설치된다. 그 의존이 없는 기여자는 제공자가 설치되어 있을 때만 연결된다. 기여자나 제공자를 설치, 켜기, 끄기, 제거하면 다른 plugin 변경과 같이 그 뒤에 불러오는 page에 적용된다([설치](installation.ko.md)).
- **제공자 interface.** 제공자 page의 surface context는 `contributions(point)`를 가지며, 그 지점의 연결된 항목을 `{plugin, index, item, module, folder, fail(reason)}`로 돌려준다. `index`는 그 plugin의 `contributes` 안에서 항목의 위치이고, `module`은 import할 URL이며, `folder`는 contributor가 설치된 folder의 절대 경로로 `/installed-plugins.json`에서 그 항목의 `folder`다([설치된 plugin 제공](installation.md#serving-installed-plugins)). 그래서 제공자는 자기가 실행하는 program에 contributor의 file을 지정할 수 있다. 제공자는 각 module을 import하고 지점 interface가 정한 export를 호출한다. 실패한 export는 그 항목을 `invalid`로 만들고 다른 항목은 연결된 채로 둔다.
- **권한.** 기여 module은 제공자 page 안에서 그 page의 권한으로 실행된다. 기여자를 설치하면 그 기여자는 제공자의 문서와 입력처럼 제공자 page가 받는 것을 받는다.

## Plugin categories

plugin category는 여러 plugin이 제공할 수 있는 기능이다. 그래서 그 기능이 필요한 plugin은 같은 category의 어떤 plugin과도 함께 동작한다. `dependencies`는 한 package와 그 version을 적으므로 여러 plugin 중 하나를 요구할 수 없고, 그래서 plugin category는 `dependencies`와 따로 선언한다. Core가 plugin category를 정의하며, category 이름은 plugin id가 아니다:

- `terminal`: surface가 terminal session에서 program을 실행하는 plugin이며, `core.layout.open`이 `program`, `args`, `role` parameter로 시작한다([agent roles](agent-roles.ko.md)).

category의 interface는 고정되며, 바뀌면 다른 이름의 새 category다. category 목록은 case 파일 `docs/spec/cases/plugin-categories.json`이며, `@soksak/plugin-api`와 Go, Rust의 `sok` validator가 이 파일에 대해 시험한다.

- `categories`와 `requires`는 각각 core의 plugin category를 한 번씩 나열하며, plugin은 `categories`에 나열한 category를 `requires`로 요구하지 않는다. validator는 다른 값을 `plugin <id>: <member> <reason>`으로 거부하며, `<reason>`은 `must be a list of plugin categories`, `category <name> is not a plugin category of core`, `category <name> repeats`이거나, `requires`이면 `category <name> is in categories`다.
- `sok plugin install`, `sok plugin enable`, `sok plugin update`는 작업 뒤에 설치되고 켜진 plugin과 작업이 설치하는 plugin 중에서 그 category를 제공하는 다른 plugin이 없는 category를 요구하는 plugin을 `plugin <id> requires a <category> plugin, and no installed and enabled plugin is one`으로 거부한다. `sok plugin disable`, `sok plugin remove`, `sok plugin update`는 켜진 plugin이 요구하는 category의 켜진 plugin을 남기지 않는 작업을 `plugin <id> is the last <category> plugin, which <requirer> requires`로 거부하며, requirer는 id 순서로 나열한다. installer는 사용자를 대신해 category의 plugin을 고르지 않는다.
- 시작할 때 workbench는 manifest를 읽은 뒤 category를 검사한다. 창의 불러오고 켜진 plugin 중 어떤 것도 제공하지 않는 category를 요구하는 켜진 plugin은 불러오지 않으며, 이유는 [불러오지 않은 플러그인](#불러오지-않은-플러그인)의 `requires`다. 오류 표시는 `plugin <id> requires a <category> plugin, and no loaded plugin is one`을 보인다. 나머지 plugin은 시작한다.
- 상태 `core.plugin-categories`는 `{ "<category>": [ { "id", "name" }, ... ] }`이며, core의 각 plugin category와 창의 불러오고 켜진 그 category의 plugin을 id 순서로 담는다.

`{ "type": "plugin", "category": "<category>" }` 형식의 설정은 그 category의 plugin 하나를 가리킨다([설정 선언](#설정-선언)). 이 설정은 `default`를 갖지 않는다. 값은 저장된 값이며 모든 저장 값과 같이 검사한다. 불러오고 켜진 그 category의 plugin을 가리키지 않는 값은 그 key 하나의 명시적인 로딩 오류 `<plugin>.<key>: plugin <value> is not a <category> plugin`이며 오류 표시가 보인다. 저장된 값은 대체하지 않고 남기며, 설정에는 값이 없고, 다른 설정은 불러와 적용한다. status `core.settings-tab`은 그 key를 `missing`에 나열하고, control은 배지 `<value> 필요`를 보인다. 참조하는 plugin은 설정이 유효한 채로 제거되거나 꺼질 수 있기 때문이다. `environment.json`의 값도 같은 방식으로 검사한다. 저장된 값이 없는 동안 값은 창에 그 category의 plugin이 정확히 하나 있을 때 그 plugin이다. 그 밖에는 설정에 값이 없고, 사용자가 고를 때까지 오류 표시가 `<plugin>.<key>: choose a <category> plugin`을 보인다. 설정 탭은 category의 plugin을 이름으로 가진 선택 상자를 보인다.

이유: category의 plugin을 요구하는 plugin에서 그 category의 plugin을 없애는 작업은 다음 시작에서 실패하므로 installer가 먼저 거부한다. 시작은 요구하는 plugin만 거부하는데, 다른 plugin이 그 plugin에 의존하지 않기 때문이다. `plugin` 형식의 설정은 `default`가 없는데, 어떤 plugin도 애플리케이션이 설치한 plugin을 알지 못하고, 같은 category의 plugin을 하나 더 설치해도 저장된 값이 가리키는 plugin이 바뀌지 않기 때문이다.

## 외부 라이브러리

스테이징은 패키지 `files`를 복사하고 페이지 import map은 코어 모듈과 `@soksak/shared/`만 가리키므로, 플러그인 페이지는 자기 plugin 안의 파일과 [확장 지점](#확장-지점)의 공유 module만 불러오고, 제공자 페이지는 자기 지점의 기여 module도 불러온다. 외부 브라우저 라이브러리를 쓰는 플러그인은 자기 `scripts/build-vendor.mjs`(esbuild)로 라이브러리를 `ui/vendor/` 아래 ES 모듈 하나로 번들하고, 번들에 든 모든 패키지의 라이선스와 고지를 담은 `.LICENSE.txt` 파일과 함께 커밋하며, `ui`를 통해 `files`에 나열한다. 라이브러리와 esbuild는 정확한 버전의 `devDependencies`다. 플러그인의 `pnpm test`는 스크립트를 `--check`로 실행하며, 커밋된 파일이 새 빌드와 다르면 실패한다. 파일 플러그인은 바닐라 진입점 `@pierre/trees`로 `@pierre/trees` 1.0.0-beta.4(Apache-2.0)와 그 의존성 `preact`(MIT)를 번들한다.

## 진단 선언

표면이나 section이 있는 플러그인은 검사에만 쓰는 status와 명령 항목을 plugin 루트의 `diagnostics.json` 파일에 둘 수 있다: `{ "module": "ui/<파일>.js", "exposes": { ... } }`. `module`은 plugin 안의 파일이며, `exposes`는 `plugin.json` `exposes`의 형식과 소유자 규칙을 따른다. 한 이름은 `plugin.json`과 `diagnostics.json` 중 한 곳에만 선언한다. `package.json`의 `files`는 `diagnostics.json`과 그 모듈을 나열하므로 모든 plugin release가 이를 담고, 진단 build만 이를 읽는다. 사용자 입력이나 OS가 만드는 상태를 주입하거나 검사를 위해 내부 이벤트를 기록하는 항목은 `diagnostics.json`에 속하고, 보이는 상태를 보고하거나 사용자 조작을 수행하는 항목은 `plugin.json`에 속한다.

진단 빌드에서 워크벤치는 이 선언을 플러그인의 표면 선언에 더한다. Wails와 Tauri의 workbench는 선언된 diagnostic module을 view page뿐 아니라 workbench page에서도 import하므로 diagnostic staging은 두 import map에 `@soksak/plugin-api/diagnostic-view-frames`를 포함한다. mygo workbench는 view page에서만 import한다. 비진단 staging은 이 mapping과 module을 제외한다. View page는 시작 값의 `diagnostics`에서 diagnostic 선언을 읽고([view 표면](native-surfaces.ko.md#view-표면)) 그 값이 `null`이 아닐 때만 선언된 module을 불러오며 `diagnostics.json`은 요청하지 않는다. 비진단 빌드에서는 그 값이 `null`이므로, release에 그 파일과 module이 있어도 view는 둘 다 요청하지 않는다. import 실패는 오류다. Plugin adapter가 해당 module을 연결하고 해제한다.

## Plugin test

plugin 저장소는 자기 `package.json`이 development dependency로 pin한 `@soksak/plugin-api` release로 module을 test하고, 그 version과 `engines.soksak`으로만 core에 의존한다. test는 그 release의 SDK module을 import하고, view page는 그 release의 view test host(host fixture를 받은 `@soksak/plugin-api/testing`의 `openView`)로 test한다. SDK module, view channel의 host 쪽, core의 contract case의 사본을 두지 않는다. test의 fixture는 core 밖에서 오는 것만 담는다: sidecar의 응답, 다른 plugin의 command, document region의 결과. `checkPluginRepository`는 contract case의 사본을 읽지 않는다.


## 표면 소유권

Wails와 Tauri host의 OS 창마다 앱 DOM WebView가 하나 있고, mygo host의 창에는 없다. 워크벤치는 표면의 카드 요소를 소유하며, `view` 합성의 표면은 자기 view에서 페이지를 실행하고 호스트가 그 view를 카드 요소 위에 배치한다([view 표면](#view-표면)). 플러그인은 내부 WebView나 iframe을 만들지 않는다. 표면 context에서 보낸 사이드카 메시지는 보낸 순서대로 사이드카에 도착한다. 워크벤치는 같은 사이드카에 대한 이전 전송이 끝난 뒤에야 다음 전송을 시작하며, 그 사이드카의 모든 표면과 background 세션이 한 순서를 공유한다. 표면이 아닌 표면에서 보낸 전송은 거부한다.

## Background sessions

`background` 선언은 두 번째 페이지나 숨은 WebView가 아니라 세션 수명을 명시하는 계약이다. 워크벤치는 선언된 `operation`을 선언된 사이드카에 사이드카 메시지 프로토콜로 보낸다. manifest에서는 읽기 쉬운 전체 필드명 `operation`을 사용한다. 워크벤치는 요청을 임의로 만들거나 누락된 동작을 대체하거나 오류를 숨기지 않는다. 표면이 마운트된 탭은 그 표면을 통해 세션을 소유한다. 같은 카드의 다른 탭이 보이는 동안에도 탭의 표면은 마운트된 채 남으므로 그런 탭에는 background 세션이 없고, 탭이 보이거나 그 표면이 마운트되면 탭의 background 세션은 끝난다. 연결 listener도 함께 멈추므로, 사이드카가 다시 연결되어도 세션을 소유한 표면에 그 동작을 보내지 않는다. 탭이 보이게 되면 그 표면이 같은 동작과 이미지 영역을 보내 기존 세션에 다시 연결한다. Page reload가 sidecar session을 유지하면서 마운트된 image region을 닫을 때는 새 page가 비마운트 표면을 background session으로 열기 전에 호스트가 supplier와 정확한 image generation의 `image.detach`/`image.detached` 교환을 완료한다. Supplier는 새 image가 붙을 때까지 표면 session을 headless로 유지한다. 탭을 제거하면 listener의 구독이 끝나지 않았어도 background 세션을 제거한다. params가 owned session을 지정하는 탭([소유 세션](#소유-세션))에는 background 세션이 없다. 그 표면은 보일 때 그 세션에 붙고 사이드카는 표면 없이 owned session을 유지하므로, background 요청은 탭의 표면에 두 번째 세션을 시작하고 사이드카는 attach를 `surface already holds a session`으로 거절하기 때문이다. 요청은 탭의 표면이 시작하는 방식대로 세션을 시작한다. 보이게 된 표면은 background 요청이 연 세션에 다시 붙을 뿐 세션을 새로 시작하지 않기 때문이다. 탭의 시작 디렉터리는 origin의 디렉터리([tab origin](projects.md#tab-origin))이고, origin이 기록하지 않았으면 창 프로젝트의 루트이며, 프로젝트가 없는 창에서는 없으므로 그 필드를 보내지 않는다. 탭 params에 없는 대응 탭 매개변수는 보내지 않으며, `params`의 필드는 `directory`의 필드 뒤에 넣으므로 같은 요청 필드에서는 탭 매개변수가 시작 디렉터리를 대신한다. 각 결정은 event `workbench.background.session` `{tab, plugin, sidecar, action, surface}`다. `open`과 `reopen`은 동작을 보내고, `skip`은 표면이 마운트된 비활성 탭에 아무것도 보내지 않고, `owned`는 params가 owned session을 지정하는 탭에 아무것도 보내지 않으며, `stop`은 세션을 끝낸다. `surface`는 `mounted` 또는 `absent`다.

## 소유 세션

`sessions`를 선언한 플러그인의 표면은 `core.session.open {plugin, params, size}`로 소유 세션을 열며, 이 명령은 `{session}`을 반환한다. `size`는 `{width, height, scale}`로, 카드의 포인트 단위 너비와 높이, 그리고 창의 backing scale이다. 호출한 표면이 세션의 소유자이고, 세션은 창이 가려졌는지와 관계없이 그 크기로 열린다. `core.session.resize {session, size}`와 `core.session.end {session}`는 세션에 작용한다. 어떤 탭도 세션을 보이지 않을 때 크기를 바꿀 수 있는 것은 소유자뿐이며, 세션을 끝낼 수 있는 것도 소유자뿐이다. `core.session.input {session, text}`는 문자열 `text`를 주어진 그대로 세션의 프로그램에 입력하며 `{}`를 답한다. `core.session.submit {session, text}`는 `text`를 프로그램에 paste한 뒤 Enter를 보내며 `{}`를 답한다. CR이나 LF가 든 `text`는 `core.session.submit text must not contain CR or LF`로 거부되는데, 이는 [명령줄](cli.ko.md#명령)의 submit 명령이 거부하는 것과 같다. `core.session.read {session}`은 `{from, rows, cursor}`를 답한다. `from`은 첫 행의 absolute line number이며 `from`과 `count`가 있는 읽기의 `from`과 같은 번호 체계를 따르고, `rows`는 보이는 행의 텍스트 문자열 배열이며 위쪽 행이 먼저이고, `cursor`는 `rows`에서 커서의 0부터 세는 `{row, column}`이다. 소유자는 `from`으로 제출한 줄 아래의 행이 화면 밖으로 스크롤된 뒤에도 그 행을 읽는다. `from`이 없거나 0 이상의 정수가 아닌 사이드카의 화면 응답은 `core.session.read: the sidecar reply from must be an integer of 0 or more`로 거부된다. `core.session.read {session, from, count}`는 대신 세션의 retained rows 중 absolute line number `from`부터 `count`개 행을 읽고, 사이드카 응답 `{from, count, rows}`를 바꾸지 않고 답한다. 번호와 범위는 사이드카 screen read를 따른다([persistent services](persistent-services.ko.md#화면-메시지)). `from`과 `count`는 함께 필요하며, `from`은 0 이상의 정수, `count`는 1부터 200까지의 정수다. 사이드카 요청 전에, 둘 중 하나만 있는 read는 `core.session.read from and count are required together`로, 잘못된 `from`은 `core.session.read from must be an integer of 0 or more`로, 잘못된 `count`는 `core.session.read count must be an integer from 1 to 200`으로 거부된다. 세 명령은 소유자만 호출할 수 있고, 다른 표면은 `session <id> is owned by <owner>`로 거부된다. 문자열이 아닌 `text`는 `core.session.input text must be a string` 또는 `core.session.submit text must be a string`으로 거부된다. 응답은 사이드카가 보내며, 메시지 형식은 [소유 세션 메시지](persistent-services.ko.md#소유-세션-메시지)에 있다.

세션의 프로그램 상태는 `{state}`이며 `state`는 `idle`, `working`, `blocked` 중 하나다. 사이드카가 상태를 보고하지 않았으면 `null`이다. 사이드카는 이벤트 `session.program`으로 상태를 소유자에게 보고하고 마지막 상태를 `sessions` 응답에 적으므로, 재시작 뒤 채택한 세션은 그 프로그램이 전에 보고한 상태를 유지한다([영속 서비스](persistent-services.ko.md#소유-세션)). 이벤트로 소유자는 `core.sessions`에서 프로그램의 turn이 끝나는 것을 본다. 상태를 바꾸는 보고가 받아들여질 때마다 이벤트 `workbench.session.program {session, state}`가 발행되며, 세션이 이미 가진 상태를 다시 보고하면 아무것도 발행되지 않는다. page가 거부한 보고는 `workbench.session.program`을 발행하지 않고 오류로 보고된다.

탭은 `core.layout.open {card, plugin, params: {session}}`로 세션을 보이며, params가 세션을 적은 `core.layout.apply`의 새 탭도 같은 방식으로 세션을 보인다. 두 command는 열려 있지 않은 세션을 layout이 바뀌기 전에 `session <id> is not open`으로 거절한다. 탭은 자기 view의 사이드카를 통해 세션에 붙는다. 플러그인의 고유 연산이 `params.session`을 읽어 붙으며, core는 그 밖에 아무것도 중계하지 않는다. 보이는 탭은 세션에 카드의 크기를 준다. 탭이 보일 때와 카드의 frame이 바뀔 때, view 없이 core가 카드의 frame 크기와 scale로 `core.session.resize`를 보낸다. 첫 layout 전의 카드나 fullscreen 카드가 가린 카드처럼 측정된 frame이 없는 카드는 크기를 보내지 않고 오류도 내지 않으며, 세션은 카드가 측정된 frame을 가질 때 그 크기를 받는다. 플러그인의 사이드카가 자기 글꼴로 이 크기를 자기 단위로 바꾼다. 보이던 탭을 닫아도 세션은 마지막 크기를 유지한다. 복원된 탭의 params가 열린 세션을 가리키면 그 탭은 그 세션을 보인다. 재시작 adopt 뒤, `sessions`를 선언한 plugin의 복원된 탭의 params가 열려 있지 않은 세션, 예를 들어 끝난 service의 세션을 가리키면, 그 탭은 저장된 제목으로 탭을 밝혀 error display로 `restored tab <tab>: the session <id> of tab "<title>" ended before the restart`를 보이고 세션을 보이지 않는다. status `core.sessions`는 열린 세션마다 `{session, plugin, owner, shownBy, program, params}`를 나열하며, `shownBy`는 보이는 탭이거나 `null`, `program`은 세션의 프로그램 상태이거나 `null`, `params`는 그 `core.session.open`의 parameter이거나 open이 parameter를 주지 않았으면 `null`이다. 재시작 뒤 채택한 세션은 서비스가 나열한 `params`를 가진다.

세션은 소유자가 끝내거나 소유자 표면이 닫힐 때 끝난다. 창을 닫아도 그 창의 소유 세션은 유지되며, 복원된 소유자가 세션에 다시 붙는다. `core.session.end`의 사유는 `ended`다. 이벤트 `workbench.session.end {session, reason}`가 사유를 담으며, 사유는 `core.session.end`이면 `ended`, 닫힌 소유자 표면이면 `owner-closed`, 재시작 뒤 돌아오지 않은 소유자이면 `owner-absent`, 재시작 뒤 세션을 연 plugin이 설치되어 있지 않거나 그 사이드카의 세션을 선언하지 않으면 `plugin-absent`다([영속 서비스](persistent-services.ko.md#소유-세션)). 세션이 열리면 이벤트 `workbench.session.open`이 발생한다. 거부 사유는 `session <id> is not open`, `surface <id> does not own session <id>`, `plugin <id> declares no sessions`, `plugin <id> must declare one sidecar for its sessions`, `size width, height and scale must be positive numbers`다. 매니페스트 reader는 `sessions`가 `true`가 아니면 `plugin <id>: sessions must be true`로, 표면이 없으면 `plugin <id>: sessions requires a surface`로, `dependencies`가 사이드카를 정확히 하나 이름 짓지 않으면 `plugin <id>: sessions requires one sidecar in dependencies`로 거부한다. 세션 요청의 경로는 [소유 세션 메시지](persistent-services.ko.md#소유-세션-메시지)를 따른다. 소유 세션의 재시작과 retain 규칙은 [영속 서비스](persistent-services.ko.md#소유-세션)에 있다. `background` 선언은 바뀌지 않으며 소유 세션을 열지 않는다.

## view 표면

`view` 합성을 가진 표면은 plugin의 native 웹뷰 하나, 즉 view로 그린다. view는 plugin의 페이지를 담으며, 자유 DOM, 입력기(IME)가 필요한 텍스트 입력, canvas, editor 또는 영역을 가질 수 있다. view의 호스트 쪽은 [native 표면](native-surfaces.ko.md#view-표면)에 정의한다.

- **선언.** 합성은 `{ "kind": "view", "page": "<path>", "regions"?: [...], "overlays"?: [...] }`이다. `page`는 plugin release 안의 경로다. 상대 경로이고 앞에 `/`가 없으며, 빈 segment, `.`, `..` segment와 `.binary` segment가 없고, `.html`로 끝나며, `package.json`의 `files`에 나열한다. page를 담지 않은 release는 `sok plugin install`이 거부한다. `regions`가 있으면 빈 배열이 아닌 배열이고, `overlays`가 있으면 배열이다. 각 항목은 혼합 합성의 규칙을 따르며, 그림 영역은 `dependencies`에 나열한 사이드카를 지정한다. `view` 합성의 표면은 `module`이 없다. `surface.module`은 거부한다. 나머지 `surface` 필드는 view에도 그대로 적용한다. view가 그것을 위해 실행하는 명령은 view가 channel을 통해 등록한다.
- **영역.** view의 영역은 그 view의 표면 host에 붙는다. 선언이 영역의 유일한 권한이다. view는 `regions`에 없는 영역을 배치할 수 없다. 영역의 inset은 view frame에 상대적이다. 페이지는 view bridge의 `composition.create({regions, overlays})`로 composition을 만든다. 이것은 `region(name)`, `update(change)`, `dispose()`를 가진 [페이지 API](surface-composition.ko.md#페이지-api)의 composition을 돌려주며, 그 동작은 view call로 메인 page에 전달된다([native 표면](native-surfaces.ko.md#view-표면)).
- **워크벤치.** 워크벤치는 view 표면을 다른 표면과 같이 만들고 배치한다. 그것을 위해 `mount`를 호출하지 않고 module을 import하지 않으며, card 요소는 plugin DOM을 갖지 않는다. 호스트가 view를 card 요소 위에 배치한다. 앱 DOM을 reload해도 view는 교체되지 않는다.
- **페이지.** release view import map은 정확히 다섯 항목을 가진다: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/view`, `@soksak/plugin-api/screen-hash`, `@soksak/shared/`. diagnostic build는 diagnostic 전용 core module에 연결되는 `@soksak/plugin-api/diagnostic-view-frames`를 추가한다. release build는 이 module을 map에 넣거나 staging하지 않는다. 이 항목은 diagnostic module만 import한다. `observeViewDocumentFrames` helper는 diagnostic command가 호출할 때만 시작하며, animation frame에서 관찰을 시작하고 view document의 `documentElement` content box를 관찰한다. ResizeObserver 전달 뒤 다음 animation frame에서 이벤트 `runtime.log.trace("view.content_frame", ...)` 하나를 기록한다. 한 animation frame callback만 대기할 수 있다. 그 callback이 실행되기 전에 root가 다시 전달되면 새 callback을 예약하지 않고 해당 frame observation에 최신 전달을 반영한다. 이벤트에는 sequence, document time origin, 첫 번째와 최신 ResizeObserver 시각(`firstResizeAtMs`, `resizeAtMs`), 해당 frame이 나타내는 전달 횟수(`resizeCount`; 값이 1이면 첫 시각과 최신 시각이 같다), animation-frame 시각(`frameTimeMs`), document width와 height가 담긴다. Animation-frame 시각은 최신 ResizeObserver 시각보다 앞설 수 없다. stop function은 observer 연결을 끊고 대기 중인 animation frame을 취소한다. 이 이벤트는 layout 이후의 size 관찰 결과이며 실제 화면 표시를 증명하지 않는다. 보이는 content의 증거는 캡처 pixel로 남긴다. `@soksak/plugin-api/view`가 view bridge다. 이것은 view channel 위에서 `createViewChannel()`을, 그리고 그 channel 위의 call 계층, 선언 UI snapshot, view 영역의 composition을 내보낸다. 페이지는 `@soksak/runtime`이나 `@soksak/workbench/` 아래의 것을 import하지 않는다. 호스트가 페이지에 map을 넣는다([plugin 처리](plugin-processes.ko.md), rule 4): view 페이지는 doctype으로 시작하며 자기 import map을 갖지 않는다. `@soksak/plugin-api`는 `checkViewPage(html)`을 제공하며, plugin의 build가 이것으로 page를 검사한다. 페이지는 시작할 때 표면 context의 동기 값을 받는다. 호스트는 페이지가 실행되기 전에 동결된 `window.sokSurface` `{surface, params, origin, project, declarations}`를 주입하고([native surfaces](native-surfaces.ko.md#view-표면)), 표면 context의 비동기 동작은 view bridge를 거쳐 호출하며, view bridge의 `contributions(point)`는 view call `runtime.contributions`로 그 point의 연결된 항목을 받는다. 항목의 module은 core root에서 import하고, 항목의 `fail(reason)`은 view call `runtime.contributions.fail`로 그 항목을 `invalid`로 만든다. View bridge는 `runtime.log`를 노출해 각 record를 host writer로 보내며 writer가 event-class 정책을 적용한다([logging](logging.ko.md)). view는 자기 page에 오류를 보여 주고, 보여 주는 순간 view bridge의 `runtime.error(where, text)`, 곧 view call `runtime.error`로 각 오류를 기록한다([native surfaces](native-surfaces.ko.md#view-표면)). `icon(name)`의 view page 전달은 아직 선언되지 않았다.
- **unload와 restore.** view 탭은 plugin이 `surface.unload`를 선언한 경우에만 unload한다. 규칙은 [메모리 절약](#메모리-절약)과 같다. unload는 view의 웹뷰와 process를 닫고 영역을 해제한다([영역 수명](native-surfaces.ko.md#region-lifetime)). view의 문서 영역은 메모리 절약이 설명하는 대로 먼저 session history를 쓴다. restore는 같은 origin으로 새 view를 만들고 페이지를 다시 load한다. 페이지는 `tab.state`로 쓴 상태를 표면 context와 같은 동작으로 읽는다. 선언한 plugin이 unload 뒤에 가지는 상태는 메모리 절약이 설명하는 대로 저장된 탭 상태뿐이다.
- **process 종료.** view process가 끝나면 view가 열어 둔 call은 `process-ended` 이유로 끝난다([plugin process](plugin-processes.ko.md) 규칙 3). 호스트는 process가 끝나면 view를 다시 만들고, 새 view는 저장된 탭 상태에서 상태를 복원한다. 재시작 한도는 [plugin process](plugin-processes.ko.md) 규칙 5의 한도다. 같은 view 표면의 실패가 300초 안에 4번 일어나면 재시작을 멈추며, sliding window로 표면마다 센다. 한도를 넘으면 card가 표시 경로로 오류를 보여 주고, 사용자가 탭을 다시 열기 전까지 view를 만들지 않는다.

## 탭 알림

표면 컨텍스트에는 `tab.title(text)`, `tab.footer(text)`, `tab.directory(path)`, `tab.notify({kind, title, text, action, system})`, `tab.modified(value)`, `tab.error(text)`, 고정된 `origin` 객체, 고정된 `project` 객체가 있다.

`tab.modified(value)`는 표면이 저장하지 않은 변경을 가졌는지를 `true`나 `false`로 알린다. 다른 값은 예외를 던진다. 탭이 수정된 동안 탭은 이름 앞에 점을 보이고, `core.grid`는 탭마다 `modified`를 보고하며, 이 상태는 layout에 저장하지 않는다. `surface.save`가 있으면 표면의 변경을 저장하는 `exposes`의 명령을 가리킨다. `core.tab.close`와 `core.card.close`는 수정된 탭을 닫지 않는다. workbench는 탭에 `<이름> 탭에 저장하지 않은 변경이 있습니다` 선택 레이어를 저장하고 닫기(`surface.save`가 있을 때만), 저장하지 않고 닫기, 닫지 않기와 함께 열고, 명령은 `{closed: false}`로 답한다. 저장하고 닫기는 표면에서 저장 명령을 실행하고, 명령이 성공하고 탭이 더는 수정되지 않았으면 탭을 닫는다. 실패한 저장은 `저장하지 못했습니다 · <command>: <error>`를 탭의 오류로 알리고 탭을 둔다. 저장하지 않고 닫기는 탭을 닫고 변경을 버리며, 닫지 않기와 레이어 닫기는 탭을 둔다. 창 닫기, 애플리케이션 끝내기, space 제거, project 제거는 진행하기 전에 수정된 탭마다 같은 방식으로 묻는다.

실패한 save는 같은 modified tab의 다음 close 요청에서 save를 선택하는 것을 막지 않는다. Retry는 그 tab에 새 save command를 실행하고 clean 보고 뒤에도 응답이 대기 중이면 tab을 열린 상태로 유지한다. 성공 응답과 clean 상태가 모두 충족되어야 닫으며, 앞서 실패한 시도가 나중에 해당 tab이나 다른 tab을 닫을 수 없다. Retry 시작은 이전 error를 지우지 않는다. 새 error 보고는 이를 교체할 수 있고 표면은 이를 지울 수 있다.

`tab.error(text)`는 표면이 준비된 뒤 실패한 표면 작업(예: 저장)의 오류를 제어 문자 없는 1자부터 1024자까지의 글로 보이고, `tab.error(null)`은 그것을 지운다. 다른 값은 예외를 던진다. 그 글은 카드의 오류 notice로 보인다. 카드 status line이 그것을 보이고, [표시 자리](notifications.ko.md#표시-자리)에 따라 toast로도 보인다. 글이 나타날 때 그 notice의 오류 log 줄을 쓴다([알림 기록](notifications.ko.md#알림-기록)). `core.grid`는 탭마다 `error`를 글이나 `null`로 보고하고, 이 오류는 layout에 저장하지 않는다. 표면 자체의 실패는 표면 상태가 `error`로 두며, 이는 탭이 닫힐 때까지 남는다.

`tab.title(text)`는 표면의 탭이 이름 대신 보일 제목을 정하고, `tab.title(null)`은 그 제목을 지워 탭이 다시 이름을 보이게 한다. 텍스트는 제어 문자(U+0000–U+001F, U+007F–U+009F)가 없는 1–256자의 문자열이며, 다른 값은 예외를 던진다. 제목은 레이아웃과 함께 저장하지 않는다. `core.grid`는 각 탭이 보이는 제목을 `label`로, 없으면 `null`로 알리고, plugin의 mark 없는 저장된 이름을 `title`로 알린다([card tabs](example-model.md#card-tabs)). plugin이 `surface.unload`를 `{format, maxBytes}`로 선언한 탭이면 워크벤치는 `memorySaver` 설정과 상관없이 마지막 제목을 탭의 `label`로 `tab-state.json`에 둔다. 그래서 마운트되지 않은 탭은 restore 뒤 첫 제목 알림이 그것을 바꿀 때까지 그것을 보인다. `tab.title(null)`은 그것을 지운다([메모리 절약](#메모리-절약)).

`tab.footer(text)`는 표면이 카드의 활성 탭인 동안 그 카드의 내용 발이 보일 글을 정한다. 터미널의 작업 디렉터리나 브라우저 문서에서 포인터 아래 링크의 주소가 그 예다. `tab.footer(null)`은 그 글을 지운다. 텍스트는 제어 문자가 없는 1–1024자의 문자열이며, 다른 값은 예외를 던진다. 하단 글은 레이아웃과 함께 저장하지 않는다. `core.grid`는 각 탭의 하단 글을 `footer`로, 없으면 `null`로, 각 카드가 보이는 발을 `status`로, 보이는 notice를 `notice`로 알린다. 카드에 notice가 있는 동안 내용 발은 그 notice를 보인다([카드 상태줄](notifications.ko.md#카드-상태줄)).

`tab.notify({kind, title, text, action, system})`는 카드에 [플러그인 알림](notifications.ko.md#플러그인-알림)의 필드와 kind를 가진 notice를 준다. `action`은 선택 사항인 `{label, command, params}`이고, `system`은 선택 사항인 불리언이다. Notice는 카드 status line에 보이고, [표시 자리](notifications.ko.md#표시-자리)에 따라 toast로도 보이며, 탭의 점은 바꾸지 않는다. 이 호출은 notice의 `id`를 돌려준다. 포커스된 카드의 notice는 그 카드의 status line에만 보인다([표시 자리](notifications.ko.md#표시-자리)).

`system: true`인 notice도 시스템 알림이다. 창의 호스트는 운영체제의 알림 센터로 탭의 이름을 제목, 알림 텍스트를 본문으로 하여 알림을 게시하며, 애플리케이션이 활성일 때도 게시한다. 호스트가 알림 센터를 시작할 수 없으면 네이티브 오류를 보고하고 알림을 조용히 버리지 않는다. 탭의 나중 알림은 그 탭의 시스템 알림을 바꾸고, 알림이 지워지면 시스템 알림도 지워진다. 시스템 알림을 누르면 그 창이 키 창이 되고 그 탭에 `core.tab.select`를 실행한다. `core.notifications`는 `{authorization, error, posted}`를 알린다. `authorization`은 `notDetermined`, `denied`, `authorized`, `provisional` 중 하나이고, `error`는 권한 요청, 게시, 제거의 마지막 실패 또는 `null`이며, `posted`는 알림 센터가 알림을 받아들인 뒤 지워지지 않은 이 창의 탭을 순서대로 나열한다. 권한이 거부된 동안 알림이 있는 탭과 그 카드의 탭 목록 버튼의 도움말은 `System notifications are turned off for this application.` 줄로 끝난다.

`tab.directory(path)`는 표면의 작업 디렉터리인 절대 경로를 기록하고, `tab.directory(null)`은 그것을 지운다. 다른 값은 예외를 던진다. 워크벤치는 이를 위해 파일 시스템을 읽지 않고 저장하지 않는다. `+`나 쪼개기가 탭을 만들면, 새 표면의 `origin.directory`는 탭을 더하거나 쪼갠 카드의 활성 탭이 그 순간 기록한 디렉터리이고, 없으면 `null`이다.

`project`는 표면이 마운트될 때 표면의 창이 보이는 프로젝트의 id와 정규 `root`를 담은 `{id, root}`이고([프로젝트](projects.ko.md#프로젝트-식별)), 프로젝트가 없는 창에서는 `null`이다. 작업 디렉터리에서 시작하는 표면은 `origin.directory`가 `null`이 아니면 그것을, 아니면 `project.root`를, 그것도 없으면 계정의 홈 디렉터리를 쓴다.

## 메모리 절약

코어는 숨겨진 탭을 **unload**하고(layout에 남는 탭의 표면을 놓는다), 탭이 다시 보이면 **restore**한다(unload된 탭을 그 상태로 다시 마운트한다). 이 두 동작은 다른 말로 부르지 않는다. [dialog surface](#dialogs)는 dialog와 함께 끝나고 unload되지 않으므로 memory saver는 그것을 넣지 않는다. 전역 설정 `memorySaver`가 이것을 켜고 끄며 `memorySaverDelay`가 지연을 정한다([설정](settings.ko.md#값)). 탭을 언제 unload하고 restore할지는 코어만 정한다. plugin에는 타이머도 unload 결정도 없다. plugin은 자기 탭을 unload할 수 있는지 선언하고 자기 상태를 최신으로 둔다. [section surface](#섹션)는 탭과 같은 규칙으로 unload되고 restore된다. 섹션은 `unload`를 선언하고, 그 view는 탭 view와 같이 상태를 쓰며, 저장소는 상태, session, 표시를 section surface id로 묶는다. `core.tab.memory`는 그것을 `kind` `section`으로 나열하고, `core.tab.unload`, `core.tab.keep`, `core.tab.menu`는 탭을 받으며 section surface id는 `<id> is a section surface, not a tab`으로 거부한다. 따라서 섹션은 메모리 절약만 unload한다.

**선언.** `background`가 없는 plugin의 표면은 `surface.unload`를 선언할 수 있고, 선언이 없는 표면은 unload하지 않으므로(`undeclared`) 선언은 요구가 아니라 plugin의 선택이다. `background`가 있는 plugin의 표면은 그것을 선언하지 않는다. background 세션은 background 경로로 세션을 유지하기 때문이다. `validateManifest`는 `background` 옆의 선언과 다른 형태의 선언을 거부한다. 선언이 없는 표면은 유효하고 영구적인 형태다. 그 탭은 unload되지 않고, 상태에 이유 `undeclared`로 나타나며, `core.tab.menu-keep` 항목을 받지 않고, `tab-state.json`에 label cache를 받지 않는다. `validateManifest`는 `false`를 포함한 다른 모든 형태를 plugin을 이름하는 오류로 거부한다. `background`가 있는 plugin의 탭은 이유 `background`로 나타난다. `{format, maxBytes}`는 plugin이 쓰는 상태의 형식 번호와 byte 단위 크기 한도를 선언한다.

**저장소 준비.** 페이지는 시작 중에 탭 상태 저장소를 연다. 호스트는 그보다 먼저 view를 만들 수 있다. `surface.unload`를 선언한 view의 call은 저장소를 시도할 때까지 기다리므로, 탭 상태 call은 저장소가 열리지 않았다는 오류 없이 저장소가 답한다.

**탭 상태.** 선언한 plugin은 필요한 상태를 JSON으로 바뀔 때마다 `context.tab.state.write(value)`로 쓴다. 쓰기는 메모리에 동기로 들어가므로 같은 task의 unload가 최신 값을 본다. 코어는 메모리의 값을 버리지 않고, 1초 안에 탭마다 `{format, value}`로 `tab-state.json`에 저장하며([프로젝트](projects.ko.md#저장)), 탭의 저장소 쓰기마다 이벤트 `workbench.tab.state.stored`가 된다. JSON이 아니거나 `maxBytes`를 넘는 값은 탭과 크기를 이름하는 오류로 거부한다. 표면이 dispose된 뒤 옛 컨텍스트의 `state.write`는 탭과 `disposed`를 이름하는 오류로 거부하고 컨텍스트마다 한 번 로그에 남긴다. 그래서 옛 인스턴스가 restore된 인스턴스의 상태를 덮어쓸 수 없다. plugin은 dispose에서 abort되는 `context.closing`에서 남은 작업을 멈춘다. restore된 표면은 `context.tab.state.read()`를 읽으며, 저장소에 그 탭의 상태가 없으면 `null`이다. 선언한 것과 다른 저장 형식은 탭과 찾은 형식을 이름하는 restore 오류로 거부한다. 이 API로 쓴 상태만 unload, crash, 재시작을 넘어 남는다.

**진행 중인 작업.** `context.tab.keep("busy", on)`은 진행 중인 작업을 알린다(`on`은 boolean). 켜져 있는 동안 탭에는 보호 `keep:busy`가 있고, 이는 표면이 dispose되면 끝난다.

**보호.** 다음 이유 중 하나라도 있는 동안 탭은 unload되지 않으며, 탭은 여러 이유를 가질 수 있다.

- `shown`: 보이는 space에서 카드의 보이는 탭이다.
- `recent`: 보인 지 지연보다 덜 지났다.
- `keep:modified`: 탭이 `context.tab.modified`로 저장하지 않은 변경을 알렸고([탭 알림](#탭-알림)) 깨끗하다고 알리지 않았다.
- `keep:busy`: 표면이 `context.tab.keep("busy", true)`로 진행 중인 작업을 알린다.
- `media`: 탭의 문서 영역이 소리가 나는 media를 재생한다. 페이지의 media 요소가 재생 중이고 mute가 아니며 volume이 0보다 크다. 결정마다(지연 기한, pressure 보고, `core.tab.unload`) 코어는 각 영역에 묻고, 영역은 web view의 audible 상태(`_isPlayingAudio`, WebKit의 탭 audio indicator 상태)를 읽는다. `true`가 탭을 보호한다. 한 번도 재생하지 않았거나, 멈췄거나, mute된 media 요소는 보호하지 않는다. 공개 `requestMediaPlaybackState`는 한 번도 재생하지 않은 media 요소가 있는 페이지에 `playing`을 답하므로 쓰지 않는다. 영역이 사라진 경우처럼 실패한 답은 이유 `media-unknown`을 주고 로그에 남는다.
- `capture`: 문서 영역에 진행 중인 카메라나 마이크 capture가 있다. 같은 결정 단계에서 공개 `cameraCaptureState`와 `microphoneCaptureState`로 읽는다. picture in picture로 멈춘 media는 다루지 않는다. WebKit이 공개 picture in picture 상태를 알리지 않기 때문이다. 화면 capture는 다루지 않는다. 영역은 `getDisplayMedia`를 허용하지 않기 때문이다.
- `form`: 문서 영역의 frame에, 그 frame의 문서가 load된 뒤 trusted `input` 이벤트를 받은 편집 가능한 요소(form field나 `contenteditable`)가 있다. WebKit은 이를 위한 공개 engine 상태를 주지 않으므로, 영역 content world에서 모든 frame에 주입한 영역 script가 이를 알린다. native 영역은 frame 식별자마다 flag를 두고, frame의 `pagehide`나 form `submit`은 그 flag를 지우며, main frame navigation commit이나 reload는 모든 flag를 지운다. 등록된 `beforeunload` handler는 보호가 아니다. content world는 page의 listener를 볼 수 없기 때문이다. 공개 `interactionState`는 form field 내용을 담지 않으므로, 이 보호가 unload에서 입력한 글을 지키는 유일한 방법이다.
- `kept`: 사람이 `core.tab.keep`으로 탭을 load된 채로 두도록 표시했다. 표시는 `tab-state.json`에 저장한다.
- `off`: 설정 `memorySaver`가 꺼져 있다.

영역은 download하지 않으므로 download 보호는 없다. 이유는 상태 `core.tab.memory`와 이벤트가 `undeclared`, `background`와 함께 쓰는 하나의 열거다([exposure](exposure.ko.md#tab-memory)). `media`, `media-unknown`, `capture`는 마지막 결정의 결과이고, 다른 이유는 그 출처가 알릴 때 바뀐다.

**계기.** 보호 없이 지연 동안 숨겨진 탭은 unload된다. 코어 scheduler 하나가 각 탭이 숨겨진 monotonic 시각으로 계산한 가장 이른 기한을 들고, 그것을 바꾸는 이벤트(탭이 보이거나 숨겨짐, 보호 변화, 설정 변화)에 다시 맞춘다. 지난 시간에는 이벤트 출처가 없으므로 타이머를 쓴다. 기한에 `media`나 `media-unknown`이 보호한 탭은 다음 기한을 지연 하나 뒤로 받는다. 호스트의 [memory pressure](hosts.ko.md#memory-pressure) 수준이 warn이나 critical인 동안 코어는 보호 없는 숨겨진 탭 하나를 unload하고, 그 unload가 끝나기를 기다리며, normal 보고가 오거나 후보가 남지 않을 때까지 되풀이한다. 후보는 가장 오래전에 보인 것부터이고, pressure 아래에서는 `recent`가 보호하지 않는다. 후보를 찾지 못한 보고는 이벤트 `workbench.tab.unload.skipped`가 된다.

**Unload.** unload는 이 순서의 코어 동작 하나다. (1) 코어는 선언된 호스트 메서드로 탭의 각 문서 영역에 `interactionState`를 묻고([호스트](hosts.ko.md#memory-pressure)) 탭 session `tab-sessions/<tab>.json`을 쓴다. (2) 탭을 unload됨으로 표시한다. (3) commit을 요청하며, commit은 자기가 선언하는 보이지 않는 표면에서 탭을 뺀다. (4) `host.place`가 성공한 뒤 워크벤치는 place가 닫은 영역을 detach하지 않고 dispose의 unload 방식으로 표면을 놓으며([region lifetime](native-surfaces.ko.md#region-lifetime)), 이 방식은 탭 알림(제목, 하단 글, 디렉터리, origin, modified, 알림)을 두고 오류만 지운다. 오류의 표시는 인스턴스와 함께 끝났고 그 글은 오류 표시가 이미 로그에 썼다. (5) `host.place`가 답한 뒤 `workbench.tab.unloaded`를 낸다. 시도마다 generation이 있다. 기다린 단계마다 코어는 (2) 전에 보호를 다시 평가하고, 새로 생긴 보호나 탭의 보임은 시도를 `workbench.tab.unload.skipped`로 끝낸다. (1) 단계나 결정에서 영역 읽기가 실패하면 시도는 (2) 전에 오류 표시를 거친 `workbench.tab.unload.failed`로 끝나고 탭은 loaded로 남는다. (3) 단계의 commit이 실패하면 시도는 같은 방식으로 끝나고, 탭을 loaded로 되돌리며, 그 표면을 다시 선언하는 commit을 요청한다. 실패한 place는 아무것도 놓지 않았으므로 표면은 마운트된 채 남는다. deadline의 unload가 실패한 탭은 다음 deadline을 한 delay 뒤에 받는다. 보이지 않고 마운트된 탭은 마운트 시각을 숨겨진 시각으로 삼고, 설정을 켜도 각 탭의 숨겨진 시각은 유지된다. unload된 표면에 대한 요청은 `tab <id> is unloaded`로 실패한다.

**Restore.** unload된 탭을 보이면 같은 `origin`으로 표면을 마운트한다. 이 origin은 레이아웃이 저장하고 재시작 뒤에도 복원하며([프로젝트](projects.ko.md#탭-origin)), 레이아웃을 읽을 때 거부된 view 탭은 뷰를 시작하지 않고 거부 문구를 보인다. 표면은 `context.tab.state.read()`로 상태를 읽는다. 탭은 마운트가 끝날 때까지 `restoring`이고, 이벤트는 `workbench.tab.restored`이며, 실패한 마운트나 거부된 session history는 오류 표시를 거친 `workbench.tab.restore.failed`다. 코어는 각 탭의 문서 영역의 직렬화된 session history(`interactionState`)를 configuration directory의 탭별 file `tab-sessions/<tab>.json`([저장](projects.ko.md#저장))에 `{format: 1, regions: {<region name>: {session}}}`로, 값은 base64로 저장한다. 코어는 영역의 main-frame navigation commit 때(page는 이를 영역의 document state에서 바뀐 history(index나 주소 목록)로 읽는다) 탭마다 1초에 한 번까지, unload 전에 1단계로, quit의 window 저장 때 host가 영역을 닫기 전에([hosts](hosts.ko.md#프로세스-생명주기)) file을 쓴다. decode한 크기가 1 MiB를 넘는 영역 값은 저장하지 않고, page는 `workbench.tab.session.dropped {tab, region, bytes}`를 `warn` 수준으로 낸다. 쓰기마다 `workbench.tab.session.stored {tab, bytes}`를 `debug` 수준으로 낸다. unload된 탭의 restore와 재시작 뒤 탭의 첫 표시 때 코어는 file을 읽어 각 영역의 값을 같은 이름 영역의 attach에 한 번 넘긴다. web view가 거부한 값은 오류 표시를 거친 `workbench.tab.restore.failed`로 알리는 restore 실패이며, 그 뒤 영역은 history 없이 다시 붙으므로 표면은 tab 상태에서 restore되고 session history만 잃는다. 탭은 `restoring`으로 남고 마운트가 끝나면 여전히 `workbench.tab.restored`를 낸다. 문서 영역의 handle은 `history`를 알린다. attach가 끝날 때까지 `null`이고, 그 뒤 영역이 세션 기록을 restore했으면 `true`다. restore된 표면은 `history`가 `false`일 때만 저장한 주소를 load한다. restore된 기록 뒤의 load는 항목을 더하고 restore된 scroll 위치를 버리기 때문이다. 읽기가 아무것도 내지 않으면 영역은 기록 없이 만들어지고, plugin이 저장한 주소를 load하며, `workbench.tab.restored`는 `history: false`를 싣는다.

**재시작.** `memorySaver`가 켜져 있는 동안 plugin이 `surface.unload`를 `{format, maxBytes}`로 선언한 숨겨진 탭과 section이 `unload`를 선언한 숨겨진 section surface는 unload된 채 시작하고 처음 보일 때 restore된다. 꺼져 있으면 숨겨진 탭은 시작할 때 마운트된다. 이 규칙은 처음 보는 surface의 규칙이다. library로 열린 창, 나중에 연결한 set, 나중에 연 project 모두 그 surface를 가진 첫 drawn layout에서 unload된 채 시작하게 하므로, 이런 surface가 마운트된 뒤 곧 내려가는 일은 없다. `memorySaver`가 꺼져 있을 때 처음 본 surface는 마운트된 채로 있고, 설정이 켜진 뒤 delay가 내린다. memory saver와 숨겨진 surface는 창이 연 project의 layout을 대상으로 하며, 창이 열지 않은 project는 surface를 갖지 않는다. 선언도 `background`도 없는 숨겨진 탭은 두 경우 모두 시작할 때 마운트된다. 탭이 unload되었는지는 저장하지 않는다.

**plugin이 포기하는 것.** 선언한 plugin은 unload된 탭에서 `context.tab.state`로 쓰지 않은 모든 상태를 포기한다. DOM, 메모리의 객체, sidecar 세션, session history를 뺀 문서 영역의 보이는 page를 포기한다. plugin은 main page의 web storage(`localStorage`, `sessionStorage`, IndexedDB)에 아무것도 저장하지 않는다. 그 저장소는 origin으로 공유되고 코어가 살피거나 지울 수 없기 때문이다. 탭 값은 `context.tab.state`로, 프로젝트 값은 프로젝트 데이터로 저장한다. 문서 영역은 자기 origin이며 자기 web storage를 가진다. unload된 탭에서 더한 탭은 `origin.directory: null`을 받는다. 마운트되지 않은 탭의 디렉터리 알림은 저장하지 않기 때문이다. 각 plugin은 자기 명세에 무엇을 저장하고 무엇을 포기하는지 적는다. plugin은 이를 위한 설정을 더하지 않는다. plugin에 site 예외 목록이 필요하면 그것은 그 plugin의 설정이며 keep 이유로 코어에 전달된다.

## 링크 열기

표면 컨텍스트에는 `runtime.links.open(url)`이 있으며, 호스트에 절대 `http`, `https`, `mailto` URL을 그 스킴의 사용자 기본 애플리케이션으로 열도록 요청한다. 호스트는 다른 스킴, 해석되지 않는 URL, 8192자보다 긴 URL을 거부하고, 반환한 promise는 그 이유로 거부된다. macOS 호스트는 `NSWorkspace`로 URL을 연다. Windows 플랫폼은 `not implemented on windows`를 반환한다.

## Tracing

`context.runtime.trace(event, fields)`는 표면의 event를 page 계층으로 [성능 트레이스](performance-trace.md)에 쓴다. `event`는 비어 있지 않은 이름이고 `fields`는 객체이며, event에는 plugin과 표면의 id인 `plugin`과 `surface`가 붙는다. `fields`는 객체를 돌려주는 함수일 수도 있으며, 이 함수는 트레이스가 켜져 있을 때만 실행되므로 꺼진 트레이스는 객체를 만들지 않는다. `context.runtime.trace.enabled()`는 트레이스가 켜져 있는지 알려 주고 host가 없는 page에서는 false다. 트레이스가 꺼져 있을 때와 host가 없는 page에서는 아무것도 쓰지 않는다. plugin은 다른 방법으로 보일 수 없는 입력의 단계를 기록해, 한 번 나타난 결함이 host와 sidecar의 event와 함께 기록되게 한다.


## Logging

`context.runtime.log.<level>(event, fields)`는 plugin의 event를 [event log](logging.ko.md)에 저장한다. level은 `error`, `warn`, `info`, `debug`, `trace`이고, `event`는 점으로 구분한 소문자 단어의 이름(`input.key`)이며, `fields`는 `surface`를 이름으로 갖지 않는 객체이거나 그 객체를 돌려주는 함수다. 저장되는 event는 `plugin.<plugin>.<event>`이고 field와 표면의 id를 가진다. Module surface의 surface context는 main page가 보내는 field에 그 id를 더하고, view page가 보내는 record는 surface를 이름으로 갖지 않는다. Host가 view channel에 묶인 surface를 더하고 surface를 이름으로 가진 record를 거부하기 때문이다([view record 전달](logging.ko.md#view-record-전달)). 세 번째 인자 `{cids}`는 event를 [사슬](logging.ko.md#상관-식별자)에 잇는다. `cids`는 따옴표, 역슬래시, 제어 문자가 없는 비어 있지 않은 문자열의 배열이며 page writer와 host의 규칙이고, 다른 값과 이 인자의 다른 key는 아무것도 저장하기 전에 `TypeError`를 던진다. 빈 배열은 `cids`를 저장하지 않는다. Page는 모든 record를 host writer로 보내며 writer가 event-class 정책을 적용한다. `fields` 자리에 있는 함수는 host가 있으면 writer의 저장 판단 전에 실행된다. Event 이름과 `cids`를 먼저 검사하고 반환된 객체는 `fields`처럼 검사한다. 기다리지 않고 큐에 넣어 host에 배치로 중계하며, host가 없는 page에서는 아무것도 저장하지 않는다. plugin은 받은 것과 판단한 것을 본 값 그대로 기록하므로, 한 번 나타난 결함을 파일만으로 찾을 수 있다. plugin의 event catalog는 plugin의 manifest에 선언한다. page가 콘솔에 쓰는 것은 field `text`를 가진 event `workbench.console.<method>`로 저장하며, level은 `console.error`와 `console.warn`이 `warn`, `console.info`와 `console.log`가 `info`, `console.debug`가 `debug`다. 콘솔은 기록 입구를 쓰지 않는 코드의 출력이므로 로그에 남되 window 검사를 실패시키지 않는다. plugin은 오류를 `context.runtime.log.error`로 보고한다.

log hook이 없는 표면 컨텍스트(host가 없는 page, 예: 브라우저 예제, 그리고 표면 시험의 host 없는 컨텍스트)에는 event log가 없어서 그 `runtime.log` 호출은 기록을 저장하지 않는다. 이는 의도된 동작이다. host가 있는 표면 컨텍스트에는 workbench가 모든 표면 runtime에 `pluginRecords`를 주므로 항상 hook이 있다.

plugin 저장소의 catalog 검사(`sok-check events`)는 `runtime.log.<level>(`와 `runtime.log[level]`를 plugin event의 입구로 인식하므로([입구](logging.md#catalog)) plugin은 runtime을 직접 호출하며, `runtime.log`로 전달만 하는 자체 emitter module(`ui/events.js`)은 선택 사항이다.

## 아이콘

표면 컨텍스트와 섹션 컨텍스트에는 `icon(name)`이 있으며, 코어 아이콘 `name`을 24 단위 `viewBox`, 획 경로만, `aria-hidden`을 가진 SVG 마크업으로 반환한다. 없는 이름은 예외를 던진다. 코어는 아이콘을 `packages/workbench/icons.js`에 두고, 플러그인은 워크벤치를 가져올 수 없으므로 플러그인 페이지는 자체 그림 대신 컨텍스트로 아이콘을 그린다. 마크업에는 스타일이 없고, 페이지가 자기 Shadow Root에서 크기, 색, 획을 정한다. 이름은 `star`, `projects`, `panel-left`, `panel-right`, `sun`, `moon`, `settings`, `close`와 Lucide 아이콘 `chevron-left`, `chevron-right`, `rotate-cw`다.

브라우저의 뒤로, 앞으로, 새로 고침 단추는 `chevron-left`, `chevron-right`, `rotate-cw`를 카드 머리 단추의 모양으로 그린다. 단추는 20×20, 아이콘은 14px, 색은 `--muted`이고, 포인터 아래에서는 배경이 `--inset`, 색이 `--fg`가 된다. 획 폭 1.95 단위는 16 단위 `viewBox`에서 획 1.3 단위인 머리 단추와 같은 굵기로 아이콘을 그린다.

## environment.json

| 필드 | 의미 |
| --- | --- |
| `runtime` | 선택. 런타임 모듈 `index.js`를 포함한 애플리케이션 안의 디렉터리. Main page를 stage하려면 필요하고, host에 main page가 없는 애플리케이션에는 없다([스테이징 배치](#스테이징-배치)) |
| `workspace.grid` | 새 스페이스의 slicing tree로, layout library의 state 형태 `{root}`다([모델](../../packages/soksak/docs/layout.ko.md#모델)). card node는 `{card, tabs?, width?, height?, fixed?}`다. 내용 카드는 `{ plugin, title }` 항목의 목록 `tabs`를 선언하며, 빈 목록은 새 스페이스가 시작할 때의 빈 카드를 선언한다(`tabs`가 없는 내용 카드는 `environment.json: card <id> is a content card and declares tabs`로 거부한다). 선택 필드인 card `width`(`top`, `bottom` 외의 카드)와 `height`(`top`, `bottom`만)는 point 단위의 유한한 양수이며, 변 이름의 창 sidebar card는 그 크기로 시작하고 생략하면 `sidebarWidth`를 쓰며 `tabs`를 선언하지 않는다 |
| `workspace.focus` | 새 스페이스에서 포커스할 카드. 내용 카드여야 한다 |
| `sidebars.sets` | 플러그인 기본값의 선택적 명시적 덮어쓰기: 섹션 세트 `{id, title, sections, layout}`. `layout`은 `list` 또는 `tabs`다 |
| `sidecars` | 선택. `false`는 런타임이 [사이드카](sidecars.ko.md)를 실행할 수 없다는 뜻이며 브라우저 예제가 그렇다. 기본값은 `true`다 |
| `starter` | 선택. [첫 실행](installation.ko.md#첫-실행)이 설치하는 registry pack |
| `install` | 선택. host가 없는 빌드가 애플리케이션을 스테이징하기 전에 설정 폴더에 설치하는 registry pack. browser 예제(`make copy-frontend-browser`)는 자기 `registry`가 가리키는 registry에서 pack `starter`의 plugin을 설치한다 |
| `registry` | 선택. registry가 정해지지 않았을 때 첫 실행이 정하는 기본 registry index의 `https:` 또는 절대 `file:` URL([첫 실행](installation.ko.md#첫-실행)) |
| `sidebars.links` | 기본 사이드바 선택: 일반 변(left, right, top, bottom) 연결, 카드 네 변 연결, window-left/window-right/window-top/window-bottom 연결. 플러그인 변 형식, null 세트, 레일 연결은 거부한다. |

워크벤치는 설정을 적용하거나 스페이스를 만들기 전에 `environment.json`과 id 순서(추가 메뉴 순서)의 [설치된 플러그인](installation.ko.md#설치된-plugin-제공)을 그 manifest와 함께 등록한다. 표면이 없는 불러온 플러그인을 가리키는 탭이나 카드 변 연결, 불러온 플러그인이 선언하지 않은 섹션을 가리키는 세트, 불러오지 않은 플러그인을 가리키는 것은 [불러오지 않은 플러그인](#불러오지-않은-플러그인)을 따른다. 사이드카를 선언한 플러그인 표면은 그런 환경에도 나열할 수 있다. 호스트가 없으면 워크벤치가 그런 표면을 마운트하지 않기 때문이다([런타임 모듈](#런타임-모듈)). 저장된 스페이스는 환경 파일이 아니며 열 때 잘못되거나 오래된 창 사이드바 상태를 거부한다([프로젝트](projects.ko.md#저장)). 저장된 사이드바 세트와 연결은 설정이며 `environment.json`과 같은 사이드바 검사를 거친다. 불러온 플러그인이 선언하지 않은 섹션을 가리키는 저장된 세트나 표면이 없는 불러온 플러그인을 가리키는 카드 변 연결은 설정 불러오기를 오류로 실패시킨다([설정 탭](settings.ko.md#저장되는-세트와-연결)).

## 불러오지 않은 플러그인

창이 시작할 때 manifest를 불러온 플러그인을 불러온 플러그인이라 한다. 설치는 저장된 스페이스, 설정, 프로젝트 데이터가 아직 가리키는 플러그인을 제거하거나 끌 수 있으므로, 불러오지 않은 플러그인을 가리키는 것은 바꾸지 않고 유지하며 불러오기를 실패시키지 않는다.

- 그런 플러그인의 내용 탭은 placeholder 카드로 열린다. 카드는 플러그인 id와 이유에 따른 한 줄을 보여 주고, 탭은 저장된 스페이스에서 id, 제목, 저장된 상태를 유지한다. 탭을 닫으면 다른 탭처럼 지워진다. `core.surfaces`는 그 탭의 `placeholder`를 이유로 보고하고, 마운트된 표면은 `placeholder: null`을 보고한다. `missing`, `disabled`, `reload`, `refused`, `host` 이유는 저장된 배치가 유효하고 플러그인이 사용자의 선택이나 환경으로 없으므로 일반 placeholder 문구다. `refused`는 창이 설치된 버전을 불러오기를 거부한 플러그인이며, 플러그인 화면이 그것을 보고한다. `unread` 이유는 설치 상태를 읽지 못한 실패이고, `params` 이유는 저장된 탭의 params가 불러온 플러그인의 선언과 맞지 않는 실패다. `params` 줄은 플러그인, 버전, 불일치를 적는다. 이 줄들은 모두 오류이며, 오류 표시 경로로 `surface <tab id> placeholder`라는 place에 보이고, 상태를 다시 읽거나 params가 맞거나 탭이 사라지면 거둔다.

| 이유 | 줄 | 동작 |
| --- | --- | --- |
| `missing` | <plugin> 플러그인이 설치되어 있지 않습니다. | registry index가 플러그인을 나열하면 설치, `core.plugins.install {plugin}` |
| `disabled` | <plugin> 플러그인을 사용하지 않습니다. | 사용, `core.plugins.enable {plugin}` |
| `refused` | <plugin> 플러그인의 설치된 버전을 불러오지 못했습니다. | 없음. plugin 카드가 업데이트나 제거를 보여 주고, 시작 때 오류 표시가 거부를 보였다 |
| `reload` | 창을 다시 불러오면 <plugin> 플러그인이 열립니다. | 없음. plugin 카드의 적용이 창을 다시 불러온다([변경 적용](installation.ko.md#변경-적용)) |
| `host` | <plugin> 플러그인은 네이티브 호스트가 있어야 설치됩니다. | 없음. 애플리케이션에 host가 없다 |
| `unread` | <plugin> 플러그인의 설치 상태를 읽지 못했습니다. | 없음. plugin 상태를 읽지 못했다 |
| `requires` | <plugin> 플러그인에 필요한 <category> 플러그인이 없습니다. | 없음. 설정 탭이 그 category의 plugin을 설치하거나 켜며, 시작 때 오류 표시가 그 오류를 보였다 |

  이유는 `installed.json`이 플러그인을 끈 상태로 나열하면 `disabled`, 켠 상태로 나열하고 창이 그 entry나 manifest를 거부했으면 `refused`, `installed.json`이 플러그인을 켠 상태로 나열하는데 창의 불러오고 켜진 plugin 중 그 plugin이 요구하는 category의 plugin이 없으면 `requires`([plugin categories](#plugin-categories)), 그 밖에 켠 상태로 나열하면 `reload`, 나열하지 않으면 `missing`, host가 없으면 `host`, [plugin 상태](installation.ko.md#애플리케이션-안의-plugin-작업)를 읽지 못하면 `unread`다. 워크벤치는 첫 스페이스를 열기 전에 plugin 상태를 읽는다. 카드는 `plugins-changed` event마다 이유를 다시 정한다.
- 그런 플러그인을 가리키는 사이드바 연결은 유지하며 아무 내용도 고르지 않는다. 플러그인(첫 `.` 앞의 id)을 불러오지 않은 세트 섹션은 세트에 유지하되 보이지 않으며 어떤 layout도 그 surface를 쥐지 않는다. 세트 편집과 사이드바는 [없는 플러그인](#없는-플러그인)대로 보인다.
- 그런 플러그인의 `plugins.<plugin id>` 아래 프로젝트 데이터는 바꾸지 않고 유지한다.
- 그런 플러그인을 가리키는 `environment.json` 항목은 유지한다. 그 `settings`는 검사하지도 적용하지도 않고, 그 `workspace` 탭은 placeholder 카드로 열린다. 그래서 환경이 가리키는 플러그인을 끄거나 제거해도 애플리케이션은 시작한다.

다시 시작한 뒤 불러온 플러그인은 유지된 탭, 연결, 섹션, 데이터를 다시 쓴다.

## 없는 플러그인

플러그인을 불러오지 않은 섹션, 사이드바 연결, 탭은 그릴 수 없다. Workbench는 그 플러그인과 불러오는 방법을 밝히고, `불러오지 않음`이라는 말은 보이지 않는다. 그 말은 원인도 고치는 방법도 알려 주지 않기 때문이다. `<name>`은 registry의 catalog가 그 플러그인에 주는 이름이며, catalog에 없으면 id다.

- 세트 편집의 칩은 흐린 점선 테두리와 취소선을 긋은 이름을 보이고, 툴팁은 `<name>(<id>) 플러그인 필요`다.
- 세트 줄과 사이드바는 섹션 위에 그런 플러그인마다 경고 줄 하나를 보인다. 세트가 그 플러그인의 섹션을 몇 개 가지든 한 번이다. 플러그인이 설치되어 있지 않으면 `<name>(<id>) 플러그인이 없어 섹션 <n>개를 못 보여 준다.`와 `core.plugins.install {plugin}`을 실행하는 버튼 `<name> 설치`, 설치되었으나 꺼져 있으면 `<name>(<id>) 플러그인이 꺼져 있어 섹션 <n>개를 못 보여 준다.`와 `core.plugins.enable {plugin}`을 실행하는 버튼 `켜기`, 설치되었으나 거절되었거나 요구하는 플러그인을 기다리면 `<name>(<id>) 플러그인을 불러오지 못해 섹션 <n>개를 못 보여 준다.`와 `core.plugins.browse`를 실행하는 버튼 `설치됨 보기`다. catalog에 없는 플러그인에는 설치 버튼이 없다. 이 줄은 매개변수 `plugin`을 가진 element `core.sidebar.missing`이며 warning 톤이다.
- 사이드바는 그릴 수 있는 섹션만 그린다. 탭 배치에서는 없는 섹션의 탭이 세트 순서의 자리를 지키며, 흐리게 하고 섹션 id에 취소선을 긋는다.
- 플러그인이 불러와지면 다른 입력 없이 그 섹션이 그려지고 그 플러그인의 경고 줄이 사라진다.

## 스테이징 배치

`sok-copy-frontend <출력> [--diagnostics] [--no-main-page] [--installed <설정 디렉터리>]`는 애플리케이션 디렉터리에서 실행하고 Node 모듈 해석으로 패키지를 찾는다. `--no-main-page`가 없으면 main page를 stage하며 `environment.json`에 `runtime`이 없으면 실패한다. `--no-main-page`가 있으면 workbench를 직접 그리는 host를 위해 view root인 `/modules/<package>/`, `/environment.json`, `/core-root.json`, `/view-imports.json`만 stage하고, `environment.json`에 `runtime`이 있으면 실패한다. 이때 `--diagnostics`는 diagnostic view observer를 남기고 page 파일을 더하지 않는다. 스테이징된 `environment.json`은 debug와 release staging 모두에서 애플리케이션이 선언한 HTTPS registry를 유지하고, 원본 `environment.json`은 바뀌지 않는다. Window check는 자기가 쓰는 각 설정에 `sok registry use`로 fixture registry를 정한다([검증 경계](plugin-processes.ko.md#검증-경계)). 스테이징된 프런트엔드는 다음을 포함한다:

| 경로 | 원본 |
| --- | --- |
| `/` | `@soksak/workbench`의 `files` |
| `/modules/<패키지>/` | `soksak`, `@soksak/plugin-api`의 `files` |
| `/runtime/` | 애플리케이션의 `runtime` 디렉터리 |
| `/environment.json` | 애플리케이션의 `environment.json` |
| `/core-root.json` | view import map의 core target 목록. `@soksak/plugin-api`의 `viewCoreTargets`가 스테이징된 `soksak`과 `@soksak/plugin-api` 파일에서 계산하며, 호스트는 이것을 core target 목록으로 읽는다 ([core root](plugin-processes.ko.md)) |
| `/view-imports.json` | view import map의 JSON 텍스트. `@soksak/plugin-api`의 `VIEW_IMPORTS`이며, 각 호스트가 시작할 때 읽어 native view handler에 설정하고 handler가 각 view 페이지에 넣는다([plugin 처리](plugin-processes.ko.md), rule 4) |
| `/diagnostics.js` | `--diagnostics`이면 워크벤치의 `observe.js`(페이지 진단 메서드), 아니면 워크벤치의 빈 모듈 `release-diagnostics.js` |
| `/transcript.js` | `--diagnostics`이면 워크벤치의 `transcript.js`(진단 모듈이 쓰는 호출 기록기), 아니면 없음 |

애플리케이션의 bundle에는 플러그인이 없다. 호스트가 설정 디렉터리에 설치된 플러그인을 제공한다([설치된 plugin 제공](installation.ko.md#설치된-plugin-제공)). 호스트가 없는 애플리케이션인 브라우저 예제는 `--installed <설정 디렉터리>`를 주며, 그러면 도구가 그 디렉터리에서 호스트가 제공할 문서를 쓴다. `/installed-plugins.json`과 켜진 각 설치 플러그인의 파일을 `/modules/<패키지>/`에 쓰며, `diagnostics`는 `--diagnostics`일 때만 담는다.

게시된 파일이 import하는 모든 파일은 그 `package.json`의 `files` 배열에 나열되어야 하며, `packages/workbench/test/published-imports.test.mjs`가 이를 검증한다.

`@soksak/plugin-api` package는 설치된 consumer가 현재 공개 API contract를 읽을 수 있도록 `contract/` directory의 모든 파일을 게시한다. plugin 저장소는 자기가 pin한 SDK release로 test한다([plugin test](#plugin-test)).

`@soksak/plugin-api` package는 view 테스트 host도 게시한다. host fixture `host`를 받은 `@soksak/plugin-api/testing`의 `openView`는 view 페이지의 각 call을 `@soksak/plugin-api/view-answer`의 `answerViewCall`로, `@soksak/plugin-api/view-host`의 `createTestHost` 옵션과 함께 응답한다. 그 fixture `dependencies`는 plugin 의존을 `plugin.json`처럼 package별로 담고, 각 항목은 view call이 명명하는 `plugin` id를 준다. 이것이 없는 항목은 `dependency fixture <package> requires the plugin id of the package`로 거부된다. fixture가 없는 route는 실패한다. host는 `view host: <route> has no fixture`를 기록하고, 테스트가 view를 닫을 때 그것을 던진다. `testing.js`는 `jsdom`을 import하며, `jsdom`은 `@soksak/plugin-api`의 선택적 peer dependency다. consumer가 이를 설치하며, 없으면 import가 `jsdom`을 이름으로 밝히는 `ERR_MODULE_NOT_FOUND`로 실패한다.

디버그 스테이징 대상 `copy-frontend-wailsv3`, `copy-frontend-tauriv2`는 `--diagnostics`를 더한다. 릴리스 빌드에는 페이지 진단 코드가 없고, 릴리스 빌드는 plugin release가 담은 [진단 선언](#진단-선언)을 읽지 않는다. `make check-release`는 스테이징된 릴리스 프런트엔드에 `/transcript.js`나 페이지 진단 모듈이 있으면 실패한다.

`index.html`이나 `overlay.html`이 staged frontend에 없는 script, style, module import를 참조하면 staging은 실패하고 각 참조를 이름으로 밝힌다. 두 종류의 참조는 이 검사 밖이다. host가 요청마다 만드는 `STAGED.served`의 문서와, staging이 통째로 복사하고 그 module이 framework나 host가 제공하는 것을 import하는 runtime 디렉터리 안 module의 import다.

모든 workbench 페이지는 `PAGE_IMPORTS`와 같은 import map 하나를 선언한다. 항목은 `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/page`, `@soksak/plugin-api/screen-hash`(화면 메시지의 [화면 hash](replay.ko.md#화면-hash)), `@soksak/runtime`, `@soksak/shared/`, `@soksak/workbench/`다. view 페이지는 자기 import map을 갖지 않으며, 호스트가 `VIEW_IMPORTS`를 넣는다([plugin 처리](plugin-processes.ko.md), rule 4).

## 런타임 모듈

`runtime/index.js`는 다음을 내보낸다.

| 내보내는 값 | 의미 |
| --- | --- |
| `host` | 메인 페이지 호스트 인터페이스(`call`, `on`, `page`, `draggable`). 네이티브 호스트가 없으면 `null` |
| `page` | 표면·모달 페이지 인터페이스(`theme`, `sidecar`, `exposure`, `document`, `modal`). 네이티브 호스트가 없으면 `null` |
| `clock` | 페이지의 이벤트 배처가 읽는 페이지의 시계: `now()`는 밀리초 단위 읽은 값을 반환하고, `after(callback, ms)`는 그 시계로 `ms` 밀리초가 지나면 callback을 한 번 실행한다. 애플리케이션은 `@soksak/plugin-api/log-batch.js`의 `platformClock`을 내보내고, 테스트 런타임은 테스트가 순간을 주는 시계를 내보낸다 |
| `openStore()` | 작업 공간 저장소를 반환한다. 브라우저 애플리케이션은 IndexedDB를, 네이티브 애플리케이션은 `HostWorkspaceStore`를 사용한다 |
| `windows` | 창과 프로젝트 폴더 인터페이스. 네이티브 애플리케이션은 `@soksak/workbench/host-windows.js`의 `hostWindows(host)`를, 브라우저 애플리케이션은 자체 구현을 내보낸다 |

`runtime/start.js`는 window main page의 [시작 문서](native-host.ko.md#page-시작)를 default export로 내보낸다. main page만 이것을 가져온다.

`windows`의 멤버는 다음과 같다.

| 멤버 | 의미 |
| --- | --- |
| `createsFolders` | `chooseFolder`와 `createFolder`를 사용할 수 있으면 `true` |
| `newWindow()` | 새 창을 연다. 브라우저 애플리케이션은 탭을 연다 |
| `onActivate(fn)` | 호스트가 창에 프로젝트 표시를 요청하면 `fn`을 호출한다 |
| `onCloseRequest(fn)` | 호스트가 창에 닫기를 요청하면 `fn`을 호출한다 |
| `ready()` | 창이 요청을 받을 수 있음을 알린다 |
| `closeKept()` | 닫기 요청을 받은 뒤 page가 수정된 탭을 지켜 창이 열려 있음을 알린다. host가 그 요청이 속한 종료를 끝낸다 |
| `askRemoveProject(id)` | 프로젝트를 보이는 창에 프로젝트를 제거해도 되는지 묻고, 제거해도 되면 `true`로 이행한다. 다른 창이 보이지 않으면 바로 `true`로 이행한다 |
| `onRemoveProjectRequest(fn)` | 이 창이 보이는 프로젝트를 제거해도 되는지 다른 창이 물으면 `fn(id)`를 호출한다 |
| `answerRemoveProject(id, allowed)` | `onRemoveProjectRequest`의 제거 요청에 답한다 |
| `close()` | 창을 닫는다 |
| `state()` | 창 좌표를 반환한다. 런타임에 창 좌표가 없으면 `null` |
| `folder(root)` | 프로젝트 디렉터리의 `{ root, identity }`를 반환한다. 브라우저 애플리케이션은 앞뒤 공백을 제거한 경로와 식별자 `path:<공백 제거 경로>`를 반환한다 |
| `chooseFolder()` | 폴더 선택 대화상자를 표시한다. 브라우저 애플리케이션은 호출을 거부한다 |
| `createFolder({ parent, name })` | 프로젝트 폴더를 만든다. 브라우저 애플리케이션은 호출을 거부한다 |
| `openProject({ id, root, geometry, separate, current })` | 프로젝트 owner를 열거나 예약하고 `{ local, staged }`를 반환한다. `local`은 호출 창이 열기를 소유하면 `true`이고, `staged`는 그 owner가 `projectShown`으로 프로젝트를 확정할 때까지 `true`다. 브라우저 애플리케이션은 별도 창으로 여는 프로젝트를 새 탭에서 연다 |
| `projectShown(project)` | `{id, root, title}` 또는 `null`을 창이 표시하는 프로젝트로 확정한다. 페이지는 일치하는 준비된 project-data context를 설치한 뒤에만 호출한다. |
| `releaseProject(id)` | 호출한 창의 프로젝트 소유를 해제한다 |

워크벤치는 이 내보내는 값만 사용하고 런타임에 따라 분기하지 않는다. `host`가 `null`이면 사이드카를 선언한 플러그인의 표면은 실행할 수 없다. 그 사이드카, 네이티브 영역, 공개 전달에 호스트가 필요하기 때문이다. 워크벤치는 그 표면의 모듈을 가져오지 않으며, 표면 자리는 자리 표시 "<플러그인 이름> 표면은 네이티브 호스트가 있어야 열립니다"를 보이고, 표면은 `ready`를 보고하며 포커스를 받지 않고, 자리 표시는 탭과 함께 사라진다. 호스트가 없으면 `report`는 그 줄을 오류로 콘솔에 쓴다.

플러그인 페이지는 `@soksak/plugin-api/page`에서 다음을 가져오고 워크벤치 파일을 가져오지 않는다: `followTheme`, `page`, `expose`([공개 항목](exposure.ko.md)), `ownManifest()`(검사한 페이지의 `plugin.json`), `createSurfaceComposition(...)`([표면 합성](surface-composition.ko.md)). 내보낸 `page` 객체는 원시 문서·그림 attach/place 포트를 노출하지 않는다. 영역 손잡이는 검증된 합성에서만 얻는다. 플러그인 페이지는 자기 위치로 plugin을 찾는다: `soksak://<plugin id>` 페이지는 host가 이름 붙인 plugin에 속하며 자기 origin의 `/plugin.json`을 읽고, 메인 origin의 `/modules/<name>/` 아래 페이지는 그 module의 `plugin.json`을 읽으며, 다른 위치는 그 위치를 밝힌 오류로 거부한다. 페이지의 plugin id는 `soksak://` 페이지에서는 host이며 그 `plugin.json`의 `id`가 같아야 하고(`plugin.json id <id> differs from the page plugin <host>`), 메인 origin 페이지에서는 module 이름이 `package`인 `/installed-plugins.json` 항목의 `id`이다. 항목이 없는 module은 그 package 이름을 밝힌 오류이다.

surface 구성의 image region은 자체 배치를 갖지 않는다. 워크벤치는 `image.place` 호스트 호출을 더 이상 제공하지 않고, region에는 `visible`과 `_place` 멤버가 없다. 호스트는 image region을 그 surface의 구성(`composition.place`)으로 배치하므로, 요소의 크기 변화는 image 배치를 보내지 않는다.

## 테스트

### 브라우저 섹션

브라우저 페이지는 [문서 영역](native-surfaces.ko.md#문서-영역)의 세션 기록을 `browser.history` `{entries: [{url, title}], index}`로 보고하고, `browser.history.go {index}`는 그 위치의 항목을 연다. 히스토리 섹션은 따라가는 표면의 항목을 오래된 것부터 나열하고 현재 항목을 표시하며, 각 항목을 `browser.history.go`에 연결한다. 탭 섹션은 `core.grid`를 따라가 `context.surface`를 가진 카드에서 플러그인이 `browser`인 탭을 보이는 제목과 함께 나열하고, 활성 탭을 표시하며, 각 탭을 `core.tab.select`에 연결한다. 페이지는 영역 상태의 `elements`와 `requests`를 문서의 요소 `browser.elements`와 기록된 요청 `browser.requests`로 보고한다. DOM 섹션은 요소를 깊이만큼 들여 `tag#id.class`로 나열하고 목록이 잘렸으면 알린다. 네트워크 섹션은 각 요청의 형식, 주소, 걸린 시간을 나열하고 목록이 잘렸으면 알린다. 두 섹션은 섹션의 표면을 따라가며 조작 요소가 없다. 브라우저 페이지는 영역 상태마다 `tab.title`([탭 알림](#탭-알림))로 탭 제목을 문서 제목으로, 제목이 비어 있으면 주소로 정하며, 제어 문자를 지우고 256자로 자른다. 둘 다 없으면 제목을 없애 탭이 이름을 보인다. 탭 섹션은 같은 보이는 제목을 보인다.

### 브라우저 주소 입력

브라우저 주소 칸은 포커스를 얻을 때 선언된 `browser.address.select` 명령으로 전체 값을 선택한다. 첫 포인터를 뗄 때 선택을 유지하여 입력이 이전 주소를 대체하게 한다. 이미 포커스된 칸의 후속 클릭에서는 다시 전체 선택하지 않고 캐럿을 옮길 수 있다. 플러그인은 소유 Shadow Root로 포커스를 판단하고 dispose 시 모든 처리기를 해제한다. 칸에 입력한 글자는 칸이 포커스를 잃거나 선언된 이동 명령(`browser.navigate`, `browser.back`, `browser.forward`, `browser.reload`)이 실행될 때까지 유지되며, 문서 상태 갱신이 이를 바꾸지 않는다. 그 밖에는 Enter 뒤 포커스를 유지하는 동안에도 상태가 갱신될 때마다 칸이 `browser.location.url`을 보인다. 상태 `browser.address.text`는 칸이 보이는 글자와 포커스 여부 `{value, focused}`를 보고한다. 네이티브 키보드 검사는 대체할 주소를 바로 입력하며 누락된 동작을 보정하려고 텍스트를 직접 선택하지 않는다.

각 디렉터리는 `pnpm test`로 자기 테스트를 실행한다. 패키지는 fixture로 자기 경계를 검사하고 다른 패키지의 소스나 실제 이름을 읽지 않는다. 플러그인 API는 형식을, 워크벤치는 fixture 파일로 로드를, 각 플러그인은 자기 `plugin.json`과 페이지를, 각 애플리케이션은 실제 플러그인 의존성으로 `environment.json`이 해석되는지를 검사한다. 워크벤치는 각 플러그인의 `preview.ink`로 프로젝트 홈 미리보기 색을 정하고 플러그인별 CSS를 두지 않는다.

### 설정 선언

플러그인은 `plugin.json`의 `settings`에 타입이 있는 설정을 선언할 수 있다. 객체 키는 플러그인 내부 설정 이름이며 워크벤치는 이를 `<플러그인 id>.<키>`로 노출한다. 각 선언은 설정 탭의 한국어 행 이름인 1자에서 40자 사이의 `label`을 가지며, 행 아래에 보이는 1자에서 200자 사이의 `description`을 가질 수 있다. 이름과 값 이름만으로 값이 무엇을 하는지 알 수 없으면 설명이 필요하다. 각 선언은 또 열거형이면 `type`, `default`, `values`를, 범위가 있는 정수면 `type`, `default`, `minimum`, `maximum`을, 최대 `maxLength`자의 비어 있지 않은 문자열이면 `type`, `default`, `maxLength`를, 주소면 `type`과 `default`를 가진다. 주소는 빈 문자열이거나 최대 2048자의 `http` 또는 `https` 주소다. `type`이 `plugin`인 선언은 `type`, `category`, `label`, `description`을 가지며 `default`를 갖지 않는다([plugin categories](#plugin-categories)). 설정 탭은 문자열과 주소를 한 줄 글자 입력으로 보인다. 타입과 검증 규칙의 유일한 출처는 선언이며 모르는 설정 키와 잘못된 기본값은 manifest 검증을 실패시킨다.

애플리케이션은 `environment.json`의 `settings`에 플러그인 id와 내부 설정 이름별 초기값을 제공할 수 있다. 값은 선언된 설정을 가리키고 선언 규칙을 통과해야 한다. 우선순위는 플러그인 기본값, 애플리케이션 값, 저장된 공통값, 저장된 프로젝트 덮어쓰기 순서다. 저장값은 유효 설정이 되기 전에 선언 규칙으로 검증하며 잘못된 저장 데이터는 명시적인 로딩 오류이고 대체하지 않는다.

`node scripts/check-boundaries.mjs`는 소스 파일의 경계 규칙을 검사한다. 코어 패키지는 플러그인, 사이드카, 플러그인 id를 적지 않고, 플러그인과 사이드카는 자기 `package.json`의 dependency에 선언한 이름만 적는다. `apps/`, `e2e/`, 선언 파일(`package.json`, `plugin.json`, `sidecar.json`), `.md` 파일은 검사하지 않는다.
