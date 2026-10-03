# 비공개 네이티브 API 목록

[English](private-native-apis.md)

네이티브 소스, 프레임워크 의존성, SDK, macOS 또는 WebKit 런타임 업데이트 후 네이티브 동작에 문제가 생기면 이 문서를 가장 먼저 검토한다. 업데이트 전에도 검토한다. 의존성을 먼저 확인한다는 사실만으로 실패 원인을 확정하지 않는다.

이 문서는 현재 macOS 호스트의 앱 호출, 진단 호출, 사용하는 프레임워크 내부 비공개 경로를 관리하는 정본이다. 공통 배치 라이브러리에는 네이티브 API 의존성이 없다. Windows와 Linux 네이티브 실행은 검증하지 않았다.

## 현재 목록

| API 또는 키 | 호출 위치와 범위 | 목적 |
| --- | --- | --- |
| `NSWindowResizeTime` 사용자 기본값 | 두 호스트의 [`window_motion.m`](../../native/darwin/src/window_motion.m), `windowResizeInstant`. 첫 창을 만들기 전에 등록 | 창 프레임과 웹 내용이 따로 표시되므로 창 확대·크기 변경 애니메이션을 화면 갱신 한 번으로 줄임 |
| `WKWebView._setOverrideDeviceScaleFactor:` | 두 호스트의 [`webview_geometry.m`](../../native/darwin/src/webview_geometry.m), `webviewAttachSurface` | 장치 픽셀 컨테이너의 로컬 한 단위를 backing 픽셀 하나로 렌더링 |
| 문서 웹뷰의 `WKWebView._setOverrideDeviceScaleFactor:` | 두 호스트의 [`webview_geometry.m`](../../native/darwin/src/webview_geometry.m), `webviewMatchSurface`. [`document_view.m`](../../native/darwin/src/document_view.m)의 `sp_document_create`가 호출 | 장치 픽셀 표면 안의 문서 영역을 표면과 같은 밀도로 렌더링 |
| `WKWebView._doAfterNextPresentationUpdate:` | 두 호스트의 [`surface_layout.m`](../../native/darwin/src/surface_layout.m), 배치 커밋 전 `surfaceLayoutAfterPresentation`와, 공개 DOM 평가 뒤 display link 전의 `settle`(`host.window.presented`와 명령 정착이 사용); [`input_inject.m`](../../native/darwin/src/input_inject.m), `sp_input_pointer_then`; [`window_reveal.m`](../../native/darwin/src/window_reveal.m), main webview의 첫 읽기가 끝난 뒤 window를 불투명하게 하기 전의 `sp_window_reveal_after_load`; 프로브와 독립 입력 검사에서도 사용한다. DOM 평가는 레이아웃만 끝내고 웹 콘텐츠 프로세스는 그 DOM의 렌더링을 나중에 커밋하므로, 이 호출 없는 정착은 페이지의 마지막 DOM 변경이 그려지기 전의 표시 시각을 보고했다. | 네이티브 좌표 커밋, 새 문서로의 네이티브 스크롤 전달, 새 window 표시, 렌더링 결과 측정 전에 웹뷰 표시 완료 확인 |
| `PreferPageRenderingUpdatesNear60FPSEnabled` 기능에 대한 `WKPreferences._features`, `_WKFeature.key`, `WKPreferences._setEnabled:forFeature:`, `WKPreferences._isEnabledForFeature:` | 두 호스트의 [`surface_layout.m`](../../native/darwin/src/surface_layout.m), [`window_facts.m`](../../native/darwin/src/window_facts.m)의 `sp_window_set_main_webview`가 호출하는 `surfaceLayoutRenderAtDisplayRate`; `host.window` 웹뷰 행의 `surfaceLayoutPrefersNear60FPS` | 배치마다 앱 DOM 웹뷰의 다음 표시를 기다리므로 그 웹뷰가 화면 갱신 주기로 렌더링을 갱신하게 함 |
| `WKWebView._setIgnoresMouseMoveEvents:` | 두 호스트의 [`webview_input.m`](../../native/darwin/src/webview_input.m), 등록·포인터 처리·제거. 표면, 모달, 문서 영역 웹뷰. 대상 뷰의 추적을 켠 뒤 첫 이동을 전달 | 겹친 웹뷰의 포인터 추적을 AppKit 히트테스트 결과로 제한하고 이동 도중 추적 대상이 바뀔 때 페이지 커서를 갱신 |
| `WKWebView` KVC `drawsBackground` (`_drawsBackground` / `_setDrawsBackground:`) | Tauri 앱 DOM 표면 생성의 [`webview_geometry.m`](../../native/darwin/src/webview_geometry.m), Wails [`webview.m`](../../packages/host/wailsv3/src/platform/darwin/webview.m)의 혼합 표면·모달 생성; 두 호스트 [`window_facts.m`](../../native/darwin/src/window_facts.m)의 `host.window` 조회 | 위에 놓인 DOM 평면의 불투명 배경 비활성화 및 상태 보고 |
| `WKWebViewConfiguration` KVC `drawsBackground` (`_setDrawsBackground:`) | Tauri → Wry 혼합 표면·모달 생성; [`modals.rs`](../../packages/host/tauriv2/src/modals.rs) `show`가 `background_color(Color(0, 0, 0, 0))` 요청; 메인도 배경색 설정 | 위에 놓인 DOM 평면의 웹뷰 초기화 전에 배경 그리기 설정 |
| `WKWebView._setShouldSuppressFirstResponderChanges:` | 두 호스트; [`webview_input.m`](../../native/darwin/src/webview_input.m)의 `webviewIgnorePageFocus`, 표면, 모달, 문서 영역 웹뷰 | 페이지가 요소에 초점을 줄 때 창의 키보드 초점을 옮기지 않게 함 |
| `NSWindow._setWindowResolution:`, `NSWindow._adjustWindowResolution` 재정의 | [`webview_geometry_test.m`](../../native/darwin/tests/webview_geometry_test.m) 전용. WebKitTestRunner가 쓰는 메서드 | 해당 디스플레이 없이 검사 창의 백킹 배율을 2나 1로 정해 어느 기기에서나 배율 동작을 검사 |
| `WKWebView._setWindowOcclusionDetectionEnabled:` | 두 호스트의 [`window_facts.m`](../../native/darwin/src/window_facts.m), `sp_window_set_main_webview`; [`webview_geometry.m`](../../native/darwin/src/webview_geometry.m), `webviewAttachSurface` | 배치와 command는 앱 DOM 문서의 표시를, surface capture와 paint 확인은 surface 렌더링을 기다리므로 창이 가려져도 앱 DOM 문서와 붙인 surface 문서를 visible로 유지하고 animation frame을 계속 실행. WebKit에 selector가 없으면 main webview 등록이 실패하므로 surface는 selector가 있을 때만 붙는다 |
| 가림 검사의 `WKWebView._doAfterActivityStateUpdate:` | [`window_occlusion_test.m`](../../native/darwin/tests/window_occlusion_test.m) | WebKit이 가려진 창의 상태를 web process에 반영한 뒤에만 문서 visibility를 읽음 |
| `WKWebView._doAfterActivityStateUpdate:` | 두 호스트; [`input_inject.m`](../../native/darwin/src/input_inject.m), `sp_input_activate_at` | 브라우저 좌표에서는 대상 웹뷰만 활성 창 상태를 웹 프로세스에 보낸 뒤 활성화를 완료하고, native 좌표에서는 관련 없는 웹뷰를 기다리지 않음 |
| `CGEventField` 51(창 번호), `CGEventSetWindowLocation` | 두 호스트; [`input_inject.m`](../../native/darwin/src/input_inject.m), `sp_input_pointer`의 스크롤과 `sp_input_key`의 키(필드 51만) | 창과 창 좌표를 가진 스크롤 `NSEvent` 생성, `-[NSApplication sendEvent:]`에 보낼 창을 가진 키 `NSEvent` 생성 |
| `WKWebView._inspector`와 `_WKInspector`(`connect`, `show`, `attach`, `close`, `isVisible`, `isConnected`, `inspectorWebView`) | [`native/darwin/tests/webview_inspector_test.m`](../../native/darwin/tests/webview_inspector_test.m), 검사 전용 | 표면 웹뷰의 웹 인스펙터를 열고 창에 붙여 표면이 자리를 유지하는지 확인 |
| `WKWebView._doAfterProcessingAllPendingMouseEvents:` | 양호스트; [`webview_input.m`](../../native/darwin/src/webview_input.m)의 `webviewInputSendThen`, `sp_input_pointer_then`에서 호출; 독립 입력 검사에서도 사용한다. 끌기 후 뗌은 뗀 좌표의 문서 대신 누름 때 잡은 문서를 따른다. | 전달 전과 수신 후 대기 중인 마우스 처리를 완료해 결과 클릭이 다음 요청보다 먼저 끝나도록 함 |
| `_WKWebsiteDataStoreConfiguration.initWithDirectory:`, `WKWebsiteDataStore._initWithConfiguration:` | 두 호스트; [`document_view.m`](../../native/darwin/src/document_view.m), `storeForDirectory`, `sp_document_create`가 `<config-dir>/document-data`로 호출 | 문서 영역의 사이트 데이터를 앱 설정 디렉터리 안에 둔다 |
| `WKProcessPool._garbageCollectJavaScriptObjectsForTesting` | 두 호스트의 진단 빌드(`diagnostics.page.collect`)와 [`webview_process_test.m`](../../native/darwin/tests/webview_process_test.m); [`webview_geometry.m`](../../native/darwin/src/webview_geometry.m), `sp_webview_collect_garbage` | 메모리를 재기 전에 pool의 WebContent process들이 JavaScript 객체를 수집하게 한다. 공개 API에는 수집 요청이 없다. 선택자를 사용할 수 없으면 호출자가 오류를 보고한다 |
| `WKWebView._killWebContentProcessAndResetState`, `_webProcessIdentifier` | 두 호스트의 애플리케이션 종료([`host.go`](../../packages/host/wailsv3/src/host.go) `OnShutdown`, [`host.rs`](../../packages/host/tauriv2/src/host.rs) 종료 처리기); [`webview_geometry.m`](../../native/darwin/src/webview_geometry.m), `sp_webview_kill_content_process` | 애플리케이션이 끝나기 전에 창마다 WebContent 프로세스를 끝내 WebKit 자식 프로세스가 남지 않게 하고, 프로세스 식별자가 0이 될 때까지 기다린다. 두 선택자를 사용할 수 없으면 호출자가 오류를 보고한다 |
| `_WKNavigationActionPolicyAllowInNewProcess`, `WKWebView._clearBackForwardCache` | 두 host. [`webview_navigation.m`](../../native/darwin/src/webview_navigation.m)의 `sp_webview_replace_documents_in_new_process`, 앱 DOM webview에 대해 `sp_window_set_main_webview`가 설치한다 | 앱 DOM webview의 새 main frame 문서를 새 WebContent process에서 열고 멈춰 둔 이전 page를 놓아, 교체된 문서를 가진 process가 끝나게 한다. `_clearBackForwardCache`가 없으면 등록이 실패한다 |

공용 라이브러리의 비공개 선언은 모두 [`native/darwin/src/private/`](../../native/darwin/src/private/)의 `webkit.h`, `coregraphics.h`에 있다. 소스와 검사는 이 헤더를 포함하며 비공개 API를 직접 선언하지 않는다. 다른 플랫폼은 `native/<os>/src/private/`에 선언을 둔다.

두 `drawsBackground` 항목의 대상 객체는 다르다. Wails는 생성된 뷰를 변경하고, Wry는 생성 전 구성을 변경한다. 프레임워크의 공개 Rust·Go 진입점도 비공개 네이티브 의존성을 포함할 수 있다.

## 필요성 검토

### 장치 배율

이 수정을 유지한다. 네이티브 높이에 0.5pt가 포함되면 문서 배치 전에 네이티브 그리기 크기가 정수로 변환되어 빈 영역이 발생했다. 장치 픽셀 컨테이너는 배치 정밀도를 낮추지 않고 정수 로컬 크기를 제공한다. 공개 `pageZoom`은 CSS 크기를 유지하지만 해당 로컬 좌표의 backing 밀도를 독립적으로 설정하지 않는다. `_setOverrideDeviceScaleFactor:1`은 각 콘텐츠 웹뷰를 등록할 때 한 번 그 밀도를 설정하며, 이후 화면 배율 변경은 컨테이너와 페이지 줌으로 처리한다. 메인과 모달 웹뷰에는 이 수정을 적용하지 않는다. 문서 영역은 표면의 하위 뷰이며, 표면이 장치 픽셀 컨테이너 안에 있을 때만 같은 설정을 받아 영역의 로컬 한 단위도 backing 픽셀 하나가 된다. 페이지 줌은 카드의 [글자 크기](../spec/text-size.ko.md) 배율이다. [`webview_geometry_test.m`](../../native/darwin/tests/webview_geometry_test.m)이 2×, 1× 변경 후, 2× 복귀 후 영역의 장치 픽셀 배율과 CSS 크기를 검사한다.

업데이트 후 선택자의 시그니처와 사용자 지정 배율·기본 배율의 의미를 검토한다. 의미가 변경되면 CSS 크기, 렌더링 밀도 또는 입력 좌표가 잘못될 수 있다. [`webview_geometry_test.m`](../../native/darwin/tests/webview_geometry_test.m)으로 0.5pt 문서 영역, 마지막 장치 픽셀, 2×↔1× 전환을, [`geometry.test.mjs`](../../e2e/geometry.test.mjs)로 창 크기 변경을 검증한다. 좌표 계약은 [네이티브 표면](../spec/native-surfaces.ko.md)에 정의한다.

선언은 [`WKWebViewPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h)에 있다. 구현은 [`WebPageProxy.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp)의 `WebPageProxy::setCustomDeviceScaleFactor`와 `deviceScaleFactor`를 사용한다.

### 렌더링 갱신 주기

앱 DOM 웹뷰에 이 설정을 유지한다. macOS의 WebKit은 `PreferPageRenderingUpdatesNear60FPSEnabled`를 기본으로 켜므로 120Hz 화면에서도 페이지는 60fps 근처로 렌더링을 갱신한다. 배치마다 앱 DOM 웹뷰의 다음 표시를 기다리므로 경계 끌기는 60Hz 프레임마다 최대 한 번 진행했다. 이 기능은 WebKit 기능 플래그이고, `_setEnabled:forFeature:`는 `WKPreferences` 객체에서 그런 플래그를 바꾸도록 WebKit이 제공하는 인터페이스다. 기능이 없으면 앱 DOM 웹뷰 등록이 실패하고 두 호스트는 시작에 실패한다. 다른 웹뷰는 기본값을 유지한다. `host.window`는 웹뷰마다 값을 `near60fps`로 보고한다.

설정이 없으면 실패하는 [`window_facts_test.m`](../../native/darwin/tests/window_facts_test.m)과 [`outside.test.mjs`](../../e2e/outside.test.mjs)의 `native content, cards, and the sidebar rail stay aligned`로 검증한다. 기능 키는 [`UnifiedWebPreferences.yaml`](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml), 선언은 [`WKPreferencesPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKPreferencesPrivate.h)와 [`_WKFeature.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/_WKFeature.h)에서 검토한다.

### 표시 완료

이 수정을 유지한다. JavaScript 실행이나 DOM 애니메이션 프레임 콜백의 완료는 앱 DOM이 새 좌표를 표시했다는 확인이 아니다. 호스트는 해당 프로젝트 창의 단일 앱 DOM을 기다린 뒤 네이티브 트랜잭션을 커밋한다. `CATransaction`은 UI 스레드에 속하므로 서로 다른 창의 준비를 직렬화하며, 탐색과 닫기는 해당 창의 준비만 취소한다. 다른 웹뷰는 URL 출처와 무관하게 참여하지 않으므로 웹 문서 렌더러의 긴 작업이 메인 창 배치를 중단시키지 않는다. 네이티브 그림 래스터 준비는 별도의 필수 검사로 유지한다.

콜백 시점, 그리기 완료, 탐색·프로세스 종료 중 동작을 검토한다. 구현은 실행 중인 프로세스나 그리기 영역이 없으면 즉시 완료할 수 있으므로 콜백만으로 캡처된 픽셀을 확인한 것으로 처리하지 않는다. 문서 준비 확인과 전체 녹화가 계속 필요하다. 대기 대상 문서를 검사하는 [`surface_layout_test.m`](../../native/darwin/tests/surface_layout_test.m)을 실행하고, 다시 로드 후 정리를 포함해 [`outside.test.mjs`](../../e2e/outside.test.mjs), [`paint.test.mjs`](../../e2e/paint.test.mjs), [`hosts.test.mjs`](../../e2e/hosts.test.mjs)를 검증한다. [`projects.test.mjs`](../../e2e/projects.test.mjs)는 독립 프로젝트 창, 모달 전달, 닫기·다시 열기 정리도 검증한다.

[`WKWebView.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm)의 `_doAfterNextPresentationUpdate:`와 [`WebPageProxy.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp)의 `WebPageProxy::callAfterNextPresentationUpdate`를 검토한다.

네이티브 `surface_layout_test`는 바깥 배치 트랜잭션이 열린 동안에도 앱 문서 콜백이 완료되는지 확인한다. 해당 구현에서 트랜잭션 교착을 가정해 대기를 제거할 근거는 없다. 두 호스트는 DOM 문서와 현재 표시 중인 그림 래스터를 차례로 기다린 뒤 커밋하며, 오래된 티켓을 성공으로 반환하지 않고 준비 거절을 보고한다.

Tauri 이벤트 전달 콜백은 Tao의 이벤트 처리 잠금을 가진다. 이 콜백에서 트랜잭션을 확정하면 창을 동기적으로 다시 그리면서 같은 잠금에 재진입할 수 있다. macOS 스레드 샘플로 프로젝트 라이브러리 검사 중 이 교착을 재현했다. 두 호스트는 문서·래스터 대기를 유지하고 공개 네이티브 메인 큐(`ui_queue.m`)로 표시 완료를 전달한다. 다시 읽기와 닫기 취소도 같은 큐를 사용한다. 이 실행 경계는 비공개 API를 추가하거나 프레임워크 상태를 수정하지 않는다. `ui_queue_test`는 호출자의 잠금 해제 후 실행을 검증하고, 다시 빌드한 호스트의 라이브러리·드래그 검사가 통합 동작을 검증한다.

### 포인터 추적

이 수정을 유지한다. 겹친 네이티브 추적 영역은 여러 웹뷰에 이동 이벤트를 전달할 수 있다. 공개 AppKit 히트테스트로 뷰를 선택하는 것만으로 다른 웹뷰의 추적을 비활성화할 수 없다. 공통 모듈은 히트테스트 결과에 따라 비공개 플래그를 적용한다. 키보드·클릭·드래그 처리를 비활성화하거나 키보드 포커스를 변경하거나 네이티브 이벤트를 DOM 이벤트로 대체하지 않는다.

비공개 플래그는 마우스 진입·이탈 처리에도 영향을 준다. 로컬 모니터는 이동·진입 이벤트에서 선택 대상을 변경하며 이탈 이벤트에서는 변경하지 않는다. 이탈 이벤트가 항상 허용된다고 서술하면 안 된다. 선택자를 사용할 수 없으면 등록이 실패하며, 제거 시 플래그를 초기화한다. 업데이트 후 추적 영역 동작, 이벤트 순서, hover 해제, 숨김·제거, 키보드 입력 유지를 검토한다. 이 API는 WebKit에 이미 제출한 작업을 취소하지 않는다. 유지 중인 검사는 지연된 커서 응답을 검증하지 않는다.

[독립 입력 검사](examples.ko.md#진단)의 기준 실행과 등록 실행, [`modal.test.mjs`](../../e2e/modal.test.mjs)를 사용한다. [`WKWebViewMac.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/mac/WKWebViewMac.mm)의 `_setIgnoresMouseMoveEvents:`와 [`WebViewImpl.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm)의 추적 처리를 검토한다.

### 투명 배경

혼합 표면과 모달 투명도를 위해 이 수정을 유지한다. 투명한 DOM 콘텐츠만으로 불투명 웹뷰 아래의 네이티브 콘텐츠를 표시할 수 없다. 공개 `underPageBackgroundColor`는 페이지 콘텐츠 뒤의 색상을 설정하며, CSS 투명도와 해당 색상 설정만으로 네이티브 배경 그리기를 비활성화하지 않는다. 비공개 `drawsBackground` 상태가 이 별도 요구사항을 처리한다. 혼합 쌓임은 [표면 합성](../spec/surface-composition.ko.md)이 정의하고, 50% 반투명 배경과 블러는 [네이티브 모달](../spec/native-modals.ko.md)에 정의한 CSS 동작이다. DOM 전용 표면은 불투명하게 유지한다.

정확한 KVC 키, 대상 클래스, 생성 전 구성과 생성 후 뷰 설정의 효과를 검토한다. Wails는 대입 결과를 확인하며 KVC 예외가 발생하거나 불투명 상태가 유지되면 뷰 생성이 실패한다. 진단 조회 자체에는 같은 예외 처리가 없다. 좌표와 표시 선택자도 직접 호출한다. 모든 비공개 API 누락이 처리된 오류로 반환된다고 가정하면 안 된다.

합성 검사, [`modal.test.mjs`](../../e2e/modal.test.mjs), [수동 인수](examples.ko.md#수동-인수)로 DOM 평면 아래의 혼합 네이티브 콘텐츠, 앵커 투명도, 오버레이 쌓임, 모달 초기 투명도, 캡처된 반투명 배경·블러, 설정 탐색 후 선명한 콘텐츠, 배경 효과 없는 메뉴, 닫기·다시 로드 후 정리를 검증한다. 투명도는 소수점 좌표를 수정하지 않는다. 표면 크기는 푸터 검사를 별도로 통과해야 한다.

뷰와 구성의 선언은 [`WKWebViewPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h)와 [`WKWebViewConfigurationPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewConfigurationPrivate.h)에 있다. 현재 프레임워크 생성 경로는 [Wry 0.57.0 `wkwebview/mod.rs`](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/src/wkwebview/mod.rs)에 있다.

### 표면과 모달 웹뷰의 페이지 초점

표면과 모달 웹뷰에는 이 설정을 유지한다. 웹뷰가 첫 응답자가 아닐 때 페이지가 요소에 초점을 주면 WebKit이 UI 프로세스에 `MakeFirstResponder`를 보내고, `PageClientImpl::makeFirstResponder`가 그 웹뷰를 창의 첫 응답자로 만든다. 불러온 뒤 입력칸에 초점을 주는 셸 표면이 열린 메뉴의 키 입력을 가져가 네이티브 Escape가 메뉴를 닫지 못했다. `_setShouldSuppressFirstResponderChanges:YES`이면 `PageClientImpl::makeFirstResponder`가 첫 응답자를 바꾸지 않고 돌아간다. AppKit 클릭과 호스트가 직접 호출하는 `-[NSWindow makeFirstResponder:]`는 영향을 받지 않는다. 메인 페이지는 이 설정을 쓰지 않으며 초점을 옮길 수 있다. 선택자가 없으면 함수가 실패를 반환하고 두 호스트는 웹뷰 생성을 실패로 처리한다.

설정이 없으면 실패하는 [`webview_focus_test.m`](../../native/darwin/tests/webview_focus_test.m)과 [`modal.test.mjs`](../../e2e/modal.test.mjs)의 메뉴 Escape 단계로 검증한다. [`PageClientImplMac.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/PageClientImplMac.mm)의 `PageClientImpl::makeFirstResponder`와 [`WKWebViewPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h)의 선언을 검토한다.

### 문서 영역 데이터 저장소

문서 영역에 이 저장소를 유지한다. 공개 `+[WKWebsiteDataStore dataStoreForIdentifier:]`는 모든 영구 저장소를 앱의 WebKit 컨테이너(`~/Library/WebKit/<bundle>/WebsiteDataStore/<identifier>`)에 두므로, 일회용 `--config-dir`로 실행한 창 검사가 이전 실행과 사용자 자신의 인스턴스의 쿠키를 다시 썼다. `-[_WKWebsiteDataStoreConfiguration initWithDirectory:]`는 데이터 디렉터리가 주어진 디렉터리 아래에 있는 영구 구성을 만들고, `-[WKWebsiteDataStore _initWithConfiguration:]`는 그 구성으로 저장소를 만든다. 이것이 호출자가 고른 디렉터리에 저장소를 두도록 WebKit이 제공하는 인터페이스다. 한 디렉터리의 저장소 객체 둘은 같은 파일을 쓰므로 라이브러리는 프로세스가 끝날 때까지 디렉터리마다 저장소 하나를 유지한다. 디렉터리를 만들 수 없거나 저장소를 초기화할 수 없으면 문서 생성이 실패하고 호스트가 오류를 보고한다.

[`document_view_test.m`](../../native/darwin/tests/document_view_test.m)으로 같은 디렉터리의 문서는 쿠키를 공유하고 다른 디렉터리의 문서는 공유하지 않으며 디렉터리가 있는지 확인하고, [`browser.test.mjs`](../../e2e/browser.test.mjs)의 `document site data lives in the configuration directory`로 확인한다. 선언은 [`_WKWebsiteDataStoreConfiguration.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/_WKWebsiteDataStoreConfiguration.h)와 [`WKWebsiteDataStorePrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebsiteDataStorePrivate.h)에서 검토한다.

### reload 후 WebContent 프로세스 메모리

반복 reload가 남기는 메모리의 측정된 원인은 이 애플리케이션이 아니라 WebKit에 있다. `Document`는 캐시할 수 있는 `querySelectorAll` 호출(단순 class 또는 tag 선택자)의 결과를 `m_querySelectorAllResults`에 담는다. 각 항목은 결과 요소의 `NodeList`를 붙잡고, 요소는 자기 document를 붙잡으며, document teardown은 이 map을 비우지 않는다([`Document.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/Document.cpp)). 그래서 같은 WebContent process에서 reload하면 이전 document가 WebKit의 메모리 압박 해제가 `clearQuerySelectorAllResults`를 부를 때까지 남는다([`MemoryRelease.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/MemoryRelease.cpp)). [`webview_process_test.m`](../../native/darwin/tests/webview_process_test.m)은 class 쿼리 하나로 이를 재현한다: 네 번 reload하면 document가 소유한 표식이 reload마다 약 55 MB씩 남고, 쿼리가 없는 같은 페이지는 남기지 않는다. 애플리케이션 페이지에서는 reload마다 document가 하나씩 더 남았고(여섯 번 뒤 1에서 7), WebKit의 메모리 경고 흉내 뒤 그 수는 1로, physical footprint는 267 MB에서 106 MB로 돌아왔다.

메인 페이지 reload는 예전에 `_killWebContentProcessAndResetState`로 WebContent process를 끝냈다. 이것은 이 메모리를 process와 함께 버렸고, 새 process가 그릴 때까지 창에 페이지가 없었다. WebKit에는 process 하나의 캐시만 비우는 인터페이스가 없다. 그래서 library는 framework가 앱 DOM webview에 설정한 navigation delegate를 감싼다. 모든 메시지는 그 delegate에 그대로 가고, 그 delegate가 문서를 바꾸는 main frame navigation(reload, page 변경, load. fragment 이동은 제외)을 허용하면 감싼 쪽이 `_WKNavigationActionPolicyAllowInNewProcess`로 답한다. 그래서 WebKit은 새 문서를 새 WebContent process에서 열고, 새 page가 commit될 때까지 이전 page를 화면에 둔다([`WebProcessPool.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebProcessPool.cpp)의 `processForNavigationInternal`은 client가 요청하면 process를 바꾼다). commit 뒤에는 `_clearBackForwardCache`를 부른다. WebKit이 뒤로 이동을 위해 이전 page를 그 process에 멈춰 두기 때문이다. 그러면 이전 process는 가진 문서와 함께 끝난다. [`webview_navigation_test.m`](../../native/darwin/tests/webview_navigation_test.m)은 reload와 load마다 새 process를 쓰고 이전 process가 끝나는지, fragment 이동은 process를 유지하는지, framework delegate가 모든 navigation을 결정하는지 검사하고, `e2e/reload-memory.test.mjs`는 두 host에서 같은 것을 검사하며 reload 뒤 page footprint의 상한을 둔다. WebKit을 업데이트할 때마다 `Document.cpp`의 `querySelectorAll` 결과 캐시와 process 교체 결정을 검토한다.

### 마우스 처리 완료

네이티브 마우스 처리가 비동기이므로 런타임과 독립 검사는 `_doAfterProcessingAllPendingMouseEvents:`를 사용한다. 런타임은 누름·뗌 전송 전과 수신 후 대기 중인 작업을 완료한다. 다른 네이티브 뷰 위에서 놓더라도 제스처를 소유한 문서를 기다린다. 기존 목록의 검사 전용 설명은 잘못됐다. 등록 시 선택자가 없으면 거부한다. 등록한 뷰의 전송 전에 선택자가 없으면 해당 오류를 보고하고 이벤트를 보내지 않으며, 수신 후 부재도 완료를 실패시킨다. 기능 부재의 소유 픽스처는 `webview_input_receipts_test`이고 실제 신뢰 이벤트 순서는 `input_inject_test`가 검증한다. V5-115-1-2에서 두 런타임 우회를 제거한다.

[`WKWebViewPrivateForTesting.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivateForTesting.h)의 선언을 검토하고, 이 API나 입력 모듈을 업데이트하면 독립 검사 두 실행을 수행한다.

## 프레임워크 내부 의존성

다음 의존성도 업데이트 시 검토한다. 표면 좌표나 겹친 입력을 수정하기 위한 앱 보완 코드에 해당하지 않는다.

| API 또는 키 | 현재 사용과 필요성 | 업데이트 후 검토 |
| --- | --- | --- |
| `WKPreferences` KVC `developerExtrasEnabled` (`_setDeveloperExtrasEnabled:`) | 내장 개발자 도구. Wry는 개발자 도구가 켜지면 이 키와 macOS 13.3 이상의 공개 `WKWebView.inspectable`을 설정한다. Tauri는 디버그 빌드에서 개발자 도구를 켜며 이 크레이트는 릴리스 `devtools`를 활성화하지 않는다. Wails v3.0.0-beta.27은 macOS 13.3 이상에서 공개 `inspectable`만 설정하고, 이 키는 그보다 이전 macOS에서 `private_mac_apis` 빌드 태그가 있는 빌드에서만 사용한다. 앱은 이 태그를 설정하지 않으므로 Wails 빌드는 Web Inspector를 창 안이 아니라 Safari를 통해 제공한다. | 실제 빌드 플래그, 웹뷰 생성, 검사기 사용 가능 여부를 확인한다. 디버깅 의존성이며 렌더링 수정이 아니다. |
| `WKWebView._inspector`; `_WKInspector.show`, `close`, `isVisible` | 프레임워크 개발자 도구 명령. Wry는 `show`, `close`, `isVisible`을 사용한다. Wails v3.0.0-beta.27은 `private_mac_apis` 빌드 태그가 있는 빌드에서만 `show`를 호출한다. 앱이 이 선택자들을 직접 호출하지 않는다. | 해당 개발자 도구 명령을 포함한 빌드에서 열기·닫기·상태를 확인한다. |
| `WKPreferences` KVC `allowsPictureInPictureMediaPlayback` (`_setAllowsPictureInPictureMediaPlayback:`) | Wry 0.57.0이 웹뷰 생성 시 조건 없이 설정한다. 앱이 비공개 미디어 수정을 요청하는 것은 아니다. | 웹뷰 생성과 변경된 프레임워크 구현을 확인한다. 현재 네이티브 검사는 화면 속 화면 동작을 포함하지 않는다. |
| `NSView._wantsKeyDownForEvent:` | Tao 0.37.1이 콘텐츠 뷰에서 이 선택자를 구현하고 Control-Tab·Control-Escape 수신을 위해 `YES`를 반환한다. 앱이 같은 재정의를 추가하지 않는다. | Tao·AppKit 업데이트 후 네이티브 키보드 전달과 응답자 체계를 확인한다. 현재 네이티브 검사는 이 두 단축키를 별도로 검증하지 않는다. |

호출은 [Wry `wkwebview/mod.rs`](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/src/wkwebview/mod.rs)와, `private_mac_apis` 태그가 있는 빌드에 한해 [Wails `mac_private_api_darwin.go`](https://github.com/wailsapp/wails/blob/v3.0.0-beta.27/v3/pkg/application/mac_private_api_darwin.go)에 있다. 키보드 재정의는 [Tao `macos/view.rs`](https://github.com/tauri-apps/tao/blob/tao-v0.37.1/src/platform_impl/macos/view.rs)에 있다. 환경설정 선언은 [`WKPreferencesPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKPreferencesPrivate.h)에 있다.

목록은 활성 경로와 사용 조건을 명시한 앱 경로를 기록하며 의존성 소스의 모든 비공개 API를 나열하지 않는다. 예를 들어 Wry는 현재 macOS에서 공개 전체화면 환경설정을 사용하므로 이전 OS의 `fullScreenEnabled` 분기는 여기서 실행되지 않는다. 지원 OS 범위, 빌드 플래그, 프레임워크 구성이 바뀌면 소스를 다시 점검한다. 공개 속성에 KVC로 접근하는 것 자체는 비공개 API가 아니다.

## 공개 Dock 메뉴 연동

[`dock_menu.m`](../../native/darwin/src/dock_menu.m)은 공개 `NSApplicationDelegate.applicationDockMenu:` 콜백과 새 창용 `NSMenu` 동작을 등록한다. 두 호스트는 Dock 메뉴 등록 API를 제공하지 않는다. 앱은 공개 Objective-C 런타임의 `class_addMethod`로 없는 콜백을 추가하며 프레임워크 델리게이트나 기존 메서드를 교체하지 않는다. 델리게이트가 없거나 이미 콜백을 구현하면 등록에 실패한다. Wails·Tauri 콜백은 AppKit 콜백 밖에서 기존 공개 창 생성 API를 실행한다. 비공개 셀렉터나 프레임워크 포크는 추가하지 않는다.

프레임워크 업데이트 후 해당 콜백이나 Dock 메뉴 API를 제공하는지 확인한다. 모든 창을 닫은 경우를 포함해 메뉴 항목과 라이브러리 창 생성을 검사한다. 이 연동은 앱 메뉴에 관한 것이며 표면 렌더링이나 웹뷰 입력에 관한 것이 아니다.

## 네이티브 입력 주입

[`input_inject.m`](../../native/darwin/src/input_inject.m)은 애플리케이션을 활성화하지 않고 창에 포인터와 키 입력을 전달한다. 스크롤을 제외하고 다음 조건으로 공개 AppKit 호출을 사용한다.

- 키: `+[NSEvent keyEventWithType:...]`와 `-[NSWindow sendEvent:]`. 키 창이 아닌 창에서도 포커스된 요소가 키를 받는다.
- 포인터 누름·끌기·뗌: `hitTest:`가 반환한 뷰의 이벤트 메서드(`mouseDown:`, `mouseDragged:`, `mouseUp:`, 오른쪽 버튼 메서드). AppKit은 비활성 창의 누름을 첫 클릭으로 처리해 뷰에 전달하지 않으므로 `-[NSWindow sendEvent:]`를 사용하지 않는다.
- 포인터 이동: 히트 뷰부터 상위로 올라가며 좌표를 포함하는 첫 추적 영역 소유자의 `mouseMoved:`. WebKit은 활성 페이지에서만 호버를 갱신한다. `WebFrame::handleMouseEvent`는 `FocusController::isActive()`가 아니면 버튼 없는 이동을 `passMouseMovedEventToScrollbars`로 넘기며, 이 상태는 `PageClientImpl::isViewWindowActive`(창의 `isKeyWindow`)에서만 온다. 이 값을 설정하는 WebKit 인터페이스는 없다. 따라서 `sp_input_pointer`는 키 창이 아닌 창의 이동에 `SP_INPUT_INACTIVE`를 반환하며 키 상태를 흉내 내지 않는다.
- 활성화: `sp_input_activate`는 `-[NSWindow makeKeyAndOrderFront:]`와 `-[NSApplication activate]`를 호출하고, 키 창 알림과 앱 활성 알림을 모두 확인한 뒤, 다음 메인 큐 차례에 창의 모든 보이는 웹뷰에 `_doAfterActivityStateUpdate:`를 호출한다. 숨겨진 웹뷰는 입력 대상이 아니므로 명시적 활성화를 막지 않는다. 이 콜백은 WebKit이 예약된 활성 상태를 보낸 뒤(`WebPageProxy::dispatchActivityStateChange`) 실행되므로, 이후 마우스 이벤트는 같은 연결에서 그 상태 다음에 웹 프로세스에 도착한다. 시스템은 활성화를 거절할 수 있고, 다른 애플리케이션이나 창이 포커스를 가져갈 수 있다. 함수는 멈춘 단계(`sp_activate_result`)와 최전면 애플리케이션을 보고하며, `tests/input_activate_test.m`이 각 조건을 만들어 검사한다.
- 스크롤: **비공개 CoreGraphics 사용.** 창 정보를 가진 스크롤 `NSEvent`를 만드는 공개 API가 없다. 코드는 `CGEventCreateScrollWheelEvent2`로 이벤트를 만들고 문서화되지 않은 창 번호 필드(`CGEventField` 51)와 비공개 함수 `CGEventSetWindowLocation`을 설정한 뒤 `+[NSEvent eventWithCGEvent:]`로 변환한다. 변환 결과는 `window`와 `locationInWindow`를 가지며 `-[NSWindow sendEvent:]`가 좌표의 뷰에 전달한다. 변환한 이벤트에 창이 없으면 입력을 거부한다. 필드 51만 설정하면 좌표가 틀리고, `CGEventSetWindowLocation`만 호출하면 창이 없다. `CGEventPostToPid`는 비활성 애플리케이션에 스크롤을 전달하지 못했다.

실패 증상: `tests/input_inject_test.m`이 포인터 이벤트 누락·비신뢰·위치 오류, 휠 이벤트 없음, 요청한 120픽셀과 다른 스크롤 거리, 클릭 후 포커스 상실을 보고한다. OS나 WebKit 업데이트 후 `make -C native/darwin test`와 `make -C native/darwin test-activation`(키보드 포커스를 가져감)을 실행한다. 공개 방법으로 창 정보를 가진 스크롤 이벤트를 만들 수 있게 되면 비공개 스크롤 호출을 교체한다.

## 업데이트 검토 절차

1. 변경 전후 앱 리비전, OS·빌드, 설치된 WebKit 버전, SDK·도구 체인, 확정된 프레임워크 리비전을 기록한다. 모든 네이티브 업데이트 후 실패를 진단할 때 이 목록부터 확인한다.
2. 증상에 해당하는 항목을 확인한다. 변경된 소스의 대상 클래스, 선택자·키, 인자·콜백 타입, 가용성, 스레드와 실제 의미를 비교한다. 앱이 공개 래퍼를 사용해도 프레임워크 호출부를 확인한다. 소스 검토로 조사 범위를 좁히되 실패를 재현한 뒤 원인을 확정한다.
3. 필요성을 다시 판단한다. 수정 없이 필요한 동작이 정확히 구현되면 해당 수정을 제거한다. 동작 계약을 유지하고 해롭거나 불필요한 코드를 제거한다. 실패를 감추기 위한 호환 분기, 고정 지연, 정밀도 축소, 배경색 변경을 추가하지 않는다.
4. [빌드·검증 절차](examples.ko.md)에 따라 두 호스트를 다시 빌드하고 재실행한 뒤 관련 검사와 `make examples-verify`를 실행한다. 입력 의존성이 바뀌면 `make -C native/darwin test`와 `make -C native/darwin test-activation`도 실행한다. 실제 제스처와 픽셀을 검증한다. 실행할 수 없는 플랫폼과 생략한 검사는 명시한다.
5. API 추가·교체·제거 또는 호출 조건 변경과 같은 변경에서 이 목록과 한국어 번역을 갱신한다. 동작 변경과 새 검증 결과는 [기능 상태](../features.ko.md)와 [변경 기록](../../CHANGELOG.ko.md)에 기록한다. `make docs-check`를 실행하며 소스 검토로 목록의 정확성도 확인한다.

필요성은 개별 수정에 대해 판단한다. 비공개라는 사실만으로 수정을 부정하지 않으며 테스트 통과만으로 설계를 정당화하지 않는다. 새 항목에는 구체적인 원인, 공개 API의 한계, 정확한 구현 위치와 범위, 실패 징후, 검증 절차가 필요하다.

## 검토 기준

소스·필요성 검토일은 2026-09-08이며 프로젝트 창 통합을 포함한다. 프레임워크 업데이트 검토일은 2026-10-04이다. 환경은 macOS 26.6.2 (25G83), WebKit `21624.5.1.11.3`, SDK 27.0을 보고한다. 의존성은 Wails `v3.0.0-beta.27`, crates.io의 Tauri `2.12.1`과 `tauri-runtime-wry` `2.12.1`, Wry `0.57.0`, Tao `0.37.1`이며 [`go.mod`](../../packages/host/wailsv3/go.mod), [`Cargo.toml`](../../Cargo.toml), [`Cargo.lock`](../../Cargo.lock)에 따라 확정한다.

Wails v3.0.0-beta.19는 비공개 WebKit 호출(웹뷰 투명화, `backgroundColor` 키, 창 안 검사기)을 `private_mac_apis` 빌드 태그 뒤로 옮겼다. 태그가 없으면 Wails는 창의 배경색을 공개 `underPageBackgroundColor`로 설정하고, 앱의 메인 웹뷰 구성이 이전과 같이 이를 투명색으로 바꾼다. Tauri 2.12.1은 `macos-private-api` 기능 없이 창의 `transparent` 설정을 Wry에 전달한다. 앱은 투명 창을 설정하지 않으며, Wry 0.57.0은 macOS 웹뷰 생성 경로 중 `window.ipc` 스크립트만 바꿨다. 이제 IPC 처리기가 있는 웹뷰에만 이 스크립트를 넣는다. 앱의 수정은 바뀌지 않았다.

프로젝트 창은 비공개 선택자를 추가하지 않는다. 공개 프레임워크 API로 독립 창을 생성하고 호출한 창을 식별한다. 공개 파일시스템 API로 설정을 저장한다. 기존의 비공개 좌표·표시·포인터·투명도 수정은 명시한 목적에 계속 필요하다. 해당 호스트 상태와 수명은 각 프로젝트 창에서 관리한다. 네이티브 마우스 모니터는 창을 닫을 때 제거한다.

프로젝트 창 통합 후 독립 겹친 입력 검사의 기준 실행과 등록 실행이 통과했으며 라이브러리 변경은 해당 입력 코드를 수정하지 않는다. 다시 빌드한 macOS 호스트의 라이브러리 검증은 예제 검사 39개 통과, 실패 0개, 화면 전환 검사 2개 생략으로 완료했다. 독립 프로젝트 창, 라이브러리 창 재사용, Dock 동작, 동시 중복 열기, 모달 분리, 소수점 렌더링, 네이티브 입력을 포함한다. 앱 종료 시 설정을 저장하고 시작 시 저장된 프로젝트를 라이브러리에 표시한다. [기능 상태](../features.ko.md)에 검증 결과와 플랫폼 제한을 기록한다. 소스 링크는 검토 위치를 제공하며 최신 소스의 선언만으로 설치된 WebKit 빌드가 같은 구현을 포함한다고 판단하지 않는다.
