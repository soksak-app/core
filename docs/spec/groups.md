# Group cards

[한국어](groups.ko.md)

A group card names a rectangle of the grid of a space and holds the cards inside it. This specification owns the group tree of a space, the leader of each level, the group header, the commands `core.group.*`, the group members of `core.layout`, `core.grid`, `core.card.get` and the window description, the stored form of the group tree in `projects.json`, and the drawing of the groups. The grid of a space follows the rules of the layout library ([soksak](../../packages/soksak/docs/layout.md)); the card commands and the layout operations follow [acting on a layout](cli.md#acting-on-a-layout); the declarations follow [exposure](exposure.md).

## Scope

The card and tab structure stays as it is: content cards, their tabs, the commands, statuses and elements of cards and tabs, and the stored grid keep their contract, and `packages/soksak` stays unchanged. A space keeps one grid with one set of lines. The one addition is the group card: a node of a tree stored beside the grid that names a set of cards whose cells form one rectangle of that grid. This specification states only what the group card adds and how the existing commands reach a card inside a group; a content card inside a group is a content card of the grid as any other.

## Model

- A space has one grid of the layout library: the state `{xs, ys, cards, paidBy}` of `toJSON` of `packages/soksak`, whose cards are the content cards and the window sidebars ([external window sidebars](external-sidebars.md)). Every line of the grid is one line across the whole space, inside and outside the groups, as R1 of the layout library states for every boundary.
- A group card is a node of the group tree of the space. It has an identifier, a name, a leader and its members: content cards of the grid and group cards, at least two. A window sidebar is no member. Each content card and each group card is a member of at most one group card; a card that is a member of no group card is a member of the root level.
- The rectangle of a group card is the span of line indices `[c0, c1) × [r0, r1)` from the smallest first line to the largest last line of the content cards inside it, its members and the members of the group cards inside it. A group card covers one rectangle: the cells of the content cards inside it are exactly the cells of its rectangle, so no other card of the grid holds a cell of the rectangle. The rectangle of a group card lies inside the rectangle of the group card that holds it.
- The level of the root level is 0, and the level of the members of a group card is the level of that group card plus 1. The level is derived from the tree and not stored.
- While a space holds a group card, every operation of the workbench on the grid ends with `tidy` and keeps no `paidBy` record, so a card that closes or moves gives its cells to the neighbours that [closing](#closing) chooses and every line that a remaining card uses keeps its coordinate. A layout with groups is stored in this form.
- The identifier of a card names one card in its space: a content card and a group card take their identifier from one sequence, `card-<n>` with `n` one greater than `lastCard`, the largest card number that the space issued, which the layout stores ([storage](#storage)), so a space never issues an identifier again after it ended, also after a restart. A card keeps its identifier when it moves into or out of a group, and every command that names a card (`core.layout.open`, `core.layout.select`, `core.layout.close`, `core.card.*`, `core.tab.move`, `core.group.*`) takes a card of any level of the active space.
- The word group alone names the group card only in the names `core.group.*`, `core.card.group` and in the member `group` of the records of this specification; the member `group` of an item of `core.picker` and the groups of the window snapshot keep their meaning.
- The reading order of a level orders its members by the first row line `r0` and then by the first column line `c0` of the card or of the rectangle of the group card; it follows the lines and not the order of an array, as R2 of the layout library requires. The workbench order of the cards is the reading order of the root level, where each group card stands before its members in their reading order.

### Drawn rectangles

The layout library gives the rectangle of each card of the grid (R5). The header of a group card is one row of the card head height (`head-h` of the chrome metrics, [layout values](settings.md#layout-values)) across the top of its rectangle, and the headers of the group cards that share a top line stack from the outermost down. A header is a box of the layout as a card is, so the corridor `gap` separates it from every box below it: a nested header, a frame or a card. So a content card is drawn below the headers of the group cards that hold it and start on its first row line: its drawn rectangle is the rectangle of the library moved down and made shorter by `k` × (`head-h` + `gap`), where `k` is the number of those group cards. Its left, right and bottom edges stay on the lines of the grid, so two cards on the same line are drawn on the same coordinate whichever groups hold them. The drawn rectangle of a group card is the union of the library rectangles of the content cards inside it, moved down and made shorter by the headers of the group cards that hold it and start on its first row line, as for a content card; its header is the top row of it, `head-h` high, and spans its whole width. The drawn heights that the minimum size and a split compare are these heights.

### Minimum size

A content card is drawn at least `minSize` on both axes. The layout library holds that bound for its rectangles; the headers make a card drawn shorter, so the workbench applies each operation (split, close, insert, move, balance, arrange, a boundary drag, a group change) to a copy of the grid and the group tree first, as the drop preview does today, and refuses the operation when a content card that it changes would then be drawn below `minSize` on an axis. A card that a window resize already left below its size does not refuse an operation that does not change it. The drop preview and the release of a drop use the same check, so a position that the check refuses shows no preview and its release changes nothing. A boundary drag is the drag of the library and moves the whole line across every group; it stops at the last position at which every content card beside the line is drawn at least `minSize`. A change that is not an operation, a window resize, a change of `gap`, of `size` or of the text size, re-expresses the proportions of the grid and refuses nothing, as R5 states: a card is then drawn below its minimum until the room returns.

## Leader

Each level that holds a content card or a group card has exactly one leader: one of its members, a content card or a group card. A window sidebar is never a leader, so a root level that holds only window sidebars, which a close of its last content card leaves today, has no leader and stores `leader: null`; the first card that a later change puts into it becomes its leader.

- A new group card takes as its leader the card that `core.group.create` groups, not the new card beside it. A new space takes the first card of its root level in reading order that is not a window sidebar.
- When `core.group.create` groups the leader of a level, the new group card takes the leader mark of that level, because it takes the place of the card.
- `core.group.leader {card}` makes `card` the leader of its own level. It changes no other level.
- When the leader of a level leaves the level, by a close or a move to another level, the first remaining member of the level in reading order that is not a window sidebar becomes the leader.
- When a group card is dissolved, the leader of its members becomes the leader of the level that held it if the group card was the leader there; otherwise that level keeps its leader.
- A group card can be the leader of its level while one of its members is the leader of its members; the two marks are independent.

The leader is a mark: it changes no command, no focus and no drawing order. `core.layout` and `core.grid` report it in every level, and in a level of two or more members the header of the leader shows it by the existing means of a card header, the pressed state of a header button ([headers](#headers)).

## Headers

The buttons of a header act on the box of that header: the card for a content card header and the rectangle of the group card for a group header.

| Header | Element | Command | Effect |
| --- | --- | --- | --- |
| content card | `core.card.add` | `core.card.menu {card, menu: "add"}` | Adds a tab to the card, as today |
| content card | `core.card.split-x`, `core.card.split-y` | `core.card.menu {card, menu}` | Puts a new content card beside the card in its group, as today |
| content card | `core.card.group` | `core.card.menu {card, menu: "group"}` | Opens the plugin menu of a new card; its items run `core.group.create {card, side, plugin}`, which groups the card with the new card |
| content card | `core.card.leader` | `core.group.leader {card}` | Makes the card the leader of its level |
| group card | `core.group.add` | `core.card.menu {card: <group>, menu: "add"}` | Adds a content card with the picked tab inside the group at the right edge of its rectangle |
| group card | `core.group.split-x`, `core.group.split-y` | `core.card.menu {card: <group>, menu}` | Puts a new content card beside the rectangle of the group card in the level that holds it |
| group card | `core.group.wrap` | `core.card.menu {card: <group>, menu: "group"}` | Opens the plugin menu of a new card; its items run `core.group.create {card: <group>, side, plugin}`, which groups the group card with the new card |
| group card | `core.card.leader` | `core.group.leader {card: <group>}` | Makes the group card the leader of its level |
| group card | `core.group.fullscreen` | `core.card.fullscreen {card: <group>}` | Shows the group card across the work area, or restores the arrangement |
| group card | `core.group.close` | `core.group.menu {group}` | Opens the close menu of the group |

- A split never creates a group: a split of a content card puts the new card into the group that holds the card, and a split of a group card puts it into the level that holds the group card.
- The side of the group button is the longer axis of its box: `right` when it is drawn wider than it is high, otherwise `bottom`. `core.card.group` and `core.group.wrap` are shown only while `core.group.create` of their card toward that side would succeed. `core.card.menu` takes the menu `group` beside `add`, `split-x` and `split-y`, and its items are the plugins of the add and split menus.
- `core.card.leader` is shown in the header of every member of a level that holds two or more members. It is pressed (`aria-pressed` true) on the leader, where it is the leader mark, and not pressed on the other members; a level of one member shows none. It is a head button of the existing card header design and follows the header fit of the card tools, so a header too narrow for it holds it in the tool menu (`core.card.tools`).
- A group header is a card header of the existing design ([card layout](example-model.md)): the head height `head-h`, the head buttons, their icons and the theme of a card header. In the place of the tab strip it shows the name of the group (`core.group.name`), and its head buttons stand where the head buttons of a content card stand: `core.group.add`, `core.group.split-x` and `core.group.split-y` with the icons of `core.card.add`, `core.card.split-x` and `core.card.split-y`, then `core.group.wrap`, `core.card.leader`, `core.group.fullscreen` with the icons of `core.card.fullscreen`, and `core.group.close` with the icon of `core.card.close`. The only icons that group cards add are the icon of the group button (`core.card.group`, `core.group.wrap`) and the icon of the leader mark (`core.card.leader`), both declared in the icons of `workbench.json` with the other card head icons. The level is reported in `core.layout` and `core.grid` and is not drawn.
- A double-click on `core.group.name` runs `core.rename.begin {kind: "group", id}`, and the rename field (`core.rename.input`) commits through `core.rename.commit`, which runs `core.group.rename`; `core.rename.begin` takes the kind `group` beside `project` and `space`.
- The close menu of a group is a picker with the items 그룹 닫기, which runs `core.card.close {card: <group>}`, and 그룹 풀기, which runs `core.group.dissolve {group}`. Its items are `core.picker.item` entries, and `core.picker` reports the menu open with its group card and its items, as it reports the add menu of a card.

## Commands

Each command answers after the placement that shows its change. A card or a group that is in a space that is not active, or in no space of the window, fails with the texts of [acting on a layout](cli.md#acting-on-a-layout). A change of the layout while a card or a group card is fullscreen fails with `card <id>: the layout does not change while card <shown> is fullscreen; restore the arrangement first`, inside the fullscreen group card as outside it. A refused command changes nothing. Sizes in error texts are drawn sizes in whole points, rounded to the nearest point, written `<w>x<h>`.

### The rectangle of a group card

Three operations act on the rectangle of a group card `G` with the layout library, and each is the generalization of a library operation to a rectangle:

- To lay the members of `G` into a rectangle `[a, b]` on an axis, each line of the grid that a content card inside `G` uses on that axis, at the coordinate `t` in the span `[a0, b0]` of `G`, is used at `a + (b − a) × (t − a0) / (b0 − a0)`; a coordinate that equals the coordinate of a line of the grid, as numbers and without a tolerance (R1), is that line, and every other is a new line. The content cards inside `G` take those lines, and the cards outside `G` keep theirs, so no line that a card outside `G` uses moves. The lines that no card uses after it are removed (`tidy`), and the result keeps no `paidBy` entry of a card that it lays out, because the lines of that card moved. The workbench installs the result with `replace`, which runs `checkState`.
- The split of the rectangle of `G` toward `side` is the generalization of R4: the rectangle is replaced by two rectangles that divide it at the middle of the axis of `side`; the new card takes the half toward `side`, and the members of `G` are laid into the other half. With `cardSplit` `even`, `balance()` follows ([split setting](#split-setting)).
- To make `G` one card, the content cards inside `G` are replaced by one card that spans its rectangle; this is a state of the library, because the cells of the rectangle are exactly the cells of those cards. It is used for the close and the move of `G`, and the members are laid into the rectangle of that card after a move.

| Command | Parameters | Result | Rule |
| --- | --- | --- | --- |
| `core.group.create` | `{card, side, plugin, params?}` | `{group, card, tab}` | Groups `card`, a content card or a group card, with a new content card. The new card comes from the split of `card` toward `side` (`left`, `right`, `top` or `bottom`): the split of the library (`splitToward`) for a content card and the split of the rectangle for a group card, with a tab of `plugin` with `params`. The new group card takes the next card identifier, then the new card the identifier after it, the name `그룹 <n>`, where `n` is the smallest positive integer that no group of the space has in its name `그룹 <n>`, the place and the leader mark of `card` in its level, and the members `card` and the new card, with `card` as its leader. The result names the group card, the new card and its tab, and the focus moves to the new card |
| `core.group.dissolve` | `{group}` | `{dissolved: true}` | Replaces the group card with its members in the level that holds it. The grid does not change; the cards of the first row of the group are drawn taller by the header that the group gave up. The leader rule of a dissolve applies |
| `core.group.rename` | `{group, name}` | `{group, name}` | Sets the name of the group to `name` with the white space at both ends removed |
| `core.group.leader` | `{card}` | `{card, group}` | Makes `card`, a content card or a group card, the leader of its level; the leader button of a header runs it with the card of that header; `group` is the identifier of the group card that holds `card`, or `null` for the root level |
| `core.group.menu` | `{group}` | `null` | Opens the close menu of the group, or closes it when it is open |
| `core.card.move` | `{card, target, side}` | `{card}` | Moves `card`, a content card or a group card, beside `target` on `side` (`left`, `right`, `top` or `bottom`) into the level of `target`, or with `side` `centre` and a group `target` into that group at the right edge of its rectangle, as a drop does. A content card moves with the move of the library (`move`); a group card is made one card, that card moves with `move`, and the members are laid into its new rectangle. A move into a group is the close of the card at its place and the add of the group card with that card. The card keeps its identifier. The leader rule of a card that leaves its level applies to the level that it leaves |

Every operation of the grid keeps each group card one rectangle. A split of a content card puts the new card into the group that holds the card, which keeps the rectangle, since the split divides a cell of it. A close, a move, a drop or an insert whose result leaves a group card without one rectangle is refused, and so is one that draws a content card below its minimum.

The refusals, in the order in which each command checks them:

| Command | Condition | Text |
| --- | --- | --- |
| `core.group.create` | `card` is a window sidebar | `card <id> is a window sidebar; a group holds content cards and group cards` |
| `core.group.create` | the layout refuses the split of `card` toward `side` | `card <id> cannot hold a group toward <side>` |
| `core.group.create` | a content card would be drawn below its minimum | `card <id> cannot hold a group toward <side>: card <c> would be <w>x<h>, below its minimum <m>x<m>`, with `<c>` the first such card in workbench order and `<m>` `minSize` |
| `core.group.create` | `plugin` or `params` is refused | the text of `core.card.split` for that plugin or those parameters ([acting on a layout](cli.md#acting-on-a-layout)) |
| `core.group.dissolve`, `core.group.rename`, `core.group.menu` | `group` names a content card or a window sidebar | `card <id> is not a group` |
| `core.group.rename` | the name has fewer than 1 or more than 40 Unicode scalar values after the white space at both ends is removed | `group name must be 1 to 40 characters: <name>` |
| `core.group.leader` | `card` is a window sidebar | `card <id> is a window sidebar and cannot lead a level` |
| `core.card.move` | `card` is a window sidebar | `card <id> is a window sidebar and does not move` |
| `core.card.move` | `target` is a window sidebar | `card <target> is a window sidebar; a card does not move beside it` |
| `core.card.move` | `target` is `card` or a card inside `card` | `card <id> cannot move into itself` |
| `core.card.move` | `side` `centre` with a content card `target` | `card <target> is not a group; a card moves beside it` |
| `core.card.move` | the layout refuses the move | `card <id> cannot move to <side> of <target>` |
| every operation | the result leaves a group card without one rectangle | `card <id> cannot <operation>: group <g> would not cover one rectangle`, with `<g>` the first such group card in workbench order |
| every operation | a content card would be drawn below its minimum | `card <id> cannot <operation>: card <c> would be <w>x<h>, below its minimum <m>x<m>` |

`<operation>` is the text of the operation in the refusals of the layout: `split toward <side>`, `close`, `move to <side> of <target>`.

### Idempotency

The same command with the same identifiers applied a second time leaves the same state and returns the same result:

- `core.group.create {card, side, plugin, params}` returns `{group: G, card: N, tab: T}` and changes nothing when `card` is a member of a group card `G` whose members are exactly `card` and `N`, `N` is the neighbour of `card` toward `side` by the rule of `core.layout.open`, and `N` holds the tab `T` of `plugin` with `params`.
- `core.group.dissolve {group}` of a group card that this window dissolved since its workbench started answers `{dissolved: true}` and changes nothing; the window keeps the identifiers of the group cards that it dissolved, as it keeps the closed tabs ([acting on a layout](cli.md#acting-on-a-layout)). An identifier that the window did not dissolve in this run fails with the text of a card that is not in the layout, also after a restart, as a repeated close of a tab does; because no identifier is issued twice, that identifier never names another card.
- `core.group.rename` with the current name, `core.group.leader` of the current leader and `core.card.move` of a card that already stands where the move puts it (a member of the level of `target` and its neighbour toward `side`, or with `centre` a member of `target` at the right edge of its rectangle reaching from its top to its bottom) return the same result without a call of the layout, so nothing changes.
- `core.group.menu` toggles the menu, as `core.card.menu` toggles a card menu; `core.layout` does not change.

### Card commands on a group card

- `core.card.add-tab {card: <group>, plugin, params?}` adds a content card with the tab inside the group at the right edge of its rectangle: the split of the rectangle toward `right`, where the new card becomes a member of the group, and returns `{tab}` as for a content card.
- `core.layout.open {card: <group>, plugin, params?}` selects the first tab of `plugin` with `params` among the content cards inside the group in workbench order, and otherwise adds a card as `core.card.add-tab` does. With `side`, it splits the rectangle of the group card toward `side` in the level that holds it.
- `core.card.menu {card: <group>, menu}` opens the add, split or group menu of the group header, whose items run `core.card.add-tab`, `core.card.split` and `core.group.create {card: <group>, side, plugin}` on the group card, as the menus of a content card run them on the content card.
- `core.card.split {card: <group>, side, plugin}` puts a new content card beside the rectangle of the group card by the split of the rectangle; the new card becomes a member of the level that holds the group card.
- `core.card.close {card: <group>}` closes the group card with every card inside it: the group card is made one card and closed with the close of the library (R7). Each modified tab is asked about first, as `core.card.close` asks for the tabs of one card, and the result is `closed: false` until every asked tab is saved or discarded.
- `core.card.focus {card: <group>}` focuses the first content card inside the group in workbench order.
- `core.card.fullscreen {card: <group>}` shows the group card across the work area: its rectangle is mapped onto the whole plane, scaled on each axis, and the content cards and the group cards inside it are drawn at the rectangles that the mapping gives them, with their headers; every other card is hidden with an empty rectangle, as for a fullscreen content card. The grid does not change, and a second `core.card.fullscreen` of the group card restores the arrangement. A content card inside a group goes fullscreen alone, as today. While a group card is fullscreen, the layout does not change, inside the group card as outside it, by the rule of a fullscreen card, and a focus of a card inside it keeps it fullscreen.
- `core.layout.balance` and the card auto-arrange command (`cardArrange`) act on the grid, as today; they keep the arrangement, so every group card keeps its rectangle.

### Split setting

The setting `cardSplit` ([values](settings.md#values)) decides the sizes after a split: with `exact`, the default, a split divides only the box that it splits: the rectangle of the card (R4 of the layout library), or the rectangle of the group card ([the rectangle of a group card](#the-rectangle-of-a-group-card)). It divides the drawn rectangle, not the rectangle in the grid: a split toward `top` or `bottom` whose upper half stands below headers, which the split of the group button always is, cuts at a new line and places it so that the two drawn rectangles, after the headers, have one height, and it is refused only when even that line draws a card below its minimum ([minimum size](#minimum-size)). A split toward `left` or `right` and a split whose upper half stands below no header divide as the layout library does. With `even`, the workbench runs `balance()` on the grid in the same change, so every card takes a fair size and the arrangement stays. It applies to `core.card.split` and the split buttons, to the split of `core.group.create` and the group button, to the add of a card to a group, and to `core.layout.open` with `side`. `balance()` gives every card a fair share and does not check the drawn minimum, so with `even` the workbench checks the balanced grid on its copy, as for every operation ([minimum size](#minimum-size)), and refuses the whole split when a content card would be drawn below its minimum, with `card <id> cannot split toward <side>: cardSplit even would draw card <c> at <w>x<h>, below its minimum <m>x<m>`, `<c>` the first such card in workbench order, or when `balance()` throws, with `card <id> cannot split toward <side>: cardSplit even cannot balance the grid: <the error of balance>`; nothing changes. The repetition of `core.layout.open` with `side` finds the new card as the neighbour toward `side` in both values, so its idempotency holds.

### Closing

A group card never holds one member. When a close, a move or a tab drop leaves one member in a group card, that member replaces the group card in the level that holds it in the same change, after the target of the move was resolved: it takes the place and the leader mark of the group card, keeps its identifier, and the group card ends, as a dissolve ends it. The grid does not change for the replacement, so it is never refused. A close of every card inside a group card is a close of the group card, `core.card.close {card: <group>}`. A close that would close the last card of the grid follows the rule of the last card of a layout (R7 of the layout library).

A close of a card of the grid, by itself, as the close of a group card made one card, or as the first half of a move, gives its cells to a row of neighbours as R7 of the layout library states. The sides are tried in the fill order of the library, the sides whose row of neighbours lies inside the level of the card first, and the first result that keeps every group card one rectangle is kept; so a card inside a group gives its cells to the cards of its group where it can, and a card of the root level never makes a group grow. A card without such a row has its slots removed, as the library removes them. A close that none of them allows is refused with its cause: `card <id> cannot <operation>: group <g> would not cover one rectangle` with the group card that the first side breaks, `card <id> cannot <operation>: it is the last card of the layout`, or `card <id> cannot <operation>: no row of cards that can grow covers a side of it, and its slots hold other cards`.

## Moving and dropping

A tab drag and `core.tab.move` take a target card of any level. A drop resolves from the root level inward. At a level, a point inside the drawn rectangle of a group card is resolved on that group card: a point on its header is the `centre` of the group card; a point in the outer quarter of its rectangle on a side (`edge` 0.25 of the rectangle, as `zoneAt` measures the body of a card) is that side of the group card; any other point goes on to the members of the group card. A point that lies in no group card of the level is resolved by `zoneAt` of the grid on the content card under it, with its five zones. So a drop reaches every side and the centre of every content card of every level, every side and the centre of every group card, from inside a group, from outside it and from another group, as between the cards of a space without groups.

- A drop on the `centre` of a content card moves the tab into the card, as today.
- A drop on a side of a content card puts the tab into a new card beside it by the split of the library, and the new card becomes a member of the group that holds the target; the only tab of a card moves its card there with `move`, and the card becomes a member of that group.
- A drop on the `centre` of a group card puts the tab into a new content card inside the group at the right edge of its rectangle, as `core.card.add-tab` does; the only tab of a card moves its card there.
- A drop on a side of a group card puts the tab into a new card beside the rectangle of the group card in the level that holds it, by the split of the rectangle; the only tab of a card moves its card there, as `core.card.move` moves it.

A tab that is the only tab of its card moves its card, which keeps its identifier, as today. A press and drag on the header of a group card outside its controls moves the group card: the drop resolves as for a tab, and the release runs `core.card.move {card, target, side}`. While a group card is dragged, the resolution leaves out the dragged group card and the cards inside it, as a tab drag leaves out the centre of its own card today (`centreOnly`); a release with no zone changes nothing and shows no error.

## Focus

The focus ring stands on one content card of any level, and the keyboard follows it as [the keyboard follows the focus ring](exposure.md#the-keyboard-follows-the-focus-ring) states, whichever group holds the card. A group card takes no focus ring and no keyboard: a command or a press that focuses a group card focuses the card that `core.card.focus` gives. The order of the elements of the workbench, which the `Tab` key follows, is the workbench order: a group card element and its header stand before the cards inside it. Moving a card into or out of a group keeps the focus on it.

## Status and queries

- `core.layout` reports the stored form of the layout ([storage](#storage)) with `level` added to each group node, `{card, name, level, leader, members}`, where `level` is the level of its members and `leader` the leader of its members, and with `leader`, the leader of the root level, beside `state`.
- `core.grid` keeps its value for the cards of the grid, with their drawn rectangles, and adds to each the member `parent`, the identifier of the group card that holds it, absent for the root level. Each card that is the leader of its level carries the added member `leader: true`, also the only member of a level. After the cards of the grid it lists the group cards in workbench order, each as `{id, x, y, w, h, parent, leader, group: {name, level, leader}}` with its drawn rectangle and no tabs.
- `core.card.get {card}` reads one card of any level, and it is the one query of the state of a card. The state of a content card is `{card, activeTab, tabs, groups}`: `card` its identifier, `activeTab` the identifier of its active tab or `null`, `tabs` its tabs in tab order as `{tab, plugin, status}`, where `status` is an object of the status values of that tab, the statuses that its plugin declares with `summary: true` ([exposure](exposure.md#entry-fields)), and `{}` for a plugin that declares none, and `groups` its group path: one `{card, name}` per group card that holds it, from the outermost to the innermost, `[]` in the root level, so a reader shows the path as `<name> > <name> > <name>`. A group card returns `{card, groups, group: {name, level, leader, members}}`, where `members` are its members in the tree form of `core.layout`: each content card by its identifier and each group card with its own node, down to the innermost group. A window sidebar fails with `card <id> is a window sidebar`, and an identifier that is no card of the active space fails with the texts of [acting on a layout](cli.md#acting-on-a-layout).
- `core.card.get {card}` and every command that names a card find the card by one walk of the group tree from the root level, which records the group cards that it passes: when the walk meets the identifier, the recorded group cards are the group path and the node is the subtree. A content card that the walk does not meet is a member of the root level.
- The `layout` of the [window snapshot](exposure.md#window-snapshot) and of `sok describe` keeps the tree of the grid, where each card node carries `parent` as `core.grid` does, and adds `groups`: the group tree as `core.layout` reports it, each node with its `frame`, the drawn rectangle of the group card, and `leader: true` on the leader of each level.

## Storage

A space layout in `projects.json` ([persistence](projects.md#persistence)) stores the grid as `state`, the group tree as `groups`, the largest card number that the space issued as `lastCard`, a positive integer at least as large as the number of every card identifier of the grid and of the group tree, and the leader of the root level as `leader`, the identifier of a member of the root level, or `null` while the root level holds only window sidebars. `groups` is the list of the group cards of the root level; each node is exactly `{card, name, leader, members}`: `card` its identifier, `name` the name of the group, `members` its members, each the identifier of a content card of `state` or a node of a group card, and `leader` the identifier of one of its members; the workbench writes the members of each level in reading order and the groups of the root level in reading order. The level is not stored, because the depth of the node gives it. A layout without groups stores `groups: []`.

The stored layout is read only in this form. Each refusal is a refusal of the space, as [persistence](projects.md#persistence) states for a stored layout: opening that space fails and the library preview shows the error, and the registry and the other spaces stay readable. The prefix of each refusal is `projects.json: project <root> space <space>: `, and `<level>` is `root` or `group <id>`:

| Found | Text |
| --- | --- |
| a grid that the layout library refuses | the error of `checkState` |
| a layout without `groups`, or a `groups` that is not a list | `layout stores groups <value>, which is not a list of groups` |
| a node of another form | `layout stores the group <value>, which is not {card, name, leader, members}` |
| a name of another form | `group <id> stores the name <value>, which is not 1 to 40 characters` |
| a node with fewer than two members | `group <id> holds fewer than two cards` |
| a member that is a window sidebar | `group <id> holds the window sidebar <side>` |
| a member that is no card of `state` and no node | `group <id> holds <value>, which is not a content card of the layout` |
| one identifier in two places of the group tree, or a group card with the identifier of a card of `state` | `card <id> is stored twice` |
| a layout without `leader`, a node without `leader`, or a `leader` `null` of a level that holds a content card or a group card | `level <level> has no leader` |
| a leader that is not a member of its level | `level <level> names the leader <id>, which is not a member of that level` |
| a window sidebar as the leader | `level <level> names the window sidebar <id> as its leader` |
| a group card that does not cover one rectangle | `group <id> does not cover one rectangle of the grid` |
| a layout with groups that stores a `paidBy` record | `layout with groups stores the paidBy record of card <id>; a layout with groups keeps none`, with `<id>` the first card of the records in sort order |
| a layout with groups that stores a line that no card uses | `layout with groups stores the <axis> line <k>, which no card uses; a layout with groups keeps none`, with the `x` lines before the `y` lines and `<k>` the smallest index |
| a layout without `lastCard`, or a `lastCard` that is not a positive integer or is smaller than the number of a card identifier of the grid or of the group tree | `layout stores lastCard <value>, which is not the largest issued card number` |

The members `groups`, `leader` and `lastCard` are required, so this form is not the form of the earlier releases: `projects.json` carries the format 2, and a file of format 1 is refused with `<file>: projects.json: format must be 2` ([stored data formats](installation.md#stored-data-formats)). No migration converts the earlier file. A file refused for its format is refused as a whole, unlike a refused space: it holds the registry, the screen state, the spaces and the project data of the plugins (`plugins`), so none of them is read, and every write of the file fails with its error until the file is removed: the release states that the person removes `projects.json` and adds the projects again, and that the settings files of the projects (`.soksak/settings.json`) and the folders stay. The layout cases of `docs/spec/cases/layout/groups.json` state the stored checks, the drawn rectangles, the commands and their refusals, the rectangle operations and the drop resolution, and the tests of `packages/workbench` and the Go layout model of `packages/workbench-mygo` run the same file.

## Drawing

A group card is drawn with the existing card design: its header is a card header of the theme and the chrome metrics, one bar across the whole width of its drawn rectangle, and its frame is the border and the radius of a card. The frame lies in the corridor around its drawn rectangle, half a gap outside it on every side, centred in the gap between its cards and the cards around it, so it covers no card and no header. The area inside the frame, the corridor between the cards of the group and its header, is filled with the color of its level: the color `bg` of the theme mixed with the theme color `group-<n>` by the setting `group.tint` in percent, where `n` is the level of the members of the group card and a level above 3 takes `group-3` ([values](settings.md#values)). The group cards are filled from the outermost inward, so a nested group card is a region of another color inside the group that holds it, and the boundary between a nested group card and the group that holds it shows where the color changes, also where their frames share a side. No grid rule, line or divider crosses a header: each rule and each grab area of a divider is cut where it would cross the drawn header of a group card, so a divider of a line inside a group starts below the stacked headers. The content cards inside a group card are drawn as cards of the existing design at their drawn rectangles ([drawn rectangles](#drawn-rectangles)). The grid draws its boundary lines and dividers (`sp-rule`, `sp-divider`) as today outside the headers: one line set across the space, so a divider moves its whole line through every group. The rail outlines the focused content card and its overridden window sidebar as today ([override context and rail border](external-sidebars.md#override-context-and-rail-border)). Both workbenches draw the group frames, fills and headers with the card chrome and the native screens in the same draw and transaction, as the acceptance criteria of [native surfaces](native-surfaces.md#acceptance-criteria) require. A layout preview of the library draws the grid as today and each group card as a frame around the panes inside it.

## Exposure

The declarations of `packages/workbench/exposure.json`; a description of this table replaces the description of the existing entry of the same name:

| Kind | Name | Description |
| --- | --- | --- |
| command | `core.group.create` | Groups a card with a new content card toward side. |
| command | `core.group.dissolve` | Replaces a group card with its members in the level that holds it. |
| command | `core.group.rename` | Renames a group card. |
| command | `core.group.leader` | Makes a card the leader of its level. |
| command | `core.group.menu` | Opens or closes the close menu of a group header. |
| command | `core.card.move` | Moves a content card or a group card beside a card of any level, or into a group, as a drop does. |
| command | `core.card.fullscreen` | Shows a content card or a group card across the work area, or restores the arrangement. |
| status | `core.layout` | The stored form of the current space layout with the level of each group node, or null. |
| status | `core.grid` | The current grid as today, each card with the group card that holds it, and the group cards with their rectangles. |
| command | `core.card.get` | Reads the state of one content card of any level with its group path, or one group card. |
| element | `core.group` | The frames of the group cards in workbench order. |
| element | `core.group.header` | The headers of the group cards in workbench order. |
| element | `core.group.name` | The names in the group headers in workbench order; a double-click renames. |
| element | `core.group.add` | The add buttons of the group headers in workbench order. |
| element | `core.group.split-x` | The vertical split buttons of the group headers in workbench order. |
| element | `core.group.split-y` | The horizontal split buttons of the group headers in workbench order. |
| element | `core.group.wrap` | The group buttons of the group headers in workbench order, shown while the group card can be grouped with a new card toward its longer axis. |
| element | `core.group.fullscreen` | The fullscreen buttons of the group headers in workbench order. |
| element | `core.group.close` | The close buttons of the group headers in workbench order; each opens the close menu of its group. |
| element | `core.card.group` | The group buttons of the content card headers in workbench order, shown while the card can be grouped with a new card toward its longer axis. |
| element | `core.card.leader` | The leader buttons of the card and group headers of levels of two or more members in workbench order; pressed on the leader. |

`core.rename.begin` declares the kind `group` beside `project` and `space`, and `core.card.menu` the menu `group`. Every element is bound through `createBinder`, and `core.workbench.audit` lists none of them as unbound.

## Decisions

- A space keeps one grid with one set of lines, and a group card names a rectangle of it. A line that continues from one group into another, or past a group, is one line: two cards on it are drawn on the same coordinate, and one drag moves it across every group, as between ordinary cards. A child grid with lines of its own for each group card was rejected: two grids cannot hold one line, so a seam that continues across groups lands at two coordinates and drags as two lines.
- The group tree is stored beside the grid and not in the data of a card, because a group card is no card of the grid: it holds no cell of its own, only the cells of the cards inside it. The grid stays exactly the state of the layout library, and every reader of a grid reads it unchanged.
- Every group card covers exactly one rectangle of the grid. The header, the frame, the drop resolution and the fullscreen of a group card need one rectangle, and an operation that would break it is refused with the group that it breaks, so the tree never names cells that are not one box.
- The header of a group card takes the top of its rectangle and makes the cards of its first row shorter, and the frame lies in the corridor, so the left, right and bottom edges of every content card stay on the lines of the grid. An inset of the cards inside the group was rejected, because it moves the edges of a card by the depth of its groups and two cards on one line are then drawn apart.
- A group card is filled with the color of its level and its header spans its whole width, and no rule or divider crosses a header. The frames of a nested group card and of the group that holds it lie on one line where they share a side, so frames alone do not show the nesting; the fill makes each nested group a region of its own color. A rule or a divider that crossed a header cut the bar into pieces that read as two headers. The colors are theme colors `group-1` to `group-3` of each mode, which the setting `group.tint` mixes into `bg`, so a theme keeps its own shades and a person can turn the fill down or off.
- The operations on the rectangle of a group card use the layout library: the split of a rectangle is R4 for a box of several cards, the cards inside take the half and keep their proportions, and the cards outside keep their lines; a close and a move make the rectangle one card, which the library closes or moves. So the library stays unchanged and every result is a state that `checkState` accepts.
- The drawn minimum is checked by the workbench on a copy of the grid and the tree, as the drop preview checks a drop, and not by an option of the library, because only the workbench knows the headers.
- A group always holds at least two members. `core.group.create` groups a card with a new card toward a side, so a group is made with its second card in one command; when one member remains, it replaces the group card. The group button takes the longer axis of its box, the axis with the room for two cards.
- The group card takes a new identifier, and the card that it groups keeps its identifier and its tabs, because every stored reference, tab session and command that names that card keeps naming it. The group card takes the place and the leader mark of the card in its level, because it stands where the card stood.
- The leader of the root level is stored as `leader`, and the leader of the members of a group card in its node. The level is derived from the depth of the node and not stored, so no stored value can contradict the tree.
- The tree is stored nested, the members of a group card in its node, because the main query of the tree is one card identifier to its whole ancestor path and its whole subtree: in the nested form the subtree is the stored node itself and the path is the walk to it, with no assembly. A flat form, one record per card with the identifier of its parent, was rejected: it needs the reference checks that the nested form holds by construction, and the file is written whole in either form.
- The workbench reaches a card by one walk of the tree and not through an index of the identifiers: an index would hold the containment of the cards a second time, which every move must update, so it can disagree with the tree; a space holds tens of cards, so one walk per query costs nothing measurable.
- `projects.json` takes the format 2: `groups`, `leader` and `lastCard` are state that a format-1 file does not have, and the stored-format rule requires a new format number and no migration. The release states the files that the person creates again.
- Card identifiers stay `card-<n>` of the existing form, issued by the workbench from `lastCard`, which the layout stores, so no identifier is issued twice, also across a restart. A random identifier was rejected, because it would change the form of the identifiers of content cards; a number derived from the stored identifiers was rejected, because after the cards with the largest numbers end it issues an ended identifier again.
- `cardSplit` `even` balances the grid, because the grid is the one set of lines of the space; `exact` stays the default, the behavior of R4 and of its generalization to a rectangle. When the balance would draw a card below its minimum, `even` refuses the split, because a return to the `exact` result would change the chosen setting into another value without a word.
- A space with groups keeps no `paidBy` record and no line that no card uses. A `paidBy` record makes the library return the room of a closed card to the card that it was split from by moving the lines between them, and in a space with groups those lines are the lines of the cards of the groups between the two cards, which then move although the operation did not name them; a line that no card uses is a target of a later split, which then lands on a seam of another group instead of the middle of the card. The library stays unchanged, and a space without groups keeps its records and lines as the library keeps them.
- A drop resolves from the root level inward on the rectangles of the group cards, with the edge share of `zoneAt`, and ends in `zoneAt` of the grid, so the five zones of every card of every level are reached, and no zone of a new kind is added.
- A group card goes fullscreen as a group: its rectangle with every card and header inside it covers the work area, because the person shows one box of the work as one card is shown. The layout does not change while it is fullscreen, inside it as outside it, by the one rule of a fullscreen card.
- A group card takes no focus ring, because the ring holds the keyboard for a surface and a group card has none; a focus of a group card goes to its first content card.

The review answered these objections:

- A `create` of the leader would leave its level with a leader that is not a member: the group card takes the leader mark of the card.
- A root level that keeps only window sidebars after a close has no card that can lead: its `leader` is `null` until a card enters it.
- A reused identifier, within a run or after a restart, would make a repeated dissolve dissolve another group: the workbench issues every identifier from the stored `lastCard`.
- Every operation would be refused while a window resize leaves a card below its drawn minimum: only an operation that changes a card is checked, and the drop preview and the release use the same check.
- `core.card.move` to the position that a card already holds would close and insert it again and change px sizes: it returns the result without a call of the layout.
- The split of a rectangle needs an equality for the lines that it maps: coordinates are equal as numbers, without a tolerance, as R1 requires, and a line that a card outside the group uses never moves.
- A move beside the group that the moved card leaves would lose its target when the group is replaced: the target is resolved before the replacement and the card lands beside the card that replaces the group.
- `core.card.get` would redefine the card state with a `leader` member: the card state stays and only `groups` is added; the leader is reported in `core.layout` and `core.grid`.
- The word group already names picker groups and snapshot groups: group alone names the group card only in the names and members that this specification lists, and the kit term list receives the new terms.
- The refusals of a stored group could be read as refusals of the whole file: they are refusals of the space, and only the format refusal refuses the file.
- The format bump loses the registry and the project data of the plugins: the release states it, and moving the layouts to another file was rejected, because that changes the form of `projects.json` too and gives the same loss.
- A close inside a group could take the place of a card from a card outside the group: the result is checked and refused with the group, so the tree never holds a group card of two boxes.
- The frames of nested group cards were drawn as one line where they share a side, which hid the nesting and drew a divider through the header of the outer group: each level has its fill, and a header is one bar that no rule crosses.
- A split toward bottom of a card below headers divided its rectangle in the grid, so the upper half lost the headers and a group of a card that fitted was refused below its minimum: a split divides the drawn rectangle at a new line, so both halves are drawn at one height.
- A header was drawn directly on the card or the nested header below it, so boxes touched without the corridor that separates every other pair of boxes: a header is followed by the gap, as a card is.
- The `paidBy` record of a card split inside a group could return its room across the space when it closes: a space with groups keeps no `paidBy` record, so the neighbours that take its cells are the only cards that change.
