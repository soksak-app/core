# Parties

[한국어](parties.ko.md)

A party groups two or more content cards that touch into one outline, marks one card as its leader, and carries its colors. This specification owns the party rules, the party commands and their replies, the party and card queries, the party state, the party storage in `projects.json`, and the card menu. Touching uses the rail criterion of [external sidebars](external-sidebars.md#override-context-and-rail-border). Storage follows the card and space layout of [projects](projects.md#persistence). Drawing follows the native frame rule of [native surfaces](native-surfaces.md#acceptance-criteria). Every command and status is declared and exposed under [exposure](exposure.md). The command line and the agent skill use the rules in [command line](cli.md#acting-on-a-layout).

## Rules

- A party is two or more content cards that touch. Two cards touch when their sides meet across the declared gap, the criterion that the rail uses ([rail](external-sidebars.md#override-context-and-rail-border)). The cards of one party form one connected group. A card set that is not connected is refused.
- A space may hold any number of parties. Their outlines never overlap, because a card belongs to at most one party.
- Fixed window sidebars are not allowed in a party and are refused.
- The leader of a party is one card of the party, or none.
- A party has a border color, a leader border color and a leader mark. The leader border color is a `#rrggbb` value. The leader mark is the element `core.party.leader` in the header of the leader card.
- Each theme declares six party colors, the theme tokens `party-1` to `party-6`, and one leader color, the theme token `party-leader`. Each of these colors differs from the rail color of its theme.
- The party border width equals `theme-rail-w`. The stroke lies on whole device pixels, because the outline is inset by half the border width, as the rail is ([drawing](#drawing)).

## Identity and values

- A card is identified by its layout identifier, the `id` of the card in the layout of its space ([layout cases](cases/layout/grid.json)).
- A party is identified by `p<n>`, where `<n>` is the smallest positive integer that no party of the same space holds when the party is created. The identifier does not change while the party exists.
- A party color is always a `#rrggbb` value. A new party takes the first of `party-1` to `party-6`, in that order, that no other party of its space uses; when all six are used, it takes the first of them. The value it takes is stored on the party, so reloading keeps it. A color that the person chose is used as chosen, with no normalization.
- A leader color is a `#rrggbb` value that the person chose, or `null`, which follows `party-leader` of the theme.
- A card list has no duplicate. A card listed twice in one command is refused.

## Commands

All commands are idempotent: the same request in the same state gives the same reply and changes nothing a second time. A refused command changes nothing. Each command runs the same way from the command line, from the MCP tools and from the screen.

| Command | Input | Reply | Notes |
| --- | --- | --- | --- |
| `core.party.create` | `{cards, color?, leader?, leaderColor?, take?}` | `{party, taken, changed}` | Creates a party from `cards`. A card of another party is refused unless `take` is true. When `cards` is exactly the card set of an existing party, it returns that party with `changed: []`. |
| `core.party.update` | `{party, color?, leader?, leaderColor?}` | `{party, changed}` | `leader: null` removes the leader. `leaderColor: null` makes the leader color follow `party-leader`. |
| `core.party.add` | `{party, card, take?}` | `{party, taken, changed}` | Adds a card that touches the party. A card already in the party changes nothing and returns `changed: []`. A card of another party is refused unless `take` is true. |
| `core.party.remove` | `{party, card}` | `{party, changed}` | Removes the card and applies the split rule of the change rules to the rest. |
| `core.party.delete` | `{party}` | `{party, changed}` | Deletes the party and keeps its cards in the layout. |
| `core.party.get` | `{party}` | the party query of [queries](#queries) | Reads one party. |
| `core.card.get` | `{card}` | the card query of [queries](#queries) | Reads one card, whether or not a party holds it. |

`taken` lists `{card, from}` for each card that changed party, where `from` is the former party identifier or `null`. A card that is already in the target party is not listed. `changed` lists `{party, removed, leader, deleted}` for each party that changed, including a party that `create` or `add` made: `removed` lists the cards that left that party, `leader` is its leader after the change or `null`, and `deleted` is true when the party no longer exists.
When the party is deleted, `removed` lists every card of the party before the change, including the card that a split or a take kept.

`core.party.delete` replies with `party` as `{id}`, the identifier of the deleted party only.

Refusals and their texts. The wording of each text is decided in [open decisions](#open-decisions).

| Condition | Text |
| --- | --- |
| A card is not in the layout | `unknown card <id>` |
| A card is a window sidebar | `card <id> is a window sidebar` |
| A card is listed twice | `card <id> is listed more than once` |
| Fewer than 2 cards | `a party needs at least 2 cards` |
| The cards of `create`, or the card of `add` or `take`, do not form one connected group with the party | `cards are not touching: <ids>` |
| A card belongs to another party and `take` is not true | `card <id> belongs to party <party>` |
| A card of `remove` is not in the party | `card <id> is not in party <party>` |
| `leader` is not in the party | `leader <id> is not in the party` |
| A `color` is not `#rrggbb`, or a `leaderColor` is neither `#rrggbb` nor `null` | `color must be #rrggbb`, or `leaderColor must be #rrggbb or null` |
| A party identifier is unknown | `unknown party <id>` |

The checks run in the order of the table. The first failing check gives the error, so one request has one error.

The `<ids>` of `cards are not touching: <ids>` are the cards of the request that touch no member of the party, in request order, separated by `, `. For `create`, which has no party yet, the group of the first card of the request is the party: the listed cards are the cards of the request outside that group. For `add` and `take`, the party is the party named in the request, so the listed card is the card of the request.

## Take

`take: true` moves a card from its former party into the target party in one command.

- Touching is judged against the target party after the move. A card that does not touch the target is refused with the touching refusal of the table, and nothing changes.
- The former party loses the card. When the card was its leader, the former party has no leader and keeps its color.
- When the remaining cards of the former party do not form one group, the split rule of the change rules applies.
- When the former party keeps fewer than 2 cards, it is deleted.
- The move, the new party and the cleanup of the former parties are stored and drawn in one layout change. No state with a half-applied move is stored or drawn.

## Changes of the layout

A layout change is a close, a move, a split, or a resize that changes which cards touch. Each affected party is corrected in the same change:

- A closed card leaves its party.
- A card that is moved or split away from its party, or whose move breaks the group, leaves the party. The remaining cards are divided into connected parts. The part that holds the leader stays with the leader. Without a leader, the part with the most cards stays. Only when the parts have equal numbers of cards does the part whose first card comes first in the space order stay. The space order is the order in which the space stores its cards ([persistence](projects.md#persistence)).
- A party that keeps fewer than 2 cards is deleted, and its cards stay in the layout.
- Each change records one reason in `reason` of the party state: `created` for a party made by `core.party.create`, `closed`, `moved`, `split-leader`, `split-most-cards`, `too-few`, `taken`, `removed`, `leader-removed` or `updated`.

## Drawing

- The whole party is drawn as one outer outline, built by `outline` of `packages/soksak` from the presented rectangles of its cards. Adjacent cards join at half the gap, and the outline is inset by half the border width.
- A layout case that states `drawing` (`docs/spec/cases/layout/parties.json`) gives its plane the size of its grid in points: the width is `unit` times the largest line value of the x axis, and the height is `unit` times the largest line value of the y axis. The grid divides the plane by the layout rules, so a line lies at `unit` times its value only when the grid divides the plane into equal parts. The outline of the case is in points.
- The leader card's border segments on the outline are drawn in the leader color, and the leader mark is drawn in its header.
- When a party outline overlaps the rail, the rail is outside and the party outline is inside, separated by the rail width. The two lines never coincide. The focus indication is independent of the party outline.
- Element names. The outer outline of party `<id>` is the SVG element `path[data-party="<id>"]`. Its leader border segments are the element `path[data-party-leader="<id>"]`, whose `stroke` is the leader color. The rail outline is the element `#railPath` of the workbench document. A test that checks the rule above compares the `d` value of `#railPath` with the `d` value of the party outline.
- The mygo host paints the same outline and leader sides on the painter of the stage, under the rail, from the outline that the layout model computes for the status `core.parties`; its element names are those of the page workbench only. A full screen card shows no party outline, as it shows no rail.
- The party outline is drawn with the card chrome and the native screens in the same draw and the same transaction, as the acceptance criteria of [native surfaces](native-surfaces.md#acceptance-criteria) require for the rail.

## Queries

Three queries return the member state of cards. They share one card state shape and one code path:

- The card state is `{card, party, leader, activeTab, tabs}`. `party` is the holding party identifier or `null`, `leader` is `true` or `false`, and `tabs` lists `{tab, plugin, status}` in tab order. `status` is an object of the status values of that tab: the statuses that the plugin declares with `summary: true` ([exposure](exposure.md#entry-fields)), or every status of the tab with `--full`. A tab whose plugin declares no summary has `status: {}`. A terminal tab's summary equals the value of its status, because core copies that value.
- `core.party.get {party}` returns `{id, cards, leader, color, leaderColor, outline, reason, members}`, where `members` is the card state of each card, the leader first and the other cards in space order.
- `core.card.get {card}` returns the card state. It answers for a card with no party, with `party: null`.
- `core.parties` is the status whose value is the list of the party records of `core.party.get`, one per party. Each party record holds `id`, `cards`, `leader`, `color`, `leaderColor`, `outline` and `reason`. `outline` is a list of closed loops, each a list of `[x, y]` points in window points; outer loops are clockwise and holes counterclockwise.
- `core.parties` changes only when the composition of parties changes: a grouping, a removal, a leader or a color. The work state of a member card is not part of that change. It is watched through the status of the tab itself, `sok status <name> --surface <tab> --watch`, as [command line](cli.md#commands) specifies, so a terminal that starts work does not change `core.parties`.
- `sok status core.parties` and the MCP tool `status_get` return the whole list.

## Host calls

- A command that changes the parties of a space writes that space once, in the layout write of [persistence](projects.md#persistence), and replies after the change is drawn ([drawing](#drawing)).
- When the value of `core.parties` changes while a watch of it is held, the page sends the call `exposureChanged` with `{name, value}` ([exposure](exposure.md)) with the new list of party records, once for each such change, before the reply of the command that caused it.
- A refused command writes nothing and sends neither `exposureChanged` nor a layout write.
- A change of the work state of a card sends no `exposureChanged` for `core.parties`.
- A save of a project sends the call `workspace` with `{kind: "patch", id, patch}` (`packages/workbench/host-store.js:44`), where `patch` is `{spaces, activeSpaceId, named}` (`packages/workbench/projects.js:438`, sent at `projects.js:443`). `spaces` is the array of the project's space objects as the page holds them, and the `parties` member of each space object is part of that array. The Go and Rust hosts store `spaces` as they receive it (`packages/host/go/src/workspace.go:541`, `packages/host/rust/src/workspace.rs:549`).

## Describe

`sok describe` and `window_describe` begin with the list of the window's parties, the same party records as `core.parties`. Each card of the layout carries the card state fields `party` and `leader`, and each tab carries its `status` as in the card state. The description holds the summary of each tab; `--full` gives every status value of each tab ([window description](cli.md#window-description)).

A surface description, `window_describe {surface}`, reads the surface group of the snapshot only, so it holds no `parties` member and no card state fields.

## Storage

- A space object of `projects.json` holds the member `parties`, an array of `{id, cards, leader, color, leaderColor}`. `leader` is a card identifier or `null`; `color` is a `#rrggbb` value; `leaderColor` is a `#rrggbb` value or `null` for the theme token.
- The storage holds no reason and no outline; both are derived.
- A space object without `parties` reads as `parties: []`, the declared empty-record default of an absent optional field ([persistence](projects.md#persistence)). Saving a space always writes `parties`, as `[]` when the space has no party. An explicit `null` for `parties`, or a value of another form, fails with an error that names the file `projects.json`, the project root, the space identifier and what it found, and the file is not changed.
- The reader also refuses a party that breaks a rule: fewer than 2 cards, a card in two parties, a card missing from the space layout, a leader outside the cards, or an invalid color.
- The `rail` and `railWidth` keys refused by [settings](settings.md#values) keep their refusal.
- Entry points of the storage rules, in `packages/workbench/projects.js`. `readStoredSpace(project, space)` returns the space with its `parties` array, which is `[]` when the member is absent, and throws an `Error` for a `null` or non-array value, or for a party record that breaks a rule above. Its text is `projects.json: project <root>, space <space id>: parties <found JSON text>`, where the found value is shown as JSON text. `writeStoredSpace(space)` returns the space object to store, which always holds the member `parties`, an array.

## Card menu

The menu of a content card holds these items. Each item is an element with the name given and runs the command given.

| Element | Command | Shown when |
| --- | --- | --- |
| `core.party.menu.group` | opens the group chooser of the card; its confirm item runs `core.party.create` with the card and the selected touching cards | the card is in no party and has a touching card in no party |
| `core.party.menu.leader` | `core.party.update` with `leader` set to the card, or `null` to remove the leader | the card is in a party |
| `core.party.menu.color` | `core.party.update` with `color` set to one of the six theme tokens `party-1` to `party-6`; the person chooses the party color from these six | the card is in a party |
| `core.party.menu.take` | `core.party.add` with the card and `take: true` | the card touches a party that another party holds it in |

The group chooser is a picker layer that lists the touching cards that are in no party. A press on a listed card selects it, or clears it when it is selected, and the layer reopens with the selection marked. Once a card is selected, the layer lists the confirm item, which runs `core.party.create` with the card and the selected cards and closes the layer. A card press never creates a party by itself.

The take item names the party it joins. When the take removes the former party, because it keeps fewer than 2 cards, the item states it. The menu asks no confirmation: a party change never deletes card content.

## Open decisions

- The six party colors `party-1` to `party-6` and the leader color `party-leader` of each theme. A person sees these colors.
  Decided: each theme declares these seven tokens in its palette, and each differs from the `rail` entry of that palette. The midnight dark palette declares `party-1` `#a06ce0`, `party-2` `#e06cac`, `party-3` `#e0a06c`, `party-4` `#ace06c`, `party-5` `#6ce0a0`, `party-6` `#6cace0` and `party-leader` `#e0da6c`, with `rail` `#7279ff`. The palette declarations are in `packages/workbench-mygo/src/workbench.json`.
- The labels of the menu items and the wording of the take item, including the note for a former party that disappears. A person reads these labels.
  Decided: the menu labels are Korean. Group: `카드 묶기`; its chooser asks `묶을 카드 고르기`; its confirm item reads `카드 N개 묶기`. Leader: `대표 카드로 지정` or `대표 카드 해제`. Color: `색 1` to `색 6`. Take: `파티 p1에 합치기`, with `, 파티 p2가 사라짐` appended when the former party p2 is deleted.
- The refusal texts of the table in [Commands](#commands) and the storage refusal text. A person reads these messages.
  Decided: keep the refusal texts of the table as written. They follow the wording of the existing command errors, such as `unknown card <id>` and `no menu is open`: lowercase English, no final period, the subject and the identifier first. The storage refusal text is `projects.json: project <root>, space <space id>: parties <found JSON text>`.

