# View import map owner

[한국어](view-import-map-owner.ko.md)

This proposal decides F212.12-1-10-6: the host inserts core's view import map into each view page it serves, so a plugin page holds no import map of its own. It is removed after its approved content is in [plugin processes](../spec/plugin-processes.md), [plugins](../spec/plugins.md) and [native surfaces](../spec/native-surfaces.md).

## Facts

- The view import map is the constant `VIEW_IMPORTS` of `packages/plugin-api/index.js`. Its five entries are `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/view`, `@soksak/plugin-api/screen-hash` and `@soksak/shared/`.
- Each plugin view page holds its own copy in a `<script type="importmap">` in its head. `plugins/terminal/ui/terminal.html` has the copy at lines 4 to 5, before the module script in body, and the doctype at line 1.
- `checkViewPage` (`packages/plugin-api/index.js`) requires exactly one map equal to `VIEW_IMPORTS`. `checkViewLiteral` (`packages/plugin-api/view-check.js`, lines 47 to 54) requires the `viewImports` of a plugin literal to equal it, and `view-check.js` line 20 pins the SHA-256 of `view-start.js`.
- `checkViewModules` (`packages/plugin-api/view-modules.js`, line 14) imports `VIEW_IMPORTS` from `index.js`, not from the page.
- Views are served by one native function, `native/darwin/src/document_view.m` (the plugin file answer at about lines 395 to 418, the core root answer at about lines 420 to 448). Go (`packages/host/wailsv3/src/platform/darwin/document.go`) and Rust (`packages/host/tauriv2/src/platform/darwin/document.rs`) both create views through `sp_document_create`. Windows has no view support (`platform/windows/unsupported.go`).
- The plugin file answer reads the whole file with `dataWithContentsOfFile` and sets `Content-Length` from its length. No response streams.
- The install check is the release zip `sha256` (`docs/spec/installation.md`, line 55), checked before extraction.
- The spec states that the host does not inject the map (`docs/spec/plugin-processes.md` rule 4, and `docs/spec/plugins.md` line 168).
- Core added the screen-hash entry, and every plugin page that copied the map lacked it (`docs/features.md` F212.12-1-10-1 and -2; shell P16; hwp H26).
- Measurement: `native/darwin/tests/view_import_map_test.m` serves the page with the map after the doctype and the module in body. The bare specifier resolves to `sok://core/m.js`, three runs.

## Decision

1. The native view handler inserts the map of the core that the host runs, directly after the doctype token, into the page of the view composition only (`isView`). A document region page is not changed.
2. A view page that already holds an import map, or that does not begin with a doctype, is refused with an explicit error that names the file. The handler never merges or replaces a map.
3. The map text comes from the staged frontend of the running host. The staging tool writes `VIEW_IMPORTS` to a file of the staged frontend, as it writes `core-root.json` (`docs/spec/plugins.md`, the staged layout), and the host hands its text to the native handler when it starts. Both hosts reach the handler through the one native implementation.
4. `Content-Length` is computed after the insertion. One record per view load names the page path and the SHA-256 of the inserted map.
5. `checkViewPage` requires no import map and a doctype first. `viewImports` leaves the view literal. `checkViewModules` keeps reading `VIEW_IMPORTS` for the offline module graph check.
6. The plugin repositories remove the map from each view page and from their test copies. Core reports the list; core does not change plugin repositories.

## Reasons

- A pack-time copy matches only the core release that the plugin pins. The host serves the modules of the core it runs, so only a host-side insertion keeps the map and the served modules in one version.
- The map is a core-to-host contract (`Common functionality belongs to core`). Each copy that a plugin holds is a second definition.

## Objections and answers

1. Rewriting served bytes (integrity, `Content-Length`, streaming). Answer: no stream exists, the file is read whole, and `Content-Length` is computed after the rewrite. The install hash covers the release zip, which the insertion does not change. The served page is the packed file plus the host-owned map, and the spec states it.
2. Order of the map and the module scripts, and two maps. Answer: the insertion sits after the doctype, before every tag, so it precedes the first module script (measured above). A page with its own map is refused, so there are never two maps.
3. A document-start user script inserts the map. Answer: rejected as the primary route. The document-start script runs before any DOM exists, and an insertion from a MutationObserver is not ordered before the parser prepares a module script. Not measured; not pursued.
4. Offline checks. Answer: `checkViewModules` reads `VIEW_IMPORTS` from the pinned `@soksak/plugin-api`, so the module graph check runs offline. Only the equality check of the page map is removed.
5. Debugging, where the page source differs from what runs. Answer: the handler logs one record per view load with the page path and the map SHA-256. The host-injected view-start, theme and start-value scripts already change the running page, so the change adds one more documented injection.
6. Alternatives. A map file that plugins copy at build recreates the drift that F212.12-1-10-1 showed. A pack-time generated map ties the map to the pinned core, which is the mismatch this proposal removes. An import map loaded with `src` is not in the spec and is not measured.
7. Parity between hosts. Answer: both hosts create views through the same darwin view function, so the insertion exists once. A contract case (input HTML and expected output) runs in the native test and in the plugin-api test.
8. The rule to remove obsolete code paths. Answer: the page map and its checks are removed, not kept beside the new path. The refusal of a page with its own map replaces the equality check; no fallback reads a page map.

## Checklist

The checklist items F212.12-1-10-6a to -6f in `docs/features.md` hold the steps.
