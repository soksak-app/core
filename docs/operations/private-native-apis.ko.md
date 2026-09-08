# 비공개 네이티브 API 목록

[English](private-native-apis.md)

네이티브 소스, 프레임워크 의존성, SDK, macOS 또는 WebKit 런타임 업데이트 후 네이티브 동작에 문제가 생기면 이 문서를 가장 먼저 검토한다. 업데이트 전에도 검토한다. 의존성을 먼저 확인한다는 사실만으로 실패 원인을 확정하지 않는다.

이 문서는 현재 macOS 호스트의 앱 호출, 진단 호출, 사용하는 프레임워크 내부 비공개 경로를 관리하는 정본이다. 공통 배치 라이브러리에는 네이티브 API 의존성이 없다. Windows와 Linux 네이티브 실행은 검증하지 않았다.

## 현재 목록

| API 또는 키 | 호출 위치와 범위 | 목적 |
| --- | --- | --- |
| `WKWebView._setOverrideDeviceScaleFactor:` | 두 호스트의 [`webview_geometry_darwin.m`](../../examples/native/webview_geometry_darwin.m), `webviewAttachSurface` | 장치 픽셀 컨테이너의 로컬 한 단위를 backing 픽셀 하나로 렌더링 |
| `WKWebView._doAfterNextPresentationUpdate:` | 두 호스트의 [`surface_layout_darwin.m`](../../examples/native/surface_layout_darwin.m), `surfaceLayoutAfterPresentation`; 프로브와 독립 입력 검사에서도 사용 | 네이티브 좌표 커밋 또는 렌더링 결과 측정 전에 웹뷰 표시 완료 확인 |
| `WKWebView._setIgnoresMouseMoveEvents:` | 두 호스트의 [`webview_input_darwin.m`](../../examples/native/webview_input_darwin.m), 등록·포인터 처리·제거 | 겹친 웹뷰의 포인터 추적을 AppKit 히트테스트 결과로 제한 |
| `WKWebView` KVC `drawsBackground` (`_drawsBackground` / `_setDrawsBackground:`) | Wails [`webview_darwin.m`](../../examples/wailsv3/webview_darwin.m)의 모달 생성; 두 호스트 [`window_probe_darwin.m`](../../examples/native/window_probe_darwin.m)의 진단 조회 | 모달 웹뷰의 불투명 배경 비활성화 및 상태 조회 |
| `WKWebViewConfiguration` KVC `drawsBackground` (`_setDrawsBackground:`) | Tauri → Wry 웹뷰 생성; [`overlay_show`](../../examples/tauriv2/src-tauri/src/main.rs)가 `background_color(Color(0, 0, 0, 0))` 요청; 메인도 배경색 설정 | 웹뷰 초기화 전에 배경 그리기 설정 |
| `WKWebView._doAfterProcessingAllPendingMouseEvents:` | [`native-tests/webview-input.m`](../../examples/native-tests/webview-input.m)의 `drain`; 독립 검사 전용 | DOM 이벤트 횟수를 검사하기 전에 네이티브 마우스 처리 완료 대기 |

두 `drawsBackground` 항목의 대상 객체는 다르다. Wails는 생성된 뷰를 변경하고, Wry는 생성 전 구성을 변경한다. 프레임워크의 공개 Rust·Go 진입점도 비공개 네이티브 의존성을 포함할 수 있다.

## 필요성 검토

### 장치 배율

이 수정을 유지한다. 네이티브 높이에 0.5pt가 포함되면 문서 배치 전에 네이티브 그리기 크기가 정수로 변환되어 빈 영역이 발생했다. 장치 픽셀 컨테이너는 배치 정밀도를 낮추지 않고 정수 로컬 크기를 제공한다. 공개 `pageZoom`은 CSS 크기를 유지하지만 해당 로컬 좌표의 backing 밀도를 독립적으로 설정하지 않는다. `_setOverrideDeviceScaleFactor:1`은 각 콘텐츠 웹뷰를 등록할 때 한 번 그 밀도를 설정하며, 이후 화면 배율 변경은 컨테이너와 페이지 줌으로 처리한다. 메인과 모달 웹뷰에는 이 수정을 적용하지 않는다.

업데이트 후 선택자의 시그니처와 사용자 지정 배율·기본 배율의 의미를 검토한다. 의미가 변경되면 CSS 크기, 렌더링 밀도 또는 입력 좌표가 잘못될 수 있다. [`footer.test.mjs`](../../examples/test/footer.test.mjs)와 [`geometry.test.mjs`](../../examples/test/geometry.test.mjs)로 실제 0.5pt 문서 영역, 마지막 장치 픽셀, 창 크기 변경, 2×↔1× 화면 전환을 검증한다. 좌표 계약은 [네이티브 표면](../spec/native-surfaces.ko.md)에 정의한다.

선언은 [`WKWebViewPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h)에 있다. 구현은 [`WebPageProxy.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp)의 `WebPageProxy::setCustomDeviceScaleFactor`와 `deviceScaleFactor`를 사용한다.

### 표시 완료

이 수정을 유지한다. JavaScript 실행이나 DOM 애니메이션 프레임 콜백의 완료는 각 웹뷰가 새 문서 좌표를 표시했다는 확인이 아니다. 호스트는 해당 프로젝트 창의 메인과 표시 중인 앱 문서를 기다린 뒤 네이티브 트랜잭션을 커밋한다. `CATransaction`은 UI 스레드에 속하므로 서로 다른 창의 준비를 직렬화하며, 탐색과 닫기는 해당 창의 준비만 취소한다. 외부 문서는 참여하지 않으므로 외부 렌더러의 긴 작업이 메인 창 배치를 중단시키지 않는다.

콜백 시점, 그리기 완료, 탐색·프로세스 종료 중 동작을 검토한다. 구현은 실행 중인 프로세스나 그리기 영역이 없으면 즉시 완료할 수 있으므로 콜백만으로 캡처된 픽셀을 확인한 것으로 처리하지 않는다. 문서 준비 확인과 전체 녹화가 계속 필요하다. 외부 문서의 700ms 작업과 다시 로드 후 정리를 포함해 [`outside.test.mjs`](../../examples/test/outside.test.mjs), [`paint.test.mjs`](../../examples/test/paint.test.mjs), [`hosts.test.mjs`](../../examples/test/hosts.test.mjs)를 검증한다. [`projects.test.mjs`](../../examples/test/projects.test.mjs)는 독립 프로젝트 창, 모달 전달, 닫기·다시 열기 정리도 검증한다.

[`WKWebView.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm)의 `_doAfterNextPresentationUpdate:`와 [`WebPageProxy.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp)의 `WebPageProxy::callAfterNextPresentationUpdate`를 검토한다.

### 포인터 추적

이 수정을 유지한다. 겹친 네이티브 추적 영역은 여러 웹뷰에 이동 이벤트를 전달할 수 있다. 공개 AppKit 히트테스트로 뷰를 선택하는 것만으로 다른 웹뷰의 추적을 비활성화할 수 없다. 공통 모듈은 히트테스트 결과에 따라 비공개 플래그를 적용한다. 키보드·클릭·드래그 처리를 비활성화하거나 키보드 포커스를 변경하거나 네이티브 이벤트를 DOM 이벤트로 대체하지 않는다.

비공개 플래그는 마우스 진입·이탈 처리에도 영향을 준다. 로컬 모니터는 이동·진입 이벤트에서 선택 대상을 변경하며 이탈 이벤트에서는 변경하지 않는다. 이탈 이벤트가 항상 허용된다고 서술하면 안 된다. 선택자를 사용할 수 없으면 등록이 실패하며, 제거 시 플래그를 초기화한다. 업데이트 후 추적 영역 동작, 이벤트 순서, hover 해제, 숨김·제거, 키보드 입력 유지를 검토한다. 이 API는 WebKit에 이미 제출한 작업을 취소하지 않는다. 유지 중인 검사는 지연된 커서 응답을 검증하지 않는다.

[독립 입력 검사](examples.ko.md#진단)의 기준 실행과 등록 실행, [`modal.test.mjs`](../../examples/test/modal.test.mjs)를 사용한다. [`WKWebViewMac.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/mac/WKWebViewMac.mm)의 `_setIgnoresMouseMoveEvents:`와 [`WebViewImpl.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm)의 추적 처리를 검토한다.

### 투명 배경

모달 투명도를 위해 이 수정을 유지한다. 투명한 DOM 콘텐츠만으로 불투명 웹뷰 아래의 네이티브 콘텐츠를 표시할 수 없다. 공개 `underPageBackgroundColor`는 페이지 콘텐츠 뒤의 색상을 설정하며, CSS 투명도와 해당 색상 설정만으로 네이티브 배경 그리기를 비활성화하지 않는다. 비공개 `drawsBackground` 상태가 이 별도 요구사항을 처리한다. 50% 반투명 배경과 블러는 [네이티브 모달](../spec/native-modals.ko.md)에 정의한 CSS 동작이다.

정확한 KVC 키, 대상 클래스, 생성 전 구성과 생성 후 뷰 설정의 효과를 검토한다. Wails는 대입 결과를 확인하며 KVC 예외가 발생하거나 불투명 상태가 유지되면 뷰 생성이 실패한다. 진단 조회 자체에는 같은 예외 처리가 없다. 좌표와 표시 선택자도 직접 호출한다. 모든 비공개 API 누락이 처리된 오류로 반환된다고 가정하면 안 된다.

[`modal.test.mjs`](../../examples/test/modal.test.mjs)와 [수동 인수](examples.ko.md#수동-인수)로 초기 투명도, 캡처된 반투명 배경·블러, 설정 탐색 후 선명한 콘텐츠, 배경 효과 없는 메뉴, 닫기·다시 로드 후 정리를 검증한다. 투명도는 소수점 좌표를 수정하지 않는다. 표면 크기는 푸터 검사를 별도로 통과해야 한다.

뷰와 구성의 선언은 [`WKWebViewPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h)와 [`WKWebViewConfigurationPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewConfigurationPrivate.h)에 있다. 현재 프레임워크 생성 경로는 [Wry 0.56.1 `wkwebview/mod.rs`](https://github.com/tauri-apps/wry/blob/wry-v0.56.1/src/wkwebview/mod.rs)에 있다.

### 독립 검사의 마우스 처리 완료

독립 검사에서 `_doAfterProcessingAllPendingMouseEvents:`를 유지한다. 네이티브 마우스 처리는 비동기이므로 이벤트 제출 직후 JavaScript로 조회하면 처리 전 횟수를 읽을 수 있다. 이 콜백은 고정 지연 없이 완료를 확인한다. 간섭을 생성하는 API가 아니며 앱 런타임에 포함하지 않는다. 선택자가 없거나 완료 제한 시간을 초과하면 검사는 실패한다.

[`WKWebViewPrivateForTesting.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivateForTesting.h)의 선언을 검토하고, 이 API나 입력 모듈을 업데이트하면 독립 검사 두 실행을 수행한다.

## 프레임워크 내부 의존성

다음 의존성도 업데이트 시 검토한다. 표면 좌표나 겹친 입력을 수정하기 위한 앱 보완 코드에 해당하지 않는다.

| API 또는 키 | 현재 사용과 필요성 | 업데이트 후 검토 |
| --- | --- | --- |
| `WKPreferences` KVC `developerExtrasEnabled` (`_setDeveloperExtrasEnabled:`) | 내장 개발자 도구. Wails의 현재 빌드 대상은 크기 최적화 대상에서도 `production` 빌드 태그를 설정하지 않아 개발자 도구를 활성화한다. Tauri는 디버그 빌드에서 활성화하며 이 크레이트는 릴리스 `devtools`를 활성화하지 않는다. | 실제 빌드 플래그, 웹뷰 생성, 검사기 사용 가능 여부를 확인한다. 디버깅 의존성이며 렌더링 수정이 아니다. |
| `WKWebView._inspector`; `_WKInspector.show`, `close`, `isVisible` | 프레임워크 개발자 도구 명령. Wails는 `show`를 사용하고 Wry는 `show`, `close`, `isVisible`을 사용한다. 앱이 이 선택자들을 직접 호출하지 않는다. | 해당 개발자 도구 명령을 포함한 빌드에서 열기·닫기·상태를 확인한다. |
| `WKPreferences` KVC `allowsPictureInPictureMediaPlayback` (`_setAllowsPictureInPictureMediaPlayback:`) | Wry 0.56.1이 웹뷰 생성 시 조건 없이 설정한다. 앱이 비공개 미디어 수정을 요청하는 것은 아니다. | 웹뷰 생성과 변경된 프레임워크 구현을 확인한다. 현재 네이티브 검사는 화면 속 화면 동작을 포함하지 않는다. |
| `NSView._wantsKeyDownForEvent:` | Tao 0.37.0이 콘텐츠 뷰에서 이 선택자를 구현하고 Control-Tab·Control-Escape 수신을 위해 `YES`를 반환한다. 앱이 같은 재정의를 추가하지 않는다. | Tao·AppKit 업데이트 후 네이티브 키보드 전달과 응답자 체계를 확인한다. 현재 네이티브 검사는 이 두 단축키를 별도로 검증하지 않는다. |

호출은 [Wry `wkwebview/mod.rs`](https://github.com/tauri-apps/wry/blob/wry-v0.56.1/src/wkwebview/mod.rs)와 [Wails `webview_window_darwin_dev.go`](https://github.com/wailsapp/wails/blob/v3.0.0-beta.16/v3/pkg/application/webview_window_darwin_dev.go)에 있다. 키보드 재정의는 [Tao `macos/view.rs`](https://github.com/tauri-apps/tao/blob/tao-v0.37.0/src/platform_impl/macos/view.rs)에 있다. 환경설정 선언은 [`WKPreferencesPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKPreferencesPrivate.h)에 있다.

목록은 활성 경로와 사용 조건을 명시한 앱 경로를 기록하며 의존성 소스의 모든 비공개 API를 나열하지 않는다. 예를 들어 Wry는 현재 macOS에서 공개 전체화면 환경설정을 사용하므로 이전 OS의 `fullScreenEnabled` 분기는 여기서 실행되지 않는다. 지원 OS 범위, 빌드 플래그, 프레임워크 구성이 바뀌면 소스를 다시 점검한다. 공개 속성에 KVC로 접근하는 것 자체는 비공개 API가 아니다.

## 공개 Dock 메뉴 연동

[`dock_menu_darwin.m`](../../examples/native/dock_menu_darwin.m)은 공개 `NSApplicationDelegate.applicationDockMenu:` 콜백과 새 창용 `NSMenu` 동작을 등록한다. 두 호스트는 Dock 메뉴 등록 API를 제공하지 않는다. 앱은 공개 Objective-C 런타임의 `class_addMethod`로 없는 콜백을 추가하며 프레임워크 델리게이트나 기존 메서드를 교체하지 않는다. 델리게이트가 없거나 이미 콜백을 구현하면 등록에 실패한다. Wails·Tauri 콜백은 AppKit 콜백 밖에서 기존 공개 창 생성 API를 실행한다. 비공개 셀렉터나 프레임워크 포크는 추가하지 않는다.

프레임워크 업데이트 후 해당 콜백이나 Dock 메뉴 API를 제공하는지 확인한다. 모든 창을 닫은 경우를 포함해 메뉴 항목과 라이브러리 창 생성을 검사한다. 이 연동은 앱 메뉴에 관한 것이며 표면 렌더링이나 웹뷰 입력에 관한 것이 아니다.

## 업데이트 검토 절차

1. 변경 전후 앱 리비전, OS·빌드, 설치된 WebKit 버전, SDK·도구 체인, 확정된 프레임워크 리비전을 기록한다. 모든 네이티브 업데이트 후 실패를 진단할 때 이 목록부터 확인한다.
2. 증상에 해당하는 항목을 확인한다. 변경된 소스의 대상 클래스, 선택자·키, 인자·콜백 타입, 가용성, 스레드와 실제 의미를 비교한다. 앱이 공개 래퍼를 사용해도 프레임워크 호출부를 확인한다. 소스 검토로 조사 범위를 좁히되 실패를 재현한 뒤 원인을 확정한다.
3. 필요성을 다시 판단한다. 수정 없이 필요한 동작이 정확히 구현되면 해당 수정을 제거한다. 동작 계약을 유지하고 해롭거나 불필요한 코드를 제거한다. 실패를 감추기 위한 호환 분기, 고정 지연, 정밀도 축소, 배경색 변경을 추가하지 않는다.
4. [빌드·검증 절차](examples.ko.md)에 따라 두 호스트를 다시 빌드하고 재실행한 뒤 관련 검사와 `make examples-verify`를 실행한다. 입력 의존성이 바뀌면 독립 입력 검사 두 실행도 수행한다. 실제 제스처와 픽셀을 검증한다. 실행할 수 없는 플랫폼과 생략한 검사는 명시한다.
5. API 추가·교체·제거 또는 호출 조건 변경과 같은 변경에서 이 목록과 한국어 번역을 갱신한다. 동작 변경과 새 검증 결과는 [기능 상태](../features.ko.md)와 [변경 기록](../../CHANGELOG.ko.md)에 기록한다. `make docs-check`를 실행하며 소스 검토로 목록의 정확성도 확인한다.

필요성은 개별 수정에 대해 판단한다. 비공개라는 사실만으로 수정을 부정하지 않으며 테스트 통과만으로 설계를 정당화하지 않는다. 새 항목에는 구체적인 원인, 공개 API의 한계, 정확한 구현 위치와 범위, 실패 징후, 검증 절차가 필요하다.

## 검토 기준

소스·필요성 검토일은 2026-09-08이며 프로젝트 창 통합을 포함한다. 환경은 macOS 26.6.2 (25G83), WebKit `21624.5.1.11.3`, SDK 15.2를 보고한다. 의존성은 Wails `v3.0.0-beta.16`, Tauri 리비전 `270c63f117eb1f4ff0a653ca63b2ca61e9175663`, Wry `0.56.1`, Tao `0.37.0`으로 유지하며 [`go.mod`](../../examples/wailsv3/go.mod), [`Cargo.toml`](../../examples/tauriv2/src-tauri/Cargo.toml), [`Cargo.lock`](../../examples/tauriv2/src-tauri/Cargo.lock)에 따라 확정한다.

프로젝트 창은 비공개 선택자를 추가하지 않는다. 공개 프레임워크 API로 독립 창을 생성하고 호출한 창을 식별한다. 공개 파일시스템 API로 설정을 저장한다. 기존의 비공개 좌표·표시·포인터·투명도 수정은 명시한 목적에 계속 필요하다. 해당 호스트 상태와 수명은 각 프로젝트 창에서 관리한다. 네이티브 마우스 모니터는 창을 닫을 때 제거한다.

프로젝트 창 통합 후 독립 겹친 입력 검사의 기준 실행과 등록 실행이 통과했으며 라이브러리 변경은 해당 입력 코드를 수정하지 않는다. 다시 빌드한 macOS 호스트의 라이브러리 검증은 예제 검사 39개 통과, 실패 0개, 화면 전환 검사 2개 생략으로 완료했다. 독립 프로젝트 창, 라이브러리 창 재사용, Dock 동작, 동시 중복 열기, 모달 분리, 소수점 렌더링, 네이티브 입력을 포함한다. 앱 종료 시 설정을 저장하고 시작 시 저장된 프로젝트를 라이브러리에 표시한다. [기능 상태](../features.ko.md)에 검증 결과와 플랫폼 제한을 기록한다. 소스 링크는 검토 위치를 제공하며 최신 소스의 선언만으로 설치된 WebKit 빌드가 같은 구현을 포함한다고 판단하지 않는다.
