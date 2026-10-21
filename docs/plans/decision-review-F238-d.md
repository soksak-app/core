# Decision review F238-d: registry listings, host contract sources, plugin placement

[한국어](decision-review-F238-d.ko.md)

This record reviews three decisions of F238 that were taken without adversarial verification: D2 (registry listings in core), D8 (sok sources in the host contract check) and D9 (plugin placement of files and shell). Each decision states what it decides, its evidence with file and line, and the exact changes it requires. Fresh auditors object where the decision is wrong or incomplete and propose a solution. The parent answers each objection with evidence or changes the decision. Rounds repeat until both auditors of a round raise no substantive objection. Each round's texts are in git history; this file holds the current texts and the answers.

## Scope

- In scope: whether each decision is right, what it leaves incomplete, and the changes that make it right.
- Out of scope: wording, citation precision, and cases that every implementation resolves the same way. The unit tests named in a decision settle the details.
- A standard changes only with evidence and is not lowered because a test cannot reach it.

## Method

- Code is read in the owning worktree and, for other branches, with `git show <branch>:<path>`. No other branch is checked out.
- Each round: two fresh auditor subagents (claude-haiku-5-5), read-only, receive the decision texts and the code paths. They return only substantive objections, each with a concrete solution.
- Each objection is checked in the files, then accepted (the decision text changes) or rebutted (with evidence, returned to the same auditor).

## D2. Registry listings in core

Decision: core keeps `scripts/workspace-registry.json` as the declaration of the sibling repositories that core tools read, keeps the repository table of `docs/spec/plugins.md` as its documentation, and keeps the sibling checkouts in CI. Three statements that do not match the code are corrected.

Evidence:

- `scripts/workspace-registry.json` declares the plugins `browser`, `editor`, `files`, `hwp` and `terminal`, the sidecars `files` (folder `.`) and `vt-alacritty`, and the pack `starter` (`browser`, `terminal`, `files`).
- `docs/spec/plugins.md`, Repositories paragraph: "none reads the files of another." This is false. `scripts/check-boundaries.mjs:27-42` reads the `package.json` name and dependency keys and the `plugin.json` id of every declared folder, and `readJson` throws when a sibling is missing. `Makefile:374-375` (`registry`) and `Makefile:382-388` (`install-plugins`) read the declared sibling repositories to pack and install them.
- The repository table says "The plugins are `browser`, `terminal`, `files` and `shell`". The registry declares `editor` and `hwp` and does not declare `shell`.
- `AGENTS.md:32` says "`environment.json` lists plugins", and `AGENTS.md:33` lists `environment.json` among manifests that "list what is installed at which version". `CHANGELOG.md:1023` (R1-2-3-3) records that `environment.json` no longer lists plugins. Its tabs still name plugins: `apps/wailsv3/environment.json:47` (`"plugin": "terminal"`), `:60` and `:115` (`"plugin": "browser"`). The installs are listed in `plugins/installed.json` (`Makefile:385` reads its `plugins` keys).
- `.github/workflows/ci.yml:19-46` checks out `plugins/browser`, `plugins/editor`, `plugins/files`, `plugins/hwp`, `plugins/terminal`, `sidecars/files` and `sidecars/vt`. `ci.yml:73` runs `make boundaries` in the Structure job. `window-checks.yml` checks out the same siblings for `make install-plugins`.
- `scripts/check-registry-manifests.mjs` downloads plugin releases over the network. It runs in `release-check` (`Makefile:35`), not in `push-check`, and it does not read sibling files.
- `scripts/check-test-parity.mjs` names `scripts/workspace-registry.mjs` only as a lane file. It does not read the registry json.

Required changes:

- R2.1 `docs/spec/plugins.md` (Repositories paragraph, with `.ko.md`): replace "none reads the files of another." with: "`make boundaries` reads the `package.json` name and dependency keys and the `plugin.json` id of each folder that `scripts/workspace-registry.json` declares, and fails when a declared folder is missing. `make registry` and `make install-plugins` read the declared sibling repositories to pack and install them."
- R2.2 `docs/spec/plugins.md` repository table (with `.ko.md`): replace "The plugins are `browser`, `terminal`, `files` and `shell`" with "The declared plugins are `browser`, `editor`, `files`, `hwp` and `terminal`, the same as `scripts/workspace-registry.json`. `shell` has a repository, is not published and is not declared." The sidecar row names `vt-alacritty` as the declared folder.
- R2.3 `AGENTS.md:32-33` and `AGENTS.ko.md:32-33`: replace "`environment.json` lists plugins" with "`environment.json` names plugins only as tab and sidebar references in `workspace` and `sidebars`; it does not install them." Remove `environment.json` from the manifests in line 33 that list what is installed. State that `plugins/installed.json` lists the installed plugins, and that `scripts/workspace-registry.json` declares the sibling folders that `make boundaries` and `make registry` read.
- R2.4 Red and Green: add a case to `scripts/test/workspace-registry.test.mjs`. It reads the declared plugin names of the repository table in `docs/spec/plugins.md` and the `plugins` of `scripts/workspace-registry.json`, and asserts they are equal. On the unchanged table the case fails, because the table lists `shell` and omits `editor` and `hwp`. Green after R2.2.
- R2.5 CI: no change to `ci.yml`. The spec states that the Structure job and the window checks need the sibling checkouts for `make boundaries` and `make install-plugins`.

Out of scope: moving the registry declaration to the registry repository.

## D8. Sok sources in the host contract check

Decision: the host contract check keeps reading the sok declarations (`packages/sok/wailsv3/tests`, `packages/sok/wailsv3/src/*_test.go`, `packages/sok/tauriv2/tests`, `packages/sok/tauriv2/src`) and changes how a declaration is matched to a result. The F218-2.4-1 change is already on `origin/main`; it is not amended, and the fix is a new change.

Evidence:

- `scripts/check-host-contract.mjs:166-167` reads the sok test and source folders for the declarations of each host.
- The same test name exists in both packages: `packages/host/wailsv3/tests/plugins_test.go:92-93` declares `plugins.state.reports-registry-and-installed` on `TestPluginsStateReportsTheRegistryAndTheInstallation`, and `packages/sok/wailsv3/tests/plugins_test.go:296-297` declares `cli.plugin.state-reads-registry-and-installed` on the same name.
- Masking: `groupResults` (`check-host-contract.mjs:91-100`) keys results by run and test name only. `statusOf` (`:103-114`) then takes every name match of every run of the host. For `wailsv3`, the host runs and the sok runs are all in `host.runs` (`:173-179`), so a host pass counts for a sok declaration, and `auditHostContract` (`:132-138`) credits the sok case as covered. Reproduced in the Verification run below.
- Rust: `statusOf` line 107 matches `name.endsWith('::' + test.name)`. Two test functions with the same leaf name in different modules of one crate match one declaration. The libtest `--list` names are module paths (`test-discovery.mjs:83`).
- Attributes: `parseDeclarations` (`:78`) skips every `#[` line. `packages/host/tauriv2/tests/endpoint_test.rs:176-178` places `#[cfg(feature = "diagnostics")]` between a declaration and `#[test]`, and that case runs in the diagnostics configuration that the check requires. `#[should_panic]` or `#[ignore]` in the same place would change the reported outcome and currently pass without a report.
- `docs/spec/host-contract.md:22` names only the host paths.
- The sok lock test is compiled into the sok crate: `packages/sok/tauriv2/src/event_log.rs:1307-1309` declares `#[cfg(test)] #[path = "event_log_lock_test.rs"] mod lock_test;`, and `packages/sok/tauriv2/src/sok.rs:19` declares `pub mod event_log`.

Decision text:

- D8.1 Owner matching: a declared test takes its result only from items of its owner. The owner is the package directory for Go (the directory of the test file, which is the `pkg.dir` of the discovered package) and the crate directory for Rust (the `dirname(manifest_path)` of the build message). Discovered items carry their owner. Results are keyed by run, owner and test name in `groupResults`, and `statusOf` takes the declaration's owner and considers only items with that owner. Host and sok results are never merged.
- D8.2 Rust leaf names: a declaration names the leaf function. The audit fails when a leaf name appears twice among the tests that `--list` reports for one crate, declared or not. A declaration matches the single item whose last path segment equals its leaf. The check does not resolve module paths, because that would need `mod` chain and `#[path]` resolution, which it does not implement.
- D8.3 Attributes: between a `// contract:` declaration and its `fn`, the allowed attribute lines are `#[test]`, `#[tokio::test]` and `#[cfg(feature = "...")]`. The `cfg` line selects the configuration in which the test is compiled and does not change the reported outcome. Any other `#[` line is an error that names the file, the line and the attribute (for example `#[should_panic]` and `#[ignore]`).
- D8.4 Spec: `docs/spec/host-contract.md:22` (and `.ko.md:22`) lists every declaration path: `packages/host/wailsv3/tests/`, `packages/host/wailsv3/src/*_test.go`, `packages/sok/wailsv3/tests/`, `packages/sok/wailsv3/src/*_test.go`, `packages/host/tauriv2/tests/`, `packages/host/tauriv2/src/`, `packages/sok/tauriv2/tests/` and `packages/sok/tauriv2/src/`. The "Check" section states the owner rule of D8.1 and the attribute rule of D8.3.
- D8.5 Red and Green: in `scripts/test/check-host-contract.test.mjs` (the owning module), add these cases, each run with `auditHostContract` on synthetic input:
  1. A host pass under one owner and no result under the sok owner for the same name: the sok declaration reports `did not run`. Red on the unchanged code (no error); Green after D8.1.
  2. Same name in two owners of one run, one failing and one passing: each declaration reports its own status; the failing owner's declaration reports `fail`. Red on the unchanged code (merged to pass); Green after D8.1.
  3. Two Rust leaves with one name in one crate: the audit fails (D8.2).
  4. A `#[cfg(feature = "diagnostics")]` line between the declaration and `#[test]` passes (D8.3 Green); a `#[should_panic]` line in that place fails (D8.3 Red on the unchanged code, which passes it silently).

## D9. Plugin placement of files and shell

Decision: the files sidebar moves to declared UI. `files.tree` becomes a status section whose value holds a `tree` and the notices, and `files.bookmarks` becomes a status section with a `list`. Their state is held by the files plugin host, which serves the statuses. The shell card stays a view whose three sidebar sections are declared statuses served by that view.

### Files: evidence

- `plugins/files/plugin.json` declares the sections `files.tree` and `files.bookmarks`, each with a `module` form (`horizontal` and `vertical`), and the `state.module` `ui/state.js`. Its description says it has no card surface. Its statuses `files.tree`, `files.bookmarks`, `files.git`, `files.selection` and `files.open` have module-era schemas (for example `files.tree` has `root`, `error`, `entries`).
- The files UI uses: expand toggle; select on press (`tree.js` and `tree-horizontal.js:59`); open on double press (`tree-horizontal.js:61`, `core.file.open` with `dblclick`) and Enter on the selected file (`tree.js:124`); bookmark add per row (`tree-horizontal.js:65`); a git marker per row (`tree-horizontal.js:62`, `marker` with `data-part="git"`); a notice beside the header title for open failures (`tree-horizontal.js:15-17`, `:29`); a header star that adds the selected path as a bookmark (`tree.js:82-85`, `:119`); refresh (`tree-horizontal.js:17`); bookmark remove (`bookmarks.js:39`); icons `star` and `rotate-cw` (`tree.js:85`, `:90`), names in the core icon table (`packages/workbench/icons.js:6`).
- No context menu, rename, or drag and drop exists: a search of `ui/sections/*.js` and `ui/state.js` for `contextmenu`, `rename` and `drag` finds no match. The word `context` matches `context.bind` and `context.icon` only.
- `ui/state.js` imports only `./events.js` (line 3) and has no DOM reference (a search for `document`, `window`, `innerHTML`, `createElement`, `querySelector` and `appendChild` finds no match in the working tree of the plugin repository; committed history is not checked here).
- `docs/spec/declared-ui.md:145`: "A registration by a state module does not serve a declared UI status." A declared status is served by a view of the card or by the plugin host (`docs/spec/plugin-processes.md:28`). The files plugin has no card surface, so the plugin host is the only route.
- `docs/spec/declared-ui.md:56` and `:171`: a `tree` is not drawn in a horizontal section. The files plugin has a horizontal tree module (`tree-horizontal.js`).
- `docs/spec/declared-ui.md:17-22`: a declared status declares `exposes.status` schema as the subset `{"type":"object","properties":{"elements":{"type":"array"}}}` that the exposure spec accepts. The current files schemas are not in that form.
- `docs/spec/declared-ui.md:117`: the expand command "does not reach the plugin". The plugin must learn expansion, because its `files.tree` status lists the children of expanded directories (`plugin.json` `files.tree` description).
- `docs/spec/declared-ui.md:111-112`: a `command` runs on press. There is no element for double press.
- The horizontal-tree backlog item F230 is named in `../core-host-routes-F229/docs/plans/plugin-host-routes.md:55`. That file is not committed: `git show feat/host-routes-F229:docs/plans/plugin-host-routes.md` fails, and the branch's `docs/features.md` has no F230. This record does not treat F230 as scheduled.
- The files listing and git status come from the files sidecar, and the plugin re-lists when the sidecar reports a change (the `files.tree` description). `docs/spec/plugin-host.md:5` says a plugin host runs DOM-free logic that neither a view nor a sidecar can hold. The main spec of `plugin-host.md` (on `main`) defines no channel from a host to its plugin's sidecar events; the phrase "no sidecar send" from an auditor was not found in it.

### Files: decision text

- D9.1 Vocabulary. Each gap is closed by a spec change in `declared-ui.md`, not by a view:
  - (a) Horizontal tree: a `tree` in a horizontal section draws its visible rows (the root nodes and the children of each expanded branch, in order) as one row that wraps at the section width, with the node controls of the vertical form and no indentation. The element limits apply unchanged. This is a rule of `declared-ui.md` (`:56`, `:171` are changed to name it).
  - (b) `open` node field: a tree node may declare `open`, a command with `params` that follows the rules of `command` (the `<plugin>.<name>` form, the `params` limits, the declared-command check). A double press of a node runs `open` in place of `command` on its second press: the first press of a double press runs `command`, the second runs only `open`. A double press is two presses within the platform double-click interval. Enter on a focused node runs `open` (the keyboard equivalent of the double press). A new gesture term goes to `packages/plugin-api/terms.json` before the spec uses it.
  - (c) Selection: `files.select` runs on press, and the plugin sets `selected` in its next value. This is a round trip per click, accepted as the cost of a declared tree.
  - (d) Git marker: a tree node may declare `detail`, a plain-text string of at most 500 code points drawn after the label. The host sets it from the git status of the files sidecar. It replaces the `files.git` status.
  - (e) Row actions: a tree node may declare `actions`, an array of at most 2 `button` objects with the rules of `button` (`command`, `params`, `icon`, `enabled`), drawn after the label. The per-row bookmark add is one action. A node's `command` (press) and its `actions` are separate controls.
  - (f) Notices: the value of `files.tree` may hold a `status-line` element before the `tree`, which draws the open-failure text. It replaces the `files.open` status. The text is a plain status line, not an error color, which `AGENTS.md` reserves for the log path. The error itself is written to the log at the moment it appears (`AGENTS.md`, display rule).
  - (g) Header: the value of `files.tree` may hold `button` root elements before the `tree`. Refresh is one button. The header star is a `button` whose `params` the host sets to the selected path, so the value changes when the selection changes; the plugin sends the new value when it accepts the selection.
- D9.2 Plugin host and the sidecar. The files listing and git status are produced by the files sidecar, and the host cannot hold them without the sidecar's events. The DOM-free logic that needs no sidecar data (the expanded set, the selection, the bookmark list) can be held by the host. The decision is: `docs/spec/plugin-host.md` gains a surface-less relay: the plugin host receives the sidecar events of its own plugin through the same relay that a view uses, and its failure follows the sidecar failure contract (`docs/spec/sidecars.md#failure`), with the contract case `plugin-host.sidecar.events-delivered` in both hosts. The relay path that a view uses must be checked before the spec text is written (round-2 check item). The alternative, keeping the listing in a view, is rejected: a view for files needs a card surface, which the files plugin does not have and which the placement rule of `plugin-processes.md:26` makes a placement change.
- D9.3 Expansion. The expand command reaches the status source. `declared-ui.md:117` gains a rule: the expand command posts `{status, tree, path, expanded}` to the source of the status as the message `declared-ui.expanded` whenever the source is a view or a plugin host. The same change updates `:137`, which says the kept state is set only through the command. The contract case `declared-ui.expanded` is added in both hosts' test set and in `packages/workbench` tests.
- D9.4 Schemas. Each files status is rewritten to the declared subset of `declared-ui.md:17-22`, or removed:
  - `files.tree`: the schema of the `files.tree` value (elements: the notices, the header buttons and the `tree`). The old `root`, `error`, `entries` shape is removed.
  - `files.bookmarks`: a status whose value holds a `list` element.
  - `files.git`: removed as a status; its content is the node `detail` of D9.1d.
  - `files.selection`: removed as a status; it is host state, used by the header star and Enter.
  - `files.open`: removed as a status; its content is the notice of D9.1f.
  The `exposes.status` entries of `files.git`, `files.selection` and `files.open` leave `plugin.json` with the move.
- D9.5 Ordering and reopened work. `F212.8` is `[o]` (`plugin-processes-handoff.md:143`) and stays `[o]`. The follow-up items for D9.1a, D9.1b, D9.1d to D9.1g and D9.3 are new IDs under F212.8, recorded in `docs/features.md` (+ko) under F212 when this review closes. D9.2 is a new item under F212.9. Then F212.9-4-1 (state calls, rule 5 of `plugin-processes.md`), then the files move (F212.10-files, in the files repository), and F212.11 removes the module form of any section that remains.
- D9.6 Until the move, the module form of `files.tree` and `files.bookmarks` stays, as `plugin-processes.md:27` ("Module section (today)") states. This is the current form, not a lowered standard; the move comes before F212.11.
- D9.7 DOM test: `plugins/files/test/` gets a test that reads the host logic module of the move and fails on any DOM reference (`document`, `window`, `innerHTML`, `createElement`, `querySelector`, `appendChild`). Red: the test fails on a copy of `ui/state.js` with `document.createElement("div")` added. Green on the unchanged state module, and on the host logic module after the move.

### Shell: evidence

- `plugins/shell/plugin.json` declares the card surface `ui/index.html` as a `view`, and the sections `shell.history`, `shell.cwd` and `shell.jobs` with the `status` form. Its `surface.unload` declares format 1 and `maxBytes` 8192.
- The card has a text input (`plugins/shell/ui/shell.js:6`), which the layer rule of `plugin-processes.md:24-26` places in a view ("text input that needs IME").
- `shell.history` is the page array `history` (`shell.js:31`), appended by the page (`:71`). `shell.jobs` is built from the page's `runs` map (`:32`, `:48-49`, `:59`). `shell.js:56` states that an unload ends the shell session, and a running command keeps its tab loaded. `shell.js:119` and `:146-154` restore cwd from tab state.
- The requirement that triggers a host is `plugin-processes.md:27-28`: a sidebar section that "must show values while none of its views is open" needs a plugin host. The shell sections have no such requirement: their values are the state of the open shell session, and the card's view is their source (`declared-ui.md:145`). The sections are cleared while no source exists (`declared-ui.md:145`, step (b)).

### Shell: decision text

- D9.8 Shell stays a view with three declared status sections, sourced from its own view. The shell layer is the view layer of the F212.10 table. No host is created for shell. The premise of the host rule is stated explicitly: shell sections do not have to show values while no shell view is open.
- D9.9 Accepted cost, stated in full:
  - `shell.history` and `shell.jobs` are page session state. An unload of the tab (the memory saver) ends the shell session, and both lists are cleared with it. The `shell.history` description in `plugin.json` changes from "the nonblank lines written to the shell session ... oldest first" to "the nonblank lines written to the current shell session through shell.write, oldest first, cut to the last 1000; an unload of the tab ends the session and clears the list". The same change is made in the shell repository.
  - `cwd` is restored from the tab state after an unload (`shell.js:119`, `:146-154`).
  - While the card is closed or is not the active tab of its card, the three sections are cleared (`declared-ui.md:145`). The interrupt control of `shell.jobs` runs only while the page is loaded.
- D9.10 The shell item `F212.10-shell-layer` is closed by this decision, recorded in the shell repository's checklist (P10, see To record elsewhere).

## Verification run (parent, in this worktree)

- `/tmp/d8-probe.mjs` (a temporary probe, not acceptance evidence) calls `auditHostContract` with one `wailsv3` declaration of `TestPluginsStateReportsTheRegistryAndTheInstallation` (file `packages/sok/wailsv3/tests/plugins_test.go`, case `cli.plugin.state-reads-registry-and-installed`) and one host run where the same name passed and no sok run exists. Output: `errors: []`, `covered: ["cli.plugin.state-reads-registry-and-installed"]`, exit 0. This is the masking of D8.
- Facts checked in the files, not taken from the draft or the auditors: `scripts/workspace-registry.json`, `scripts/check-boundaries.mjs:27-42`, `Makefile:374-388`, `.github/workflows/ci.yml:19-46,73`, `apps/wailsv3/environment.json:47,60,110,115`, `scripts/check-host-contract.mjs:91-114`, `packages/host/tauriv2/tests/endpoint_test.rs:176-178`, `docs/spec/declared-ui.md:17-22,56,111-117,145,171`, `docs/spec/plugin-processes.md:24-28`, `packages/sok/tauriv2/src/event_log.rs:1307-1309`, `packages/sok/tauriv2/src/sok.rs:19`, `plugins/files/plugin.json`, `plugins/files/ui/sections/tree.js:82-124`, `plugins/files/ui/sections/tree-horizontal.js:15-65`, `plugins/shell/plugin.json`, `plugins/shell/ui/shell.js:6,31-71,119,146-154`.

## Round 1

Auditors: two fresh subagents, each reviewing all three decisions. Thirteen objections (D2: 1 and 1; D8: 3; D9: 9 distinct). Each objection and its answer:

- A-D2-1 (R2.3 partly false, environment tabs name plugins): accepted. Verified `apps/wailsv3/environment.json:47,60,110,115`. R2.3 replaced.
- B-D2 and A-D2: no other D2 objection. The registry contents, `check-boundaries.mjs:27-42`, the Makefile targets, CI and the `shell` mismatch were confirmed by both auditors.
- A-D8-2 and the cfg case (D8.3 breaks `#[cfg(feature)]` declarations): accepted. Verified `endpoint_test.rs:176-178`. D8.3 allows `cfg(feature)` and rejects outcome-changing attributes.
- A-D8-3 and B-D8-7 (`groupResults` merges owners before `statusOf`): accepted. Verified `check-host-contract.mjs:91-100`. D8.1 keys by run, owner and name; D8.5 adds the case.
- B-D9-1 (plugin host cannot receive the sidecar events the listing needs): accepted as a required spec change. The quoted phrase "no sidecar send" is not in `plugin-host.md` on main; the substantive point is confirmed: the spec defines no host channel to its plugin's sidecar events. D9.2 adds the relay, with a check of the view's relay path as a round-2 item. The view-channel alternative is rejected (D9.2).
- B-D9-2 (expansion never reaches the plugin): accepted. Verified `declared-ui.md:117` ("does not reach the plugin"). D9.3 adds the `declared-ui.expanded` message.
- A-D9-4 and B-D9-3 (vocabulary gaps: git marker, row bookmark action, open notice, header star, Enter-to-open): accepted. Verified `tree-horizontal.js:15-17,29,62,65` and `tree.js:82-85,119,124`. D9.1 (d) to (g) add them. Enter-to-open is D9.1b.
- A-D9-4 (context grep claim not reproducible): accepted. The wording now names `contextmenu`, `rename` and `drag`.
- A-D9-5 and B-D9-5 (D9.1a and D9.4 contradict): accepted. D9.5 is the single wording: new IDs, F212.8 stays `[o]`.
- A-D9-6 (double press runs select twice): accepted. D9.1b defines the second press as `open` only.
- B-D9-4 (schemas not rewritten; statuses without disposition): accepted. Verified the `declared-ui.md:17-22` rule and the module-era schemas. D9.4 gives each status a disposition.
- A-D9-7 and B-D9-6 (shell layer rule and history loss): partly accepted. The history loss on unload is real: `shell.js:56` states the session ends on unload. The decision now states the cost in full and changes the `shell.history` description (D9.9). The layer rule is not violated: `plugin-processes.md:27-28` requires a host only when a section must show values while no view is open, and the shell sections do not have that requirement. This premise is stated explicitly (D9.8). The auditor's proposed host for shell is rebutted on that basis; it returns to the auditor in round 2.

## Round 2 checks (done by the parent)

- The relay a view uses: the host delivers each sidecar message to the window that first sent for the surface, as the `sidecar-message` event `{sidecar, surface, body}` (`docs/spec/sidecars.md:46`). The relay is keyed by surface, so a surface-less plugin host has no route to sidecar events today. D9.2 is therefore a required spec change, not an existing path.
- `docs/spec/plugin-host.md` on `main` (sections Declaration to State) defines no sidecar channel; `git show feat/plugin-host-F212.9:docs/spec/plugin-host.md` contains no `sidecar` text.

(Round 2 auditor answers: pending.)

## To record elsewhere

Recorded on the owning repository or branch; this review does not change them.

- Core main (follow-up of F218-2.4-1): D8.1 to D8.5 in `scripts/check-host-contract.mjs`, `scripts/test/check-host-contract.test.mjs` and `docs/spec/host-contract.md` (+ko), as a new change after the F218-2.4-1 change.
- Core main (F212.8 follow-up IDs): D9.1a to D9.1g and D9.3 in `docs/spec/declared-ui.md` (+ko) and the vocabulary table, with tests in `packages/workbench`.
- Core main (F212.9 follow-up): D9.2 in `docs/spec/plugin-host.md` (+ko), the surface-less sidecar relay, with the contract case in both hosts.
- `AGENTS.md:32-33` and `AGENTS.ko.md:32-33` (R2.3), `docs/spec/plugins.md` (R2.1, R2.2) and `scripts/test/workspace-registry.test.mjs` (R2.4): core main.
- The F230 backlog item named in `../core-host-routes-F229/docs/plans/plugin-host-routes.md:55` is not committed on `feat/host-routes-F229`. Its owner records it on that branch or drops the reference; D9.1a is the horizontal rule this review sets.
- `plugins/files` repository: D9.4 schemas and D9.7 test, and item F212.10-files after F212.9-4-1.
- `plugins/shell` repository: `plugin.json` `shell.history` description (D9.9); checklist item P10 closed by D9.8 and D9.10.

## Sub-items

Registered in `docs/features.md` (+ko) under F212 when the decisions close.
