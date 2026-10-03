# Surface composition

[한국어](surface-composition.ko.md)

This specification defines the ownership boundary between a surface page and native content. It is the canonical contract for DOM-only and hybrid surfaces. [Native surface layout](native-surfaces.md) defines placement of the outer surface.

## Model

Each window has one application DOM webview. Each surface has one logical `SurfaceHost` that clips, moves, hides, dims, and closes its native content. Plugin DOM is mounted inside that window's DOM plane. The single-DOM implementation is in progress; [features](../features.md) records validation separately.

```text
Window compositor
├─ NativePlane
│  └─ SurfaceHost per logical surface
│     ├─ document regions
│     ├─ image regions
│     └─ other declared native region kinds
└─ DOMPlane: one transparent application webview
   ├─ workbench and mounted plugin DOM
   ├─ native anchors that provide geometry and do not paint
   └─ declared DOM overlays, menus, and dialogs
```

A DOM-only surface paints its content in the shared DOM plane and has no native regions. A hybrid surface leaves its native anchors transparent. The page controller forces each native anchor, including its descendants and pseudo-elements, transparent with zero opacity and forces every ancestor from the mounted surface root to that anchor to have no background image, background color, or box shadow. The workbench owns transparency outside that root. It forces pointer hit testing on native anchors and declared overlays, confines overlay painting to the declared overlay element's box, and continuously restores these properties if plugin code changes them. The anchor still participates in layout and DOM hit testing but provides geometry only. Declared plugin overlays and workbench menus/dialogs own input above native document regions. An overlay and a native anchor cannot contain each other.

`SurfaceHost` is the sole compositor. No page, plugin, sidecar, host relay, or platform adapter may place, size, order, show, hide, hit-route, or present a native region except through the complete declared composition owned by that host.

The DOM/native order above describes logical ownership and clipping, not an unqualified AppKit subview order. On macOS, a transparent `WKWebView` backing can still cover native sibling pixels when the native plane is below it in the AppKit hierarchy. The Darwin host therefore places the clipped native plane above the transparent app-DOM backing at the platform compositor level. DOM overlays and input routing still follow the logical order below; native content is never allowed to escape its `SurfaceHost` or to own an overlay's point, so the Darwin host cuts the native plane out under every visible declared overlay and the overlay's DOM pixels show there. A platform adapter must document and enforce the equivalent compositor rule rather than assuming that CSS transparency changes native sibling ordering.

## Declaration

Every `plugin.json` surface declares one composition.

```json
{
  "surface": {
    "page": "ui/shell.html",
    "composition": { "kind": "dom" }
  }
}
```

A hybrid composition declares every native region and every DOM overlay before the page loads.

```json
{
  "surface": {
    "page": "ui/terminal.html",
    "composition": {
      "kind": "hybrid",
      "regions": [
        {
          "name": "view",
          "kind": "image",
          "sidecar": "@soksak/sidecar-vt-alacritty",
          "input": "dom"
        }
      ],
      "overlays": []
    }
  }
}
```

Region names are unique and match `^[a-z0-9][a-z0-9-]{0,63}$`. Region order in the array is back to front. A document region has `kind: "document"` and `input: "native"`. An image region has `kind: "image"`, names one sidecar already listed by the plugin, and has `input: "dom"`. `overlays` is an array of unique names that use the same name syntax. Unknown kinds, fields, input owners, undeclared sidecars, duplicate names, and overlays that duplicate region names are errors. A DOM composition cannot declare regions or overlays.

The workbench includes the validated declaration in every outer-surface synchronization. A host stores that declaration on the `SurfaceHost` before it accepts a page request. The host rejects a request whose caller, name, kind, supplier, generation, or operation is not declared. Calling a lower-level bridge directly does not bypass this check.

## Page API

A page creates its composition once:

```js
const composition = await createSurfaceComposition({
  regions: { view: document.querySelector("[data-region=view]") },
  overlays: {},
});
const view = composition.region("view");
```

The keys must exactly equal the manifest declarations, and every value must be an element in the calling document. Creation attaches every region and submits one complete layout snapshot. It fails without attaching anything if any declaration or element is missing or extra.

`composition.update(change)` applies a code-driven DOM change, measures all declared anchors and overlays, and submits one complete snapshot. The controller observes every anchor, overlay, and ancestor for resize, viewport resize, scroll, and DOM mutation; every observed change submits the same complete snapshot. Every detected change submits the same complete snapshot. No observer or caller can submit one region independently. Individual public `attach`, `place`, and raw region ports do not exist.

A viewport or observed-element size change always submits a composition snapshot, even when all measured insets are unchanged. A full-surface image region therefore receives a new raster configuration when its surface size changes. A visible hybrid surface has exactly one attached native region for each declared visible native region; an orphan region or a visible surface without its declared region is an error.

Insets use the element's CSS rectangle and the current mounted viewport. Native surface and region frames use AppKit points, while backing scale applies only to raster dimensions. WebKit may expose a whole-CSS-pixel `visualViewport` for a fractional AppKit frame (for example, `200.5pt` at `2x` can report `200` CSS px); that platform quantization is measured explicitly and must not change the native frame or final backing-pixel row. Integer `innerWidth` and `innerHeight` do not define native raster geometry.

The returned region handle contains only operations for its declared kind. Document handles load and navigate. Image handles control focus, caret, accessibility text, and receive supplier events. Detaching an individual region is not permitted; closing or navigating the surface destroys the complete composition.

Closing a surface waits for its last in-flight complete composition placement to settle before detaching regions or removing the native composition declaration. A close may cancel future placements, but it must not let a placement race after the declaration or its native region has been removed.

## Revisions and atomicity

Composition and raster progress are separate.

Native transaction commit and cancellation can synchronously invoke window redraw callbacks. Hosts execute them on the native main queue outside the framework's event-dispatch locks. Dispatching through a framework callback that holds those locks is not a safe completion boundary. The commit still waits for application-document presentation and the exact current image raster; moving its execution does not remove either requirement.

- A **composition revision** is one complete snapshot of all region and overlay rectangles, visibility, order, and input ownership. The host validates the complete snapshot, then applies it atomically. A partial or stale revision is rejected. Revisions increase per surface: the host keeps the last applied revision of each surface until the surface is destroyed or its document is replaced, so the main page numbers every placement of the document with one increasing number, which also keeps a composition created when a surface is mounted again, or when a tab with the same id opens again, above the earlier revisions of that surface. Outer-surface movement applies the stored composition synchronously in the same native transaction and does not wait for JavaScript or a sidecar.
- A **raster revision** changes only when an image region's native pixel width, native pixel height, or backing scale changes. Position-only changes and hide/show at the same size retain the revision. The host computes the expected raster geometry from the applied native rectangle; a plugin must not derive it from `clientWidth * devicePixelRatio`.

Each surface attachment has a generation. Navigation, replacement, or close ends that generation. Region operations and image frames carry the generation; the host rejects data from an older generation even when the surface and region names were reused.

Reloading the app DOM replaces every mounted plugin document in that window. The host cancels the pending layout, hides the logical surfaces, closes their document/image attachments, clears their exposure registrations and composition revisions, and advances attachment generations before remount. This operation does not close terminal sessions; the new modules reconnect to the same session owners. Per-tab WebView navigation callbacks cannot implement this lifecycle in the single-DOM model. The reload command hides the surfaces before it ends the page process, so the window shows no native surface without the page. A screen change within the page, such as opening the library and returning to the workspace, shows no frame without the page.

Continuous layout commits only a complete native frame. The host keeps the previous complete frame visible while a newer composition or raster is pending; it never commits a new region geometry with an older raster, clips the old raster into the new geometry, or exposes a platform-default background. A visible image region's composition revision, raster revision, exact dimensions, and presented snapshot must all belong to the prepared layout before the host commits it. Before the first valid snapshot, the image layer stays transparent so the application's surface background remains visible. After input settles, `host.window.presented` also verifies that each image region whose own placement and `SurfaceHost` are visible has presented the exact current raster and that the resulting native transaction has reached the display. Hiding or showing the outer surface updates that requirement without changing the region raster revision. The command fails on timeout instead of accepting a missing or failed presentation. Empty native pixels, stale raster content, exposing a platform-default background, and allowing native content outside `SurfaceHost` are failures.

A settled `SurfaceHost` commit has the same completion boundary: a settled surface placement is not complete until every visible image region in that composition has consumed and presented its exact current raster. Returning from a DOM-only page, such as the project library, to a hybrid surface must not expose the restored DOM page as complete while any visible native image region is still pending. Tests must verify this boundary by navigating away from a surface with multiple visible native regions and asserting every region's frame and presented raster immediately after return, without an additional presentation command.

## Image transfer

An image supplier receives host `configure` events containing the attachment generation, raster revision, exact pixel width, exact pixel height, and scale. The supplier coalesces pending configurations to the newest revision.

For each frame, the supplier writes a transfer image and sends `{name, generation, raster, sequence, token, width, height, scale}`. It must not modify or reuse that transfer image until the host replies `consumed` or rejects it. Sequences increase within one generation and raster revision.

The host verifies the caller, declaration, supplier, generation, raster revision, sequence, token authorization, actual image dimensions, expected native dimensions, and scale. It copies valid pixels into host-owned immutable presentation storage, swaps that snapshot into the image layer, and then replies `consumed`. A native presentation layer never points at storage the supplier may overwrite. Invalid or stale frames do not replace the previous valid snapshot.

## Input and stacking

The DOM plane owns the logical overlay layer above native regions. The platform compositor may place the native plane above the app-DOM backing when required to make native pixels visible; this does not change logical clipping or input ownership. Input ownership is evaluated for the current composition revision in this order:

1. the topmost declared DOM overlay;
2. the topmost native region whose declaration owns native input;
3. the DOM plane.

An image region with DOM input lets pointer events reach its anchor while native keyboard composition and accessibility remain on its image handle after explicit focus. A document region receives native pointer input except where a declared DOM overlay covers it. Arbitrary DOM content is not an overlay and cannot intercept a native-owned point.

## Failure behavior

Composition validation fails closed. Manifest validation rejects undeclared, missing, duplicate, and input-conflicting regions and overlays. The page controller requires the exact declared element set before attachment. The host keeps the last complete valid composition or hides the affected native regions; it never applies a partial request, reparents a region outside `SurfaceHost`, infers a missing declaration, substitutes a compatibility path, reduces coordinate precision, or paints over an unexplained gap.

A failed preparation or presentation rejects its requesting operation and appears in verification status and the error display. It does not permanently reject the work queue: a subsequent user layout operation can submit a new preparation. Rejected preparation promises are not reused, and no automatic retry reports the failed operation as successful.

## Acceptance

- Native content remains clipped to its `SurfaceHost` on every recorded frame during split drag, window resize, hide/show, reorder, navigation, reload, replacement, and close.
- A recording starts before native input, includes the complete gesture at the requested rate, and fails on missing frames or any platform-default pixels.
- Tests delay and reorder composition snapshots, configure events, and image frames. Stale generations, revisions, and sequences never become visible.
- A hybrid surface preserves native/DOM stacking and hit ownership at fractional coordinates and after backing-scale changes.
- Every committed frame uses an exact current raster; a pending raster holds the previous complete frame until the new raster is consumed.
- A terminal image preserves its logical text while resizing: narrowing reduces terminal columns and reflows long logical rows onto multiple screen rows; widening increases columns and reflows those rows back without truncation or permanent narrow wrapping.
- Terminal cell width and height are stable presentation metrics during layout; divider movement changes the surface and raster geometry, not the font or cell metrics, and native geometry changes do not animate.
- Both native hosts enforce the same declaration and revision rules. A platform that cannot implement them fails at startup.
