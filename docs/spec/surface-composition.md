# Surface composition


A settled image presentation wait follows the latest accepted frame until completion. Freezing its sequence when the wait begins would let a settled commit finish while a later accepted frame remains pending; a later accepted frame therefore keeps the wait pending even when an earlier frame completed before its arrival.
A continuous layout wait instead requires an installed complete snapshot of the current generation and raster. Later accepted sequences of that same raster do not invalidate its geometry or restart this wait. Raster and generation changes invalidate the snapshot, and any presentation failure still rejects completion. This distinction prevents unrelated same-size image updates from indefinitely extending a continuous layout transaction; settled completion still confirms the latest content.

[한국어](surface-composition.ko.md)

This specification defines the ownership boundary between a surface page and native content. It is the canonical contract for the native regions and overlays of a view surface. [Native surface layout](native-surfaces.md) defines placement of the outer surface.

## Model

Each window has one application DOM webview. Each surface has one logical `SurfaceHost` that clips, moves, hides, dims, and closes its native content. Plugin DOM of the `dom` composition is mounted inside that window's DOM plane, and a surface of the `view` composition runs its page in a web view of its own ([plugins](plugins.md#view-surfaces)). The single-DOM implementation is in progress; [features](../features.md) records validation separately.

The mygo host has no application DOM webview. The container of the surface hosts of a window lies in the native view of the window, and the workbench shows each surface through a native view element ([native views](hosts.md#native-views)).

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


`SurfaceHost` is the sole compositor. No page, plugin, sidecar, host relay, or platform adapter may place, size, order, show, hide, hit-route, or present a native region except through the complete declared composition owned by that host.

The DOM/native order above describes logical ownership and clipping, not an unqualified AppKit subview order. On macOS, a transparent `WKWebView` backing can still cover native sibling pixels when the native plane is below it in the AppKit hierarchy. The Darwin host therefore places the clipped native plane above the transparent app-DOM backing at the platform compositor level. DOM overlays and input routing still follow the logical order below; native content is never allowed to escape its `SurfaceHost` or to own an overlay's point, so the Darwin host cuts the native plane out under every visible declared overlay and the overlay's DOM pixels show there. A platform adapter must document and enforce the equivalent compositor rule rather than assuming that CSS transparency changes native sibling ordering.

For a view surface the stacking order of input and visual ownership, from the top, is: the view's DOM overlays, then its view regions, then the view page DOM. A point inside a visible view overlay rect is delivered to the overlay's DOM view when that view's DOM has a hit at the point, and to nothing otherwise. It is never delivered to a region or to the native plane.

## Declaration

Every `plugin.json` surface declares one composition.

```json
{
  "surface": {
    "composition": { "kind": "view", "page": "ui/view.html" }
  }
}
```

A `view` composition declares its page, and it declares its native regions and overlays in `plugin.json`, if it has any. Its page does not create a composition; the workbench declares the composition when the view mounts ([view surfaces](plugins.md#view-surfaces)). A view composition declares every native region and every DOM overlay before the page loads. The kind `dom` and the kind `hybrid` do not exist: the reader refuses both.

```json
{
  "surface": {
    "composition": {
      "kind": "view",
      "page": "ui/view.html",
      "regions": [
        {
          "name": "view",
          "kind": "image",
          "sidecar": "@scope/sidecar-probe",
          "present": "copy",
          "input": "dom"
        }
      ],
      "overlays": []
    }
  }
}
```

Region names are unique and match `^[a-z0-9][a-z0-9-]{0,63}$`. Region order in the array is back to front. A document region has `kind: "document"` and `input: "native"`. An image region has `kind: "image"`, names one sidecar already listed by the plugin, declares `present` as `copy` or `lease` ([presentation mode](native-surfaces.md#image-regions)), and has `input: "dom"`. `overlays` is an array of unique names that use the same name syntax. Unknown kinds, fields, input owners, undeclared sidecars, duplicate names, and overlays that duplicate region names are errors.

The workbench includes the validated declaration in every outer-surface synchronization. A host stores that declaration on the `SurfaceHost` before it accepts a page request. The host rejects a request whose caller, name, kind, supplier, generation, or operation is not declared. Calling a lower-level bridge directly does not bypass this check.

## Page API

A view creates its composition once through the composition of its view bridge (`bridge` is the view bridge of `@soksak/plugin-api/view`, [view surfaces](plugins.md#view-surfaces)):

```js
const composition = await bridge.composition.create({
  regions: { view: document.querySelector("[data-region=view]") },
  overlays: {},
  input: { view: (event) => receive(event) },
});
const view = composition.region("view");
```

The keys must exactly equal the manifest declarations, and every value must be an element in the calling document. `input` holds one function for each declared image region and no other key, the handler of the `input` events of that region ([image regions](native-surfaces.md#image-regions)). A creation that gives no `input` gives no function, so it holds only for a declaration without an image region, and no region of such a creation receives an input event. A missing `input` over an image region, or a missing, extra or non-function entry, fails the creation with `composition input must exactly match the image regions of the surface declaration (expected <names>)`. Creation attaches every region and submits one complete layout snapshot. It fails without attaching anything if any declaration or element is missing or extra.

`composition.update(change)` applies a code-driven DOM change, measures all declared anchors and overlays, and submits one complete snapshot. The controller observes every anchor, overlay, and ancestor for resize, viewport resize, scroll, and DOM mutation; every observed change submits the same complete snapshot. Every detected change submits the same complete snapshot. No observer or caller can submit one region independently. Individual public `attach`, `place`, and raw region ports do not exist.

A viewport or observed-element size change always submits a composition snapshot, even when all measured insets are unchanged. A full-surface image region therefore receives a new raster configuration when its surface size changes. A visible view surface has exactly one attached native region for each declared visible native region; an orphan region or a visible surface without its declared region is an error.

Insets use the element's CSS rectangle and the current mounted viewport, measured from the edges of the web view frame: the right and bottom insets add back a classic scroll bar of the root (`innerWidth` less the root `clientWidth`, and the same for the height), because `visualViewport` excludes it and the frame contains it. The web view places the vertical scroll bar of a root whose direction is right to left on the left, so for such a root the left inset adds the scroll bar width and the right inset does not. Native surface and region frames use AppKit points, while backing scale applies only to raster dimensions. WebKit may expose a whole-CSS-pixel `visualViewport` for a fractional AppKit frame (for example, `200.5pt` at `2x` can report `200` CSS px); that platform quantization is measured explicitly and must not change the native frame of a surface or its final backing-pixel row. WebKit lays out and paints only the whole points of a web view frame, so a document region takes the whole points inside its insets: its right and bottom edges move inward to the edge of its page, and no row of the region shows the backing of the web view, and the part of a point that the region leaves is the area of the view page and takes its input. The view web view is the root of its surface and keeps the fractional frame of the surface, so the final backing-pixel row of the surface belongs to the view. An image region keeps its fractional frame. Integer `innerWidth` and `innerHeight` do not define native raster geometry.

The returned region handle contains only operations for its declared kind. Document handles load, navigate, and exchange messages with a plugin document (`post(message)` and `onMessage(fn)`, [document regions](native-surfaces.md#document-regions)). A document handle also reports `history`: null until its attach replies, then whether the region restored a session history. A view document handle reports the same `history` as a page document handle, and an attach reply without a boolean `history` rejects the composition with an error that names the region. Image handles control focus, caret, accessibility text, and receive supplier events. Detaching an individual region is not permitted; closing or navigating the surface destroys the complete composition.

An observed geometry equal to the last placement sends no placement, because one view resize reaches both of its observers. A refused placement is sent again at the next observation, and `composition.update` always sends its placement. An image region does not send a caret equal to the last accepted one, because the host holds the caret relative to the region; a refused caret is sent again.

Closing a surface waits for its last in-flight complete composition placement to settle before detaching regions or removing the native composition declaration. A close may cancel future placements, but it must not let a placement race after the declaration or its native region has been removed.

## Revisions and atomicity

Composition and raster progress are separate.

Native transaction commit and cancellation can synchronously invoke window redraw callbacks. Hosts execute them on the native main queue outside the framework's event-dispatch locks. Dispatching through a framework callback that holds those locks is not a safe completion boundary. The commit still waits for application-document presentation and the exact current image raster; moving its execution does not remove either requirement.

- A **composition revision** is one complete snapshot of all region and overlay rectangles, visibility, order, and input ownership. The host validates the complete snapshot, then applies it atomically. A partial or stale revision is rejected. Revisions increase per surface: the host keeps the last applied revision of each surface until the surface is destroyed or its document is replaced, so the main page numbers every placement of the document with one increasing number, which also keeps a composition created when a surface is mounted again, or when a tab with the same id opens again, above the earlier revisions of that surface. Outer-surface movement applies the stored composition synchronously in the same native transaction and does not wait for JavaScript or a sidecar.
- A **raster revision** changes only when an image region's native pixel width, native pixel height, or backing scale changes. Position-only changes and hide/show at the same size retain the revision. The host computes the expected raster geometry from the applied native rectangle; a plugin must not derive it from `clientWidth * devicePixelRatio`. A region attached again in the same generation, for example when the page mounts the surface again, continues the revision above its last value, because the sidecar ignores a configuration whose generation and raster revision are not newer than the ones it holds.

Each surface attachment has a generation. Navigation, replacement, or close ends that generation. Region operations and image frames carry the generation; the host rejects data from an older generation even when the surface and region names were reused.

Reloading the app DOM replaces every mounted plugin document in that window. The host cancels the pending layout, hides the logical surfaces, closes their document/image attachments, clears their exposure registrations and composition revisions, and advances attachment generations before remount. This operation does not close sidecar sessions; the new modules reconnect to the same session owners. Per-tab WebView navigation callbacks cannot implement this lifecycle in the single-DOM model. The reload command hides the surfaces before it ends the page process, so the window shows no native surface without the page. A screen change within the page, such as opening the library and returning to the workspace, shows no frame without the page.

Continuous layout commits only a complete native frame. The host keeps the previous complete frame visible while a newer composition or raster is pending; it never commits a new region geometry with an older raster, clips the old raster into the new geometry, or exposes a platform-default background. A visible image region's composition revision, raster revision, exact dimensions, and presented snapshot must all belong to the prepared layout before the host commits it. Before the first valid snapshot, the image layer stays transparent so the application's surface background remains visible. After input settles, `host.window.presented` also verifies that each image region whose own placement and `SurfaceHost` are visible has presented the exact current raster and that the resulting native transaction has reached the display. Hiding or showing the outer surface updates that requirement without changing the region raster revision. The command fails on timeout instead of accepting a missing or failed presentation. Empty native pixels, stale raster content, exposing a platform-default background, and allowing native content outside `SurfaceHost` are failures.

A settled `SurfaceHost` commit has the same completion boundary: a settled surface placement is not complete until every visible image region in that composition has accepted (`consumed` or `leased`) and presented its exact current raster. Returning from a page without native regions, such as the project library, to a view surface with native regions must not expose the restored DOM page as complete while any visible native image region is still pending. Tests must verify this boundary by navigating away from a surface with multiple visible native regions and asserting every region's frame and presented raster immediately after return, without an additional presentation command.

## Image transfer

An image supplier receives host `configure` events containing the attachment generation, raster revision, exact pixel width, exact pixel height, and scale. The supplier coalesces pending configurations to the newest revision.

For each frame, the supplier writes a transfer image and sends `{name, generation, raster, sequence, token, width, height, scale}`. In the `copy` mode it must not modify or reuse that transfer image until the host replies `consumed` or rejects it; in the `lease` mode it follows the [image lease](native-surfaces.md#image-regions). Sequences increase within one generation and raster revision.

The host verifies the caller, declaration, supplier, generation, raster revision, sequence, token authorization, actual image dimensions, expected native dimensions, and scale. Nonce authentication releases its copied IOSurface property after comparison on both accepted and refused paths, following the Core Foundation Copy ownership rule. In the `copy` mode it copies valid pixels into host-owned immutable presentation storage, swaps that snapshot into the image layer, and then replies `consumed`, and the native presentation layer never points at storage the supplier may overwrite. In the `lease` mode it swaps the retained transfer IOSurface into the image layer and replies `leased`. Invalid or stale frames do not replace the previous valid snapshot.

## Input and stacking

The DOM plane owns the logical overlay layer above native regions. The platform compositor may place the native plane above the app-DOM backing when required to make native pixels visible; this does not change logical clipping or input ownership. Input ownership is evaluated for the current composition revision in this order:

1. the topmost declared DOM overlay;
2. the topmost native region whose declaration owns native input;
3. the DOM plane.

An image region with DOM input lets pointer events reach its anchor while native keyboard composition and accessibility remain on its image handle after explicit focus. A document region receives native pointer input except where a declared DOM overlay covers it. Arbitrary DOM content is not an overlay and cannot intercept a native-owned point.

## Failure behavior

Composition validation fails closed. Manifest validation rejects undeclared, missing, duplicate, and input-conflicting regions and overlays. The page controller requires the exact declared element set before attachment. The host keeps the last complete valid composition or hides the affected native regions; it never applies a partial request, reparents a region outside `SurfaceHost`, infers a missing declaration, substitutes a compatibility path, reduces coordinate precision, or paints over an unexplained gap.

A check of the verification status that has nothing to measure in the current state is not a pass: `core.verify` lists it with its reason under `skipped`, and it is neither a row nor a failure. A host that cannot have what a check measures always lists that check as skipped.

`V7a` compares the latest commit of the compositor with the drawn plane: every surface of the commit has a drawn slot and every drawn slot is in the commit, placed or deferred by the answer of its placement, the dimming of each surface is the dimming of its slot, and the x, y, width and height of each declared rectangle each differ from those of its drawn slot by less than half a point. An invisible declaration with zero width or zero height has no presented area ([native surfaces](native-surfaces.md)), so it has no place to compare; it still counts for the slots and the dimming. A view that the placement deferred because it has not declared its composition keeps its place empty until the page lays out again at its declaration ([native surfaces](native-surfaces.md#view-surfaces), placement), so its drawn slot is in the commit as deferred and has no place to compare; the row names each deferred surface.

On the mygo host a placement whose answer waits is such a state for 3 s, the bound of a stalled request of a window check. From then on until the host answers, `V7a` is failed and states how long the placement has waited, so the status does not answer no failure for views that stay in their old place. A placement that the host refused has its answer: it appears as the failure of the presentation, and the rows that read the placement stay skipped.

A failed preparation or presentation rejects its requesting operation and appears in verification status and the error display. It does not permanently reject the work queue: a subsequent user layout operation can submit a new preparation. Rejected preparation promises are not reused, and no automatic retry reports the failed operation as successful.

## Acceptance

- Native content remains clipped to its `SurfaceHost` on every recorded frame during split drag, window resize, hide/show, reorder, navigation, reload, replacement, and close.
- A recording starts before native input, includes the complete gesture at the requested rate, and fails on missing frames or any platform-default pixels.
- Tests delay and reorder composition snapshots, configure events, and image frames. Stale generations, revisions, and sequences never become visible.
- A view surface preserves native/DOM stacking and hit ownership at fractional coordinates and after backing-scale changes.
- Every committed frame uses an exact current raster; a pending raster holds the previous complete frame until the new raster is consumed.
- Both native hosts enforce the same declaration and revision rules. A platform that cannot implement them fails at startup.
