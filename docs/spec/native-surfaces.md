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
2. The host begins a main-thread layer transaction and applies the full native rectangles. The response contains actual geometry and one identifier for the complete preparation.
3. After preparation completes, the page updates card DOM and requests presentation for that identifier.
4. After the main webview and visible webviews from the same application origin confirm presentation, the host commits the transaction and returns actual geometry. Hidden webviews and documents from external origins do not delay this commit.
5. The page starts the next preparation after that response, using the latest pending layout. Outdated draw callbacks do not draw.

A native surface is never temporarily reduced to the intersection of pending rectangles. A surface without a matching future slot is hidden before the DOM changes. Measurement after drawing supplies the new rectangles.

An older confirmation must not commit a newer preparation. Main-document navigation cancels any open transaction. Native calls execute on the UI thread without blocking it while waiting for WebKit.

The host controls native view geometry. Each content webview renders its document independently; a delayed external renderer must not stop the main window's layout updates.

The main document's presentation callback does not confirm another webview's document size. Application documents participate in the same presentation completion check. External documents retain independent content rendering; their native frames still follow the card geometry in the transaction.

Ordinary content webviews use default opaque rendering. Their documents define their backgrounds. Settings and menu transparency is configured separately.

## Acceptance criteria

- Recorded native content stays within its card on every measurable frame. Native content, card chrome, the rail sidebar, and its outer rail must preserve their relative geometry in the same frame; temporary inset growth does not satisfy this requirement.
- Drag input completes at the requested rate and recording includes the complete drag. Recording starts before input. A controlled test stops recording only after the capture contains the final geometry; a presentation callback or frame timestamp alone is insufficient.
- A run must fail if it records too few frames or cannot identify the surface and card in most frames.
- Continuous input must continue to update the displayed layout; postponing all rendering until release does not satisfy this specification.
- Surface creation, replacement, hiding, window resizing, and document reload must preserve these requirements.
- Settings and menu webviews remain above surfaces. Their behavior is specified in [data-native-modal](native-modals.md).

## Platform scope

Native presentation validation currently targets macOS. Windows and Linux behavior is unverified. No framework fork is part of this implementation.
