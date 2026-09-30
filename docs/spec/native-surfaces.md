# Native surface layout

[한국어](native-surfaces.ko.md)

The approved single-DOM model is defined by [surface composition](surface-composition.md) and [plugin modules](plugins.md#surface-module-ownership). A logical surface is not a WebView. Native window facts identify the app DOM by its registered native view, not by its drawing order; document WebViews are below the app DOM. `appDomWebviews` and `documentWebviews` are measured from the native hierarchy. Counting a constant or inferring the main view from the first child is invalid. [Features](../features.md) tracks integration and verification separately.

This specification defines surface placement in the example applications. Implementation and validation status are recorded in [features](../features.md).

## Ownership

- The layout library computes card rectangles and updates their DOM elements.
- The example compositor derives surface rectangles from card rectangles and DOM insets.
- The host creates native views, applies surface rectangles, and reports actual geometry.
- The macOS presentation code commits native geometry after the window's single app DOM confirms presentation and every visible image region has its exact current raster.

The host must not assume that DOM and native rendering differ by at most one frame.

## Placement sequence

1. Before updating card DOM, the page submits the next surface rectangles.
2. The host acquires the UI thread's layer transaction for the owning window and applies the full native rectangles. The response contains actual geometry and one identifier for the complete preparation.
3. After preparation completes, the page updates card DOM and requests presentation for that identifier.
4. After the window's app DOM confirms presentation and the required image rasters are ready, the host commits the transaction and returns actual geometry. [Document regions](#document-regions) render independently and never join the DOM presentation wait, regardless of their URL origin.
5. The page starts the next preparation after that response, using the latest pending layout. A newer layout replaces an older layout that has not started, and neither the preparation nor the draw of the replaced layout runs. The newest layout contains every earlier input. When a presentation settles, the page writes the number of replaced layouts to the application log.

A native surface is never temporarily reduced to the intersection of pending rectangles. A surface without a matching future slot is hidden before the DOM changes. A surface whose future slot the page measured stays visible at its new rectangle during the preparation: the preparation's changes stay in the window's open transaction and do not reach the screen, and hiding a surface there would send a press at the place where the screen still shows it to the page instead. Measurement after drawing supplies the new rectangles. Hiding a view that contains the first responder makes AppKit move the first responder to another view or the window, so a surface hidden during a placement records its keyboard owner and returns the focus to it when it is shown again, unless the focus moved while the surface was hidden.

Hiding an existing surface preserves its applied native frame and image snapshot. An invisible request's empty rectangle is not a 1×1 replacement viewport. Hidden outer surfaces do not send raster configurations to suppliers; showing one applies its visible rectangle and configures the exact resulting raster if needed. A newly attached hidden surface must not start image rendering before it has a visible placement. A surface page can place a shown image region before a preparation has given its surface a native frame, because the page draws a new card before the host applies the card's rectangle; such a region has no raster geometry, and the host configures it when a preparation places the surface. A shown region in a placed surface without raster geometry is an error.

The outer surface owns visibility independently of the document generation. Removing image regions for a document's first load or navigation must not remove that surface state. Only closing the outer surface ends its visibility ownership.

Before waiting for image presentation, the host reads every visible image region's actual native raster and sends any required configuration. This check does not depend on a new DOM resize notification: a region can become visible without changing its element size or insets. A failed configuration batch reports the error and releases every unsent configuration so a later explicit operation can configure it; it does not silently mark unsent work as completed.

Applying an outer-surface rectangle starts required image configurations before returning the preparation to the page. Image rendering can proceed alongside DOM drawing and presentation. The final presentation check rereads native raster geometry after DOM presentation, because the document may have changed its anchor insets; parallel preparation never permits a stale raster to commit.

An older confirmation must not commit a newer preparation. Main-document navigation cancels that window's active and queued preparations. Native calls execute on the UI thread without blocking it while waiting for WebKit.

While a window's transaction is open, none of that window's changes reach the screen, and a newer preparation of the same window extends the open transaction. A wait for the window's presented state (`host.window.presented`) therefore ends only after a presentation update that follows the commit of every open or queued preparation of the window, and reports the target time of the screen's next refresh after that update.

A surface keeps the frame the host applied. Only the main document web view enables the Web Inspector; attaching it resizes that web view and does not move a surface, so the host holds no surface frame against outside changes.

Native layer transactions are shared by the UI thread. Preparations from different project windows are queued until the current window commits or cancels. A window's reload or closure cancels only that window's active and queued preparations. Waiting requests do not block the UI thread.

The host controls native view geometry. Each content webview renders its document independently; a delayed web document renderer must not stop the main window's layout updates.

The app DOM contains every mounted plugin DOM. Its presentation callback confirms that DOM plane, not another webview's content. Document regions retain independent content rendering; as subviews of their surface, their native frames still follow the card geometry in the transaction. URL-origin matching must not determine presentation ownership.

A native surface module is authorized only after the host has prepared the corresponding native surface handle. The authorization notification is delivered exactly once for each current surface generation before the module may declare composition, attach an image region, or open its sidecar session. A missing authorization is a lifecycle failure, not an indefinite loading state; the host must report an attributable error within the operation's bound.

The example preserves device-pixel placement, including 0.5 CSS pixel dimensions on a display with a scale factor of two. Card edges, rules, dividers, and prepared surface rectangles use that same grid. Rendered content must cover its native surface without a gap at the footer. Reducing placement precision or recoloring native backgrounds does not satisfy this requirement. Settings and menu transparency is configured separately.

On macOS, content webviews use a shared native container whose coordinates are device pixels. The host converts window rectangles through the native view hierarchy. Each content webview uses the display scale as its page zoom and one backing pixel per local coordinate unit. This preserves CSS dimensions and device-pixel ratio while providing integral native rendering sizes. Window resizing and display-scale changes preserve the conversion. WebKit takes wheel distances in the view's coordinate units, so the application's event monitor and native scroll input multiply the distances of a wheel event for a webview in the container by the display scale; a scroll moves the document by the same number of CSS pixels as points at every scale. Main and modal webviews retain window-point coordinates.

The [private native API inventory](../operations/private-native-apis.md) records the geometry, presentation, and input dependencies, their necessity, and the first review steps after native updates.

## Regions

A region is a place on a surface where native content is displayed. Its ownership, hierarchy, complete-snapshot geometry, stacking, input, generation, and raster rules are defined by [surface composition](surface-composition.md). This document defines behavior specific to document and image suppliers.

Every native region is a descendant of its surface's `SurfaceHost.NativePlane`. It is never a sibling of the host or DOM plane. The host derives region frames from the applied complete composition and clips them to the host. A region moves, hides, dims, and closes synchronously with its surface.

Regions are below modal dialogs. Document-region renderers are excluded from the presentation wait; visible image regions must have the exact current raster before the prepared layout commits. Each region has a unique name within its surface. The host reports the region's name, rectangle, visibility, and focused state through `host.window`.

There are two kinds of region suppliers:

- **Document regions**: Created by the core as subviews of surfaces, hosting web documents.
- **Image regions**: Created by external sidecars, supplying shared images as native surfaces.

## Input over native views

A native view is placed on the DOM: it draws the DOM element it is placed on and does not own that element's input. Input over it is decided by the page for the DOM element under the point, as if the native view were absent:

- Pointer and wheel events pass through image regions to the page; the page decides their meaning, including the cursor.
- A native view registers no cursor rectangles and no dragged types.
- Files dragged from another application onto a window go to the window's file drop view, the only native drag destination of the window composition. It lies above the composition's web views, accepts only file URLs, and returns no view from hit testing, so pointer events and other drags reach the views below. The view converts file reference URLs, which Finder places on the drag pasteboard, to file path URLs, and refuses a drop whose reference no longer resolves to a file. A drop sends the page `files-dropped` with the JSON text of `{urls, x, y}`, the file URLs and the drop point in page coordinates; the hosts pass the text unchanged, and the page parses it. The page finds the surface of the DOM element at the point and runs the drop command that the surface's plugin declares as `surface.drop` in `plugin.json`, on that surface, with `{urls}`. `core.drop` reports the last drop as `{urls, x, y, surface, command, error}`; a drop outside every surface, or on a surface whose plugin declares no drop command, sets `error` to its reason and runs nothing, as does text that is not such an object.
- The hosts disable the file-drop handling of their frameworks, so the file drop view is the only receiver of dropped files.

## Document regions

A surface page shows a web document in one of its elements through a document region. Surfaces themselves always show a page of their plugin package ([plugins](plugins.md)); a web address is never a surface.

- The manifest declares a unique name that matches `^[a-z0-9][a-z0-9-]{0,63}$`. The page obtains the document handle from `createSurfaceComposition`; individual attach, place, and detach operations are not public.
- The host creates a web view under the calling surface's `SurfaceHost.NativePlane` and verifies on every call that the calling DOM webview is the surface named in the request. A surface cannot operate another surface's regions.
- The complete composition reports the element's position as insets in CSS pixels from the edges of its viewport and whether it is shown. The host stores the insets and reapplies them when the outer surface changes in the same native transaction.
- A page hides a region by hiding its element. The composition then reports the region as not shown, and the host hides the native view, so it neither draws nor takes input. The browser plugin hides its document element while `browser.location` reports an empty `url`, which is its state before the first address. A browser surface without a stored address opens the address of the browser setting `browser.home` (label `홈 주소`, an address setting whose default is empty) when it mounts; while that setting is empty, the surface starts in the empty state. In the element's place it shows the empty state `browser.empty` with the text `주소를 입력하세요`; a click on it runs `browser.address.select`, which focuses the address field and selects its value. When a state reports a nonempty `url`, the plugin removes the empty state and shows the document element again.
- Regions load `http`, `https`, and `file` addresses. The application's own scheme is rejected, both when requested and when the document navigates. A `file` address loads with `loadFileURL:allowingReadAccessToURL:` granting read access to the file's containing directory; a path outside the granted directory is refused by WebKit itself. Region documents use one persistent website data store, separate from the application documents, and receive no application bridge. The store keeps its site data, such as cookies, local storage, and caches, in the directory `document-data` inside the application's configuration directory: the `--config-dir` directory when the application starts with it, otherwise the default configuration directory. Two configuration directories therefore never share site data, and removing a configuration directory removes its site data. The host creates the store with `_WKWebsiteDataStoreConfiguration` `initWithDirectory:` ([private native APIs](../operations/private-native-apis.md)), because the public `dataStoreForIdentifier:` keeps every store in the application's WebKit container.
- A region document follows the owning window's dark or light appearance: `prefers-color-scheme` matches the application mode and changes with it. The host sends the user agent of Safari on the same WebKit: it appends `Version/<major>.<minor> Safari/605.1.15` to the WebKit user agent through `applicationNameForUserAgent`, where the version is the `CFBundleShortVersionString` of the system Safari at `/Applications/Safari.app`. The region identifies itself as Safari because sites select their page by the browser name in the user agent and send a reduced page to a WebKit user agent without one; Google Search sends that user agent its basic page with gray buttons and sends Safari its current page. A site's own light or dark design is not changed: Google Search keeps the same appearance in both modes, as in Safari. A site can show the appearance it stored in an earlier visit with the same configuration directory. The host fails document creation when it cannot read the Safari version.
- `go` performs `back`, `forward`, `reload`, or `stop`, or `entry` with an integer `offset` other than 0, which loads the session history entry at that offset from the current entry, and returns whether it ran. An `offset` outside the history returns false; `offset` with another action, or `entry` without it, is an error.
- The host sends `document-state {surface, document, state}` only to the owning surface. `state` is `{url, title, loading, progress, canGoBack, canGoForward, error, scroll: {x, y}, history: {entries, index}, elements, requests}`; `error` is the last load failure or null, `scroll` is the document scroll position in CSS pixels, and `history` is the session history of the region: `entries` lists `{url, title}` from the oldest entry to the newest and `index` is the position of the current entry, or `entries` is empty and `index` is -1 before the first load. The history comes from the web view's back-forward list, so it has the entries the list keeps. `elements` and `requests` describe the current document, and both are empty from the start of a navigation until the new document reports them.
- `elements` is `{nodes, truncated}`: the elements of the main-frame document in document order, each `{depth, tag, id, class}` with the lowercase tag name and the `id` and `class` attribute values or empty strings, at most 500 elements with `truncated` true when the document has more. The host reports it when the document finishes parsing and after each change of the element tree or of an `id` or `class` attribute.
- `requests` is `{entries, truncated}`: the requests of the main-frame document that its Performance API records, the navigation first and then each resource in the order it was recorded, each `{url, type, start, duration}` where `type` is `navigation` or the resource's initiator type (`img`, `script`, `link`, `fetch`, `xmlhttprequest`, `css`, `other`, ...) and `start` and `duration` are milliseconds from the navigation start; at most 200 entries with `truncated` true when the document recorded more. The Performance API does not record request methods, headers, bodies, or response status, requests of subframes, or requests that the page makes before the host's script runs and that the resource timing buffer dropped, so `requests` has none of these.
- A script in the host's own content world collects `elements` and `requests` and posts them to the host through a script message handler of that world. Page scripts run in another world and cannot post to that handler, so a page cannot write these values; a page can still change what they report by changing its own document. Changes within one run-loop turn are reported once.
- The host closes a surface's regions when the surface is removed and when the surface page begins to show a new document, before that document can attach again. The new document attaches its regions itself.
- While a dialog is open, the host blurs regions with the same radius as the surface document blur.
- Regions participate in native input like surfaces: pointer input reaches the region under the point without activating the application, and page focus changes do not move the application's keyboard focus. `host.window` lists regions as `documents` with `focused` set only when the document WebView or one of its descendants is the window's native first responder, and `host.hit` reports `{kind: "document", surface, document}` ([exposure](exposure.md)).
- The presentation wait excludes regions. Their content renders independently.

## Image regions

Images are created by sidecars and supplied to the core through a region. The core receives only an opaque token and pixel size; it knows neither the image buffer nor the supplier's identity beyond the token.

- **Image supply and size validation**: The manifest assigns a supplier sidecar. The host computes the raster revision and exact dimensions from the applied native frame and sends them to the supplier. A frame must match its attachment generation, raster revision, monotonic sequence, actual token dimensions, expected dimensions, and window scale. A mismatch is rejected and never replaces the previous valid snapshot.
- **Device pixel reporting**: The region reports its size in device pixels, not CSS pixels.
- **Input handling**: Pointer events pass through to the surface document below, and the document decides the pointer's cursor: the region registers no cursor rectangles or cursor tracking areas, because the I-beam areas of a selectable `NSTextView` covered the cursors of page elements above the region when AppKit rebuilt cursor rectangles for a window that became key. When the window's view geometry changes, AppKit asks the view under the pointer for a cursor update; `WKWebView` does not answer it, so the window would set the arrow. The window composition answers by passing the current pointer location, as a mouse move, to the tracking owner of the WebKit view under the pointer, which sets the page's cursor for that location. Pointer routing also passes the first move to that owner when the target WebKit view changes or the application becomes active, because enabling that view's mouse tracking during the event can leave the page cursor stale until the pointer exits and re-enters. It passes no synthetic move while a mouse button is pressed. Keyboard input, input composition, and accessibility belong to the region. The region receives keyboard and composition events: `{type: "key", key: name, text?, shift, alt, ctrl}`, `{type: "insert", text}`, `{type: "compose", text?, caret?}`, and `{type: "focus", focused: boolean}`. Keys are delivered to the page. Command-key sequences are intercepted by the application menu. Focus changes on host request, and the current position is observed through `host.window`. A pointer press passes through the region to the page, and AppKit's press routing hands the first responder to the pressed page view for the gesture's setup; that handoff is not a focus change: the region keeps its reported focus and restores the responder itself, so a program watching focus reports sees none, and a press outside the region still reports the focus loss. A press inside another image region is a region-to-region transition (V5-114): the previously focused region reports its focus loss and hands the responder to the pressed region in the same event pass, so the page webview never holds the keyboard — while it did, the document refocused its active element and the browser card's address field visibly took focus for the gesture's duration.
- **Accessibility**: The region is an accessibility element. Its value is the screen text provided by the owner through `setAccessibleText`.
- **Image consumption**: The host copies an accepted transfer image into host-owned immutable presentation storage before replying `consumed`. The supplier must not modify or reuse the transfer image before that reply. The native layer never points at supplier-mutable storage.
- **Authorization**: The region specifies which sidecar is authorized to supply images. The host rejects images from unregistered sidecars with an error.
- **Error reporting**: If the host cannot present an image, the region sends an error event: `{type: "error", reason}`. Reasons include `notFound` (IOSurface not found), `forbidden` (access denied), `size` (declared dimensions do not match the IOSurface's actual dimensions), `scale` (the image was drawn at a scale other than the window's), and `presentFailed` (platform presentation failed).

`host.window.regions[].error` retains the last native presentation rejection until a valid frame is presented. A valid older snapshot does not make a later rejection disappear. Image pixels retain their size at the native backing scale; resizing a layer must not scale text to fill the new geometry.

Both hosts forward each native image event as `image-event {surface, name, event}` only to its owning surface webview. An empty callback, broadcast delivery, or substituting a direct sidecar command for keyboard delivery violates this contract. Invalid event JSON and delivery failures are reported, never replaced with a null event.

The terminal exposes its latest cell rows as `terminal.screen` and notifies subscribers on sidecar screen events. Input checks use native clicks and keys, wait for these notifications, and verify editing, command output, and isolation across at least three visible terminals. `terminal.input` checks only direct sidecar input, not native keyboard delivery.

## Acceptance criteria

- Recorded native content stays within its card on every measurable frame. Native content, card chrome, the rail sidebar, and its outer rail must preserve their relative geometry in the same frame; temporary inset growth does not satisfy this requirement.
- Page drawing that follows the cards, such as the rail outline, uses the rectangles that the last draw wrote to the card elements and the plane's CSS pixels. While a preparation is pending, the grid already holds the next layout, so drawing from the grid moves the drawing before the cards.
- During a divider drag, each recorded frame shows the layout of a step at most 34ms (two 60Hz frames) after the grid left that layout. A placement waits for the next presentation of the app DOM webview, so that webview renders at the display rate instead of WebKit's default rendering near 60fps.
- Such drawing does not use a coordinate system that scales with its element. That coordinate system fits the previous drawing to the new box, which moves it before the cards move.
- A layout that is replaced before it is presented does not reach the screen, so a position that the pointer holds for less than one presentation, such as the start position between two fast round trips, may be absent from a recording. A drag recording starts and ends at the start position and reaches the far end in every round trip.
- Drag input completes at the requested rate and recording includes the complete drag. Recording starts before input. A controlled test stops recording only after the capture contains the final geometry; a presentation callback or frame timestamp alone is insufficient.
- A run must fail if it records too few frames or cannot identify the surface and card in most frames.
- Continuous input must continue to update the displayed layout; postponing all rendering until release does not satisfy this specification.
- Surface creation, replacement, hiding, window resizing, and document reload must preserve these requirements.
- A document region stays on its element when its surface moves or resizes, receives native scroll input without application activation, and closes with its surface.
- Fractional-size checks measure actual CSS rectangles and recorded pixels. Integer-valued viewport queries alone do not establish the rendered document extent.
- The final device pixel inside a native surface must participate in document hit testing.
- Native pointer coordinates must match document coordinates after window resizing and changes between display scales.
- Settings and menu webviews remain above surfaces. Their behavior is specified in [data-native-modal](native-modals.md).

## Platform scope

Surface placement, visibility, stacking, and input follow the same contract in every host and operating system. Native implementations use the APIs and coordinate systems of their target platform.

Platform and framework defects are corrected in the host's native core within this repository when necessary. Private APIs are permitted when the required behavior cannot be obtained correctly through public APIs. Each correction must identify the cause, justify the API's role using its actual behavior, use the smallest sufficient implementation, and verify geometry, rendering, input, and lifecycle on the affected platform. Remove harmful or unnecessary changes. Passing tests is evidence of tested behavior; implementation review must also establish necessity and correct API use. API availability and maintenance risks are documented separately from the technical validity of the correction. Differences between hosts require diagnosis of the framework integration and native behavior; they do not establish the cause by themselves.

Native presentation validation currently targets macOS. Windows and Linux behavior is unverified. No framework fork is part of this implementation.

### darwin

Image region tokens on macOS consist of a global IOSurface identifier and a 16-byte nonce attached to that surface. When the host receives an image, it looks up the surface by identifier and rejects the image if the nonce does not match. This guards against reuse of recycled 32-bit identifiers.

IOSurface identifiers are in the global namespace of the user who owns the process. Different processes of the same user can look up and open the surface; this trust boundary is the same as the endpoint socket used for sidecar communication.
