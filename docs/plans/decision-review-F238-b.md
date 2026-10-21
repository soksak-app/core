# Decision review F238-b: view log levels and view shortcut table

[한국어](decision-review-F238-b.ko.md)

This record reviews two decisions taken on branch `feat/view-bridge-F231` without adversarial verification:

- D5 (F233): the view bridge learns the stored log levels by a request on first use.
- D6 (F234): the view registers a shortcut table and passes workbench keys to the command path.

Each decision states its text, reasons, evidence with file and line, and the change it requires. Auditors are fresh subagents (Haiku); each gives substantive objections with a concrete solution. Wording and citation corrections are applied directly. Each round is recorded below. Rounds repeat until both auditors of a round have no substantive objection.

Citations: `feat` is `feat/view-bridge-F231`; `main` is `main` of this repository.

## Scope

- D5: which levels a view page gates with, how the levels reach the view, how refused records are counted, and which request paths are removed.
- D6: whether the view needs a shortcut table, and which key the view prevents.

Out of scope: wording, the exact names of new fields (fixed by the sub-items), and behaviour that the unit tests of the owning modules settle.

## D5. View log levels (F233)

### Original decision

`feat` `packages/plugin-api/view.js:116-135`: the bridge calls `runtime.log.levels` on the first record (`storedLevel`, line 127), sends every record while `levels === null` (line 135), and reports a refused read as an error line (`recordError`, line 116). The page answers the request from the levels of the plugin record (`packages/workbench/view-calls.js:184-187`). Each change arrives as the event `log.levels` (`view.js:130-131`; `surface-modules.js:261-264`, `:308`; `view-events.js`).

### Decision text (round 2)

1. **The host builds the start values from the policy it holds.** On creation and on restart the host injects into `window.sokSurface` (`ViewStart`, `packages/host/tauriv2/src/surfaces.rs:61`, `packages/host/wailsv3/src/surfaces.go:66`) two required members:
   - `logPolicy`: the five classes of [classes and policy](../spec/logging.md#classes-and-policy) with the values `off`, `error`, `warn`, `info`, `debug`, `trace`, taken from the policy in force in the host (the file `log-policy.json`, or the default when no file exists; `log_policy.rs`).
   - `logClasses`: each full event name `plugin.<id>.<event>` of the surface's plugin, mapped to its class, taken from the catalog that the host already reads at start (`PluginEventClasses`, `packages/sok/wailsv3/src/plugin_catalog.go:21`, `packages/host/wailsv3/src/installed.go:463`; the Rust reader is its counterpart), filtered by the prefix `plugin.<id>.`.
   A start without either member is refused with `view start is missing logPolicy` or `view start is missing logClasses`, in each host and in `createSurfaceContext`. [Host contract](../spec/host-contract.md) line 196 gains both members; they are new, not existing.
2. **The view gates per record.** The hook `logEnabled` receives the event name, so the view decides a record from `logPolicy[logClasses[event]]`. A plugin record whose name is not in `logClasses` is an undeclared event: it is gated at the default level `error`, marked `undeclared`, and counted, as [logging](../spec/logging.md#classes-and-policy) line 13 requires for an undeclared event. `log.enabled(level)` answers true when some class of the plugin stores the level.
3. **Refused records are counted in the page batcher.** A refused record is counted by class and level in the view. The counts leave as the call `runtime.log.gated {class, level, count}`; the page adds them to the batcher's gated map (`batcher.countGated`, `packages/workbench/log-batch.js`), and they are reported as `page.log.gated`. The view sends pending counts when a second has passed since the earlier report, with the next stored record, and on `pagehide`. Counts still pending when a view process is killed are lost; the host writes `host.view.log-counts-lost {surface, plugin}` with no count, so the loss is recorded though its size is not known. The one-second bound is the only timer, because no event source reports a count.
4. **Changes reach the view through the existing event.** The host already emits `log-policy {classes}` to every surface document, and a surface document applies it to its gate ([logging](../spec/logging.md#policy), Documents; `packages/host/tauriv2/src/log_policy.rs:109,120`). The view applies the same event to `logPolicy`. If `log-policy` does not reach a view created by the host, the host posts the same payload to the ready view at each `log-policy` emit; the change check is part of D5-c. No new surface call is added.
5. **Removals.** The first-use request (`view.js:125-135`), `runtime.log.levels` (`view-calls.js:184-187`), the `log.levels` event and its subscription in `view-events.js`, `subscribe.logLevels` and `surface-modules.js:261-264`, `:308`, and the spec lines (`native-surfaces.md:113`, `:120`, `:127`; `plugins.md:170`, and ko) are removed. Tests `view.test.mjs:370-384`, `view-calls.test.mjs:61,210-214`, `view-events.test.mjs:48-52` move to the new path.
6. **`recordError` reports.** When the error record itself fails, `recordError` calls the bridge's `report` function with `{where, text, error}` (`view.js:89-90`); no failure is silent.
7. **Supersession.** This decision supersedes [logging](../spec/logging.md#policy) lines 71 and 74 for views: a view with a start record receives its policy in its start values and has no default window. The default error-only policy stays for a page without a host and for a host with no policy file. D5-f changes the two lines.

### Reasons and evidence

- The original rule sent every record before the answer (`view.js:135`). That contradicts the default that `logging.md:74` gives a surface, and it sends IPC for records the policy refuses (`logging.md:10`). Start values remove the window: the host holds the policy before it creates the view.
- The gate on `main` starts at `error` until the first settings refresh (`packages/workbench/log-gate.js:23-24`; the only caller of `setLogPolicy` is `settings.js:458`). A start built from the page gate could therefore be stale. The host builds it from its own policy, so it is not.
- `plugin-runtime.js:72` (`if (!enabled(level)) return;`) drops a refused record without a count, and `enabled` calls the hook with the level only (`plugin-runtime.js:59-63`). Passing the event to the hook (D5-g) and counting in the view (step 3) fix both.
- `classOf` (`packages/workbench/event-classes.js:137`) has no plugin entries on `main`; the class of a plugin event comes from the host's catalog reader instead (step 1).
- `log.levels` delivered an array (`view-events.js`, `view.js:131,135`). The new data is the policy object; the array form is removed with it.

### Required changes

| ID | Owner | Change |
|---|---|---|
| D5-a | `main`: `packages/host/tauriv2/src/surfaces.rs`, `packages/host/wailsv3/src/surfaces.go`, `docs/spec/host-contract.md:196` and ko, `docs/spec/events.json` (`host.view.log-counts-lost`) | Host builds and injects `logPolicy` and `logClasses` at creation and restart; refusal texts in host and `createSurfaceContext`; the new event declared. |
| D5-c | `feat`: `packages/plugin-api/view-events.js` and `view.js` (apply `log-policy`); `main`: host event delivery | Check that `log-policy` reaches a host-created view. If it does, the view applies it; if not, the host posts the same payload to the ready view on each `log-policy` emit. |
| D5-d | `feat`: `packages/plugin-api/view.js` | Count refused records by class and level; send `runtime.log.gated` at the timer and on `pagehide`. |
| D5-e | `feat`: `view.js:125-135`, `view-calls.js:184-187`, `view-events.js` (`log.levels`, `subscribe.logLevels`), `surface-modules.js:261-264`, `:308`, `native-surfaces.md:113,120,127`, `plugins.md:170`, ko mirrors; tests `view.test.mjs:370-384`, `view-calls.test.mjs:61,210-214`, `view-events.test.mjs:48-52` | Remove the first-use request, `runtime.log.levels`, the `log.levels` event and its subscription. |
| D5-f | `main`: `docs/spec/logging.md:71,74,76` and ko | State the view rule (start values, no default window) and the undeclared-event rule for plugin records. |
| D5-g | `feat`: `packages/plugin-api/plugin-runtime.js:59-72` and tests, `packages/plugin-api/test/surface.test.mjs:142,172,195-198` | `logEnabled(level, event)`; `log.enabled(level)` = some class stores the level; undeclared events gated at `error` and marked. |
| D5-h | `main`: `packages/workbench/log-batch.js` (`countGated`), `packages/workbench/view-calls.js` (`runtime.log.gated`) | Batcher accepts counts from a view; the same gated map and timer. |

### Rounds

#### Round 1 (answers)

Two auditors (A: D5 gate and owners; B: D5 changes and gaps). Each objection was checked in the files.

| Objection | Answer |
|---|---|
| A1: gate never gets the event | Accepted. Step 2; D5-g. |
| A2: counts have no entry into the batcher | Accepted. Step 3; D5-h. |
| A3: plugin catalog owner and key format | Accepted. Host reader exists (`plugin_catalog.go`, `installed.go:463`); keys are full names; step 1; D5-a owns it. Plugin repositories are not needed. |
| A4: start values can be stale | Accepted. Host builds from its own policy; step 1. |
| A5: change path duplicates `log-policy` | Accepted in part. `log-policy` already reaches surface documents (`log_policy.rs:109,120`); step 4 reuses it. Whether it reaches a host-created view is a check (D5-c). |
| A6: `log.levels` shape and owners | Accepted. `log.levels` removed; D5-e owns the removal. |
| B1: gate change hook | Accepted as moot: no page-side change path is used now; `onChange` (`feat` `log-gate.js:59-64`) is removed with D5-e only if unused, and D5-c decides it. |
| B2: `host-contract.md:196` cited as existing | Accepted. The members are new (step 1; D5-a). |
| B3: unclassed records bypass the policy | Accepted. Step 2: gated at `error`, marked `undeclared`, counted (`logging.md:13`). |
| B4: supersession misstates the spec | Accepted. Step 7 is rewritten; D5-f changes `logging.md:71` and `:74`. |
| B5: parallel delivery path | Same as A5: reuse `log-policy`. |
| B6: final counts lost silently | Accepted in part. Pending counts are sent on `pagehide` and each second; a kill loses at most one second of counts, recorded as `host.view.log-counts-lost` (step 3). The loss is not silent. |

Wording: the line of `sends every record while levels === null` is `view.js:135`; corrected.

## D6. View shortcut table (F234)

### Original decision

`feat` `packages/plugin-api/view.js:139-164`: the view registers a shortcut table read from the page (`runtime.shortcuts.read`, answered by `viewShortcuts`, `packages/workbench/view-calls.js:86-88`). A keydown whose row has owner `workbench` is prevented and passed on (`runtime.shortcuts.run`, `view.js:153-158`, `view-calls.js:205-212`). Before registration the first key sends `runtime.shortcuts.missing` (`view.js:143-147`), recorded as `page.view.shortcut-table-missing`. The bridge exports `shortcuts.register()` (`view.js:160-164`, returned at `:331`).

### Decision text (round 2)

1. **The view prevents no key.** `viewShortcuts` keeps only rows whose `when` is `Any focus` (14 rows, all owner `native menu`) or whose owner is `view` (`Escape`, `command: none`; text input keys). No row of owner `workbench` reaches the view table, because the workbench rows have other contexts (`packages/workbench/shortcuts.json:17-23`). The view prevents no default action today.
2. **The table path is removed, with its public API.** Removed:
   - the keydown listener and `shortcutTable` (`view.js:139-159`);
   - `shortcuts.register()` and its return (`view.js:160-164`, `:331`); no caller exists in `packages/` outside `view.js`, so the removal is complete in-repo, and a plugin that calls `shortcuts.register()` is broken by the removal, not given a no-op;
   - the page side: `viewShortcuts` and cases `runtime.shortcuts.read`, `.missing`, `.run` (`view-calls.js:86-88`, `:199-212`), the import of `shortcuts.json` and the `shortcuts` option (`surface-modules.js:21`, `:287`, `view-calls.js:15`);
   - the events `page.view.shortcut-table-missing` and `page.input.shortcut.failed` (`docs/spec/events.json:690`, `:699`) and their rows in the class tables (`packages/sok/tauriv2/src/event_classes.rs:167`, `packages/sok/wailsv3/src/event_classes.go:125`, `packages/workbench/event-classes.js:112`), regenerated.
   AGENTS.md: remove obsolete code paths; a dormant table is not kept.
3. **No workbench row holds in a view.** A workbench row that must hold while a view has focus needs its own decision, path, test and evidence.
4. **Spec text.** The view-shortcut sentences are rewritten to "a plugin view prevents no key": `native-surfaces.md` Input (`main:137`; `feat:141`), `plugin-processes.md` rule 7 (`main:94-100`; `feat` `docs/plans/plugin-processes.md:113-122`), `exposure.md:67`, `:71` (`feat`), `:94`, `:95` on `main`, and their ko mirrors. `shortcuts.json` rows 24-25 change their `when` text to "A plugin view has keyboard focus; the view handles it itself". `scripts/test/shortcut-table.test.mjs` is updated in the same change. The changelog (`CHANGELOG.md:8`, `CHANGELOG.ko.md:8`) and `docs/features.md:1239` state that the F234 table path is removed and superseded.
5. **Escape with view focus: known outcome from the code.** The picker's Escape listener is attached only while a picker is open (`packages/workbench/plane.js:745-746`), and it receives keys only while the page has focus. The view row `Escape` (`owner: view`) handles nothing. So Escape in a view does not close a page picker, and the expectation is stated as this known outcome, not as a probe result. Native picker and modal WebViews answer Escape themselves (`packages/workbench/picker-layer.js:98-99`, `card.js:25-28`), so the case differs for them; the probe covers that.
   **Fallback fixed in advance:** the view sends the call `runtime.dismiss` on Escape (no default prevented); the page closes the open layer with `core.picker.close` or `core.modal.dismiss`, or does nothing when none is open. This is a new path and needs its own Red test. The probe (D6-c) confirms whether the fallback is needed for each overlay; the F212.6a Escape measurement covers the same case and is linked, so one probe serves both.
6. **cmd+k and shift+cmd+n with view focus.** `cmd+k` (`core.focus.set`, `shortcuts.json:18`) and `shift+cmd+n` in browser builds (`:17`) are handled only by the page keydown, so with view focus they do not reach the page. The spec states them without a view qualifier (`exposure.md:87-88`). Probe case in D6-c; if the gap is confirmed, D6-d narrows the `When` text to "The library is shown and the page has keyboard focus" (en and ko).

### Reasons and evidence

- `viewShortcuts` never returns an owner `workbench` row, so `runtime.shortcuts.run` refuses every key (`view-calls.js:205-212`, "is not a workbench shortcut of a view"). A path that cannot succeed is obsolete.
- The table gives the view nothing it uses: `native menu` and `view` rows keep their default action, which the view does not prevent anyway.
- The original argument (one table is the source of bindings) does not hold while the table has no workbench row.
- The Escape case (step 5) and the cmd+k case (step 6) are existing behaviour; removing the table does not change them.

### Required changes

| ID | Owner | Change |
|---|---|---|
| D6-a | `feat`: `packages/plugin-api/view.js:139-164,331`, `packages/workbench/view-calls.js:15,86-88,199-212`, `packages/workbench/surface-modules.js:21,287`, `docs/spec/events.json:690,699`, the three class tables, `native-surfaces.md:141` and ko, `docs/plans/plugin-processes.md:113-122`, `exposure.md:71`, `CHANGELOG.md:8`, `CHANGELOG.ko.md:8`, `docs/features.md:1239` and ko; `main`: `docs/spec/native-surfaces.md:137`, `plugin-processes.md:94-100`, `exposure.md:67,94,95` and ko, `scripts/test/shortcut-table.test.mjs` | Remove the table path, its API and events; state that a view prevents no key. |
| D6-b | `feat`: `packages/plugin-api/test/view.test.mjs:394-419`, `packages/workbench/test/view-calls.test.mjs:13,278-310`, `shortcuts` option in `fakes()` | Delete the table tests. Add a test: a keydown in a view is never prevented, no `runtime.shortcuts.*` call is made, and no event is emitted (Red on the current code: the listener calls `runtime.shortcuts.missing`). |
| D6-c | `feat` (probe, then fix) | Probe on macOS: Escape with a view focused and (a) a page picker, (b) a native picker and (c) a modal open; cmd+k and shift+cmd+n with view focus. Fallback `runtime.dismiss` per step 5. Linked to F212.6a. |
| D6-d | `main`: `docs/spec/exposure.md:87-88` and ko | Narrow `When` to the page-focus condition if D6-c confirms the gap. |

### Rounds

#### Round 1 (answers)

Two auditors (C: D6 completeness; D: D6 against removal). Each objection was checked in the files.

| Objection | Answer |
|---|---|
| C1: files omitted (surface-modules, view-calls doc, events, class tables, changelog, plan lines) | Accepted; all listed in step 2, 4 and D6-a. |
| C2: test list incomplete (278-286, 288-293, fixture row :13, fakes) | Accepted; D6-b. |
| C3: view-owner rows keep stale text | Accepted; step 4 rewrites `when` of rows 24-25 and the `exposure.md` copies. The two rows stay because `shortcut-table.test.mjs` tests the owner. |
| C4: Escape open item misdescribed; no fix path | Accepted; step 5 states the code-derived outcome and the fallback fixed in advance. |
| D1: `shortcuts.register()` API left in place | Accepted; step 2. |
| D2: other spec sentences (`exposure.md:67,94,95`) | Accepted; step 4. |
| D3: Escape item described as if a handler existed | Accepted; step 5. |
| D4: cmd+k and shift+cmd+n overstated | Accepted; step 6, D6-d. |

## Sub-items

Registered in `docs/features.md` under F212 as F238-b-1 (D5-a) to F238-b-12 (D6-d), one per row above.

## To record elsewhere

Each row names its owner. Rows owned by `main` are changes to be made on `main`; rows owned by `feat/view-bridge-F231` are changes to be made on that branch.
