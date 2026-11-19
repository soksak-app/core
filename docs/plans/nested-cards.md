# Nested cards

[한국어](nested-cards.ko.md)

This proposal replaces parties (F908) with nested cards in release 0.0.45. It is removed after its approved content is in the specification.

## Model

- A group card is a card of a plane whose body is a plane of its own. A plane is one grid of the layout library `packages/soksak` (`xs`, `ys`, `cards`, `paidBy`); the library stays a library of one plane, and the workbench holds the tree of planes.
- The space has one root plane. A card of a plane is either a content card, which holds tabs, or a group card, which holds a child plane. Each tab of a content card is independent of the other cards, as today.
- The card and tab structure stays as it is; the group card is the only addition. Its header follows the existing card header design and holds its name, the leader mark and its buttons; its level (the depth of its plane, the root plane being level 0) is reported in status. Its body is its child plane, inset by the corridor of that plane. The mockup that introduced the idea is not a design to copy.
- A group holds at least two cards. Creating a group from a card turns that card into a group card that holds two cards: the card with its tabs and a new card, split toward a side. When a close or a move leaves one card in a group, that card replaces the group card in the parent plane.
- A group card may be split into its own plane as long as the child plane can give every card `minSize` on both axes below the group header; a split, a move or a resize that would break this is refused, as the layout refuses it today for one plane.
- Each plane has exactly one leader: one card of that plane, a content card or a group card. A new plane takes its first card as its leader; `core.group.leader` moves the mark to another card of the same plane, and closing the leader passes the mark to the first remaining card. A group card can be the leader of its parent plane while one card of its own plane is the leader of that plane, independently. The leader is a mark only: the header of the leader card shows it, the group header names the leader of its plane, and `core.layout` reports it.
- The buttons of a header act on the box of that header. In the header of a content card, `+` adds a tab and the two split buttons put a new card beside the card in the same plane. In the header of a group card, `+` adds a content card inside the group and the two split buttons split the group card in its parent plane. A split never creates a group. The group button turns the card into a group of two cards; it is shown only when the card can hold the group header and give its cards `minSize`. Dissolving a group is in the close menu of the group header.
- A card keeps its identifier when it moves between planes. Every command that names a card (`core.layout.open`, `core.layout.select`, `core.layout.close`, `core.card.get`) works for a card in any plane.

- The setting `cardSplit` decides the sizes after a split: `exact` (the default) divides only the rect of the card that is split; `even` rearranges the cards of that plane to fair sizes with `balance()`. It applies to the split buttons, the inner split of the group button and `core.layout.open` with `side`.

## Commands and statuses

- `core.group.create {card, side}` turns the card into a group card whose plane holds the card and a new content card toward `side`. The group button uses the longer axis of the card: `right` when it is wider than tall, else `bottom`.
- `core.group.dissolve {group}` replaces the group card with the cards of its plane: the lines of the child plane are inserted into the parent plane inside the span of the group card. It is refused when the parent plane cannot give each card `minSize`.
- `core.group.rename {group, name}`, `core.group.leader {card}` (the card becomes the leader of its plane).
- The status `core.layout` reports the tree: a group card carries `group: {name, level, leader, plane}`. `core.card.get` reports the group path of a card. `sok describe` shows the tree.
- Moving a card by drag or by command lands in the plane under the drop point; a drop zone exists in every plane.

## Drawing

- Each plane draws its corridor with the background of its level: the theme tokens `group-1` to `group-n` with the setting `group.tint` (opacity 0 to 100 percent). At corridor 0 a group is told apart by its header and its tint.
- Each content card surface receives the token `--card`, the card background mixed with the tint of its plane, through the per-surface theme channel (F926-5 `setTheme {scheme, tokens, surfaces}`). Plugins paint `--card` and no background of their own.
- The rail outlines the focused content card as today. The leader border uses the theme token `group-leader`.

## Removal of parties

- Parties were never released (absent from v0.0.44). Remove `docs/spec/parties.md`, the `core.party.*` commands, the status `core.parties`, the theme tokens `party-*`, `packages/workbench/parties.js`, the mygo `layout/parties*.go` and `shell_parties.go`, the party tests, `e2e/parties.test.mjs`, and the `parties` member of the space layout. A reader that finds `parties` in `projects.json` refuses it and names the file.
- Carried over from the party work: the per-surface theme channel (F926-5) and the corridor tint per level with its opacity setting.

## Order

1. Specification (layout, projects, settings, exposure, plugins, terms) with an adversarial review.
2. Removal of parties, one unit per host.
3. mygo: tree of planes, group header, commands, statuses, storage, drawing. Shown to the person in the debug application.
4. Page workbench (Wails and Tauri) with the same contract cases, then the host parts.
5. One window check per host, then release 0.0.45.
