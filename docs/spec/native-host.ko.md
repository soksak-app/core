# 네이티브 호스트 인터페이스

[English](native-host.md)

워크벤치 페이지는 [host.js](../../packages/workbench/host.js)의 인터페이스를 사용한다. 애플리케이션의 런타임 모듈(`@soksak/runtime`, [플러그인](plugins.ko.md#런타임-모듈) 참고)이 런타임 호출, 이벤트, 문서 URL을 제공한다. 일반 브라우저에서는 `native`가 false, `chrome`이 null이며 네이티브 그리기 연산을 실행하지 않는다.

| 인터페이스 | 연산 | 책임 |
| --- | --- | --- |
| `surfaces` | `kinds`, `report`, `theme`, `place` | 네이티브 표면 생성·준비·표시·숨김·흐림 |
| `shapes` | `set`, `clear` | 표면 위의 네이티브 외곽선 |
| `chrome` | `draggable`, `controls` | 메인 창 드래그, 실제 네이티브 버튼 좌표 |
| `overlay` | `show`, `place`, `update`, `hide` | 표시된 DOM 요소의 네이티브 웹뷰 |

`surfaces.place(record)`는 호스트 배치의 Promise를 반환한다. 아직 그리지 않은 레코드는 `syncSurfaces`를 요청하고, 그린 레코드는 `presentSurfaces`도 요청한다. 페이지는 표시 확인을 기다린 뒤 최신 대기 배치를 준비한다. 각 준비는 제목줄 높이 `titlebar` 를 담고, 전체 배치의 `ticket` 하나와 `placements` 배열, 호스트가 제목줄을 정한 뒤의 창 `chrome` 을 반환한다([제목줄 높이](native-surfaces.ko.md#제목줄-높이)). 식별자는 해당 창 내부에서만 유효하다. 호스트는 배치 트랜잭션을 시작하기 전에 `syncSurfaces` 요청 전체를 검사한다. 표면 id가 비었거나 반복되거나, 표면 사각형이나 창 overlay 사각형에 유한하지 않은 수가 있거나(`surface "<id>" geometry must contain finite numbers`, `window overlay geometry must contain finite numbers`) 크기가 음수이거나(`surface "<id>" geometry must not have a negative size`, `window overlay geometry must not have a negative size`), composition 선언이 올바르지 않거나 표면이 전에 선언한 것과 다르거나, `titlebar` 가 32 이상 200 이하 point 의 수가 아니면(`title bar height must be a finite number from 32 through 200 points`) 창을 바꾸지 않고 요청을 실패시킨다. [표면 명세](native-surfaces.ko.md)가 배치와 표시를 정의한다. 표시의 각 단계는 자기 한도와 오류를 가진다. 호스트는 앱 문서나 image raster가 10초 안에 표시되지 않으면 `syncSurfaces`와 `presentSurfaces`를 실패시킨다. 실패한 배치는 페이지 오류로 보고되며 다음 배치를 막지 않는다.

`onSurfaceInput({press, input})`는 표면 누름과 드래그 단계를 메인 페이지 좌표로 수신한다. 오버레이의 `(key, value)` 응답은 소유 컴포넌트가 등록한 콜백으로 전달한다. [네이티브 모달](native-modals.ko.md)이 필수 속성, 프레임 좌표, 콘텐츠 갱신을 정의한다.

## 프로젝트·설정 연산

`projects.js`, `library.js`, `storage.js`는 런타임 브리지의 `projectFolder`, `projectCreate`, `folderChoose`, `projectOpen`, `projectRelease`, `windowNew`, `windowState`, `windowReady`, `windowClose`, `workspace`를 사용한다. main page는 [시작 문서](#page-시작)로 시작한다. main webview의 navigation callback은 새 page의 요청과의 전달 순서가 보장되지 않으므로 page 시작 작업을 하지 않고 WebKit 자식 process 기록만 갱신한다. `folderChoose`는 호스트의 공개 디렉터리 선택 API를 사용하며 취소 시 경로를 반환하지 않는다. `projectCreate`는 새 디렉터리를 생성하고 정규화된 식별 정보를 반환한다. `windowNew`는 프로젝트 미선택 앱 창을 생성한다. 저장소 스냅샷은 열린 창이 소유한 프로젝트 ID를 포함한다. [프로젝트 명세](projects.ko.md)가 파일 저장과 창 동작을 정의한다. Wails는 프레임워크의 서비스 컨텍스트가 제공한 호출 창으로 네이티브 상태를 선택한다. Tauri는 명령의 창으로 선택한다. 이벤트, 표면, 오버레이, 입력 모니터, 사이드카 표면 등록은 해당 창에 속한다. 표면·모달 라벨은 창 사이에서 중복되지 않는다. 창을 닫으면 호스트는 입력 모니터를 제거하고, 표면마다 문서 영역과 그림 영역을 닫은 뒤 표면을 닫고, 그 창의 표면이 닫혔음을 [사이드카](sidecars.ko.md)에 알린다. 표면은 main webview를 보유하고 문서 영역은 자기 web content process를 가지므로, 열린 채 남은 표면이나 영역은 창을 닫은 뒤에도 그 webview와 web content process를 남긴다. webview의 네이티브 입력 등록은 webview가 해제될 때 끝난다.

## 애플리케이션 주소

웹뷰 안의 애플리케이션 문서는 주소 `sok://<owner>/<path>`를 가진다. owner `core`는 core의 문서를 가리키고, plugin id는 그 plugin의 파일을 가리킨다([문서 영역](native-surfaces.ko.md#문서-영역)). `soksak` scheme은 애플리케이션 밖에서 여는 딥링크에 쓰며, 웹뷰 안의 문서 주소에는 쓰지 않는다.

## page 시작

window의 main page는 host가 그 window를 위해 page의 요청 때 만드는 시작 문서 `{ workspace, controls }`로 시작한다. `workspace`는 `workspace` 호출이 `snapshot`에 돌려주는 스냅샷이고, `controls`는 그 window의 `windowControls` 답, 곧 native 단추 사각형과 title-bar 행이다. window가 전체 화면처럼 title bar를 보이지 않는 동안 행은 0이다. 표준 단추나 content view가 없는 window는 title bar를 가질 수 없으므로 `windowControls`가 실패한다. 요청에 답하는 것이 page의 시작이다: host는 문서를 보내기 전에 window를 not ready로 표시하고, 이전 page에 보낸 요청을 끝내고, window의 열린 layout을 취소하고, 이전 page의 surface document와 image를 닫고, 그 surface가 닫혔다고 알리고, 열린 modal을 버리고, 이어서 창의 title bar를 저장된 frame 배율의 첫 행 높이로 정한 뒤(창이 이전 page를 보이면 새 page의 첫 표시와 함께 커밋하는 시작 transaction 안에서) `controls`를 읽는다([제목줄 높이](native-surfaces.ko.md#제목줄-높이)). page의 module graph가 이 문서를 포함하고 page 코드는 graph를 다 불러온 뒤에만 실행되므로, 이 요청은 새 page의 모든 호출보다 앞선다. Wails는 요청이 가리키는 window(`x-wails-window-id`)를 위해 asset server에서 `/start.json`을 제공한다. Tauri는 요청한 webview를 위해 custom URI scheme handler에서 `sok://core/start.json`을 제공하고 `Access-Control-Allow-Origin`으로 page origin을 허용한다. window를 가리키지 않는 요청은 오류로 실패하고 아무것도 시작하지 않는다. Tauri는 window의 main webview가 아닌 webview의 요청도 거부한다. runtime 파일 `runtime/start.js`는 문서를 default export로 내보낸다. browser runtime은 저장된 workspace를 top-level await로 읽고 `controls: null`을 내보낸다.

main page의 module script는 `head`의 render-blocking script(`blocking="render"`)다. HTML 표준은 `body`가 생기기 전에만 render-blocking 요소를 받아들인다. module은 document를 다 읽은 뒤 실행되어 `environment.json`, `exposure.json`, `/installed-plugins.json`을 JSON module로, 시작 문서를 `runtime/start.js`로 가져오고, 첫 `await` 전에 단추 여백과 행을 적용한 window chrome과 라이브러리나 window의 project space 카드를 그린다. plugin 내용, native surface, 비동기 읽기는 그 뒤에 이어진다. 그 전에는 document를 그리지 않고, WebKit은 다시 읽기의 이전 page를 새 page가 그릴 때까지 화면에 두므로, 다시 읽기의 첫 frame은 그 완전한 첫 화면이다. main page 다시 읽기는 WebContent process를 유지한다.

WebKit은 window가 화면에 있는 동안에만 web view를 그리고, window가 화면에 올라갈 때 그 그리기를 기다리지 않는다. 그래서 page가 그리기 전에 보인 window는 열리는 동안 빈 window를 보인다. 두 host는 모든 window를 숨긴 채 만들고, 투명하게 한 뒤 화면에 올리고, main webview의 첫 읽기가 성공이든 실패든 끝나고 그 뒤의 presentation update가 끝나면 불투명하게 한다(`sp_window_reveal_after_load`). 첫 화면은 읽기가 끝나기 전에 그려지므로, 시작할 때의 첫 window를 포함해 새 window의 처음 보이는 frame은 그 완전한 첫 화면이고, 읽지 못한 page도 그 실패와 함께 보인다.

## page 다시 읽기

`host.window.reload`는 window의 main page를 새 WebContent process에서 다시 읽고, 이전 process는 이전 문서와 함께 끝난다([비공개 native API](../operations/private-native-apis.md)). main page의 page 변경도 같다. 준비된 page는 먼저 대기 중인 저장을 끝낸다(`core.projects.flush`). 그다음 host는 web view를 직접 다시 읽지 않고 그 page에 `page-reload` 이벤트를 보낸다. 다시 읽기가 요청을 멈춘 뒤에 쓴 host 응답은 사라지고 Wails가 이를 오류로 기록하기 때문이다. page는 host 호출 보내기를 멈추고, 보낸 호출이 모두 답을 받을 때까지 기다린 뒤 스스로 다시 읽는다. 이벤트 뒤에 page가 하는 호출은 보내지 않으며, 다시 읽기가 멈춘 호출처럼 document와 함께 끝난다. 준비를 알리지 않은 page에는 `page-reload` listener가 없을 수 있으므로 host가 직접 다시 읽는다. 명령은 새 page가 준비를 알린 뒤 끝나고, 10초 안에 알리지 않으면 1005를 돌려준다.

## host 호출

두 애플리케이션에서 main page는 모든 host 호출을 하나의 호출 경로(`packages/workbench/host-calls.js`)로 보낸다. JSON은 NaN, Infinity, -Infinity를 `null`로 쓰고, host는 숫자 field의 `null`을 page가 가졌던 수를 밝히지 않고 거부하므로, page는 인자에 그런 수가 든 호출을 보내기 전에 거부한다. 호출은 `TypeError`로 실패하며 message는 `host call <name>: <path> is <value>, which JSON sends as null`이다. `<path>`는 field를 가리키거나(예: `surfaces[0].y`) 인자 자체가 그 수이면 `the argument`다.

각 host는 host 호출과 surface 페이지가 page runtime으로 보내는 호출의 모든 인자를 호출이 실행되기 전에 자기 인자 decoder로 해석한다. framework 자체의 인자 해석은 인자를 raw JSON으로 받아 아무것도 거부하지 않으므로, 두 host는 같은 인자를 같은 문장으로 거부한다. field는 선언이 그렇게 말할 때 선택 사항이다: Tauri host에서는 `Option` field나 `#[serde(default)]` field, Wails host에서는 pointer field나 `json` tag에 `omitempty`가 있는 field다. 값이 `null`인 field는 빠진 field로 보므로, 선택 field는 빠지거나 `null`일 수 있다. decoder는 인자를 `argument <path> <problem>` message로 거부한다:

- `<path> is missing`: 선택 사항이 아닌 field가 빠졌거나 `null`이다.
- `<path> must be <expected>, not <actual>`: 값이 다른 JSON 형식이다. `<expected>`와 `<actual>`은 `null`, `a boolean`, `a number`, `a string`, `an array`, `an object` 중 하나다.
- `<path> must be an integer from <min> to <max>`: 정수 field의 수가 그 field 범위의 정수가 아니다.
- `<path> must be an array of <n> items`: 고정 길이 배열의 길이가 다르다.

`<path>`는 인자 이름으로 시작하고 `.<field>`와 `[<index>]`를 붙인다. 예: `request.rect.h`, `request.surfaces[0].x`. runtime adapter가 보내지 않은 인자는 `null`이다. 인자 형식이 선언하지 않은 field는 무시한다. 두 인자는 두 host에서 형식이 다르다: Tauri runtime adapter는 host가 page의 key 순서를 그대로 중계하도록 exposure 응답과 상태 변경 값을 JSON 텍스트로 보내며([exposure](exposure.ko.md)), Tauri host는 인자를 해석한 뒤 그 텍스트를 검사한다. 값이 빠졌거나 `null`인 상태 변경은 두 host에서 상태를 `null`로 바꾼다.

실패한 image 영역 호출은 호출을 밝힌다: 인자 해석 뒤 `imageAttach`, `imageFocus`, `imageCaret`, `imageText`, `imageDetach`의 실패는 두 host에서, 그리고 main page와 surface page 경로 모두에서 `<call>: <reason>`이다. 예: `imageDetach: image "view" is not attached`.

## macOS 구현

Wails는 앱이 생성한 추가 `WKWebView`, Tauri는 자식 웹뷰 API를 사용한다. 두 호스트 모두 해당 프로젝트 `NSWindow` 안에 뷰를 배치한다. 설정과 메뉴는 추가 OS 창을 생성하지 않는다. 현재 표면·배경 변경으로 프레임워크 의존성을 변경하지 않았다.

공통 AppKit 코드가 창 제목줄, 입력 대상 선택, 표면 배치 트랜잭션, 창 크기 변경 애니메이션을 처리한다. 두 호스트는 첫 창을 만들기 전에 `NSWindowResizeTime`을 0.001로 등록해 확대와 애니메이션 크기 변경이 화면 갱신 한 번 안에 끝나게 한다. 창 프레임과 웹 내용은 따로 표시되므로 애니메이션이 길면 그동안 이전 내용이 보인다. 사용자가 직접 설정한 값이 있으면 그 값을 쓴다. 입력 코드는 히트 테스트와 `_setIgnoresMouseMoveEvents:`로 보이는 웹뷰만 포인터 추적을 수신하게 한다. 지연된 커서 응답 처리는 변경하지 않는다. 표면 표시는 메인 문서와 표시 중인 앱 문서들의 `_doAfterNextPresentationUpdate:`가 완료된 뒤 레이어 트랜잭션을 커밋한다. 표시 상태 대기는 창의 열린 트랜잭션이 커밋되기를 기다리고, 이어서 그 표시 갱신을 기다린 뒤 화면의 `CADisplayLink`에서 다음 갱신 시각을 읽는다. 외부 문서의 렌더링을 기다리지 않으며 UI 스레드를 차단하지 않는다. 설정과 메뉴는 투명 배경을, 일반 표면은 불투명 렌더링을 사용한다. 공통 CSS가 모달 배경과 블러를 정의한다.

Wails는 저장된 창 좌표를 적용하기 전에 초기 웹뷰 크기 보정을 완료한다. 이후 프레임 크기와 위치의 조회·설정 함수는 같은 좌표 기준을 사용한다.

창 버튼 컨테이너는 녹화 중 AppKit이 버튼의 부모를 변경하면 버튼을 다시 배치한다. 위치 조회는 좌표만 읽는다. 전체화면 전환 중에는 버튼을 표준 타이틀바 컨테이너로 일시 복원한다.

Windows와 Linux의 네이티브 호스트 동작은 검증하지 않았다. Windows에서 두 호스트는 디렉터리 식별만 구현하며 애플리케이션 시작이 실패한다. [네이티브 호스트](hosts.ko.md#windows-상태)가 이 상태를 설명한다. Linux 구현은 없다. [기능 상태](../features.ko.md)는 검증과 배포를 구분해 기록한다.
