# 플러그인과 애플리케이션 환경

[English](plugins.md)

독립 창 선언·배치·연결·레일 경계선 계약은 [외부 창 사이드바](external-sidebars.ko.md)에 정의한다. 카드 내부 변 계약은 독립적으로 유지한다.

워크벤치는 특정 플러그인을 참조하지 않는다. 각 애플리케이션은 `environment.json`에 플러그인과 기본값을 선언한다. 각 플러그인은 `plugin.json`에 자신을 선언한다. [`@soksak/plugin-api`](../../packages/plugin-api/index.js)가 두 형식, `sidecar.json` 형식, 스테이징 파일 배치, 페이지 import map을 정의한다. 워크벤치, 플러그인, 애플리케이션은 이 함수로 자기 파일을 검사한다.

## 작업 공간 구조

| 디렉터리 | 내용 |
| --- | --- |
| `packages/soksak` | 헤드리스 배치 라이브러리 |
| `packages/workbench` | 워크벤치 프런트엔드(코어): 프로젝트, 스페이스, 카드, 탭, 사이드바, 설정, 플러그인 로드, `soksak-stage` |
| `packages/plugin-api` | 선언 형식, 스테이징 배치, 페이지 import map, 플러그인 페이지 도구 |
| `packages/client` | 로컬 엔드포인트 클라이언트와 지연 시간 벤치마크 |
| `packages/host/<name>` | [네이티브 호스트](hosts.ko.md) 라이브러리(코어): Go의 `wailsv3`와 Rust의 `tauriv2` |
| `apps/<name>` | 애플리케이션 하나: `environment.json`, `runtime/`, 네이티브 진입점과 프레임워크 설정, 테스트 |
| `native/darwin` | 네이티브 호스트가 사용하는 macOS 공용 라이브러리 |
| `e2e` | 실행 중인 네이티브 애플리케이션의 창 검사 |

Plugin과 sidecar는 자기 repository에 있다([Repository](#repository)).

공통 기능은 워크벤치나 네이티브 호스트에 두어 플러그인이 다시 구현하지 않게 한다. 플러그인 기능은 워크벤치로 옮기지 않는다. 사이드카는 한 영역의 네이티브 기능을 담고 여러 플러그인에 제공할 수 있다. 메시지 전달 같은 일반 기능은 호스트에 둔다.

## Repository

Core, 각 plugin, 각 sidecar는 core checkout의 sibling 폴더에 있는 별도 git repository다. 각각 자기 test, 자기 `docs/features.md` checklist, 자기 build를 가지며, 어느 것도 다른 repository의 파일을 읽지 않는다.

| 폴더 | Repository | GitHub |
| --- | --- | --- |
| `core` | Layout library, workbench, plugin-api, client, command line, host, 애플리케이션, spec, window check | `soksak-app/core` |
| `../registry` | 공개 registry: 항목마다 파일 하나, 그 검사와 게시([공개 registry](registry.ko.md)) | `soksak-app/registry` |
| `../plugins/<id>` | Plugin 하나: `plugin.json`, page, `engines.soksak`을 가진 `package.json`, test. Plugin은 `browser`, `terminal`, `files`, `shell`이다 | `browser`, `terminal`, `files`는 `soksak-app/plugin-<id>`. `shell`은 게시하지 않는다 |
| `../sidecars/vt` | Terminal engine: crate `vt-core`, `vt-alacritty`, 그리고 `vt-alacritty`의 sidecar `@soksak/sidecar-vt-alacritty` | `soksak-app/sidecar-vt` |
| `../sidecars/files`, `../sidecars/shell` | Sidecar `@soksak/sidecar-files`, `@soksak/sidecar-shell` | `soksak-app/sidecar-files`. `shell`은 게시하지 않는다 |

Checkout은 repository를 이 sibling 폴더에 두고, repository 둘 이상이 필요한 workflow도 같은 방식으로 checkout한다. 그래서 `scripts/workspace-registry.json`의 상대 폴더가 어디서나 성립한다.

Plugin이나 sidecar의 version은 자기 것이며 core version과 관계가 없다. Plugin의 `engines.soksak` 범위가 그 plugin을 설치하는 core version을 정한다. Plugin repository는 test를 위해 `@soksak/plugin-api`에 git 의존을 둔다. 자기 `package.json`이 지정한 core release tag와 `path:/packages/plugin-api`를 쓴다. Test가 `validateSidecar`로 `sidecar.json`을 검사하는 sidecar repository도 같은 방식으로 의존한다. Plugin이나 sidecar repository의 release workflow는 자기가 릴리스하는 tag와 무관하게, workflow가 `CORE_RELEASE`에 선언한 core release에서 `sok`를 build한다. Plugin repository는 build를 위해 sidecar package에 의존하지 않고, `plugin.json`의 `dependencies`가 설치할 sidecar와 그 범위를 가리킨다. `make test`는 plugin repository의 test를 실행하고, `make pack OUT=<folder>`는 `sok plugin pack`으로 package를 쓴다. Sidecar repository에는 `make test`, `sidecar.json`이 가리키는 실행 파일을 쓰는 `make build`, 현재 platform으로 `sok sidecar release`를 실행하는 `make release OUT=<folder>`가 있다. Registry repository `../registry`는 제3자의 것을 포함해 새 plugin, sidecar, version을 항목 파일을 바꾸는 pull request로 받는다. 그 workflow가 pull request를 검사하고 merge한 뒤 index를 게시하며([공개 registry](registry.ko.md)), 그 `make build`는 `sok registry build`를 실행한다. `sok registry build`는 `index.json`을 쓰기 전에 모든 archive를 그 항목과 대조한다.

Core window check는 registry fixture에서 plugin을 설치한다. `scripts/workspace-registry.json`은 core checkout 기준 상대 폴더로 plugin repository, sidecar 폴더(`sidecar.json`을 가진 폴더), pack을 선언한다. `make registry`는 선언된 각 sidecar를 build하고 release하며, 선언된 각 plugin을 pack하고, `target/registry`에 index를 만든다. Network는 쓰지 않는다. `shell` plugin과 `@soksak/sidecar-shell`은 repository가 있지만 선언하지 않으므로, 두 애플리케이션의 새 space layout은 shell card 자리에 terminal card를 둔다.

## plugin.json

| 필드 | 필수 | 의미 |
| --- | --- | --- |
| `id` | 예 | 소문자 식별자. 탭과 설정이 참조한다 |
| `name` | 예 | 표시 이름 |
| `description` | 예 | 플러그인이 하는 일을 말하는 1자에서 200자 사이의 한두 문장. [plugin 화면](installation.ko.md#plugin-화면)이 보여 주고, plugin 화면과 설정 창이 검색한다 |
| `surface` | 아니오 | `{ "module": "ui/page.js", "composition": ... }`: 패키지 안의 모듈과 필수 [표면 합성](surface-composition.ko.md). 모듈은 앱 DOM에 마운트하며 외부 웹 문서는 문서 영역을 사용한다. 웹 주소는 표면이 아니다 |
| `mark` | `surface`가 있으면 | 추가 메뉴와 새 탭 제목에 표시하는 짧은 텍스트 |
| `icon` | `surface`가 있으면 | 16×16 뷰박스용 SVG 요소 |
| `sections` | 아니오 | 사이드바 섹션 `{ "id": "<플러그인 id>.<이름>", "name", "module" }`. `module`은 섹션을 그리는 패키지 안의 JavaScript 경로이고, 선택 항목 `fill: true`는 섹션에 남은 사이드바 높이를 준다([섹션](#섹션)) |
| `sidebars` | 아니오 | 로컬 기본 세트와 선택적인 네 변 `card` 연결([기본 사이드바 세트](#기본-사이드바-세트)) |
| `preview` | 아니오 | `{ "ink": "--<토큰>" }`: 라이브러리 미리보기에서 플러그인 카드의 색을 정하는 테마 토큰 이름. `surface`가 필요하다 |
| `dependencies` | 아니오 | `{ "<package>": "<version range>" }`: plugin이 필요로 하는 package와, plugin이 함께 동작하는 그 version의 범위([version과 범위](installation.ko.md#version과-범위)). sidecar package는 표면 페이지나 상태 모듈이 쓰는 [사이드카](sidecars.ko.md)를 가리키며 `surface`나 `state`가 필요하다. plugin package는 plugin이 기여하는 [확장 지점](#확장-지점)을 가진 plugin을 가리키며, plugin을 설치하면 그것도 설치된다. registry index나 `installed.json`의 plugin이 가진 package는 plugin package이고, 나머지는 sidecar package다. plugin이 다른 package에 요구하는 것의 유일한 선언이다 |
| `extends` | 아니오 | `{ "<point>": { "version": "x.y.z", "schema": <스키마>, "modules"?: { "<bare specifier>": "<경로>" } } }`: 다른 plugin이 기여하는 [확장 지점](#확장-지점). `surface`가 필요하다 |
| `contributes` | 아니오 | `{ "<plugin id>.<point>": [ { "range": "<version range>", "module": "<경로>", ... } ] }`: plugin이 다른 plugin의 확장 지점에 기여하는 항목 |
| `state` | 아니오 | `{ "module": "ui/state.js" }`: 표면 밖의 상태를 갖는 [플러그인 상태](#플러그인-상태) 모듈. `sections`가 필요하다 |
| `data` | 아니오 | `{ "<키>": { "schema": <스키마>, "default": <값>, "format"?: <양의 정수> } }`: 상태 모듈이 프로젝트마다 저장하는 [프로젝트 데이터](#프로젝트-데이터). `state`가 필요하다 |
| `background` | 아니오 | `{ "sidecar": "<선언한 사이드카>", "operation": "<동작 이름>", "settings"?: { "<요청 필드>": "<선언한 설정>" } }`: 활성화되지 않은 탭마다 네이티브 표면을 만들지 않고 선언한 사이드카 세션 하나를 유지한다. 워크벤치는 대응한 플러그인 설정의 현재 값을 요청 필드에 넣으며, `settings`는 `operation`이나 선언하지 않은 설정을 가리킬 수 없다. `surface`와 `dependencies`가 필요하다 |

플러그인은 `surface`, `sections`, `contributes` 중 하나 이상이 필요하다. 표면이 있는 플러그인만 추가 메뉴에 표시되고 레일을 갖는다. 워크벤치는 `modules/<패키지 이름>/<module>`을 import하고 `mount(root, context)`를 호출한다. 표면 식별자는 URL 쿼리가 아닌 명시적인 context 멤버다. 기존 `page` 선언은 거부하며 별도 구현 경로를 선택하지 않는다. 정의되지 않은 필드는 거부한다.

`surface.params`가 있으면 plugin의 탭 인자의 schema이며, `type`이 `object`인 exposure 선언 schema 부분집합이다. `core.card.add-tab {card, plugin, params}`는 `params`를 그것으로 검사하고 space layout에 탭과 함께 저장하며, 맞지 않으면 `params do not match <plugin> surface.params`로, `surface.params`가 없는 plugin이면 `plugin <plugin> declares no tab params`로 실패한다. surface context는 그것을 복사본 `tab.params`로 주고, 인자가 없는 탭이면 `null`이다. 저장된 탭의 인자가 불러온 plugin의 선언과 맞지 않으면 그 탭은 이유와 함께 `<plugin> <version> 탭의 인자가 선언과 맞지 않습니다`를 보이는 placeholder로 열리며, 인자는 변환하지 않는다.

`surface.drop`이 있으면 파일이 표면에 놓였을 때 페이지가 그 표면에서 실행할 `exposes`의 명령을 가리키며, `{urls}`에 놓인 파일 URL을 담는다([네이티브 표면](native-surfaces.ko.md#네이티브-뷰-위의-입력)).

`surface.composition`은 `{ "kind": "dom" }`이거나 `kind: "hybrid"`, 완전한 `regions`, 완전한 `overlays`를 가진 혼합 선언이다. 그림 영역은 `dependencies`에 이미 나열한 사이드카를 지정한다. manifest 선언은 호스트에 전달하는 권한 데이터다. 페이지 코드는 선언에 없는 영역, 공급자, 입력 소유자, 쌓임 항목을 추가할 수 없다.

## 기본 사이드바 세트

플러그인의 선택 필드 `sidebars`는 `sets`와 선택 필드 `card`, `window` 매핑을 포함한다. 각 세트는 로컬 소문자 식별자를 가진 `{id, title, sections, layout}`이며 `layout`은 `list` 또는 `tabs`다. 섹션 ID는 설치된 어느 플러그인도 참조할 수 있다. `card` 매핑은 표면이 있어야 하며 `top`, `bottom`, `left`, `right`를 로컬 세트 ID에 연결한다. 없는 변은 기본 연결을 선언하지 않는다. 알 수 없는 필드, 중복·예약 로컬 ID, 없는 세트와 설치되지 않은 섹션은 명시적으로 실패한다.

`window` 매핑은 `left`, `right` 로컬 세트 ID를 받고 표면을 요구하지 않는다. `card`와 독립적이며 잘못된 매핑과 없는 로컬 세트는 명시적으로 실패한다.

코어는 로컬 세트 ID를 `<plugin>.<local>`로, 카드 매핑을 `{place: "card-<side>", plugin, set}`으로, 창 매핑을 `{place: "window-<side>", plugin, set}`으로 정규화한다. 환경의 `sidebars`가 없으면 정규화한 기본값을 사용한다. 명시적 환경 `sidebars`는 `sets`와 `links`를 모두 제공하고 두 목록 전체를 교체한다. 저장된 공통·프로젝트 목록은 [설정](settings.ko.md#저장되는-세트와-연결)의 규칙으로 각 유효 목록을 덮어쓴다. 덮어쓰기가 제거한 기본값은 복원하지 않는다. 환경이 출력을 덮어써도 플러그인 선언은 검증한다.

창 연결은 등록된 플러그인을 요구하지만 표면은 요구하지 않고, 카드 연결은 표면을 요구한다. `left`나 `right` 연결은 일반 선택이며 `plugin: null`을 요구한다. 플러그인별 창 연결은 `window-left`나 `window-right`를 쓴다.

## 섹션

섹션의 `module`은 두 방향에 공통인 JavaScript 경로 하나 또는 `{horizontal, vertical}` 경로 객체다. 객체는 두 키를 모두 요구하며 그 외 키를 허용하지 않는다. 각 값은 패키지 내부의 상대 `.js` 경로이고 두 파일 모두 배포 목록에 있어야 한다. 한 방향을 다른 방향으로 대체하지 않는다. 카드 레이아웃은 상·하에 `horizontal`, 좌·우와 외부 창 사이드바에 `vertical`을 선택한다. 워크벤치는 선택한 구현의 `mount(root, context)`에 `context.orientation`을 전달하고 `core.sidebars`에 방향을 공개한다. 방향이 바뀌면 기존 구현을 해제하고 새 구현을 마운트하며 섹션 선택·접힘 상태는 유지한다. 가로 `list`는 섹션을 좌우로 배치하고 세로 `list`는 상하로 배치한다. 최종 공통 검사와 릴리스 적용은 미완료다.

섹션은 플러그인이 그리는 사이드바의 한 부분이다. 워크벤치는 섹션의 `module`을 불러 표면 페이지처럼 섹션 요소에서 `mount(root, context)`를 호출하고, 섹션이 사이드바를 떠나면 돌려받은 해제 함수를 호출한다. `context.card`는 사이드바가 속한 카드의 id이고 `context.surface`는 그 카드의 활성 탭이며, 좌측 사이드바에서는 둘 다 `null`이다. 섹션은 애플리케이션 문서 안에 그려지며 네이티브 표면을 갖지 않는다.

섹션은 플러그인이 선언한 status로 그 플러그인의 상태를 보이고, 플러그인이 선언한 명령으로 상태를 바꾼다. 섹션은 그 상태의 사본을 갖지 않는다. `context.status(name, fn)`은 섹션을 가진 플러그인의 status 하나를 따라가고, 따라가기를 멈추는 함수를 반환한다. `fn(value, source)`는 현재 값과 그 뒤의 모든 변경을 받는다. `source`는 그 status를 등록한 표면이고, 플러그인의 상태 모듈이 등록했으면 `"state"`다. 상태 모듈이 등록한 status는 어떤 표면보다 먼저 따라간다. 그렇지 않으면 섹션은 `context.surface`가 그 이름을 등록했으면 그 표면을, 아니면 `surface`가 없는 요청이 쓰는 표면([표면 선택](exposure.ko.md#표면-선택))을 따라가며, 그 이름을 등록한 표면이 없는 동안에는 `fn(null, null)`을 받는다. 등록이 바뀌면 표면을 다시 고른다. status 따라가기의 시작, 값 읽기, 멈춤이 실패하면 페이지 오류로 보고한다. `context.bind(element, name, params, options)`는 공통 binder로 요소를 섹션 플러그인의 명령에 연결하고 dom 이름 `core.sidebar.section.control`을 붙인다. 요소가 표면 페이지가 아니라 애플리케이션 문서에 속하기 때문이다. 명령은 상태 모듈이 등록했으면 상태 모듈에서, `context.surface`가 등록했으면 그 표면에서, 아니면 `surface`가 없는 요청이 쓰는 표면에서 실행된다. 섹션은 이름이 `core.`로 시작하는 코어 status를 따라가고 코어 명령을 연결할 수도 있다. 이때 `context.status`는 앱 문서의 등록을 따라가며 `source`는 `"core"`다. 앱 문서는 시작할 때 무엇을 기다리기 전에 코어 status와 명령을 등록하므로, 그것들은 첫 섹션이 마운트되기 전에 등록되어 있다. 라이브러리가 자기 shadow root 안에 그리는 조작(트리의 폴더 열기 등)은 라이브러리를 담은 요소를 거쳐 명령에 닿는다. 섹션은 그 요소를 사용자 정의 이벤트로 명령에 연결하고(`context.bind(holder, name, (event) => params, {event: "<type>"})`), 조작의 매개변수를 `detail`에 담아 이벤트를 보낸다. 섹션은 다른 플러그인의 이름을 쓰지 못한다. `core.sidebars`는 각 섹션이 그린 텍스트와 조작 요소의 수를 보고하므로, 검사는 섹션이 보이는 내용을 읽고 `core.sidebar.section.control` 요소 중 그 섹션의 조작 요소를 찾는다.

세트는 어느 플러그인의 섹션이든 순서대로 묶고, 세트를 만들 때 고른 `layout`을 가진다. `list`에서 사이드바는 세트의 모든 섹션을 세로 방향에서는 위에서 아래로, 가로 방향에서는 왼쪽에서 오른쪽으로 보이며, 각 섹션은 이름 머리 아래에 있고 머리로 접고 편다. `tabs`에서 사이드바는 섹션 이름의 탭 줄과 고른 탭의 섹션 하나만 보인다. 고른 탭과 접은 섹션은 사이드바마다 유지되고 스페이스와 함께 저장되므로([프로젝트](projects.ko.md#저장)) 다시 불러오기와 다시 시작 뒤에도 그대로 보인다. 카드 레이아웃은 변에 따라 섹션의 방향과 배치를 선택한다.

사이드바는 세트 제목이나 자리 이름을 보이지 않는다. 섹션은 사이드바 맨 위에서 시작한다. 창 사이드바는 자리를 말하고 끝에 접기 컨트롤(`core.sidebar.fold`)을 둔 상태 줄로 끝난다. 접기 컨트롤은 `core.settings.set`(`left`나 `right`를 false로)으로 사이드바를 끄고, 창 머리의 컨트롤이 다시 켠다. 카드 안 사이드바는 자기 면과 세트를 말하는 상태 줄로 끝난다([카드 배치](example-model.ko.md)). 접은 섹션은 머리만 남는다. 섹션은 내용의 높이를 가지며, `fill: true`로 선언한 펼친 섹션만 다른 섹션이 쓰고 남은 사이드바 높이를 나눠 갖고 그 안에서 내용을 스크롤한다. 접힌 fill 섹션은 그 자리를 다른 fill 섹션에 준다. 높이를 선언으로 정하는 이유는, 파일 트리 같은 가상 목록은 워크벤치가 자리가 필요함을 알 내용 높이가 없고, 짧은 목록을 늘리면 빈 공간이 보이기 때문이다. 섹션 머리는 카드 머리의 높이, 상태 줄은 카드 발의 높이를 가져 선이 이웃 카드의 선과 한 줄에 놓인다. 섹션은 빈 목록을 기록 없음 같은 말로 알린다.

사이드바는 그것을 담은 카드의 id로 식별한다. `left`, `right`, 또는 카드 내부 사이드바의 `카드id:변`(`top`, `bottom`, `left`, `right`)이다. 섹션 머리를 접고 펴면 `core.sidebar.section.fold`를, 탭을 고르면 `core.sidebar.section.select`를 `{sidebar, section}`으로 실행한다. status `core.sidebars`는 그려진 모든 사이드바의 세트, 레이아웃, 고른 탭, 각 섹션의 접힘과 마운트 상태를 알린다. 섹션 모듈은 패키지의 `files`에 나열한 파일이므로 plugin package가 담는다. 섹션 모듈이 나열되어 있지 않으면 `sok plugin pack`이 실패한다.

세로 목록의 펼친 fill 섹션은 머리와 본문의 고유 최소 높이를 유지한다. 사이드바가 더 작으면 세트 전체를 스크롤하며 섹션을 높이 0으로 줄이지 않는다. 플러그인이 가상 목록을 사용하면 플러그인이 최소 가시 행 높이를 선언한다. 파일 트리는 28포인트 도구 줄과 최소 한 행 20포인트를 확보한다. 이 동작은 카드 콘텐츠의 잔여 높이를 늘리거나 저장한 사이드바 크기를 바꾸지 않는다.

## 플러그인 상태

표면이 없는 플러그인이나 한 탭이 소유하지 않는 상태를 가진 플러그인은 `state` 모듈을 선언한다. 창이 프로젝트를 보이는 동안 워크벤치는 모듈을 한 번 불러와 `mount(context)`를 호출하고, 창이 다른 프로젝트나 라이브러리를 보이면 먼저 돌려받은 `dispose`를 호출한다. 문맥은 다음을 갖는다.

- `project`: `{id, root}`, 보이는 프로젝트와 그 정규 디렉터리([프로젝트](projects.ko.md)).
- `exposure.status(name, read, subscribe)`와 `exposure.command(name, run)`: 플러그인이 선언한 status와 명령을 애플리케이션 문서의 등록소에 등록한다. `subscribe(fn)`은 여러 번 호출될 수 있고 그 구독을 멈추는 함수를 반환한다. 이 항목은 `surface`가 없는 요청에 같은 이름의 어떤 표면 등록보다 먼저 답하고([표면 선택](exposure.ko.md#표면-선택)), dispose가 제거한다.
- `sidecar`: 플러그인이 선언한 유일한 사이드카의 `{send(body), on(fn), onFailure(fn)}`. `onFailure`는 세션의 각 [사이드카 실패](sidecars.ko.md#실패) 이유를 받는다. 세션 식별자는 `state:<플러그인 id>:<프로젝트 id>`이므로 호스트는 사이드카에 프로젝트 디렉터리를 `root`로 준다([사이드카](sidecars.ko.md#메시지)).
- `data.get(key)`와 `data.set(key, value)`: 플러그인의 [프로젝트 데이터](#프로젝트-데이터).

상태 모듈은 패키지 `files`에 나열한 파일이며, 나열하지 않으면 `sok plugin pack`이 실패한다. 마운트나 해제의 실패는 페이지 오류로 보고한다.

## 프로젝트 데이터

`data`는 상태 모듈이 프로젝트마다 저장하는 키를 선언한다. `schema`는 공개 선언의 스키마 부분 집합(`type`, `enum`, `properties`, `items`)을 쓰고 `default`는 그 스키마에 맞아야 한다. 선택 항목 `format`은 양의 정수이며 없으면 1이다. 플러그인은 키의 저장 형태를 바꿀 때 이 값을 올린다. 워크벤치는 각 값을 `projects.json`에서 그 프로젝트의 `plugins.<플러그인 id>.<키>` 항목에 `{ "format": <format>, "value": <value> }`로 저장한다([저장](projects.ko.md#저장)). `data.get`은 저장된 값이나 기본값을 반환하고, 저장된 값이 스키마에 맞지 않으면 실패한다. `data.set`은 값이 맞지 않거나 선언하지 않은 키이면 쓰지 않고 실패하며, 선언한 format으로 저장하고, 저장소가 쓰기를 받아들인 뒤 끝난다.

저장된 항목은 정확히 양의 정수 `format`과 `value`만 가진 객체일 때 현재 형태다. 워크벤치는 프로젝트의 상태 모듈을 마운트하기 전에, 이전 형태나 format으로 저장된 선언 키를 한 번 변환한다. format 없이 저장된 값, 즉 format이 생기기 전의 형태는 format 1이다. 선언보다 낮은 format의 값은 상태 모듈의 `convertData({ key, format, value })` export에 넘기고, 이 함수는 선언한 format의 값을 돌려준다. 워크벤치는 값을 스키마로 검사하고 선언한 format으로 저장한 뒤, 프로젝트, 플러그인, 키, 두 format을 적은 줄을 애플리케이션 log에 쓴다. 선언보다 높은 format으로 저장된 값, 없는 `convertData` export, 실패한 변환, 스키마에 맞지 않는 값은 바꾸지 않고 두며, 그 키의 `data.get`은 프로젝트, 플러그인, 키, format이나 스키마 불일치를 적은 message로 실패한다.

## 확장 지점

plugin은 다른 plugin이 선언한 확장 지점으로 그 plugin을 확장한다. 제공자는 `extends`에 지점을 선언하고, 기여자는 `contributes`에 항목을 선언하며, workbench는 이 선언만으로 둘을 잇는다. 어떤 plugin도 코드에서 다른 plugin의 이름을 쓰지 않는다.

- **이름과 version.** plugin `<id>`의 지점 `<name>`은 `<id>.<name>`이다. `version`은 지점 interface의 version이고, 기여한 각 항목은 `range`로 함께 동작하는 version을 적는다. 이전 version에 맞춰 쓴 항목이 실패할 수 있으면 제공자는 `version`의 major를 올리고, interface에 더하면 minor를 올린다.
- **항목.** 각 항목은 `range`, 기여자 package 안의 JavaScript 경로 `module`, 그리고 지점의 `schema`가 exposure 선언의 schema 부분집합으로 선언한 필드를 갖는다. workbench는 모든 항목을 schema로 검증한다.
- **공유 module.** `modules`는 bare import specifier를 제공자 package의 파일에 대응한다. page import map은 `@soksak/shared/`를 `/shared/`에 대응하고, `/shared/<plugin id>.<point>/<specifier>`는 그 specifier의 제공자 파일을 내보낸다([설치된 plugin 제공](installation.ko.md#설치된-plugin-제공)). 제공자와 기여자는 공유 library를 `@soksak/shared/<plugin id>.<point>/<specifier>`로 import하므로 한 URL에서 불러와 instance 하나를 함께 쓴다. 각자 그 library를 그 external import로 번들한다.
- **연결.** page를 불러올 때 workbench는 설치되고 켜진 plugin의 기여를 해석한다. 항목은 제공자가 설치되고 켜져 있고 그 `range`가 지점의 `version`을 포함하면 `connected`, 제공자가 설치되지 않았거나 켜져 있지 않으면 `provider-missing`, 범위가 version을 포함하지 않으면 `version-mismatch`, 항목이 schema와 맞지 않거나 그 module을 불러오거나 확장하다 실패하면 `invalid`다. status `core.contributions`가 모든 항목을 `{plugin, point, state, reason}`으로 보고한다. `connected`가 아닌 상태는 애플리케이션의 오류가 아니며, `invalid`는 오류 표시로 보인다.
- **설치.** `dependencies`에 제공자의 plugin package를 적은 기여자는 제공자와 함께 설치된다. 그 의존이 없는 기여자는 제공자가 설치되어 있을 때만 연결된다. 기여자나 제공자를 설치, 켜기, 끄기, 제거하면 다른 plugin 변경과 같이 그 뒤에 불러오는 page에 적용된다([설치](installation.ko.md)).
- **제공자 interface.** 제공자 page의 surface context는 `contributions(point)`를 가지며, 그 지점의 연결된 항목을 `{plugin, item, module}`로 돌려준다. `module`은 import할 URL이다. 제공자는 각 module을 import하고 지점 interface가 정한 export를 호출한다. 실패한 export는 그 항목을 `invalid`로 만들고 다른 항목은 연결된 채로 둔다.
- **권한.** 기여 module은 제공자 page 안에서 그 page의 권한으로 실행된다. 기여자를 설치하면 그 기여자는 제공자의 문서와 입력처럼 제공자 page가 받는 것을 받는다.

## 외부 라이브러리

스테이징은 패키지 `files`를 복사하고 페이지 import map은 코어 모듈과 `@soksak/shared/`만 가리키므로, 플러그인 페이지, 섹션, 상태 모듈은 자기 패키지 안의 파일과 [확장 지점](#확장-지점)의 공유 module만 불러오고, 제공자 페이지는 자기 지점의 기여 module도 불러온다. 외부 브라우저 라이브러리를 쓰는 플러그인은 자기 `scripts/build-vendor.mjs`(esbuild)로 라이브러리를 `ui/vendor/` 아래 ES 모듈 하나로 번들하고, 번들에 든 모든 패키지의 라이선스와 고지를 담은 `.LICENSE.txt` 파일과 함께 커밋하며, `ui`를 통해 `files`에 나열한다. 라이브러리와 esbuild는 정확한 버전의 `devDependencies`다. 플러그인의 `pnpm test`는 스크립트를 `--check`로 실행하며, 커밋된 파일이 새 빌드와 다르면 실패한다. 파일 플러그인은 바닐라 진입점 `@pierre/trees`로 `@pierre/trees` 1.0.0-beta.4(Apache-2.0)와 그 의존성 `preact`(MIT)를 번들한다. 플러그인은 React를 쓰지 않는다.

## 진단 선언

표면이 있는 플러그인은 검사에만 쓰는 status와 명령 항목을 패키지 루트의 `diagnostics.json` 파일에 둘 수 있다: `{ "module": "ui/<파일>.js", "exposes": { ... } }`. `module`은 패키지 안의 파일이며, `exposes`는 `plugin.json` `exposes`의 형식과 소유자 규칙을 따른다. 한 이름은 `plugin.json`과 `diagnostics.json` 중 한 곳에만 선언한다. `diagnostics.json`과 그 모듈은 패키지의 `files`에 나열하지 않으므로, plugin package는 `sok plugin pack --diagnostics`가 쓸 때만 이를 담는다([command line](cli.ko.md#package-release-registry)). 둘 중 하나가 나열되어 있으면 스테이징과 pack이 실패한다. 사용자 입력이나 OS가 만드는 상태를 주입하거나 검사를 위해 내부 이벤트를 기록하는 항목은 `diagnostics.json`에 속하고, 보이는 상태를 보고하거나 사용자 조작을 수행하는 항목은 `plugin.json`에 속한다.

진단 빌드에서 워크벤치는 이 선언을 플러그인의 표면 선언에 더하고, 표면을 마운트하기 전에 모듈을 import한다. 표면 context는 그 모듈을 `diagnostics`로 전달하며, 릴리스 빌드에서 `diagnostics`는 `null`이다. 표면 모듈은 이를 구현에 넘기고, 구현은 진단 항목이 쓰는 내부 연산을 모듈에 넘겨 호출한다.

## 표면 모듈 소유권

OS 창마다 앱 DOM WebView가 하나 있다. 워크벤치는 표면 요소와 Shadow Root를 소유하며 플러그인은 그 루트 안에 마운트한 DOM을 소유한다. Shadow DOM은 스타일을 분리하며 보안 권한을 분리하지 않는다. context는 표면 범위의 명령, 상태, DOM 바인딩, 사이드카 메시지와 [사이드카 실패](sidecars.ko.md#실패), 선언된 합성 컨트롤러를 제공한다. 호스트는 창, 표면, 선언을 다시 검증한다. context로 보낸 사이드카 메시지는 보낸 순서대로 사이드카에 도착한다. 워크벤치는 같은 사이드카로의 앞선 전송이 끝난 뒤 다음 전송을 시작하며, 그 사이드카의 모든 표면과 백그라운드 세션이 한 순서를 공유한다. context의 표면이 아닌 표면으로 보내는 전송은 거부된다. 플러그인은 내부 WebView나 iframe을 만들지 않는다.

`mount(root, context)`는 비동기일 수 있고 `{ dispose() }`를 반환한다. 영역을 부착하는 마운트 작업 전에 네이티브 표면 등록이 끝나야 한다. 마운트 실패는 보이는 오류이며 빈 표면의 성공으로 처리하지 않는다. 네이티브 준비 완료는 모듈 import 완료가 아닌 첫 영역의 실제 표시를 요구한다. 워크벤치는 로딩, 준비 완료, 오류를 구분한다.

탭 숨김이나 라이브러리 이동은 모듈을 폐기하거나 세션을 닫지 않고 DOM과 네이티브 영역을 숨긴다. 명시적 제거는 모듈을 폐기하고 바인딩, 이벤트 구독, 영역을 해제하며 해제 실패를 보고한다. 워크벤치는 모듈이 준비되고 배치가 표시된 뒤 표면에 포커스를 준다. 그 포커스가 기다리는 동안 표면의 제거가 시작되면 모듈의 `focus`를 부르지 않는다. 해제된 모듈의 뗀 영역은 포커스를 거부하기 때문이다. 워크벤치는 모듈의 `dispose`를 호출하기 전에 모듈이 만든 composition의 영역을 뗀다. 모듈은 `dispose`에서 사이드카 세션을 끝내고 공급자는 세션이 끝날 때 전송 그림을 놓으므로, 공급자가 그 전에 보낸 프레임은 아직 붙은 영역에서 `notFound`로 실패하지 않고 뗀 영역의 프레임으로 `stale` 답을 받는다([그림 영역](native-surfaces.ko.md#그림-영역)). 모든 동작은 공통 binder와 [노출](exposure.ko.md) 계약을 따른다. 메뉴와 설정은 같은 앱 WebView의 DOM 오버레이이며 네이티브 영역 위의 입력 소유권을 선언한다.

`background` 선언은 두 번째 페이지나 숨은 WebView가 아니라 세션 수명을 명시하는 계약이다. 워크벤치는 선언된 `operation`을 선언된 사이드카에 사이드카 메시지 프로토콜로 보낸다. manifest에서는 읽기 쉬운 전체 필드명 `operation`을 사용한다. 워크벤치는 요청을 임의로 만들거나 누락된 동작을 대체하거나 오류를 숨기지 않는다. 탭이 보이게 되면 그 표면이 같은 동작과 이미지 영역을 보내 기존 세션에 다시 연결한다. 탭을 제거하면 background 세션도 제거한다.

## 탭 알림

표면 컨텍스트에는 `tab.title(text)`, `tab.footer(text)`, `tab.directory(path)`, `tab.notify(text, policy)`, 고정된 `origin` 객체, 고정된 `project` 객체가 있다.

`tab.title(text)`는 표면의 탭이 이름 대신 보일 제목을 정하고, `tab.title(null)`은 그 제목을 지워 탭이 다시 이름을 보이게 한다. 텍스트는 제어 문자(U+0000–U+001F, U+007F–U+009F)가 없는 1–256자의 문자열이며, 다른 값은 예외를 던진다. 제목은 레이아웃과 함께 저장하지 않는다. `core.grid`는 각 탭이 보이는 제목을 `label`로, 없으면 `null`로 알린다.

`tab.footer(text)`는 표면이 카드의 활성 탭인 동안 그 카드의 내용 발이 보일 글을 정한다. 터미널의 작업 디렉터리나 브라우저 문서에서 포인터 아래 링크의 주소가 그 예다. `tab.footer(null)`은 그 글을 지운다. 텍스트는 제어 문자가 없는 1–1024자의 문자열이며, 다른 값은 예외를 던진다. 하단 글은 레이아웃과 함께 저장하지 않는다. `core.grid`는 각 탭의 하단 글을 `footer`로, 없으면 `null`로, 각 카드가 보이는 발을 `status`로 알린다.

`tab.notify(text, policy)`는 탭이 포커스된 카드의 활성 탭이 아닐 때 그 탭에 알림을 둔다. `policy`는 `tab`이나 `system`이고 생략하면 `tab`이다. 터미널 플러그인은 `terminal.notifications` 설정값을 전달한다. 그 탭이면 표면이 보이고 있으므로 아무것도 바꾸지 않는다. 텍스트는 제목 규칙을 따르되 최대 1024자이며, 다른 값은 예외를 던진다. `tab`은 `core.grid`에 점과 도움말을 보이고, `system`은 호스트 알림 센터에만 보내며 grid의 `notice`는 `null`이다. 알림은 탭이 포커스된 카드의 활성 탭이 되거나 닫히면 지워지고, 나중 알림이 앞의 알림을 바꾼다. 워크벤치는 알림을 저장하지 않는다.

`system` 정책은 시스템 알림이다. 창의 호스트는 운영체제의 알림 센터로 탭의 이름을 제목, 알림 텍스트를 본문으로 하여 알림을 게시하며, 애플리케이션이 활성일 때도 게시한다. 호스트가 알림 센터를 시작할 수 없으면 네이티브 오류를 보고하고 탭 알림으로 조용히 바꾸거나 버리지 않는다. 탭의 나중 알림은 그 탭의 시스템 알림을 바꾸고, 알림이 지워지면 시스템 알림도 지워진다. 시스템 알림을 누르면 그 창이 키 창이 되고 그 탭에 `core.tab.select`를 실행한다. `core.notifications`는 `{authorization, error, posted}`를 알린다. `authorization`은 `notDetermined`, `denied`, `authorized`, `provisional` 중 하나이고, `error`는 권한 요청, 게시, 제거의 마지막 실패 또는 `null`이며, `posted`는 알림 센터가 알림을 받아들인 뒤 지워지지 않은 이 창의 탭을 순서대로 나열한다. 권한이 거부된 동안 알림이 있는 탭과 그 카드의 탭 목록 버튼의 도움말은 `System notifications are turned off for this application.` 줄로 끝난다.

`tab.directory(path)`는 표면의 작업 디렉터리인 절대 경로를 기록하고, `tab.directory(null)`은 그것을 지운다. 다른 값은 예외를 던진다. 워크벤치는 이를 위해 파일 시스템을 읽지 않고 저장하지 않는다. `+`나 쪼개기가 탭을 만들면, 새 표면의 `origin.directory`는 탭을 더하거나 쪼갠 카드의 활성 탭이 그 순간 기록한 디렉터리이고, 없으면 `null`이다.

`project`는 표면이 마운트될 때 표면의 창이 보이는 프로젝트의 정규 `root`를 담은 `{root}`이고([프로젝트](projects.ko.md#프로젝트-식별)), 프로젝트가 없는 창에서는 `null`이다. 작업 디렉터리에서 시작하는 표면은 `origin.directory`가 `null`이 아니면 그것을, 아니면 `project.root`를, 그것도 없으면 계정의 홈 디렉터리를 쓴다.

## 링크 열기

표면 컨텍스트에는 `runtime.links.open(url)`이 있으며, 호스트에 절대 `http`, `https`, `mailto` URL을 그 스킴의 사용자 기본 애플리케이션으로 열도록 요청한다. 호스트는 다른 스킴, 해석되지 않는 URL, 8192자보다 긴 URL을 거부하고, 반환한 promise는 그 이유로 거부된다. macOS 호스트는 `NSWorkspace`로 URL을 연다. Windows 플랫폼은 `not implemented on windows`를 반환한다.

## 아이콘

표면 컨텍스트와 섹션 컨텍스트에는 `icon(name)`이 있으며, 코어 아이콘 `name`을 24 단위 `viewBox`, 획 경로만, `aria-hidden`을 가진 SVG 마크업으로 반환한다. 없는 이름은 예외를 던진다. 코어는 아이콘을 `packages/workbench/icons.js`에 두고, 플러그인은 워크벤치를 가져올 수 없으므로 플러그인 페이지는 자체 그림 대신 컨텍스트로 아이콘을 그린다. 마크업에는 스타일이 없고, 페이지가 자기 Shadow Root에서 크기, 색, 획을 정한다. 이름은 `star`, `projects`, `panel-left`, `panel-right`, `sun`, `moon`, `settings`, `close`와 Lucide 아이콘 `chevron-left`, `chevron-right`, `rotate-cw`다.

브라우저의 뒤로, 앞으로, 새로 고침 단추는 `chevron-left`, `chevron-right`, `rotate-cw`를 카드 머리 단추의 모양으로 그린다. 단추는 20×20, 아이콘은 14px, 색은 `--muted`이고, 포인터 아래에서는 배경이 `--inset`, 색이 `--fg`가 된다. 획 폭 1.95 단위는 16 단위 `viewBox`에서 획 1.3 단위인 머리 단추와 같은 굵기로 아이콘을 그린다.

## environment.json

| 필드 | 의미 |
| --- | --- |
| `runtime` | 런타임 모듈 `index.js`를 포함한 애플리케이션 안의 디렉터리 |
| `workspace.grid` | 새 스페이스의 격자선과 카드. `tabs`가 있는 카드는 `{ plugin, title }` 항목을 나열한다. 선택 필드인 card `width`는 point 단위의 유한한 양수이며, 왼쪽·오른쪽 고정 sidebar card는 그 너비로 시작하고 생략하면 `sidebarWidth`를 쓴다 |
| `workspace.focus` | 새 스페이스에서 포커스할 카드. 탭이 있어야 한다 |
| `sidebars.sets` | 플러그인 기본값의 선택적 명시적 덮어쓰기: 섹션 세트 `{id, title, sections, layout}`. `layout`은 `list` 또는 `tabs`다 |
| `sidecars` | 선택. `false`는 런타임이 [사이드카](sidecars.ko.md)를 실행할 수 없다는 뜻이며 브라우저 예제가 그렇다. 이런 환경에서 설치된 플러그인의 상태 모듈이 사이드카를 쓰면 로드가 실패한다. 기본값은 `true`다 |
| `starter` | 선택. [첫 실행](installation.ko.md#첫-실행)이 설치하는 registry pack |
| `registry` | 선택. registry가 정해지지 않았을 때 첫 실행이 정하는 기본 registry index의 `https:` 또는 절대 `file:` URL([첫 실행](installation.ko.md#첫-실행)) |
| `sidebars.links` | 기본 사이드바 선택: 일반 left/right 연결, 카드 네 변 연결, window-left/window-right 연결. 플러그인 left/right 형식, null 세트, 레일 연결은 거부한다. |

워크벤치는 설정을 적용하거나 스페이스를 만들기 전에 `environment.json`과 id 순서(추가 메뉴 순서)의 [설치된 플러그인](installation.ko.md#설치된-plugin-제공)을 그 manifest와 함께 등록한다. 표면이 없는 불러온 플러그인을 가리키는 탭이나 카드 변 연결, 불러온 플러그인이 선언하지 않은 섹션을 가리키는 세트, `sidecars: false` 환경에서 상태 모듈이 사이드카를 쓰는 플러그인이 있으면 등록 전에 로드가 실패한다. 불러오지 않은 플러그인을 가리키는 것은 [불러오지 않은 플러그인](#불러오지-않은-플러그인)을 따른다. 사이드카를 선언한 플러그인 표면은 그런 환경에도 나열할 수 있다. 호스트가 없으면 워크벤치가 그런 표면을 마운트하지 않기 때문이다([런타임 모듈](#런타임-모듈)). 저장된 스페이스는 환경 파일이 아니며 열 때 잘못되거나 오래된 창 사이드바 상태를 거부한다([프로젝트](projects.ko.md#저장)). 저장된 사이드바 세트와 연결은 설정이며 `environment.json`과 같은 사이드바 검사를 거친다. 불러온 플러그인이 선언하지 않은 섹션을 가리키는 저장된 세트나 표면이 없는 불러온 플러그인을 가리키는 카드 변 연결은 설정 불러오기를 오류로 실패시킨다([설정 창](settings.ko.md#저장되는-세트와-연결)).

## 불러오지 않은 플러그인

창이 시작할 때 manifest를 불러온 플러그인을 불러온 플러그인이라 한다. 설치는 저장된 스페이스, 설정, 프로젝트 데이터가 아직 가리키는 플러그인을 제거하거나 끌 수 있으므로, 불러오지 않은 플러그인을 가리키는 것은 바꾸지 않고 유지하며 불러오기를 실패시키지 않는다.

- 그런 플러그인의 내용 탭은 placeholder 카드로 열린다. 카드는 플러그인 id와 이유에 따른 한 줄을 보여 주고, 탭은 저장된 스페이스에서 id, 제목, 저장된 상태를 유지한다. 탭을 닫으면 다른 탭처럼 지워진다. `core.surfaces`는 그 탭의 `placeholder`를 이유로 보고하고, 마운트된 표면은 `placeholder: null`을 보고한다.

| 이유 | 줄 | 동작 |
| --- | --- | --- |
| `missing` | <plugin> 플러그인이 설치되어 있지 않습니다. | registry index가 플러그인을 나열하면 설치, `core.plugins.install {plugin}` |
| `disabled` | <plugin> 플러그인을 사용하지 않습니다. | 사용, `core.plugins.enable {plugin}` |
| `restart` | 애플리케이션을 다시 시작하면 <plugin> 플러그인이 열립니다. | 없음 |
| `host` | <plugin> 플러그인은 네이티브 호스트가 있어야 설치됩니다. | 없음. 애플리케이션에 host가 없다 |
| `unread` | <plugin> 플러그인의 설치 상태를 읽지 못했습니다. | 없음. plugin 상태를 읽지 못했다 |

  이유는 `installed.json`이 플러그인을 끈 상태로 나열하면 `disabled`, 켠 상태로 나열하면 `restart`, 나열하지 않으면 `missing`, host가 없으면 `host`, [plugin 상태](installation.ko.md#애플리케이션-안의-plugin-작업)를 읽지 못하면 `unread`다. 워크벤치는 첫 스페이스를 열기 전에 plugin 상태를 읽는다. 카드는 `plugins-changed` event마다 이유를 다시 정한다.
- 그런 플러그인을 가리키는 사이드바 연결은 유지하며 아무 내용도 고르지 않는다. 플러그인(첫 `.` 앞의 id)을 불러오지 않은 세트 섹션은 세트에 유지하되 보이지 않는다. 세트 편집은 그 행을 "<section id> (불러오지 않음)"과 ▲, ▼, −로 보여 준다.
- 그런 플러그인의 `plugins.<plugin id>` 아래 프로젝트 데이터는 바꾸지 않고 유지한다.
- 그런 플러그인을 가리키는 `environment.json` 항목은 유지한다. 그 `settings`는 검사하지도 적용하지도 않고, 그 `workspace` 탭은 placeholder 카드로 열린다. 그래서 환경이 가리키는 플러그인을 끄거나 제거해도 애플리케이션은 시작한다.

다시 시작한 뒤 불러온 플러그인은 유지된 탭, 연결, 섹션, 데이터를 다시 쓴다.

## 스테이징 배치

`soksak-stage <출력> [--diagnostics] [--installed <설정 디렉터리>]`는 애플리케이션 디렉터리에서 실행하고 Node 모듈 해석으로 패키지를 찾는다. 파일 내용을 바꾸지 않고 복사한다.

| 경로 | 원본 |
| --- | --- |
| `/` | `@soksak/workbench`의 `files` |
| `/modules/<패키지>/` | `soksak`, `@soksak/plugin-api`의 `files` |
| `/runtime/` | 애플리케이션의 `runtime` 디렉터리 |
| `/environment.json` | 애플리케이션의 `environment.json` |
| `/diagnostics.js` | `--diagnostics`이면 워크벤치의 `observe.js`(페이지 진단 메서드), 아니면 워크벤치의 빈 모듈 `release-diagnostics.js` |
| `/transcript.js` | `--diagnostics`이면 워크벤치의 `transcript.js`(진단 모듈이 쓰는 호출 기록기), 아니면 없음 |

애플리케이션의 bundle에는 플러그인이 없다. 호스트가 설정 디렉터리에 설치된 플러그인을 제공한다([설치된 plugin 제공](installation.ko.md#설치된-plugin-제공)). 호스트가 없는 애플리케이션인 브라우저 예제는 `--installed <설정 디렉터리>`를 주며, 그러면 도구가 그 디렉터리에서 호스트가 제공할 문서를 쓴다. `/installed-plugins.json`과 켜진 각 설치 플러그인의 파일을 `/modules/<패키지>/`에 쓰며, `diagnostics`는 `--diagnostics`일 때만 담는다.

게시된 파일이 import하는 모든 파일은 패키지의 `files` 배열에 나열되어야 하며, `packages/workbench/test/published-imports.test.mjs`가 이를 검증한다.

디버그 스테이징 대상 `frontend-wailsv3`, `frontend-tauriv2`는 `--diagnostics`를 더한다. 릴리스 빌드에는 페이지 진단 코드가 없고, 플러그인 진단 코드는 [진단 package](cli.ko.md#package-release-registry)를 설치한 설정에만 있다. `make release-check`는 스테이징된 릴리스 프런트엔드에 `/transcript.js`나 페이지 진단 모듈이 있으면 실패한다.

모든 페이지는 `PAGE_IMPORTS`와 같은 import map 하나를 선언한다. 항목은 `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/page`, `@soksak/runtime`, `@soksak/workbench/`다.

## 런타임 모듈

`runtime/index.js`는 다음을 내보낸다.

| 내보내는 값 | 의미 |
| --- | --- |
| `host` | 메인 페이지 호스트 인터페이스(`call`, `on`, `page`, `draggable`). 네이티브 호스트가 없으면 `null` |
| `page` | 표면·모달 페이지 인터페이스(`theme`, `sidecar`, `exposure`, `document`, `modal`). 네이티브 호스트가 없으면 `null` |
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
| `close()` | 창을 닫는다 |
| `state()` | 창 좌표를 반환한다. 런타임에 창 좌표가 없으면 `null` |
| `folder(root)` | 프로젝트 디렉터리의 `{ root, identity }`를 반환한다. 브라우저 애플리케이션은 앞뒤 공백을 제거한 경로와 식별자 `path:<공백 제거 경로>`를 반환한다 |
| `chooseFolder()` | 폴더 선택 대화상자를 표시한다. 브라우저 애플리케이션은 호출을 거부한다 |
| `createFolder({ parent, name })` | 프로젝트 폴더를 만든다. 브라우저 애플리케이션은 호출을 거부한다 |
| `openProject({ id, root, title, geometry, separate, current })` | 프로젝트를 열고 `{ local }`을 반환한다. 호출한 창이 프로젝트를 표시하면 `local`은 `true`다. 브라우저 애플리케이션은 별도 창으로 여는 프로젝트를 새 탭에서 연다 |
| `releaseProject(id)` | 호출한 창의 프로젝트 소유를 해제한다 |

워크벤치는 이 내보내는 값만 사용하고 런타임에 따라 분기하지 않는다. `host`가 `null`이면 사이드카나 `hybrid` 합성을 선언한 플러그인의 표면은 실행할 수 없다. 그 사이드카, 네이티브 영역, 공개 전달에 호스트가 필요하기 때문이다. 워크벤치는 그 모듈을 불러오지 않고, 표면 자리는 자리 표시 "<플러그인 이름> 표면은 네이티브 호스트가 있어야 열립니다"를 보이며, 표면은 `ready`를 보고하고 포커스를 받지 않고, 자리 표시는 탭과 함께 사라진다. 사이드카가 없는 `dom` 표면은 마운트된다. 호스트가 없으면 `report`는 그 줄을 콘솔에 오류로 쓴다.

플러그인 페이지는 `@soksak/plugin-api/page`에서 다음을 가져오고 워크벤치 파일을 가져오지 않는다: `followTheme`, `page`, `expose`([공개 항목](exposure.ko.md)), `ownManifest()`(검사한 페이지의 `plugin.json`), `createSurfaceComposition(...)`([표면 합성](surface-composition.ko.md)). 내보낸 `page` 객체는 원시 문서·그림 attach/place 포트를 노출하지 않는다. 영역 손잡이는 검증된 합성에서만 얻는다.

## 테스트

### 브라우저 섹션

브라우저 페이지는 [문서 영역](native-surfaces.ko.md#문서-영역)의 세션 기록을 `browser.history` `{entries: [{url, title}], index}`로 보고하고, `browser.history.go {index}`는 그 위치의 항목을 연다. 히스토리 섹션은 따라가는 표면의 항목을 오래된 것부터 나열하고 현재 항목을 표시하며, 각 항목을 `browser.history.go`에 연결한다. 탭 섹션은 `core.grid`를 따라가 `context.surface`를 가진 카드에서 플러그인이 `browser`인 탭을 보이는 제목과 함께 나열하고, 활성 탭을 표시하며, 각 탭을 `core.tab.select`에 연결한다. 페이지는 영역 상태의 `elements`와 `requests`를 문서의 요소 `browser.elements`와 기록된 요청 `browser.requests`로 보고한다. DOM 섹션은 요소를 깊이만큼 들여 `tag#id.class`로 나열하고 목록이 잘렸으면 알린다. 네트워크 섹션은 각 요청의 형식, 주소, 걸린 시간을 나열하고 목록이 잘렸으면 알린다. 두 섹션은 섹션의 표면을 따라가며 조작 요소가 없다. 브라우저 페이지는 영역 상태마다 `tab.title`([탭 알림](#탭-알림))로 탭 제목을 문서 제목으로, 제목이 비어 있으면 주소로 정하며, 제어 문자를 지우고 256자로 자른다. 둘 다 없으면 제목을 없애 탭이 이름을 보인다. 탭 섹션은 같은 보이는 제목을 보인다.

### 브라우저 주소 입력

브라우저 주소 칸은 포커스를 얻을 때 선언된 `browser.address.select` 명령으로 전체 값을 선택한다. 첫 포인터를 뗄 때 선택을 유지하여 입력이 이전 주소를 대체하게 한다. 이미 포커스된 칸의 후속 클릭에서는 다시 전체 선택하지 않고 캐럿을 옮길 수 있다. 플러그인은 소유 Shadow Root로 포커스를 판단하고 dispose 시 모든 처리기를 해제한다. 칸에 입력한 글자는 칸이 포커스를 잃거나 선언된 이동 명령(`browser.navigate`, `browser.back`, `browser.forward`, `browser.reload`)이 실행될 때까지 유지되며, 문서 상태 갱신이 이를 바꾸지 않는다. 그 밖에는 Enter 뒤 포커스를 유지하는 동안에도 상태가 갱신될 때마다 칸이 `browser.location.url`을 보인다. 상태 `browser.address.text`는 칸이 보이는 글자와 포커스 여부 `{value, focused}`를 보고한다. 네이티브 키보드 검사는 대체할 주소를 바로 입력하며 누락된 동작을 보정하려고 텍스트를 직접 선택하지 않는다.

각 디렉터리는 `pnpm test`로 자기 테스트를 실행한다. 패키지는 fixture로 자기 경계를 검사하고 다른 패키지의 소스나 실제 이름을 읽지 않는다. 플러그인 API는 형식을, 워크벤치는 fixture 파일로 로드를, 각 플러그인은 자기 `plugin.json`과 페이지를, 각 애플리케이션은 실제 플러그인 의존성으로 `environment.json`이 해석되는지를 검사한다. 워크벤치는 각 플러그인의 `preview.ink`로 라이브러리 미리보기 색을 정하고 플러그인별 CSS를 두지 않는다.

### 설정 선언

플러그인은 `plugin.json`의 `settings`에 타입이 있는 설정을 선언할 수 있다. 객체 키는 플러그인 내부 설정 이름이며 워크벤치는 이를 `<플러그인 id>.<키>`로 노출한다. 각 선언은 설정 창의 한국어 행 이름인 1자에서 40자 사이의 `label`을 가지며, 행 아래에 보이는 1자에서 200자 사이의 `description`을 가질 수 있다. 이름과 값 이름만으로 값이 무엇을 하는지 알 수 없으면 설명이 필요하다. 각 선언은 또 열거형이면 `type`, `default`, `values`를, 범위가 있는 정수면 `type`, `default`, `minimum`, `maximum`을, 최대 `maxLength`자의 비어 있지 않은 문자열이면 `type`, `default`, `maxLength`를, 주소면 `type`과 `default`를 가진다. 주소는 빈 문자열이거나 최대 2048자의 `http` 또는 `https` 주소다. 설정 창은 문자열과 주소를 한 줄 글자 입력으로 보인다. 타입과 검증 규칙의 유일한 출처는 선언이며 모르는 설정 키와 잘못된 기본값은 manifest 검증을 실패시킨다.

애플리케이션은 `environment.json`의 `settings`에 플러그인 id와 내부 설정 이름별 초기값을 제공할 수 있다. 값은 선언된 설정을 가리키고 선언 규칙을 통과해야 한다. 우선순위는 플러그인 기본값, 애플리케이션 값, 저장된 공통값, 저장된 프로젝트 덮어쓰기 순서다. 저장값은 유효 설정이 되기 전에 선언 규칙으로 검증하며 잘못된 저장 데이터는 명시적인 로딩 오류이고 대체하지 않는다.

`node scripts/check-boundaries.mjs`는 소스 파일의 경계 규칙을 검사한다. 코어 패키지는 플러그인·사이드카 패키지 이름과 플러그인 id를 적지 않고, 플러그인과 사이드카는 자기 `package.json`에 선언한 패키지 이름만 적는다. `apps/`, `e2e/`, 선언 파일(`package.json`, `plugin.json`, `sidecar.json`), `.md` 파일은 검사하지 않는다.
