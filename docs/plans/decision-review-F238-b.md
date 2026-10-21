# Decision review F238-b: view log levels and view shortcut table

[한국어](decision-review-F238-b.ko.md)

This record reviews two decisions taken on branch `feat/view-bridge-F231` without adversarial verification:

- D5 (F233): the view bridge learns the stored log levels by a request on first use.
- D6 (F234): the view registers a shortcut table and passes workbench keys to the command path.

Each decision states its text, reasons, evidence with file and line, and the change it requires. Auditors are fresh subagents (Haiku); each gives substantive objections with a concrete solution. Wording and citation corrections are applied directly. Each round is recorded below. Rounds repeat until both auditors of a round have no substantive objection.

Citations: `feat` is `feat/view-bridge-F231`; `main` is `main` of this repository.

## Scope

- D5: which levels a view page gates with, how the levels reach the view and stay current, and how the view counts refused records. The rate cap for undeclared plugin events, the flush timing of pending refusals and the record of a killed view's lost counts are not decided here: they are sub-items S1 to S3, each with its evidence.
- D6: whether the view needs a shortcut table, which key the view passes to the workbench, and how Escape closes an open page picker.

Out of scope: wording, the exact names of new fields (fixed by the sub-items), behaviour that the unit tests of the owning modules settle, and sub-items S1 to S3.

## D5. View log levels (F233)

### Original decision

`feat` `packages/plugin-api/view.js:116-135`: the bridge calls `runtime.log.levels` on the first record (`storedLevel`, line 127), sends every record while `levels === null` (line 135), and reports a refused read as an error line (`recordError`, line 116). The page answers the request from the levels of the plugin record (`packages/workbench/view-calls.js:184-187`). Each change arrives as the event `log.levels` (`view.js:130-131`; `packages/workbench/surface-modules.js:261-264`, `:308`; `packages/workbench/view-events.js`).

### Decision text (round 6, reduced)

The supervisor reduced this text: the rate cap, the flush rules and the kill-loss record are removed from it and registered as S1 to S3. Round 5 objections are answered below and applied here.

1. **The host builds the start values at each injection.** On creation, and again at each restart, the host builds two members from the live state at that moment and injects them into `window.sokSurface` (`ViewStart`, `packages/host/tauriv2/src/surfaces.rs:61`, `packages/host/wailsv3/src/surfaces.go:66`). They are not part of the stored start of the view (`ViewSpec`, `view_lifecycle.rs:28-29`, `view_lifecycle.go:25-26`), so a restart never replays an old policy:
   - `logPolicy`: the five classes of [classes and policy](../spec/logging.md#classes-and-policy) with the values `off`, `error`, `warn`, `info`, `debug`, `trace`, read from the policy the host last applied (the default when no file was applied, or the last valid `log-policy.json`). A refused file does not change it (`logging.md:93`). The start value is never the text of a file.
   - `logClasses`: each full event name `plugin.<id>.<event>` of the surface's plugin, mapped to its class, read from the plugin class map that the catalog applier stores (`apply_plugin_event_classes`, `packages/host/tauriv2/src/installed.rs:492`, which calls `log.set_plugin_classes`; the Go counterpart is `packages/host/wailsv3/src/installed.go:463`). A getter that D5-a adds exposes the map (`plugin_classes()` in `packages/sok/tauriv2/src/event_log.rs`, `PluginClasses()` in `packages/sok/wailsv3/src/event_log.go`); the host filters it by the prefix `plugin.<id>.`.
   The page's preparation values do not carry either member. A policy or class map that cannot be read is an error of the injection step that names the file or the getter; it is not a missing member.
2. **Each producer decides per event, and the host writer decides again.** The bridge gates each record by its class: `logEnabled(level, event)` answers from `logClasses` and `logPolicy`, and the fields are built only for a stored event. The two-argument `log.enabled(level, event)` replaces the one-argument form of the plugin API (`docs/spec/plugins.md:241`, `plugins.ko.md:242`; D5-e), and answers the same way. A record whose name is in `logClasses` is stored when `logPolicy[class]` stores its level. A refused record is not sent and is counted (step 3). A page batch carries plugin-layer records of every plugin, not only views, so the host writer applies `enabled(class, level)` to every event of layer `plugin` in a batch, with the class from its plugin class map, and counts a refusal as `log.gated`. The gate rule is [logging](../spec/logging.md#policy) line 76, which requires every writer to ask the gate for an event that reaches it. The view's gate is an optimisation; the writer is the boundary. The writer also gates main-page plugin records, which are not gated today; D5-a lists the regression test. The page batcher does not gate plugin records: `classOf` returns undefined for them (`packages/workbench/event-classes.js:137-143`) and the page gate stores an unclassed event (`packages/workbench/log-gate.js:28`). A record whose name is not in `logClasses` is an undeclared event: it has no class, so no policy value applies to it. It is sent with the marker `undeclared` (`logging.md` line 40, the `undeclared` field) and passes the gate ([logging](../spec/logging.md#policy) line 76). Its rate is S1.
3. **Refused records are counted in the view.** The view counts a refused record by class and level, and sends the count with the call `runtime.log.gated {class, level, count}`. Each send carries `.catch(report)`. The page adds the counts to the batcher's gated map (`batcher.countGated`), reported as `page.log.gated`. When the counts leave the view is the subject of S2. This decision requires only that every refused record is counted and that no count is dropped without a record.
4. **Changes reach the view through the view channel.** The host posts two events to a view through the view channel that carries the theme (`view.channel.ready`, [host contract](../spec/host-contract.md) lines 196-197):
   - `{sok: 1, event: "log-policy", data: {classes}}`, the payload of the host event that surface documents already receive (`packages/host/tauriv2/src/log_policy.rs:120`, `packages/host/wailsv3/src/log_policy.go:178`);
   - `{sok: 1, event: "log-classes", data: {classes}}`, the map of step 1, sent at each run of the catalog applier.
   The host posts the current pair at the ready message, as it posts the theme. A change posts only to a view that has a recorded ready document; a view that is still being created receives the current pair at its ready message, so the skipped post is not an error. Any other refused post is recorded as a host error. The view applies both events in the bridge: `keyOf` (`view.js:211-216`) maps each to its own key, and `dispatch` (`view.js:268`) stores the policy and the classes in the bridge state. The page-side `view-events.js` is not involved.
5. **`recordError` reports.** `recordError` (`view.js:116-121`) drops the error of a failed error record in a silent `catch`. It calls the bridge's `report` function with `{where, text, error}` instead, so no failure is silent.
6. **Removals.** The first-use request (`view.js:125-135`), `runtime.log.levels` (`view-calls.js:184-187`), the `log.levels` event and its subscription in `packages/workbench/view-events.js` (with its comments at `view-events.js:14,19,22`), `subscribe.logLevels` and `surface-modules.js:261-264`, `:308` (with its comment at `:260`), and the comments of `view-calls.js:28,33`, are removed. The one-argument `log.enabled(level)` of the plugin API is replaced by the two-argument form (step 2). The sentence of `native-surfaces.md:111` that describes the page gate and the writer is rewritten (D5-i). Tests move to the new path: `packages/plugin-api/test/view.test.mjs:370-384`, `packages/workbench/test/view-calls.test.mjs:61,210-214`, `packages/workbench/test/view-events.test.mjs:48-52`.
7. **Supersession.** This decision supersedes [logging](../spec/logging.md#policy) lines 71 and 74 for views: a view with a start record receives its policy in its start values and has no default window. The default error-only policy stays for a page without a host and for a host with no policy applied. D5-f changes these lines.

### Reasons and evidence

- The original rule sent every record before the answer (`view.js:135`). That contradicts the default that `logging.md:74` gives a surface, and it sends IPC for records the policy refuses (`logging.md:10`). Start values remove the window: the host holds the policy before it creates the view.
- The page gate on `main` starts at `error` until the first settings refresh (`packages/workbench/log-gate.js:23-24`). It does not gate plugin records (step 2), so the stale start is not the page gate's problem; the start value comes from the host.
- `plugin-runtime.js:72` (`if (!enabled(level)) return;`) drops a refused record without a count, and `enabled` calls the hook with the level only (`plugin-runtime.js:59-63`). Per-event checks (D5-g) and the view-side count (step 3) fix both.
- `log.levels` delivered an array (`view-events.js`, `view.js:131,135`). The new data is the policy object; the array form is removed with it.
- The Wails host emits `log-policy` on `main` (`log_policy.go:178`), and the Tauri host does (`log_policy.rs:120`). The `log-classes` send is the new part of both hosts.

### Required changes

| ID | Owner | Change |
|---|---|---|
| D5-a | `main`: `packages/host/tauriv2/src/surfaces.rs`, `packages/host/wailsv3/src/surfaces.go` (the injection script builds the members at each injection, `documents.rs:2132`, `documents.go:426`), `packages/sok/tauriv2/src/event_log.rs` (`plugin_classes()` getter beside `set_plugin_classes`), `packages/sok/wailsv3/src/event_log.go` (`PluginClasses()` getter beside `SetPluginClasses`); the host writer's gate for every event of layer `plugin` in a batch | The host builds `logPolicy` and `logClasses` at each injection, not from the stored start. The writer applies `enabled(class, level)` to every `plugin`-layer event and counts a refusal as `log.gated`. Regression test: a main-page plugin record below its class level is refused by the writer. |
| D5-b | `feat`: `packages/plugin-api/view.js:116-121` and test | `recordError` calls `report({where, text, error})` on a failed error record; a test that a refused `runtime.error` is reported. |
| D5-c | `main`: the host post path at `view.channel.ready` and at each `log-policy` and catalog-applier change (both hosts); `feat`: `packages/plugin-api/view.js` (`keyOf` at `:211-216`, `dispatch` at `:268`) | The host posts the pair at ready, and at each change only to views with a recorded ready document. Tests: a change between creation and ready is applied at ready with no error line; a change to a ready view is applied; a refused post to a ready view is recorded. |
| D5-d | `feat`: `packages/plugin-api/view.js` and test | Count refused records by class and level; send each count with `runtime.log.gated {class, level, count}` and `.catch(report)`. The flush timing is S2. |
| D5-e | `feat`: `view.js:125-135`, `view-calls.js:184-187` and its comment at `:28,33`, `packages/workbench/view-events.js` (`log.levels`, `subscribe.logLevels`, comments at `:14,19,22`), `surface-modules.js:260-264`, `:308`; `docs/spec/plugins.md:241` and `plugins.ko.md:242` (the one-argument `log.enabled(level)` becomes `log.enabled(level, event)`); tests `packages/plugin-api/test/view.test.mjs:370-384`, `packages/workbench/test/view-calls.test.mjs:61,210-214`, `packages/workbench/test/view-events.test.mjs:48-52` | Remove the first-use request, `runtime.log.levels`, the `log.levels` event and its subscription; change the public `log.enabled` signature and its spec lines; move the tests. |
| D5-f | `main`: `docs/spec/logging.md:71,74` and ko | The view rule: start values, no default window (step 7). |
| D5-g | `feat`: `packages/plugin-api/plugin-runtime.js:59-72` and tests, `packages/plugin-api/test/surface.test.mjs:142,172,195-198` (new expectations: the two-argument form answers per event; an undeclared event answers `true`) | `logEnabled(level, event)` and `log.enabled(level, event)` answer per event (step 2); `fieldsOf` builds only for a stored event. |
| D5-h | `main`: `packages/workbench/log-batch.js` (`countGated` for view counts), `packages/workbench/view-calls.js` (`runtime.log.gated`) | Batcher accepts counts from a view into its gated map. A regression test: a plugin record is not gated by the page batcher. |
| D5-i | `main`: `docs/spec/native-surfaces.md` (the view call list gains `runtime.log.gated {class, level, count}`; the view events gain `log-policy` and `log-classes` posted at ready and at each change; the sentence at line 111 that describes the gate and the writer is rewritten to the start values and the writer re-check), and ko | The contract of the view channel states the new call and events before the code changes (AGENTS.md: update the specification first). |

### Sub-items of D5 (registered at close, not decided here)

- **S1, rate of undeclared plugin records.** An undeclared plugin record has no class, so no policy value caps it, and `log.enabled` answers true for every level. A plugin whose classes are all `off` can write undeclared records without limit. Evidence: round 4 A-3; `logging.md` line 76 states that an undeclared event has no class and no gate, line 13 states the marker, and no line states a rate bound. Required: a decision with its own adversarial review, either a stated per-surface cap with a count record, or the statement that no cap applies.
- **S2, flush of pending refusals.** The view counts refused records (step 3), and the spec does not fix when the counts leave. The Count paragraph of `logging.md` (line 77) states that counts leave at a flush and when a second has passed since the earlier report. Evidence: round 4 A-1 showed that a microtask flush sends one IPC per task, and a timer-free flush can hold counts with no later refusal. Required: the flush rules with a bound on pending counts, the `.catch(report)` on each send, and the Bounds entry that states the bound.
- **S3, counts lost with a killed view.** A killed view loses its pending counts, because no code runs after the kill. Evidence: `logging.md` Principle 3 (line 11) says that loss is counted and stated, and the Count paragraph (line 77) gives exact counts. Required: a host record for each killed view that passes every gate and says that counts may be lost, the exception in `logging.md`, and the bound of that exception; decided with its own adversarial review.

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

## D6. View shortcut table (F234)

### Original decision

`feat` `packages/plugin-api/view.js:139-164`: the view registers a shortcut table read from the page (`runtime.shortcuts.read`, answered by `viewShortcuts`, `packages/workbench/view-calls.js:86-88`). An owner `workbench` row is prevented and passed on (`runtime.shortcuts.run`, `view.js:153-158`, `view-calls.js:205-212`). Before registration the first key sends `runtime.shortcuts.missing` (`view.js:143-147`), recorded as `page.view.shortcut-table-missing`. The bridge exports `shortcuts.register()` (`view.js:160-164`, returned at `:331`).

### Decision text (round 6, reduced)

The supervisor reduced this text: the Escape passthrough uses `runtime.shortcuts.run` with `core.picker.close`, and no separate `runtime.dismiss` call exists. Round 5 objections are answered below and applied here.

1. **The view prevents no key by itself.** A key that a view owns (its text input, its own Escape action) keeps its default action and reaches the view's first responder. No workbench row is handled by a view: the workbench rows have other contexts (`packages/workbench/shortcuts.json:17-23`). The only key that the view passes to the workbench is Escape, with no modifier, when its default action was not prevented (step 4).
2. **The table registration, its API, and its events are removed; the passthrough route is kept and narrowed.**
   - The keydown listener and `shortcutTable` (`view.js:139-159`), the helpers `MODIFIERS` and `isKey` that only the table uses (`view.js:21-32`), and the table comment (`view.js:137-138`).
   - `shortcuts.register()` and its return (`view.js:160-164`, `:331`).
   - The page side: `viewShortcuts` (`view-calls.js:82-89`), the cases `runtime.shortcuts.read` and `.missing` (`view-calls.js:199-203`), and the `shortcuts` option (`surface-modules.js:21`, `:287`, `view-calls.js:15`), which no call uses after this change.
   - The case `runtime.shortcuts.run` (`view-calls.js:205-212`) stays and takes `{command}`. It runs the command through `runCore` only when the command is `core.picker.close`, the command of the Escape row of `packages/workbench/shortcuts.json:22`, and refuses any other command with `view call runtime.shortcuts.run: <command> is not the command of the Escape picker shortcut`. The allow-list is that one name, and the D6-b test (f) asserts it.
   - A failing command writes `page.input.shortcut.failed {plugin, command}`. This call has no `key` field, so the event fields for it are stated in `native-surfaces.md` (D6-a).
   - The event `page.view.shortcut-table-missing` (`docs/spec/events.json:690`) and its row in the class tables (`packages/sok/tauriv2/src/event_classes.rs:167`, `packages/sok/wailsv3/src/event_classes.go:125`, `packages/workbench/event-classes.js:112`), regenerated.
   AGENTS.md: obsolete code paths are removed; a dormant table is not kept.
3. **Spec, term, and table text.** English and Korean:
   - `packages/plugin-api/terms.json:394` ("shortcut table"): replaced by "The workbench table of shortcuts, each with its owner and command (`packages/workbench/shortcuts.json`)".
   - `main` `docs/spec/native-surfaces.md:137` (Input) and `feat` `native-surfaces.md:141`: the view registers no table; Escape passes to `runtime.shortcuts.run {command}` (step 4); the event fields of `page.input.shortcut.failed` for that call are `{plugin, command}`.
   - `main` `docs/spec/plugin-processes.md:94-103` (rule 7; the same event fields) and the event row `:141`; `:166` (the contract-case list "RPC, snapshot, restart, shortcut table"): the shortcut-table case is removed.
   - `main` `docs/spec/exposure.md:67` (owner `view`): rewritten to "a key that the view leaves to its default action, or the Escape of an open picker that the view passes to the workbench".
   - `main` `docs/spec/exposure.md:94-95` and ko: the two table rows are rewritten to the text of `shortcuts.json` rows 24 and 25 (the rows are table rows, not paragraphs). `feat` `docs/spec/exposure.md:71`: the paragraph about the table is deleted.
   - `feat` `docs/plans/plugin-processes.md:113-123` (rule 7), `:162-163` (event rows), `:190` (contract-case list).
   - `main` `packages/workbench/shortcuts.json` row 24 (owner `view`, `Escape`): the `when` text becomes "A plugin view has keyboard focus; the view's own Escape action runs when its handler prevents the default, otherwise the Escape command of the open picker runs", and `exposure.md:94` matches it. Row 25 (text input keys): "A plugin view has a text input focused; the view handles the key itself and it keeps its default action".
   - `scripts/test/shortcut-table.test.mjs` is updated in the same change.
   - `CHANGELOG.md:8`, `CHANGELOG.ko.md:8`, `docs/features.md:1239` and ko: state that the F234 table registration is removed and superseded, and name the removed API.
4. **Escape closes an open page picker through `runtime.shortcuts.run`.** Escape with view focus does not reach the page picker's listener (`packages/workbench/plane.js:745-746`, attached only while a picker is open and used only with page focus). So an open page picker stays open when focus is in a view. The fix:
   - The view bridge handles Escape on `window` in the bubble phase. It sends the call `runtime.shortcuts.run {command: "core.picker.close"}` only when the key is Escape with no modifier, `event.repeat` is false, `event.isComposing` is false and `event.keyCode` is not 229 (an input-method key). The check runs after the event has finished propagating, in a `setTimeout(0)` that reads `event.defaultPrevented` at that point. The bridge sends this call only for Escape.
   - The bridge does not enforce the rule of a view's own Escape. A view whose own Escape action (a popover, for example) does not call `preventDefault` also closes an open page picker, because the bridge reads only `event.defaultPrevented`. The one-layer result holds only for views that follow the contract stated in `native-surfaces.md`: a view that handles its own Escape calls `preventDefault`.
   - `core.picker.close` is already declared (`packages/workbench/core-exposure.js:553`, `packages/workbench/exposure.json:3586`) and is the command of the row `shortcuts.json:22`. `closePicker` returns when no picker is open (`packages/workbench/plane.js:756-757`), so the command is idempotent.
   - No privilege is added. A view plugin's `runtime.command(name, params)` calls `calls.request(name, params)` for any name, as the plugin contexts of the editor, shell and flowmark views show (`plugins/editor/ui/view.js:128`, `plugins/shell/ui/view.js:104`, `plugins/flowmark/ui/view.js:78`). The call layer runs every `core.` name through `runCore` (`view-calls.js:244` on `feat`). The Escape passthrough gives a plugin no command it cannot already run.
   - The page keeps a single picker slot (`plane.js:734`), so one Escape closes at most one page picker. It does not stop a view's own layer from also closing (the previous point).
   - A native picker or modal WebView holding focus receives the keydown itself, so the view does not see it. The native modal answers Escape through `core.modal.dismiss` (`packages/workbench/picker-layer.js:103-105`), which is unchanged. A native picker that is open while a view has focus is reached by the same Escape; its expected result is in D6-c.
   The Red tests are in D6-b. The probe (D6-c) confirms the expectation for each overlay; it does not decide whether the fix ships.
5. **cmd+k and shift+cmd+n with view focus.** `cmd+k` (`core.focus.set`, `packages/workbench/shortcuts.json:18`) and `shift+cmd+n` in browser builds (`:17`) are handled only by the page keydown, so with view focus they do not reach the page. The narrowing ships now (D6-d): the `when` text of `shortcuts.json:17-18` and `exposure.md:87-88` (and ko) become "The library is shown and the page has keyboard focus" (`cmd+k`) and "No host chrome (browser build) and the page has keyboard focus" (`shift+cmd+n`). The shortcut table test compares `when` text, so both files change in the same commit.

### Reasons and evidence

- `viewShortcuts` never returns an owner `workbench` row, so `runtime.shortcuts.run` refuses every key (`view-calls.js:205-212`). The table registration is obsolete, because a view that passes no key needs no table; the passthrough is kept for Escape.
- The table gives the view nothing it uses: `native menu` and `view` rows keep their default action, which the view does not prevent anyway.
- A new `core.layer.dismiss` or a `runtime.dismiss` call would duplicate `core.picker.close` and `core.modal.dismiss`; the existing `core.picker.close` is used through the existing call.
- The rule-7 gate of F212.6a (`plugin-processes.md` feat `:267`) is removed with the table. Its Escape measurement is kept in D6-c, linked to F212.6a.
- Sibling plugin checkouts (`../plugins/browser`, `editor`, `files`, `hwp`, `terminal`, from `scripts/workspace-registry.json`) were searched with `git grep` for `shortcuts.register`, `runtime.shortcuts`, and `shortcut-table-missing`: no match. So no declared plugin calls the removed registration today.
- `exposure.md:53` requires that a user operation run a declared command; `core.picker.close` is declared and is the command the passthrough runs.

### Required changes

| ID | Owner | Change |
|---|---|---|
| D6-a | `feat`: `packages/plugin-api/view.js:21-32,137-164,331`, `packages/plugin-api/terms.json:394`, `packages/workbench/view-calls.js:13-16` (header comment), `:82-89`, `:199-203`, `:205-212` (the `{command}` allow-list), `packages/workbench/surface-modules.js:21,287` (the `shortcuts` option is unused after the change: remove it), `docs/spec/events.json:690`, the class-table rows for `page.view.shortcut-table-missing`, `native-surfaces.md:141`, `exposure.md:71`, `docs/plans/plugin-processes.md:113-123,162-163,190`, `CHANGELOG.md:8`, `docs/features.md:1239`, and their ko; `main`: `docs/spec/native-surfaces.md:137` (fields of `page.input.shortcut.failed` for the Escape call), `plugin-processes.md:94-103,141,166` (same fields), `exposure.md:67,94-95` (table rows) and ko, `packages/workbench/shortcuts.json:24-25`, `scripts/test/shortcut-table.test.mjs` | Remove the table registration, the read and missing cases, the table-only helpers, the `shortcuts` option, the `page.view.shortcut-table-missing` event and the spec and term text of step 3. |
| D6-b | `feat`: `packages/plugin-api/test/view.test.mjs:394-419`, `packages/workbench/test/view-calls.test.mjs:13,278-310`, the `shortcuts` option in `fakes()` | Delete the table tests. Add (Red on current code where the behaviour is new): (a) a keydown of any key other than Escape sends no `runtime.shortcuts.*` call; (b) a page picker open, one view Escape closes it once; (c) a view handler that calls `preventDefault` on its own element sends nothing, and a `window` bubble listener registered after the bridge's that calls `preventDefault` also leaves the page picker open (the read happens after propagation); (d) no picker open, `runtime.shortcuts.run {command: "core.picker.close"}` is a no-op; (e) `event.repeat`, `event.isComposing`, `keyCode` 229, and Escape with any modifier send nothing; (f) `runtime.shortcuts.run` accepts `core.picker.close` and refuses `core.focus.set` with the text of step 2; (g) a view whose own Escape handler does not call `preventDefault` closes an open page picker (the documented, accepted result of step 4); (h) a failing `runtime.shortcuts.run` writes `page.input.shortcut.failed {plugin, command}` with no `key` field. |
| D6-c | `feat` (probe) | macOS probe for each overlay with view focus: a page picker (the expectation of step 4), a native picker open while the view has focus (expected to close through the same command), and a native modal holding focus (the view receives no keydown, so no call is sent; this is an end-to-end check, not a unit test). Also cmd+k and shift+cmd+n with view focus, and an Escape that ends an input-method composition in a view (expected: no call). Linked to F212.6a. |
| D6-d | `main`: `packages/workbench/shortcuts.json:17-18`, `docs/spec/exposure.md:87-88` and ko | Narrow the `when` text now (step 5), in one commit. |
| D6-e | `main` (`docs/features.md`, F238-b record) | Record the sibling check of the reasons: `git grep` in every `plugins/*` checkout, not only five, for `shortcuts.register`, `runtime.shortcuts`, and `shortcut-table-missing`. Two open rows describe the removed registration and must be closed as superseded by F238-b D6 (with ko): `plugins/shell/docs/features.md` P11.6 (line 34) and `plugins/flowmark/docs/features.md` P8.6 (line 27). Record the breaking changelog line. |
| D6-f | `main`: `docs/features.md` entries F212.6a and F212.7 (+ko) | Re-scope F212.6a (the table gate is removed; the Escape measurement remains under D6-c) and F212.7 (no table gate). |
| D6-g | Order: `main` first, then `feat`. `main`: `docs/spec/native-surfaces.md` (the view call `runtime.shortcuts.run {command}` in the view-call list, with its allow-list). `feat`: `packages/plugin-api/view.js` (window bubble Escape with the guards of step 4, `setTimeout(0)` read of `defaultPrevented`, sends `runtime.shortcuts.run {command: "core.picker.close"}`), `packages/workbench/view-calls.js` (case `runtime.shortcuts.run` with the one-name allow-list) | Implement the Escape passthrough of step 4. The `feat` change lands after `core.picker.close` is on `main` (it already is); D6-b (d) and (f) assert the registry command and the refusal. |

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

## Sub-items

- D5 sub-items S1 to S3 (above, "Sub-items of D5"): registered in `docs/features.md` under F212 at close, with owner branch `feat/view-bridge-F231`.
- D6 rows D6-a to D6-g: registered under F212 as F238-b-1 to F238-b-7, one per row, at close.

## To record elsewhere

Each row names its owner. Rows owned by `main` are changes to be made on `main`; rows owned by `feat/view-bridge-F231` are changes to be made on that branch.
