# Decision review F238-b: view log levels and view shortcut table

[한국어](decision-review-F238-b.ko.md)

This record reviews two decisions taken on branch `feat/view-bridge-F231` without adversarial verification:

- D5 (F233): the view bridge learns the stored log levels by a request on first use.
- D6 (F234): the view registers a shortcut table and passes workbench keys to the command path.

Each decision states its text, reasons, evidence with file and line, and the change it requires. Auditors are fresh subagents (Haiku); each gives substantive objections with a concrete solution. Wording and citation corrections are applied directly. Each round is recorded below. Rounds repeat until both auditors of a round have no substantive objection.

Citations: `feat` is `feat/view-bridge-F231`; `main` is `main` of this repository.

## Scope

- D5: which levels a view page gates with, how the levels reach the view and stay current, how refused records are counted, and which request paths are removed.
- D6: whether the view needs a shortcut table, which key the view prevents, and how Escape closes an open page picker.

Out of scope: wording, the exact names of new fields (fixed by the sub-items), and behaviour that the unit tests of the owning modules settle.

## D5. View log levels (F233)

### Original decision

`feat` `packages/plugin-api/view.js:116-135`: the bridge calls `runtime.log.levels` on the first record (`storedLevel`, line 127), sends every record while `levels === null` (line 135), and reports a refused read as an error line (`recordError`, line 116). The page answers the request from the levels of the plugin record (`packages/workbench/view-calls.js:184-187`). Each change arrives as the event `log.levels` (`view.js:130-131`; `packages/workbench/surface-modules.js:261-264`, `:308`; `packages/workbench/view-events.js`).

### Decision text (round 5)

1. **The host builds the start values from the policy in force.** On creation and on restart the host injects into `window.sokSurface` (`ViewStart`, `packages/host/tauriv2/src/surfaces.rs:61`, `packages/host/wailsv3/src/surfaces.go:66`) two required members:
   - `logPolicy`: the five classes of [classes and policy](../spec/logging.md#classes-and-policy) with the values `off`, `error`, `warn`, `info`, `debug`, `trace`. The value is the policy the host last applied: the default when no file was applied, or the last valid `log-policy.json`. A refused file does not change it (`logging.md:93`). The start value is never the text of a file.
   - `logClasses`: each full event name `plugin.<id>.<event>` of the surface's plugin, mapped to its class. The host reads it from the plugin class map that the catalog applier stores (`apply_plugin_event_classes`, `packages/host/tauriv2/src/installed.rs:492`, which calls `log.set_plugin_classes`; the Go counterpart is `packages/host/wailsv3/src/installed.go:463`). Each writer exposes the map through a getter that D5-a adds (`plugin_classes()` in `packages/sok/tauriv2/src/event_log.rs`, `PluginClasses()` in `packages/sok/wailsv3/src/event_log.go`); the host filters it by the prefix `plugin.<id>.`.
   A start without either member is refused with `view start is missing logPolicy` or `view start is missing logClasses`, in each host and in `createSurfaceContext`. [Host contract](../spec/host-contract.md) lines 196-197 gain both members; they are new.
2. **Each producer decides per event, and the host writer decides again.** The bridge gates each record by its class: `logEnabled(level, event)` and `log.enabled(level, event)` answer from `logClasses` and `logPolicy`. A record whose name is in `logClasses` is stored when `logPolicy[class]` stores its level. A refused record is not sent and is counted (step 3). A record that the view sends is re-checked by the host writer: the writer applies `enabled(class, level)` to every `view` record, using the class from its own catalog, and counts a refusal as `log.gated` ([logging](../spec/logging.md#policy) Gate; line 40 requires it of every writer). The view's gate is therefore an optimisation, and the writer is the boundary. The page batcher does not gate plugin records: `classOf` returns undefined for them (`packages/workbench/event-classes.js:137-143`) and the page gate stores an unclassed event (`packages/workbench/log-gate.js:28`). No page-side bypass is needed.
3. **Undeclared plugin events are capped.** A record whose name is not in `logClasses` is an undeclared event. It is sent with the marker `undeclared`, as [logging](../spec/logging.md#classes-and-policy) lines 13 and 40 require. Because it has no class, no policy value applies to it, so the view caps undeclared records per surface at 100 per second. A record above the cap is counted under the class `undeclared` and level `info` and the page reports it as `page.log.gated`. The cap is the stated bound of this exception; the spec states it at [logging](../spec/logging.md) Principle 2 and the undeclared row of the event table (D5-f). `log.enabled(level, event)` for an undeclared event returns true for every level.
4. **Refused records are counted in the view and flushed by bounded rules.** The view counts a refused record by class and level. A flush sends the counts with the call `runtime.log.gated {class, level, count}`. A flush happens when one of these holds, and only these:
   - the pending total reaches 256 refusals (checked on each refusal);
   - at least 1 second has passed since the last send, checked on the next refusal (no timer);
   - `pagehide`.
   Each send carries `.catch(report)`. The page adds the counts to the batcher's gated map (`batcher.countGated`), reported as `page.log.gated`. Under these rules at most 255 refusals per killed view can be pending when the view dies with no later refusal; the bound is stated in Bounds (D5-f).
5. **The loss of a killed view is an explicit exception with a count bound.** A killed view loses its pending counts, at most 255 refusals (step 4), because no code runs after the kill. The host writes `host.view.log-counts-possibly-lost {surface, plugin}` for every killed view, with the class `lifecycle` and the level `warn`, so the record passes every gate (added to `passes_every_gate` and `PassesEveryGate`, and to the Change paragraph of [logging](../spec/logging.md)). The record states no count: the host does not know it. The record says "possibly", because the host does not know whether counts were pending. The exception is written into [logging](../spec/logging.md) Principle 3 (line 11), the Count paragraph (line 77) and the Bounds section by D5-f. It is the only exception to exact counts.
6. **Changes reach the view through the view channel.** The host posts two events to a view through the view channel that carries the theme (`view.channel.ready`, [host contract](../spec/host-contract.md) line 197):
   - `{sok: 1, event: "log-policy", data: {classes}}`, the payload of the host event that surface documents already receive (`packages/host/tauriv2/src/log_policy.rs:120`, `packages/host/wailsv3/src/log_policy.go:178`);
   - `{sok: 1, event: "log-classes", data: {classes}}`, the map of step 1, sent at each run of the catalog applier.
   The host posts the current pair at the ready message, as it posts the theme, so a change between creation and ready is not lost. The view applies both events in the bridge: `keyOf` (`view.js:211-216`) maps each to its own key, and `dispatch` (`view.js:268`) stores the policy and the classes in the bridge state. The page-side `view-events.js` is not involved. A post before ready is refused by the existing rule (`view.channel.post-before-ready`).
7. **Removals.** The first-use request (`view.js:125-135`), `runtime.log.levels` (`view-calls.js:184-187`), the `log.levels` event and its subscription in `packages/workbench/view-events.js`, `subscribe.logLevels` and `surface-modules.js:261-264`, `:308`, and the spec lines (`native-surfaces.md:113`, `:120`, `:127`; `plugins.md:170`, and ko) are removed. Tests `view.test.mjs:370-384`, `view-calls.test.mjs:61,210-214`, `view-events.test.mjs:48-52` move to the new path.
8. **`recordError` reports.** `recordError` (`view.js:116-121`) currently drops the error of a failed error record in a silent `catch`. It calls the bridge's `report` function with `{where, text, error}` instead, so no failure is silent.
9. **Supersession.** This decision supersedes [logging](../spec/logging.md#policy) lines 71 and 74 for views: a view with a start record receives its policy in its start values and has no default window. The default error-only policy stays for a page without a host and for a host with no policy applied. D5-f changes these lines.

### Reasons and evidence

- The original rule sent every record before the answer (`view.js:135`). That contradicts the default that `logging.md:74` gives a surface, and it sends IPC for records the policy refuses (`logging.md:10`). Start values remove the window: the host holds the policy before it creates the view.
- The page gate on `main` starts at `error` until the first settings refresh (`packages/workbench/log-gate.js:23-24`). It does not gate plugin records (step 2), so the stale start is not the page gate's problem; the start value comes from the host.
- `plugin-runtime.js:72` (`if (!enabled(level)) return;`) drops a refused record without a count, and `enabled` calls the hook with the level only (`plugin-runtime.js:59-63`). Per-event checks (D5-g) and the view-side count (step 4) fix both.
- `logging.md:13`, `:40`: an undeclared event has no class and no gate; the cap of step 3 is the only bound placed on it, and it is stated in the spec.
- `log.levels` delivered an array (`view-events.js`, `view.js:131,135`). The new data is the policy object; the array form is removed with it.
- The Wails host emits `log-policy` on `main` (`log_policy.go:178`), and the Tauri host does (`log_policy.rs:120`). The `log-classes` send is the new part of both hosts.

### Required changes

| ID | Owner | Change |
|---|---|---|
| D5-a | `main`: `packages/host/tauriv2/src/surfaces.rs`, `packages/host/wailsv3/src/surfaces.go`, `docs/spec/host-contract.md:196-197` and ko, `docs/spec/events.json` (`host.view.log-counts-possibly-lost`, `page.log.gated` class `undeclared`), `packages/sok/tauriv2/src/event_log.rs` (`plugin_classes()` getter beside `set_plugin_classes`, and `passes_every_gate`), `packages/sok/wailsv3/src/event_log.go` (`PluginClasses()` getter beside `SetPluginClasses`, and `PassesEveryGate`); the view-side gate of the host writer | Host builds and injects `logPolicy` (policy applied) and `logClasses` (prefix-filtered) at creation and restart; refusal texts in host and `createSurfaceContext`; the writer applies `enabled(class, level)` to every `view` record; the new event declared at `lifecycle` `warn` and passing every gate. |
| D5-b | `feat`: `packages/plugin-api/view.js:116-121` and test | `recordError` calls `report({where, text, error})` on a failed error record; a test that a refused `runtime.error` is reported. |
| D5-c | `main`: the host post path at `view.channel.ready` and at each `log-policy` and catalog-applier change (both hosts); `feat`: `packages/plugin-api/view.js` (`keyOf` at `:211-216`, `dispatch` at `:268`) | Host posts the pair at ready and at each change; the view stores both in its bridge state. A test that a change between creation and ready is applied. |
| D5-d | `feat`: `packages/plugin-api/view.js` and test | Count refused records by class and level; flush on the three rules of step 4 only (256 pending, 1 second checked on refusal, `pagehide`); `.catch(report)` on each send; the cap of step 3 with its count. No timer. |
| D5-e | `feat`: `view.js:125-135`, `view-calls.js:184-187`, `packages/workbench/view-events.js` (`log.levels`, `subscribe.logLevels`), `surface-modules.js:261-264`, `:308`, `native-surfaces.md:113,120,127`, `plugins.md:170`, ko mirrors; tests `view.test.mjs:370-384`, `view-calls.test.mjs:61,210-214`, `view-events.test.mjs:48-52` | Remove the first-use request, `runtime.log.levels`, the `log.levels` event and its subscription. |
| D5-f | `main`: `docs/spec/logging.md:10,11,40,71,74,76,77`, Principle 2 for the undeclared cap, the Change paragraph, the Bounds section (the 256 threshold, the 1 s check, the 255-refusal kill bound, the undeclared cap), and ko | State the exceptions and their bounds in the spec; the view rule (start values, no default window). |
| D5-g | `feat`: `packages/plugin-api/plugin-runtime.js:59-72` and tests, `packages/plugin-api/test/surface.test.mjs:142,172,195-198` | `logEnabled(level, event)` and `log.enabled(level, event)` answer per event from `logClasses` and `logPolicy` (step 2); `fieldsOf` builds only for a stored event; an undeclared event is answered `true` and capped (step 3). |
| D5-h | `main`: `packages/workbench/log-batch.js` (`countGated` for view counts), `packages/workbench/view-calls.js` (`runtime.log.gated`) | Batcher accepts counts from a view into its gated map. A regression test: a plugin record is not gated by the page batcher. |

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

## D6. View shortcut table (F234)

### Original decision

`feat` `packages/plugin-api/view.js:139-164`: the view registers a shortcut table read from the page (`runtime.shortcuts.read`, answered by `viewShortcuts`, `packages/workbench/view-calls.js:86-88`). An owner `workbench` row is prevented and passed on (`runtime.shortcuts.run`, `view.js:153-158`, `view-calls.js:205-212`). Before registration the first key sends `runtime.shortcuts.missing` (`view.js:143-147`), recorded as `page.view.shortcut-table-missing`. The bridge exports `shortcuts.register()` (`view.js:160-164`, returned at `:331`).

### Decision text (round 5)

1. **The view prevents no key.** `viewShortcuts` keeps only rows whose `when` is `Any focus` (14 rows, all owner `native menu`) or whose owner is `view` (`Escape`, text input keys). No owner `workbench` row reaches the view table, because the workbench rows have other contexts (`packages/workbench/shortcuts.json:17-23`). A key that a view owns (its text input) keeps its default action and reaches the view's first responder. The view's Escape keeps its default action too.
2. **The table path, its API, and its events are removed.**
   - The keydown listener and `shortcutTable` (`view.js:139-159`).
   - `shortcuts.register()` and its return (`view.js:160-164`, `:331`).
   - The page side: `viewShortcuts`, and the cases `runtime.shortcuts.read`, `.missing`, `.run` (`view-calls.js:86-88`, `:199-212`), the import of `shortcuts.json` and the `shortcuts` option (`surface-modules.js:21`, `:287`, `view-calls.js:15`).
   - The events `page.view.shortcut-table-missing` and `page.input.shortcut.failed` (`docs/spec/events.json:690`, `:699`), their rows in the class tables (`packages/sok/tauriv2/src/event_classes.rs:167`, `packages/sok/wailsv3/src/event_classes.go:125`, `packages/workbench/event-classes.js:112`), regenerated.
   AGENTS.md: obsolete code paths are removed; a dormant table is not kept.
3. **Spec, term, and table text.** English and Korean:
   - `packages/plugin-api/terms.json:394` ("shortcut table"): replaced by "The workbench table of shortcuts, each with its owner and command (`packages/workbench/shortcuts.json`)".
   - `main` `docs/spec/native-surfaces.md:137` (Input) and `feat` `native-surfaces.md:141`.
   - `main` `docs/spec/plugin-processes.md:94-103` (rule 7) and the event rows `:141-142`; `:166` (the contract-case list "RPC, snapshot, restart, shortcut table"): the shortcut-table case is removed.
   - `main` `docs/spec/exposure.md:67` (owner `view`): rewritten to "a key that the view leaves to its default action; no workbench row is handled by a view".
   - `main` `docs/spec/exposure.md:94-95` and `feat` `docs/spec/exposure.md:71`: the `feat` paragraph about the table is deleted; the view section points to "a plugin view prevents no key".
   - `feat` `docs/plans/plugin-processes.md:113-123` (rule 7), `:162-163` (event rows), `:190` (the contract-case list).
   - `main` `packages/workbench/shortcuts.json` row 24 (owner `view`, `Escape`): the `when` text becomes "A plugin view has keyboard focus; the view sends runtime.dismiss and the key keeps its default action", and `exposure.md:94` matches it. Row 25 (text input keys): "A plugin view has a text input focused; the view handles the key itself and it keeps its default action".
   - `scripts/test/shortcut-table.test.mjs` is updated in the same change.
   - `CHANGELOG.md:8`, `CHANGELOG.ko.md:8`, `docs/features.md:1239` and ko: state that the F234 table path is removed and superseded, and name the removed API.
4. **Escape closes an open page picker through the existing declared command.** Escape with view focus does not reach the page picker's listener (`packages/workbench/plane.js:745-746`, attached only while a picker is open and used only with page focus). So an open page picker stays open when focus is in a view. The fix uses the command that already exists:
   - The view bridge handles Escape on `window` in the bubble phase. It ignores `event.repeat`. It dispatches the view call `runtime.dismiss` only after the event has finished propagating, in a `setTimeout(0)` that reads `event.defaultPrevented` at that point, so a handler that prevents the default later in propagation is seen.
   - A view whose own Escape action (a popover, for example) must call `preventDefault`; this is a contract of the view, stated in `native-surfaces.md`, and the bridge enforces it by the check of the previous point.
   - The page's view-call case `runtime.dismiss` runs the declared command `core.picker.close` through `runCore`. `core.picker.close` is already declared (`packages/workbench/core-exposure.js:553`), and `closePicker` returns when no picker is open (`packages/workbench/plane.js:756-757`), so the command is idempotent. No new command is declared, because one is not needed.
   - The page keeps a single picker slot (`plane.js:734`), so one Escape closes exactly one layer. No stack is introduced.
   - `runtime.dismiss` is an internal bridge call: it takes no payload. Plugin code may send it through the channel as it may send any view call; its only effect is to close an open page picker, which carries no data and is declared as `core.picker.close`. The name is listed in `native-surfaces.md` as internal, and `make exposure-check` covers the command.
   - A native picker or modal WebView holding focus receives the keydown itself, so the view does not see it and no call is dispatched. The native modal answers Escape through `core.modal.dismiss` (`packages/workbench/picker-layer.js:103-105`), which is unchanged.
   The Red tests are in D6-b. The probe (D6-c) confirms the expectation for each overlay; it does not decide whether the fix ships.
5. **cmd+k and shift+cmd+n with view focus.** `cmd+k` (`core.focus.set`, `packages/workbench/shortcuts.json:18`) and `shift+cmd+n` in browser builds (`:17`) are handled only by the page keydown, so with view focus they do not reach the page. The narrowing ships now (D6-d): the `when` text of `shortcuts.json:17-18` and `exposure.md:87-88` (and ko) become "The library is shown and the page has keyboard focus" (`cmd+k`) and "No host chrome (browser build) and the page has keyboard focus" (`shift+cmd+n`). The shortcut table test compares `when` text, so both files change in the same commit.

### Reasons and evidence

- `viewShortcuts` never returns an owner `workbench` row, so `runtime.shortcuts.run` refuses every key (`view-calls.js:205-212`). A path that cannot succeed is obsolete.
- The table gives the view nothing it uses: `native menu` and `view` rows keep their default action, which the view does not prevent anyway.
- A new `core.layer.dismiss` would duplicate `core.picker.close` and `core.modal.dismiss` (round 4 B-1); the existing `core.picker.close` is used, and no stack is introduced.
- The rule-7 gate of F212.6a (`plugin-processes.md` feat `:267`) is removed with the table. Its Escape measurement is kept in D6-c, linked to F212.6a.
- Sibling plugin checkouts (`../plugins/browser`, `editor`, `files`, `hwp`, `terminal`, from `scripts/workspace-registry.json`) were searched for `shortcuts.register`, `runtime.shortcuts`, and `shortcut-table-missing` with `git grep`: no match. So no declared plugin calls the removed API today.
- `exposure.md:53` requires that a user operation run a declared command; `runtime.dismiss` runs `core.picker.close`, which is declared.

### Required changes

| ID | Owner | Change |
|---|---|---|
| D6-a | `feat`: `packages/plugin-api/view.js:139-164,331`, `packages/plugin-api/terms.json:394`, `packages/workbench/view-calls.js:15,86-88,199-212`, `packages/workbench/surface-modules.js:21,287`, `docs/spec/events.json:690,699`, the three class tables, `native-surfaces.md:141`, `exposure.md:71`, `docs/plans/plugin-processes.md:113-123,162-163,190`, `CHANGELOG.md:8`, `docs/features.md:1239`, and their ko; `main`: `docs/spec/native-surfaces.md:137`, `plugin-processes.md:94-103,141-142,166`, `exposure.md:67,94-95` and ko, `packages/workbench/shortcuts.json:24-25`, `scripts/test/shortcut-table.test.mjs` | Remove the table path, API, events, and the spec and term text of step 3. |
| D6-b | `feat`: `packages/plugin-api/test/view.test.mjs:394-419`, `packages/workbench/test/view-calls.test.mjs:13,278-310`, the `shortcuts` option in `fakes()`; `packages/workbench` test of `runtime.dismiss` | Delete the table tests. Add: a keydown in a view is never prevented and makes no `runtime.shortcuts.*` call (Red on current code). Add the Escape tests: (a) a page picker open, one view Escape closes it once; (b) a view handler that prevents the default and closes its own popover leaves the page picker open; (c) no picker open, `runtime.dismiss` is a no-op; (d) a native modal holding focus gets no dispatch from the view; (e) a repeated keydown (`event.repeat`) dispatches nothing; (f) `runtime.dismiss` runs a command that exists in the registry. |
| D6-c | `feat` (probe) | macOS probe for each overlay (page picker, native picker, modal) with view focus: the expectation of step 4 is confirmed or corrected; cmd+k and shift+cmd+n with view focus. Linked to F212.6a. |
| D6-d | `main`: `packages/workbench/shortcuts.json:17-18`, `docs/spec/exposure.md:87-88` and ko | Narrow the `when` text now (step 5), in one commit. |
| D6-e | `main` (`docs/features.md`, F238-b record) | Record the sibling check of the reasons (no match in the five plugin checkouts) with the removal, and the breaking changelog line. |
| D6-f | `main`: `docs/features.md` entries F212.6a and F212.7 (+ko) | Re-scope F212.6a (the table gate is removed; the Escape measurement remains under D6-c) and F212.7 (no table gate). |
| D6-g | Order: `main` first, then `feat`. `main`: `docs/spec/native-surfaces.md` (the internal call `runtime.dismiss` in the view-call list). `feat`: `packages/plugin-api/view.js` (window bubble Escape, `event.repeat` ignored, deferred `setTimeout(0)` read of `defaultPrevented`, sends `runtime.dismiss`), `packages/workbench/view-calls.js` (case `runtime.dismiss` runs `core.picker.close` through `runCore`) | Implement the Escape step 4. The `feat` change lands only after `core.picker.close` is on `main` (it already is), and its test (D6-b (f)) asserts that the registry has the command. |

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

## Sub-items

Registered in `docs/features.md` under F212 as F238-b-1 to F238-b-N, one per row above.

## To record elsewhere

Each row names its owner. Rows owned by `main` are changes to be made on `main`; rows owned by `feat/view-bridge-F231` are changes to be made on that branch.
