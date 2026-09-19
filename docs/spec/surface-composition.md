# Surface composition

[한국어](surface-composition.ko.md)

This specification defines the ownership boundary between a surface page and native content. It is the canonical contract for DOM-only and hybrid surfaces. [Native surface layout](native-surfaces.md) defines placement of the outer surface.

## Model

Every surface has one `SurfaceHost`. The host clips, moves, hides, dims, and closes all content of that surface as one unit.

```text
SurfaceHost
├─ NativePlane
│  ├─ document regions
│  ├─ image regions
│  └─ other declared native region kinds
└─ DOMPlane: one transparent surface webview
   ├─ DOM-owned content
   ├─ native anchors that provide geometry and do not paint
   └─ declared DOM overlays
```

A DOM-only surface has an empty `NativePlane`; its `DOMPlane` may remain opaque. A hybrid surface has a transparent `DOMPlane`. The page controller forces each native anchor, including its descendants and pseudo-elements, transparent with zero opacity and forces every ancestor from the page root to that anchor to have no background image, background color, or box shadow. It forces pointer hit testing on native anchors and declared overlays, confines overlay painting to the declared overlay element's box, and continuously restores these properties if page code changes them. The anchor still participates in layout and DOM hit testing but provides geometry only. DOM overlays are the only declared DOM content allowed to accept input above a native document region. An overlay and a native anchor cannot contain each other.

`SurfaceHost` is the sole compositor. No page, plugin, sidecar, host relay, or platform adapter may place, size, order, show, hide, hit-route, or present a native region except through the complete declared composition owned by that host.

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

`composition.update(change)` applies a code-driven DOM change, measures all declared anchors and overlays, and submits one complete snapshot. The controller also compares their geometry on animation frames and observes every anchor, overlay, and ancestor for resize, viewport resize, and scroll. Every detected change submits the same complete snapshot. No observer or caller can submit one region independently. Individual public `attach`, `place`, and raw region ports do not exist.

The returned region handle contains only operations for its declared kind. Document handles load and navigate. Image handles control focus, caret, accessibility text, and receive supplier events. Detaching an individual region is not permitted; closing or navigating the surface destroys the complete composition.

## Revisions and atomicity

Composition and raster progress are separate.

- A **composition revision** is one complete snapshot of all region and overlay rectangles, visibility, order, and input ownership. The host validates the complete snapshot, then applies it atomically. A partial or stale revision is rejected. Outer-surface movement applies the stored composition synchronously in the same native transaction and does not wait for JavaScript or a sidecar.
- A **raster revision** changes only when an image region's native pixel width, native pixel height, or backing scale changes. Position-only changes and hide/show at the same size retain the revision. The host computes the expected raster geometry from the applied native rectangle; a plugin must not derive it from `clientWidth * devicePixelRatio`.

Each surface attachment has a generation. Navigation, replacement, or close ends that generation. Region operations and image frames carry the generation; the host rejects data from an older generation even when the surface and region names were reused.

Continuous layout never waits for raster production. Until the exact raster for the current revision is consumed, the host clips and scales the previous immutable snapshot to cover the current region. Before the first valid snapshot, the image layer stays transparent so the application's surface background remains visible; it never exposes a platform-default background. After input settles, `host.window.presented` completes only after each image region whose own placement and `SurfaceHost` are both visible has presented the exact current raster and the resulting native transaction has reached the display. Hiding or showing the outer surface updates that requirement without changing the region raster revision. The command fails on timeout instead of accepting a missing or failed presentation. Empty native pixels after a prior snapshot, exposing a platform-default background, and allowing native content outside `SurfaceHost` are failures.

A settled `SurfaceHost` commit has the same completion boundary: a settled surface placement is not complete until every visible image region in that composition has consumed and presented its exact current raster. Returning from a DOM-only page, such as the project library, to a hybrid surface must not expose the restored DOM page as complete while any visible native image region is still pending. Tests must verify this boundary by navigating away from a surface with multiple visible native regions and asserting every region's frame and presented raster immediately after return, without an additional presentation command.

## Image transfer

An image supplier receives host `configure` events containing the attachment generation, raster revision, exact pixel width, exact pixel height, and scale. The supplier coalesces pending configurations to the newest revision.

For each frame, the supplier writes a transfer image and sends `{name, generation, raster, sequence, token, width, height, scale}`. It must not modify or reuse that transfer image until the host replies `consumed` or rejects it. Sequences increase within one generation and raster revision.

The host verifies the caller, declaration, supplier, generation, raster revision, sequence, token authorization, actual image dimensions, expected native dimensions, and scale. It copies valid pixels into host-owned immutable presentation storage, swaps that snapshot into the image layer, and then replies `consumed`. A native presentation layer never points at storage the supplier may overwrite. Invalid or stale frames do not replace the previous valid snapshot.

## Input and stacking

The DOM plane is above the native plane. Input ownership is evaluated for the current composition revision in this order:

1. the topmost declared DOM overlay;
2. the topmost native region whose declaration owns native input;
3. the DOM plane.

An image region with DOM input lets pointer events reach its anchor while native keyboard composition and accessibility remain on its image handle after explicit focus. A document region receives native pointer input except where a declared DOM overlay covers it. Arbitrary DOM content is not an overlay and cannot intercept a native-owned point.

## Failure behavior

Composition validation fails closed. Manifest validation rejects undeclared, missing, duplicate, and input-conflicting regions and overlays. The page controller requires the exact declared element set before attachment. The host keeps the last complete valid composition or hides the affected native regions; it never applies a partial request, reparents a region outside `SurfaceHost`, infers a missing declaration, substitutes a compatibility path, reduces coordinate precision, or paints over an unexplained gap.

## Acceptance

- Native content remains clipped to its `SurfaceHost` on every recorded frame during split drag, window resize, hide/show, reorder, navigation, reload, replacement, and close.
- A recording starts before native input, includes the complete gesture at the requested rate, and fails on missing frames or any platform-default pixels.
- Tests delay and reorder composition snapshots, configure events, and image frames. Stale generations, revisions, and sequences never become visible.
- A hybrid surface preserves native/DOM stacking and hit ownership at fractional coordinates and after backing-scale changes.
- The final settled frame uses an exact current raster; stretching is permitted only while a newer raster is pending during continuous layout.
- Both native hosts enforce the same declaration and revision rules. A platform that cannot implement them fails at startup.
