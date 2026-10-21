# Screen hash decision

[한국어](screen-hash-decision.ko.md)

This proposal decides F236-9: which parts of the screen hash and its replay contract core keeps, and which parts are the engine rules of the terminal sidecar or the page parser of the terminal plugin that move out of core. It is removed after its approved content is in [replay](../spec/replay.md) and the decision record is in the changelog.

## Scope

Decide four questions.

1. Does core keep the byte definition of the screen hash, the generic screen message format, and the golden vectors that every implementation reproduces?
2. Which parts of the drawn-screen rules (how the cursor, the blank cells and the selection highlight of a drawn screen are computed) are generic, and which are engine behaviour of the terminal sidecar?
3. Where does the page-side parser `screenFromMessage` belong?
4. Which core checks prove decisions 1 to 3, and how is each removal gated on an observable check?

- A *core objection* is a sentence or code in core that (a) names the terminal, a plugin or a sidecar as the owner or producer of a definition, (b) encodes a behaviour that only the terminal sidecar or the terminal page implements, or (c) defines the same thing in two places without a sync check that core can run.
- *Out of scope*: wording that no implementation resolves differently; cases every implementation resolves the same way; details the unit tests settle.

## Facts

Each fact was checked in this worktree. Paths are written from the workspace root: `packages/...` is core, `plugins/...` and `sidecars/...` are the sibling repositories (`../plugins/...`, `../sidecars/...` from the worktree).

- F1. `packages/plugin-api/screen-hash.js`: `screenBytes` has JSDoc at line 41 and its function at line 42; `screenHash` has JSDoc at line 89 and its function at line 90; `screenFromMessage` has JSDoc at lines 104 to 109 and its function at lines 110 to 134. Line 1 says "The hash of a terminal screen". `screenFromMessage` calls `messageRefuse`, `shown`, `isObject`, `resolvedColor` and `screenBytes` (line 133).
- F2. The module reaches every page through the import map: `packages/plugin-api/index.js:55` (`PAGE_IMPORTS`), `packages/workbench/index.html:12`, `packages/workbench/overlay.html:25`, and the export `./screen-hash` of `packages/plugin-api/package.json:15`. The test `packages/plugin-api/test/validate.test.mjs:269` to `:270` asserts the entry.
- F3. Core's `sok` does not compute the hash. `packages/sok/tauriv2/src/replay.rs:100` (`is_screen_hash`) and `packages/sok/wailsv3/src/replay.go:26` (`screenHashText`) accept a stored hash only when it is 64 lowercase hexadecimal characters. The replayed hash comes from the replay executable that the sidecar declares in `sidecar.json` (`docs/spec/replay.md`, "Replay executable"). `sok` compares the two strings.
- F4. The terminal page `plugins/terminal/ui/terminal.js` imports `screenFromMessage` and `screenHash` from `@soksak/plugin-api/screen-hash` (line 2), calls `screenFromMessage` at line 1209 and `screenHash` at line 1218. `plugins/terminal/package.json:26` pins `@soksak/plugin-api` to `#v0.0.11`. No other plugin or sidecar outside core imports the module; this was checked for `plugins/` and `sidecars/vt` by search.
- F5. The sidecar in `sidecars/vt` has a second implementation of the hash and copies of the vectors (`vt-core` sources and its fixtures README, which says "Core owns all three; a change of the contract replaces the copies"). The README also lists copies of `replay-inputs.json` (the copy of `packages/log-contract/fixtures/replay/inputs.json`) and of the policy fixture. Core has no check of those copies.
- F6. `docs/spec/replay.md` sections: "Records" (line 7), "Segments" (24), "Screen hash" (33), "Golden vectors" (56), "View state" (74 to 88), its subsection "Decision" (89 to 98), "Replay executable" (99), "Command" (105). Line 81 states "under one lock for all kinds" and line 84 states that the scrollback limit and the default theme belong to the replay executable. The rules that set hash contents are: the selection highlight is in the cells (line 76), the blank cells that the engine trims depend on the theme (line 80), and the cursor is the viewport cursor with `visible` `false` outside the viewport (line 82).
- F7. `scripts/workspace-registry.json` lists plugins, sidecars and packs. No contract repository is declared.
- F8. The `plugin` layer of [logging](../spec/logging.md) (`docs/spec/logging.md:34`, the layers `native`, `host`, `page`, `plugin`, `sidecar`, `sok`) is a generic logging layer name. The Korean twin states the same in `docs/spec/logging.ko.md:35`.
- F9. `docs/spec/plugins.md:42` states that the version of a plugin or sidecar is its own and has no relation to a core version. The installed terminal plugin therefore does not change when core changes its version. The `#v0.0.11` pin of F4 is a development dependency.
- F10. `scripts/check-test-parity.mjs` names the helper in: `F160.25` (line 2621, `export async function screenHash`), `F160.34` (its `expected` text names "the view-state inputs of a session" and its tests cite the replay input files), and `F160.35` (line 2651, `export function screenFromMessage`, with tests at lines 2655 and 2656).
- F11. Cross-references to anchors that this decision moves, all of which `scripts/check-docs.mjs` checks against headings: `docs/spec/replay.md` lines 20, 22, 26, 66 (`view-state anchor`) and 83; `docs/spec/terminal-runtime.md` lines 117 (`replay.mdview-state anchor`) and 135 (`#screen-message`); `docs/features.md` lines 880 (`replay.mdview-state anchor`) and 885, 886 (`terminal-runtime.md screen-message anchor`), and the same in `docs/features.ko.md`; `docs/plans/decouple-handoff.md` line 73 and its Korean twin; `CHANGELOG.md` lines 538 to 550 and the Korean twin; the comments `packages/plugin-api/test/validate.test.mjs:269` and `packages/plugin-api/test/screen-hash.test.mjs:32`; the citations `packages/sok/wailsv3/tests/replay_test.go:63` and `packages/sok/tauriv2/tests/replay_test.rs:68`.

## Decision

1. **Core keeps the byte definition, the generic screen message format, and all vectors.** `docs/spec/replay.md` keeps "Screen hash", "Golden vectors", and the input-kind table in "Records" (lines 11 to 18). The vector file `packages/log-contract/fixtures/replay/screen-hash.json` keeps all its vectors, including the three that show a drawn screen (`scrolled viewport with the cursor outside it`, `selected cells with the highlight colors`, `the same text under another theme`), because each is a screen in the hash form and core's hash test runs it. The generic member table of the screen message (`event`, `sequence`, `segment`, `rows`, `cols`, `cursor`, `cells`, with the cell members) moves from `terminal-runtime.md` "Screen message" into `replay.md` under a new heading "### Hashed members"; the table names no plugin.
2. **Core keeps `screenBytes` and `screenHash`, and their import entry.** `packages/plugin-api/screen-hash.js` keeps `screenBytes` and `screenHash`, with line 1 changed to "The hash of a screen, a grid of cells with a cursor". The entry `@soksak/plugin-api/screen-hash` in `PAGE_IMPORTS` (F2) stays. The terminal page imports `screenHash` from it (F4), and the installed plugin's version is independent of the core version (F9), so the entry cannot be removed while any installed plugin imports it. Core's tests `packages/log-contract/test/screen-hash.test.mjs` and `replay-vectors-named.test.mjs` run these functions against the vectors in core.
3. **The drawn-screen engine rules move to the sidecar; generic rules stay.** The sentences of "View state" that describe how the terminal engine computes a drawn screen move to the sidecar's specification in `sidecars/vt/docs/spec/`: the selection geometry and its reactions (lines 74 to 80, the selection bullet), the viewport moves and their effect on the offset (the viewport bullet), the theme's effect on trimming and palette (the theme bullet's trimming sentence), the cursor rule that `visible` is `false` outside the viewport (line 82), the lock and the engine's scrollback and default theme (lines 81 and 84), and the subsection "Decision" (89 to 98). `replay.md` keeps one generic sentence under "### Hashed members": the hashed cells and the cursor are the ones the sidecar reports for the drawn screen, and each sidecar states in its own specification how it computes them. Line 97 ("The golden vectors that fix the drawn screen under a scroll, a selection and another theme are ...") stays with "Golden vectors", because the vectors stay.
4. **The page-side parser moves to the terminal plugin.** `screenFromMessage` (`screen-hash.js` lines 104 to 134), the refusal list of `packages/log-contract/fixtures/replay/screen-message.json` and its runner `packages/log-contract/test/screen-message.test.mjs`, and the `screenFromMessage` tests of `packages/plugin-api/test/screen-hash.test.mjs` move to the terminal plugin repository. The plugin's copy imports `screenBytes` (and so the byte definition) from `@soksak/plugin-api/screen-hash`, which its declared dependency already provides; the plugin does not copy `screenBytes`. The paragraph of `terminal-runtime.md` (line 124) that specifies `screenFromMessage` and its refusal list moves to the plugin's specification. Core then keeps no refusal case of the parser.
5. **Sync and gate.** Core's vector test is the reference for the byte definition. The owners that hold vectors run them in their own tests against a copy pinned to a core tag (AGENTS: shared contract cases run in the owning package; core may not read another repository's files). Decision 4's removal is gated as follows: core keeps `screenFromMessage` until its end-to-end window check `e2e/terminal-replay.test.mjs` passes with the terminal plugin's copy installed through the registry (the AGENTS exception for installation-based window checks), and a checklist sub-item in `docs/features.md` names the plugin release tag that holds the copy and the gate. The sub-item is written in the implementation step. Core's record is then a passing check, not a promise.
6. **The replay input validator stays in core until a sidecar check replaces it.** `replayInputProblem` and `replaySessionProblem` (`packages/log-contract/index.js`), `packages/log-contract/fixtures/replay/inputs.json`, the sidecar copy `replay-inputs.json` (F5), and the `sok` copies (`packages/sok/tauriv2/src/replay_inputs.rs`, `packages/sok/wailsv3/src/replay_inputs.go`) hold the terminal engine's bounds (selection against the grid, theme colors). That is a core objection under (b). Removal needs a contract change first: "### Replay executable" in `replay.md` gets a new sentence that the executable refuses every input of `inputs.json` that the validator refuses, with the same error text. The requirement applies to sidecar releases that carry it. Core keeps the validator, and the command keeps `replaySessionProblem` (line 85 of `replay.md`), until an installed sidecar release passes the invalid `inputs.json` cases through its executable in an end-to-end window check. The sidecar's copy and `sok`'s copies are then removed in the same change. The sub-item in `docs/features.md` names the owner (the sidecar repository), the release, and the gate. This decision adds the requirement and the sub-item; it does not remove the validator.
7. **The vocabulary changes.** `packages/plugin-api/terms.json` "replay" (line 151) becomes "Rebuilding the screen of a session from its stored inputs with the replay executable of its sidecar, to compare the stored hashes of the screens (docs/spec/replay.md)". "screen hash" (line 170) becomes "The SHA-256 of the canonical bytes of a screen, a grid of cells with a cursor, as docs/spec/replay.md defines it". `replay.md` line 101 "it holds the terminal engine" becomes "it holds the replay engine of the sidecar".
8. **The application-level divergence test stays in core.** `e2e/terminal-replay.test.mjs` runs the installed plugins through the registry. AGENTS.md line 33 states: "Window checks are end-to-end checks of the application with the plugins its environment installs, not package tests, and this rule does not apply to them." The test's assertions depend on terminal-plugin behaviour (the replay of a terminal session with a scroll, a selection and a theme), which is why its removal is gated in decision 5, not decided here. Its parity entries (F160.25 and F160.35) stay.

## Changes

Documents and moves named above. Until a gate passes, no behaviour changes.

- `docs/spec/replay.md` and `.ko.md`:
  - Lines 11 to 18 (input-kind table) and lines 7 to 10, 24 to 32, 56 to 72 stay. Lines 13 and 14 ("pseudo terminal") stay: they name the device.
  - Line 20 (`defined in [View state] (view-state anchor)`) changes to point at "### Hashed members".
  - Lines 22 and 26 (`[View state] (view-state anchor)`) change to point at "### Hashed members".
  - Line 28 changes "[screen message] (terminal-runtime.md screen-message anchor)" to "the screen message (the Hashed members section of this document)".
  - Line 54 changes "(`@soksak/plugin-api/screen-hash`, the golden vectors)" to "(the golden vectors)".
  - Line 66 changes its link `view-state anchor` to "### Hashed members".
  - Lines 66 to 68 (the rows of the three drawn-screen vectors) stay, because their vectors stay.
  - Lines 74 to 98 change as decision 3 states: "### Hashed members" is added with the generic sentence; lines 74 to 98 except that sentence move to the sidecar specification.
  - Line 83 loses its link to `terminal-runtime.md` and keeps the generic page rule: the page computes the hash of the message with the parser of its plugin and `screenHash`.
  - Line 85 (the command runs `replaySessionProblem` before the executable; an unknown kind is refused) stays.
  - Line 87 (`replayInputProblem`, `replaySessionProblem`) stays.
  - Line 101 changes "it holds the terminal engine" to "it holds the replay engine of the sidecar".
  - Line 103 (the executable's exit rules) stays. Line 103 gains the sentence of decision 6 (the refusal requirement).
  - Lines 105 to 109 (the command) stay.
- `docs/spec/terminal-runtime.md` and `.ko.md`: the table and the sentences of "Screen message" that define the members move to `replay.md` (decision 1). The sentences about the reply of `terminal.screen.read` (line 109) and the cursor shapes (line 117) stay, because they describe the terminal command. Line 117 changes its `replay.mdview-state anchor` link to "### Hashed members". Line 124 (the `screenFromMessage` paragraph) moves to the plugin's specification (decision 4). Line 135 (`[Screen message] (screen-message anchor)`) changes to `replay.md#hashed-members`.
- `docs/features.md`, `docs/features.ko.md` lines 880, 885 and 886 and `docs/plans/decouple-handoff.md`, `.ko.md` line 73: links repointed to the new anchors. The text of each history entry stays.
- `CHANGELOG.md` and `CHANGELOG.ko.md` lines 538 to 550: links repointed; text unchanged.
- `packages/plugin-api/test/validate.test.mjs:269` and `packages/plugin-api/test/screen-hash.test.mjs:32` comments: repointed.
- `packages/sok/wailsv3/tests/replay_test.go:63` and `packages/sok/tauriv2/tests/replay_test.rs:68`: citations repointed to "### Hashed members" or to the sidecar sentence.
- `docs/plans/decouple-handoff.md` and `.ko.md`: this decision's implementation adds two gated entries, (a) the drawn-screen engine rules with their destination `sidecars/vt/docs/spec/`, and (b) the replay input validator with the sidecar gate of decision 6, and one entry (c) for the `screenFromMessage` removal with the gate of decision 5.
- `packages/plugin-api/terms.json` lines 151 and 170: decision 7.
- `packages/plugin-api/screen-hash.js`: line 1 (decision 2). `screenFromMessage` (104 to 134) is removed only when decision 5's gate passes.
- `packages/log-contract/test/replay-doc.test.mjs` (new, core-owned): reads `docs/spec/replay.md` and `packages/plugin-api/terms.json` and checks: the section "### Hashed members" exists; no line of `replay.md` in the "Golden vectors" section names `screenFromMessage`; `terms.json` "screen hash" and "replay" do not name the terminal. Red on the unchanged tree: `replay.md` line 101 contains "terminal engine", and `terms.json` line 151 contains "a terminal session", so the assertion on those two strings fails. Green after the edits passes. The test does not import the helper, so the removal of the parser does not remove it.
- `packages/log-contract/test/screen-message.test.mjs` and `packages/log-contract/fixtures/replay/screen-message.json`: removed from core in the decision 4 change, after the gate; they move to the plugin's repository.
- `scripts/check-test-parity.mjs`: F160.34's `expected` text changes to the input kinds (decision 3). F160.35's entries at 2651, 2655 and 2656 move to the plugin's entries when the parser moves. F160.25 (2621) stays, because `screenHash` stays.
- `docs/features.md` and `docs/features.ko.md` line 2014: F236-9 is closed by this decision; the three sub-items of the handoff are its gated follow-ups.
- `CHANGELOG.md` and `CHANGELOG.ko.md`: the decision, the review rounds, and the answers.

Verification for the documents: `make docs-check` (checks every fragment, so each repoint above is needed), `make parity-check`, and `node --test packages/log-contract/test/*.test.mjs packages/plugin-api/test/*.test.mjs`. Red and Green: `replay-doc.test.mjs` as described. Owner checks for the sok citation edits: `go test ./tests` in `packages/sok/wailsv3` and `cargo test -p soksak-sok-tauriv2 --test replay_test`.

## Residual

The replay input validator (decision 6) and the page parser (decision 4) are terminal behaviour in core until their gates pass. Core keeps them, each with its gate in the handoff and the checklist. This decision does not claim either is removed.

## Review record

### Round 1

Three fresh auditors reviewed the first version. Accepted: the Residual claim was false (the hash contents depend on View state, `replay.md` lines 76, 80, 82); `screenFromMessage` parses the terminal sidecar's message; the helper had one plugin consumer; sync copies exist under every candidate (F5); the Red and Green test is possible; the edit list named missing targets; F236-8 and F236-12 removed text before owners held it; the import specifier, not the file path, must stay. Rebutted: the `plugin` layer name is generic (F8).

### Round 2

Three fresh auditors reviewed the second version (26 objections). Answered in v3: core keeps `screenBytes`, `screenHash` and the vector tests; the Red and Green test moved to a document-only core file; the e2e divergence test has a decision; the copy gate has a checkable form; the validator stays with a gate; the Changes list names every line and anchor; the View-state move target is the sidecar; the screen message stays generic; the handoff entry is added by the implementation step.

### Round 3

Three fresh auditors reviewed v3 (29 objections). Each is answered here.

- R3-H1 (the copy gate was a text claim): accepted. Decision 5 gates the removal on the e2e window check with the copy installed through the registry, and the sub-item names the tag.
- R3-H2, R3-I8 (removing the import entry breaks installed plugins; the entry also supplies `screenHash`): accepted. The import entry and `screenHash` stay (decision 2), because F9 says installed plugins do not follow the core version. Only the parser moves.
- R3-H3 (the copy's function set is undefined): accepted. Decision 4 names the parser, its fixture and runner, and states that the plugin imports `screenBytes` from core.
- R3-H4 (the validator gate is unobservable, no owner or date): accepted. Decision 6 names the owner (the sidecar repository), the gate (an end-to-end run of the invalid cases through the installed executable), and the sub-item.
- R3-H5 (the refusal requirement breaks already shipped sidecars): accepted. Decision 6 applies the requirement to sidecar releases that carry it; core's command keeps the check until the gate passes.
- R3-H6 and R3-G1 (the Green test deletes sidecar-owned text before the sidecar holds it): accepted. The View-state text moves to the sidecar specification only when the sidecar holds it (decision 5 gate and sub-item (a)); until then core keeps the text. The Green condition is written as the sidecar's merged specification, observed by the decouple handoff.
- R3-I1, R3-I2, R3-I3 (anchors and cross-references not in Changes): accepted. The repoint list names every occurrence (F11, Changes).
- R3-I4, R3-G3 (`replay.md` line 83 and `terminal-runtime.md` line 124 name the parser after removal): accepted. Line 83 keeps the generic page rule without the function name; line 124 moves with the parser.
- R3-I5 (the refusal requirement is not in `replay.md`): accepted. Decision 6 adds it, and Changes lists it at "Replay executable".
- R3-I6 and R3-G6 (lines 81, 84 and the generic sentence are unassigned): accepted. Decision 3 names lines 81, 84 and 97 and the generic sentence.
- R3-I7 (sidecar fixture copies are missing from sync): accepted. F5 lists `replay-inputs.json` and the policy fixture; decision 6 covers the copy.
- R3-I9 (the heading for the generic sentence has no anchor): accepted. The heading is "### Hashed members" and every repoint names it.
- R3-I10 (`terms.json` Red reason): accepted. The Red reason names the strings the test checks.
- R3-I12 and R3-I13 (F1 and F8 line numbers): accepted. F1 gives JSDoc and function lines; F8 gives `logging.ko.md:35`.
- R3-I14 (input-kind table lines, path forms): accepted. Lines 11 to 18 and the workspace-root form.
- R3-G2 (the reply of `terminal.screen.read` and the cursor shapes are terminal-only in a generic section): accepted. Those sentences stay in `terminal-runtime.md` (Changes).
- R3-G4 (the screen-message fixture has no core runner): accepted. The fixture moves with the parser (decision 4).
- R3-G5 (which functions the plugin copies): accepted. Decision 4.
- R3-G8 (`validate.test.mjs` import-map assertion missing from the gate): answered. The assertion stays while the entry stays (decision 2); no gate removes the entry.
- R3-G9 and R3-I8 (decision 8 quoted a sentence that does not exist in AGENTS): accepted. Decision 8 quotes AGENTS.md line 33 exactly.
- R3-H3 and R3-G7 (the sidecar requirement sentence is not in Changes): accepted. Changes lists it.

The round 4 auditors check this version, not the earlier ones.
