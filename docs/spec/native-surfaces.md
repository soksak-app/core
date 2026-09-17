# Native surface layout

[한국어](native-surfaces.ko.md)

This specification defines surface placement in the example applications. Implementation and validation status are recorded in [features](../features.md).

## Ownership

- The layout library computes card rectangles and updates their DOM elements.
- The example compositor derives surface rectangles from card rectangles and DOM insets.
- The host creates native views, applies surface rectangles, and reports actual geometry.
- The macOS presentation code commits native geometry after the main document and visible application documents confirm presentation.

The host must not assume that DOM and native rendering differ by at most one frame.

## Placement sequence

1. Before updating card DOM, the page submits the next surface rectangles.
2. The host acquires the UI thread's layer transaction for the owning window and applies the full native rectangles. The response contains actual geometry and one identifier for the complete preparation.
3. After preparation completes, the page updates card DOM and requests presentation for that identifier.
4. After the main webview and visible webviews from the same application origin confirm presentation, the host commits the transaction and returns actual geometry. Hidden webviews and [document regions](#document-regions) do not delay this commit.
5. The page starts the next preparation after that response, using the latest pending layout. Outdated draw callbacks do not draw.

A native surface is never temporarily reduced to the intersection of pending rectangles. A surface without a matching future slot is hidden before the DOM changes. Measurement after drawing supplies the new rectangles.

An older confirmation must not commit a newer preparation. Main-document navigation cancels that window's active and queued preparations. Native calls execute on the UI thread without blocking it while waiting for WebKit.

While a window's transaction is open, none of that window's changes reach the screen, and a newer preparation of the same window extends the open transaction. A wait for the window's presented state (`host.window.presented`) therefore ends only after a presentation update that follows the commit of every open or queued preparation of the window, and reports the target time of the screen's next refresh after that update.

A surface keeps the frame the host applied. WebKit moves an inspected web view to the rest of the window when its Web Inspector is attached, and leaves it there when the inspector closes; the host restores the frame it last applied, so an open inspector overlaps the surface instead of moving it.

Native layer transactions are shared by the UI thread. Preparations from different project windows are queued until the current window commits or cancels. A window's reload or closure cancels only that window's active and queued preparations. Waiting requests do not block the UI thread.

The host controls native view geometry. Each content webview renders its document independently; a delayed web document renderer must not stop the main window's layout updates.

The main document's presentation callback does not confirm another webview's document size. Application documents participate in the same presentation completion check. Document regions retain independent content rendering; as subviews of their surface, their native frames still follow the card geometry in the transaction.

The example preserves device-pixel placement, including 0.5 CSS pixel dimensions on a display with a scale factor of two. Card edges, rules, dividers, and prepared surface rectangles use that same grid. Rendered content must cover its native surface without a gap at the footer. Reducing placement precision or recoloring native backgrounds does not satisfy this requirement. Settings and menu transparency is configured separately.

On macOS, content webviews use a shared native container whose coordinates are device pixels. The host converts window rectangles through the native view hierarchy. Each content webview uses the display scale as its page zoom and one backing pixel per local coordinate unit. This preserves CSS dimensions and device-pixel ratio while providing integral native rendering sizes. Window resizing and display-scale changes preserve the conversion. WebKit takes wheel distances in the view's coordinate units, so the application's event monitor and native scroll input multiply the distances of a wheel event for a webview in the container by the display scale; a scroll moves the document by the same number of CSS pixels as points at every scale. Main and modal webviews retain window-point coordinates.

The [private native API inventory](../operations/private-native-apis.md) records the geometry, presentation, and input dependencies, their necessity, and the first review steps after native updates.

## Document regions

A surface page shows a web document in one of its elements through a document region. Surfaces themselves always show a page of their plugin package ([plugins](plugins.md)); a web address is never a surface.

- The page attaches a region under a name that is unique within the surface and matches `^[a-z0-9][a-z0-9-]{0,63}$`. Attaching a name that is already attached fails. Plugin pages call `attachDocument(element, name)` from `@soksak/plugin-api/page`; the runtime interface is `page.document` (`attach`, `place`, `load`, `go`, `detach`, `onState`).
- The host creates a web view as a subview of the calling surface's web view and verifies on every call that the calling web view is the surface named in the request. A surface cannot operate another surface's regions.
- The page reports the element's position as insets in CSS pixels from the edges of its viewport, and whether the element is shown. It sends a new placement when the element or an ancestor changes size, and when the viewport resizes or scrolls; it does not poll. The host applies the insets in the surface's coordinates. The region is a subview of the surface, so it moves and hides with the surface in the same native transaction; when the surface changes size, the region takes its frame from its insets again in that frame change, including after the surface was smaller than the insets.
- Regions load only `http` and `https` addresses. Other schemes, including the application's own scheme and `file`, are rejected, both when requested and when the document navigates. Region documents use a persistent website data store named `soksak-documents`, separate from the application documents, and receive no application bridge.
- `go` performs `back`, `forward`, `reload`, or `stop` and returns whether it ran.
- The host sends `document-state {surface, document, state}` only to the owning surface. `state` is `{url, title, loading, progress, canGoBack, canGoForward, error, scroll: {x, y}}`; `error` is the last load failure or null, and `scroll` is the document scroll position in CSS pixels. Changes within one run-loop turn are reported once.
- The host closes a surface's regions when the surface is removed and when the surface page begins to show a new document, before that document can attach again. The new document attaches its regions itself.
- While a dialog is open, the host blurs regions with the same radius as the surface document blur.
- Regions participate in native input like surfaces: pointer input reaches the region under the point without activating the application, and page focus changes do not move the application's keyboard focus. `host.window` lists regions as `documents` and `host.hit` reports `{kind: "document", surface, document}` ([exposure](exposure.md)).
- The presentation wait excludes regions. Their content renders independently.

## Acceptance criteria

- Recorded native content stays within its card on every measurable frame. Native content, card chrome, the rail sidebar, and its outer rail must preserve their relative geometry in the same frame; temporary inset growth does not satisfy this requirement.
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
