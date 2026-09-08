# Private native API inventory

[한국어](private-native-apis.ko.md)

Read this document first when native behavior fails after updating native source, framework dependencies, the SDK, macOS, or its WebKit runtime. Review it before those updates as well. Checking a dependency first does not establish that it caused the failure.

This is the canonical inventory for application calls, diagnostic calls, and the private framework paths used by the current macOS hosts. The shared layout library has no native API dependency. Windows and Linux native execution remains unverified.

## Current inventory

| API or key | Caller and scope | Purpose |
| --- | --- | --- |
| `WKWebView._setOverrideDeviceScaleFactor:` | Both hosts; [`webview_geometry_darwin.m`](../../examples/native/webview_geometry_darwin.m), `webviewAttachSurface` | Render one backing pixel per device-pixel container unit |
| `WKWebView._doAfterNextPresentationUpdate:` | Both hosts; [`surface_layout_darwin.m`](../../examples/native/surface_layout_darwin.m), `surfaceLayoutAfterPresentation`; also used by probes and the standalone input check | Confirm webview presentation before committing native geometry or measuring rendered output |
| `WKWebView._setIgnoresMouseMoveEvents:` | Both hosts; [`webview_input_darwin.m`](../../examples/native/webview_input_darwin.m), registration, pointer routing, and removal | Restrict overlapping webview pointer tracking to the AppKit hit-test result |
| `WKWebView` KVC `drawsBackground` (`_drawsBackground` / `_setDrawsBackground:`) | Wails modal creation in [`webview_darwin.m`](../../examples/wailsv3/webview_darwin.m); both hosts' diagnostic reads in [`window_probe_darwin.m`](../../examples/native/window_probe_darwin.m) | Disable the modal webview's opaque background and inspect that state |
| `WKWebViewConfiguration` KVC `drawsBackground` (`_setDrawsBackground:`) | Tauri → Wry webview creation; [`overlay_show`](../../examples/tauriv2/src-tauri/src/main.rs) requests `background_color(Color(0, 0, 0, 0))`; main also configures a background color | Configure background drawing before initializing the webview |
| `WKWebView._doAfterProcessingAllPendingMouseEvents:` | [`native-tests/webview-input.m`](../../examples/native-tests/webview-input.m), `drain`; standalone check only | Wait for native mouse processing before asserting DOM event counts |

The two `drawsBackground` entries affect different objects. Wails changes the created view; Wry changes its configuration before creation. A framework's public Rust or Go entry point can therefore still introduce a private native dependency.

## Necessity review

### Device scale

Keep this correction. A half-point native height previously left an uncovered strip because the native drawing size became integral before document layout. The device-pixel container provides integral local sizes without reducing the layout's precision. Public `pageZoom` preserves CSS dimensions, but does not independently set the backing density for those local coordinates. `_setOverrideDeviceScaleFactor:1` supplies that density once when attaching each content webview; the container and page zoom handle later display-scale changes. Main and modal webviews do not use this correction.

Review the selector's signature and the meaning of custom versus intrinsic scale after an update. A changed interpretation can cause incorrect CSS size, rendering density, or input coordinates. Verify actual half-point document coverage, the last device pixel, window resizing, and 2×↔1× display transitions with [`footer.test.mjs`](../../examples/test/footer.test.mjs) and [`geometry.test.mjs`](../../examples/test/geometry.test.mjs). The coordinate contract is in [native surfaces](../spec/native-surfaces.md).

The declaration is in [`WKWebViewPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h); the implementation uses `WebPageProxy::setCustomDeviceScaleFactor` and `deviceScaleFactor` in [`WebPageProxy.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp).

### Presentation completion

Keep this correction. Completing a JavaScript evaluation or a DOM animation-frame callback does not confirm that each separate webview has presented its new document geometry. The host waits for the main and visible application documents before committing the native transaction. External documents do not participate, so a busy external renderer cannot stop main-window layout.

Review callback timing, painting completion, and behavior during navigation or process termination. The callback alone is not proof of captured pixels: its implementation can complete immediately without a running process or drawing area. Document readiness and complete recordings remain required. Verify [`outside.test.mjs`](../../examples/test/outside.test.mjs), [`paint.test.mjs`](../../examples/test/paint.test.mjs), and [`hosts.test.mjs`](../../examples/test/hosts.test.mjs), including the external document's 700ms task and reload cleanup.

Review `_doAfterNextPresentationUpdate:` in [`WKWebView.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm) and `WebPageProxy::callAfterNextPresentationUpdate` in [`WebPageProxy.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebPageProxy.cpp).

### Pointer tracking

Keep this correction. Overlapping native tracking areas can deliver movement to more than one webview; choosing a view with public AppKit hit testing does not disable the other webview's tracking. The shared module applies the private flag according to that hit result. It does not disable keyboard, click, or drag handling, change keyboard focus, or replace the native event with a DOM event.

The private flag also affects mouse-enter and mouse-exit processing. The local monitor changes the selected target on mouse-move and mouse-enter events; it does not change that target on mouse-exit. Do not describe exit delivery as unconditionally enabled. Registration rejects an unavailable selector, and removal resets the flag. Review tracking-area behavior, event ordering, hover cleanup, hiding, removal, and retained keyboard input after an update. This API does not cancel work already submitted to WebKit; delayed cursor responses are not validated by the retained check.

Use the baseline and registered runs of the [standalone input check](examples.md#diagnostics), plus [`modal.test.mjs`](../../examples/test/modal.test.mjs). Review `_setIgnoresMouseMoveEvents:` in [`WKWebViewMac.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/mac/WKWebViewMac.mm) and its tracking handlers in [`WebViewImpl.mm`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm).

### Transparent background

Keep this correction for modal transparency. Transparent DOM content cannot reveal native content below an opaque webview. Public `underPageBackgroundColor` controls the color behind page content; setting CSS transparency and that color alone does not disable native background drawing. The private `drawsBackground` state supplies that separate requirement. The 50% shading and blur remain CSS behavior specified in [native modals](../spec/native-modals.md).

Review the exact KVC key, its receiver class, and whether configuration-time and instance-time settings still have the expected effect. Wails checks the assigned value and fails view creation on a KVC exception or an unchanged opaque state; the diagnostic read itself has no such exception handling. Geometry and presentation selectors are also called directly. Do not assume every unavailable private API produces a handled error.

Verify initial transparency, captured shading and blur, clear settings content after navigation, menus without a backdrop, and close/reload cleanup with [`modal.test.mjs`](../../examples/test/modal.test.mjs) and [manual acceptance](examples.md#manual-acceptance). Transparency does not correct fractional geometry; surface dimensions must independently pass the footer checks.

The view and configuration declarations are in [`WKWebViewPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h) and [`WKWebViewConfigurationPrivate.h`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewConfigurationPrivate.h). The active framework creation path is in [Wry 0.56.1 `wkwebview/mod.rs`](https://github.com/tauri-apps/wry/blob/wry-v0.56.1/src/wkwebview/mod.rs).

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

## Update review procedure

1. Record the old and new application revision, OS/build, installed WebKit version, SDK/toolchain, and resolved framework revisions. Read this inventory first when diagnosing a failure after any native update.
2. Match the symptom to the relevant entries. Compare receiver classes, selectors or keys, argument and callback types, availability, threading, and actual semantics in the changed source. Inspect framework callers even when the application uses a public wrapper. Source review narrows the investigation; reproduce the failure before assigning its cause.
3. Reassess necessity. Remove a correction when the required behavior is now implemented correctly without it. Preserve the behavior contract and remove harmful or unnecessary code instead of adding compatibility branches, fixed delays, reduced precision, or background recoloring to conceal a failure.
4. Follow [build and verification](examples.md): rebuild and restart both hosts, run the affected checks and `make examples-verify`, and run both standalone input variants when input dependencies change. Verify actual gestures and pixels. Record unavailable platforms or skipped checks explicitly.
5. Update this inventory and its Korean translation in the same change as API additions, replacements, removals, or changed call conditions. Record changed behavior and new validation in [features](../features.md) and [changes](../../CHANGELOG.md). Run `make docs-check`; source review must also confirm the inventory's accuracy.

The necessity decision belongs to the specific correction. Private status alone does not invalidate a correction, and successful tests alone do not justify its design. Each new entry requires a concrete cause, the public API limitation, exact implementation location and scope, failure signs, and verification steps.

## Review baseline

Source and necessity review: 2026-09-08, application implementation `1a921b4`. The environment reports macOS 26.6.2 (25G83), WebKit `21624.5.1.11.3`, and SDK 15.2. Dependencies are Wails `v3.0.0-beta.16`, Tauri revision `270c63f117eb1f4ff0a653ca63b2ca61e9175663`, Wry `0.56.1`, and Tao `0.37.0`, resolved by [`go.mod`](../../examples/wailsv3/go.mod), [`Cargo.toml`](../../examples/tauriv2/src-tauri/Cargo.toml), and [`Cargo.lock`](../../examples/tauriv2/src-tauri/Cargo.lock).

The application correction and standalone-check entries remain necessary for their stated purposes; this review removes no runtime calls. The input-monitor comment is corrected to avoid claiming unconditional mouse-exit delivery. Framework debugging and media defaults are recorded with their own purposes rather than as surface-fix requirements.

The existing 35/35 macOS host result applies to the unchanged application implementation; [features](../features.md) records its scope. This inventory review does not constitute new runtime, release, or cross-platform validation. The source links identify review locations; a current source declaration does not prove that an installed WebKit build contains the same implementation.
