# Linux 호스트 제안

[English](linux-host.md)

상태: 체크리스트 항목 R2-7 의 미결 제안([기능](../features.ko.md)의 R2-7-3). 이 제안의 어떤 내용도 구현되지 않았다. 승인된 내용은 구현 항목을 시작하기 전에 명세([호스트](../spec/hosts.ko.md), [네이티브 표면](../spec/native-surfaces.ko.md), [표면 합성](../spec/surface-composition.ko.md), [사이드카](../spec/sidecars.ko.md), [터미널 런타임](../spec/terminal-runtime.ko.md))로 옮기고, 그 뒤 이 파일을 제거한다.

framework, toolkit, 시스템 인터페이스에 관한 모든 진술은 [출처](#출처)의 출처를 `[Sn]` 으로 인용한다. **unverified** 로 표시한 진술은 그것을 입증하는 출처가 없으며, 그 진술에 의존하는 항목이 측정해야 한다. macOS 메커니즘은 [`platform.go`](../../packages/host/wailsv3/src/platform/platform.go), [`platform.rs`](../../packages/host/tauriv2/src/platform/platform.rs), [`native/darwin/src`](../../native/darwin/src/)와 [비공개 네이티브 API 목록](../operations/private-native-apis.ko.md)에서 읽었다.

## Linux 의 프레임워크 사실

### Wails v3.0.0-beta.27

- 기본 Linux build 는 GTK4 와 WebKitGTK 6.0 을 쓴다: `linux_cgo.go` 의 build constraint 는 `linux && cgo && !gtk3` 이고 지시문은 `#cgo linux pkg-config: gtk4 webkitgtk-6.0` 이다 [S1].
- GTK3 와 WebKitGTK 4.1 은 `gtk3` build tag 를 줄 때만 쓴다: `linux_cgo_gtk3.go` 의 constraint 는 `linux && cgo && gtk3` 이고 지시문은 `#cgo linux pkg-config: gtk+-3.0 webkit2gtk-4.1 gdk-3.0` 이다 [S2]. 같은 release 의 benchmark 설명은 GTK3 build 를 "legacy, opt-in via -tags gtk3, removed in v3.1" 이라고 적는다 [S3].
- 네이티브 핸들: `WebviewWindow.NativeWindow()` 는 `impl.nativeWindow()` 를 반환하고, Linux 에서 그 값은 `linuxWebviewWindow` 의 `window` 필드인 `GtkWindow` 포인터다. 같은 struct 는 `webview` 와 `vbox` 포인터도 갖지만 export 하지 않는다 [S4]. GTK3 build 의 `windowNew` 는 세로 `GtkBox` 를 만들어 창에 넣고 `webkit_web_view_new_with_user_content_manager` 로 `WebKitWebView` 를 만든다 [S5]. 따라서 호스트는 받은 `GtkWindow` 의 자식을 따라가야만 `WebKitWebView` 에 닿으며, 이는 지금 macOS 호스트가 content view 를 따라가는 방식(`MainWebview`)과 같다.
- Wails 는 어느 플랫폼에도 child-webview API 가 없다([호스트](../spec/hosts.ko.md#허용-차이)의 허용 차이 H4). Linux 에서도 호스트는 macOS 의 `webview.m` 처럼 표면, 모달, 문서 webview 를 C 로 만든다.

### Tauri v2.12.1 (tao 0.37.1, wry 0.57.0)

- Linux 의 Tauri 는 GTK3 와 WebKitGTK 4.1 만 쓴다. wry 는 Linux target 에서 `gtk` 0.18 과 기능 `v2_38` 의 `webkit2gtk` =2.0.2 에 의존한다 [S6]. `webkit2gtk-sys` 2.0.2 는 시스템 라이브러리 `webkit2gtk-4.1` 을 링크한다 [S7]. tao 는 `gtk` 0.18 에 의존한다 [S8]. `gtk-sys` 0.18 은 `gtk+-3.0` 을 링크한다 [S13]. 이 crate 버전들에는 GTK4 변형이 없다([S6], [S8]에 GTK4 의존성이 없다).
- 네이티브 핸들: tao 의 `WindowExtUnix::gtk_window()` 는 `&gtk::ApplicationWindow` 를, `default_vbox()` 는 `Option<&gtk::Box>` 를 반환한다 [S8]. Tauri 는 이를 `Window::gtk_window()` 와 `Window::default_vbox()` 로 노출한다 [S12]. `Webview::with_webview` 는 `PlatformWebview` 를 주며, Linux 에서 그 `inner()` 는 `webkit2gtk::WebView` 다 [S12]. wry 의 `WebViewExtUnix::webview()` 도 같은 타입을 반환한다 [S9].
- 자식 webview: Linux 에서 `tauri-runtime-wry` 는 `WindowChild` webview 를 `build_gtk(window.default_vbox())` 로 만들고 [S11], wry 는 `GtkBox` 안에 만든 webview 를 `pack_start(webview, true, true, 0)` 로 넣는다 [S10]. wry 는 `set_bounds` 를 `GtkFixed` 안의 webview 나 X11 자식 창에만 적용한다 [S10]. 따라서 Tauri 의 `add_child` 로 만든 webview 는 box 안에 쌓이며 호스트가 준 영역을 따르지 않는다. `build_as_child` 는 X11 에서만 동작하며, wry 는 X11 과 Wayland 를 함께 지원하려면 `gtk::Fixed` 와 `build_gtk` 를 쓰라고 권한다 [S9].

### 결과

두 호스트는 하나의 플랫폼 인터페이스를 공유하고, macOS 에서는 하나의 네이티브 라이브러리도 공유한다. GTK3 와 GTK4 는 widget, event, 그리기 API 가 다르므로, Linux 에서 두 호스트가 하나의 네이티브 라이브러리를 공유하려면 같은 toolkit 을 써야 한다. Tauri 는 GTK3 만 제공하고 [S6][S8], Wails 는 v3.1 전까지만 GTK3 를 제공한다 [S3]. 이것이 아래의 결정 D1 이다.

두 프레임워크 모두 main webview 를 `GtkBox` 에 둔다. Linux 플랫폼 계층은 영역, 쌓임 순서, 입력 영역을 정하기 위해 자신이 합성하는 모든 webview(main, 표면, 모달, 문서)를 자신이 소유한 container 로 옮겨야 한다. `WebKitWebView` 를 페이지를 다시 읽지 않고 GTK3 container 사이에서 옮기는 동작(`g_object_ref`, `gtk_container_remove`, `gtk_container_add`)은 **unverified** 다.

## 연산 그룹

Go 인터페이스에는 `Platform` 연산 94 개와 진단 연산 16 개(`InputSources`, `ProcessExitWaiter`, `WindowObjectCounter`, `Capturer`)가 있다. Rust trait 에는 연산 116 개가 있으며, Go 가 다른 package 에 두는 endpoint 연결과 비공개 디렉터리 연산을 포함한다. 표는 연산을 역할별로 묶는다. "가능"은 공개 API 가 X11 과 Wayland 모두에서 그 동작을 제공한다는 뜻이고, "제한"은 그 제한을 적으며, "불가"는 해당 display server 를 적는다.

| # | 그룹과 연산 | macOS 메커니즘 | 제안하는 Linux 메커니즘 | 가능 여부 |
| --- | --- | --- | --- | --- |
| 1 | UI 큐: `EnqueueUI` / `enqueue_ui` | main queue 로 `dispatch_async` ([`ui_queue.m`](../../native/darwin/src/ui_queue.m)) | 기본 main context 의 `g_idle_add`. 그 context 를 실행하는 thread 에서 함수를 실행한다 [S20] | 가능 |
| 2 | 창 준비: `PrepareWindow`, `SetMainWebview`, `MainWebview`, `MainWindow`, `ConfigureMainWindow`, `RevealAfterLoad`, Rust `prepare_window`, `window_handle`, `set_main_appearance`, `observe_occlusion`, `stays_open_without_windows` | content view 안의 합성 view, main `WKWebView` 등록, 첫 읽기와 다음 표시까지 투명한 창 ([`window_facts.m`](../../native/darwin/src/window_facts.m), [`window_reveal.m`](../../native/darwin/src/window_reveal.m)) | 프레임워크의 `GtkBox` 내용을 기본 자식이 main `WebKitWebView` 인 호스트 `GtkOverlay` 로 바꾼다 [S21]. `WEBKIT_LOAD_FINISHED` 의 `load-changed` [S16] 뒤 toplevel frame clock 의 다음 `after-paint` [S24]에서, toplevel 의 `gtk_widget_set_opacity` [S22]로 창을 드러낸다 | 제한: toplevel 불투명도는 X11 에서 compositing manager 가 있을 때만 효과가 있다 [S22]. frame clock 의 paint 가 WebKit 의 첫 페이지 그리기 뒤에 오는지는 **unverified** |
| 3 | 제목줄과 창 단추: `TitlebarHeight`, `SetTitlebarHeight`, `WindowControls` | 제목줄이 페이지 첫 행의 높이를 갖고 AppKit 이 그 안에서 단추를 가운데 둔다([호스트](../spec/hosts.ko.md#창-단추)) | 창 제목줄로 쓰는 `GtkHeaderBar`(`gtk_window_set_titlebar`). 그 `show-close-button` 과 `decoration-layout` 이 창 단추를 배치한다 [S25]. `WindowControls` 는 단추 box 의 allocation 을 보고한다 | 제한: 결정 D6 |
| 4 | 창 정보와 기하: `WindowFacts`, `WindowHit`, `MoveWindow`, `Screens`, `AlignRect`, Rust `hit`, `move_window`, `screens` | `NSWindow` frame, key 상태, `hitTest:`, `NSScreen` frame 과 배율 | toplevel allocation 과 `gtk_window_is_active`. 호스트 소유 widget tree 를 따라가는 hit test. `GdkMonitor` 기하와 `gdk_monitor_get_scale_factor` [S26]. `gtk_window_move` [S27] | 제한: monitor 배율은 정수이므로 [S26] `AlignRect` 는 소수 배율을 표현하지 못한다. window manager 는 `gtk_window_move` 를 무시할 수 있고 [S27], xdg-shell 은 배치를 compositor 에 맡기며 사용자 동작에 따른 대화형 `move` 만 제공하므로 [S28] `MoveWindow` 는 Wayland 에서 불가 |
| 5 | 전체 화면: `Fullscreen` | 전환 중의 요청을 대기열에 두는 `toggleFullScreen:` ([`window_fullscreen.m`](../../native/darwin/src/window_fullscreen.m)) | `gtk_window_fullscreen` / `gtk_window_unfullscreen`. `window-state-event` 가 전체 화면 상태를 보고하면 완료 [S29] | 제한: window manager 가 요청을 거부할 수 있다 [S29]. 이때 `done` 은 끝없이 기다리지 않고 오류를 보고해야 한다 |
| 6 | 창 동작: `InstantWindowResize` | `NSWindowResizeTime` user default | 창 크기 변경 애니메이션을 정하는 GTK3 API 를 찾지 못했다(**unverified**) | 해당 없음: 결정 D7 |
| 7 | Webview: `CreateWebview`, `NavigateWebview`, `SetWebviewBounds`, `SetWebviewHidden`, `SetWebviewBackground`, `SetWebviewAlpha`, `SetWebviewResizing`, `EvaluateScript`, `CloseWebview`, `WebviewFrame`, Rust `place_webview`, `webview_frame`, `attach_surface`, `detach_surface`, `set_surface_hidden`, `set_alpha`, `set_live_resize`, `raise_webview`, `view_id` | `WKWebView` 생성(Wails) 또는 `add_child` 와 부모 변경(Tauri). user script 와 message handler. 비공개 `drawsBackground` | 호스트 `GtkFixed` 안의 `WebKitWebView`. `WebKitUserContentManager` 를 통한 user script 와 `script-message-received`(`webkit_user_content_manager_register_script_message_handler`, WebKitGTK 2.8 [S14]). `WEBKIT_LOAD_COMMITTED` 의 `load-changed` 로 commit [S16]. `webkit_web_view_evaluate_javascript`(2.40 [S14]). alpha 0 의 `webkit_web_view_set_background_color` 로 투명(2.8 [S14]). `gtk_widget_set_opacity` 로 불투명도 [S22] | 가능. 단 Tauri webview 의 부모 변경은 **unverified**([결과](#결과) 참조). `gtk_widget_set_opacity` 는 native window 를 가진 자식에서 실패하며 [S22], `WebKitWebView` 가 native window 를 갖는지는 **unverified** |
| 8 | 모달 webview: `ConfigureModal`, `FocusModal`, Rust `round_corners`, `focus_webview` | 접근성 이름, layer 모서리 반경, first responder | ATK 를 통한 접근성 이름. `gtk_widget_grab_focus`. 부모 container 의 cairo clip 으로 모서리 반경 | 제한: GTK3 에서 가속 렌더링하는 `WebKitWebView` 를 둥근 모서리로 자르는 동작은 **unverified** |
| 9 | 표면 합성: `CreateSurface`, `CloseSurface`, `SetSurfaceBounds`, `SurfaceFrame`, `SetSurfaceHiddenHandle`, `SetSurfaceAlphaHandle`, `SetWindowOverlays`, `SetSurfaceOverlays`, Rust `create_surface`, `place_surface`, `set_surface_overlays`, `set_window_overlays` | app DOM 아래의 `SurfaceHost` view. 장치 픽셀 container. 선언된 overlay 에 따른 hit 소유 ([`webview_geometry.m`](../../native/darwin/src/webview_geometry.m), [`window_objects.m`](../../native/darwin/src/window_objects.m)) | 창의 `GtkOverlay` 의 overlay 자식으로 `SurfaceHost` 마다 `GtkFixed` 하나 [S21]. overlay 자식과 main webview 창의 input shape 로 네이티브 입력 소유를 정한다(`gtk_overlay_set_overlay_pass_through`, GTK 3.18 [S21]) | 제한: 투명한 `WebKitWebView` 가 `GtkOverlay` 의 형제 widget 위나 아래에서 바르게 합성되는지는 **unverified** 이며, 이것이 첫 prototype 항목(R2-7-4)이다 |
| 10 | 배치 트랜잭션과 표시: `BeginLayout`, `CommitLayout`, `CancelLayout`, `AfterPresentation`, `AfterSettled`, `InjectSettledFailure` | 네이티브 기하를 감싸는 `CATransaction`. 비공개 `_doAfterNextPresentationUpdate:`. `CADisplayLink` ([`surface_layout.m`](../../native/darwin/src/surface_layout.m)) | commit 까지 widget allocation 을 호스트가 보관하고, commit 때 main loop callback 하나에서 적용해 한 frame clock 주기 안에서 배치하고 그린다 [S24]. 표시 시각은 `gdk_frame_timings_get_presentation_time` 이며, compositor 가 보고하지 않으면 0 이다 [S23] | 제한: WebKitGTK 는 페이지의 렌더링 갱신이 화면에 닿은 뒤의 callback 을 문서화하지 않는다(WebView 의 method 와 signal 목록에 없다 [S16]). `_doAfterNextPresentationUpdate:` 를 대신할 공개 API 는 **unverified**(결정 D5) |
| 11 | 문서 영역: `CreateDocument`, `SetDocumentEvent`, `LoadDocument`, `ZoomDocument`, `GoDocument`, `PlaceDocument`, `SetDocumentBackground`, `SetDocumentAppearance`, `CloseDocument` | `<config-dir>/document-data` 의 비공개 data store 를 쓰는 표면의 `WKWebView` subview ([`document_view.m`](../../native/darwin/src/document_view.m)) | 표면의 `GtkFixed` 안의 `WebKitWebView`. `base-data-directory` 와 `base-cache-directory` 를 준 `webkit_website_data_manager_new` 로 만든 `WebKitWebContext`(2.10, 공개 [S17]). `load_uri`, `set_zoom_level`, `go_back`, `go_forward`, `reload`, `stop_loading`, `go_to_back_forward_list_item`, `get_estimated_load_progress` [S16] | 가능 |
| 12 | 그림 영역: `CreateImage`, `PlaceImage`, `RasterImage`, `SurfacePlacedImage`, `PresentImage`, `FactsImage`, `CloseImage` | ID 로 찾고 nonce 로 확인한 전역 IOSurface 의 불변 복사본을 `CALayer` contents 로 둔다 ([`image_region.m`](../../native/darwin/src/image_region.m)) | 호스트 소유 cairo image surface(`CAIRO_FORMAT_ARGB32`, premultiplied, native byte order [S30])를 창 배율의 `cairo_surface_set_device_scale` [S31]로 그리는 `GtkDrawingArea`. 프레임은 file descriptor 로 온다([Linux 에서의 vt 사이드카](#linux-에서의-vt-사이드카) 참조) | 제한: 픽셀 단위로 정확한 표시는 정수 GTK 배율에서만 성립한다 [S26]. 소수 출력 배율을 위해 창 buffer 를 확대·축소하는 compositor 는 픽셀을 다시 sampling 한다(compositor 마다 **unverified**) |
| 13 | 그림 영역의 키보드, IME, 접근성: `FocusImage`, `CaretImage`, `TextImage`, 영역 `event` | 영역 view 의 `NSTextInputClient`. 접근성 값 | 영역 widget 의 `GtkIMContext`: `filter_keypress`, `preedit-changed`, `commit`, `retrieve-surrounding`, `delete-surrounding`, `set_cursor_location`, `set_client_window` [S32]. `AtkText` 를 통한 접근성 text [S33] | 가능. [터미널 런타임](../spec/terminal-runtime.ko.md)이 설명하는 한국어 input method 의 replacement range 동작은 `delete-surrounding` [S32]에 대응하며, Linux input method 의 실제 순서는 **unverified** |
| 14 | 도형: `CreateShape`, `SetShapeFrame`, `SetShapeStyle`, `RaiseShape`, `DestroyShape` | 표면 위의 `CAShapeLayer` view | cairo 로 외곽선을 그리고 입력을 통과시키는 `GtkDrawingArea` overlay 자식 [S21] | 가능 |
| 15 | 입력 감시와 페이지 초점: `WatchInput`, `UnwatchInput`, Rust `register_input`, `ignore_page_focus` | `addLocalMonitorForEventsMatchingMask`. 비공개 `_setIgnoresMouseMoveEvents:` 와 `_setShouldSuppressFirstResponderChanges:` | GDK 의 모든 event 를 처리하는 함수를 정하는 `gdk_event_handler_set` [S34]. handler 는 각 event 를 `gtk_main_do_event` 로 넘긴다 | 감시는 가능. 페이지 초점의 대응은 **unverified**(비공개 API 표 참조) |
| 16 | 입력 주입과 활성화: `InjectPointer`, `InjectKey`, `ActivateWindow`, Rust `input_pointer`, `input_activate`, `input_key` | hit view 의 event method, `-[NSWindow sendEvent:]`, 비공개 scroll 필드. `makeKeyAndOrderFront:` 와 활성화 | 대상 `GdkWindow` 를 담은 합성 `GdkEvent`(button, motion, scroll, key)를 process 안에서 `gtk_main_do_event` 로 전달. `gtk_window_present_with_time` 으로 활성화 | 제한: WebKitGTK 가 합성 event 를 받아들이는지는 **unverified**. Wayland 에서 compositor 는 유효한 xdg-activation token 이 없는 활성화를 거부할 수 있다 [S35] |
| 17 | 입력 소스(진단): `InputSource`, `SelectInputSource` | `TISCopyCurrentKeyboardInputSource`, `TISSelectInputSource` ([`input_source.m`](../../native/darwin/src/input_source.m)) | 사용 중인 input method framework 고유의 인터페이스 | X11 과 Wayland 모두 하나의 공개 인터페이스로는 불가(**unverified**: toolkit API 를 찾지 못했다). 진단 build 는 `not implemented on linux` 를 반환한다 |
| 18 | 캡처와 추적(진단): `WindowNumbers`, `CaptureOpen`, `CaptureStart`, `CaptureWait`, `CaptureStop`, `CaptureLimited`, `CaptureLongestGap`, `CaptureClock`, `CaptureStill`, `LayoutTraceStart`, `LayoutTraceStop` | 활성화하지 않는 ScreenCaptureKit 창 stream 과 정지 화상 ([`capture.m`](../../native/darwin/src/capture.m)) | X11: `gdk_pixbuf_get_from_window` 로 창을 읽는다 [S36]. Wayland: ScreenCast portal 이 사용자 대화 상자 뒤에 PipeWire 로 프레임을 준다 [S37] | X11 에서 제한: 가려진 영역은 정의되지 않고, map 되지 않은 창은 `NULL` 을 반환한다 [S36]. Wayland 에서는 사용자 조작 없이 불가 [S37]. 결정 D2 |
| 19 | Web process 수명(일부 진단): `KillWebContentProcess`, `CollectGarbage`, `WindowObjectsWhen` | 비공개 `_killWebContentProcessAndResetState`, `_webProcessIdentifier`, `_garbageCollectJavaScriptObjectsForTesting` | `webkit_web_view_terminate_web_process`(2.34 [S14])와 종료 이유를 주는 `web-process-terminated`(2.20 [S15]). 객체 수는 호스트 자신의 registry 에서 센다 | 종료는 가능. JavaScript garbage collection 은 `WebKitWebContext` [S18]와 `WebKitWebView` [S16]에 UI process API 가 없으므로, 메커니즘을 찾기 전까지 `CollectGarbage` 는 `not implemented on linux` 를 반환한다 |
| 20 | 파일 놓기: `FileDrop` | 파일 URL 의 `registerForDraggedTypes:` | main webview container 의 `text/uri-list` target GTK drag destination | 가능(`WebKitWebView` 가 container 보다 먼저 drop 을 소비하는지는 **unverified**) |
| 21 | Clipboard: `ClipboardRead`, `ClipboardWriteText`, `ClipboardWritePNG` | `NSPasteboard` 문자열, PNG, 파일 URL ([`clipboard.m`](../../native/darwin/src/clipboard.m)) | `GtkClipboard`: `set_text`, `GdkPixbuf` 의 `set_image`, `wait_for_contents`, `wait_for_uris` [S38] | 가능([S38]은 Wayland 동작을 적지 않는다. **unverified**) |
| 22 | 링크: `OpenLink` | `NSWorkspace openURL:` | `g_app_info_launch_default_for_uri` [S39] | 가능 |
| 23 | 알림: `StartNotifications`, `PostNotification`, `RemoveNotification`, `DeliveredNotifications` | 권한 상태와 활성화를 주는 `UNUserNotificationCenter` ([`notifications.m`](../../native/darwin/src/notifications.m)) | 식별자를 notification ID 로 쓰는 `g_application_send_notification`, `g_application_withdraw_notification` [S40]. application ID 가 필요하다 [S40] | 제한: freedesktop protocol 에는 표시 중인 알림을 나열하는 method 가 없으므로 [S41], `DeliveredNotifications` 는 호스트가 게시했고 닫힘을 보지 못한 식별자를 보고한다. 보고할 권한 상태가 없다 |
| 24 | 메뉴와 Dock: `InstallDock`, `DockItems`, `DockSelect`, `MenuItems`, `MenuSelect`, `PreferredLanguage` | `class_addMethod` 로 추가한 `applicationDockMenu:`. `NSMenu` | launcher 가 메뉴로 보여 주는 desktop entry `Actions` 의 New Window action [S42]. 메뉴 항목은 프레임워크의 GTK menu bar 에서 읽는다. 언어는 `g_get_language_names`(**unverified**: 문서를 읽지 않았다) | 제한: desktop action 은 실행 파일을 시작하거나 D-Bus 로 활성화하므로 [S42], New Window 는 실행 중인 호스트로 넘기는 단일 인스턴스 전달이 필요하다 |
| 25 | Endpoint 와 서비스: `Listen`, `ServiceProcessExists`, Rust `endpoint_listen`, `endpoint_connect`, `connect_service`, `secure_service_directory`, `create_private_directories`, `private_directory` | Unix socket, `kill(pid, 0)`, mode 0700 디렉터리 | 같은 POSIX 호출. `sok` 이 Linux 에서 이미 구현한다([기능](../features.ko.md)의 R2-7-1) | 가능 |
| 26 | 프로세스 종료 대기(진단): `WhenProcessExited` | `DISPATCH_SOURCE_TYPE_PROC` ([`process_exit.m`](../../native/darwin/src/process_exit.m)) | 프로세스가 끝나면 읽을 수 있게 되는 `pidfd_open`(Linux 5.3 [S43])을 GLib file descriptor source 로 감시 | 가능 |
| 27 | 종료 신호: `OnTermination` | POSIX signal handler | 같은 POSIX handler | 가능 |
| 28 | 종료 요청: `OnQuitRequest`, `AnswerQuitRequests` | 응답을 미루는 `kAEQuitApplication` handler ([`quit_request.m`](../../native/darwin/src/quit_request.m)) | Inhibit portal monitor: `CreateMonitor`, session 상태 Query End 의 `StateChanged`, 1 초 안의 `QueryEndResponse`, 저장하는 동안 logout flag 의 `Inhibit` [S44] | 제한: 호스트는 1 초 안에 답해야 한다 [S44]. 저장은 logout inhibitor 아래에서 계속되며, 그것이 session 에 주는 효과는 session manager 가 정한다(**unverified**) |
| 29 | 표준 오류: `ReplaceStandardError` | `dup2` | `dup2` | 가능 |
| 30 | 디렉터리 식별: `DirectoryIdentity` | device 와 inode | device 와 inode | 가능 |
| 31 | 외관: `ConfigureMainWindow(dark)`, `SetDocumentAppearance` | `NSAppearance` Aqua / DarkAqua ([`appearance.m`](../../native/darwin/src/appearance.m)) | Settings portal 키 `org.freedesktop.appearance color-scheme` 와 그 `SettingChanged` signal 로 시스템 선호를 읽는다 [S45]. 창에는 GTK 설정 `gtk-application-prefer-dark-theme` | 제한: WebKitGTK 4.1 이 페이지의 `prefers-color-scheme` 을 그 GTK 설정에서 정하는지는 **unverified** |

## 비공개 네이티브 API

[현재 목록](../operations/private-native-apis.ko.md#현재-목록)과 [프레임워크 내부 의존성](../operations/private-native-apis.ko.md#프레임워크-내부-의존성)의 각 행과 그 목적, Linux 대응. 그 자체가 공개 API 가 아닌 Linux 대응은 채택할 때 `docs/operations/private-native-apis.md` 의 Linux 절에 적는다.

| macOS API | 목적 | Linux 대응 |
| --- | --- | --- |
| `NSWindowResizeTime` | 한 프레임의 창 크기 변경 애니메이션 | GTK3 에 줄일 애플리케이션 크기 변경 애니메이션이 없다면 필요 없다(API 를 찾지 못했다. **unverified**. 결정 D7) |
| `_setOverrideDeviceScaleFactor:`(표면 webview) | 장치 픽셀 container 단위당 backing 픽셀 하나 | WebKitGTK 에 공개 device scale override 가 없다([S16]에 없다). GTK 배율은 정수다 [S26]. 제안: 정수 GTK 배율의 논리 좌표와 page zoom(`webkit_web_view_set_zoom_level` [S16]). 배율 2 에서 홀수 장치 픽셀 가장자리는 표현할 수 없다. 반 픽셀 덮음 검사를 통과하는지는 **unverified** |
| `_setOverrideDeviceScaleFactor:`(문서 view) | 표면 밀도로 그리는 문서 영역 | 앞 행과 같다 |
| `_doAfterNextPresentationUpdate:` | 기하 commit, 창 표시, 측정 전에 표시를 확인 | 문서화된 대응이 없다 [S16]. 후보는 toplevel 의 frame clock `after-paint` [S24]와 presentation timing [S23]이며, 이것이 WebKit 의 합성된 페이지 갱신 뒤에 오는지는 **unverified**(결정 D5) |
| `WKPreferences` 기능 `PreferPageRenderingUpdatesNear60FPSEnabled` | app DOM 이 display 주기로 렌더링 | `webkit_settings_set_feature_enabled` 와 `webkit_settings_get_all_features` 는 2.42 부터 공개다 [S19][S46]. 이 기능이 WebKitGTK 에 있는지, 기본으로 켜져 있는지는 **unverified**. 사용 중인 Rust binding 은 `v2_40` 까지의 버전만 노출하므로([S6]의 `webkit2gtk` 기능) 공유 C 라이브러리로 호출한다 |
| `_setIgnoresMouseMoveEvents:` | hit test 된 webview 만 포인터 이동을 추적 | 필요 없을 가능성이 높다: GDK 는 포인터 아래의 창에 포인터 event 를 주고, overlay pass-through 와 input shape 가 그 창을 정한다 [S21]. 겹친 `WebKitWebView` widget 에 대해서는 **unverified** |
| `WKWebView` KVC `drawsBackground` | 투명한 overlay DOM 평면 | alpha 0 의 공개 `webkit_web_view_set_background_color`(2.8 [S14]) |
| `WKWebViewConfiguration` KVC `drawsBackground` | 생성 전 투명 배경(wry 를 통한 Tauri) | wry 의 Linux 투명 경로. 호스트는 생성 뒤 위의 공개 호출로 색을 정한다 |
| `_inspector`, `_WKInspector`(검사 전용) | 검사에서 Web Inspector 를 열고 붙인다 | 공개 `webkit_web_view_get_inspector` [S16] |
| `_doAfterProcessingAllPendingMouseEvents:` | 전달 전후에 마우스 처리를 비운다 | 문서화된 대응이 없다 [S16]. 기존의 페이지 수신 확인(문서가 event 를 보고)이 완료 신호로 남는다. WebKitGTK 가 합성 event 를 순서대로 처리하는지는 **unverified** |
| `_setShouldSuppressFirstResponderChanges:` | 페이지가 창의 키보드 초점을 가져가지 못한다 | 문서화된 대응이 없다 [S16]. 페이지의 `focus()` 가 WebKitGTK 의 `gtk_widget_grab_focus` 호출로 이어지는지는 **unverified**. 검사 `webview_focus_test` 가 대응의 필요 여부를 정한다 |
| `_setWindowResolution:`, `_adjustWindowResolution`(테스트 전용) | 맞는 display 없이 배율 1 또는 2 | 모든 창을 확대하는 정수 환경 변수 `GDK_SCALE` [S47] |
| `_setWindowOcclusionDetectionEnabled:` | 창이 가려진 동안 문서를 보이는 상태로 두고 애니메이션을 유지 | 문서화된 대응이 없다 [S16]. WebKitGTK 가 가려졌지만 map 된 GTK3 창을 throttle 하는지는 **unverified** |
| `_doAfterActivityStateUpdate:`(가림 검사) | WebKit 이 창 상태를 적용한 뒤 가시성을 읽는다 | 앞 행에 따른다. **unverified** |
| `_doAfterActivityStateUpdate:`(활성화) | web process 가 활성 상태를 받은 뒤 입력을 전달 | 문서화된 대응이 없다 [S16]. **unverified** |
| `CGEventField` 51, `CGEventSetWindowLocation` | 창을 담은 scroll 과 key event | 필요 없다: 합성 `GdkEvent` 가 `GdkWindow` 와 좌표를 담는다(그룹 16) |
| `_WKWebsiteDataStoreConfiguration.initWithDirectory:`, `_initWithConfiguration:` | `<config-dir>/document-data` 의 문서 사이트 데이터 | `base-data-directory` 와 `base-cache-directory` 를 준 공개 `webkit_website_data_manager_new` [S17]와 `webkit_web_context_new_with_website_data_manager`(2.10 [S14]) |
| `_garbageCollectJavaScriptObjectsForTesting` | 메모리 측정 전에 JavaScript 객체 수집 | UI process API 에 없다 [S16][S18]. `diagnostics.page.collect` 는 `not implemented on linux` 를 반환한다 |
| `_killWebContentProcessAndResetState`, `_webProcessIdentifier` | 애플리케이션보다 오래 사는 WebKit 자식 프로세스가 없다 | 공개 `webkit_web_view_terminate_web_process`(2.34 [S14])와 `web-process-terminated` [S15]. WebKitGTK 는 web process 식별자를 문서화하지 않으므로 [S16] 대기는 signal 을 쓴다 |
| `_WKNavigationActionPolicyAllowInNewProcess`, `_clearBackForwardCache` | app DOM 의 각 main-frame 문서를 새 프로세스에서 열어, WebCore 의 `querySelectorAll` 결과 cache 가 교체된 문서를 붙잡지 않게 한다 | WebKitGTK 에는 context 속성 `process-swap-on-cross-site-navigation-enabled`(2.28 [S18])만 있다. 같은 site 의 reload 는 프로세스를 유지한다. cache 는 공유 WebCore 소스(`Document.cpp`, 목록이 인용)에 있으므로 결함은 WebKitGTK 에도 해당한다. 공개된 navigation 단위 프로세스 교체는 **unverified**. 결정 D8 |
| 프레임워크: `developerExtrasEnabled` | 개발자 도구 | 공개 `WebKitSettings` 의 `enable-developer-extras`(**unverified**: 속성 문서를 읽지 않았다) |
| 프레임워크: `_inspector` show, close, isVisible | 프레임워크 개발자 도구 명령 | `webkit_web_view_get_inspector` 를 통한 공개 `WebKitWebInspector` [S16] |
| 프레임워크: `allowsPictureInPictureMediaPlayback` | macOS 에서 wry 가 설정 | 호스트가 설정하는 Linux 대응은 없다 |
| 프레임워크: `_wantsKeyDownForEvent:` | tao 가 Control-Tab 과 Control-Escape 를 받는다 | 해당 없음: GTK3 는 key event 를 toplevel 에 먼저 준다. 이 단축키에 대한 tao 의 Linux key 처리는 **unverified** |

## Linux 에서의 vt 사이드카

macOS 사이드카는 각 프레임을 CoreText 로 전역 IOSurface(`kIOSurfaceIsGlobal`, BGRA, `soksak.frame` 값의 16 바이트 nonce)에 그리고, `token.kind` 가 `iosurface-global` 인 [그림 봉투](../spec/sidecars.ko.md#그림-봉투)로 IOSurface ID 를 보낸다(사이드카 저장소의 `vt-core/src/platform/darwin/frame.m`). 호스트는 ID 로 IOSurface 를 찾고, nonce, 크기, 픽셀 형식, 배율을 확인하고, 픽셀을 복사한 뒤 `consumed` 로 답한다([`image_region.m`](../../native/darwin/src/image_region.m)). Linux 에는 IOSurface 가 없다. rasterizer 와 token 이 바뀌고, [표면 합성](../spec/surface-composition.ko.md#그림-전송)의 복사 후 `consumed` 규칙은 유지된다.

### 글꼴 rasterization

1. 사이드카의 `platform/linux/` 아래에 C 로 작성하는 Pango 와 cairo: Pango 는 glyph string 을 배치해 cairo context 에 그리고 [S48], 그 fontconfig 기반(PangoFc)은 fontconfig 와 FreeType 으로 글꼴을 찾는다 [S49]. 구조는 `frame.m` 과 같다: `CTFontDescriptor` 대신 font descriptor, `CGBitmapContext` 대신 cairo image surface.
2. cosmic-text 같은 Rust text stack: harfrust 로 shaping, fontdb 로 글꼴 탐색, swash 로 rasterization [S50]. fontdb 가 사용자의 fontconfig 대체와 fallback 규칙을 적용하는지는 **unverified**.

### 프레임 전송

persistent transport 는 호스트와 서비스 사이의 Unix socket 이다([터미널 런타임](../spec/terminal-runtime.ko.md)). 제안 token: `token.kind` `memfd`. 사이드카는 `memfd_create`(Linux 3.17 [S51])로 전송 그림을 만들고, 축소를 막는 seal(`F_SEAL_SHRINK`, 수신자를 `SIGBUS` 에서 보호한다 [S51])을 걸고, descriptor 를 같은 socket 에서 봉투 줄과 함께 `SCM_RIGHTS` ancillary data 로 보낸다. `memfd_create` 는 이 전달을 문서화한다 [S51]. 호스트는 descriptor 를 읽기 전용으로 map 하고, 크기를 `stride × height` 와 대조하고, cairo surface 로 복사하고, 닫은 뒤 `consumed` 로 답한다. 그 뒤 사이드카는 자기 descriptor 를 재사용하거나 닫는다. 인증된 연결이 nonce 를 대신한다: descriptor 를 가진 상대만 그림을 지정할 수 있으므로, `notFound` 와 `forbidden` 은 message 의 descriptor 가 없거나 남는 경우가 된다.

ancillary data 를 읽는 방법은 언어마다 다르다. Go 는 표준 라이브러리에 out-of-band buffer 를 받는 `UnixConn.ReadMsgUnix` 가 있다 [S52]. Rust `UnixStream` 의 ancillary data method 는 nightly 전용(기능 `unix_socket_ancillary_data`)이므로 [S53], Tauri 호스트는 `recvmsg` 를 위한 crate 가 필요하며 이는 새 의존성이다. buffer 를 쓰는 줄 reader 는 descriptor 를 그 줄과 연결할 수 없으므로, 두 호스트 모두 줄과 descriptor 를 같은 `recvmsg` 호출로 읽어야 한다.

### 호스트의 합성

그룹 12: 영역은 표면의 `GtkFixed` 안의 `GtkDrawingArea` 이며, 호스트 소유 `CAIRO_FORMAT_ARGB32` surface [S30]를 장치 배율로 [S31] 그린다. 프레임은 너비, 높이, 배율이 정수 GTK 배율에서의 영역 raster 와 같을 때만 받아들인다 [S26]. [네이티브 표면](../spec/native-surfaces.ko.md)의 commit 규칙(배치를 commit 하기 전에 보이는 모든 영역이 정확한 현재 raster 를 가진다)은 바뀌지 않는다.

### 사용자의 결정

각 결정은 권장 선택과 그 이유를 적는다. 이후 항목이 기대는 의존성이나 계약을 정하므로 선택은 사용자의 몫이다.

- **D1 Toolkit.** 권장: 두 호스트 모두 GTK3 와 WebKitGTK 4.1, Wails 는 `gtk3` build tag [S2]. 이유: Tauri 에는 GTK3 만 있고 [S6][S8], 공유 `native/linux` 라이브러리 하나가 `native/darwin` 처럼 두 호스트에 하나의 구현과 하나의 테스트 세트를 유지한다. Wails 는 v3.1 이 GTK3 build 를 제거한다고 적는다 [S3]. 그 release 가 이 결정을 다시 연다. 그때의 선택은 Tauri 의 GTK3 라이브러리 옆에 Wails 용 GTK4 라이브러리를 두는 것이다.
- **D2 Display server.** 권장: 애플리케이션이 X11 과 Wayland 에서 동작하도록 GTK 의 backend 선택 위에 만든다(`GDK_BACKEND` 가 backend 를 고른다 [S54]). 창 캡처 [S36][S37]와 `MoveWindow` [S28]는 Wayland 에서 사용자 조작 없이 쓸 수 없으므로 창 검사는 X11 에서 실행한다. backend 가 제공할 수 없는 연산은 `<operation> is not implemented on wayland` 를 반환한다.
- **D3 글꼴 rasterizer.** 권장: Pango 와 cairo(선택 1). 이유: GTK3 와 WebKitGTK 가 호스트를 실행하는 모든 기계에 이 라이브러리를 이미 요구하고, fontconfig 가 사용자의 글꼴 설정과 fallback 을 적용하며 [S49], C 구조가 `frame.m` 과 대응한다.
- **D4 프레임 전송.** 권장: seal 한 memfd 를 persistent socket 의 `SCM_RIGHTS` 로 전달. 이유: 다른 프로세스가 열 수 있는 파일 이름이 없고, descriptor 자체가 권한이며, 복사 후 `consumed` 규칙을 바꿀 필요가 없다. 비용은 Rust `recvmsg` 의존성이다 [S53].
- **D5 표시 대기.** 권장: R2-7-4 를 prototype 으로 두고, DOM 변경 뒤 toplevel frame clock 의 `after-paint` [S24]가 WebKitGTK 의 그 변경 그리기 뒤에 오는지를 tracked test 로 측정한다. 그렇지 않으면 공개 WebKitGTK API 로는 [네이티브 표면](../spec/native-surfaces.ko.md)의 commit 계약을 충족할 수 없으며, 그 발견은 다른 Linux 호스트 항목보다 먼저 사용자에게 돌아간다.
- **D6 창 단추.** 권장: 페이지 위의 `GtkHeaderBar` 제목줄 [S25]. Linux 에서 페이지는 단추 영역을 예약하지 않고 `WindowControls` 는 header bar 의 단추 box 를 보고한다. 이유: macOS 배치는 AppKit 이 페이지가 요청한 높이의 제목줄 안에서 단추를 가운데 두는 동작에 기대며([호스트](../spec/hosts.ko.md#창-단추)), GTK 는 이를 제공하지 않는다.
- **D7 창 동작.** 권장: `InstantWindowResize` 를 플랫폼 공통 인터페이스에서 빼고 macOS 창 준비로 옮긴다. 이유: 줄일 GTK3 크기 변경 애니메이션을 찾지 못했고(**unverified**), 효과 없이 성공하는 연산은 [호스트](../spec/hosts.ko.md#규칙)가 금지하는 stub 이다.
- **D8 reload 메모리.** 권장: main-frame 문서를 읽을 때마다 app DOM `WebKitWebView` 를 새 web process 의 새 view 로 바꾸고, 새 view 가 commit 할 때까지 이전 view 를 화면에 둔다. 이유: 공개 API 만 쓰며 교체된 문서를 가진 프로세스를 끝낸다. WebKitGTK process model 에서 새 view 가 새 web process 를 받는지는 **unverified**.

## 구현 순서

각 항목은 R2-7 의 하위 항목이며 시작 전에 [기능](../features.ko.md)에 등록한다. 항목이 달리 적지 않으면 검증은 build-machine Linux lane 에서 실행한다. 항목 1 이 나머지 항목의 가능 여부를 정한다.

1. R2-7-4 — `native/linux` 의 합성과 표시 prototype(D5): `GtkOverlay` 에서 투명한 `WebKitWebView` 를 `GtkDrawingArea` 위에 두고 DOM 을 바꾼 뒤, frame clock 의 `after-paint` 가 그려진 변경 뒤에 오는지를 X11 과 Wayland 에서 기록하는 tracked C 테스트. 검증: 테스트가 측정한 픽셀과 시각. 부정적 결과는 사용자에게 보고한다.
2. R2-7-5 — Toolkit 과 build(D1): pkg-config 파일을 가진 `native/linux` 라이브러리, Wails `gtk3` tag, Tauri Linux target, `platform/linux/` 를 받아들이는 `make platforms` 와 `make hosts-check`. 검증: 두 호스트가 Linux 에서 build 되고, 시작할 때 구현되지 않은 각 연산의 이름을 대며 실패한다.
3. R2-7-6 — 프로세스, endpoint, 신호, 표준 오류, 식별, 종료 요청(그룹 1, 25–30). 검증: Linux 의 `make host-contract-check` case. Query End 응답의 tracked test.
4. R2-7-7 — 창과 webview(그룹 2–8, 31): 호스트 container 로의 부모 변경, 투명, 표시, 전체 화면, header bar. 검증: module 별 네이티브 C 테스트. 두 호스트가 Linux 에서 준비된 창을 연다.
5. R2-7-8 — 표면, 도형, 입력 감시, 배치 트랜잭션(그룹 9, 10, 14, 15). 검증: X11 에서의 기하와 표시 창 검사.
6. R2-7-9 — 문서 영역(그룹 11). 검증: `browser.test.mjs` 의 문서 데이터와 navigation case.
7. R2-7-10 — 호스트의 프레임 전송(그룹 12, D4)과 `memfd` token 및 그 거부의 계약 case. 검증: 테스트 소유 공급자를 쓰는 호스트 계약 case.
8. R2-7-11 — 사이드카 저장소의 vt 사이드카 Linux renderer(D3). 그 저장소의 체크리스트에 등록한다. 검증: Linux 에서의 사이드카 프레임 테스트. 두 호스트의 터미널 창 검사.
9. R2-7-12 — 그림 영역의 키보드, IME, 접근성(그룹 13). 검증: 사용자의 승인을 받아 실행하는 activation 단계 IME 검사.
10. R2-7-13 — 입력 주입, clipboard, 링크, 파일 놓기, 알림, desktop action(그룹 16, 20–24). 검증: X11 에서의 창 검사.
11. R2-7-14 — 진단(그룹 17–19): X11 캡처, 프로세스 종료 대기, web process 종료, 쓸 수 없는 연산의 명시적 오류. 검증: X11 에서의 캡처 검사.
12. R2-7-15 — 두 호스트의 Linux package 와 `ci.yml` job. 검증: 모든 R2-7 항목이 완료되었을 때 한 번 실행하는 전체 suite.

## 출처

프레임워크 소스는 [`go.mod`](../../packages/host/wailsv3/go.mod)와 [`Cargo.lock`](../../Cargo.lock)이 정한 버전에서 읽었다.

- [S1] Wails v3.0.0-beta.27 [`v3/pkg/application/linux_cgo.go`](https://github.com/wailsapp/wails/blob/v3.0.0-beta.27/v3/pkg/application/linux_cgo.go), 1 행과 17 행
- [S2] Wails v3.0.0-beta.27 [`v3/pkg/application/linux_cgo_gtk3.go`](https://github.com/wailsapp/wails/blob/v3.0.0-beta.27/v3/pkg/application/linux_cgo_gtk3.go), 1 행과 19 행
- [S3] Wails v3.0.0-beta.27 [`v3/tests/gtk4-benchmark/README.md`](https://github.com/wailsapp/wails/blob/v3.0.0-beta.27/v3/tests/gtk4-benchmark/README.md), 10–14 행
- [S4] Wails v3.0.0-beta.27 [`v3/pkg/application/webview_window_linux.go`](https://github.com/wailsapp/wails/blob/v3.0.0-beta.27/v3/pkg/application/webview_window_linux.go), 29–36 행과 465–467 행. [`webview_window.go`](https://github.com/wailsapp/wails/blob/v3.0.0-beta.27/v3/pkg/application/webview_window.go), 1659–1665 행
- [S5] Wails v3.0.0-beta.27 `linux_cgo_gtk3.go`([S2]와 같다), 1483–1516 행
- [S6] wry 0.57.0 [`Cargo.toml`](https://docs.rs/crate/wry/0.57.0/source/Cargo.toml), Linux target 의존성 `gtk` 0.18 과 `v2_38` 의 `webkit2gtk` =2.0.2
- [S7] webkit2gtk-sys 2.0.2 [`Cargo.toml`](https://docs.rs/crate/webkit2gtk-sys/2.0.2/source/Cargo.toml), `system-deps` 이름 `webkit2gtk-4.1`
- [S8] tao 0.37.1 [`Cargo.toml`](https://docs.rs/crate/tao/0.37.1/source/Cargo.toml)(`gtk` 0.18)과 [`src/platform/unix.rs`](https://docs.rs/crate/tao/0.37.1/source/src/platform/unix.rs), 79–96 행
- [S9] wry 0.57.0 [`src/lib.rs`](https://docs.rs/crate/wry/0.57.0/source/src/lib.rs), 1525–1563 행, 2028–2062 행, 2411–2444 행
- [S10] wry 0.57.0 [`src/webkitgtk/mod.rs`](https://docs.rs/crate/wry/0.57.0/source/src/webkitgtk/mod.rs), 685–720 행과 963–1000 행
- [S11] tauri-runtime-wry 2.12.1 [`src/lib.rs`](https://docs.rs/crate/tauri-runtime-wry/2.12.1/source/src/lib.rs), 5164–5200 행
- [S12] tauri 2.12.1 [`src/window/mod.rs`](https://docs.rs/crate/tauri/2.12.1/source/src/window/mod.rs), 1790 행과 1804 행. [`src/webview/mod.rs`](https://docs.rs/crate/tauri/2.12.1/source/src/webview/mod.rs), 177 행
- [S13] gtk-sys 0.18 [`Cargo.toml`](https://docs.rs/crate/gtk-sys/0.18.2/source/Cargo.toml), `system-deps` 이름 `gtk+-3.0`
- [S14] webkit2gtk-sys 2.0.2 [`src/lib.rs`](https://docs.rs/crate/webkit2gtk-sys/2.0.2/source/src/lib.rs): 버전 gate `v2_8`(`set_background_color`, `register_script_message_handler`), `v2_10`(`website_data_manager_new`, `new_with_website_data_manager`), `v2_34`(`terminate_web_process`), `v2_40`(`evaluate_javascript`)
- [S15] WebKitGTK [`web-process-terminated`](https://webkitgtk.org/reference/webkit2gtk/stable/signal.WebView.web-process-terminated.html)
- [S16] WebKitGTK [`WebKitWebView`](https://webkitgtk.org/reference/webkit2gtk/stable/class.WebView.html), method 와 signal 목록
- [S17] WebKitGTK [`WebKitWebsiteDataManager`](https://webkitgtk.org/reference/webkit2gtk/stable/class.WebsiteDataManager.html)
- [S18] WebKitGTK [`WebKitWebContext`](https://webkitgtk.org/reference/webkit2gtk/stable/class.WebContext.html)
- [S19] WebKitGTK [`webkit_settings_set_feature_enabled`](https://webkitgtk.org/reference/webkit2gtk/stable/method.Settings.set_feature_enabled.html)
- [S20] GLib [`g_idle_add`](https://docs.gtk.org/glib/func.idle_add.html)
- [S21] GTK3 [`gtk_overlay_set_overlay_pass_through`](https://docs.gtk.org/gtk3/method.Overlay.set_overlay_pass_through.html)
- [S22] GTK3 [`gtk_widget_set_opacity`](https://docs.gtk.org/gtk3/method.Widget.set_opacity.html)
- [S23] GDK3 [`gdk_frame_timings_get_presentation_time`](https://docs.gtk.org/gdk3/method.FrameTimings.get_presentation_time.html)
- [S24] GDK3 [`GdkFrameClock`](https://docs.gtk.org/gdk3/class.FrameClock.html)
- [S25] GTK3 [`GtkHeaderBar`](https://docs.gtk.org/gtk3/class.HeaderBar.html)
- [S26] GDK3 [`gdk_monitor_get_scale_factor`](https://docs.gtk.org/gdk3/method.Monitor.get_scale_factor.html)
- [S27] GTK3 [`gtk_window_move`](https://docs.gtk.org/gtk3/method.Window.move.html)
- [S28] Wayland [xdg-shell](https://wayland.app/protocols/xdg-shell)
- [S29] GTK3 [`gtk_window_fullscreen`](https://docs.gtk.org/gtk3/method.Window.fullscreen.html)
- [S30] cairo [image surfaces](https://www.cairographics.org/manual/cairo-Image-Surfaces.html)
- [S31] cairo [`cairo_surface_set_device_scale`](https://www.cairographics.org/manual/cairo-cairo-surface-t.html)
- [S32] GTK3 [`GtkIMContext`](https://docs.gtk.org/gtk3/class.IMContext.html)
- [S33] ATK [`AtkText`](https://docs.gtk.org/atk/iface.Text.html)
- [S34] GDK3 [`gdk_event_handler_set`](https://docs.gtk.org/gdk3/type_func.Event.handler_set.html)
- [S35] Wayland [xdg-activation-v1](https://wayland.app/protocols/xdg-activation-v1)
- [S36] GDK3 [`gdk_pixbuf_get_from_window`](https://docs.gtk.org/gdk3/func.pixbuf_get_from_window.html)
- [S37] XDG desktop portal [ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
- [S38] GTK3 [`GtkClipboard`](https://docs.gtk.org/gtk3/class.Clipboard.html)
- [S39] GIO [`g_app_info_launch_default_for_uri`](https://docs.gtk.org/gio/type_func.AppInfo.launch_default_for_uri.html)
- [S40] GIO [`g_application_send_notification`](https://docs.gtk.org/gio/method.Application.send_notification.html)
- [S41] freedesktop [notification protocol](https://specifications.freedesktop.org/notification/latest/protocol.html)
- [S42] freedesktop [desktop entry additional actions](https://specifications.freedesktop.org/desktop-entry/latest/extra-actions.html)
- [S43] Linux [`pidfd_open(2)`](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)
- [S44] XDG desktop portal [Inhibit](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Inhibit.html)
- [S45] XDG desktop portal [Settings](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Settings.html)
- [S46] WebKitGTK [`WebKitSettings`](https://webkitgtk.org/reference/webkit2gtk/stable/class.Settings.html)
- [S47] GTK3 [X11 환경 변수](https://docs.gtk.org/gtk3/x11.html), `GDK_SCALE`
- [S48] [PangoCairo](https://docs.gtk.org/PangoCairo/)
- [S49] [PangoFc](https://docs.gtk.org/PangoFc/)
- [S50] [cosmic-text](https://docs.rs/cosmic-text/latest/cosmic_text/)
- [S51] Linux [`memfd_create(2)`](https://man7.org/linux/man-pages/man2/memfd_create.2.html)
- [S52] Go [`net.UnixConn.ReadMsgUnix`](https://pkg.go.dev/net#UnixConn.ReadMsgUnix)
- [S53] Rust [`std::os::unix::net::UnixStream`](https://doc.rust-lang.org/std/os/unix/net/struct.UnixStream.html), `recv_vectored_with_ancillary`
- [S54] GTK3 [GTK 애플리케이션 실행](https://docs.gtk.org/gtk3/running.html), `GDK_BACKEND`
