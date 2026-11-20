# Group cards

[한국어](groups.ko.md)

A group card is a card whose body is a plane of its own. This specification owns the tree of planes, the leader of each plane, the group header, the commands `core.group.*`, the group members of `core.layout`, `core.grid`, `core.card.get` and the window description, the stored form of the tree in `projects.json`, and the drawing of the planes. The grid of one plane follows the rules of the layout library ([soksak](../../packages/soksak/docs/layout.md)); the card commands and the layout operations follow [acting on a layout](cli.md#acting-on-a-layout); the declarations follow [exposure](exposure.md).

## Scope

The card and tab structure stays as it is: content cards, their tabs, the commands, statuses and elements of cards and tabs, and their stored form keep their contract, and `packages/soksak` stays a library of one plane, unchanged. The one addition is the group card, a card that holds child cards in a plane of its own in the place where a content card holds tabs. This specification states only what the group card adds and how the existing commands reach a card inside a group; a content card inside a group is a content card as in the root plane.

## Model

- A plane is one grid of the layout library: the state `{xs, ys, cards, paidBy}` of `toJSON` of `packages/soksak`. The library stays a library of one plane, and the workbench holds the tree of planes.
- A space has one root plane, at level 0. A card of a plane is a content card, which holds one or more tabs, a group card, which holds one child plane, or, in the root plane only, a window sidebar ([external window sidebars](external-sidebars.md)). The child plane of a group card is at the level of the plane of the group card plus 1.
- A group card has a name, a header and a body. The header is one row of the card head height (`head-h` of the chrome metrics, [layout values](settings.md#layout-values)) at the top of the card. The body is the rest of the card, and the child plane lies in the body inset by half the gap on every side, as the root plane lies in the stage with a margin of half the gap ([values](settings.md#values)). A group card of the drawn size `w`×`h` gives its child plane the size (`w` − gap)×(`h` − `head-h` − gap). A group card holds no tab, no surface and no card sidebar.
- A group holds at least two cards; there is no group of one card. A child plane holds content cards and group cards and no window sidebar.
- The identifier of a card names one card in all the planes of its space: a content card and a group card take their identifier from one sequence, `card-<n>` with `n` one greater than `lastCard`, the largest card number that the space issued, which the layout stores ([storage](#storage)), so two planes never hold the same identifier and a space never issues an identifier again after it ended, also after a restart. A card keeps its identifier when it moves from one plane to another, and every command that names a card (`core.layout.open`, `core.layout.select`, `core.layout.close`, `core.card.*`, `core.tab.move`, `core.group.*`) takes a card of any plane of the active space.
- The word group alone names the group card only in the names `core.group.*`, `core.card.group` and in the member `group` of the records of this specification; the member `group` of an item of `core.picker` and the groups of the window snapshot keep their meaning.
- The reading order of a plane orders its cards by their first row line `r0` and then by their first column line `c0`; it follows the lines and not the order of the array of `cards`, as R2 of the layout library requires.

### Minimum size

A content card has the smallest edge `minSize` on both axes. The smallest extent of a plane on an axis is computed on its slicing tree (`sliceTree`): a card counts its smallest extent; a cut along the axis counts the sum of its sides plus one gap for each line between them; a cut along the other axis counts the largest of its sides. The smallest size of a group card is the smallest extent of its child plane plus the gap on the `x` axis, and plus the gap and `head-h` on the `y` axis.

A group fits when its child plane, at the size that the group card gives it, holds every card of the child plane at its smallest size. The layout library is not changed for this: the workbench applies each operation of a plane (split, close, insert, move, balance, arrange) to a copy of the plane first, as the drop preview does today, and refuses the operation when it changes the drawn size of a group card and that group card is then below its smallest size, so no operation takes a group card below it, as no operation takes a card below `minSize`. A group card that a window resize already left below its smallest size does not refuse an operation that does not change its size. The drop preview and the release of a drop use the same check, so a position that the check refuses shows no preview and its release changes nothing. A boundary drag stops at the last position at which every group card beside the boundary keeps its smallest size. An operation in a plane changes the sizes of the group cards of that plane, so the workbench applies it to the planes inside each changed group card in the same change, and refuses the whole operation when one of them refuses. A change that is not an operation, a window resize, a change of `gap`, of `size` or of the text size, re-expresses the proportions of every plane and refuses nothing, as R5 states for one plane: a card is then drawn below its smallest size until the room returns.

## Leader

Each plane that holds a content card or a group card has exactly one leader: one card of that plane, a content card or a group card. A window sidebar is never a leader, so a root plane that holds only window sidebars, which a close of its last content card leaves today, has no leader and stores `leader: null`; the first card that a later change puts into it becomes its leader.

- A new plane takes its first card as its leader: the card that `core.group.create` turns into a group, not the new card beside it. A new space takes the first card of its root plane in reading order that is not a window sidebar.
- When `core.group.create` puts the leader of a plane into a group, the new group card takes the leader mark of that plane, because it takes the slot of the card.
- `core.group.leader {card}` makes `card` the leader of its own plane. It changes no other plane.
- When the leader of a plane leaves the plane, by a close or a move to another plane, the first remaining card of the plane in reading order that is not a window sidebar becomes the leader.
- When a group is dissolved, the leader of its child plane becomes the leader of the parent plane if the group card was the leader of the parent plane; otherwise the parent plane keeps its leader.
- A group card can be the leader of its parent plane while one card of its own child plane is the leader of that child plane; the two marks are independent.

The leader is a mark: it changes no command, no focus and no drawing order. `core.layout` and `core.grid` report it in every plane, and in a plane of two or more cards the header of the leader card shows it by the existing means of a card header, the pressed state of a header button ([headers](#headers)).

## Headers

The buttons of a header act on the box of that header.

| Header | Element | Command | Effect |
| --- | --- | --- | --- |
| content card | `core.card.add` | `core.card.menu {card, menu: "add"}` | Adds a tab to the card, as today |
| content card | `core.card.split-x`, `core.card.split-y` | `core.card.menu {card, menu}` | Puts a new content card beside the card in the same plane, as today |
| content card | `core.card.group` | `core.card.menu {card, menu: "group"}` | Opens the plugin menu of a new card; its items run `core.group.create {card, side, plugin}`, which turns the card into a group card of the card and the new card |
| content card | `core.card.leader` | `core.group.leader {card}` | Makes the card the leader of its plane |
| group card | `core.group.add` | `core.card.menu {card: <group>, menu: "add"}` | Adds a content card with the picked tab at the right edge of the child plane |
| group card | `core.group.split-x`, `core.group.split-y` | `core.card.menu {card: <group>, menu}` | Puts a new content card beside the group card in the parent plane |
| group card | `core.group.wrap` | `core.card.menu {card: <group>, menu: "group"}` | Opens the plugin menu of a new card; its items run `core.group.create {card: <group>, side, plugin}`, which puts the group card and the new card into a new group card |
| group card | `core.card.leader` | `core.group.leader {card: <group>}` | Makes the group card the leader of its parent plane |
| group card | `core.group.close` | `core.group.menu {group}` | Opens the close menu of the group |

- A split never creates a group: a split of a content card and a split of a group card each put a new content card into the plane of the card that they split.
- The side of the group button is the longer axis of its card: `right` when the card is drawn wider than it is high, otherwise `bottom`. `core.card.group` and `core.group.wrap` are shown only while `core.group.create` of their card toward that side would succeed: the child plane that the card would give, (`w` − gap)×(`h` − `head-h` − gap), holds the card at its smallest size and a content card at `minSize` side by side toward that side with one gap between them, the size `mw`×`mh` of the refusal of `core.group.create`. `core.card.menu` takes the menu `group` beside `add`, `split-x` and `split-y`, and its items are the plugins of the add and split menus.
- `core.card.leader` is shown in the header of every card of a plane that holds two or more cards. It is pressed (`aria-pressed` true) on the leader, where it is the leader mark, and not pressed on the other cards; a plane of one card shows none. It is a head button of the existing card header design and follows the header fit of the card tools, so a header too narrow for it holds it in the tool menu (`core.card.tools`).
- A group header is a card header of the existing design ([card layout](example-model.md)): the head height `head-h`, the head buttons, their icons and the theme of a card header. In the place of the tab strip it shows the name of the group (`core.group.name`), and its head buttons stand where the head buttons of a content card stand: `core.group.add`, `core.group.split-x` and `core.group.split-y` with the icons of `core.card.add`, `core.card.split-x` and `core.card.split-y`, then `core.group.wrap`, `core.card.leader` and `core.group.close` with the icon of `core.card.close`. The only icons that group cards add are the icon of the group button (`core.card.group`, `core.group.wrap`) and the icon of the leader mark (`core.card.leader`), both declared in the icons of `workbench.json` with the other card head icons. The level of a plane is reported in `core.layout` and `core.grid` and is not drawn.
- A double-click on `core.group.name` runs `core.rename.begin {kind: "group", id}`, and the rename field (`core.rename.input`) commits through `core.rename.commit`, which runs `core.group.rename`; `core.rename.begin` takes the kind `group` beside `project` and `space`.
- The close menu of a group is a picker with the items 그룹 닫기, which runs `core.card.close {card: <group>}`, and 그룹 풀기, which runs `core.group.dissolve {group}`; 그룹 풀기 is shown only while the dissolve would succeed. Its items are `core.picker.item` entries, and `core.picker` reports the menu open with its group card and its items, as it reports the add menu of a card.

## Commands

Each command answers after the placement that shows its change. A card or a group that is in a space that is not active, or in no space of the window, fails with the texts of [acting on a layout](cli.md#acting-on-a-layout). A change of the layout while a card is fullscreen fails with `card <id>: the layout does not change while card <shown> is fullscreen; restore the arrangement first`. A refused command changes nothing. Sizes in error texts are drawn sizes in whole points, rounded to the nearest point, written `<w>x<h>`.

| Command | Parameters | Result | Rule |
| --- | --- | --- | --- |
| `core.group.create` | `{card, side, plugin, params?}` | `{group, card, tab}` | Turns `card` into a group of two cards. The group card takes the slot, the px sizes and the leader mark of `card` in its plane, the next card identifier and the name `그룹 <n>`, where `n` is the smallest positive integer that no group of the space has in its name `그룹 <n>`. `card` keeps its identifier, and its tabs or its child plane, and is the card of the child plane on the side opposite `side`, without px sizes, and the leader of the child plane. The child plane is split toward `side` (`left`, `right`, `top` or `bottom`) into `card` and a new content card with the identifier after the group card and a tab of `plugin` with `params`, as `core.card.split` puts a new card toward a side. The result names the group card, the new card and its tab, and the focus moves to the new card |
| `core.group.dissolve` | `{group}` | `{dissolved: true}` | Replaces the group card with the cards of its child plane: each line of the child plane is inserted into the parent plane inside the span of the group card, at the coordinate `a + (b − a) × t`, where `a` and `b` are the coordinates of the first and last line of the span and `t` the coordinate of the line in the child plane; a line whose coordinate equals the coordinate of a line of the parent plane, as numbers and without a tolerance (R1), is that line. The mapping is in the coordinates of the lines, so the drawn sizes of the cards change by the header and the inset that the group card gave up. Each card keeps its identifier, its data and its px sizes; the px sizes of the group card are not carried, because its cards span several slots of the parent plane or none of its own (R5). The leader rule of a dissolve applies |
| `core.group.rename` | `{group, name}` | `{group, name}` | Sets the name of the group to `name` with the white space at both ends removed |
| `core.group.leader` | `{card}` | `{card, plane}` | Makes `card`, a content card or a group card, the leader of its plane; the leader button of a header runs it with the card of that header; `plane` is the identifier of the group card whose child plane holds `card`, or `null` for the root plane |
| `core.group.menu` | `{group}` | `null` | Opens the close menu of the group, or closes it when it is open |
| `core.card.move` | `{card, target, side}` | `{card}` | Moves `card`, a content card or a group card, with its tabs or its child plane, beside `target` on `side` (`left`, `right`, `top` or `bottom`) in the plane of `target`, or with `side` `centre` and a group `target` to the right edge of the child plane of `target`, as a drop does. The card keeps its identifier. The leader rule of a card that leaves its plane applies to the plane that it leaves |

The refusals, in the order in which each command checks them:

| Command | Condition | Text |
| --- | --- | --- |
| `core.group.create` | `card` is a window sidebar | `card <id> is a window sidebar; a group holds content cards and group cards` |
| `core.group.create` | the card cannot hold a group of itself and a new card toward `side` | `card <id> cannot hold a group toward <side>: it is <w>x<h> and the group needs <mw>x<mh>`, where, with `cw`×`ch` the smallest size of `card`, `mw` is `cw` + `minSize` + 2 × gap and `mh` is max(`ch`, `minSize`) + `head-h` + gap toward `left` or `right`, and `mw` is max(`cw`, `minSize`) + gap and `mh` is `ch` + `minSize` + `head-h` + 2 × gap toward `top` or `bottom` |
| `core.group.create` | `plugin` or `params` is refused | the text of `core.card.split` for that plugin or those parameters ([acting on a layout](cli.md#acting-on-a-layout)) |
| `core.group.dissolve`, `core.group.rename`, `core.group.menu` | `group` names a content card or a window sidebar | `card <id> is not a group` |
| `core.group.dissolve` | a card of the child plane would be drawn below its smallest size in the parent plane | `group <id> cannot be dissolved: card <c> would be <w>x<h>, below its minimum <mw>x<mh>`, with `<c>` the first such card in the reading order of the child plane |
| `core.group.rename` | the name has fewer than 1 or more than 40 Unicode scalar values after the white space at both ends is removed | `group name must be 1 to 40 characters: <name>` |
| `core.group.leader` | `card` is a window sidebar | `card <id> is a window sidebar and cannot lead a plane` |
| `core.card.move` | `card` is a window sidebar | `card <id> is a window sidebar and does not move` |
| `core.card.move` | `target` is a window sidebar | `card <target> is a window sidebar; a card does not move beside it` |
| `core.card.move` | `target` is `card` or a card inside the child plane of `card` | `card <id> cannot move into itself` |
| `core.card.move` | `side` `centre` with a content card `target` | `card <target> is not a group; a card moves beside it` |
| `core.card.move` | the layout refuses the move | `card <id> cannot move to <side> of <target>` |

### Idempotency

The same command with the same identifiers applied a second time leaves the same state and returns the same result:

- `core.group.create {card, side, plugin, params}` returns `{group: G, card: N, tab: T}` and changes nothing when `card` is a card of the child plane of a group card `G` that holds exactly `card` and `N`, `N` is the neighbour of `card` toward `side` by the rule of `core.layout.open`, and `N` holds the tab `T` of `plugin` with `params`.
- `core.group.dissolve {group}` of a group card that this window dissolved since its workbench started answers `{dissolved: true}` and changes nothing; the window keeps the identifiers of the group cards that it dissolved, as it keeps the closed tabs ([acting on a layout](cli.md#acting-on-a-layout)). An identifier that the window did not dissolve in this run fails with the text of a card that is not in the layout, also after a restart, as a repeated close of a tab does, and the description shows that the group is gone; because no identifier is issued twice, that identifier never names another card.
- `core.group.rename` with the current name, `core.group.leader` of the current leader and `core.card.move` of a card that already stands where the move puts it (the neighbour of `target` toward `side`, or with `centre` the card at the right edge of the child plane of `target` reaching from its top to its bottom) return the same result without a call of the layout, so nothing changes.
- `core.group.menu` toggles the menu, as `core.card.menu` toggles a card menu; `core.layout` does not change.

### Card commands on a group card

- `core.card.add-tab {card: <group>, plugin, params?}` inserts a new content card with the tab at the right edge of the child plane, reaching from its top to its bottom (`insertAt` on `x` at the last line), and returns `{tab}` as for a content card; a child plane that cannot hold it fails with `group <id> has no room for a card at its right edge`.
- `core.layout.open {card: <group>, plugin, params?}` selects the first tab of `plugin` with `params` among the content cards of the child plane in reading order, and otherwise adds a card as `core.card.add-tab` does. With `side`, it splits the group card in its parent plane, as for any card.
- `core.card.menu {card: <group>, menu}` opens the add, split or group menu of the group header, whose items run `core.card.add-tab`, `core.card.split` and `core.group.create {card: <group>, side, plugin}` on the group card, as the menus of a content card run them on the content card.
- `core.card.split {card: <group>, side, plugin}` puts a new content card beside the group card in the parent plane.
- `core.card.close {card: <group>}` closes the group card with every card of its child plane and the planes inside them; each modified tab is asked about first, as `core.card.close` asks for the tabs of one card, and the result is `closed: false` until every asked tab is saved or discarded.
- `core.card.focus {card: <group>}` focuses the first content card in reading order of the child plane, descending into the first group card when the first card is a group card.
- `core.card.fullscreen {card: <group>}` fails with `card <id> is a group; fullscreen shows a content card`. A content card of any plane goes fullscreen across the work area, as today.
- `core.layout.balance` and the card auto-arrange command (`cardArrange`) apply to each plane on its own, from the root plane inward, so the size that a parent plane gives a group card decides its child plane; a group card counts as one card of its plane. When one plane refuses, nothing changes.

### Split setting

The setting `cardSplit` ([values](settings.md#values)) decides the sizes after a split: with `exact`, the default, a split divides only the rectangle of the card that it splits (R4 of the layout library), as today; with `even`, the workbench runs `balance()` on the plane of the split in the same change, so the cards of that plane take fair sizes and keep their arrangement, and no other plane changes except through the sizes of the group cards of that plane. It applies to `core.card.split` and the split buttons, to the split inside the new group of `core.group.create` and the group button, and to `core.layout.open` with `side`. A `balance()` that the plane refuses leaves the split as `exact` made it. The repetition of `core.layout.open` with `side` finds the new card as the neighbour toward `side` in both values, so its idempotency holds.

### Closing

A group never holds one card. When a close, a move or a tab drop leaves one card in a child plane, that card replaces the group card in the parent plane in the same change, after the target of the move was resolved, so a move beside the group card that the moved card leaves lands beside the card that replaces it, while a move or a drop into the `centre` of the group card that the card leaves puts the card into the child plane first, which then holds two cards again and is not replaced: it takes the slot, the px sizes and the leader mark of the group card there, keeps its identifier, and the group card ends, as a dissolve ends it; the replacement is never refused, because the card gets the whole slot of the group card. A close of every card of a child plane is a close of the group card, `core.card.close {card: <group>}`. A close that would close the last card of the root plane follows the rule of the last card of a layout (R7 of the layout library).

## Moving and dropping

A tab drag and `core.tab.move` take a target card of any plane. A drop resolves from the root plane inward: `zoneAt` of a plane gives a card and a zone; when the card is a group card and the zone is `centre`, the resolution goes on in its child plane at the same point, and a point on the group header, or a point of the body that the child plane resolves to no card, is the `centre` of the group card. So the outer quarter of the body of a group card on each side (`edge` 0.25) is a side of the group card in its parent plane, and the rest of the body belongs to its child plane. A drop on the `centre` of a group card puts the tab into a new content card at the right edge of its child plane, as `core.card.add-tab` does; a drop on a side puts it beside the target in the plane of the target. A tab that is the only tab of its card moves its card, which keeps its identifier, as today.

A press and drag on the header of a group card outside its controls moves the group card: the drop resolves as for a tab, and the release runs `core.card.move {card, target, side}`. While a group card is dragged, the resolution leaves out the dragged card and its child plane, as a tab drag leaves out the centre of its own card today (`centreOnly`); a release with no zone changes nothing and shows no error.

## Focus

The focus ring stands on one content card of any plane, and the keyboard follows it as [the keyboard follows the focus ring](exposure.md#the-keyboard-follows-the-focus-ring) states, whichever plane holds the card. A group card takes no focus ring and no keyboard: a command or a press that focuses a group card focuses the card that `core.card.focus` gives. The order of the elements of the workbench, which the `Tab` key follows, is the element tree: a group card element holds its header and then the cards of its child plane in reading order. Moving a card to another plane keeps the focus on it.

## Status and queries

- `core.layout` reports the stored form of the layout ([storage](#storage)) with `level` added to each group record, `group: {name, level, leader, plane}`, where `level` is the level of its child plane and `leader` the leader of its child plane, and with `leader`, the leader of the root plane, beside `state`.
- `core.grid` keeps its value for the cards of the root plane and adds the cards of the child planes in workbench order, each with the added member `plane`, the identifier of the group card whose child plane holds it; their rectangles are in the coordinates of the root plane, as the rectangles of the root plane are. Each card that is the leader of its plane carries the added member `leader: true`, also the only card of a plane. A group card is listed with the added member `group: {name, level, leader}` and no tabs.
- `core.card.get {card}` reads one card of any plane. A content card keeps its card state unchanged and adds the member `groups`, its group path: one `{card, name}` per group card that holds it, from the outermost to the innermost, `[]` in the root plane, so a reader shows the path as `<name> > <name> > <name>`. A group card returns `{card, groups, group: {name, level, leader, plane}}`, where `plane` is its child plane in the tree form of `core.layout`: every card of it in reading order, and every group card in it with its own `group` record, down to the innermost plane.
- The `layout` of the [window snapshot](exposure.md#window-snapshot) and of `sok describe` holds a group card as a node `{card, size, frame, group: {name, level, leader, root}}`, where `root` is the tree of its child plane in the form of the tree of the root plane; each node of the tree carries `leader: true` on the leader of its plane.

## Storage

A space layout in `projects.json` ([persistence](projects.md#persistence)) stores the root plane as `state`, the largest card number that the space issued as `lastCard`, a positive integer at least as large as the number of every card identifier of the tree, and the leader of the root plane as `leader`, the identifier of a card of the root plane, or `null` while the root plane holds only window sidebars. A group card of any plane is a card of its plane whose `data` is exactly `{group: {name, leader, plane}}`: `name` the name of the group, `plane` its child plane in the form of `state`, and `leader` the identifier of a card of `plane`. The level is not stored, because the depth of the record gives it. A layout without groups stores `leader` and no group record.

The stored layout is read only in this form. Each refusal is a refusal of the space, as [persistence](projects.md#persistence) states for a stored layout: opening that space fails and the library preview shows the error, and the registry and the other spaces stay readable. The prefix of each refusal is `projects.json: project <root> space <space>: `, and `<plane>` is `root` or `group <id>`:

| Found | Text |
| --- | --- |
| a layout without `leader`, a group record without `leader`, or a `leader` `null` of a plane that holds a content card or a group card | `plane <plane> has no leader` |
| a leader that is not a card of its plane | `plane <plane> names the leader <id>, which is not a card of that plane` |
| a window sidebar as the leader | `plane <plane> names the window sidebar <id> as its leader` |
| a group record of another form, or a group card whose `data` holds another member | `card <id> stores the group <value>, which is not {name, leader, plane}` |
| a child plane with fewer than two cards | `group <id> holds fewer than two cards` |
| a window sidebar in a child plane | `group <id> holds the window sidebar <side>` |
| one identifier in two places of the tree | `card <id> is stored twice` |
| a name of another form | `group <id> stores the name <value>, which is not 1 to 40 characters` |
| a child plane that the layout library refuses | `group <id>: <the error of checkState>` |
| a layout without `lastCard`, or a `lastCard` that is not a positive integer or is smaller than the number of a card identifier of the tree | `layout stores lastCard <value>, which is not the largest issued card number` |

The members `leader` and `lastCard` are required, so this form is not the form of the earlier releases: `projects.json` carries the format 2, and a file of format 1 is refused with `<file>: projects.json: format must be 2` ([stored data formats](installation.md#stored-data-formats)). No migration converts the earlier file. A file refused for its format is refused as a whole, unlike a refused space: it holds the registry, the screen state, the spaces and the project data of the plugins (`plugins`), so none of them is read, and every write of the file fails with its error until the file is removed: the release states that the person removes `projects.json` and adds the projects again, and that the settings files of the projects (`.soksak/settings.json`) and the folders stay. The layout cases of `docs/spec/cases/layout/groups.json` state the stored checks, the smallest extents, the commands and their refusals, the drop resolution, and the tests of `packages/workbench` and the Go layout model of `packages/workbench-mygo` run the same file.

## Drawing

A group card is drawn as a card of the existing design: its background, border, radius, header and focus treatment are those of a content card, from the theme and the chrome metrics, and no color, border or label is added for groups. Its child plane lies in its body as stated in [model](#model), and the cards of the child plane are drawn as cards of the existing design inside it. Each plane draws its own boundary lines and dividers (`sp-rule`, `sp-divider`) inside its rectangle; a divider of a parent plane beside a group card resizes the group card, and the child plane keeps its proportions. The rail outlines the focused content card and its overridden window sidebar as today ([override context and rail border](external-sidebars.md#override-context-and-rail-border)). Both workbenches draw the group card, its header and its child plane with the card chrome and the native screens in the same draw and transaction, as the acceptance criteria of [native surfaces](native-surfaces.md#acceptance-criteria) require. A layout preview of the library draws a group card as a card that holds the diagram of its child plane.

## Exposure

The declarations of `packages/workbench/exposure.json`; a description of this table replaces the description of the existing entry of the same name:

| Kind | Name | Description |
| --- | --- | --- |
| command | `core.group.create` | Turns a card into a group card that holds the card and a new content card toward side. |
| command | `core.group.dissolve` | Replaces a group card with the cards of its child plane inside its span. |
| command | `core.group.rename` | Renames a group card. |
| command | `core.group.leader` | Makes a card the leader of its plane. |
| command | `core.group.menu` | Opens or closes the close menu of a group header. |
| command | `core.card.move` | Moves a content card or a group card beside a card of any plane, or into a group, as a drop does. |
| status | `core.layout` | The stored form of the current space layout with the level of each group record, or null. |
| status | `core.grid` | The current grid as today, with the cards of the child planes, each with its plane, and each group card with its group record. |
| command | `core.card.get` | Reads the state of one content card of any plane with its group path, or one group card. |
| element | `core.group` | The group cards in workbench order. |
| element | `core.group.header` | The headers of the group cards in workbench order. |
| element | `core.group.name` | The names in the group headers in workbench order; a double-click renames. |
| element | `core.group.add` | The add buttons of the group headers in workbench order. |
| element | `core.group.split-x` | The vertical split buttons of the group headers in workbench order. |
| element | `core.group.split-y` | The horizontal split buttons of the group headers in workbench order. |
| element | `core.group.wrap` | The group buttons of the group headers in workbench order, shown while the group card can hold a group of itself and a new card toward its longer axis. |
| element | `core.group.close` | The close buttons of the group headers in workbench order; each opens the close menu of its group. |
| element | `core.card.group` | The group buttons of the content card headers in workbench order, shown while the card can hold a group of itself and a new card toward its longer axis. |
| element | `core.card.leader` | The leader buttons of the card and group headers of planes of two or more cards in workbench order; pressed on the leader. |

`core.rename.begin` declares the kind `group` beside `project` and `space`, and `core.card.menu` the menu `group`. Every element is bound through `createBinder`, and `core.workbench.audit` lists none of them as unbound.

## Decisions

- The card and tab structure, their commands, statuses, elements and stored form, and the layout library stay unchanged; a group card is the one addition. The smallest size of a group card is therefore checked by the workbench on a copy of the plane, as the drop preview checks a drop, and not by an option of the library.
- A group card is drawn as a card of the existing design. The only new visuals are the icon of the group button and the leader mark, which is a pressed header button; the level is reported and not drawn.
- A group always holds at least two cards. `core.group.create` turns a card into a group card of that card and a new card toward a side, so a group is made with its second card in one command; when one card remains, it replaces the group card. The group button takes the longer axis of its card, the axis with the room for two cards.
- The group card takes a new identifier, and the card that becomes a group keeps its identifier and its tabs, because every stored reference, tab session and command that names that card keeps naming it. The group card takes the slot, the px sizes and the leader mark of the card in the parent plane, because it stands where the card stood.
- The leader of the root plane is stored as `leader` beside `state`, and the leader of a child plane in its group record, so a plane is exactly the state of the layout library and every reader of a plane reads it unchanged. The level is derived from the depth of the record and not stored, so no stored value can contradict the tree.
- `projects.json` takes the format 2: `leader` is state that `core.group.leader` changes, a format-1 file has none, and the stored-format rule requires a new format number and no migration. The release states the files that the person creates again.
- Card identifiers stay `card-<n>` of the existing form, issued by the workbench for every plane from `lastCard`, which the layout stores, so the identifiers of the planes never collide and no identifier is issued twice, also across a restart. A random identifier was rejected, because it would change the form of the identifiers of content cards; a number derived from the stored identifiers was rejected, because after the cards with the largest numbers end it issues an ended identifier again.
- `cardSplit` `even` balances only the plane of the split, because the person splits inside one box and the boxes around it keep their sizes; `exact` stays the default, the behavior of R4.
- A drop resolves from the root plane inward with the existing `zoneAt` and its edge share, so the outer quarter of a group body is a side of the group card and the rest belongs to its plane; no zone of a new kind is added.
- A group card takes no focus ring, because the ring holds the keyboard for a surface and a group card has none; a focus of a group card goes to its first content card.

The review answered these objections:

- A `create` of the leader would leave its plane with a leader that is not a card of the plane: the group card takes the leader mark of the card.
- A root plane that keeps only window sidebars after a close has no card that can lead: its `leader` is `null` until a card enters it.
- Card identifiers of separate library instances would collide, and a reused identifier, within a run or after a restart, would make a repeated dissolve dissolve another group: the workbench issues the identifiers of every plane from the stored `lastCard`.
- Every operation of a plane would be refused while a window resize leaves a group below its smallest size: only an operation that changes the size of a group card is checked, and the drop preview and the release use the same check.
- `core.card.move` to the position that a card already holds would close and insert it again and change px sizes: it returns the result without a call of the layout.
- The line mapping of a dissolve needs an equality: coordinates are equal as numbers, without a tolerance, as R1 requires, and the px sizes of the group card are not carried.
- A move beside the group that the moved card leaves would lose its target when the group is replaced: the target is resolved before the replacement and the card lands beside the card that replaces the group.
- `core.card.get` would redefine the card state with a `leader` member: the card state stays and only `groups` is added; the leader is reported in `core.layout` and `core.grid`.
- The refusal size of `create` was undefined: `mw`×`mh` is stated for each side.
- The word group already names picker groups and snapshot groups: group alone names the group card only in the names and members that this specification lists, and the kit term list receives the new terms.
- A move into the `centre` of the group that the moved card leaves had no defined result: the card enters the child plane first, so the group keeps two cards.
- The refusals of a stored group could be read as refusals of the whole file: they are refusals of the space, and only the format refusal refuses the file.
- The format bump loses the registry and the project data of the plugins: the release states it, and moving the layouts to another file was rejected, because that changes the form of `projects.json` too and gives the same loss.
