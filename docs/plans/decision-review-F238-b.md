# Decision review F238-b: view log levels and view shortcut table

[한국어](decision-review-F238-b.ko.md)

This record reviews two decisions taken on branch `feat/view-bridge-F231` without adversarial verification:

- D5 (F233): the view bridge learns the stored log levels by a request on first use.
- D6 (F234): the view registers a shortcut table and passes workbench keys to the command path.

Each decision states its text, reasons, evidence with file and line, and the change it requires. Auditors are fresh subagents (Haiku); each gives substantive objections with a concrete solution. Wording and citation corrections are applied directly. Each round is recorded below. Rounds repeat until both auditors of a round have no substantive objection.

Citations: `feat` is `feat/view-bridge-F231`; `main` is `main` of this repository.

## Scope

- D5: which class gates a view record, who counts a refused record, and what a killed view loses. Round 7 decides the rate of undeclared plugin records (S1), the flush of pending refusals (S2) and the record of a killed view (S3), each with its evidence.
- D6: whether a view runs a workbench command for a key, how it does so, and what the host does with a key that a view sends.

Out of scope: wording, the exact names of new fields (fixed by the sub-items) and behaviour that the unit tests of the owning modules settle.

## D5. View log levels (F233)

### Original decision

`feat` `packages/plugin-api/view.js:116-135`: the bridge calls `runtime.log.levels` on the first record (`storedLevel`, line 127), sends every record while `levels === null` (line 135), and reports a refused read as an error line (`recordError`, line 116). The page answers the request from the levels of the plugin record (`packages/workbench/view-calls.js:184-187`). Each change arrives as the event `log.levels` (`view.js:130-131`; `packages/workbench/surface-modules.js:261-264`, `:308`; `packages/workbench/view-events.js`).

### Decision text (round 7)

The supervisor decided the open points of round 6. A view has no gate: the writer is the only gate and the only counter. The start values, the posts of the policy and the class map to a view, the view count and the flush rules of the view are removed. The citations of steps 1 to 7 to `packages/plugin-api/view.js`, `packages/workbench/view-calls.js`, `view-events.js`, `surface-modules.js`, `plugin-runtime.js` and their tests are on `feat/view-bridge-F231` (checked with `git show` in round 7); they are not in the worktree of this record.

1. **A view has no gate and no policy copy.** The view bridge keeps no policy and no class map. The host injects nothing into a view for logging (`ViewStart`, `packages/host/tauriv2/src/surfaces.rs:61` and `packages/host/wailsv3/src/surfaces.go:66`, are unchanged), posts no `log-policy` and no `log-classes` to a view, and the view's `runtime.log` has the five level methods only. A view builds the fields of each record and sends it to the page batch, which the page uses for its own records ([logging](../spec/logging.md#writers), line 108).
   - Alternative rejected: a view gate that refuses a record before it is sent, with a view-side count. That design needs three synchronisation paths (start values, posts, ready timing: rounds 1 to 6), a view count with a flush rule (S2) and a count that a kill loses (S3). Its only gain is that a refused record builds nothing, which is Principle 2 of [logging](../spec/logging.md#principles). The chosen design gives that gain up for views. The main page already does the same for plugin records: the page gate does not store a plugin record by its class (`packages/workbench/event-classes.js:137-143`, `packages/workbench/log-gate.js:28`), and the writer decides. The stated cost: a refused view record is built and batched. The batch bound of step 8 (256 events, the `page batch` row of Bounds, or the timer of 100 ms, [logging](../spec/logging.md#writers), line 108) bounds the calls to the host.
2. **The writer gates every plugin record by its class, undeclared records included.** The writer applies `enabled(class, level)` to every event of layer `plugin` in a batch, with the class of its plugin catalog. An event whose name no catalog declares takes the plugin layer default class `lifecycle`: the writer writes it with `class: "lifecycle"` and `undeclared: true`, and gates it as a `lifecycle` event. The default is one fixed class for every plugin: no field is added to `plugin.json`, and no per-plugin default exists.
   - Why `lifecycle`: it is the class of the plugin's own lifetime changes in the class table (the class table of `logging.md`), it is the only class with a low rate, and a name that no catalog declares is a naming error that must stay in the lowest-rate class. Off on `lifecycle` silences undeclared plugin records, and the other four classes do not affect them.
3. **Undeclared plugin records have no separate rate bound (S1 is closed).** Principle 5 ([logging](../spec/logging.md#principles), line 13) requires that an undeclared event is written with the marker and counted. Step 8 amends it: the record is written when the class of its layer stores its level, and counted in `log.gated` when refused. Development rejects the name: the events checker compares every emit site with the catalog and reports an emit site that names no declared event (`packages/plugin-api/events-check.js`, lines 9 to 10 and 418 to 419). At run time the class gate is the only bound. A refused undeclared record is counted in the class count of step 4 (`lifecycle`, its level), and its name is not kept in that count.
4. **The writer counts; the record and its time.** The writer counts each plugin record its gate refuses by class and level and writes `log.gated {class, level, count}` at its existing report times: when a second has passed since its earlier report, at a flush and when it stops ([logging](../spec/logging.md#policy), line 77). That record passes every gate. Views keep no count of their own, so the flush of pending view refusals (S2) does not exist. A view's unsent batch is not a refusal and is covered by step 5.
5. **A killed view's unsent batch (S3 is reduced to a stated loss).** The writer cannot count records it never received. The unsent batch of a killed view is therefore the one loss without a count. Its bound is the batch rule of step 1 (100 ms or 256 events). The host states it: the kill of a view is written as the event `host.view.killed` (layer `host`, lifecycle, `warn`, with `plugin`, `surface` and `unsent: true`, passing every gate, as `log.closed` does, [logging](../spec/logging.md#policy), line 78). The text says that unsent records of the view may be lost, so the loss is stated and no count is claimed.
6. **Removals.** The first-use request (`packages/plugin-api/view.js:125-135`), `runtime.log.levels` (`packages/workbench/view-calls.js:184-187`, comments `:28,33`), the event `log.levels` and its subscription (`packages/workbench/view-events.js`, comments `:14,19,22`), `subscribe.logLevels` and `packages/workbench/surface-modules.js:260-264,308`, `log.enabled` in the view (`view.js:196`) and in the plugin runtime (`packages/plugin-api/plugin-runtime.js:59-63,75`), The function form of `fields` stays (`fieldsOf`, `plugin-runtime.js:69`): the builder runs at the call, and the eight function-form calls of `plugins/terminal/ui/terminal.js` (lines 303, 335, 340, 344, 351, 365, 649, 925) need no change. The public API statement `log.enabled(level)` (`docs/spec/plugins.md:241`, `plugins.ko.md:242`) is removed. The consumers of `enabled` found are `plugins/terminal/ui/terminal.js:1214` (`runtime.log.enabled("debug")`) and the frame gate of its P32.1 (`CHANGELOG.md:40`); the owner changes them (D5-e).
7. **`recordError` reports.** `recordError` (`view.js:116-121`) calls the bridge's `report({where, text, error})` when a record fails, so no failure is silent (D5-d). The sentence is unchanged from round 6.
8. **Specification.** The view rules of this decision are written into [logging](../spec/logging.md) before the code changes (AGENTS.md: specification first). Lines 40 (`undeclared`: the record carries the class `lifecycle` and the marker), 71 and 74 (a view has no gate, so no default window applies to it), 76 (the gate asks; a view and the main page's plugin records build their fields and the writer decides), 77 (the count is written by the writer only), and 291 (the class of an undeclared plugin event) are changed, with their Korean mirrors. Principle 2 states the exception of step 1, with the page batch row added to Bounds. Principle 3 adds `host.view.killed` to its list of loss records, and to the list of records that pass every gate (`logging.md` line 78; `passes_every_gate` and `PassesEveryGate`). Principle 5 states the rule of step 3. The rule of step 3 covers the `plugin` layer only: an undeclared event of the `host` or `page` layer keeps the rule of [logging](../spec/logging.md#classes-and-policy) (no class, no gate), which this decision does not change. [native-surfaces](../spec/native-surfaces.md#view-surfaces), line 111, is rewritten to describe the writer as the gate.
9. **Supersession.** This decision replaces steps 1 to 4 and step 6 of the round 6 text. Those steps (start values, posts of `log-policy` and `log-classes`, `runtime.log.gated`, view counts, D5-a's view part) are not implemented.

### Reasons and evidence

- The round 6 design carried one count per view, with a flush rule and a kill loss (S2 and S3). The writer already keeps its own counts with a report rule (`logging.md` line 77), so the count moves to the one place that knows what it drops, and no view count or view flush rule is needed.
- The writer already holds the plugin catalog classes and gates plugin events (`logging.md` line 291), so a view record needs no copy of the policy: its class is known to the writer.
- The view's gate was an optimisation of Principle 2. The main page does not gate a plugin record by its class today (round 4 B-1, verified), so the view and the page now share one rule, and the cost of a refused record is the one stated in step 1.
- `log.enabled` cannot answer per event without the class map in the view, and the view has no map under this design. Removing it is simpler than a second copy of the policy; the terminal call is the one consumer (D5-e).
- An undeclared event is a naming error. The events checker rejects it at development time (`events-check.js`, lines 418 to 419); the record of the naming error at run time is the marker (`logging.md`, line 40), and a count when the gate refuses it.

### Required changes

| ID | Owner | Change |
|---|---|---|
| D5-a | `main`: `docs/spec/logging.md` (Principles 2 and 5; lines 40, 71, 74, 76, 77, 291 and their ko), `docs/spec/native-surfaces.md:111` and ko, `docs/spec/events.json` (`host.view.killed`: lifecycle, warn, fields `plugin`, `surface`, `unsent`; passes every gate; the class tables regenerated: `packages/sok/tauriv2/src/event_classes.rs`, `packages/sok/wailsv3/src/event_classes.go`, `packages/workbench/event-classes.js`) | The rules of steps 1 to 5 in the specification, before the code changes. The Bounds table gains the row `page batch`: 256 events or the timer of 100 ms; Principle 3 adds `host.view.killed`; Principle 5 states step 3. |
| D5-b | `main`: `packages/sok/tauriv2/src/event_log.rs`, `packages/sok/wailsv3/src/event_log.go` (the writer gate for an undeclared `plugin` event: class `lifecycle` and the marker), `scripts/audit-run.mjs:155-156` (count an undeclared line by its marker), `packages/log-contract` (an undeclared line with the class `lifecycle` is valid); `packages/sok/tauriv2/src/event_log.rs` and `packages/sok/wailsv3/src/event_log.go` (`passes_every_gate` and `PassesEveryGate`: the exception list gains `host.view.killed`); `packages/sok/wailsv3/src/log_policy.go` (the Go gate of the same exception) | The writer gates every `plugin` event by its class, undeclared ones with `lifecycle`; the refusal is counted in `log.gated`. Regression tests: an undeclared plugin record at `lifecycle` off is refused and counted; a main-page plugin record below its class level is refused by the writer. |
| D5-c | `feat`: `packages/plugin-api/view.js` (remove `log.enabled` and the levels request; `recordError` calls `report`, D5-d), `packages/plugin-api/plugin-runtime.js:59-75` (remove `enabled`; the function form of `fields` stays), `packages/workbench/view-calls.js` (comments `:28,33`; `runtime.log.levels`, `:184-187`), `packages/workbench/view-events.js` (`log.levels` and comments `:14,19,22`), `packages/workbench/surface-modules.js:260-264,308`, `docs/spec/plugins.md:241` and `plugins.ko.md:242`; tests `packages/plugin-api/test/view.test.mjs:370-384`, `packages/workbench/test/view-calls.test.mjs:61,210-214`, `packages/workbench/test/view-events.test.mjs:48-52`, `packages/plugin-api/test/surface.test.mjs:142,172,195-198,214`, `packages/workbench/test/plugin-states.test.mjs:40`, `packages/workbench/test/plugin-records.test.mjs:25` | The view has no gate, no levels request, no `log.enabled`, no `runtime.log.gated`; the tests are moved or deleted with their code. |
| D5-d | `feat`: `packages/plugin-api/view.js:116-121` and test | `recordError` calls `report({where, text, error})` on a failed record; a test that a refused `runtime.error` is reported. |
| D5-e | `plugins/terminal`: `ui/terminal.js:1214` (the `runtime.log.enabled("debug")` guard), with the grep of step 6 repeated in every `plugins/*` checkout for `log.enabled` and for a function passed as `fields`; the screen hash of P32.1 (`CHANGELOG.md:40`), gated by `runtime.log.enabled`, is computed on every screen message, and the owner keeps that cost or moves it behind its own condition; `plugins/flowmark/docs/features.md:26` (open P8.4, the builder run while the level is off) is closed as superseded by this decision | The plugin builds its debug fields without the guard, or it keeps the call site unchanged when the record is cheap. Owner: `plugins/terminal` (not in the round 6 owner list; registered here). |
| D5-f | `main`: `packages/host/tauriv2/src/surfaces.rs`, `packages/host/wailsv3/src/surfaces.go` (the kill path of a view writes `host.view.killed`) | The kill record of step 5, with its text. |
| D5-g | `main`: `packages/workbench/log-batch.js` (the page batch size bound of 256 events; no such bound exists today) | The page batch flushes at 256 events or at the 100 ms timer, and the `page batch` row of Bounds states it. |

### Sub-items of D5 (registered at close)

- S1 is closed by step 3 (no separate rate; the class gate is the bound).
- S2 is closed by step 4 (no view count, so no view flush).
- S3 is reduced to step 5 and row D5-f: the unsent batch of a killed view is a stated loss, bounded by the batch rule, with no count.

### Rounds

#### Round 1 (answers)

Two auditors (A: D5 gate and owners; B: D5 changes and gaps). Each objection was checked in the files.

| Objection | Answer |
|---|---|
| A1: gate never gets the event | Accepted. Step 2; D5-g. |
| A2: counts have no entry into the batcher | Accepted. Step 4; D5-h. |
| A3: plugin catalog owner and key format | Accepted. Host reader exists; keys are full names; step 1; D5-a. |
| A4: start values can be stale | Accepted. Host builds from its applied policy; step 1. |
| A5: change path duplicates `log-policy` | Accepted in part. `log-policy` reaches surface documents; step 6 reuses it. |
| A6: `log.levels` shape and owners | Accepted. Removed; step 7, D5-e. |
| B1: gate change hook | Accepted as moot; no page-side change path is used. |
| B2: `host-contract.md:196` cited as existing | Accepted. New members. |
| B3: unclassed records bypass the policy | Accepted in round 1; round 2 changed it (undeclared events are sent, not gated); round 5 caps them (step 3). |
| B4: supersession misstates the spec | Accepted. Step 9; D5-f. |
| B5: parallel delivery path | Same as A5. |
| B6: final counts lost silently | Accepted in part; superseded in rounds 3 and 5 (steps 4 and 5). |

#### Round 2 (answers)

| Objection | Answer |
|---|---|
| C1 / D1: undeclared events gated at `error` contradict `logging.md:13` and `:40` | Accepted. Undeclared events are sent with the marker, ungated; round 5 caps them. |
| C2 / D2: no timer; the bound does not hold | Accepted in round 2; round 5 replaces the microtask flush with the three rules of step 4. |
| C3 / D3: the residual loss lowers Principle 3 and the exact-count rule | Accepted in form: an explicit exception in the spec (D5-f), bounded (step 5). |
| C4: `logClasses` frozen at start | Accepted. Step 6: the host posts `log-classes` at each applier change. |
| C5: change path and start source not decided | Accepted. Step 6 names the channel; step 1 uses the applied policy. |
| D4: `recordError` has no owning change | Accepted. Step 8; D5-b. |
| citation: `view-events.js` path | Corrected to `packages/workbench/view-events.js`. |

#### Round 3 (answers)

| Objection | Answer |
|---|---|
| B1: step 4 lowers the standard; the loss record is gated by `lifecycle=off` | Accepted. The record is `lifecycle` `warn`, passing every gate (D5-a). |
| B2: `keyOf` routes unknown events to `native:` | Accepted. Verified at `feat` `view.js:211-216`; step 6 applies in `keyOf` and `dispatch`. |
| B3: the Go host has no `log-policy` announcer | Not accepted: `main` `packages/host/wailsv3/src/log_policy.go:178` emits `log-policy`. The `log-classes` send is added in both hosts. |
| B4: citation `view.channel.ready` is at `host-contract.md:197` | Accepted; steps 1 and 6 cite 196-197. |
| B4: `runtime.log.gated` timer sends have no failure handler | Accepted; every send carries `.catch(report)`. |
| D5-1: the page gate drops records the host approved | Accepted in round 3; round 4 found that the page gate never gates plugin records, so the bypass is removed (step 2). |
| D5-2: the loss record can be gated off | Accepted; `lifecycle` `warn`, passing every gate. |
| D5-3: the host cannot know that counts were pending | Accepted; the record says "possibly". |
| D5-4: the decision lowers Principle 3 | Accepted in part; round 5 states the count bound (step 5). |
| D5-5: `log.enabled(level)` undefined for undeclared events | Accepted in round 3; round 5 makes it per event (step 2). |

#### Round 4 (answers)

| Objection | Answer |
|---|---|
| A-1: a microtask flush sends one IPC per task; the one-second rule is ignored | Accepted. Step 4: flush on 256 pending, on the 1-second check at the next refusal, and on `pagehide`; no timer. |
| A-2: the view is a second gate with no backstop | Accepted. Step 2: the host writer applies `enabled(class, level)` to every view record and counts a refusal as `log.gated`. |
| A-3: undeclared plugin events bypass `off` | Accepted. Step 3 caps undeclared records per surface (100 per second); the cap is stated in `logging.md` (D5-f). |
| A-4: the bound is a time bound, not a count bound | Accepted. Step 4 adds the 256-refusal flush; step 5 states at most 255 refusals per killed view. |
| B-1: the page-gate rationale is false | Accepted, verified: `classOf` returns undefined for `plugin.<id>.<event>` (`event-classes.js:137-143`) and `log-gate.js:28` stores an unclassed event. The bypass is removed (step 2). |
| B-2: `logClasses` has no Rust getter | Accepted. Step 1 and D5-a add `plugin_classes()` and `PluginClasses()`; the applier is `installed.rs:492`. |
| B-3: level-only `log.enabled` contradicts `logging.md:10` and `:76` | Accepted. Step 2: `log.enabled(level, event)` is per event; D5-g and D5-f. |

#### Round 5 (answers)

Two auditors on the D5 text (both fresh; each objection checked in the files).

| Objection | Answer |
|---|---|
| A1: the gate and no-gate rules are at `logging.md:76`, not `:40` | Accepted. Step 2 cites line 76; S1 cites lines 13, 40 and 76. |
| A2: `native-surfaces.md:113,120,127` and `plugins.md:170` do not concern log levels | Accepted; `grep` finds no `log.levels` in the spec. The removal list is replaced; the sentence at `native-surfaces.md:111` is rewritten (D5-i). |
| A3: the view call `runtime.log.gated` and the events `log-policy`, `log-classes` are not in `native-surfaces.md` | Accepted. D5-i updates the view call list, the view events and the sentence, with ko mirrors. |
| A4: a change during creation is posted to a view that is not ready | Accepted. Step 4: a change posts only to a view with a recorded ready document; the pair arrives at ready; D5-c tests it. |
| A5: test paths lack their directory | Accepted. Step 6 and D5-e give full paths. |
| B-O1: a restart replays the stored `ViewSpec` start | Accepted. Step 1: the members are built at each injection and are not part of the stored start. |
| B-O2: a refusal for a missing member contradicts the host building the members | Accepted. The refusal is removed; an unreadable policy or class map is an error of the injection step. |
| B-O3: the writer gate for `view` records cannot identify them in a batch | Accepted. The writer gates every event of layer `plugin` in a batch (step 2, D5-a), which includes main-page plugin records. |
| B-O4: `log.enabled(level)` is public at `plugins.md:241` and is not in the removal list | Accepted, option (ii): the two-argument form replaces it; `plugins.md:241` and `plugins.ko.md:242` are in D5-e. |
| B-O5: removal list misses comments at `view-calls.js:28,33`, `view-events.js:14,19,22`, `surface-modules.js:260` | Accepted; listed in step 6 and D5-e. |

#### Round 6 (answers)

Two auditors on the D5 text (both fresh; read-only; decision-level objections only).

| Objection | Answer |
|---|---|
| D5 A1: an undeclared plugin event passes every gate, so a plugin whose classes are all `off` can emit without limit; the bound is deferred to S1 | Accepted as a decision-level objection. Open: round 7 must either give an undeclared plugin event a class so that `off` holds for it, or state the bound inside the decision. |
| D5 B1: the same point, from the policy's goal (`logging.md` Gate paragraph, `log-gate.js:28`) | Accepted; the same open item as A1. |
| D5 A2: step 3 says no count is dropped without a record, but S2 and S3 leave the flush and the kill loss open | Accepted. Open: round 7 must choose between a writer-only count (no pending state in the view, so S2 and S3 fall away) and a stated bound in the decision. The IPC cost of refused records is part of that choice. |
| D5 A3: the view-side gate is an optimisation with three synchronisation paths (start values, posts, ready timing); the decision does not weigh it against the writer-only design | Accepted as part of the same open choice; round 7 states the cost of each design. |

#### Round 7 (answers)

Four fresh auditors (Haiku, two per decision; read-only). Each objection was checked in the files; the D5 citations to the view bridge are on `feat/view-bridge-F231`, so the auditors' absence of them in the worktree is a citation issue, not a design issue.

| Objection | Answer |
| --- | --- |
| D5 A: citations to view-side code (`view.js`, `view-calls.js`, `view-events.js`, `surface-modules.js`) do not exist in the worktree | Accepted as a citation issue: the paths are on `feat/view-bridge-F231`, checked with `git show`; the decision now says so (opening of D5). No design change. |
| D5 A: step 3 contradicts Principle 5 for undeclared `info` and `warn` records under the default `error` policy | Accepted. Step 8 amends Principle 5 explicitly: the record is written when the class of its layer stores its level, and counted in `log.gated` when refused. |
| D5 A: refused view `frame` records cost IPC on the frame path (Principle 2) | Accepted as a stated cost with its bound: the page batch bound of step 8 (256 events or 100 ms) bounds the calls; Principle 2 states the exception. |
| D5 B: removing the function form of `fields` breaks eight call sites in `plugins/terminal/ui/terminal.js` | Accepted. The function form stays; `fieldsOf` builds it at the call (step 6). D5-e names the frame gate of P32.1. |
| D5 B and D5 A: the removal targets of step 6 do not match the HEAD of this worktree | Accepted as a citation issue (see the first row); the feat paths are the owner paths of D5 (`feat` in the original decision). |
| D5 B: `view.killed` violates the layer prefix rule; `log.dropped` needs a sequence range | Accepted: the event is `host.view.killed` (layer `host`). `log.dropped` is not used: its fields are sequence ranges, which an unsent batch lacks. Principle 3 adds `host.view.killed` to its list of loss records, and to the list of records that pass every gate (`logging.md` line 78; `passes_every_gate` and `PassesEveryGate`). |
| D5 B: tests `plugin-states.test.mjs:40`, `plugin-records.test.mjs:25,195,197,198` and `surface.test.mjs:214` call `runtime.log.enabled` | Accepted; D5-c lists them. |
| D5 B: the page batch bound of 256 events is not in `logging.md` Bounds | Accepted; D5-a adds the row `page batch` (256 events or 100 ms). |
| D5 round 7 sibling check: `plugins/terminal` (P32.1 frame gate), `plugins/flowmark` P8.4 (open) | Recorded in D5-e; flowmark P8.4 is closed as superseded. Browser P18.4 is a done row that mentions `enabled` as history; it needs no change. |

#### Round 8 (answers)

Four fresh auditors (Haiku). Round 8 found the objections below; each was checked in the files.

| Objection | Answer |
| --- | --- |
| D5 A: D5-a and D5-f still write `view.killed` | Accepted: renamed to `host.view.killed`. |
| D5 A: D5-b omits the files that implement the gate exception | Accepted: `passes_every_gate` (`packages/sok/tauriv2/src/event_log.rs`), `PassesEveryGate` (`packages/sok/wailsv3/src/event_log.go`) and `packages/sok/wailsv3/src/log_policy.go` are added to D5-b. |
| D5 A: the 256-event bound is not implemented in `log-batch.js`, and `logging.md` line 108 states no number | Accepted: step 1 and step 8 cite the new Bounds row; D5-g owns `packages/workbench/log-batch.js`. |
| D5 A: no rule for undeclared `host` and `page` events | Accepted: step 8 scopes step 3 to the `plugin` layer; other layers keep `logging.md` line 76. |
| D5 B: `plugin-records.test.mjs` lines 195, 197, 198 do not exist on `feat` | Accepted: the citation is `:25` only, in D5-c and here. |
| D5 B: `view-calls.js:86-88` is `viewShortcuts`, not a log-level line | Not a D5 citation; the log-level lines are `:184-187` and `:28,33`, as cited. |

## D6. View shortcut table (F234)

### Original decision

`feat` `packages/plugin-api/view.js:139-164`: the view registers a shortcut table read from the page (`runtime.shortcuts.read`, answered by `viewShortcuts`, `packages/workbench/view-calls.js:86-88`). An owner `workbench` row is prevented and passed on (`runtime.shortcuts.run`, `view.js:153-158`, `view-calls.js:205-212`). Before registration the first key sends `runtime.shortcuts.missing` (`view.js:143-147`), recorded as `page.view.shortcut-table-missing`. The bridge exports `shortcuts.register()` (`view.js:160-164`, returned at `:331`).

### Decision text (round 7)

The supervisor decided the open points of round 6. A view forwards a workbench key only by running its command itself. The host never acts on a key from a view.

1. **The view prevents no key by itself.** A key that a view owns (its text input, its own Escape action) keeps its default action and reaches the view's first responder. The view owns its keys; the workbench owns the rows of `packages/workbench/shortcuts.json` whose owner is `workbench`.
2. **No implicit passthrough.** The bridge installs no keydown listener for the shortcut table and sends no call on a keydown. The host never closes a page picker or runs a workbench command because of a key that the view did not forward. An editable target (a find bar's Escape, an input-method composition) is handled by the view, which does not forward the key, so it is never overridden by the workbench.
3. **A view forwards by running the command.** The view reads the workbench rows with `runtime.shortcuts.read` (kept, read only: it returns the rows whose owner is `workbench` or `view`). When the view's own handler decides that a key is a workbench key, it runs the row's command with `runtime.command(row.command, {})`. The rule is one rule for every row: Escape with an open page picker (`core.picker.close`, `shortcuts.json:22`), cmd+k (`core.focus.set`, `:18`), shift+cmd+n in a browser build (`core.window.new`, `:17`) and every other workbench row. There are no per-key exceptions and no narrowing of the `when` text: the command decides what it does, and a command that does not apply refuses with its own error, which the call layer reports. `runtime.command` lets a view run any declared core command; the table only tells the view which keys the workbench owns, and the forwarding decision is the view's for every row. The read returns the rows of the running build: a row whose `when` names a build condition that does not hold (the browser-only shift+cmd+n row in a native build) is not returned; this is a property of the build's table, not a key exception.
   - Escape is an ordinary key: the view decides, and it runs `core.picker.close` (the row of `shortcuts.json:22`) when it forwards it. A view with its own Escape action (a popover, a find bar) decides in its own handler; D6-g states the contract in [native-surfaces](../spec/native-surfaces.md#view-surfaces).
   - Rows of owner `native menu` (`shortcuts.json:3-16`) are not in the table that the view reads (step 5), so the view never forwards them. Whether the web view receives those keys is observed in D6-c; it does not change the rule.
4. **Verified: `runtime.command` already reaches the table commands, so `runtime.shortcuts.run` is dropped.** The call layer runs every `core.` name through `runCore` (`packages/workbench/view-calls.js:244` on `feat/view-bridge-F231`). `core.picker.close` is declared (`packages/workbench/core-exposure.js:553`, `packages/workbench/exposure.json:3586`). The plugin views call `calls.request(name, params)` for any name through `runtime.command` (`plugins/editor/ui/view.js:128`, `plugins/shell/ui/view.js:104`, `plugins/flowmark/ui/view.js:78`). So a view that runs `core.picker.close` through `runtime.command` gets no command it cannot already run. `runtime.shortcuts.run` and its allow-list are removed: an allow-list of one name that the view can reach by another route protects nothing. The generic bridge (`packages/plugin-api/view.js`) gets the same route, `command: (name, params) => calls.request(name, params)`, so that every view has one route; the call layer keeps the owner check.
5. **Removed, with no deprecation.** `shortcuts.register()` and its return (`view.js:160-164,331`) are removed with no deprecation: F231 was never released and is not in `main`, and core is 0.0.x, so no compatibility layer is kept. Also removed: the keydown listener and `shortcutTable` (`view.js:137-159`), the helpers `MODIFIERS` and `isKey` (`view.js:21-32`), the case `runtime.shortcuts.missing` and its event `page.view.shortcut-table-missing` (`docs/spec/events.json:690`, the class rows of `packages/sok/tauriv2/src/event_classes.rs:167`, `packages/sok/wailsv3/src/event_classes.go:125`, `packages/workbench/event-classes.js:112`), and the case `runtime.shortcuts.run` (`view-calls.js:205-212`) with its event `page.input.shortcut.failed`, because the call layer already reports a failed call. Kept: `runtime.shortcuts.read` (`view-calls.js:199-200`; `viewShortcuts` at `:86-88` changes its filter from `row.when === "Any focus" || row.owner === "view"` to the owners `workbench` and `view`, because the current filter lets the native menu rows through; it returns `key`, `owner` and `command`), and the `shortcuts` option of `surface-modules.js:21,287`, which that read uses.
6. **Spec, term and table text.** The text is English and Korean in every file:
   - `packages/plugin-api/terms.json:394` ("shortcut table"): "The workbench table of shortcuts, each with its owner and command (`packages/workbench/shortcuts.json`); a view reads it with `runtime.shortcuts.read` and runs a row's command with `runtime.command`."
   - `native-surfaces.md:137` (Input) and `feat` `:141`: the view registers no table; a view runs the command of a workbench row with `runtime.command` (step 3); the call list gains no `runtime.shortcuts.run`; `runtime.shortcuts.read` is listed as a read.
   - `plugin-processes.md:94-103` (rule 7), the event row `:141` and the contract-case list `:166` (remove the shortcut-table case); `docs/plans/plugin-processes.md:113-123,162-163,190` (feat). Rule 7 states step 2 and step 3.
   - `exposure.md:67` (owner `view`): "a key that the view leaves to its default action, or a workbench command that the view runs with `runtime.command` for its own forwarded key". `exposure.md:94-95` and ko: the two table rows follow the text of `shortcuts.json` rows 24 and 25. `feat` `exposure.md:71`: the paragraph about the table is deleted.
   - `packages/workbench/shortcuts.json` row 24 (owner `view`, `Escape`): `when` becomes "A plugin view has keyboard focus; the view handles the key itself, and runs the Escape command of an open picker only when it forwards the key". Row 25 (text input keys): "A plugin view has a text input focused; the view handles the key itself and it keeps its default action". `scripts/test/shortcut-table.test.mjs` follows the rows.
   - `CHANGELOG.md:8` and `CHANGELOG.ko.md:8`: a breaking line: "The view shortcut table (F234) and `shortcuts.register()` are removed; a view runs a workbench command with `runtime.command`." `docs/features.md:1239` and ko: superseded by F238-b D6, the removed API named.
7. **No change to the `when` text of cmd+k and shift+cmd+n.** The round 6 narrowing (`shortcuts.json:17-18`, `exposure.md:87-88`) is dropped, because the view now forwards them by the same rule as every row. The rows keep their `when` text. cmd+k is forwarded in a text input too: no text input is an exception, and the view decides. If the library is hidden, `core.focus.set` refuses, and the refusal reaches the view as a call error (test (i)).
8. **The cases and tests.** A view runs a workbench command only through `runtime.command`. Tests (red where the behaviour is new): (a) a keydown of any key sends no call from the bridge; (b) an open page picker and a view that runs `runtime.command("core.picker.close")` closes it once; (c) with no picker open, the same command is a no-op; (d) an editable target whose Escape the view does not forward leaves the page picker open; (e) `runtime.shortcuts.run` and `runtime.shortcuts.missing` are refused as not served (owner `runtime`); (f) `runtime.shortcuts.read` returns the rows of owners `workbench` and `view` and no native menu row; (g) the bridge has no `shortcuts.register`; (h) `runtime.command` with a `core.` name reaches `runCore`, and a name of another owner is refused; (i) a refused forwarded command (`core.focus.set` with the library hidden) reaches the view as a call error; (j) `runtime.shortcuts.read` returns no row of owner `native menu`; (k) a native build's read has no `shift+cmd+n` workbench row.

### Reasons and evidence

- `viewShortcuts` never returned a workbench row to `runtime.shortcuts.run` (`view-calls.js:205-212`), so the route refused every key in round 6. The table registration and the route are removed, so no code path acts on a view's key.
- A view that runs `core.picker.close` through `runtime.command` is the same action as the removed route, with no new privilege: the call layer and the owner check of step 4 apply to both.
- A passthrough that the host performs for a view (round 6, step 4) cannot tell an editable target from a plain key, and the view's Escape default is not visible to the host. The view knows its own state; the forward decision belongs to the view.
- The sibling checkouts were searched in round 5 for `shortcuts.register`, `runtime.shortcuts` and `shortcut-table-missing` in every `plugins/*` checkout (D6-e). No declared plugin calls the removed API.
- The rule-7 gate of F212.6a (`plugin-processes.md` feat `:267`) is removed with the table. Its Escape measurement is kept in D6-c, linked to F212.6a.

### Required changes

| ID | Owner | Change |
|---|---|---|
| D6-a | `feat`: `packages/plugin-api/view.js:21-32,137-164,331` (step 5), `packages/plugin-api/terms.json:394`, `packages/workbench/view-calls.js:13-16` (header comment), `packages/workbench/surface-modules.js:287` (the `shortcuts` option is fed from `packages/workbench/shortcuts.json`, not from `shortcutTable`), `:86-88` (filter to owners `workbench` and `view`; the current filter lets the native menu rows through), `:199-203` (`runtime.shortcuts.missing` removed), `:205-212` (`runtime.shortcuts.run` removed), `docs/spec/events.json:690` and the class-table rows, `native-surfaces.md:141`, `exposure.md:71`, `docs/plans/plugin-processes.md:113-123,162-163,190,267`, `docs/spec/events.json:699` (`page.input.shortcut.failed`), `packages/sok/tauriv2/src/event_classes.rs:142`, `packages/sok/wailsv3/src/event_classes.go:100`, `packages/workbench/event-classes.js:87`, `docs/spec/plugin-processes.ko.md:163`, `CHANGELOG.md:8`, `docs/features.md:1239`, and their ko; `main`: `docs/spec/native-surfaces.md:137`, `plugin-processes.md:94-103,141,166`, `exposure.md:67,94-95` and ko, `packages/workbench/shortcuts.json:24-25`, `scripts/test/shortcut-table.test.mjs`, `CHANGELOG.md:8` and ko on `main` | Remove the registration, the keydown table, the missing and run cases, their event, and the table-only helpers; keep `runtime.shortcuts.read`; state the view rule (step 3 and step 6). |
| D6-b | `feat`: `packages/plugin-api/test/view.test.mjs:394-419`, `packages/workbench/test/view-calls.test.mjs:13,278-310`, the `shortcuts` option of `fakes()` | Delete the table tests; add tests (a) to (h) of step 8. |
| D6-c | `feat` (probe) | macOS probe with view focus: a page picker (the view runs `core.picker.close` on its Escape: expected to close once); a native picker open while a view has focus (expected: no call from the view, the native picker answers through its own route, recorded as observed); a native modal holding focus (the view receives no keydown; end-to-end check); cmd+c (a role row) and cmd+= (a command row) with view focus, to observe each native menu mechanism (the view forwards neither); cmd+k and shift+cmd+n (the view runs the row's command; in a native build shift+cmd+n is observed to be answered by the menu, the view receiving no keydown); an Escape that ends an input-method composition in a view (the view does not forward). Linked to F212.6a. |
| D6-d | `feat`: `packages/plugin-api/view.js` (`runtime.command: (name, params) => calls.request(name, params)` on the generic bridge's runtime; the bridge installs no keydown listener) and `packages/workbench/view-calls.js` (no change to `runCore`) | One route for a view to run a command (step 4). |
| D6-e | `main` (`docs/features.md` F238-b record) | The sibling check, repeated at close in every `plugins/*` checkout for `shortcuts.register`, `runtime.shortcuts`, and `shortcut-table-missing`. Two open rows describe the removed registration and are closed as superseded by F238-b D6 (with ko): `plugins/shell/docs/features.md` P11.6 (line 34) and `plugins/flowmark/docs/features.md` P8.6 (line 27). The breaking changelog line (step 6). |
| D6-f | `main`: `docs/features.md` entries F212.6a and F212.7 (+ko) | Re-scope F212.6a (the table gate is removed; the Escape measurement remains under D6-c) and F212.7 (no table gate). |
| D6-g | Order: `main` first, then `feat`. `main`: `docs/spec/native-surfaces.md` (the view rule of step 3 and the call list with `runtime.shortcuts.read` and `runtime.command`) and its ko. `feat`: D6-d and D6-a | The spec states the rule before the code changes, and the Escape contract: Escape is an ordinary key; a view with an open own Escape action decides in its handler; a view forwards it only by running `core.picker.close`. |

### Rounds

#### Round 1 (answers)

| Objection | Answer |
|---|---|
| C1: files omitted | Accepted; listed in steps 2, 3 and D6-a. |
| C2: test list incomplete | Accepted; D6-b. |
| C3: view-owner rows keep stale text | Accepted; step 3. |
| C4: Escape item misdescribed; no fix path | Accepted; step 4. |
| D1: `shortcuts.register()` API left in place | Accepted; step 2. |
| D2: other spec sentences | Accepted; step 3. |
| D3: Escape item described as if a handler existed | Accepted; step 4. |
| D4: cmd+k and shift+cmd+n overstated | Accepted; step 5, D6-d. |

#### Round 2 (answers)

| Objection | Answer |
|---|---|
| E1: row 24 `when` text contradicts step 5 | Accepted; step 3. |
| E2: stale sites (terms, plugin-processes lines, feat plan lines) | Accepted; step 3, D6-a. |
| E3: Korean mirrors incomplete | Accepted; D6-a lists every ko mirror. |
| E4: no replacement sentence for `feat` `exposure.md:71` | Accepted; the paragraph is deleted (step 3). |
| E5: `exposure.md:67` "handles inside itself" remains | Accepted; step 3. |
| F1: Escape fallback internally inconsistent | Accepted; round 4 and round 5 keep the fallback and make it complete. |
| F2: `runtime.dismiss` is not a declared command | Accepted; round 5 step 4 runs the declared `core.picker.close`. |
| F3: double-close and Escape stealing | Accepted; step 4, D6-b (b) and (c). |
| F4: rule-7 F212.6a gate dropped without replacement | Accepted; D6-f. |
| F5: public API removal not shown safe | Accepted; sibling checkouts searched, no match (Reasons). D6-e. |
| F6: cmd+k and shift+cmd+n narrowing waits for the probe | Accepted; step 5 narrows now (D6-d). |
| F7: the view's own keys must keep handling inside the view | Accepted; step 1. |

#### Round 3 (answers)

| Objection | Answer |
|---|---|
| D6-1: D6-d misses `shortcuts.json:17-18` that the test checks | Accepted; step 5 and D6-d include them. |
| D6-2: rows 24-25 of `shortcuts.json` not owned | Accepted; D6-a owns them. |
| D6-3: the Escape fallback has no required-change row | Accepted; D6-g. |
| D6-B1: `runtime.dismiss` is a raw call, not a declared command | Accepted; step 4 runs the declared command. |
| D6-B2: the fallback fires on the view's own Escape UI | Accepted; step 4 (`defaultPrevented`); D6-b (b). |
| D6-B3: sibling plugin check is not complete | Accepted; checked and recorded (Reasons; D6-e). |

#### Round 4 (answers)

| Objection | Answer |
|---|---|
| A-1: `core.layer.dismiss` duplicates `core.picker.close` and `core.modal.dismiss`; "topmost" has no basis | Accepted, verified: both are declared (`core-exposure.js:553,555`) and `closePicker` is idempotent (`plane.js:756-757`); the single slot (`plane.js:734`). The new command is dropped; `core.picker.close` is used (step 4). |
| A-2: cross-branch dependency unstated | Accepted. D6-g states the order: `main` first, then `feat`; D6-b (f) asserts the registry command. |
| B-1: the `defaultPrevented` check is synchronous and listener order decides | Accepted. Step 4 reads `defaultPrevented` in a `setTimeout(0)` after propagation. |
| B-2: `runtime.dismiss` is plugin-reachable | Partly accepted. Step 4 states it as internal and names it; its only effect is closing an open picker, a declared command with no data. The plugin reach is stated, not hidden. |
| B-3: "topmost" stacking across native and page layers | Accepted. Step 4: a single picker slot; no stack. The native modal answers through `core.modal.dismiss`. |
| B-4: key auto-repeat cascades | Accepted. Step 4 and D6-b (e) ignore `event.repeat`. |

#### Round 5 (answers)

Two auditors on the D6 text (both fresh; each objection checked in the files).

| Objection | Answer |
|---|---|
| A1: the passthrough accepts any workbench row, including `core.focus.set`, which step 5 narrows | Accepted. The allow-list is the one name `core.picker.close` (step 2); test (f) asserts the accept and the refusal. |
| A2: the Escape failure event loses its `key` field, and the spec does not cover it | Accepted. The fields are `{plugin, command}`; `native-surfaces.md:137` and `plugin-processes.md` rule 7 are in D6-a. |
| A3: the "no caller" search omits `plugins/shell` and `plugins/flowmark`, which hold open rows for the table | Accepted. The search covers every `plugins/*` checkout; `shell` P11.6 and `flowmark` P8.6 are closed as superseded (D6-e). |
| B-1: the one-layer guarantee is overstated; the bridge enforces nothing | Accepted. Step 4 states the bridge does not enforce the rule and the result holds only for views that follow the contract; test (g) asserts the accepted result. |
| B-2: the `setTimeout(0)` ordering is untested | Accepted. Test (c): a `window` listener registered after the bridge's calls `preventDefault`, and no call is sent. |
| B-3: no IME composition guard | Accepted. Step 4 adds the guard (`isComposing`, keyCode 229); test (e); D6-c probe. |
| B-4: removal list misses `view.js:21-32` (`MODIFIERS`, `isKey`) and `view-calls.js:82-89`; the `{command}` lookup needs an explicit form | Accepted. D6-a lists the ranges; step 2 gives the one-name allow-list. |
| B-5: the `surface-modules.js` removal is conditional and the condition never holds | Accepted. The option is removed unconditionally (D6-a). |
| B-6: `exposure.md:94-95` are table rows, not a paragraph | Accepted. Step 3 and D6-a rewrite the two rows; the `feat` paragraph at `:71` is deleted. |
| B-7: Red list gaps: non-Escape key, failing command event, popover double close, `setTimeout` order, IME, modifiers; the native modal case is not a unit test | Accepted. D6-b tests (a) to (h); the native modal case moves to the D6-c probe. |
| Non-blocking: a native picker open with view focus; the `runtime.command` wording | Accepted. Step 4 states the expected result (D6-c); the wording reads "calls `calls.request(name, params)` for any name". |

#### Round 6 (answers)

Two auditors on the D6 text (both fresh; read-only; decision-level objections only).

| Objection | Answer |
|---|---|
| D6 A1 and B1: the Escape passthrough closes an open page picker whenever a view's own Escape does not call `preventDefault`; the shipped editor find bar (`editor.js:571`) is not confirmed to call it, and the vendor Escape handler (`libraries.js:2078`) can return without consuming the key | Accepted as a decision-level objection. Open: round 7 must choose between opt-in forwarding from the view's own handler (the bridge sends nothing by default) and a host-side close with a skip for editable targets. |
| D6 A2: if `runtime.command` already reaches `core.picker.close`, the `runtime.shortcuts.run` route and its allow-list add surface and no protection | Accepted as a decision question. Open: round 7 checks whether the view bridge reaches `core.picker.close` through `runtime.command`; if it does, the route is dropped, and if it does not, the allow-list is described as a convenience and not a boundary. |
| D6 A3: removing `shortcuts.register()` breaks external plugins that call it, and the sibling search covers only local checkouts | Accepted. Open: round 7 chooses between a deprecated no-op for one release with a changelog entry, and removal with a stated version. |
| D6 B2: dropping workbench-key forwarding for `cmd+k` and `shift+cmd+n` is a removal with no stated rule | Accepted. Open: round 7 states the rule (no workbench key except Escape is forwarded from a view, with its reason in `native-surfaces.md`) or adds one named `core.focus.set` entry with its own test. |

#### Round 7 (answers)

Two fresh auditors on the D6 text (Haiku; read-only). Each objection was checked in the files.

| Objection | Answer |
| --- | --- |
| D6 A: `viewShortcuts` filters `when === "Any focus" || owner === "view"` (`view-calls.js:86-88`), so the native menu rows (`shortcuts.json:3-16`, `when` "Any focus") pass to the view | Accepted and verified. The filter changes to the owners `workbench` and `view` (step 5, D6-a); test (j). |
| D6 A: the claim that `runtime.command` reaches `core.picker.close` | Confirmed: `view-calls.js:244` routes `core.` names to `runCore`; the plugin views call `calls.request(name, params)`; `core.picker.close` is declared. Step 4 stands. |
| D6 B: the Escape sub-bullet cites a passage that does not exist and gives Escape a default that no other key has | Accepted. The sub-bullet is removed; Escape is an ordinary key, and D6-g states the contract. |
| D6 B: the native menu rule generalises beyond the probe (`shift+cmd+n` only) | Accepted. The rule no longer rests on the menu mechanism: the view never forwards a native menu row because it does not read one (step 3). D6-c observes `cmd+c`, `cmd+=` and `shift+cmd+n`. |
| D6 B: cmd+k with the library hidden is a refusal on every press; cmd+k inside a text input is not stated | Accepted and stated (step 7): the view forwards cmd+k like every row, also in a text input; the refusal reaches the view as a call error (test (i)). |
| D6 A: the generic bridge gets a new route | Not an objection: the owner check of the call layer applies; step 4 says so. |

#### Round 8 (answers)

Two fresh auditors (Haiku). Each objection was checked in the files.

| Objection | Answer |
| --- | --- |
| D6 A: step 5 says `read` returns `when`, but `viewShortcuts` returns only `key`, `owner`, `command` | Accepted: the read returns `{key, owner, command}`; the `when` text is not returned. |
| D6 A: a native build returns the browser-only `shift+cmd+n` row, and the view could run `core.window.new` beside the native menu | Accepted: the read returns the rows of the running build (step 3); test (k). The native menu answer is observed in D6-c. |
| D6 A: the Escape bullet of step 3 contradicts the round 7 answer that removed it | Accepted: the bullet is kept as the statement of the rule, and the contract is stated in D6-g. The round 7 answer is read as "the default sentence removed". |
| D6 A: `runtime.command` lets a view run any declared core command, so the single rule holds by convention | Accepted: stated in step 3; the table gives the keys the workbench owns, and the forwarding decision is the view's. |
| D6 B: owner rows miss `plugin-processes.md:267`, the five `page.input.shortcut.failed` rows, and `surface-modules.js:287` | Accepted: added to D6-a. |
| D6 B: round 5 B-5 said the `shortcuts` option is removed unconditionally | Superseded: the option stays and is fed from `shortcuts.json`, because the read remains (step 5). |

## Sub-items

- D5 sub-items S1 to S3 (above, "Sub-items of D5"): registered in `docs/features.md` under F212 at close, with owner branch `feat/view-bridge-F231`.
- D6 rows D6-a to D6-g: registered under F212 as F238-b-1 to F238-b-7, one per row, at close.

## To record elsewhere

Each row names its owner. Rows owned by `main` are changes to be made on `main`; rows owned by `feat/view-bridge-F231` are changes to be made on that branch.
