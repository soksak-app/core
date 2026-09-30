# Example model

[한국어](example-model.ko.md)

The example application owns projects, spaces, and tabs. The layout library owns card geometry.

| Object | Contents |
| --- | --- |
| Project | Root path, name, color, and spaces |
| Space | Card arrangement, focused card, card sidebar widths, and tabs |
| Card | Layout slots, optional pixel size, and tabs |
| Tab | Plugin and title |

The [project contract](projects.md) defines directory identity, persistence, settings inheritance, startup selection, and project windows. Switching spaces captures the current application state and restores the selected space through `Soksak.replace()`.

The add and split buttons select a plugin for a new tab. Dropping a tab on a card center adds it to that card; dropping it at a card edge creates adjacent space. Moving the only tab in a card moves the card.

Plugins declare surfaces as `{page}`, a document inside the plugin package, and declare sidebar sections. A page shows web documents in document regions. The [plugin specification](plugins.md) defines the declaration files. Settings stores section sets and their assignments to the left sidebar, plugin card-left sidebar, or right sidebar.

A card has content and at most one sidebar on each of top, bottom, left, and right. There is one card-sidebar state and command path. Top and bottom span the content area; left and right flank its center. An explicit set overrides the active plugin default and survives tab changes. Without an explicit set, the plugin default applies. `core.card.sidebar.set {card, side, set}` accepts a known set, `off` to disable that side, or `inherit` to clear the explicit selection. Folding and sizing through `core.card.sidebar.toggle {card, side}` and `core.card.sidebar.size {card, side, size}` persist independent layout values without making a default-derived set explicit. The card remains the same size and content fills the residual area. `core.grid` reports effective sides as `sidebars`; the separate inset sidebar, panel commands, and duplicate left column are removed. The static four-side implementation is tracked in V5-117-1-2; full gesture acceptance remains pending in V5-115-1.

Card layout is stored in `data.sidebars`, keyed by side. Each entry may contain an explicit `set`, a `size`, and a boolean `collapsed`. An absent `set` derives the active plugin default; `off` disables the side. `inherit` removes only the explicit set and retains layout. Missing assigned sets, invalid saved fields or values, and obsolete `data.sidebar` or `data.panels` produce explicit errors; there is no migration or hidden removal. Folding hides section content and retains a visible divider with an input area. Static residual-width and divider-area checks are separate from full gesture acceptance. Legacy external flow/pin positioning remains pending removal in V5-117-1-3. Orientation-specific modules remain pending in V5-117-2.

The browser application simulates native surfaces. Browser checks do not verify native composition; native acceptance requires the host checks in [verification](../operations/examples.md).

`plane.js` owns card and tab actions. `compositor.js` measures or predicts surface rectangles. `host.js` sends native requests. Each application's `runtime/index.js` implements transport for its runtime. `environment.js` loads the application's plugins and defaults. `settings-ui.js` owns settings DOM; `card.js` handles inputs shared with `overlay.html`.
