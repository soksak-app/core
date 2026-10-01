# 네이티브 호스트 인터페이스

[English](native-host.md)

워크벤치 페이지는 [host.js](../../packages/workbench/host.js)의 인터페이스를 사용한다. 애플리케이션의 런타임 모듈(`@soksak/runtime`, [플러그인](plugins.ko.md#런타임-모듈) 참고)이 런타임 호출, 이벤트, 문서 URL을 제공한다. 일반 브라우저에서는 `native`가 false, `chrome`이 null이며 네이티브 그리기 연산을 실행하지 않는다.

| 인터페이스 | 연산 | 책임 |
| --- | --- | --- |
| `surfaces` | `kinds`, `report`, `theme`, `place` | 네이티브 표면 생성·준비·표시·숨김·흐림 |
| `shapes` | `set`, `clear` | 표면 위의 네이티브 외곽선 |
| `chrome` | `draggable`, `controls` | 메인 창 드래그, 실제 네이티브 버튼 좌표 |
| `overlay` | `show`, `place`, `update`, `hide` | 표시된 DOM 요소의 네이티브 웹뷰 |

`surfaces.place(record)`는 호스트 배치의 Promise를 반환한다. 아직 그리지 않은 레코드는 `syncSurfaces`를 요청하고, 그린 레코드는 `presentSurfaces`도 요청한다. 페이지는 표시 확인을 기다린 뒤 최신 대기 배치를 준비한다. 각 준비는 전체 배치의 `ticket` 하나와 `placements` 배열을 반환한다. 식별자는 해당 창 내부에서만 유효하다. [표면 명세](native-surfaces.ko.md)가 배치와 표시를 정의한다. 표시의 각 단계는 자기 한도와 오류를 가진다. 호스트는 앱 문서나 image raster가 10초 안에 표시되지 않으면 `syncSurfaces`와 `presentSurfaces`를 실패시키고, 페이지는 메인 문서가 10초 안에 animation frame을 실행하지 않으면 배치를 실패시킨다(`the main document ran no animation frame within 10000ms`). 실패한 배치는 페이지 오류로 보고되며 다음 배치를 막지 않는다.

`onSurfaceInput({press, input})`는 표면 누름과 드래그 단계를 메인 페이지 좌표로 수신한다. 오버레이의 `(key, value)` 응답은 소유 컴포넌트가 등록한 콜백으로 전달한다. [네이티브 모달](native-modals.ko.md)이 필수 속성, 프레임 좌표, 콘텐츠 갱신을 정의한다.

## 프로젝트·설정 연산

`projects.js`, `library.js`, `storage.js`는 런타임 브리지의 `projectFolder`, `projectCreate`, `folderChoose`, `projectOpen`, `projectRelease`, `windowNew`, `windowState`, `pageStarted`, `windowReady`, `windowClose`, `workspace`를 사용한다. main page는 exposure 항목을 등록하거나 surface를 mount하기 전에 `pageStarted`를 호출한다. 호출이 돌아오기 전에 host는 window를 not ready로 표시하고, 이전 page에 보낸 요청을 끝내고, window의 열린 layout을 취소하고, 이전 page의 surface document와 image를 닫고, 그 surface가 닫혔다고 알리고, 열린 modal을 버린다. main webview의 navigation callback은 새 page의 호출과의 전달 순서가 보장되지 않으므로 이 작업을 하지 않고 WebKit 자식 process 기록만 갱신한다. `folderChoose`는 호스트의 공개 디렉터리 선택 API를 사용하며 취소 시 경로를 반환하지 않는다. `projectCreate`는 새 디렉터리를 생성하고 정규화된 식별 정보를 반환한다. `windowNew`는 프로젝트 미선택 앱 창을 생성한다. 저장소 스냅샷은 열린 창이 소유한 프로젝트 ID를 포함한다. [프로젝트 명세](projects.ko.md)가 파일 저장과 창 동작을 정의한다. Wails는 프레임워크의 서비스 컨텍스트가 제공한 호출 창으로 네이티브 상태를 선택한다. Tauri는 명령의 창으로 선택한다. 이벤트, 표면, 오버레이, 입력 모니터, 사이드카 표면 등록은 해당 창에 속한다. 표면·모달 라벨은 창 사이에서 중복되지 않는다. 창을 닫으면 호스트는 입력 모니터를 제거하고 그 창의 표면이 닫혔음을 [사이드카](sidecars.ko.md)에 알린다.

## macOS 구현

Wails는 앱이 생성한 추가 `WKWebView`, Tauri는 자식 웹뷰 API를 사용한다. 두 호스트 모두 해당 프로젝트 `NSWindow` 안에 뷰를 배치한다. 설정과 메뉴는 추가 OS 창을 생성하지 않는다. 현재 표면·배경 변경으로 프레임워크 의존성을 변경하지 않았다.

공통 AppKit 코드가 창 제목줄, 입력 대상 선택, 표면 배치 트랜잭션, 창 크기 변경 애니메이션을 처리한다. 두 호스트는 첫 창을 만들기 전에 `NSWindowResizeTime`을 0.001로 등록해 확대와 애니메이션 크기 변경이 화면 갱신 한 번 안에 끝나게 한다. 창 프레임과 웹 내용은 따로 표시되므로 애니메이션이 길면 그동안 이전 내용이 보인다. 사용자가 직접 설정한 값이 있으면 그 값을 쓴다. 입력 코드는 히트 테스트와 `_setIgnoresMouseMoveEvents:`로 보이는 웹뷰만 포인터 추적을 수신하게 한다. 지연된 커서 응답 처리는 변경하지 않는다. 표면 표시는 메인 문서와 표시 중인 앱 문서들의 `_doAfterNextPresentationUpdate:`가 완료된 뒤 레이어 트랜잭션을 커밋한다. 표시 상태 대기는 창의 열린 트랜잭션이 커밋되기를 기다리고, 이어서 그 표시 갱신을 기다린 뒤 화면의 `CADisplayLink`에서 다음 갱신 시각을 읽는다. 외부 문서의 렌더링을 기다리지 않으며 UI 스레드를 차단하지 않는다. 설정과 메뉴는 투명 배경을, 일반 표면은 불투명 렌더링을 사용한다. 공통 CSS가 모달 배경과 블러를 정의한다.

Wails는 저장된 창 좌표를 적용하기 전에 초기 웹뷰 크기 보정을 완료한다. 이후 프레임 크기와 위치의 조회·설정 함수는 같은 좌표 기준을 사용한다.

창 버튼 컨테이너는 녹화 중 AppKit이 버튼의 부모를 변경하면 버튼을 다시 배치한다. 위치 조회는 좌표만 읽는다. 전체화면 전환 중에는 버튼을 표준 타이틀바 컨테이너로 일시 복원한다.

Windows와 Linux의 네이티브 호스트 동작은 검증하지 않았다. Windows에서 두 호스트는 디렉터리 식별만 구현하며 애플리케이션 시작이 실패한다. [네이티브 호스트](hosts.ko.md#windows-상태)가 이 상태를 설명한다. Linux 구현은 없다. [기능 상태](../features.ko.md)는 검증과 배포를 구분해 기록한다.
