# 플러그인과 애플리케이션 환경

[English](plugins.md)

워크벤치는 특정 플러그인을 참조하지 않는다. 각 애플리케이션은 `environment.json`에 플러그인과 기본값을 선언한다. 각 플러그인은 `plugin.json`에 자신을 선언한다. [`@soksak/plugin-api`](../../packages/plugin-api/index.js)가 두 형식, `sidecar.json` 형식, 스테이징 파일 배치, 페이지 import map을 정의한다. 워크벤치, 플러그인, 애플리케이션은 이 함수로 자기 파일을 검사한다.

## 작업 공간 구조

| 디렉터리 | 내용 |
| --- | --- |
| `packages/soksak` | 헤드리스 배치 라이브러리 |
| `packages/workbench` | 워크벤치 프런트엔드(코어): 프로젝트, 스페이스, 카드, 탭, 사이드바, 설정, 플러그인 로드, `soksak-stage` |
| `packages/plugin-api` | 선언 형식, 스테이징 배치, 페이지 import map, 플러그인 페이지 도구 |
| `packages/client` | 로컬 엔드포인트 클라이언트와 지연 시간 벤치마크 |
| `plugins/<id>` | 플러그인 하나: `plugin.json`, 페이지, 테스트 |
| `packages/host/<name>` | [네이티브 호스트](hosts.ko.md) 라이브러리(코어): Go의 `wailsv3`와 Rust의 `tauriv2` |
| `apps/<name>` | 애플리케이션 하나: `environment.json`, `runtime/`, 네이티브 진입점과 프레임워크 설정, 테스트 |
| `sidecars/<name>` | [사이드카](sidecars.ko.md) 하나: `sidecar.json`, 플러그인이 호스트를 통해 사용하는 네이티브 프로세스, 테스트 |
| `native/darwin` | 네이티브 호스트가 사용하는 macOS 공용 라이브러리 |
| `e2e` | 실행 중인 네이티브 애플리케이션의 창 검사 |

공통 기능은 워크벤치나 네이티브 호스트에 두어 플러그인이 다시 구현하지 않게 한다. 플러그인 기능은 워크벤치로 옮기지 않는다. 사이드카는 한 영역의 네이티브 기능을 담고 여러 플러그인에 제공할 수 있다. 메시지 전달 같은 일반 기능은 호스트에 둔다.

## plugin.json

| 필드 | 필수 | 의미 |
| --- | --- | --- |
| `id` | 예 | 소문자 식별자. 탭과 설정이 참조한다 |
| `name` | 예 | 표시 이름 |
| `surface` | 아니오 | `{ "module": "ui/page.js", "composition": ... }`: 패키지 안의 모듈과 필수 [표면 합성](surface-composition.ko.md). 모듈은 앱 DOM에 마운트하며 외부 웹 문서는 문서 영역을 사용한다. 웹 주소는 표면이 아니다 |
| `home` | 아니오 | 표면 페이지가 처음 여는 `http` 또는 `https` 주소. `surface`가 필요하다 |
| `mark` | `surface`가 있으면 | 추가 메뉴와 새 탭 제목에 표시하는 짧은 텍스트 |
| `icon` | `surface`가 있으면 | 16×16 뷰박스용 SVG 요소 |
| `sections` | 아니오 | 사이드바 섹션 `{ "id": "<플러그인 id>.<이름>", "name", "module" }`. `module`은 섹션을 그리는 패키지 안의 JavaScript 경로다([섹션](#섹션)) |
| `preview` | 아니오 | `{ "ink": "--<토큰>" }`: 라이브러리 미리보기에서 플러그인 카드의 색을 정하는 테마 토큰 이름. `surface`가 필요하다 |
| `sidecars` | 아니오 | 표면 페이지가 사용하는 [사이드카](sidecars.ko.md)의 패키지 이름. `surface`가 필요하다. 각각 플러그인 `package.json`의 의존성이어야 한다 |
| `background` | 아니오 | `{ "sidecar": "<선언한 사이드카>", "operation": "<동작 이름>", "settings"?: { "<요청 필드>": "<선언한 설정>" } }`: 활성화되지 않은 탭마다 네이티브 표면을 만들지 않고 선언한 사이드카 세션 하나를 유지한다. 워크벤치는 대응한 플러그인 설정의 현재 값을 요청 필드에 넣으며, `settings`는 `operation`이나 선언하지 않은 설정을 가리킬 수 없다. `surface`와 `sidecars`가 필요하다 |

플러그인은 `surface`와 `sections` 중 하나 이상이 필요하다. 표면이 있는 플러그인만 추가 메뉴에 표시되고 레일을 갖는다. 워크벤치는 `modules/<패키지 이름>/<module>`을 import하고 `mount(root, context)`를 호출한다. 표면 식별자는 URL 쿼리가 아닌 명시적인 context 멤버다. 기존 `page` 선언은 거부하며 별도 구현 경로를 선택하지 않는다. 정의되지 않은 필드는 거부한다.

`surface.drop`이 있으면 파일이 표면에 놓였을 때 페이지가 그 표면에서 실행할 `exposes`의 명령을 가리키며, `{urls}`에 놓인 파일 URL을 담는다([네이티브 표면](native-surfaces.ko.md#네이티브-뷰-위의-입력)).

`surface.composition`은 `{ "kind": "dom" }`이거나 `kind: "hybrid"`, 완전한 `regions`, 완전한 `overlays`를 가진 혼합 선언이다. 그림 영역은 `sidecars`에 이미 나열한 사이드카를 지정한다. manifest 선언은 호스트에 전달하는 권한 데이터다. 페이지 코드는 선언에 없는 영역, 공급자, 입력 소유자, 쌓임 항목을 추가할 수 없다.

## 섹션

섹션은 플러그인이 그리는 사이드바의 한 부분이다. 워크벤치는 섹션의 `module`을 불러 표면 페이지처럼 섹션 요소에서 `mount(root, context)`를 호출하고, 섹션이 사이드바를 떠나면 돌려받은 해제 함수를 호출한다. `context.card`는 사이드바가 속한 카드의 id이고 `context.surface`는 그 카드의 활성 탭이며, 좌측 사이드바에서는 둘 다 `null`이다. 섹션은 애플리케이션 문서 안에 그려지며 네이티브 표면을 갖지 않는다.

섹션은 플러그인이 선언한 status로 그 플러그인의 상태를 보이고, 플러그인이 선언한 명령으로 상태를 바꾼다. 섹션은 그 상태의 사본을 갖지 않는다. `context.status(name, fn)`은 섹션을 가진 플러그인의 status 하나를 따라가고, 따라가기를 멈추는 함수를 반환한다. `fn(value, surface)`는 현재 값과 그 뒤의 모든 변경을 받는다. 섹션은 `context.surface`가 그 이름을 등록했으면 그 표면을, 아니면 `surface`가 없는 요청이 쓰는 표면([표면 선택](exposure.ko.md#표면-선택))을 따라가며, 그 이름을 등록한 표면이 없는 동안에는 `fn(null, null)`을 받는다. 등록이 바뀌면 표면을 다시 고른다. `context.bind(element, name, params, options)`는 공통 binder로 요소를 섹션 플러그인의 명령에 연결하고 dom 이름 `core.sidebar.section.control`을 붙인다. 요소가 표면 페이지가 아니라 애플리케이션 문서에 속하기 때문이다. 명령은 `context.surface`가 그 명령을 등록했으면 그 표면에서, 아니면 `surface`가 없는 요청이 쓰는 표면에서 실행된다. 섹션은 다른 플러그인의 이름을 쓰지 못한다. `core.sidebars`는 각 섹션이 그린 텍스트와 조작 요소의 수를 보고하므로, 검사는 섹션이 보이는 내용을 읽고 `core.sidebar.section.control` 요소 중 그 섹션의 조작 요소를 찾는다.

세트는 어느 플러그인의 섹션이든 순서대로 묶고, 세트를 만들 때 고른 `layout`을 가진다. `list`에서 사이드바는 세트의 모든 섹션을 위에서 아래로 보이며, 각 섹션은 이름 머리 아래에 있고 머리로 접고 편다. `tabs`에서 사이드바는 섹션 이름의 탭 줄과 고른 탭의 섹션 하나만 보이며, 선택은 사이드바마다 유지된다. 세트를 보이는 모든 사이드바(레일, 카드 안 사이드바, 좌측과 우측 사이드바)는 같은 방식으로 그린다.

사이드바는 그것을 담은 카드의 id로 식별한다. `left`, `right`, 레일 카드, 또는 카드 안 사이드바의 카드다. 섹션 머리를 접고 펴면 `core.sidebar.section.fold`를, 탭을 고르면 `core.sidebar.section.select`를 `{sidebar, section}`으로 실행한다. status `core.sidebars`는 그려진 모든 사이드바의 세트, 레이아웃, 고른 탭, 각 섹션의 접힘과 마운트 상태를 알린다. 섹션 모듈은 패키지의 `files`에 나열한 파일이므로 릴리스 스테이징이 복사한다. 섹션 모듈이 나열되어 있지 않으면 스테이징이 실패한다.

## 진단 선언

표면이 있는 플러그인은 검사에만 쓰는 status와 명령 항목을 패키지 루트의 `diagnostics.json` 파일에 둘 수 있다: `{ "module": "ui/<파일>.js", "exposes": { ... } }`. `module`은 패키지 안의 파일이며, `exposes`는 `plugin.json` `exposes`의 형식과 소유자 규칙을 따른다. 한 이름은 `plugin.json`과 `diagnostics.json` 중 한 곳에만 선언한다. `diagnostics.json`과 그 모듈은 패키지의 `files`에 나열하지 않으므로 릴리스 스테이징은 이를 복사하지 않는다. 둘 중 하나가 나열되어 있으면 스테이징이 실패한다. 사용자 입력이나 OS가 만드는 상태를 주입하거나 검사를 위해 내부 이벤트를 기록하는 항목은 `diagnostics.json`에 속하고, 보이는 상태를 보고하거나 사용자 조작을 수행하는 항목은 `plugin.json`에 속한다.

진단 빌드에서 워크벤치는 이 선언을 플러그인의 표면 선언에 더하고, 표면을 마운트하기 전에 모듈을 import한다. 표면 context는 그 모듈을 `diagnostics`로 전달하며, 릴리스 빌드에서 `diagnostics`는 `null`이다. 표면 모듈은 이를 구현에 넘기고, 구현은 진단 항목이 쓰는 내부 연산을 모듈에 넘겨 호출한다.

## 표면 모듈 소유권

OS 창마다 앱 DOM WebView가 하나 있다. 워크벤치는 표면 요소와 Shadow Root를 소유하며 플러그인은 그 루트 안에 마운트한 DOM을 소유한다. Shadow DOM은 스타일을 분리하며 보안 권한을 분리하지 않는다. context는 표면 범위의 명령, 상태, DOM 바인딩, 사이드카 메시지와 선언된 합성 컨트롤러를 제공한다. 호스트는 창, 표면, 선언을 다시 검증한다. context로 보낸 사이드카 메시지는 보낸 순서대로 사이드카에 도착한다. 워크벤치는 같은 사이드카로의 앞선 전송이 끝난 뒤 다음 전송을 시작하며, 그 사이드카의 모든 표면과 백그라운드 세션이 한 순서를 공유한다. context의 표면이 아닌 표면으로 보내는 전송은 거부된다. 플러그인은 내부 WebView나 iframe을 만들지 않는다.

`mount(root, context)`는 비동기일 수 있고 `{ dispose() }`를 반환한다. 영역을 부착하는 마운트 작업 전에 네이티브 표면 등록이 끝나야 한다. 마운트 실패는 보이는 오류이며 빈 표면의 성공으로 처리하지 않는다. 네이티브 준비 완료는 모듈 import 완료가 아닌 첫 영역의 실제 표시를 요구한다. 워크벤치는 로딩, 준비 완료, 오류를 구분한다.

탭 숨김이나 라이브러리 이동은 모듈을 폐기하거나 세션을 닫지 않고 DOM과 네이티브 영역을 숨긴다. 명시적 제거는 모듈을 폐기하고 바인딩, 이벤트 구독, 영역을 해제하며 해제 실패를 보고한다. 모든 동작은 공통 binder와 [노출](exposure.ko.md) 계약을 따른다. 메뉴와 설정은 같은 앱 WebView의 DOM 오버레이이며 네이티브 영역 위의 입력 소유권을 선언한다.

`background` 선언은 두 번째 페이지나 숨은 WebView가 아니라 세션 수명을 명시하는 계약이다. 워크벤치는 선언된 `operation`을 선언된 사이드카에 사이드카 메시지 프로토콜로 보낸다. manifest에서는 읽기 쉬운 전체 필드명 `operation`을 사용한다. 워크벤치는 요청을 임의로 만들거나 누락된 동작을 대체하거나 오류를 숨기지 않는다. 탭이 보이게 되면 그 표면이 같은 동작과 이미지 영역을 보내 기존 세션에 다시 연결한다. 탭을 제거하면 background 세션도 제거한다.

## 탭 알림

표면 컨텍스트에는 `tab.title(text)`, `tab.directory(path)`, `tab.notify(text)`, 그리고 고정된 `origin` 객체가 있다.

`tab.title(text)`는 표면의 탭이 이름 대신 보일 제목을 정하고, `tab.title(null)`은 그 제목을 지워 탭이 다시 이름을 보이게 한다. 텍스트는 제어 문자(U+0000–U+001F, U+007F–U+009F)가 없는 1–256자의 문자열이며, 다른 값은 예외를 던진다. 제목은 레이아웃과 함께 저장하지 않는다. `core.grid`는 각 탭이 보이는 제목을 `label`로, 없으면 `null`로 알린다.

`tab.notify(text)`는 탭이 포커스된 카드의 활성 탭이 아닐 때 그 탭에 알림을 둔다. 그 탭이면 표면이 보이고 있으므로 아무것도 바꾸지 않는다. 텍스트는 제목 규칙을 따르되 최대 1024자이며, 다른 값은 예외를 던진다. 알림이 있는 탭은 점을 보이고, 그 탭과 카드의 탭 목록 버튼은 텍스트를 도움말로 가지며, 탭 목록은 탭 옆에 점을 보인다. 알림은 탭이 포커스된 카드의 활성 탭이 되거나 닫히면 지워지고, 나중 알림이 앞의 알림을 바꾼다. `core.grid`는 각 탭의 알림을 `notice`로, 없으면 `null`로 알린다. 워크벤치는 알림을 저장하지 않는다.

알림은 시스템 알림이기도 하다. 창의 호스트는 운영체제의 알림 센터로 탭의 이름을 제목, 알림 텍스트를 본문으로 하여 알림을 게시하며, 애플리케이션이 활성일 때도 게시한다. 탭의 나중 알림은 그 탭의 시스템 알림을 바꾸고, 알림이 지워지면 시스템 알림도 지워진다. 호스트는 첫 알림 때 사용자에게 권한을 요청한다. macOS의 알림 센터는 애플리케이션 번들에서 실행된 프로세스만 받으므로 애플리케이션은 번들에서 실행된다([호스트](hosts.ko.md#프런트엔드와-실행-파일)). 시스템 알림을 누르면 그 창이 키 창이 되고 그 탭에 `core.tab.select`를 실행한다. `core.notifications`는 `{authorization, error, posted}`를 알린다. `authorization`은 `notDetermined`, `denied`, `authorized`, `provisional` 중 하나이고, `error`는 권한 요청, 게시, 제거의 마지막 실패 또는 `null`이며, `posted`는 알림 센터가 알림을 받아들인 뒤 지워지지 않은 이 창의 탭을 순서대로 나열한다. 권한이 거부된 동안 알림이 있는 탭과 그 카드의 탭 목록 버튼의 도움말은 `System notifications are turned off for this application.` 줄로 끝난다.

`tab.directory(path)`는 표면의 작업 디렉터리인 절대 경로를 기록하고, `tab.directory(null)`은 그것을 지운다. 다른 값은 예외를 던진다. 워크벤치는 이를 위해 파일 시스템을 읽지 않고 저장하지 않는다. `+`나 쪼개기가 탭을 만들면, 새 표면의 `origin.directory`는 탭을 더하거나 쪼갠 카드의 활성 탭이 그 순간 기록한 디렉터리이고, 없으면 `null`이다.

## 링크 열기

표면 컨텍스트에는 `runtime.links.open(url)`이 있으며, 호스트에 절대 `http`, `https`, `mailto` URL을 그 스킴의 사용자 기본 애플리케이션으로 열도록 요청한다. 호스트는 다른 스킴, 해석되지 않는 URL, 8192자보다 긴 URL을 거부하고, 반환한 promise는 그 이유로 거부된다. macOS 호스트는 `NSWorkspace`로 URL을 연다. Windows 플랫폼은 `not implemented on windows`를 반환한다.

## 아이콘

표면 컨텍스트에는 `icon(name)`이 있으며, 코어 아이콘 `name`을 24 단위 `viewBox`, 획 경로만, `aria-hidden`을 가진 SVG 마크업으로 반환한다. 없는 이름은 예외를 던진다. 코어는 아이콘을 `packages/workbench/icons.js`에 두고, 플러그인은 워크벤치를 가져올 수 없으므로 플러그인 페이지는 자체 그림 대신 컨텍스트로 아이콘을 그린다. 마크업에는 스타일이 없고, 페이지가 자기 Shadow Root에서 크기, 색, 획을 정한다. 이름은 `star`, `projects`, `panel-left`, `panel-right`, `sun`, `moon`, `settings`, `close`와 Lucide 아이콘 `chevron-left`, `chevron-right`, `rotate-cw`다.

브라우저의 뒤로, 앞으로, 새로 고침 단추는 `chevron-left`, `chevron-right`, `rotate-cw`를 카드 머리 단추의 모양으로 그린다. 단추는 20×20, 아이콘은 14px, 색은 `--muted`이고, 포인터 아래에서는 배경이 `--inset`, 색이 `--fg`가 된다. 획 폭 1.95 단위는 16 단위 `viewBox`에서 획 1.3 단위인 머리 단추와 같은 굵기로 아이콘을 그린다.

## environment.json

| 필드 | 의미 |
| --- | --- |
| `runtime` | 런타임 모듈 `index.js`를 포함한 애플리케이션 안의 디렉터리 |
| `plugins` | 플러그인 패키지 이름. 각각 애플리케이션 패키지의 의존성이어야 한다. 순서가 추가 메뉴 순서다 |
| `workspace.grid` | 새 스페이스의 격자선과 카드. `tabs`가 있는 카드는 `{ plugin, title }` 항목을 나열한다 |
| `workspace.focus` | 새 스페이스에서 포커스할 카드. 탭이 있어야 한다 |
| `sidebars.sets` | 기본 섹션 세트 `{id, title, sections, layout}`. `layout`은 `list` 또는 `tabs`다 |
| `sidebars.links` | 세트를 `left`(`plugin: null`), `right`, `rail`(플러그인 id 포함)에 연결하는 기본값 |

워크벤치는 설정을 읽거나 스페이스를 만들기 전에 `environment.json`과 나열된 모든 `plugin.json`을 로드한다. 표면이 없는 플러그인을 가리키는 탭이나 연결, 알 수 없는 섹션을 가리키는 세트가 있으면 등록 전에 로드가 실패한다. 저장된 스페이스는 환경 파일이 아니며, 스페이스를 열 때 등록되지 않은 플러그인의 탭과 레일을 제거한다([프로젝트](projects.ko.md#저장)). 저장된 사이드바 세트와 연결은 설정이며 `environment.json`과 같은 사이드바 검사를 거친다. 등록되지 않은 섹션을 가리키는 저장된 세트나 표면이 없는 플러그인을 가리키는 연결은 설정 불러오기를 오류로 실패시킨다([설정 창](settings.ko.md#저장되는-세트와-연결)).

## 스테이징 배치

`soksak-stage <출력> [--executables <디렉터리>] [--diagnostics]`는 애플리케이션 디렉터리에서 실행하고 Node 모듈 해석으로 패키지를 찾는다. 파일 내용을 바꾸지 않고 복사한다.

| 경로 | 원본 |
| --- | --- |
| `/` | `@soksak/workbench`의 `files` |
| `/modules/<패키지>/` | `soksak`, `@soksak/plugin-api`, 나열된 각 플러그인의 `files` |
| `/runtime/` | 애플리케이션의 `runtime` 디렉터리 |
| `/environment.json` | 애플리케이션의 `environment.json` |
| `/modules/<사이드카>/sidecar.json` | 플러그인의 `sidecars`에 나열된 각 사이드카 패키지의 `sidecar.json` |
| `/diagnostics.js` | `--diagnostics`이면 워크벤치의 `observe.js`(페이지 진단 메서드), 아니면 빈 모듈 |
| `/transcript.js` | `--diagnostics`이면 워크벤치의 `transcript.js`(진단 모듈이 쓰는 호출 기록기), 아니면 없음 |
| `/diagnostic-plugins.json` | `--diagnostics`이면 `diagnostics.json`이 있는 나열된 플러그인 패키지마다 그 파일 내용을 담은 객체, 아니면 `{}` |
| `/modules/<패키지>/<모듈>` | `--diagnostics`이면 플러그인의 `diagnostics.json`이 지정한 `module` 파일, 아니면 없음 |

배포된 파일이 import 하는 모든 파일은 패키지의 `files` 배열에 나열되어야 한다. 이는 `packages/workbench/test/published-imports.test.mjs`가 검사한다.

`--executables <디렉터리>`를 지정하면 각 사이드카의 빌드된 `executable` 파일을 파일 이름 그대로 `<디렉터리>`에 복사하고, 파일이 빌드되지 않았으면 실패한다. 디버그 스테이징 대상 `frontend-wailsv3`, `frontend-tauriv2`는 `sidecars-debug`를, 릴리스 빌드 대상은 `sidecars-release`를 실행한다. 두 대상은 애플리케이션이 선언한 사이드카와 그 사이드카가 선언한 헬퍼를 해당 프로필로 빌드한다. 그 뒤 애플리케이션 실행 파일의 디렉터리(`target/debug` 또는 `target/release`)를 `--executables`로 지정해 `apps/<app>/src/frontend`에 스테이징한다. 디버그 대상은 `--diagnostics`를 더하며, 릴리스 빌드에는 페이지와 플러그인의 진단 코드가 없다. 스테이징된 릴리스 프런트엔드의 `/diagnostic-plugins.json`이 비어 있지 않거나, 플러그인 진단 모듈이 있거나, 플러그인 `diagnostics.json`에 선언한 이름이 들어 있으면 `make release-check`가 실패한다.

모든 페이지는 `PAGE_IMPORTS`와 같은 import map 하나를 선언한다. 항목은 `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/page`, `@soksak/runtime`, `@soksak/workbench/`다.

## 런타임 모듈

`runtime/index.js`는 다음을 내보낸다.

| 내보내는 값 | 의미 |
| --- | --- |
| `host` | 메인 페이지 호스트 인터페이스(`call`, `on`, `page`, `draggable`). 네이티브 호스트가 없으면 `null` |
| `page` | 표면·모달 페이지 인터페이스(`theme`, `sidecar`, `exposure`, `document`, `modal`). 네이티브 호스트가 없으면 `null` |
| `openStore()` | 작업 공간 저장소를 반환한다. 브라우저 애플리케이션은 IndexedDB를, 네이티브 애플리케이션은 `HostWorkspaceStore`를 사용한다 |
| `windows` | 창과 프로젝트 폴더 인터페이스. 네이티브 애플리케이션은 `@soksak/workbench/host-windows.js`의 `hostWindows(host)`를, 브라우저 애플리케이션은 자체 구현을 내보낸다 |

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

워크벤치는 이 내보내는 값만 사용하고 런타임에 따라 분기하지 않는다.

플러그인 페이지는 `@soksak/plugin-api/page`에서 다음을 가져오고 워크벤치 파일을 가져오지 않는다: `followTheme`, `page`, `expose`([공개 항목](exposure.ko.md)), `ownManifest()`(검사한 페이지의 `plugin.json`), `createSurfaceComposition(...)`([표면 합성](surface-composition.ko.md)). 내보낸 `page` 객체는 원시 문서·그림 attach/place 포트를 노출하지 않는다. 영역 손잡이는 검증된 합성에서만 얻는다.

## 테스트

### 브라우저 주소 입력

브라우저 주소 칸은 포커스를 얻을 때 선언된 `browser.address.select` 명령으로 전체 값을 선택한다. 첫 포인터를 뗄 때 선택을 유지하여 입력이 이전 주소를 대체하게 한다. 이미 포커스된 칸의 후속 클릭에서는 다시 전체 선택하지 않고 캐럿을 옮길 수 있다. 플러그인은 소유 Shadow Root로 포커스를 판단하고 dispose 시 모든 처리기를 해제한다. 칸에 입력한 글자는 칸이 포커스를 잃거나 선언된 이동 명령(`browser.navigate`, `browser.back`, `browser.forward`, `browser.reload`)이 실행될 때까지 유지되며, 문서 상태 갱신이 이를 바꾸지 않는다. 그 밖에는 Enter 뒤 포커스를 유지하는 동안에도 상태가 갱신될 때마다 칸이 `browser.location.url`을 보인다. 상태 `browser.address.text`는 칸이 보이는 글자와 포커스 여부 `{value, focused}`를 보고한다. 네이티브 키보드 검사는 대체할 주소를 바로 입력하며 누락된 동작을 보정하려고 텍스트를 직접 선택하지 않는다.

각 디렉터리는 `pnpm test`로 자기 테스트를 실행한다. 패키지는 fixture로 자기 경계를 검사하고 다른 패키지의 소스나 실제 이름을 읽지 않는다. 플러그인 API는 형식을, 워크벤치는 fixture 파일로 로드를, 각 플러그인은 자기 `plugin.json`과 페이지를, 각 애플리케이션은 실제 플러그인 의존성으로 `environment.json`이 해석되는지를 검사한다. 워크벤치는 각 플러그인의 `preview.ink`로 라이브러리 미리보기 색을 정하고 플러그인별 CSS를 두지 않는다.

### 설정 선언

플러그인은 `plugin.json`의 `settings`에 타입이 있는 설정을 선언할 수 있다. 객체 키는 플러그인 내부 설정 이름이며 워크벤치는 이를 `<플러그인 id>.<키>`로 노출한다. 각 선언은 설정 창의 한국어 행 이름인 1자에서 40자 사이의 `label`을 가지며, 행 아래에 보이는 1자에서 200자 사이의 `description`을 가질 수 있다. 이름과 값 이름만으로 값이 무엇을 하는지 알 수 없으면 설명이 필요하다. 각 선언은 또 열거형이면 `type`, `default`, `values`를, 범위가 있는 정수면 `type`, `default`, `minimum`, `maximum`을, 최대 `maxLength`자의 비어 있지 않은 문자열이면 `type`, `default`, `maxLength`를 가진다. 타입과 검증 규칙의 유일한 출처는 선언이며 모르는 설정 키와 잘못된 기본값은 manifest 검증을 실패시킨다.

애플리케이션은 `environment.json`의 `settings`에 플러그인 id와 내부 설정 이름별 초기값을 제공할 수 있다. 값은 선언된 설정을 가리키고 선언 규칙을 통과해야 한다. 우선순위는 플러그인 기본값, 애플리케이션 값, 저장된 공통값, 저장된 프로젝트 덮어쓰기 순서다. 저장값은 유효 설정이 되기 전에 선언 규칙으로 검증하며 잘못된 저장 데이터는 명시적인 로딩 오류이고 대체하지 않는다.

`node scripts/check-boundaries.mjs`는 소스 파일의 경계 규칙을 검사한다. 코어 패키지는 플러그인·사이드카 패키지 이름과 플러그인 id를 적지 않고, 플러그인과 사이드카는 자기 `package.json`에 선언한 패키지 이름만 적는다. `apps/`, `e2e/`, 선언 파일(`package.json`, `plugin.json`, `sidecar.json`), `.md` 파일은 검사하지 않는다.
