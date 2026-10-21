# Plugin processes: remaining work

[한국어](plugin-processes-handoff.ko.md)

This document lists the remaining work of F212 (plugin code outside the main page) and of the open items beside it. It also says how to do and verify each item. A session can start from this document, AGENTS.md and the files it names, without any other context. Remove this document when F212.15 is released.

## Sources of truth

| Topic | File |
|---|---|
| Process rules, the checklist rules, Red/Green, commit form, branches and worktrees | `AGENTS.md` (+ `.ko.md`) |
| Checklist | `docs/features.md` (+ `.ko.md`) |
| Decided design of F212: the layers, the rules 1 to 10, the pass values (i) to (viii), the review records | `docs/plans/plugin-processes.md` (+ `.ko.md`) |
| Declared UI contract (list, tree, button, status-line, sections, addresses, rejections) | `docs/spec/declared-ui.md` (+ `.ko.md`) |
| Exposure contract (commands, statuses, dom, `address`, errors) | `docs/spec/exposure.md` |
| Build, test parity, window checks, diagnostics | `docs/operations/examples.md` |
| Private WebKit APIs and their call conditions | `docs/operations/private-native-apis.md` |

The view branch `feat/view-kind-F212.7` merged into main on 2026-10-21 and was removed, so main holds every source above.

## Repository state

### Branches and worktrees

State on 2026-10-21. Only main is pushed; no other branch is published.

| Branch | Worktree | State | Next step |
|---|---|---|---|
| `main` | `core` | pushed; holds the F212 view and declared UI work, F212.7-10 to F212.7-13, and F224 to F227 | — |
| `fix/lock-unwraps-F218-2-4` | `../core-lock-unwraps-F218-2-4` | F218-2.4 in progress | finish F218-2.4 and F218-2.5, merge into main, then remove the worktree and the branch |
| `feat/plugin-host-F212.9` | `../core-plugin-host-F212.9` | F212.9-1 and F212.9-2 committed, F212.9-3 in progress | finish F212.9-3 and F212.9-4, merge into main, then remove |
| `fix/persistent-restart-F212-8a-4` | `../core-persistent-restart-F212-8a-4` | F212.8a-4 in progress | specify and implement, merge into main, then remove |
| `feat/settings-G1.4-87-1` | `../core-settings-G1.4-87-1` | held item | do not touch |
| `fix/background-launch-V5-117-1-3-4-7-1-8` | none | held item | do not touch |

Two annotated tags keep the commits of two superseded branches; `git tag -l` lists them.

### Sidecar repositories

| Repository | Open | Note |
|---|---|---|
| `../sidecars/files` (origin `soksak-app/sidecar-files`) | none | S31 (a log record as the first action of the process) is committed and pushed. S26 to S30 are committed. |
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

- Work on `main` directly by default. When an agent or the situation needs isolation, use the branch `{type}/{shortname}-{ID}` and the worktree `../core-{shortname}-{ID}`.
- Never push a branch. Every branch merges into main, and only main is pushed.
- Remove the worktree and the local branch right after the merge into main succeeds. Never remove one whose merge failed or has not happened: the condition of a removal is a successful merge.
- Test or probe code that cannot merge into main is cherry-picked while it still has meaning, otherwise discarded, before the commit. When it cannot be removed at once, register a checklist sub-item that states the removal condition.
- Before a merge into main, run `git fetch` and `git rev-list --count HEAD..origin/main` on main, and merge origin/main first when the count is not zero. After the merge run `make push-check` on main, then push main.
- Run `make hooks`, `make native-darwin` and `make frontend-tauriv2` in a new worktree before tests.
- On a CHANGELOG conflict keep both entries. On a conflict of the recorded counts in `docs/operations/examples.md`, use the count that `make parity-check` prints for the merged tree.
- After a worktree moves, the Tauri build cache keeps old paths and clippy fails. Run `cargo clean -p tauri -p soksak-tauriv2` in the worktree.
- Gate commands with `&&`, and never pipe a gate command (`make x | tail && ...`): the pipe returns the status of its last command, so a failure does not stop the chain. Write the output to a log file and judge by the exit status, or set `pipefail`.
- A change that adds or touches a contract case or a test of `packages/host` or `packages/sok` runs `make host-contract-check`; no push gate runs it, and CI fails without it (F220).

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

Done on main: F218-2.1, F218-2.2 and F218-2.3 (F219 made the order-dependent sidecar test that blocked F218-2.2 run alone), and F212.6a-1-3-2-2 (the stall is the page-close work of WebKit and the system on the main thread, so no host change follows).

**F218-2.4** — in progress on `fix/lock-unwraps-F218-2-4`. 86 lock results that call `unwrap` or `expect`. Same change and test; Red is the panic of the calling thread.

**F218-2.5** — enable `rs.lock-result` with zero findings, and remove its pending entry in `scripts/census.json`. Green is `make census-check` with zero findings. Then mark F218-2 `[o]`.

**F212.1-2-2** — the fixture reply waited 12.4 s for the first answer of the files sidecar. `host.trace.sidecar.ready` (F212.1-2-2-6) measures spawn to first answer. S31 is committed in the files sidecar. Repeat the window check of F212.1-2 with the trace on, and read `host.trace.sidecar.ready` and the sidecar's first record. If the gap is before the sidecar's first record, the cause is the start of the process (the binary launch); record the measured time and its cause. If the gap is inside the sidecar, fix it there.

**F212.1-3** — the recorded DOM mount baseline of pass value (iii). For each installed surface plugin, record the main page from the surface start request to the first content frame (`diagnostics.capture.start/stop`), and take the median of 5 runs with the load average. Make it a tracked window check under `e2e/`, and write the result in the plan table "F212.1-2".

**F212.8a-4** — in progress on `fix/persistent-restart-F212-8a-4`; the decision record is `docs/plans/persistent-restart.md`. The restart limit of persistent services (`docs/spec/terminal-runtime.md`, one attempt per disconnect). This is a decision first: which event counts as a failure of a persistent service. A disconnect that the host re-attaches without a send is not a failure event today. Write the scope, run the review, then specify and implement it in both hosts with a contract case. Reuse the stdio limit of F212.8a (Go `Sidecars.Now`, Rust `Sidecars::with_clock`, `host.sidecar.restart-limit`, `host.trace.sidecar.restart-reset`).

### 2. Checklist states

Done: F212.3, F212.4 and F212.6 are `[o]`. F212.7 stays `[ ]` while F212.7a, F212.7b-1, F212.7c, F212.7d-1 and F212.7-9 are open.

### 3. Declared UI (F212.8)

Done: F212.8 and all its children, including F212.8-6-3 (the source and transitions of a declared section), F212.8-6-4 (its drawing and reporting) and F212.8-7 (draw time in jsdom: tree median 501.2 ms, list median 116.4 ms; the limits of declared-ui.md stay).

### 4. Plugin host (F212.9)

F212.9-1 (the specification `docs/spec/plugin-host.md`) and F212.9-2 (the native operation) are committed on `feat/plugin-host-F212.9`; F212.9-3 and F212.9-4 are in progress there.

F212.9 is required, because a plugin whose sidebar section shows values while none of its views is open needs a plugin host (declared-ui.md, source order). The plan names the files state as the first case.
- Spec first: plan native gap 3 (a platform operation that creates a plugin host web view attached to the window, not to a surface host), gap 7 (owner key `plugin:<id>`), and rule 5 (restart within limit (vi), state restored from the last saved value).
- F212.9a: measure the footprint and the throttle of a hidden host web view before F212.10.
- Implement in native/darwin and both hosts, with contract cases, Go and Rust tests, and a native test. The view channel code of F212.7-2 is the pattern for the host channel.

### 5. Plan into specifications (F212.7-9)

Before F212.15: move the accepted contract of `docs/plans/plugin-processes.md` into a new `docs/spec/plugin-processes.md` (+ko). Repoint every link, including `packages/plugin-api/terms.json` and `docs/spec/declared-ui.md` line 11, and remove the plan. Decide where the review records go: the specification has no history, so they go to the changelog entries or are dropped.

### 6. Plugin moves (F212.10)

Each move is an item of its own plugin repository, made against main. The plan table "Layers and placement" gives the target of each plugin:

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

### 8. Removal and release

- F212.11: remove the page mount of plugin surfaces, parking, the `dom` composition, and the page mount of module sections and state modules. Manifests then accept only the new form.
- F212.15: release core only when no development item is open; list the open items first. Then release each plugin and the files and shell sidecars.

## Held items

Do not work on these without an instruction: G1.4-87-1, G1.4-101-1-1, the V5 background launch branch, R2-7, F54, F161.22, F161.30 and F160.29.2. The parents F160, F160.29 and F161 stay open with them.
