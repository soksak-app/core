# Sidebar section views

[한국어](sidebar-section-views.ko.md)

This proposal states how a sidebar section becomes a view of its plugin (F332). It is removed after its approved content is in the specifications.

## Problem

A sidebar section is declared UI: the plugin sends a status value of list, tree, button or status-line elements, and the workbench draws it (`docs/spec/plugin-processes.md#layer-rules`, `docs/spec/declared-ui.md`). The drawing of plugin content is therefore a function of core. The files tree is drawn by `packages/workbench/declared-ui.js` and lost the design of `@pierre/trees` that F13-2-5 set, and a plugin cannot draw a section with the means it draws its views with.

## Rule

A plugin draws every screen it owns by any means: DOM written by hand, a framework, a library, or a sidecar image in an image region. Core gives the place and requires only the exposure contract: every interactive element binds a declared command through the shared binder and has an element name, and every visible state is a declared status ([exposure](../spec/exposure.md)). A sidebar section is such a screen.

## Decisions

- **D1 Form.** A section of `plugin.json` is `{id, name, composition, height, unload?}`; `unload` has the form of `surface.unload` and lets the memory saver unload the section surface, which is never unloaded without it, as a tab of a surface without `surface.unload`. `composition` has the form of `surface.composition` ([plugins](../spec/plugins.md#pluginjson)) with kind `view`, so a plugin with sections and no surface declares the page and regions of each section. `height` is `"fill"` or a positive integer of points: a fill section shares the height left after the other open sections, and any other open section has its declared height. A section with `status`, `module` or `fill` is refused when the manifest is read, with `plugin <id>: section <section id> <field> is removed; a section takes composition and height`; a `height` of another form is refused with `plugin <id>: section <section id> height must be "fill" or a positive integer`. A plugin with `sections` may declare `dependencies`, as a plugin with `surface` may.
- **D2 Surface.** Each drawn section is a view surface of its plugin, a *section surface*, with one view per section, as each tab has one view. Its surface id is `<space id>/<sidebar id>/<section id>`; the file of its tab session is named by the percent-encoding of the id, because the id holds `/` ([persistence](../spec/projects.md#persistence)). A sidebar holds a section once, and the id names the sidebar, so a set linked to two sidebars gives two section surfaces. `core.surfaces` lists section surfaces with `kind` `section` and their sidebar, beside the tab surfaces. The page declares its composition as a tab page does, and the host creates, places and releases the view as it does for a tab.
- **D3 Lifetime and memory.** A section surface exists while its section is in a sidebar of a space of the window, as a tab view exists while its tab is in such a space; a section of a space that is not shown is hidden. A folded section, a section of an unselected tab of a `tabs` set and a section of a sidebar that is turned off are hidden as an inactive tab is hidden, and the memory saver observes section surfaces with the tabs and unloads a hidden section surface by the rules of a hidden tab ([tab memory](../spec/exposure.md#tab-memory)); the section shows it again when it is shown. `core.tab.memory` lists section surfaces with `kind` `section`; `core.tab.unload`, `core.tab.keep` and `core.tab.menu` take a tab and refuse a section surface id, so only the memory saver unloads a section. The surfaces that a layout holds (`layoutSurfaces`) are its tabs and the section surfaces of its card sidebars and window sidebars, so the tab state store and the tab session store keep the entries of section surfaces at a load. The surface is released when its section leaves the set of its sidebar, when the sidebar is removed, and when the card that holds the sidebar closes. The events of the table below apply.
- **D4 Start values.** The start values of a section surface are those of a view with `params` `null`, `origin` `{directory: null}` because no tab opened it, which the workbench sets without the origin record of tabs, the `project` of the window, and the new member `section` `{id, sidebar, card}`, where `card` is the id of the card that holds the sidebar, or `null` for a window sidebar. Both hosts carry, validate and inject `section`, `null` for a tab surface; the host contract states it.
- **D5 Followed surface.** `core.sidebars` reports for each section its `surface`: the active tab of the card that holds the sidebar, or for a window sidebar the active tab of the focused card, or `null`. The view calls `runtime.status.watch` and `runtime.status.unwatch` take an optional `surface`, a surface of the view's plugin in the window; a status of the plugin is then followed on that surface, and a watch is keyed by its name and its surface. A section view follows `core.sidebars` and, with `surface`, the statuses of the surface that it reports; when that surface changes, it unwatches the earlier surface and watches the new one. A request without `surface` never chooses a section surface ([choosing a surface](../spec/exposure.md#choosing-a-surface)).
- **D6 Orientation.** `core.sidebars` reports the orientation of each sidebar, `horizontal` or `vertical`, and a section view lays out its content by it.
- **D7 Height.** The height comes from the declaration of D1; core reads no content height and the view reports none, so a height change starts no layout.
- **D8 Frame and seats.** Core draws the sidebar frame only: the section header with its name, folding (`core.sidebar.section.fold`), tabs (`core.sidebar.section.select`), the heights, and the status line of the sidebar. The compositor measures the body of each drawn section as a seat keyed by its section surface id, beside the card seats, for card sidebars and window sidebars, and a layout is complete only when every section seat is measured. Every section surface has a seat: a hidden section has a seat with `visible` false and a zero frame, as an unmeasured tab surface has.
- **D9 Restarts.** The restart limit of a section surface is counted per section surface with the records of a view surface of a tab, which name the section surface id. After it is exceeded, the section body shows the error through the error display. Rule 5 of `docs/spec/plugin-processes.md` names the actions of the person that clear the record of a section surface: unfolding the section, selecting its tab, and changing the set of its sidebar; the view then starts again.
- **D10 Removal.** The names of the table below are removed. A plugin release that declares a removed field is refused by the reader with an error that names the field.
- **D11 Releases.** Each plugin releases independently with an `engines.soksak` range that contains the core that carries this change.
- **D12 Cost.** One web view process runs for each drawn section that is not unloaded: up to two for files and four for browser. The cost is measured by the benchmarks after development.
- **D13 Project data.** The view calls `runtime.data.get {key}` and `runtime.data.set {key, value}` read and write the `data` keys of the plugin for the project of the start values of the calling view, which the main page answers from the project data store of that project, so a hidden view of another project reads and writes only its own project; a write to a project that is not shown is stored for that project. The sentence of `docs/spec/plugins.md:130` that answers for the shown project is replaced. `data` no longer requires `host`; it requires `surface` or `sections`.

### Events

| Event | Section surface |
| --- | --- |
| Space switch | The sections of the space that is left are hidden, as the tab views of that space are, and the memory saver unloads them by its rules (D3). |
| Project switch | The window shows the layout of another project; the sections of the earlier layout follow the rule of the space switch and keep the project of their start values, which their data calls address (D13). |
| Page reload | Every section surface is retired and created again with the sections of the reloaded page, as the tab surfaces are. |
| Fold, unselected tab, sidebar off | Hidden, then unloaded by the memory saver (D3). |
| Section leaves the set, sidebar removed, card closed | Released. |

Input and focus over a section view follow [input over native views](../spec/native-surfaces.md#input-over-native-views), as for a tab view.

### Removed names

| Removed | Replacement |
| --- | --- |
| Declared UI: `declared-ui.js`, `declared-section.js`, `declared-source.js`, `docs/spec/declared-ui.md`, the declared UI snapshot messages, `core.declared-ui.tree.*` | The section view draws its content. |
| Section `status`, `fill`, with `data-fill` (`sidebar-sections.js:226-227`, `app.css:673-676`, `test/sidebar-sections.test.mjs:89-93`) and the `fill` checks (`plugin-api/index.js:810`, `:824-825`) | Section `composition`, `height`, with `height: "fill"`. |
| Plugin host: `plugin-host.js`, `host`, `docs/spec/plugin-host.md`, `host.plugin-host.*` and `host.trace.plugin-host.*` records, and the plugin host entries of `core.plugin.losses`, `core.plugin.views` and `core.plugin.open-calls` | The section views; those three statuses keep their view entries. |
| `hostOperations` of `plugin.json` and `hostReadOperations` of `sidecar.json` | The view sidecar calls of `dependencies`. |
| `data` through the plugin host (`plugin-data.js`, `environment.js:115`, the `host` requirement of `plugin-api/index.js:679-681`) | `data` read and written by the views of the plugin through `runtime.data.get` and `runtime.data.set` (D13). |
| The status `core.plugin.snapshots`, the control address of `element.rect` and `element.act` with the error 1009, the declared tree keys of the shortcut table, and the view events `declared-ui.expanded` and `declared-ui.snapshot` | Nothing: the view of a section serves its own controls and keys. |
| The host events `declared-ui-source-registered` and `declared-ui-source-ended` and the query `declaredSourceOrigins` | `view-source-registered`, `view-source-ended` and `viewSourceOrigins`, which keep the generation of every view source. |
| element name `core.sidebar.section.control` and the control count of `core.sidebars` | The element names of the plugin, which the binder audit covers. |
| Window checks that use these names (`e2e/files.test.mjs`, `e2e/editor.test.mjs`, `e2e/declared-sidebar-control.mjs`) | Checks that use the entries of the section views. |

`docs/spec/native-surfaces.md` states the origin of a section surface and the member `section` of the start values, and the host contract states both. The layer rules and rule 5 of `docs/spec/plugin-processes.md`, `docs/spec/plugins.md` (`sections`, heights, the plugin requirement of line 84, `dependencies` and `data` with lines 127-130), the served view calls of `docs/spec/native-surfaces.md` (lines 150-160), the checks of `packages/plugin-api/index.js:679-681` and `:698-700`, and the terms *section surface* and *card surface* of `packages/plugin-api/terms.json` change in the same change.

## Review

Round 1 objections and their judgment:

1. The compositor seats only cards, so a section surface is never shown (`compositor.js:370-402`, `plane.js:1413-1433`). Accepted: D8.
2. The origin cannot be produced (`surface-modules.js:266-318`, `tab-reports.js:226-229`, `native-surfaces.md:191`), and `section` is a new start value member. Partly accepted: `{directory: null}` is the stated form of an origin that records no directory, and a section has no opening tab, so it is the value and not a fill of a dropped origin; the workbench sets it without `tabOrigin`. The new member is accepted: D4.
3. A section has no composition (`environment.js:34-100`). Accepted: D1.
4. `runtime.status.watch` takes `{name}` only (`native-surfaces.md:154`). Accepted: D5.
5. Hidden sections never unload, and the state store drops keys that no layout holds (`plugin-processes.md:17-25`, `tab-session.js:99-101`). Accepted: D3.
6. The restart limit clears only when a person opens a surface (`plugin-processes.md:118-120`). Accepted: D9.
7. The height report is not served, clamps invalid values and can loop. Accepted: D1 and D7 use a declared height.
8. The removal misses `data`, `hostOperations`, `core.plugin.*`, the control name and the checks. Accepted: the table of removed names.
9. Plugin releases bound to one core release. Accepted: D11.
10. The layer rules and terms contradict D2. Accepted: stated under the table.
11. The surface identity and `core.surfaces` are unspecified. Accepted: D2.
12. Space, project, reload and input are not covered. Accepted: the table of events.

Round 2 objections and their judgment (the round 1 objections 2, 5, 6, 8, 11 and 12 were partly open and are answered with these):

- N1 The layout store and the memory saver hold only tabs (`projects.js:98-105`, `:263-264`, `tab-state.js:89-90`, `tab-session.js:99-100`, `memory-saver.js:212-218`, `core-exposure.js:554-555`). Accepted: D3.
- N2 A hidden section has no measured seat, so no layout completes. Accepted: D8.
- N3 `dependencies` requires `surface`, `host` or `contributes` (`plugin-api/index.js:698-700`). Accepted: D1.
- N4 Rule 5 clears the record only when a surface is opened (`plugin-processes.md:118-120`), and the records are not named. Accepted: D9.
- N5 The view bridge passes only `name`, a watch is keyed by name, and the default choice can pick a section (`view-calls.js:243-247`, `exposure.md:168`). Accepted: D5.
- N6 The `fill` uses are not listed. Accepted: the table.
- N7 `data` has no view call. Accepted: D13 and the table.
- N8 `hostReadOperations` and the `core.plugin.*` statuses are not stated. Accepted: the table.
- Round 1 objection 2 remainder: `native-surfaces.md:189` and `:191` are in the change list, and the workbench sets the origin of a section without `tabOrigin` (D4).

Round 3 objections and their judgment:

- A The space switch has two rules, and a tab open cannot clear the record of a section process. The first is accepted with another solution: a section of a space that is not shown is hidden as its tab views are and unloaded by the memory saver, rather than released, because a section and a tab of one space follow one rule (D3, the events table). The second is accepted: D9 names only actions on the section.
- B A section of an earlier project would read the data of the shown project. Accepted with another solution: the data calls address the project of the start values of the calling view (D13), so no section is released at a project switch.
- C The view call list and `plugins.md:127-130` are not in the change list, and `data` without a surface or sections has no reader. Accepted: D13 and the change list.

Round 4 objections and their judgment:

- N1 D13 cited the shown-project rule of `plugins.md:130` while it answers for the project of the view. Accepted: D13 states its own rule and replaces that sentence.
- N2 `host.trace.plugin-host.*` was missing from the removed records. Accepted: the table.

No objection remained in round 5.

## Answered objections

- A section that must show values while no view of its plugin is open needed the plugin host. Under D3 the section is itself a view, so it serves its own values while it is drawn.
- The F238-d review placed the files sidebar in declared UI. Its reason was the layer rule, which this proposal replaces; its other conditions (no rename, drag and drop or pointer menu) are not needed, because a view may hold them.
