# Plugin processes: remaining work

[한국어](plugin-processes-handoff.ko.md)

This document lists the remaining work of F212 (plugin code outside the main page) and of the open items beside it. It also says how to do and verify each item. A session can start from this document, AGENTS.md and the files it names, without any other context. Remove this document when F212.15 is released.

## Sources of truth

| Topic | File | Where |
|---|---|---|
| Process rules, the checklist rules, Red/Green, commit form | `AGENTS.md` (+ `.ko.md`) | main |
| Checklist of main | `docs/features.md` (+ `.ko.md`) | main |
| Checklist of the F212 work | `docs/features.md` on branch `feat/view-kind-F212.7` | branch |
| Decided design of F212: the layers, the rules 1 to 10, the pass values (i) to (viii), the review records | `docs/plans/plugin-processes.md` (+ `.ko.md`) | branch, older copy on main |
| Declared UI contract (list, tree, button, status-line, sections, addresses, rejections) | `docs/spec/declared-ui.md` (+ `.ko.md`) | branch |
| Exposure contract (commands, statuses, dom, `address`, errors) | `docs/spec/exposure.md` | branch is newer |
| Build, test parity, window checks, diagnostics | `docs/operations/examples.md` | both |
| Private WebKit APIs and their call conditions | `docs/operations/private-native-apis.md` | both |

Read the branch copy of a file whenever the branch has one. The branch holds most of the F212 work, and main does not show it until the branch merges.

## Repository state

### Branches and worktrees

| Branch | Worktree | State | Next step |
|---|---|---|---|
| `main` | `core` | pushed, clean | — |
| `feat/view-kind-F212.7` | `../core-view-kind-F212.7` | published on origin; all F212 view and declared UI work | continue items below; merge into main only after the F212 core items and F212.7-9 |
| `fix/lock-drops-F218-2-2` | `../core-lock-drops-F218-2-2` | F218-2.2 committed and rebased on main; `make push-check` passed | resolve the failing test below, then merge into main and remove the worktree and the branch |
| `feat/settings-G1.4-87-1` | `../core-settings-G1.4-87-1` | held item | do not touch |
| `fix/background-launch-V5-117-1-3-4-7-1-8` | none | held item | do not touch |

Two annotated tags keep the commits of two superseded branches; `git tag -l` lists them.

### Uncommitted work in `../core-view-kind-F212.7`

F212.8-6-3 (the source and transitions of a declared section) was in progress when work stopped:

- new, untracked: `packages/workbench/declared-section.js` and `packages/workbench/test/declared-section.test.mjs` (10 tests, passing with `node --test`);
- modified, not committed: `CHANGELOG.md`, `CHANGELOG.ko.md`, `docs/features.md`, `docs/features.ko.md`, `docs/operations/examples.md`, `docs/operations/examples.ko.md` (record lines and the recorded test counts).

The work has no recorded Red and has not passed `make push-check`. Review it against declared-ui.md "Status mapping" and transitions (a) to (d). Record a Red by running the tests against the module with the behavior removed, then finish, commit and push. Otherwise delete both new files and restore the modified files with `git restore`.

### The failing test that blocks F218-2.2

A full run of `make rust-repeat PACKAGE=soksak-host-tauriv2 COUNT=1` on `fix/lock-drops-F218-2-2` failed once in `tests/sidecars_test.rs`, at a load average of 27 to 42:

```
surface_open_clears_the_restart_limit
the opened surface recorded no host.trace.sidecar.restart-reset
```

The same test passes alone three of three times (`make rust-repeat PACKAGE=soksak-host-tauriv2 COUNT=3 TEST=surface_open_clears_the_restart_limit`). The test belongs to F212.8a. F218-2.2 changed `sidecars.rs` (the sidecar state lock recovery). Register an item, then:

1. Run `make rust-tests-alone PACKAGE=soksak-host-tauriv2` and `make rust-repeat PACKAGE=soksak-host-tauriv2 COUNT=3` on main and on the branch. This shows whether the failure depends on test order or on F218-2.2.
2. The test reads trace records through a shared event log. Check whether another test in the same binary writes or drains the same log; `useEventLog` in the Go tests is the isolated pattern.
3. Fix the cause, with a Red from the cheapest run that shows the failing assertion and a Green from the owning tests. The full-suite acceptance runs once after the checklist completes, not now. Then merge F218-2.2.

### Sidecar repositories

| Repository | Open | Note |
|---|---|---|
| `../sidecars/files` (origin `soksak-app/sidecar-files`) | S31: write a log record as the first action of the process, before any setup | It measures the 12.4 s gap of F212.1-2-2 between the spawn and `log.open`. S26 to S30 are committed. |
| `../sidecars/shell` (no remote) | none | S10 to S15 are committed. |

Both sidecar releases follow the core release (F212.15). F212.1-2-2-3-1 stays open until both are published.

## How to work

### Every item

1. `git fetch` and read the checklist on origin first.
2. Classify the request, register the item (EN and KO), and update the specification first when the contract changes.
3. Write the test at the owning module. Run it on the unchanged code and record the failing assertion (Red). A missing module, a compile error or a link error is not Red. When the code already has the behavior, disable it on a copy to see the assertion fail, then restore the file.
4. Implement, then run the same test (Green).
5. Run the owning tests and the structural checks the change touches, then `make push-check` on the committed tree.
6. Mark the item `[o]` with its Red and Green, and add CHANGELOG entries in EN and KO.
7. Commit with author `min-0-max <max@blue.tools>` and `type(scope): Subject (#ID)`. The subject has at most 50 characters. The body states what changed and why, wrapped at 72 columns. There is no footer and no trailer. The commit-msg hook rejects other forms. Stage explicit paths only; never use `git add -A`.

### Branches and worktrees

- Work on `main` directly by default. For isolation use the branch `{type}/{shortname}-{ID}` and the worktree `../core-{shortname}-{ID}`.
- Remove the worktree and the branch right after a merge into main succeeds. Never remove an unmerged one.
- Run `make hooks`, `make native-darwin` and `make frontend-tauriv2` in a new worktree before tests.
- `feat/view-kind-F212.7` is published. Sync it with `git merge origin/main` and never rebase or force-push it. Before each push run `git rev-list --count HEAD..origin/main`, and merge first when the count is not zero.
- On a CHANGELOG conflict keep both entries. On a conflict of the recorded counts in `docs/operations/examples.md`, use the count that `make parity-check` prints for the merged tree.
- After a worktree moves, the Tauri build cache keeps old paths and clippy fails. Run `cargo clean -p tauri -p soksak-tauriv2` in the worktree.
- Gate commands with `&&`. A pipe or a grep does not stop a chain.

### Adding a test file

- Claim it in `scripts/check-test-parity.mjs` (its lane), then update the recorded counts in `docs/operations/examples.md` (+ko) to the output of `make parity-check`.
- A Rust test with no Go counterpart needs an allowed-difference row in `docs/spec/hosts.md` (+ko) and `scripts/check-hosts.mjs`. Row H13 lists the lock tests.
- A completed capability needs its feature link in `scripts/check-test-parity.mjs`.

### Test commands

| What | Command |
|---|---|
| One Node test file | `node --test packages/<pkg>/test/<file>.test.mjs` |
| Repeat a Node test | `make node-repeat FILE=<file> NAME=<pattern> COUNT=<n>` |
| Go tests | `make go-repeat PACKAGE=./packages/host/wailsv3/tests COUNT=1 [TEST=<regexp>]` (also `./packages/sok/wailsv3/tests`, `./packages/host/wailsv3/src`) |
| Rust tests | `make rust-repeat PACKAGE=soksak-host-tauriv2 COUNT=1 [TEST=<name>]`, and `PACKAGE=soksak-sok-tauriv2` |
| Rust order dependence | `make rust-tests-alone PACKAGE=<package>` |
| Native tests | `make -C native/darwin repeat TEST=<name>_test COUNT=<n>` |
| Docs, links, translations, records | `make docs-check` |
| Exposure names | `make exposure-check` |
| Event catalog | `make events-check` |
| Host file pairs and allowed differences | `make hosts-check` |
| Test inventory | `make parity-check` |
| Core names no plugin | `make boundaries` |
| Census rules | `make census-check` |
| Push gate (records, structure, format, clippy, gate tests) | `make push-check` |
| View process benchmark | `make -C native/darwin benchmark-view-processes` |

Full suites (`pnpm test`, `make native-test`, `make host-contract-check`, `make verify`, the window suites) are not run to complete an item; they run once after the checklist completes, before the release. During development run only the unit tests of what changed; repeat targets of an intermittent failure also wait for that final pass.

### Window checks and measurements

Window checks are end-to-end checks of the applications with installed plugins. `docs/operations/examples.md` "Window checks" says how to build both applications, start them with `--config-dir` and `--registry-ca` on disposable configurations, and run `pnpm -F @soksak/e2e verify` or one file. The rules:

- Connect through `<config-dir>/endpoint.json`. Use declared exposure entries and native input only. Wait on status notifications, never on timers.
- Never activate or focus a window. Capture with `diagnostics.capture.still`, and record with `diagnostics.capture.start` and `diagnostics.capture.stop`. Inspect images at original resolution. An image is observation, not a pass result.
- For visual or time behavior, record the whole gesture and derive the measured frame gaps and coordinates as tracked evidence.
- Every application error during a check fails it unless the check declares it with `expectError`.
- The input method checks (`make -C native/darwin test-activation`, `pnpm -F @soksak/e2e verify:activation`) run only with the person's approval.
- A time limit missed by less than 100 times its expected value on a loaded machine is load: record the load and the time, and complete the item.

### Decisions that need a review

When a decision rests on a new argument, run an adversarial review by agents:

1. Before the first round, write the scope: what the document must decide, what counts as a core objection, and what is out of scope (wording, cases every implementation resolves the same way, details that the unit tests settle).
2. Each objection names the exact sentence (file, line, quoted text) and the replacement.
3. Check each objection in the files yourself, then accept it or rebut it. A rebuttal with its reason goes back to the same auditor until both agree.
4. Use new auditors for each round, at most 5 rounds. Write the objections and the answers in the related document.

## Remaining items

The order below follows the dependencies. IDs are checklist IDs.

### 1. Main items beside F212

**F218-2.2** — merge it after the failing test above is resolved.

**F218-2.3** — 100 lock results that map a poisoned lock to an error (`map_err`, `ok()`, `?`) in the Rust host and in the sok crate.
- Change: recover each with `PoisonError::into_inner` and a `// default:` reason on the line above the call: the panic hook installed first records the panic (`docs/spec/logging.md`). Group one module per commit.
- Test: for each module with a seam, poison the lock in a spawned thread, then show that the operation returns its value. Red is the old error result.
- Find the sites with `make census-check` (rule `rs.lock-result`).

**F218-2.4** — 86 lock results that call `unwrap` or `expect`. Same change and test; Red is the panic of the calling thread.

**F218-2.5** — enable `rs.lock-result` with zero findings, and remove its pending entry in `scripts/census.json`. Green is `make census-check` with zero findings. Then mark F218-2 `[o]`.

**F212.1-2-2** — the fixture reply waited 12.4 s for the first answer of the files sidecar. `host.trace.sidecar.ready` (F212.1-2-2-6) measures spawn to first answer. Do S31 in the files sidecar first. Then repeat the window check of F212.1-2 with the trace on, and read `host.trace.sidecar.ready` and the sidecar's first record. If the gap is before the sidecar's first record, the cause is the start of the process (the binary launch); record the measured time and its cause. If the gap is inside the sidecar, fix it there.

**F212.1-3** — the recorded DOM mount baseline of pass value (iii). For each installed surface plugin, record the main page from the surface start request to the first content frame (`diagnostics.capture.start/stop`), and take the median of 5 runs with the load average. Make it a tracked window check under `e2e/`, and write the result in the plan table "F212.1-2".

**F212.6a-1-3-2-2** — the cause of the 2.4 s main-thread stall of the Tauri host. The findings are in the item. Stall dumps of 2 s or more are now stored by default (F212.6a-1-3-2-1). When the next one appears, symbolicate the WebKit frames with `atos -o /System/Library/Frameworks/WebKit.framework/Versions/A/WebKit -l <load address> <addresses>`; it resolves through the dyld shared cache when the OS build matches the dump. Then name the thread that holds `IPC::Connection` `m_incomingMessagesLock` and the run loop lock. Mark the parent F212.6a-1-3 when its children are complete.

**F212.8a-4** — the restart limit of persistent services (`docs/spec/terminal-runtime.md`, one attempt per disconnect). This is a decision first: which event counts as a failure of a persistent service. A disconnect that the host re-attaches without a send is not a failure event today. Write the scope, run the review, then specify and implement it in both hosts with a contract case. Reuse the stdio limit of F212.8a (Go `Sidecars.Now`, Rust `Sidecars::with_clock`, `host.sidecar.restart-limit`, `host.trace.sidecar.restart-reset`).

### 2. Branch `feat/view-kind-F212.7`: checklist states

Several parent items stay `[ ]` although all their children are `[o]`: F212.3, F212.4, F212.6 and F212.7 (whose open children are F212.7a, F212.7b-1, F212.7c, F212.7d-1 and F212.7-9). Read each parent's children and set the parent by the rule: `[o]` only when every child is complete and verified, `[~]` only while a child is `[~]`.

### 3. Declared UI (F212.8)

Done: F212.8-0 (the spec, closed after round 20), F212.8-1 (list), F212.8-1-1 (keyed redraw), F212.8-2 (tree), F212.8-4 (button), F212.8-5 (status-line), F212.8-6-1 (manifest `status` sections), and F212.8-6-2 (`address` in `dom.rect` and `dom.act`). The code is in `packages/workbench/declared-ui.js` with `test/declared-ui.test.mjs` (56 tests).

**F212.8-6-3** — the source and transitions of a declared section; see "Uncommitted work" above.
- The source is the active tab view of the card that registered the status, then the plugin host, otherwise cleared. A state-module registration does not serve.
- Transitions (a) to (d), including the plugin override start and stop.
- The pulls happen at main page load, at a change of source and at a change of orientation.
- Discard a snapshot or a pull reply from a pair that is not the chosen source, and a pull reply with a lower seq.
- Call hideError on a change of source, a process end and a surface close.
- Test with fakes for the registrations. Where a production channel does not exist yet, list it in the item.

**F212.8-6-4** — draw and report the section: the element and its header (`core.sidebar.section.header`), the rejection text from `showError`, the horizontal layout, the orientation re-check, and the `core.sidebars` fields `mounted`, `error`, `text` and `controls`. Then mark F212.8-6.

**F212.8-7** — a tracked benchmark of the workbench draw time of 5000 tree nodes and 1000 list items. If the result requires another limit, change declared-ui.md in a new item.

### 4. Plugin host (F212.9)

F212.9 is required, because a plugin whose sidebar section shows values while none of its views is open needs a plugin host (declared-ui.md, source order). The plan names the files state as the first case.
- Spec first: plan native gap 3 (a platform operation that creates a plugin host web view attached to the window, not to a surface host), gap 7 (owner key `plugin:<id>`), and rule 5 (restart within limit (vi), state restored from the last saved value).
- F212.9a: measure the footprint and the throttle of a hidden host web view before F212.10.
- Implement in native/darwin and both hosts, with contract cases, Go and Rust tests, and a native test. The view channel code of F212.7-2 is the pattern for the host channel.

### 5. Plan into specifications (F212.7-9)

Before the branch merges: move the accepted contract of `docs/plans/plugin-processes.md` into a new `docs/spec/plugin-processes.md` (+ko). Repoint every link, including `packages/plugin-api/terms.json` and `docs/spec/declared-ui.md` line 11, and remove the plan. Decide where the review records go: the specification has no history, so they go to the changelog entries or are dropped.

### 6. Plugin moves (F212.10)

Each move is an item of its own plugin repository, made against the branch. The plan table "Layers and placement" gives the target of each plugin:

| Plugin | Surface | Section | State | Sidecar |
|---|---|---|---|---|
| editor | view (text input, IME) | — | — | files |
| flowmark | view | — | — | its own |
| shell | declared UI if the vocabulary expresses it, otherwise view | — | — | shell |
| files | — | declared tree, or a view when it needs rename, drag or a context menu | files sidecar, otherwise plugin host | files |
| hwp | view with a document region | — | — | files |
| browser | view with a document region | four sections as declared UI or card surfaces | — | — |
| terminal | view with an image region | — | — | vt |

- Core names no plugin in code or tests (`make boundaries`). Each plugin repository checks its own sources.
- Each plugin item measures its view before its release: (iii) first display, (v) display after a layout change, (viii) drag. Each plugin release follows the core release.
- F212.10-editor comes first, and F212.7a measures pass values (i), (ii), (iii), (iii-b), (v) and (viii) on that first editor view.

### 7. Window measurements and checks

- F212.7b-1: record card fullscreen and tab switches with a view, and show that each presentation wait ends.
- F212.7c: record a drag of a card with a view and measure (viii). The native frame against the card boundary is at most 2 pt. Content frame gaps are at most 33 ms. A content size mismatch ends within 2 frames after the gesture.
- F212.7d-1: compare the first frame color of a view with the card token color.
- F212.12: window checks of views, one item per function: display, input and focus, drag, restart.
- F212.13: the input method activation check of views, run with approval.
- F212.14: the final measurement of every plugin view against (i), (ii), (iii), (iii-b), (v) and (viii).

The pass values are in the plan, section "Pass values". A failed mechanism value ((v), (vi) or (viii)) stops the mechanism items. A failed plugin value stops only that plugin, and the person decides between accepting the cost and changing its layer.

### 8. Removal, merge and release

- F212.11: remove the page mount of plugin surfaces, parking, the `dom` composition, and the page mount of module sections and state modules. Manifests then accept only the new form.
- Merge `feat/view-kind-F212.7` into main after every core item above is complete. Run `make push-check` on main after the merge, then remove the worktree and the branch.
- F212.15: release core only when no development item is open; list the open items first. Then release each plugin and the files and shell sidecars.

## Held items

Do not work on these without an instruction: G1.4-87-1, G1.4-101-1-1, the V5 background launch branch, R2-7, F54, F161.22, F161.30 and F160.29.2. The parents F160, F160.29 and F161 stay open with them.
