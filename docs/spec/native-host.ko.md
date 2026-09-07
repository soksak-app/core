# 네이티브 호스트 인터페이스

[English](native-host.md)

예제 페이지는 [host.js](../../examples/browser/host.js)의 인터페이스를 사용한다. `framework/`는 런타임 호출, 이벤트, 문서 URL을 제공한다. 일반 브라우저에서는 `native`가 false, `chrome`이 null이며 네이티브 그리기 연산을 실행하지 않는다.

| 인터페이스 | 연산 | 책임 |
| --- | --- | --- |
| `surfaces` | `kinds`, `report`, `theme`, `place` | 네이티브 표면 생성·준비·표시·숨김·흐림 |
| `shapes` | `set`, `clear` | 표면 위의 네이티브 외곽선 |
| `chrome` | `draggable`, `controls` | 메인 창 드래그, 실제 네이티브 버튼 좌표 |
| `overlay` | `show`, `place`, `update`, `hide` | 표시된 DOM 요소의 네이티브 웹뷰 |

`surfaces.place(record)`는 호스트 배치의 Promise를 반환한다. 아직 그리지 않은 레코드는 `syncSurfaces`를 요청하고, 그린 레코드는 `presentSurfaces`도 요청한다. 페이지는 표시 확인을 기다린 뒤 최신 대기 배치를 준비한다. 각 준비는 전체 배치의 `ticket` 하나와 `placements` 배열을 반환한다. 식별자는 호스트 프로세스 내부에서만 유효하다. [표면 명세](native-surfaces.ko.md)가 배치와 표시를 정의한다.

`onSurfaceInput({press, input})`는 표면 누름과 드래그 단계를 메인 페이지 좌표로 수신한다. 오버레이의 `(key, value)` 응답은 소유 컴포넌트가 등록한 콜백으로 전달한다. [네이티브 모달](native-modals.ko.md)이 필수 속성, 프레임 좌표, 콘텐츠 갱신을 정의한다.

## macOS 구현

Wails는 앱이 생성한 추가 `WKWebView`, Tauri는 자식 웹뷰 API를 사용한다. 두 호스트 모두 메인 `NSWindow` 안에 뷰를 배치한다. 설정과 메뉴는 추가 OS 창을 생성하지 않는다. 현재 표면·배경 변경으로 프레임워크 의존성을 변경하지 않았다.

공통 AppKit 코드가 네이티브 버튼 배치, 입력 대상 선택, 표면 배치 트랜잭션을 처리한다. 입력 코드는 히트 테스트와 `_setIgnoresMouseMoveEvents:`로 보이는 웹뷰만 포인터 추적을 수신하게 한다. 지연된 커서 응답 처리는 변경하지 않는다. 표면 표시는 메인 문서와 표시 중인 앱 문서들의 `_doAfterNextPresentationUpdate:`가 완료된 뒤 레이어 트랜잭션을 커밋한다. 외부 문서의 렌더링을 기다리지 않으며 UI 스레드를 차단하지 않는다. 설정과 메뉴는 투명 배경을, 일반 표면은 불투명 렌더링을 사용한다. 공통 CSS가 모달 배경과 블러를 정의한다.

창 버튼 컨테이너는 녹화 중 AppKit이 버튼의 부모를 변경하면 버튼을 다시 배치한다. 위치 조회는 좌표만 읽는다. 전체화면 전환 중에는 버튼을 표준 타이틀바 컨테이너로 일시 복원한다.

Windows와 Linux의 네이티브 호스트 동작은 검증하지 않았다. Wails의 추가 웹뷰 생성은 현재 macOS에만 구현되어 있다. [기능 상태](../features.ko.md)는 검증과 배포를 구분해 기록한다.
