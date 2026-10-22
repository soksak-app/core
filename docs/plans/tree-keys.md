# Arrow keys between declared tree nodes

[한국어](tree-keys.ko.md)

This proposal decides F238-d-22: whether arrow-key navigation between the rows of a declared tree becomes declared behavior. The accepted content moves into [declared UI](../spec/declared-ui.md) and [exposure](../spec/exposure.md), and this proposal is then removed.

## Scope

The review decides four things:

1. Whether the workbench moves keyboard focus between the visible tree nodes of a declared tree with the arrow keys.
2. The key map.
3. How each key reaches a declared command, as AGENTS.md requires of every shortcut.
4. The test that shows it.

A core objection shows that the decision contradicts a specification or AGENTS.md rule, cannot be implemented, or leaves a case that two implementations would resolve differently. Out of scope: wording, roles and attributes for assistive technology (the accessibility claim waits for F212.12), lists, and plugin views.

## Problem

A module section drew its own tree and could handle keys. A declared tree has no key handler except Enter on a node with `open` (`declared-ui.md`, Binding). So a person who moved through a tree with the arrow keys before the move to declared UI can no longer do it (decision D9.9 of `decision-review-F238-d.md` records the cost). Keyboard navigation of a tree is common functionality, so it belongs to core, not to each plugin.

## Decision

1. The workbench handles the arrow keys on the focused control of a declared tree node: the label button or the expand control of a node.
2. Key map, over the visible tree nodes in drawing order:
   - Down moves focus to the focus target of the next visible tree node that has one; Up moves it to the previous one. At the last or the first such node, focus stays.
   - Right on a collapsed branch runs `core.declared-ui.tree.expand` with `expanded: true`; on an expanded branch it moves focus to the focus target of the first child node that has one, and when no child node has one, focus stays; on a leaf it does nothing.
   - Left on an expanded branch runs `core.declared-ui.tree.expand` with `expanded: false`; on a collapsed branch or a leaf it moves focus to the parent node; on a root node it does nothing.
   - Home and End move focus to the first and the last visible tree node that has a focus target.
   - A key with a modifier (Shift, Control, Alt, Meta) is not handled.
3. Each handled key runs a declared command, as AGENTS.md requires of every shortcut. A focus move runs `core.declared-ui.tree.move {status, tree, path, key}`, declared in `packages/workbench/exposure.json`; its handler moves focus. Right on a collapsed branch and Left on an expanded branch run `core.declared-ui.tree.expand`; every other handled key runs `core.declared-ui.tree.move`. Each key-and-command pair is a row of `packages/workbench/shortcuts.json` with owner `workbench`; ArrowRight and ArrowLeft each have two rows whose When column names the branch state ("a collapsed branch has focus", "an expanded branch has focus"), so `scripts/test/shortcut-table.test.mjs` covers the key comparisons (`exposure.md`, shortcut table).
   - The focus target of a tree node is its label control when that control exists and is enabled; otherwise it is the expand control of a branch. A tree node with no focus target is skipped by Down, Up, Home and End and is not a target of Left.
4. A handled key calls `preventDefault`, so the sidebar does not scroll by the key; an unhandled key keeps its default.
5. Focus survives a redraw because a redraw keeps the element of each control whose address stays (`declared-ui.md`, Binding). When an accepted value removes the focused control, focus moves to the focus target of the nearest preceding tree node that has one, or else to the first tree node that has one. When a rejection or a change of source removes it, focus moves to the document body.
6. Specification changes, English and Korean: `declared-ui.md` line 136 ("No other declared UI element has a key handler.") becomes "Declared tree nodes also handle the ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home and End keys without a modifier, as the Tree keys section of this document specifies. No other declared UI element has a key handler.", with a new Tree keys section holding items 1 to 5; `exposure.md` line 56 gains "A declared UI tree node handles the keys that the Tree keys section of declared UI specifies."

## Test

Workbench unit tests over a drawn tree with a fake binder and fake source: each key of the map on a collapsed branch, an expanded branch, a leaf, the first and the last row, a modifier key, and a redraw that removes the focused row. Each test asserts the active element by control address and the expand requests sent to the source. The Red is the unchanged workbench, where no arrow key moves focus.

## Review record

- Round 1, auditor A: the key-handler sentences of `declared-ui.md` and `exposure.md` that the decision reverses, focus moves without a declared command and without shortcut-table rows, rows with no label control or a disabled one, and focus after a rejection or a source change. All accepted and merged above.
- Round 2, auditor B: which command Right and Left run in each branch state, one shortcut row per key-and-command pair, the Right target when the first child has no focus target or no child is sent, and "tree row" as a second name for "tree node". All accepted and merged above.
- Round 3, auditor C: Down, Up, Home and End against the focus-target rule, and "row" for tree nodes: accepted and merged above; "focus target" is added to `packages/plugin-api/terms.json` by the implementation. The exact `shortcuts.json` rows and their table rows in `exposure.md` (+ko), the Korean sentences of item 6 and its Korean heading, and the `event.key === "<Name>"` comparison that the shortcut table test reads are details that the implementation item writes and its tests settle, so the review closes after round 3 with no core objection open.
