# Horizontal tree and tree detail

[한국어](horizontal-tree.ko.md)

This proposal decides F230: what a declared `tree` shows in a horizontal sidebar section, and whether a tree node gets a `detail` field. It records the evidence, the alternatives, and the adversarial review. Its accepted content goes into [declared UI](../spec/declared-ui.md) and [plugin processes](../spec/plugin-processes.md). Remove this document when F230 is complete.

## Problem

The validator rejects a `tree` in a horizontal section with `tree cannot be drawn in a horizontal section` ([declared UI](../spec/declared-ui.md#sidebar-section-form), rejection table). A plugin whose tree section has a horizontal layout therefore has no form for that section: the same value is accepted in a vertical section and rejected in a horizontal one. A card sidebar's orientation follows its card side (`packages/workbench/plane.js:1021`: top and bottom are horizontal); a window sidebar is always vertical (`plane.js:249`). So a card moved from a side to the top or bottom turns a valid tree into a rejection, and the plugin cannot choose the orientation.

The evidence in the code:

- `packages/workbench/declared-ui.js` rejects a tree whose context orientation is `horizontal` (`treeHorizontal` row). No other element is orientation-dependent.
- `packages/workbench/app.css:642` lays a declared body in one wrapping row for a horizontal set (`flex-direction:row;flex-wrap:wrap`). No rule sets the width of a root box (`.declared-tree`, `.declared-list`, `.declared-row` have none), so a root box is a flex item sized to its content.
- A horizontal `list` body is bounded by `min-height:0; overflow:auto` in the list layout (`app.css:665`). In the other layouts the set scrolls (`app.css:607`, `.set{overflow:auto}`).
- A list item already has `detail` (plain text, at most 500 code points, drawn after the label). A tree node has no per-row text field other than `label`.
- Each tree level adds one indent step (`.declared-children{padding-left:1em}`, `app.css:634`); a branch row also has its expand control (`.declared-expand` width 1em, `app.css:635`) and a gap of .25em (`.declared-row`, `app.css:633`). The section body has 14 px padding on each side (`app.css:650`). At 12 px text, a branch at depth d has W − 28 − 15 − 12(d−1) px for its label, where W is the section width. With W = 120 this reaches zero at depth 8; with W = 96 at depth 6. The sidebar minimum is in pt (`packages/workbench/settings.js:194`) and the card minimum in px (`packages/soksak/src/soksak.ts:266`); the comparison assumes 1 pt = 1 px, which is not verified here. Level 16 has 15 indent steps (180 px).

## Decision 1: a tree takes a full line in a horizontal section, and scrolls inside its box

A `tree` in a horizontal section is accepted and drawn. It takes one full line of the section width, and the other root elements of the section wrap onto the lines around it. Its outline is the same as in a vertical section: indented children, the expand control of each branch, the kept expanded state, and the `empty` text.

Two rules make this work:

```css
.set[data-orientation=horizontal] .set__body[data-declared] > .declared-tree{flex:1 1 100%;min-width:0}
.declared-tree{overflow-x:auto}
```

The first rule gives a tree its line. The second rule applies to a tree in every orientation: when the tree's content is wider than its box, the tree scrolls horizontally inside its own box, so no label is cut and no text leaves the tree box. In a vertical section the box is the section width, so the rule changes nothing unless the content is wider than the section, where it replaces an overflow that today runs past the section into the set scroll.

Reason for the full line, from the code: a tree's width is set by its deepest visible row, which includes the indent of each level. Expanding or collapsing a branch changes the visible depth, so it changes the tree's width. In a row flow at content width, that change reflows the sibling elements beside the tree. A full line confines the change to the tree itself. A `list` has no expand control, so its width does not change with a user action in this way, and it keeps its content width. This reason is code-based; the reflow is a consequence of the CSS, and it is not a measured result.

Reason for the scroll rule: the indent takes width from the label at each level, so at narrow widths a deep label has little or no room (the arithmetic in Problem). The scroll keeps every label readable and reachable inside its own tree box, and does not depend on the section width. It does not remove the indent: the indent stays one step per level, as the outline requires. The narrow-width layout is therefore a scroll, not a clipped label, and the scroll is the tree's own, not the set's.

Reasons (the decision):

1. The decisive reason is the card side. A card sidebar's orientation follows its card side, so a tree rejected in a horizontal section makes a valid value fail when the user moves the card, and the section shows a rejection (the rejection display of [declared UI](../spec/declared-ui.md#rejection)). The contract must not make a valid value depend on the card side.
2. One accepted value gives the plugin one form in every placement. Accepting the tree in both orientations keeps the check of the value independent of the layout.
3. The extent of a tree is bounded by the serialized value size, the root count, and its own limits of 5000 nodes and 16 levels; a list has its own limit of 1000 items. The list height rule of the Problem section (`app.css:665`, list layout) applies to a tree body the same way; the other layouts bound neither. No new limit is needed.
4. Inference, not measured: an indented outline does not fit a left-to-right row of short elements. The code and the spec give no reason for the rejection, so this reason is marked as an inference and is not the basis of the decision.

Alternatives rejected:

- Keep the rejection and tell the plugin to use a `list`. A flattened list has no hierarchy and no expand control, so the plugin would flatten its data and lose the kept expanded state ([status mapping](../spec/declared-ui.md#status-mapping)). The rejection forces that flattening.
- Give every list the full line too. Rejected: a list's width does not change with a user action (no expand control), so the reflow reason does not apply, and a change of list behaviour is not needed for F230.
- Let labels wrap onto several lines at each level (`overflow-wrap:anywhere`). Rejected: at 0 px of room a label wraps one character per line, which is unreadable; the scroll keeps each label on one line.
- Draw only the root nodes as a row of wrapping chips. The children of a branch would have no drawn form, because a chip row has no place for the nested node list (`declared-ui.js`, `paintNode`). This adds a second drawing rule for one orientation.
- Draw the outline without indentation in the row flow. The nesting would be lost, and the wrapped nodes would read as siblings of their parent.

## Decision 2: orientation no longer affects a declared value

Removing the rejection makes the orientation a layout choice only. The consequences follow from the contract itself:

- `packages/workbench/declared-ui.js`: the `treeHorizontal` entry of `ROWS` (line 32), the check in `checkElement` (lines 278 to 280), and the `orientation` option in `validateValue` (line 290) are removed.
- `packages/workbench/declared-section.js`: the `orientation` parameter of `createDeclaredSection` (line 39) and the `orientation` option passed to `receive` (line 51) are removed. `orientationChanged()` (lines 119 to 123) and its entry in the returned object (line 127) are removed. The header comment (lines 26 and 34 to 35) is rewritten to the change rule below.
- `packages/workbench/sidebar-sections.js`: the `orientation` option of `createDeclaredSection` (line 130) is removed. In `apply()` (lines 177 to 187), an orientation change unmounts a module section only: `if (orientationChanged && !entry.declared) unmount(entry);`. A declared section is never unmounted, closed, or pulled by an orientation change, because `unmount` leads to its release and its next `reconcile()` pulls again. The comments at lines 177 to 178 and 216 are rewritten to the same rule. The `orientationChanged` flag in `drawSet` (lines 219, 281 to 284) stays for the module remount. The comment at line 249 stays, because the body still lays its root elements by orientation through the CSS.
- The pull reason "a value discarded for the previous orientation may be valid for the new one" is removed from [declared UI](../spec/declared-ui.md) (line 172, sidebar section form) and from [plugin processes](../spec/plugin-processes.md) rule 2 (line 51). The sentence "A running view has no other way to send its last value to a new reader" stays, because it is the reason of the load and source-change pulls.
- Module sections keep their remount on an orientation change ([plugins](../spec/plugins.md#sections)); that rule concerns the module and stays.

## Decision 3: a tree node has a `detail` field

A tree node accepts an optional `detail`: plain text, at most 500 code points, drawn after the label as a list item's `detail` is drawn. It has no `command` requirement. The label keeps its command binding; `detail` is text only.

Reasons:

1. A tree is an outline of rows. A row attribute such as a per-row state (for example, the state of a listed file) belongs in its own field. A list item already has one; a tree node without one would force a plugin to put the state into the label, which is the name the user selects and reads as an identifier.
2. One concept has one field name in both row kinds, so the vocabulary keeps `detail` for a row's text after its label, as a list item's `detail` is drawn.
3. The field is plain text with the text rules of every other text field. It adds no tone, colour, or error: `status-line` has no tone, and an error reaches the user only through the log display path ([declared UI](../spec/declared-ui.md#element-kinds)).

Alternative rejected: a `tone` or `status` enumeration on a node. The vocabulary defines no tone and no colour, and adding one adds a visual concept that no other element uses.

## Specification changes

Each change is made in the English document and in the Korean translation in the same change.

- [declared UI](../spec/declared-ui.md) (`declared-ui.ko.md`), element table: the `tree` node row `detail` (string, optional, at most 500 code points, drawn after the label). The `tree` row loses "A tree is not drawn in a horizontal section".
- [declared UI](../spec/declared-ui.md) (line 171 in English; line 172 in `declared-ui.ko.md`), sidebar section form: the bullet about a tree in a horizontal section becomes: "A `tree` takes one full line of that width and draws its outline as in vertical orientation, so the row wraps before and after it. A `list` keeps its content width. A tree expands and collapses in place: its width follows its deepest visible row, so it has its own line, and a label wider than the tree scrolls horizontally inside the tree."
- [declared UI](../spec/declared-ui.md) (line 172 in English; line 173 in `declared-ui.ko.md`), sidebar section form: the paragraph "The orientation check runs again when the section changes orientation ..." is removed, together with the reason sentence of the orientation pull.
- [declared UI](../spec/declared-ui.md) (line 151 in English), status mapping: "at a change of orientation" is removed from the pull rule. The Korean line is the matching line of `declared-ui.ko.md`.
- [declared UI](../spec/declared-ui.md) (line 230 in English; line 231 in `declared-ui.ko.md`), rejection table: the row "A `tree` in a horizontal section" is removed.
- [declared UI](../spec/declared-ui.md) (line 85 in English), Limits table: "Text field | 500 code points | Bounds the width of one line of text in a section." becomes "Bounds the length of one text field. It does not bound the drawn width: a tree draws a label wider than its box inside a horizontal scroll of the tree; other text is drawn past the section edge and scrolls with the set."
- [plugin processes](../spec/plugin-processes.md) (line 51 and the pull row at line 124 in English; the matching lines of `plugin-processes.ko.md`), rule 2: the clause "once when the section changes orientation" and the clause "and a value discarded for the previous orientation may be valid for the new one, which only the source holds" are removed; the sentence "A running view has no other way to send its last value to a new reader" stays. The pull row of the messages table reads "load, source change".

## Checklist entries

- F230 (`docs/features.md`, `docs/features.ko.md`): marked `[o]` when this item completes, with its Red and Green results. Its registered retry text ("Retry when: F229 is decided.") is superseded by the instruction to work the item now; the change adds this line under F230 in both files, stating that the F229 condition is superseded by that instruction. F229 is not on this branch.
- No follow-up ID is registered. The narrow-width label cases are handled by Decision 1 (the scroll), so no defect is left open by this item.

## Verification plan

- Red, on the unchanged code (recorded in the test commit): a tree value in a horizontal section is rejected with `tree cannot be drawn in a horizontal section` (labels `[]`, expected `["b", "c", "l"]`); a tree value is rejected in a horizontal context; a tree node `detail` is rejected as `unknown field "detail"`; the horizontal `.declared-tree` `flex-basis` is `auto`, expected `100%`; the section shows the rejection after an orientation change, expected a mounted tree.
- Red for the scroll rule: the computed `overflow-x` of `.declared-tree` is `visible` on the unchanged CSS, expected `auto`, in both orientations. This assertion is added to the CSS test before the CSS change and run to record its Red.
- Green: the same tests pass. The orientation check and orientation pull tests are replaced by tests that the accepted tree is kept and that no pull is made on an orientation change; the in-flight pull test checks the lower-seq rule without the removed method.
- The CSS rules are checked by jsdom computed-style tests (`flex-basis` and `min-width` of `.declared-tree` in a horizontal declared body, and `overflow-x` in both orientations). jsdom does not lay out text, so the label room at depth is not measured here; the rule is a CSS-level decision, and its layout effect is observed in a window check when one is run.
- Owning checks: the workbench declared UI tests (`declared-ui.test.mjs`, `declared-section.test.mjs`, `sidebar-sections.test.mjs`), `make docs-check`, and `make exposure-check` for the unchanged dom names.

## Review record

Scope of the review. The review decides Decisions 1 to 3 and the removal of the orientation check and pull that Decision 2 requires. A core objection is one of these: a decision that leaves a valid declared value without a form in some placement; a decision that adds a second drawing rule or a field that duplicates an existing concept; a removal that leaves a stated rule without its reason; a specification sentence that contradicts the code after the change; a claim the code does not support; an exception to a shared rule without a sound reason; a reachable defect left open by this item. Out of scope: the wording of the Korean translation, and details that the unit tests settle.

### Round 1

Two auditors read the proposal and the code without editing or testing. Each objection and its answer:

- A-O1 (full-line claim has no CSS rule). Accepted. The CSS rule is in Decision 1 and the claim "needs no layout rule" is removed.
- A-O2 (removal list incomplete). Accepted. Decision 2 lists each site by file and line; the module remount is kept by name.
- A-O3 (stale reason in rule 2 and wrong citation). Accepted. The citations are corrected and the reason clause is removed.
- A-O4 (limits claim not supported by the spec). Accepted; the limits are stated per kind.
- B-O1 (CSS rule and its test missing). Accepted; the rule and the computed-style test are in the plan and the Red commit.
- B-O2 (horizontal tree and list follow different rules without a stated reason). Accepted as an exception; the reason was revised in Rounds 2 and 4.
- B-O3 (indent at narrow widths). Accepted; see Rounds 2 to 4 and Decision 1.
- B-O4 (removal list; module remount). Same answer as A-O2.
- B-O5 (Korean lines not named). Accepted; the Korean lines are named.
- B-O6 (the argument against the rejection rests on an unsourced reason). Accepted; the decisive reason is the card-side derivation (`plane.js:1021`); the outline argument is marked as an inference.

### Round 2

- C-O1, D-O2 (the list exception's reason is an inference). Accepted; revised in Round 4 (below).
- C-O2 (wrong citation for the set scroll). Accepted; `app.css:607`.
- C-O3 (orientation claim applies to card sidebars only). Accepted; `plane.js:249` is the window case.
- C-O4 (`orientationChanged` is an entry of the returned object). Accepted; verified.
- C-O5 (Korean line numbers). Accepted; verified at lines 172 and 173.
- D-O1 (narrow-width claim unsupported). Accepted; arithmetic corrected in Round 3.
- D-O3 ("That is the defect F230 names"). Accepted; replaced.
- D-O4 (tabs scroll citation). Accepted; `app.css:607`.

### Round 3

- E-O1, F-O1 (indent arithmetic omitted the body padding, the expand control, and the 15-step count). Accepted; the arithmetic is in Problem.
- F-O2 (list-layout width share). Accepted; the 48 pt case is recorded in the Round 4 answer below.
- E-O2, F-O3 (`detail` reason said "second line"). Accepted; the reason says "text after its label".
- F-O4 (labels "shrink" without a rule). Accepted; the overflow is stated, and Decision 1 now gives the scroll rule.
- E-O3 (F230-1 unregistered, no retry condition). Accepted in form; Round 4 removed F230-1 because the item now resolves the case.
- E-O4 (height rule cited to a section that states none). Accepted; Reason 3 cites `app.css:665`.

### Round 4

Two fresh auditors (G, H) read the Round 3 revision.

- G-O1 and H-1 (the reason for the tree-only full line states a mechanism the code does not support: sharing a line does not shrink an item). Accepted. The mechanism is replaced: a tree's width follows its deepest visible row, so expansion changes it and reflows the siblings in a row flow; a list has no expand control. Verified in the CSS: a wrapping flex line sizes items to content and shrinks only an item that overflows its line.
- G-O2, H-1 (a reachable defect is deferred to F230-1 while F230 is marked complete; the retry condition is a decision, not a condition). Accepted. F230-1 is removed. Decision 1 resolves the narrow-width label case by the tree's own horizontal scroll (`.declared-tree{overflow-x:auto}`), so no label is cut and no text leaves the tree box. The change is in both orientations, because the box is the same element. The indent stays one step per level.
- G-O3, H-2 (the registered retry condition "F229 is decided" is not recorded as superseded). Accepted. The Checklist entries state the superseding instruction, and both features files get that line.
- G-O4, H-4 (citations: expand control at `app.css:635`, gap at `app.css:633`; the list-layout scroll is inside the section body at `app.css:665`). Accepted. Corrected in Problem and Decision 1.
- G-O5 (Limits table sentence "Bounds the width of one line of text in a section" is false). Accepted. The Limits row is rewritten in Specification changes.
- H-5 (96 px and 120 pt units). Accepted; the unit assumption is stated once in Problem.

Round 5: pending, with two fresh auditors on the Round 4 decision.
