# Example model

[한국어](example-model.ko.md)

The independent window declaration, placement, association and rail-border contract is [external window sidebars](external-sidebars.md). The internal card-side contract remains independent.

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

A card has content and at most one sidebar on each of top, bottom, left, and right. There is one card-sidebar state and command path. Top and bottom span the content area; left and right flank its center. An explicit set overrides the active plugin default and survives tab changes. Without an explicit set, the plugin default applies. `core.card.sidebar.set {card, side, set}` accepts a known set, `off` to disable that side, or `inherit` to clear the explicit selection. Folding and sizing through `core.card.sidebar.toggle {card, side}` and `core.card.sidebar.size {card, side, size}` persist independent layout values without making a default-derived set explicit. The card remains the same size and content fills the residual area. `core.grid` reports effective sides as `sidebars`; the separate inset sidebar, panel commands, and duplicate left column are removed.

Card layout is stored in `data.sidebars`, keyed by side. Each entry may contain an explicit `set`, a `size`, and a boolean `collapsed`. An absent `set` derives the active plugin default; `off` disables the side. `inherit` removes only the explicit set and retains layout. Missing assigned sets, invalid saved fields or values, and obsolete `data.sidebar` or `data.panels` produce explicit errors; there is no migration or hidden removal. Folding hides section content and retains a visible divider with an input area. Static residual-width and divider-area checks are separate from full gesture acceptance. Fixed external sidebars and their active plugin overrides follow the external-window contract; legacy flow/pin positioning is removed.

A card-sidebar divider measures the sidebar extent at pointer-down and adds the signed pointer displacement: left/top increase toward the card center, right/bottom increase in the opposite direction. The opposite sidebar, card header and footer do not contribute to this displacement. The size is bounded by the declared sidebar limits. A drag from a folded side starts at the folded extent and opens the side when the pointer reaches the minimum size, so the edge stays under the pointer; a drag stores the size and an open choice. A click without a drag folds a side shown open and opens a side shown folded, whatever the stored choice was. The divider input box stays inside the sidebar at its inner edge; it must not extend beyond a clipped parent or put its center on a native surface.

The browser application simulates native surfaces. Browser checks do not verify native composition; native acceptance requires the host checks in [verification](../operations/examples.md).

`plane.js` owns card and tab actions. `compositor.js` measures or predicts surface rectangles. `host.js` sends native requests. Each application's `runtime/index.js` implements transport for its runtime. `environment.js` loads the application's plugins and defaults. `settings-ui.js` owns settings DOM; `card.js` handles inputs shared with `overlay.html`.

## Card fullscreen

The card header has a fullscreen toggle immediately before the close X. `core.card.fullscreen {card}` toggles that content card between its normal arrangement and the full work area. The control has DOM name `core.card.fullscreen`, an explicit accessible name, and a restore icon drawn in the focus color while fullscreen, like the pressed toggles of the window header. `core.grid.fullscreen` reports the presented card ID or null; each card reports whether it is fullscreen. Fullscreen is transient presentation state, not a saved layout mutation. Other cards and their live surfaces are hidden without disposal. The same toggle restores all original card geometry and state. Resizing the work area retains fullscreen. Structural operations restore normal presentation before changing the layout; selecting another card restores normal presentation. Invalid and sidebar-only cards fail explicitly. The OS window state does not change.

Card-sidebar expansion depends on the saved choice and available presentation space. The room of an axis is the card extent less its borders (and header and footer for height), the current layout minimum for content (currently 96 points), and the divider of each side folded by choice. Open sides whose stored sizes fit the room are shown at those sizes. When they do not fit, they are shown smaller in proportion to their stored sizes; when that would make a side smaller than the declared sidebar minimum, the side operated last (by click or drag; top or left before any operation) is shown at the size that fits, at most its stored size, and the other side folds automatically. A side that does not fit at the minimum alone folds automatically. Width applies to left/right and height to top/bottom. The status line of the card names the sides folded for lack of space. A folded side uses only the declared divider width and draws only a grip at its centre with the length, thickness and colours of the grip of a card divider (the grip colour, and the active grip colour on hover and press); it draws no line along the side, because such a line reads as another card edge. Recompute on fullscreen, resize and layout restore. Preserve assigned sets, sizes and saved user fold choices. core.grid exposes actual collapsed, requestedCollapsed, autoCollapsed, collapseReason and shownSize (the size shown, or null for a folded side). A user-folded side stays folded when more space becomes available.
