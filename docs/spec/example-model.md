# Example model

[한국어](example-model.ko.md)

The example application owns projects, spaces, and tabs. The layout library owns card geometry.

| Object | Contents |
| --- | --- |
| Project | Root path, name, color, and spaces |
| Space | Card arrangement, focused card, rail widths, and tabs |
| Card | Layout slots, optional pixel size, and tabs |
| Tab | Plugin and title |

The [project contract](projects.md) defines directory identity, persistence, settings inheritance, startup selection, and project windows. Switching spaces captures the current application state and restores the selected space through `Soksak.replace()`.

The add and split buttons select a plugin for a new tab. Dropping a tab on a card center adds it to that card; dropping it at a card edge creates adjacent space. Moving the only tab in a card moves the card.

Plugins declare surfaces as `{page}`, a document inside the plugin package, and declare sidebar sections. A page shows web documents in document regions. The [plugin specification](plugins.md) defines the declaration files. Settings stores section sets and their assignments to the left sidebar, plugin rail, or right sidebar.

The setting `rail` (shown as "사이드바 위치") places the plugin sidebar; its default is `inset`, and its control lists 카드 안 (`inset`), 포커스 카드 옆 (`flow`), 고정 (`pin`), and 없음 (`off`) in that order. `flow` inserts it as a fixed column beside the focused card of its plugin, `sidebarWidth` wide until the column is resized in the space, and moves it with the focus; `pin` keeps the column where it stood; `off` hides it. With `inset` the sidebar stands inside every card whose active tab's plugin has a linked set, to the left of the surface, so no card changes size and no column is inserted. The card's content row is split into the sidebar and the surface slot, with no gap between them; a 6-point divider lies over the sidebar's right border and takes two gestures. Dragging it more than 3 points (`core.card.sidebar.size {card, width}`, from `sidebarMinWidth` to `sidebarMaxWidth`) changes the sidebar width and is never a click. A click runs `core.card.sidebar.toggle {card}` at once; there is no double-click gesture, and an unfolded sidebar keeps its stored width. A folded sidebar hides its content and keeps only the divider, drawn as a 2-point `--muted` line that a click unfolds. All of these keep the card's size, and the surface follows its slot. A card with no stored width opens its sidebar at `sidebarWidth`. The [settings window](settings.md#layout-values) defines these values (120, 480, and 190 points by default). The width and the folded state are stored per card in the space, and `core.grid` reports them for each card as `sidebar: {width, collapsed}` or `null`.

A card also carries assigned panels on its four sides (V5-115): at most one per side (`top`, `bottom`, `left`, `right` — four in total). A panel is assigned, not derived: `core.card.panel.set {card, side, set}` names a set for that side of that card and `off` removes it, and the assignment stays when the card's active tab changes to another plugin — that is the whole difference from the inset sidebar, whose set follows the active tab. Everything else is the same treatment: the shared section/set system draws the assigned set, `core.card.panel.toggle {card, side}` folds it to its divider and `core.card.panel.size {card, side, size}` sets its size (width for `left` and `right`, height for `top` and `bottom`) under the same 120–480 bounds with the same 190 default, and a drag past 3 points sizes while a click folds. The top and bottom panels span the card's full width; the left and right panels flank the center cell that holds the inset sidebar and the surface slot, and the inset sidebar keeps its behavior in that cell. A card keeps its size through every panel change, and the surface follows its shrunk slot. A set id that no longer resolves leaves the panel hidden and the assignment kept — nothing is silently cleared. The size and the folded state are stored beside the assignment, and `core.grid` reports the assigned sides as `panels: {side: {set, size, collapsed}}`.

The browser application simulates native surfaces. Browser checks do not verify native composition; native acceptance requires the host checks in [verification](../operations/examples.md).

`plane.js` owns card and tab actions. `compositor.js` measures or predicts surface rectangles. `host.js` sends native requests. Each application's `runtime/index.js` implements transport for its runtime. `environment.js` loads the application's plugins and defaults. `settings-ui.js` owns settings DOM; `card.js` handles inputs shared with `overlay.html`.
