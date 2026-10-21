# Decision review F238-b: view log levels and view shortcut table

[한국어](decision-review-F238-b.ko.md)

This record reviews two decisions taken on branch `feat/view-bridge-F231` without adversarial verification:

- D5 (F233): the view bridge learns the stored log levels by a request on first use.
- D6 (F234): the view registers a shortcut table and passes workbench keys to the command path.

Each decision states its text, reasons, evidence with file and line, and the change it requires. Auditors are fresh subagents (Haiku); each gives substantive objections with a concrete solution. Wording and citation corrections are applied directly. Each round is recorded below. Rounds repeat until both auditors of a round have no substantive objection.

Citations: `feat` is `feat/view-bridge-F231`; `main` is `main` of this repository.

## Scope

- D5: which levels a view page gates with, how the levels reach the view and stay current, how refused records are counted, and which request paths are removed.
- D6: whether the view needs a shortcut table, which key the view prevents, and how Escape closes an open page overlay.

Out of scope: wording, the exact names of new fields (fixed by the sub-items), and behaviour that the unit tests of the owning modules settle.

## D5. View log levels (F233)

### Original decision

`feat` `packages/plugin-api/view.js:116-135`: the bridge calls `runtime.log.levels` on the first record (`storedLevel`, line 127), sends every record while `levels === null` (line 135), and reports a refused read as an error line (`recordError`, line 116). The page answers the request from the levels of the plugin record (`packages/workbench/view-calls.js:184-187`). Each change arrives as the event `log.levels` (`view.js:130-131`; `packages/workbench/surface-modules.js:261-264`, `:308`; `packages/workbench/view-events.js`).

### Decision text (round 4)

1. **The host builds the start values from the policy in force.** On creation and on restart the host injects into `window.sokSurface` (`ViewStart`, `packages/host/tauriv2/src/surfaces.rs:61`, `packages/host/wailsv3/src/surfaces.go:66`) two required members:
   - `logPolicy`: the five classes of [classes and policy](../spec/logging.md#classes-and-policy) with the values `off`, `error`, `warn`, `info`, `debug`, `trace`. The value is the policy the host last applied: the default when no file was applied, or the last valid `log-policy.json`. A refused file does not change it (`logging.md:93`). The start value is never the text of a file.
   - `logClasses`: each full event name `plugin.<id>.<event>` of the surface's plugin, mapped to its class, taken from the catalog reader that each host already runs at start (`PluginEventClasses`, `packages/sok/wailsv3/src/plugin_catalog.go:21`; the Rust reader `packages/host/tauriv2/src/installed.rs:492`), filtered by the prefix `plugin.<id>.`.
   A start without either member is refused with `view start is missing logPolicy` or `view start is missing logClasses`, in each host and in `createSurfaceContext`. [Host contract](../spec/host-contract.md) lines 196-197 gain both members; they are new.
2. **The view gates each record by its class, and the page does not gate it again.** The hook `logEnabled(level, event)` receives the event name. A record whose name is in `logClasses` is stored when `logPolicy[class]` stores its level; otherwise it is refused and counted (step 3). The view sends a stored record to the page with a path that the page batcher accepts without a second gate (`log-batch.js`, D5-h); the page gate of `logGate` starts at `error` and would otherwise refuse a record the host policy stores. A record whose name is not in `logClasses` is an undeclared event: it is sent with the marker `undeclared` and is not gated ([logging](../spec/logging.md#classes-and-policy) lines 13 and 40). `log.enabled(level)` returns true for every level, because an undeclared event at any level is sent; producers therefore build fields more often than with a per-class answer, and this cost is accepted.
3. **Refused records are counted in the view and sent at the end of the task.** The view counts a refused record by class and level. When the first count of a task becomes pending, the view schedules one flush with `queueMicrotask`; the flush sends the counts with the call `runtime.log.gated {class, level, count}`. The view also flushes on `pagehide`. Each send carries `.catch(report)`. The page adds the counts to the batcher's gated map (`batcher.countGated`), reported as `page.log.gated`. There is no timer.
4. **The loss of a killed view is an explicit exception with a stated bound.** A killed view loses the counts of the task that was running when it was killed, because no code runs after the kill. The host writes `host.view.log-counts-possibly-lost {surface, plugin}` for every killed view, with the class `lifecycle` and the level `warn`, so the record passes every gate (it is added to `passes_every_gate` and `PassesEveryGate`, and to the Change paragraph of [logging](../spec/logging.md)). The record says "possibly": the host does not know whether counts were pending. The exception is written into [logging](../spec/logging.md) Principle 3 (line 11), the Count paragraph (line 77) and the Bounds section by D5-f. It is the only exception to exact counts, and its bound is the refusals of one running task of one killed view.
5. **Changes reach the view through the view channel.** The host posts two events to a view through the view channel that carries the theme (`view.channel.ready`, [host contract](../spec/host-contract.md) line 197):
   - `{sok: 1, event: "log-policy", data: {classes}}`, the payload of the host event that surface documents already receive (`packages/host/tauriv2/src/log_policy.rs:120`, `packages/host/wailsv3/src/log_policy.go:178`);
   - `{sok: 1, event: "log-classes", data: {classes}}`, the map of step 1, sent at each run of the catalog reader (`packages/host/wailsv3/src/installed.go:463`, `packages/host/tauriv2/src/installed.rs:492`, called from the host's start and plugin-change paths).
   The host posts the current pair at the ready message, as it posts the theme, so a change between creation and ready is not lost. The view applies both events in the bridge: `keyOf` (`view.js:211-216`) maps each to its own key, and `dispatch` (`view.js:268`) stores the policy and the classes in the bridge state. The page-side `view-events.js` is not involved. A post before ready is refused by the existing rule (`view.channel.post-before-ready`).
6. **Removals.** The first-use request (`view.js:125-135`), `runtime.log.levels` (`view-calls.js:184-187`), the `log.levels` event and its subscription in `packages/workbench/view-events.js`, `subscribe.logLevels` and `surface-modules.js:261-264`, `:308`, and the spec lines (`native-surfaces.md:113`, `:120`, `:127`; `plugins.md:170`, and ko) are removed. Tests `view.test.mjs:370-384`, `view-calls.test.mjs:61,210-214`, `view-events.test.mjs:48-52` move to the new path.
7. **`recordError` reports.** `recordError` (`view.js:116-121`) currently drops the error of a failed error record in a silent `catch`. It calls the bridge's `report` function with `{where, text, error}` instead, so no failure is silent.
8. **Supersession.** This decision supersedes [logging](../spec/logging.md#policy) lines 71 and 74 for views: a view with a start record receives its policy in its start values and has no default window. The default error-only policy stays for a page without a host and for a host with no policy applied. D5-f changes these lines.

### Reasons and evidence

- The original rule sent every record before the answer (`view.js:135`). That contradicts the default that `logging.md:74` gives a surface, and it sends IPC for records the policy refuses (`logging.md:10`). Start values remove the window: the host holds the policy before it creates the view.
- The page gate on `main` starts at `error` until the first settings refresh (`packages/workbench/log-gate.js:23-24`; the only caller of `setLogPolicy` is `settings.js:458`). A start built from the page gate could be stale, and a page gate applied to a view record would refuse what the host approved. Step 2 removes the second gate for view records.
- `plugin-runtime.js:72` (`if (!enabled(level)) return;`) drops a refused record without a count, and `enabled` calls the hook with the level only (`plugin-runtime.js:59-63`). Passing the event to the hook (D5-g) and counting in the view (step 3) fix both.
- `logging.md:13` and `:40`: an undeclared event is written with the marker and has no class and no gate. Gating it at a default level would drop evidence, which the spec forbids.
- `classOf` (`packages/workbench/event-classes.js:137`) has no plugin entries on `main`; the class of a plugin event comes from the host's catalog reader instead (step 1).
- `log.levels` delivered an array (`view-events.js`, `view.js:131,135`). The new data is the policy object; the array form is removed with it.
- The Wails host emits `log-policy` on `main` (`log_policy.go:178`), and the Tauri host does (`log_policy.rs:120`). The `log-classes` send is the new part of both hosts.

### Required changes

| ID | Owner | Change |
|---|---|---|
| D5-a | `main`: `packages/host/tauriv2/src/surfaces.rs`, `packages/host/wailsv3/src/surfaces.go`, `docs/spec/host-contract.md:196-197` and ko, `docs/spec/events.json` (`host.view.log-counts-possibly-lost`), `passes_every_gate` (`packages/sok/tauriv2/src/event_log.rs`), `PassesEveryGate` (`packages/sok/wailsv3/src/event_log.go`) | Host builds and injects `logPolicy` (policy applied) and `logClasses` (prefix-filtered) at creation and restart; refusal texts in host and `createSurfaceContext`; the new event declared at `lifecycle` `warn` and passing every gate. |
| D5-b | `feat`: `packages/plugin-api/view.js:116-121` and test | `recordError` calls `report({where, text, error})` on a failed error record; a test that a refused `runtime.error` is reported. |
| D5-c | `main`: the host post path at `view.channel.ready` and at each `log-policy` and catalog-reader change (both hosts); `feat`: `packages/plugin-api/view.js` (`keyOf` at `:211-216`, `dispatch` at `:268`) | Host posts the pair at ready and at each change; the view stores both in its bridge state. A test that a change between creation and ready is applied. |
| D5-d | `feat`: `packages/plugin-api/view.js` and test | Count refused records by class and level; schedule one `queueMicrotask` flush per task with pending counts; flush on `pagehide`; `.catch(report)` on each send. No timer. |
| D5-e | `feat`: `view.js:125-135`, `view-calls.js:184-187`, `packages/workbench/view-events.js` (`log.levels`, `subscribe.logLevels`), `surface-modules.js:261-264`, `:308`, `native-surfaces.md:113,120,127`, `plugins.md:170`, ko mirrors; tests `view.test.mjs:370-384`, `view-calls.test.mjs:61,210-214`, `view-events.test.mjs:48-52` | Remove the first-use request, `runtime.log.levels`, the `log.levels` event and its subscription. |
| D5-f | `main`: `docs/spec/logging.md:11,40,71,74,76,77`, the Change paragraph and the Bounds section, and ko | Principle 3 and the Count paragraph state the kill exception with `host.view.log-counts-possibly-lost` and its bound (one running task of one killed view); the view rule (start values, no default window); undeclared events of plugin records. |
| D5-g | `feat`: `packages/plugin-api/plugin-runtime.js:59-72` and tests, `packages/plugin-api/test/surface.test.mjs:142,172,195-198` | `logEnabled(level, event)`; `log.enabled(level)` true for every level (step 2); undeclared events sent with the marker and not gated. |
| D5-h | `main`: `packages/workbench/log-batch.js` (`countGated`, and an accept path for view records that skips `logGate`), `packages/workbench/view-calls.js` (`runtime.log` and `runtime.log.gated`) | The batcher accepts view records without a second gate, and accepts counts into its gated map. A Red test: the page gate at `error`, the view sends an `info` record that the host policy stores, and it is stored. |

### Rounds

#### Round 1 (answers)

Two auditors (A: D5 gate and owners; B: D5 changes and gaps). Each objection was checked in the files.

| Objection | Answer |
|---|---|
| A1: gate never gets the event | Accepted. Step 2; D5-g. |
| A2: counts have no entry into the batcher | Accepted. Step 3; D5-h. |
| A3: plugin catalog owner and key format | Accepted. Host reader exists; keys are full names; step 1; D5-a. |
| A4: start values can be stale | Accepted. Host builds from its applied policy; step 1. |
| A5: change path duplicates `log-policy` | Accepted in part. `log-policy` reaches surface documents; step 5 reuses it. |
| A6: `log.levels` shape and owners | Accepted. Removed; D5-e. |
| B1: gate change hook | Accepted as moot; no page-side change path is used. |
| B2: `host-contract.md:196` cited as existing | Accepted. New members. |
| B3: unclassed records bypass the policy | Accepted in round 1; superseded in round 2 (undeclared events are sent, not gated). |
| B4: supersession misstates the spec | Accepted. Step 8; D5-f. |
| B5: parallel delivery path | Same as A5. |
| B6: final counts lost silently | Accepted in part; superseded in round 3 (step 4). |

#### Round 2 (answers)

| Objection | Answer |
|---|---|
| C1 / D1: undeclared events gated at `error` contradict `logging.md:13` and `:40` | Accepted. Step 2 sends them with the marker, ungated. |
| C2 / D2: no timer; the one-second bound does not hold | Accepted in round 2; superseded in round 4 (step 3: microtask flush, no timer). |
| C3 / D3: the residual loss lowers Principle 3 and the exact-count rule | Accepted in form: an explicit exception in `logging.md` (D5-f). Round 3 narrowed the bound (step 4). |
| C4: `logClasses` frozen at start | Accepted. Step 5: the host posts `log-classes` at each catalog-reader change. |
| C5: change path and start source not decided | Accepted. Step 5 names the channel; step 1 uses the applied policy, not the file text. |
| D4: `recordError` has no owning change | Accepted. Step 7; D5-b. |
| citation: `view-events.js` path | Corrected to `packages/workbench/view-events.js`. |

#### Round 3 (answers)

Two auditors on the round-3 text, one on each of its points. Each objection was checked against `main` and `feat`.

| Objection | Answer |
|---|---|
| B1: step 4 lowers the standard; the loss record is gated by `lifecycle=off`; the one-second bound bounds nothing | Accepted. Step 4 names the record `host.view.log-counts-possibly-lost` at `lifecycle` `warn`, passing every gate (D5-a). The window shrinks to one running task (step 3, microtask flush). |
| B2: `view-events.js` is not the view-side apply; `keyOf` routes unknown events to `native:` | Accepted. Verified at `feat` `view.js:211-216`. Step 5 applies in `keyOf` and `dispatch` (D5-c). |
| B3: the Go host has no `log-policy` announcer | Not accepted: `main` `packages/host/wailsv3/src/log_policy.go:178` emits `log-policy`, and the Tauri host emits it at `log_policy.rs:120`. The `log-classes` send is added in both hosts (step 5). |
| B4: citation `view.channel.ready` is at `host-contract.md:197` | Accepted; step 1 and step 5 cite 196-197. |
| B4: `runtime.log.gated` timer sends have no failure handler | Accepted. Step 3 uses `.catch(report)` on every send; the timer is removed. |
| D5-1: the page gate drops records the host approved | Accepted. Step 2 and D5-h: view records pass the batcher without a second gate, with a Red test. |
| D5-2: the loss record can be gated off | Accepted. Step 4 declares it `lifecycle` `warn` and passing every gate. |
| D5-3: the host cannot know that counts were pending | Accepted. Step 4 writes "possibly" for every killed view. |
| D5-4: the decision lowers Principle 3 | Accepted in part, as B1 above: the exception is named, bounded to one running task, and recorded. |
| D5-5: `log.enabled(level)` has an undefined answer for undeclared events | Accepted. Step 2: `log.enabled(level)` returns true for every level. |

## D6. View shortcut table (F234)

### Original decision

`feat` `packages/plugin-api/view.js:139-164`: the view registers a shortcut table read from the page (`runtime.shortcuts.read`, answered by `viewShortcuts`, `packages/workbench/view-calls.js:86-88`). An owner `workbench` row is prevented and passed on (`runtime.shortcuts.run`, `view.js:153-158`, `view-calls.js:205-212`). Before registration the first key sends `runtime.shortcuts.missing` (`view.js:143-147`), recorded as `page.view.shortcut-table-missing`. The bridge exports `shortcuts.register()` (`view.js:160-164`, returned at `:331`).

### Decision text (round 4)

1. **The view prevents no key.** `viewShortcuts` keeps only rows whose `when` is `Any focus` (14 rows, all owner `native menu`) or whose owner is `view` (`Escape`, text input keys). No owner `workbench` row reaches the view table, because the workbench rows have other contexts (`packages/workbench/shortcuts.json:17-23`). A key that a view owns (its text input) keeps its default action and reaches the view's first responder. The view's Escape keeps its default action too, unless the view's own handler calls `preventDefault` (step 4).
2. **The table path, its API, and its events are removed.**
   - The keydown listener and `shortcutTable` (`view.js:139-159`).
   - `shortcuts.register()` and its return (`view.js:160-164`, `:331`).
   - The page side: `viewShortcuts`, and the cases `runtime.shortcuts.read`, `.missing`, `.run` (`view-calls.js:86-88`, `:199-212`), the import of `shortcuts.json` and the `shortcuts` option (`surface-modules.js:21`, `:287`, `view-calls.js:15`).
   - The events `page.view.shortcut-table-missing` and `page.input.shortcut.failed` (`docs/spec/events.json:690`, `:699`), their rows in the class tables (`packages/sok/tauriv2/src/event_classes.rs:167`, `packages/sok/wailsv3/src/event_classes.go:125`, `packages/workbench/event-classes.js:112`), regenerated.
   AGENTS.md: obsolete code paths are removed; a dormant table is not kept.
3. **Spec, term, and table text.** English and Korean:
   - `packages/plugin-api/terms.json:394` ("shortcut table", a definition of the removed registration): replaced by "The workbench table of shortcuts, each with its owner and command (`packages/workbench/shortcuts.json`)".
   - `main` `docs/spec/native-surfaces.md:137` (Input) and `feat` `native-surfaces.md:141`.
   - `main` `docs/spec/plugin-processes.md:94-103` (rule 7) and the event rows `:141-142`; `:166` (the contract-case list "RPC, snapshot, restart, shortcut table"): the shortcut-table case is removed.
   - `main` `docs/spec/exposure.md:67` (owner `view`): rewritten to "a key that the view leaves to its default action; no workbench row is handled by a view".
   - `main` `docs/spec/exposure.md:94-95` and `feat` `docs/spec/exposure.md:71`: the `feat` paragraph about the table is deleted; the view section points to "a plugin view prevents no key".
   - `feat` `docs/plans/plugin-processes.md:113-123` (rule 7), `:162-163` (event rows), `:190` (the contract-case list).
   - `main` `packages/workbench/shortcuts.json` row 24 (owner `view`, `Escape`): the `when` text becomes "A plugin view has keyboard focus; the view sends runtime.dismiss and the key keeps its default action", and `exposure.md:94` matches it. Row 25 (text input keys): "A plugin view has a text input focused; the view handles the key itself and it keeps its default action".
   - `scripts/test/shortcut-table.test.mjs` is updated in the same change.
   - `CHANGELOG.md:8`, `CHANGELOG.ko.md:8`, `docs/features.md:1239` and ko: state that the F234 table path is removed and superseded, and name the removed API.
4. **Escape closes an open page overlay through a declared command.** Escape with view focus does not reach the page picker's listener (`packages/workbench/plane.js:745-746`, attached only while a picker is open and used only with page focus). So an open page picker stays open when focus is in a view. The fix is part of this decision:
   - A core command `core.layer.dismiss` is declared in `packages/workbench/core-exposure.js` (`registry.command`) and in `packages/workbench/exposure.json`; `packages/plugin-api/core-exposure.json` is regenerated (`exposure.md:59`). The command closes the topmost open picker or modal layer, and does nothing when none is open. It is idempotent.
   - The view bridge handles Escape in the bubble phase and sends the view call `runtime.dismiss` only when `!event.defaultPrevented`. The view-call case of the page runs `core.layer.dismiss` through `runCore`, so the key reaches a declared command. `runtime.dismiss` is a bridge route to that declared command, not a command of its own.
   - A view whose own Escape handler (a popover, for example) calls `preventDefault` does not dispatch the call; the rule is in the bridge, so each view gets it without code of its own.
   - A native picker or modal WebView holding focus receives the keydown itself, so the view does not see it and no call is dispatched.
   - The view-call route is added to the view-call list of `native-surfaces.md`, and `make exposure-check` covers the command.
   The Red tests are in D6-b. The probe (D6-c) confirms the expectation for each overlay; it does not decide whether the fix ships.
5. **cmd+k and shift+cmd+n with view focus.** `cmd+k` (`core.focus.set`, `packages/workbench/shortcuts.json:18`) and `shift+cmd+n` in browser builds (`:17`) are handled only by the page keydown, so with view focus they do not reach the page. The narrowing ships now (D6-d): the `when` text of `shortcuts.json:17-18` and `exposure.md:87-88` (and ko) become "The library is shown and the page has keyboard focus" (`cmd+k`) and "No host chrome (browser build) and the page has keyboard focus" (`shift+cmd+n`). The shortcut table test compares `when` text, so both files change in the same commit.

### Reasons and evidence

- `viewShortcuts` never returns an owner `workbench` row, so `runtime.shortcuts.run` refuses every key (`view-calls.js:205-212`, "is not a workbench shortcut of a view"). A path that cannot succeed is obsolete.
- The table gives the view nothing it uses: `native menu` and `view` rows keep their default action, which the view does not prevent anyway.
- The rule-7 gate of F212.6a (`plugin-processes.md` feat `:267`, the shortcut-table gate before F212.7) is removed with the table. Its Escape measurement is kept in D6-c, linked to F212.6a.
- Sibling plugin checkouts (`../plugins/browser`, `editor`, `files`, `hwp`, `terminal`, the repositories of `scripts/workspace-registry.json`) were searched for `shortcuts.register`, `runtime.shortcuts`, and `shortcut-table-missing` with `git grep`: no match. So no declared plugin calls the removed API today. The changelog still names the removed API.
- `exposure.md:53` requires that a user operation run a declared command; the Escape fallback reaches `core.layer.dismiss` through the registry, which is why the command is declared.

### Required changes

| ID | Owner | Change |
|---|---|---|
| D6-a | `feat`: `packages/plugin-api/view.js:139-164,331`, `packages/plugin-api/terms.json:394`, `packages/workbench/view-calls.js:15,86-88,199-212`, `packages/workbench/surface-modules.js:21,287`, `docs/spec/events.json:690,699`, the three class tables, `native-surfaces.md:141`, `exposure.md:71`, `docs/plans/plugin-processes.md:113-123,162-163,190`, `CHANGELOG.md:8`, `docs/features.md:1239`, and their ko; `main`: `docs/spec/native-surfaces.md:137`, `plugin-processes.md:94-103,141-142,166`, `exposure.md:67,94-95` and ko, `packages/workbench/shortcuts.json:24-25`, `scripts/test/shortcut-table.test.mjs` | Remove the table path, API, events, and the spec and term text of step 3. |
| D6-b | `feat`: `packages/plugin-api/test/view.test.mjs:394-419`, `packages/workbench/test/view-calls.test.mjs:13,278-310`, the `shortcuts` option in `fakes()`; `packages/workbench` tests of `core.layer.dismiss` | Delete the table tests. Add: a keydown in a view is never prevented and makes no `runtime.shortcuts.*` call (Red on current code). Add the Escape tests: (a) a page picker open, one view Escape closes it once; (b) a view handler that calls `preventDefault` dispatches no call; (c) no layer open, `core.layer.dismiss` is a no-op; (d) a native modal holding focus gets no dispatch from the view. |
| D6-c | `feat` (probe) | macOS probe for each overlay (page picker, native picker, modal) with view focus: the expectation of step 4 is confirmed or corrected; cmd+k and shift+cmd+n with view focus. Linked to F212.6a. |
| D6-d | `main`: `packages/workbench/shortcuts.json:17-18`, `docs/spec/exposure.md:87-88` and ko | Narrow the `when` text now (step 5), in one commit. |
| D6-e | `main` (`docs/features.md`, F238-b record) | Record the sibling check of step 3 (no match in the five plugin checkouts) with the removal, and the breaking changelog line. |
| D6-f | `main`: `docs/features.md` entries F212.6a and F212.7 (+ko) | Re-scope F212.6a (the table gate is removed; the Escape measurement remains under D6-c) and F212.7 (no table gate). |
| D6-g | `main`: `packages/workbench/core-exposure.js` (`registry.command("core.layer.dismiss")`), `packages/workbench/exposure.json`, regenerated `packages/plugin-api/core-exposure.json`, `docs/spec/native-surfaces.md` (view-call list, with `runtime.dismiss`), `exposure.md:53` (no change; the rule is the reason); `feat`: `packages/plugin-api/view.js` (bubble-phase Escape, `!defaultPrevented`, sends `runtime.dismiss`), `packages/workbench/view-calls.js` (case `runtime.dismiss` runs `core.layer.dismiss` through `runCore`) | Implement the Escape fallback of step 4. |

### Rounds

#### Round 1 (answers)

| Objection | Answer |
|---|---|
| C1: files omitted | Accepted; listed in step 2, 3 and D6-a. |
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
| E2: stale sites (terms, plugin-processes lines, feat plan lines) | Accepted; step 3, D6-a. The contract case at `:166` is removed. |
| E3: Korean mirrors incomplete | Accepted; D6-a lists every ko mirror. |
| E4: no replacement sentence for `feat` `exposure.md:71` | Accepted; the paragraph is deleted (step 3). |
| E5: `exposure.md:67` "handles inside itself" remains | Accepted; step 3. |
| F1: Escape fallback internally inconsistent | Accepted; round 2 shipped the fallback; round 4 keeps it and makes it complete. |
| F2: `runtime.dismiss` is not a declared command | Accepted; round 4 step 4: the view call routes to the declared `core.layer.dismiss`. |
| F3: double-close and Escape stealing | Accepted; round 4 step 4 and D6-b (a) to (d). |
| F4: rule-7 F212.6a gate dropped without replacement | Accepted; D6-f re-scopes F212.6a and F212.7. |
| F5: public API removal not shown safe | Accepted; sibling checkouts searched, no match (Reasons). D6-e. |
| F6: cmd+k and shift+cmd+n narrowing waits for the probe | Accepted; step 5 narrows now (D6-d). |
| F7: the view's own keys must keep handling inside the view | Accepted; step 1. |

#### Round 3 (answers)

| Objection | Answer |
|---|---|
| D6-1: D6-d narrows the spec but not `shortcuts.json:17-18` that the test checks | Accepted; step 5 and D6-d include `shortcuts.json:17-18` in one commit. |
| D6-2: rows 24-25 of `shortcuts.json` are not owned; row 24 text contradicts the Escape call | Accepted; D6-a owns `shortcuts.json:24-25`; step 3 gives the new text, and `exposure.md:94` matches it. |
| D6-3: the Escape fallback has no required-change row | Accepted; D6-g. |
| D6-B1: `runtime.dismiss` is a raw call, not a declared command (`exposure.md:53`) | Accepted; step 4: the bridge route runs the declared command `core.layer.dismiss`. |
| D6-B2: the fallback fires on the view's own Escape UI | Accepted; step 4: `!defaultPrevented` in the bubble phase; D6-b (b). |
| D6-B3: sibling plugin check is not complete | Accepted; the check is run and recorded (Reasons; D6-e). The removal is recorded as breaking. |

## Sub-items

Registered in `docs/features.md` under F212 as F238-b-1 to F238-b-N, one per row above.

## To record elsewhere

Each row names its owner. Rows owned by `main` are changes to be made on `main`; rows owned by `feat/view-bridge-F231` are changes to be made on that branch.
