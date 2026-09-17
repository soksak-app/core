# Private native API inventory

[한국어](private-native-apis.ko.md)

Read this document first when native behavior fails after updating native source, framework dependencies, the SDK, macOS, or its WebKit runtime. Review it before those updates as well. Checking a dependency first does not establish that it caused the failure.

This is the canonical inventory for application calls, diagnostic calls, and the private framework paths used by the current macOS hosts. The shared layout library has no native API dependency. Windows and Linux native execution remains unverified.

## Current inventory

| API or key | Caller and scope | Purpose |
| --- | --- | --- |
| `WKWebView._setOverrideDeviceScaleFactor:` | Both hosts; [`webview_geometry.m`](../../native/darwin/src/webview_geometry.m), `webviewAttachSurface` | Render one backing pixel per device-pixel container unit |
| `WKWebView._setOverrideDeviceScaleFactor:` on document views | Both hosts; [`webview_geometry.m`](../../native/darwin/src/webview_geometry.m), `webviewMatchSurface`, called by `sp_document_create` in [`document_view.m`](../../native/darwin/src/document_view.m) | Render a document region inside a device-pixel surface at the surface's density |
| `WKWebView._doAfterNextPresentationUpdate:` | Both hosts; [`surface_layout.m`](../../native/darwin/src/surface_layout.m), `surfaceLayoutAfterPresentation`; [`input_inject.m`](../../native/darwin/src/input_inject.m), `sp_input_pointer_then`; also used by probes and the standalone input check | Confirm webview presentation before committing native geometry, delivering a native scroll to a new document, or measuring rendered output |
| `WKWebView._setIgnoresMouseMoveEvents:` | Both hosts; [`webview_input.m`](../../native/darwin/src/webview_input.m), registration, pointer routing, and removal, for surface, modal, and document-region webviews | Restrict overlapping webview pointer tracking to the AppKit hit-test result |
| `WKWebView` KVC `drawsBackground` (`_drawsBackground` / `_setDrawsBackground:`) | Wails modal creation in [`webview.m`](../../packages/host/wailsv3/src/platform/darwin/webview.m); both hosts' `host.window` reads in [`window_facts.m`](../../native/darwin/src/window_facts.m) | Disable the modal webview's opaque background and report that state |
| `WKWebViewConfiguration` KVC `drawsBackground` (`_setDrawsBackground:`) | Tauri → Wry webview creation; [`modals.rs`](../../packages/host/tauriv2/src/modals.rs) `show` requests `background_color(Color(0, 0, 0, 0))`; main also configures a background color | Configure background drawing before initializing the webview |
| `WKWebView._doAfterProcessingAllPendingMouseEvents:` | [`native/darwin/tests/`](../../native/darwin/tests/) input checks, `drain`; checks only | Wait for native mouse processing before asserting DOM event counts |
| `WKWebView._setShouldSuppressFirstResponderChanges:` | Both hosts; [`webview_input.m`](../../native/darwin/src/webview_input.m), `webviewIgnorePageFocus`, for surface, modal, and document-region webviews | Keep a page from moving the window's keyboard focus when it focuses an element |
| `NSWindow._setWindowResolution:`, override of `NSWindow._adjustWindowResolution` | [`webview_geometry_test.m`](../../native/darwin/tests/webview_geometry_test.m) only; the method WebKitTestRunner uses | Set a test window's backing scale to 2 or 1 without the matching display, so scale behavior is checked on any machine |
| `WKWebView._doAfterActivityStateUpdate:` | Both hosts; [`input_inject.m`](../../native/darwin/src/input_inject.m), `sp_input_activate` | Deliver a hover move only after each webview has sent the active window state to its web process |
| `CGEventField` 51 (window number), `CGEventSetWindowLocation` | Both hosts; [`input_inject.m`](../../native/darwin/src/input_inject.m), scroll in `sp_input_pointer` | Create a scroll `NSEvent` that carries its window and window location |

All private declarations of the shared library are in [`native/darwin/src/private/`](../../native/darwin/src/private/): `webkit.h` and `coregraphics.h`. Sources and checks include these headers and declare no private API themselves. Another platform keeps its declarations in `native/<os>/src/private/`.

The two `drawsBackground` entries affect different objects. Wails changes the created view; Wry changes its configuration before creation. A framework's public Rust or Go entry point can therefore still introduce a private native dependency.

## Necessity review

### Device scale

Keep this correction. A half-point native height previously left an uncovered strip because the native drawing size became integral before document layout. The device-pixel container provides integral local sizes without reducing the layout's precision. Public `pageZoom` preserves CSS dimensions, but does not independently set the backing density for those local coordinates. `_setOverrideDeviceScaleFactor:1` supplies that density once when attaching each content webview; the container and page zoom handle later display-scale changes. Main and modal webviews do not use this correction. A document region is a subview of its surface and takes the same override only while its surface is inside the device-pixel container, so a local unit of the region is also one backing pixel; its page zoom follows the surface. [`webview_geometry_test.m`](../../native/darwin/tests/webview_geometry_test.m) checks the region's device pixel ratio and CSS size at 2×, after changing to 1×, and back.

Review the selector's signature and the meaning of custom versus intrinsic scale after an update. A changed interpretation can cause incorrect CSS size, rendering density, or input coordinates. Verify half-point document coverage, the last device pixel, and 2×↔1× transitions with [`webview_geometry_test.m`](../../native/darwin/tests/webview_geometry_test.m), and window resizing with [`geometry.test.mjs`](../../e2e/geometry.test.mjs). The coordinate contract is in [native surfaces](../spec/native-surfaces.md).

The declaration is in [`WKWebViewPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h); the implementation uses `WebPageProxy::setCustomDeviceScaleFactor` and `deviceScaleFactor` in [`WebPageProxy.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp).

### Presentation completion

Keep this correction. Completing a JavaScript evaluation or a DOM animation-frame callback does not confirm that each separate webview has presented its new document geometry. The host waits for the owning project window's main and visible application documents before committing the native transaction. Preparations from different windows are serialized because `CATransaction` belongs to the UI thread; navigation and closing cancel only the owning window's preparations. Document regions do not participate, so a busy web document renderer cannot stop main-window layout.

Review callback timing, painting completion, and behavior during navigation or process termination. The callback alone is not proof of captured pixels: its implementation can complete immediately without a running process or drawing area. Document readiness and complete recordings remain required. Run [`surface_layout_test.m`](../../native/darwin/tests/surface_layout_test.m), which checks which documents the wait includes, and verify [`outside.test.mjs`](../../e2e/outside.test.mjs), [`paint.test.mjs`](../../e2e/paint.test.mjs), and [`hosts.test.mjs`](../../e2e/hosts.test.mjs), including reload cleanup. [`projects.test.mjs`](../../e2e/projects.test.mjs) also verifies independent project windows, modal routing, and close/reopen cleanup.

Review `_doAfterNextPresentationUpdate:` in [`WKWebView.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm) and `WebPageProxy::callAfterNextPresentationUpdate` in [`WebPageProxy.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp).

### Pointer tracking

Keep this correction. Overlapping native tracking areas can deliver movement to more than one webview; choosing a view with public AppKit hit testing does not disable the other webview's tracking. The shared module applies the private flag according to that hit result. It does not disable keyboard, click, or drag handling, change keyboard focus, or replace the native event with a DOM event.

The private flag also affects mouse-enter and mouse-exit processing. The local monitor changes the selected target on mouse-move and mouse-enter events; it does not change that target on mouse-exit. Do not describe exit delivery as unconditionally enabled. Registration rejects an unavailable selector, and removal resets the flag. Review tracking-area behavior, event ordering, hover cleanup, hiding, removal, and retained keyboard input after an update. This API does not cancel work already submitted to WebKit; delayed cursor responses are not validated by the retained check.

Use the baseline and registered runs of the [standalone input check](examples.md#diagnostics), plus [`modal.test.mjs`](../../e2e/modal.test.mjs). Review `_setIgnoresMouseMoveEvents:` in [`WKWebViewMac.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/mac/WKWebViewMac.mm) and its tracking handlers in [`WebViewImpl.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm).

### Transparent background

Keep this correction for modal transparency. Transparent DOM content cannot reveal native content below an opaque webview. Public `underPageBackgroundColor` controls the color behind page content; setting CSS transparency and that color alone does not disable native background drawing. The private `drawsBackground` state supplies that separate requirement. The 50% shading and blur remain CSS behavior specified in [native modals](../spec/native-modals.md).

Review the exact KVC key, its receiver class, and whether configuration-time and instance-time settings still have the expected effect. Wails checks the assigned value and fails view creation on a KVC exception or an unchanged opaque state; the diagnostic read itself has no such exception handling. Geometry and presentation selectors are also called directly. Do not assume every unavailable private API produces a handled error.

Verify initial transparency, captured shading and blur, clear settings content after navigation, menus without a backdrop, and close/reload cleanup with [`modal.test.mjs`](../../e2e/modal.test.mjs) and [manual acceptance](examples.md#manual-acceptance). Transparency does not correct fractional geometry; surface dimensions must independently pass the footer checks.

The view and configuration declarations are in [`WKWebViewPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h) and [`WKWebViewConfigurationPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewConfigurationPrivate.h). The active framework creation path is in [Wry 0.56.1 `wkwebview/mod.rs`](https://github.com/tauri-apps/wry/blob/wry-v0.56.1/src/wkwebview/mod.rs).

### Page focus in surface and modal webviews

Keep this setting for surface and modal webviews. When a page focuses an element while its web view is not the first responder, WebKit sends `MakeFirstResponder` to the UI process, and `PageClientImpl::makeFirstResponder` makes the web view the window's first responder. A shell surface that focused its input after loading took the keys from an open menu, so a native Escape did not close the menu. `_setShouldSuppressFirstResponderChanges:YES` makes `PageClientImpl::makeFirstResponder` return without changing the first responder. AppKit clicks and the host's own `-[NSWindow makeFirstResponder:]` calls are not affected. The main page does not use the setting and can still move the focus. The function reports failure when the selector is missing, and both hosts then fail to create the webview.

Verify with [`webview_focus_test.m`](../../native/darwin/tests/webview_focus_test.m), which fails without the setting, and the menu Escape steps of [`modal.test.mjs`](../../e2e/modal.test.mjs). Review `PageClientImpl::makeFirstResponder` in [`PageClientImplMac.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/PageClientImplMac.mm) and the declaration in [`WKWebViewPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h).

### Mouse-processing completion in the standalone check

Keep `_doAfterProcessingAllPendingMouseEvents:` in the standalone check. Native mouse processing is asynchronous; evaluating JavaScript immediately after event submission can read counts before processing finishes. The callback supplies completion without a fixed sleep. It neither generates interference nor belongs to the application runtime. The check fails if the selector is absent or completion exceeds its timeout.

Review the declaration in [`WKWebViewPrivateForTesting.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivateForTesting.h) and run both standalone variants when updating this API or the input module.

## Framework-owned dependencies

These dependencies also require update review. They are not application corrections for surface geometry or overlapping input.

| API or key | Current use and necessity | Review after an update |
| --- | --- | --- |
| `WKPreferences` KVC `developerExtrasEnabled` (`_setDeveloperExtrasEnabled:`) | Embedded developer tools. Wails enables them in the current build targets, including the size-optimized target, which does not set the `production` build tag. Tauri enables them in debug builds; this crate does not enable release `devtools`. | Check the actual build flags, webview creation, and inspector availability. This is a debugging dependency, not a rendering correction. |
| `WKWebView._inspector`; `_WKInspector.show`, `close`, `isVisible` | Framework developer-tool commands: Wails uses `show`; Wry uses `show`, `close`, and `isVisible`. The application does not directly call these selectors. | Check opening, closing, and status only in builds that include the corresponding developer-tool commands. |
| `WKPreferences` KVC `allowsPictureInPictureMediaPlayback` (`_setAllowsPictureInPictureMediaPlayback:`) | Wry 0.56.1 sets this unconditionally during webview creation. The application does not request a private media correction. | Check webview creation and the changed framework implementation. Picture-in-picture behavior is not covered by the current native checks. |
| `NSView._wantsKeyDownForEvent:` | Tao 0.37.0 implements this selector on its content view and returns `YES` to receive Control-Tab and Control-Escape. The application adds no such override. | Check native keyboard delivery and the responder chain after Tao or AppKit updates. The current native suite does not specifically cover these two shortcuts. |

Call sites are in [Wry `wkwebview/mod.rs`](https://github.com/tauri-apps/wry/blob/wry-v0.56.1/src/wkwebview/mod.rs) and [Wails `webview_window_darwin_dev.go`](https://github.com/wailsapp/wails/blob/v3.0.0-beta.16/v3/pkg/application/webview_window_darwin_dev.go); the keyboard override is in [Tao `macos/view.rs`](https://github.com/tauri-apps/tao/blob/tao-v0.37.0/src/platform_impl/macos/view.rs). Preference declarations are in [`WKPreferencesPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKPreferencesPrivate.h).

Inventory entries describe active or explicitly conditional application paths, not every private API present in dependency source. For example, Wry uses public fullscreen preferences on the current macOS; its older-OS `fullScreenEnabled` branch is not active here. Changing the supported OS range, build flags, or framework configuration requires another source audit. KVC access to a public property is not itself a private API.

## Public Dock menu integration

[`dock_menu.m`](../../native/darwin/src/dock_menu.m) registers the public `NSApplicationDelegate.applicationDockMenu:` callback and an `NSMenu` action for New Window. Neither host exposes Dock-menu registration. The application adds this missing callback with public Objective-C runtime `class_addMethod`; it does not replace the framework delegate or an existing method. Registration fails if the delegate is unavailable or already implements the callback. Wails and Tauri callbacks invoke their existing public window creation APIs outside the AppKit callback. No private selector or framework fork is added.

After a framework update, check whether it supplies this callback or a Dock-menu API. Verify the menu item and creation of a library window, including after closing all windows. This integration concerns application menus, not surface rendering or webview input.

## Native input injection

[`input_inject.m`](../../native/darwin/src/input_inject.m) delivers pointer and key input to an application window without activating the application. It uses public AppKit calls, except for scroll, with these conditions:

- Keys: `-[NSWindow sendEvent:]` with `+[NSEvent keyEventWithType:...]`. A focused element receives the keys in a window that is not the key window.
- Pointer press, drag, release: the event method (`mouseDown:`, `mouseDragged:`, `mouseUp:`, right-button variants) of the view returned by `hitTest:`. `-[NSWindow sendEvent:]` is not used for these because AppKit treats a press in an inactive window as a first click and does not deliver it to the view.
- Pointer movement: `mouseMoved:` of the owner of the first tracking area that contains the point, from the hit view upward. WebKit updates hover only in an active page: `WebFrame::handleMouseEvent` passes a move without a button to `passMouseMovedEventToScrollbars` unless `FocusController::isActive()`, and that state comes only from `PageClientImpl::isViewWindowActive` (the window's `isKeyWindow`). No WebKit interface sets it. `sp_input_pointer` therefore returns `SP_INPUT_INACTIVE` for a move to a window that is not key, and does not fake the key state.
- Activation: `sp_input_activate` calls `-[NSWindow makeKeyAndOrderFront:]` and `-[NSApplication activate]`, waits for both the key-window and the application-active notifications, and then calls `_doAfterActivityStateUpdate:` for every webview in the window on the next main-queue turn. The callback runs after WebKit has sent the scheduled active state (`WebPageProxy::dispatchActivityStateChange`), so a following mouse event reaches the web process after that state on the same connection. The system can decline activation, and another application or window can take the focus. The function reports the step that stopped (`sp_activate_result`) and the frontmost application; `tests/input_activate_test.m` creates each of these conditions.
- Scroll: **private CoreGraphics use.** No public API creates a scroll `NSEvent` that carries a window. The code creates the event with `CGEventCreateScrollWheelEvent2`, sets the undocumented window-number field (`CGEventField` 51) and the private `CGEventSetWindowLocation`, and converts it with `+[NSEvent eventWithCGEvent:]`. The result has `window` and `locationInWindow` set, and `-[NSWindow sendEvent:]` delivers it to the view under the point. The code rejects the input when the converted event has no window. With only field 51 the location is wrong; with only `CGEventSetWindowLocation` the event has no window. `CGEventPostToPid` did not deliver the scroll to an inactive application (review on 2026-09-17).

Failure signs: `tests/input_inject_test.m` reports missing, untrusted, or misplaced pointer events, no wheel event, a scroll distance other than the requested 120 pixels, or a lost focus after a click. After an OS or WebKit update, run `make -C native/darwin test` and `make -C native/darwin test-activation` (the latter takes the keyboard focus); replace the private scroll calls when a public method creates a windowed scroll event.

## Update review procedure

1. Record the old and new application revision, OS/build, installed WebKit version, SDK/toolchain, and resolved framework revisions. Read this inventory first when diagnosing a failure after any native update.
2. Match the symptom to the relevant entries. Compare receiver classes, selectors or keys, argument and callback types, availability, threading, and actual semantics in the changed source. Inspect framework callers even when the application uses a public wrapper. Source review narrows the investigation; reproduce the failure before assigning its cause.
3. Reassess necessity. Remove a correction when the required behavior is now implemented correctly without it. Preserve the behavior contract and remove harmful or unnecessary code instead of adding compatibility branches, fixed delays, reduced precision, or background recoloring to conceal a failure.
4. Follow [build and verification](examples.md): rebuild and restart both hosts, run the affected checks and `make examples-verify`, and run `make -C native/darwin test` and `make -C native/darwin test-activation` when input dependencies change. Verify actual gestures and pixels. Record unavailable platforms or skipped checks explicitly.
5. Update this inventory and its Korean translation in the same change as API additions, replacements, removals, or changed call conditions. Record changed behavior and new validation in [features](../features.md) and [changes](../../CHANGELOG.md). Run `make docs-check`; source review must also confirm the inventory's accuracy.

The necessity decision belongs to the specific correction. Private status alone does not invalidate a correction, and successful tests alone do not justify its design. Each new entry requires a concrete cause, the public API limitation, exact implementation location and scope, failure signs, and verification steps.

## Review baseline

Source and necessity review: 2026-09-08, including the project-window integration. The environment reports macOS 26.6.2 (25G83), WebKit `21624.5.1.11.3`, and SDK 15.2. Framework versions remain Wails `v3.0.0-beta.16`, Tauri revision `270c63f117eb1f4ff0a653ca63b2ca61e9175663`, Wry `0.56.1`, and Tao `0.37.0`, resolved by [`go.mod`](../../packages/host/wailsv3/go.mod), [`Cargo.toml`](../../Cargo.toml), and [`Cargo.lock`](../../Cargo.lock).

Project windows add no private selectors. Public framework APIs create top-level windows and identify the calling window. Public filesystem APIs store settings. The existing private geometry, presentation, pointer, and transparency corrections remain necessary for their stated purposes. Their host state and lifetime now belong to each project window. Native mouse monitors are removed on window closure.

The standalone overlapping-input baseline and registered runs passed after the project-window integration; the library change does not modify that input code. Rebuilt macOS hosts passed 39 example checks with 0 failures and 2 display-transition skips in the library verification. This includes independent project windows, library window reuse, Dock actions, concurrent duplicate opens, modal isolation, fractional rendering, and native input. Application quit saves settings, and startup displays saved projects in the library. [Features](../features.md) records validation and platform limits. Source links identify review locations; a current source declaration does not prove that an installed WebKit build contains the same implementation.
