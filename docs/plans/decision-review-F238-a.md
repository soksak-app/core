# Decision review F238-a: view regions (D4) and origin form (D7)

[한국어](decision-review-F238-a.ko.md)

This record reviews two decisions that were taken without adversarial verification: D4 (view regions, F228) and D7 (origin form, F235 and F237). Each decision states what it decides, why, the evidence with file and line, and the required changes. Fresh auditors (claude-haiku-5-5) object only where the decision is wrong or incomplete and propose a solution. Wording and citation corrections are applied directly. Rounds repeat until both auditors of a round have no substantive objection.

Citations are branch-qualified because the code lives on the branches named below; `main` does not contain F228 or F237.

Branches: `feat/view-region-F228`, `fix/view-region-close-F228-5`, `fix/view-origin-F237`, `feat/view-bridge-F231`, `main`.

## D4. View regions (F228)

### Decision

1. Region operations are view calls. The view calls the host through `sok-view`; the workbench stamps each call with the sender surface and routes region calls through the region record.
2. Refusal set. `REGION_HOST_CALLS` in `packages/workbench/view-calls.js` is the set of host command names of the composition, document and image kinds. Its authoritative source is the host's registered command table (`packages/host/tauriv2` and `packages/host/wailsv3`). A test reads that table and asserts `REGION_HOST_CALLS` equals the region-kind names. A second test scans `packages/workbench/` for string literals matching `document*`, `image*` or `composition*` passed to `invoke`, `composed`, `hostClose`, `bridge.call` or `scoped.native.call`, and asserts each is in the set.
3. Refusal on the plugin-facing path. The plugin-facing `call` (`packages/workbench/host.js:235`, bound to `invoke` at `surface-modules.js:77`) refuses every name in `REGION_HOST_CALLS` with the region error. A view and an app-DOM surface both use this path. The test calls the plugin-facing `call` with each name in the set and asserts a refusal; no region-kind name reaches `scoped.native.call` through it.
4. `runtime.native.on` accepts only the names in `REGION_EVENTS`. `REGION_EVENTS` is exactly the four region events that `surface-modules.js` subscribes to: `document-stream` (`:103`), `document-state` (`:105`), `document-message` (`:106`) and `image-event` (`:115`). A test asserts (a) `REGION_EVENTS` equals those four literals and (b) `runtime.native.on` rejects `view-call`, `view-reply`, `view-stopped`, `view-responsiveness` and `view-presentation-abandoned` (`surface-modules.js:320-507`), which are view-bridge internal events.
5. Stacking, visual and input order, from the top: view DOM overlays, then view regions, then the view page DOM. A point inside a visible view overlay rect is delivered to the overlay's DOM view (`webview` or `mainWebview`) or to nothing; it is never delivered to a region or to the native plane.
6. Reapply: an image region reapplies its insets inside a local `CATransaction`. A document region reapplies at placement and in its `NSViewFrameDidChangeNotification` observer; neither runs in a `CATransaction`. The spec does not claim a window transaction for document regions.
7. Hit-test owner. The hit-test fix has one owner: `fix/view-region-close-F228-5`, which already rewrites `hitTest` (`webview_geometry.m:283-300`). `feat/view-region-F228` does not change `hitTest`; its version is superseded when the fix branch merges, and the feat branch must not merge a `hitTest` change of its own.

### Why

Routing through the stamped view call makes the revision, the region lifetime and the region record the only path to a region. A raw host call would skip them (`view-calls.js:74-76`, feat). This is a workbench choice with that basis, not a consequence of rule 9 of the plugin process rules. Rule 9 supplies only the envelope check.

Stacking follows the surface composition contract: "Declared plugin overlays and workbench menus/dialogs own input above native document regions" (main `docs/spec/surface-composition.md:24`), and "native content is never allowed to ... own an overlay's point" (`:28`). A region is native content, so it sits below a view overlay.

### Evidence

- E1 (routing). `packages/workbench/view-calls.js` on feat, case `runtime.native.call` at `:105-118`, refuses a name in `REGION_HOST_CALLS` (`:78-83`) with "a view operates its regions through its composition".
- E2 (refusal set, gap). Region-kind calls issued from `packages/workbench/surface-modules.js` on feat: `invoke` at `:92` through `:113` (`documentAttach`, `documentLoad`, `documentZoom`, `documentGo`, `documentSubscribe`, `documentUnsubscribe`, `documentPost`, `imageAttach`, `imageFocus`, `imageCaret`, `imageText`, `imageDetach`), `composed` at `:110` (`imagePlace`) and `:131` (`compositionPlace`), `invoke` at `:120` (`compositionDeclare`). `packages/workbench/host.js:462-463` calls `bridge.call("documentQuery")` and `bridge.call("documentInteractionState")`. `REGION_HOST_CALLS` (`view-calls.js:78-83`) lacks both. A grep for `invoke(` alone misses them; the literal scan of Decision item 2 includes `bridge.call`.
- E3 (plugin-facing path). `packages/workbench/host.js:235` exposes `call: invoke`, and `surface-modules.js:77` defines `invoke` as `scoped.native.call(name, payload)`. A name passed as a variable reaches `scoped.native.call` through this path, so the literal scan cannot cover it; the runtime refusal of Decision item 3 covers it.
- E4 (hit test, fix branch). `fix/view-region-close-F228-5:native/darwin/src/webview_geometry.m:283-300`. For a point in a visible overlay rect: if `self.webview` is visible and its DOM hit is non-nil, it is returned (`:292-293`); if `self.mainWebview` is set, nil is returned (`:296`); otherwise the loop `continue`s (`:287`) and the point falls through to `self.nativePlane` (`:298-300`). A DOM-only surface with a visible overlay and no `webview` or `mainWebview` therefore gives the overlay point to native content. The spec (`surface-composition.md:28`) forbids this. The fix branch's own comment (`:289-290`) says the hybrid app DOM "keeps the input under its overlays"; that keeping is the defect, because the native plane is the owner that receives it.
- E5 (hit test, feat branch). `feat/view-region-F228:webview_geometry.m:283-303` returns nil under a visible overlay when `mainWebview` is set (`:287`), and falls through to the native plane when `webview` is nil or its DOM hit is nil (`:288-299`). This version is superseded by E4's branch (Decision item 7).
- E6 (mask path). `packages/host/tauriv2/src/composition.rs:315-325` → `platform/darwin/webview.rs:196-208` → `webview_geometry.m:761-771` (feat) / `:783-793` (fix) → `domOverlays` setter → `applyOverlayMask`. The mask path exists; a unit test must prove that a view overlay reaches the mask before pass.
- E7 (reapply). `image_region.m` `applyInsetsNow` at `:363-368` runs inside `CATransaction` (`:371-372`) and is called at `:1244-1249`. `document_view.m:1068` (feat) and `:1076` (fix) attach a document region to the native plane; `:1266` (feat) and `:1275` (fix) apply insets at placement; `:898-938` reapply in the frame-change observer. No `CATransaction` wraps the document path.
- E8 (spec). `docs/spec/native-surfaces.md:102` (main) says "in the same native transaction" for regions; the sentence is true for image regions only (E7).

### Required changes

- Owner `feat/view-region-F228`: add `documentQuery` and `documentInteractionState` to `REGION_HOST_CALLS`; add the two tests of Decision items 2 and 4 (Red on the unchanged sets and on `runtime.native.on`); add the refusal of Decision item 3 on the plugin-facing `call` (Red first).
- Owner `feat/view-region-F228`: define `REGION_EVENTS` as the four events of Decision item 4 in `view-calls.js`; `runtime.native.on` checks its name against it.
- Owner `fix/view-region-close-F228-5` (the only branch that changes `hitTest`): in the loop of `webview_geometry.m:283-300`, a point inside a visible overlay rect returns the overlay's DOM hit or nil, and never reaches `self.nativePlane`. Unit tests, Red on the unchanged code: (a) DOM-only surface, overlay point over the native plane, expect nil; (b) view overlay with a transparent DOM point, expect no native hit; (c) hidden `webview`, expect no native hit for a visible overlay rect; (d) `mainWebview` set, expect nil.
- Owner `fix/view-region-close-F228-5` or `feat/view-region-F228` (whichever merges first): a unit test that a view overlay reaches `applyOverlayMask` (E6).
- Spec on main (`docs/spec/surface-composition.md`, `docs/spec/native-surfaces.md:102`, and the ko mirrors): state the stacking order of Decision item 5 and restrict "same native transaction" to image regions.

### Objections and answers

- Round 1, auditor A: the test must scan `surface-modules.js`, not `host.js`; `REGION_EVENTS` is undefined. Accepted.
- Round 1, auditor B: the same source gap, plus `hostClose` and `composed`; and a second hit-test leak. Accepted.
- Round 2, auditor D, objection 1: names passed as variables and the plugin-facing `call` (`host.js:235`). Accepted. Decision item 3 refuses region names on that path at runtime; the literal scan is secondary.
- Round 2, auditor D, objection 2: `REGION_EVENTS` may leak view-internal events. Accepted. Decision item 4 fixes it to four events and tests the five view-internal names.
- Round 2, auditor D, objection 3, and auditor C, objection 3: the fix branch still leaks an overlay point to native content when no `webview` or `mainWebview` is set (E4). Accepted; the previous text said the fix branch was clean. The fix is on the fix branch (Required changes).
- Round 2, auditor C, objection 1: `REGION_EVENTS` must not be "all subscriptions". Accepted (Decision item 4).
- Round 2, auditor C, objection 2: `bridge.call` names need the literal scan. Accepted (Decision item 2).
- Round 2, auditor D, objection 3: one branch must own the hit-test fix. Accepted (Decision item 7).

## D7. Origin form (F235, F237)

### Decision

1. `origin` is always the object `{directory}`, with exactly one member named `directory`.
2. `directory` is an absolute path or null. Null means the tab recorded no directory.
3. An absolute path is a path whose first character is `/`. Windows drive paths and UNC paths are refused, because the workbench already refuses them (E5). Each host and the page apply the same string test: `path.startsWith("/")` in TypeScript, `strings.HasPrefix(path, "/")` in Go, `path.starts_with('/')` in Rust. No platform path API is used.
4. An absent origin, a null origin, an object of another form, a non-string non-null `directory`, an empty path, and a path not starting with `/` are refused with an explicit error. The five texts are:
   - `surface "<id>": view start origin is missing` (absent)
   - `surface "<id>": view start origin is not {directory} with a path or null` (other form)
   - `surface "<id>": view start origin directory is empty` (empty path)
   - `surface "<id>": view start origin directory is not an absolute path` (path not starting with `/`)
5. The page does not coerce. `packages/plugin-api/surface.js:12` (default `origin = { directory: null }`) and `:72` (`origin.directory ?? null`) are removed; `createSurfaceContext` throws a `TypeError` unless origin is exactly `{directory}` with null or a `/`-prefixed value.
6. Every tab creation passes its origin explicitly. `newTab(kind, params)` (`packages/workbench/plane.js:142`) gains a required `fromTabId` argument (null when there is no source tab) and calls `recordOrigin(tab.id, fromTabId)` itself. Its callers pass the source explicitly: the card-creation paths at `plane.js:779` and `:797` (already calling `recordOrigin`), and the last-tab-close path at `plane.js:518` (`newTab(..., null)`, recording `{directory: null}`).
7. Origin persists with the tab layout, not with the tab session. The saved layout entry of each tab carries `origin`. The tab session file `tab-sessions/<tab>.json` is not the store, because `packages/workbench/tab-session.js` removes the file for a tab without document regions (`put(tab, null)`, `:55`, `:65`). On restore, the function that rebuilds a tab from the saved layout calls `recordOrigin(tab.id, storedOrigin)` before the tab mounts. The sub-item names that function after locating it in the restore code; this record does not claim a name.
8. Removal of the workbench fallback is the last step. `tabOrigin` (`packages/workbench/tab-reports.js:141`, `?? Object.freeze({ directory: null })`) keeps its fallback until Decision items 6 and 7 have landed and their tests pass; then it throws for an unrecorded tab, and the view start path surfaces that error.

### Why

The workbench always sends an object (`tab-reports.js:137`), so refusing an absent or null origin in the host and the page breaks no code path that records origin. A coerced `{directory: null}` for a missing record hides a defect, which `AGENTS.md` forbids ("reject invalid values at the boundary"). The `/` rule is the one the workbench already applies to directories (`reportDirectory`, `tab-reports.js:125`), so a view's origin and a tab's directory cannot disagree. Windows support is a separate change to that rule.

Persisting origin with the layout instead of the tab session follows from E4 below: the tab session file is deleted for plain surfaces, so origin stored there would be lost.

### Evidence

- E1 (hosts, fix). `fix/view-origin-F237:packages/host/tauriv2/src/surfaces.rs:58-61` keeps `origin` raw (`Option<Value>`, `present_value`). `view_origin_directory` at `:76-94` refuses absent (`:78`), a non-object or multi-member value (`:82-86`), a missing or wrong-typed `directory`, and an empty path. No absolute-path check exists.
- E2 (hosts, fix). `fix/view-origin-F237:packages/host/wailsv3/src/surfaces.go:62-112`: `viewOriginDirectory` refuses nil origin (`:70`), a non-map (`:76`), `directory` missing (`:81`), and an empty path (`:91`). No absolute-path check exists.
- E3 (page, main). `packages/plugin-api/surface.js:12` defaults origin to `{directory: null}`; `:72` coerces with `origin.directory ?? null`.
- E4 (persistence, main). `packages/workbench/tab-session.js` `put(tab, regions)` at `:33` and the calls at `:55` and `:65` (`put(tab, null)`) remove the tab session file when a tab has no document regions. `capture` returns early when no interaction state exists. The stored format (`docs/spec/plugins.md:142`) and `host-store.js:16` (`tabSessionPut(tab, regions)`) carry no origin field.
- E5 (workbench rule, main). `packages/workbench/tab-reports.js:125` refuses any directory that does not `startsWith("/")`; origins are copied from the same map (`:137`).
- E6 (origin sources, main). `recordOrigin` is called only at `plane.js:779` and `:797`. `newTab` is also called at `plane.js:518` (last tab closed, card kept) with no `recordOrigin`, so `origins` has no entry for that tab. `origins` is in memory (`tab-reports.js:5`), so after an app restart it is empty for every tab.
- E7 (view start, main). `surface-modules.js:193` and `:448` read `tabOrigin(surface.surfaceId)`; with the fallback removed before E6 is fixed, these throw for the tabs of E6.
- E8 (restore spec, main). `docs/spec/plugins.md:223` says "Showing an unloaded tab mounts its surface with the same `origin`", with no session qualifier; after a restart the sentence is false until Decision item 7 lands. Until then the spec states that origin is `{directory: null}` for a restored tab.

### Required changes

- Owner `fix/view-origin-F237`: add the `/`-prefix check of Decision item 3 in `view_origin_directory` (`surfaces.rs`) and `viewOriginDirectory` (`surfaces.go`), after the empty-path check; a `/` case and a `C:\` case in each host test (Red first).
- Owner main, `packages/plugin-api/surface.js`: remove the default at `:12` and the coercion at `:72` (Decision item 5); unit test (Red first).
- Owner main, `packages/workbench/plane.js` and `tab-reports.js`: Decision item 6. Tests: a last-tab close (`plane.js:518`) starts a view with `{directory: null}` and does not throw; a new tab records its source origin.
- Owner main, workbench layout and restore: Decision item 7. Tests: a restored tab with no document regions starts a view with its stored origin after a restart (Red first); a restored tab without a stored origin is refused with the named error.
- Owner main, `tab-reports.js`: remove the `tabOrigin` fallback (Decision item 8) only after the two tests above are Green.
- Owner the shell repository: `plugins/shell/ui/view.js:22` and `plugins/shell/test/view.test.mjs:47-53` stop treating null as a default; recorded under "To record elsewhere".
- Owner main (specification, EN and KO): `native-surfaces.md:136`, `host-contract.md:196`, `plugins.md:142`, `:223`, `:225`, with the five texts, the `/` rule, and the layout origin field.

### Objections and answers

- Round 1, auditor A, objection 2: a single rule cannot be satisfied with platform APIs, and the workbench refuses non-`/` paths. Accepted; the rule is the `/` prefix.
- Round 1, auditor A, objection 3: restore is unowned and `plugins.md:223` is false after restart. Accepted; Decision item 7 and E8.
- Round 1, auditor B, objection 3: the `tabOrigin` fallback is the same coercion. Accepted; but removing it first is a regression (round 2), so Decision item 8 orders it last.
- Round 1, auditor B, objection 4: a pure-string predicate. Accepted (Decision item 3).
- Round 2, auditor D, objection 4 (a): origin in `tab-sessions` is deleted for plain surfaces; `capture` returns early. Accepted; origin moves to the layout (Decision item 7, E4).
- Round 2, auditor D, objection 4 (b): `recordOrigin` is not called on restore. Accepted (Decision item 7).
- Round 2, auditor C, objection 1: `plane.js:518` and restored tabs bypass `recordOrigin`; removing the fallback first regresses them. Accepted (Decision items 6, 7 and 8, E6, E7).

## Round log

- Round 1: auditors A and B objected (3 and 4 objections). All accepted; text revised.
- Round 2: auditors C and D objected (3 and 3 objections for D4; 1 and 2 for D7). All accepted; text revised. Verdict pending round 3.
