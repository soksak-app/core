# Decision review F238-a: view regions (D4) and origin form (D7)

[한국어](decision-review-F238-a.ko.md)

This record reviews two decisions that were taken without adversarial verification: D4 (view regions, F228) and D7 (origin form, F235 and F237). Each decision states what it decides, why, the evidence with file and line, and the required changes. Fresh auditors (claude-haiku-5-5) object only where the decision is wrong or incomplete and propose a solution. Wording and citation corrections are applied directly. Rounds repeat until both auditors of a round have no substantive objection.

Citations are branch-qualified because the code lives on the branches named below; `main` does not contain F228 or F237.

Branches: `feat/view-region-F228`, `fix/view-region-close-F228-5`, `fix/view-origin-F237`, `feat/view-bridge-F231`, `main`.

## D4. View regions (F228)

### Decision

1. Region operations are view calls. The view calls the host through `sok-view`; the workbench stamps each call with the sender surface and routes region calls through the region record.
2. Refusal: a raw `runtime.native.call` of a composition, document or image host call is refused. The refusal set is `REGION_HOST_CALLS`, and a test derives the region-kind names from every workbench module that issues a host call (`packages/workbench/surface-modules.js` and `host.js`, plus any other file that a grep of `invoke(`, `composed(` or `hostClose(` finds under `packages/workbench/`). The test fails when a region-kind name is missing from the set.
3. `runtime.native.on` accepts only the names in `REGION_EVENTS`. `REGION_EVENTS` does not exist on either branch; it is defined in `packages/workbench/view-calls.js` and the test checks it against the event names that `surface-modules.js` subscribes to.
4. Stacking, visual and input order, from the top: view DOM overlays, then view regions, then the view page DOM. A point inside a visible view overlay rect is delivered to the overlay's DOM view (`mainWebview` or `webview`) or to nothing; it is never delivered to a region or to the native plane.
5. Reapply: an image region reapplies its insets inside a local `CATransaction`. A document region reapplies at placement and in its `NSViewFrameDidChangeNotification` observer; neither runs in a `CATransaction`. The spec does not claim a window transaction for document regions.
6. Open defects, each with a fix and a test on the owner branch: the hit-test defect of item 4 (Evidence E3), the refusal-set gap of item 2 (E2), and the missing `REGION_EVENTS` (item 3).

### Why

Routing through the stamped view call makes the revision, the region lifetime and the region record the only path to a region. A raw host call would skip them (`view-calls.js:74-76`, feat). This is a workbench choice with that basis, not a consequence of rule 9 of the plugin process rules. Rule 9 supplies only the envelope check.

Stacking follows the surface composition contract: "Declared plugin overlays and workbench menus/dialogs own input above native document regions" (`docs/spec/surface-composition.md:24` on main) and "native content is never allowed to ... own an overlay's point" (`:28`). A region is native content, so it sits below a view overlay.

### Evidence

- E1 (routing). `packages/workbench/view-calls.js` on feat, case `runtime.native.call` at `:105-118`, refuses a name in `REGION_HOST_CALLS` (`:78-83`) with "a view operates its regions through its composition".
- E2 (refusal set, gap). Region-kind calls are issued from `packages/workbench/surface-modules.js` on feat: `invoke` at `:92` through `:113` (`documentAttach`, `documentLoad`, `documentZoom`, `documentGo`, `documentSubscribe`, `documentUnsubscribe`, `documentPost`, `imageAttach`, `imageFocus`, `imageCaret`, `imageText`, and `imageDetach`), `composed` at `:110` (`imagePlace`) and `:131` (`compositionPlace`), and `invoke` at `:120` (`compositionDeclare`). `packages/workbench/host.js:462-463` calls `documentQuery` and `documentInteractionState`. `REGION_HOST_CALLS` (`view-calls.js:78-83`) lacks `documentQuery` and `documentInteractionState`, and `documentWebviews` is not a host call. A test that reads only `host.js` would miss sixteen of the eighteen names.
- E3 (hit test, two leaks). `native/darwin/src/webview_geometry.m` on feat, `SPSurfaceHost hitTest` at `:283-303`. For a point in a visible overlay rect: (a) when `self.mainWebview` is set the method returns nil (`:287`), so the overlay's DOM never receives the point; (b) when the overlay's DOM returns nil (`:288-292`, transparent point) or when `self.webview` is nil or hidden, the loop does not return and the point falls through to `self.nativePlane` (`:294-296`). The spec (`surface-composition.md:28`) forbids both. On `fix/view-region-close-F228-5` the non-view branch attaches to the native plane after `document_view.m:1070` (`sp_surface_place_view` at `webview_geometry.m:764`), and `hitTest` checks `self.webview` first; the defect is recorded for feat only.
- E4 (mask path). `packages/host/tauriv2/src/composition.rs:315-325` → `platform/darwin/webview.rs:196-208` → `webview_geometry.m:761-771` (feat) / `:783-793` (fix) → `domOverlays` setter → `applyOverlayMask`. The mask path exists; a unit test must prove that a view overlay reaches the mask before pass.
- E5 (reapply). `image_region.m` `applyInsetsNow` at `:363-368` runs inside `CATransaction` (`:371-372`) and is called at `:1244-1249`. `document_view.m:1068` (feat) and `:1076` (fix) attach a document region to the native plane; `:1266` (feat) and `:1275` (fix) apply insets at placement; `:898-938` reapply in the frame-change observer. No `CATransaction` wraps the document path.
- E6 (spec). `docs/spec/native-surfaces.md:102` (main) says "in the same native transaction" for regions; the sentence is true for image regions only (E5).

### Required changes

- Owner `feat/view-region-F228`: add `documentQuery` and `documentInteractionState` to `REGION_HOST_CALLS`; add a test that scans the workbench modules named in Decision item 2 and asserts that every region-kind name is in the set (Red on the unchanged set).
- Owner `feat/view-region-F228`: define `REGION_EVENTS` in `view-calls.js`; `runtime.native.on` checks its name against it; a test checks it against the subscription names of `surface-modules.js` (Red first).
- Owner `feat/view-region-F228`: fix `SPSurfaceHost hitTest` (`webview_geometry.m:283-303`) so that a point in a visible overlay rect returns the overlay's DOM hit or nil and never reaches the native plane; a unit test covers the mainWebview case, the transparent-overlay point (DOM returns nil), and the case where `webview` is nil (Red on the unchanged code, Green after the fix).
- Owner `feat/view-region-F228` or `fix/view-region-close-F228-5` (whichever merges first): a unit test that a view overlay reaches `applyOverlayMask` (E4).
- Spec on main (`docs/spec/surface-composition.md`, `docs/spec/native-surfaces.md:102`, ko mirrors): state the stacking order of Decision item 4 and restrict "same native transaction" to image regions.

### Objections and answers

- Round 1, auditor A, objection 1: the test must scan `surface-modules.js` (not `host.js`); `REGION_EVENTS` is undefined on both branches. Accepted. The test source and the `REGION_EVENTS` definition are in Decision items 2 and 3.
- Round 1, auditor B, objection 1: the same source gap, with `hostClose` and `composed` wrappers. Accepted. Decision item 2 covers `invoke`, `composed` and `hostClose`.
- Round 1, auditor B, objection 2: the hit-test has a second leak (transparent DOM point and nil `webview` fall through to native). Accepted. E3 and the Required changes cover both cases; the earlier text covered only the mainWebview case.

## D7. Origin form (F235, F237)

### Decision

1. `origin` is always the object `{directory}`, with exactly one member named `directory`.
2. `directory` is an absolute path or null. Null means that the tab recorded no directory.
3. An absolute path is a path whose first character is `/`. Windows drive paths and UNC paths are refused, because the workbench already refuses them (Evidence E5). Each host and the page apply the same string test: `path.startsWith("/")` in TypeScript, `strings.HasPrefix(path, "/")` in Go, `path.starts_with('/')` in Rust. No platform path API is used, so the result does not depend on the host OS.
4. An absent origin, a null origin, an object of another form, a non-string non-null `directory`, an empty path, and a path that does not start with `/` are refused with an explicit error. The five texts are:
   - `surface "<id>": view start origin is missing` (absent)
   - `surface "<id>": view start origin is not {directory} with a path or null` (any other form)
   - `surface "<id>": view start origin directory is empty` (empty path)
   - `surface "<id>": view start origin directory is not an absolute path` (path not starting with `/`)
5. The page does not coerce. `packages/plugin-api/surface.js:12` (default `origin = { directory: null }`) and `:72` (`origin.directory ?? null`) are removed; `createSurfaceContext` throws a `TypeError` unless origin is exactly `{directory}` with null or a `/`-prefixed value.
6. The workbench does not default an origin. `tabOrigin` on main (`packages/workbench/tab-reports.js:141`, `?? Object.freeze({ directory: null })`) is removed; a tab without a recorded origin is an error at view start, and every tab-creation path calls `recordOrigin`.
7. Restore keeps origin. The origin of a tab is written to the tab session file `tab-sessions/<tab>.json` with its interaction state, and restore reads it back; the in-memory `origins` map (`tab-reports.js:5`, deleted at `:194`) is not the only store. Until this sub-item lands, the spec does not claim that restored tabs keep their origin (see Required changes).

### Why

The workbench always sends an object (`packages/workbench/tab-reports.js:137`), so refusing an absent or null origin breaks no code path. A coerced `{directory: null}` for an absent origin hides a missing record, which `AGENTS.md` forbids ("reject invalid values at the boundary"). A `/` rule is the rule the workbench already enforces for directories (`reportDirectory`, main `tab-reports.js:125`), so the view's origin and the tab's directory cannot disagree. Windows support is a separate change to that workbench rule, not a difference in this decision.

### Evidence

- E1 (hosts, fix). `fix/view-origin-F237:packages/host/tauriv2/src/surfaces.rs:58-61` keeps `origin` raw (`Option<Value>`, `present_value`). `view_origin_directory` at `:76-94` refuses absent (`:78`), a non-object or multi-member value (`:82-86`), a missing or wrong-typed `directory`, and an empty path. No absolute-path check exists.
- E2 (hosts, fix). `fix/view-origin-F237:packages/host/wailsv3/src/surfaces.go:62-112`: `viewOriginDirectory` refuses nil origin (`:70`), a non-map (`:76`), `directory` missing (`:81`), an empty path (`:91`). No absolute-path check exists.
- E3 (page, main). `packages/plugin-api/surface.js:12` defaults origin to `{directory: null}`; `:72` coerces with `origin.directory ?? null`. This makes the host refusals in E1 and E2 unreachable from the page path.
- E4 (shell page). `plugins/shell/ui/view.js:22` and `plugins/shell/test/view.test.mjs:47-53` treat a null origin as the default directory; they change in the shell repository.
- E5 (workbench rule, main). `packages/workbench/tab-reports.js:125` refuses any directory that does not `startsWith("/")`, so no Windows or UNC origin can reach a view through the workbench.
- E6 (restore, main). `docs/spec/plugins.md:223` says "Showing an unloaded tab mounts its surface with the same `origin`", with no session qualifier. After an app restart the in-memory `origins` map is empty and `tabOrigin` returns `{directory: null}` (`tab-reports.js:141`), so the sentence is false for restart. `plugins.md:225` says whether a tab is unloaded is not stored, and the tab session file stores only interaction state (`plugins.md:223`).
- E7 (`directory: null` is valid). A tab opened without a directory records none (`recordOrigin` with no source tab, `tab-reports.js:137`).

### Required changes

- Owner `fix/view-origin-F237`: replace the absolute-path check (not yet present) with the `/`-prefix test of Decision item 3 in `view_origin_directory` (`surfaces.rs`) and `viewOriginDirectory` (`surfaces.go`), after the empty-path check; add a `/` and a `C:\` case in each host test (Red on the unchanged code).
- Owner main, `packages/plugin-api/surface.js`: remove the default at `:12` and the coercion at `:72`; `createSurfaceContext` refuses per Decision item 5; a unit test in `packages/plugin-api` (Red first).
- Owner main, `packages/workbench/tab-reports.js`: remove the fallback in `tabOrigin` (`:141`); a missing origin at view start throws the named error; a test that a tab without `recordOrigin` cannot start a view (Red first).
- Owner main, workbench (`tab-reports.js`, tab session file): persist origin with the tab session and restore it; a test that a restored tab keeps its origin after a restart (Red first). Until this lands, `plugins.md:223` and `:225` state that the origin of a restored tab is not kept across an app restart.
- Owner the shell repository: `plugins/shell/ui/view.js:22` and its test `view.test.mjs:47-53` stop treating null as a default; recorded under "To record elsewhere".
- Owner main (specification, EN and KO): `native-surfaces.md:136`, `host-contract.md:196`, `plugins.md:223` and `:225`, with the five texts and the `/` rule.

### Objections and answers

- Round 1, auditor A, objection 2: a single rule cannot be satisfied with platform APIs, and the workbench refuses non-`/` paths. Accepted. The rule is now `/`-prefix only, which is the workbench's existing rule; Windows is out of scope until the workbench rule changes.
- Round 1, auditor A, objection 3: restore is unowned and `plugins.md:223` is false after restart. Accepted. Restore is an owned required change (persist origin in the tab session file), and the spec text is stated as false until it lands.
- Round 1, auditor B, objection 3: the `tabOrigin` fallback is the same coercion the decision forbids. Accepted. The fallback is removed (Decision item 6).
- Round 1, auditor B, objection 4: a pure-string predicate is required. Accepted; the `/`-prefix string test is the predicate (Decision item 3).

## Round log

- Round 1: both auditors objected (A: 3 objections, B: 4 objections). All accepted and applied above. Verdict pending round 2.
