# Decision review F238-c: plugin test imports (D1) and owner classification (D3)

[한국어](decision-review-F238-c.ko.md)

This record reviews two decisions. Each decision states its argument, its evidence with file and line, and the exact required changes. Fresh auditor subagents object only where a decision is wrong or incomplete, and each objection carries a concrete solution. Wording and citation corrections are applied directly and are not objections. A round repeats until both auditors of the round report no substantive objection. A standard changes only with evidence and is never lowered because a test cannot reach it.

Scope of a review: what the decision must settle, what counts as a substantive objection, and what is out of scope (wording, cases that every implementation resolves the same way, details settled by unit tests).

## Evidence base

- Main is `origin/main`. Other branches are read with `git show <branch>:<path>` only.
- Plugin repositories are sibling folders `../plugins/<id>` on branch `main` of each plugin repository.
- The rule source is `AGENTS.md` (Structure): "Tests must not read another package's paths, SDK, build, or implementation names." and "consumer tests use fakes or fixtures at the consumer boundary".

---

## D1. Plugin tests import no SDK code

### Decision

A plugin repository's tests import and resolve no `@soksak/*` name (the SDK `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`, the shared kit, a sidecar), read no installed package path, and load no copy of SDK code. A plugin test checks that plugin's own code, manifest and fixtures.

Implementation modules under `ui/` keep their `@soksak/*` specifiers, because the page loads them through the import map. A test does not import `ui/` source. The plugin build writes a test tree (`build/test/`) that copies `ui/` and rewrites each `@soksak/*` specifier to a plugin-authored fixture module (the SDK functions the page uses, as fakes at the consumer boundary, with no SDK code) or to the vendored file that `plugin.json` names. Tests import only that tree, plugin-authored fixtures and third-party public packages declared in `devDependencies`.

Each plugin's `test` script runs the test-tree build first (`node scripts/build-test.mjs && node --test test/`), so a fresh checkout builds before it tests.

SDK behaviour is tested only in its owning package. Where a plugin test today asserts an SDK value or imports an SDK function, the assertion moves to the owning core test, and the plugin keeps a literal constant or a fake.

Command split: `make test` runs the plugin test script only. `make check` runs the SDK-reading tools (`soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`), the SHA-256 comparison of the SDK `view-start.js` against a constant held in the check script, `build-vendor --check`, and the literal-equality check of the `VIEW_IMPORTS` entries that a test fixture holds. Build and check scripts (not tests) may call SDK validators and read `VIEW_IMPORTS`.

The decision takes effect for each plugin repository when that repository's sub-items land. Until then the current form is an open defect with an owner, not compliance.

### Argument

- The rule forbids a test from reading another package's SDK or implementation. The SDK tests its own formats and view bridge in core: `packages/plugin-api/test/view-page.test.mjs` (`checkViewPage`), `view.test.mjs` (`createViewBridge`), `binder.test.mjs` (`createBinder`), `view-imports.test.mjs` (`VIEW_IMPORTS`), `view-core-targets.test.mjs`, `events-check.test.mjs` (census findings, `:26`, `:147`, `:161`), and `packages/log-contract/test/screen-hash.test.mjs` (screen hash contract).
- A test that imports `ui/` source resolves the SDK through that source. Rewriting the test-visible specifiers in a build output is the only way to keep SDK code out of a test run, and it is a build step, which the rule allows.
- A test fixture that holds an SDK file or a copy of one runs SDK code in the test run, so no fixture holds SDK bytes. A fixture may hold literal values that `make check` compares with the SDK.

### Evidence (sibling `../plugins/*`, branch `main`)

Test and test-helper files that import or resolve `@soksak/plugin-api` (17): `appview/test/manifest.test.mjs`; `browser/test/{address-input,empty-state,manifest,page}.test.mjs` (`page.test.mjs:5` imports `INTERACTIVE`; `address-input:5` and `empty-state:5` import `createBinder`); `editor/test/{editor,view,manifest}.test.mjs` (`editor.test.mjs:6` imports `createBinder`; `view.test.mjs:7` imports `VIEW_IMPORTS` and `checkViewPage`); `editor/test/view-host.mjs`; `files/test/manifest.test.mjs`; `hwp/test/hwp.test.mjs:6` (imports `createBinder`); `shell/test/{manifest,view}.test.mjs` (`view.test.mjs:7` imports `VIEW_IMPORTS` and `checkViewPage`); `terminal/test/{census,manifest,terminal}.test.mjs` (`terminal.test.mjs:4` imports `createBinder`); `flowmark/ui/view.test.mjs:7` (imports `VIEW_IMPORTS` and `checkViewPage`).

Test files that import `@soksak/shared` specifiers: `editor/test/editor.test.mjs:184` and `:198`; `editor/test/fixtures/upper-gutter.mjs:2` (`@soksak/shared/editor.extension/@codemirror/view.js`); `editor/test/shared-modules.mjs`.

Implementation modules loaded by tests that import the SDK (transitive): `terminal/ui/terminal.js:1-2` (`@soksak/plugin-api`, `@soksak/plugin-api/screen-hash`), loaded by `terminal/test/terminal.test.mjs:6`; `browser/ui/sections/tabs.js:3` and `history.js:3` (`drawList`), loaded by `browser/test/section-lists.test.mjs:22`; `files/ui/sections/tree-horizontal.js:2`, loaded by `files/test/section-lists.test.mjs:43`; `editor/ui/view.js:7-8` and `flowmark/ui/view.js:7`, loaded by `editor/test/view.test.mjs` and `flowmark/ui/view.test.mjs`.

SDK value assertions in plugin tests: `terminal/test/terminal.test.mjs:3874-3885` (SDK golden-vector hash `vector.hash`) and `:3909-3911` (altered message hashes differently). These are SDK contract checks and move to `packages/log-contract/test/screen-hash.test.mjs`.

SDK bytes loaded by plugin hosts: `packages/plugin-api/view-start.js:1-12` is the injected start script. `editor/test/view-host.mjs:14` and `flowmark/ui/view-host.mjs:13` read it and run it in a window.

Resolver hooks: `editor/test/shared-modules.mjs:4-18` (`registerHooks`, `POINT` `@soksak/shared/editor.extension/`), run by `editor/package.json:23` through `--import`.

Makefile targets that run SDK tools inside `make test`: `editor/Makefile:16-20` and `terminal/Makefile:16-20` (`soksak-exposure`, `soksak-engines`, `soksak-events --census`); `flowmark/Makefile:10-14` (`soksak-engines`, `soksak-events`, `soksak-records`). `build-vendor --check` runs in `editor/package.json:22` and in `files/package.json` `scripts.test`.

CI: `ci.yml:23` runs `make test` in `appview`, `browser`, `editor`, `files`, `hwp`, `shell` and `terminal`. Release workflows (`release.yml`) exist in `appview`, `browser`, `editor`, `files`, `hwp` and `terminal`; `shell` has no release workflow. `flowmark` has no `.github` folder.

Build scripts: `browser`, `appview`, `shell`, `terminal` and `flowmark` have no `build` script; `editor` and `files` have one that runs `build-vendor` only.

Shipped files: `flowmark/package.json` `files` is `plugin.json`, `events.json`, `ui`; its test script is `node --test ui/`.

### Required changes

1. Test tree build: each plugin gains `scripts/build-test.mjs`, which writes `build/test/`. It copies `ui/`, and rewrites every `@soksak/*` specifier to a plugin-authored fixture module (the SDK names the page uses, implemented with the host call names and no SDK code) or to the vendored file named by `plugin.json` `extends.extension.modules`. The plugin `test` script runs it first, then `node --test test/`. Owner: each plugin repository, one sub-item per repository.
2. Test rule: a test in each plugin's `test/` builds its needle from parts (for example `"@" + "soksak/"`), so it does not match its own source. The rule asserts that no line of `test/**` and no line of `ui/**/*.test.mjs` equals a line in the plugin's marker list (the `@soksak/` needle and the first line of `view-start.js`). The test does not read any SDK file. The SHA-256 comparison of `view-start.js` runs only in `make check`, because that command is allowed to read the installed package.
3. Resolver hooks: `editor/test/shared-modules.mjs` is deleted when the test tree of change 1 lands, and `editor/package.json:23` drops its `--import`. Until then the hook is an open defect with the editor repository as owner.
4. `editor/test/editor.test.mjs:184` and `:198` and `editor/test/fixtures/upper-gutter.mjs:2` import the vendored file through the test tree. Each assertion keeps its meaning.
5. The view host fixtures (`editor/test/view-host.mjs`, `flowmark/ui/view-host.mjs`) do not read or run `packages/plugin-api/view-start.js`. They use a plugin-authored literal of the start values named in `docs/spec/plugins.md:171` (`window.sokSurface` `{surface, params, origin, project, declarations}`) and a plugin-written `sokView` stub. No SDK file is written into `test/`. The bridge behaviour of `view-start.js` is tested only in `packages/plugin-api/test/view.test.mjs`.
6. `terminal/test/terminal.test.mjs:3874-3885` and `:3909-3911`: the golden-vector and altered-message assertions move to `packages/log-contract/test/screen-hash.test.mjs`, which already holds the screen-hash contract. In terminal, change 1 rewrites `@soksak/plugin-api/screen-hash` in `ui/terminal.js` to a plugin-authored fake `screenHash`; the plugin test asserts its result as a literal constant.
7. Direct SDK imports in plugin tests (change 13 of the round-4 list, applied here): every `@soksak/*` import in the 17 files above is removed.
   - `createBinder` users (`editor/test/editor.test.mjs:6`, `browser/test/address-input.test.mjs:5`, `browser/test/empty-state.test.mjs:5`, `hwp/test/hwp.test.mjs:6`, `terminal/test/terminal.test.mjs:4`) import the rewritten binder fixture from `build/test/`. Each assertion about the binder contract has a Coverage row to `packages/plugin-api/test/binder.test.mjs`; an assertion of the plugin's own binder wiring stays as a fixture-backed assertion.
   - `VIEW_IMPORTS` and `checkViewPage` users (`editor/test/view.test.mjs:7`, `shell/test/view.test.mjs:7`, `flowmark/ui/view.test.mjs:7`): `checkViewPage` runs in the plugin build (change 11). The test reads a literal copy of the four import-map entries; `make check` compares the literal with `VIEW_IMPORTS`.
   - `INTERACTIVE` in `browser/test/page.test.mjs:5` is a literal constant.
8. Manifest tests (`appview`, `browser`, `editor`, `files`, `shell`, `terminal`) read the manifest validated by the plugin build and check its values as literals. The validators run in the build with the SDK validators.
9. `terminal/test/census.test.mjs` is deleted (`:24` and `:29`). The census of plugin sources runs in `make check`. The probe case is covered by `packages/plugin-api/test/events-check.test.mjs` (`:26`, `:147`, `:161`).
10. Flowmark moves its tests and helper from `ui/` to `test/`; its `test` script becomes `node scripts/build-test.mjs && node --test test/`. `ui/` ships only its page files.
11. Spec: `docs/spec/plugins.md:40` changes from "`make test` runs the tests of a plugin repository" and "depends on `@soksak/plugin-api` for its tests" to: `make test` runs the plugin tests; `make check` runs the SDK tools; the plugin repository depends on `@soksak/plugin-api` as a build dependency. `docs/spec/plugins.md:171` ("a plugin repository test calls `checkViewPage`") changes to: the plugin build calls `checkViewPage`. Owner: core `main`, with `.ko.md` mirrors.
12. `make test` runs the plugin test script only. `make check` runs `soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`, the view-start hash check, the `VIEW_IMPORTS` literal check and `build-vendor --check`.
13. CI and release, per repository (no repository is assumed to have a file it lacks):
    - `appview`, `browser`, `editor`, `files`, `hwp`, `terminal`: `.github/workflows/ci.yml` and `release.yml` each run `make check` after `make test`; `make pack` depends on `make check`.
    - `shell`: `ci.yml` runs `make check` after `make test`. It has no `release.yml`; the sub-item records that no release workflow exists, so `make pack` runs only by hand and is an open defect with owner `shell`.
    - `flowmark`: no `.github` folder exists. Its sub-item either adds `ci.yml` that runs `make test` and `make check`, or records the absence as an open defect with owner `flowmark`. Its SDK tools currently run in `make test` (`flowmark/Makefile:10-14`), which change 12 moves to `make check`.

### Coverage

Each removed plugin assertion maps to a core test or a plugin fixture assertion. The table is written in the sub-item before any test is deleted: plugin file and test name, then core test file and name or the new fixture assertion. Rows required from the start: `terminal/test/terminal.test.mjs:3874-3885` and `:3909-3911` (to `packages/log-contract/test/screen-hash.test.mjs`); `terminal/test/census.test.mjs:24,29` (to `events-check.test.mjs`); `browser/test/page.test.mjs:5` (to `binder.test.mjs`); `editor/test/editor.test.mjs:6`, `browser/test/address-input.test.mjs:5`, `browser/test/empty-state.test.mjs:5`, `hwp/test/hwp.test.mjs:6`, `terminal/test/terminal.test.mjs:4` (binder assertions, to `binder.test.mjs`). No assertion is dropped without a row.

### Out of scope

Fixture comment wording and exact fixture file names (chosen in the sub-item).

---

## D3. Owner classification by declared name

### Decision

The name rule for `@soksak/plugin-*` and `@soksak/sidecar-*` lives in `scripts/check-boundaries.mjs`, which already reads the declared folders and already states that core names no plugin or sidecar. It adds one pattern rule to the existing loop. `scripts/check-test-parity.mjs` keeps its path-based owner roots and gains a name-independent private-path rule. It no longer classifies plugin or sidecar names.

1. Core names are the `name` of each `packages/*/package.json` and `packages/host/*/package.json` (`components()` in `check-boundaries.mjs`).
2. Pattern rule: a `@soksak/plugin-*` or `@soksak/sidecar-*` reference in a core source (`packages/**`, every extension the check reads, including `.ts`, `.tsx`, `.cjs`) whose two-segment base is not a core name fails the check, whether or not the name is declared. The rule matches the pattern `^@soksak/(plugin|sidecar)-` on the base, so `@soksak/plugin-api-x` fails. The declared set is not an exemption. The `allowed` exemption (a core package's own dependency keys, `check-boundaries.mjs:33-35`) is removed for these names; no core `package.json` names a plugin or sidecar except `@soksak/plugin-api`, which is a core name.
3. Exact match: a reference is compared by its two-segment base (`@scope/name`) with the core names. A base is a core name only when it equals a core package name exactly.
4. Other scopes are not owners and are not classified. Undeclared plain plugin ids are not detected. `docs/spec/plugins.md` (Repositories) will state this limit (change 5). The prefix in rule 2 selects candidates in core sources only; it classifies no reference as an owner.
5. Private-path rule (name-independent): in `scripts/check-test-parity.mjs` `auditOwnership`, any `@soksak/` reference with a private subpath (`PRIVATE_SEGMENT`) fails as "private", except a reference to the referencing package's own declared name. The check does not exempt core names: `plugins/x/ui/a.js` importing `@soksak/plugin-api/src/private.js` fails, while `@soksak/plugin-api` without a subpath passes. Core names come from `packages/*/package.json`, read as in change 1.
6. Core test fixtures use `@scope/`. Existing `@soksak/sidecar-vt` fixtures are renamed.
7. The `-example` clauses are removed. A name such as `@soksak/sidecar-example` is not an exemption; it fails rule 2 under `packages/**`.

### Argument

- A prefix is not a contract. `docs/spec/plugins.md` gives GitHub repository names and no npm-name rule. A list in core is knowledge of plugins in core, which the boundary rule forbids. The prefix in rule 2 only selects candidates; it classifies nothing.
- `check-boundaries.mjs` already reads the declared folders' `package.json` names and `plugin.json` ids (`origin/main:scripts/check-boundaries.mjs:25-44`), and already flags declared names in core sources (`:58-93`). Rule 2 is one new pattern in that loop, applied to undeclared names as well. It is not a second check: it reads nothing new.
- The private rule is independent of owner classification. Without it, a plugin importing a core package's private subpath passes, and `apps/` and `e2e/` (not checked by `check-boundaries`) escape any finding.
- `startsWith` would classify `@soksak/plugin-api-x` as a plugin; exact base matching does not, and rule 2 fails `@soksak/plugin-api-x` only because its base is not a core name.

### Evidence

- `origin/main:scripts/check-test-parity.mjs:4514-4523`: main's `packageOwner` gives the core literals `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench` the owner `core` (`:4516`), the plugin list `:4517-4519` and sidecar list `:4520-4522` (each with an `-example` clause) their owners, and returns `null` for any other name (`:4523`). So on main `@soksak/plugin-foo` has no owner. On `fix/decouple-F236` the prefix branches at `:4484-4486` classify every `@soksak/plugin-*` and `@soksak/sidecar-*` name.
- `origin/main:scripts/check-test-parity.mjs:4553-4561`: the private error fires when the referenced owner differs from the referencing owner, before the core skip at `:4561`. So on main a plugin importing `@soksak/plugin-api/src/private.js` is flagged; removing the core literals would drop that finding, which rule 5 prevents.
- `origin/main:scripts/check-boundaries.mjs:17`: `SOURCE` is `/\.(js|mjs|html|css|json|go|rs|m|h|toml)$/`, which excludes `.ts`, `.tsx` and `.cjs`. `packages/soksak/src/*.ts` (8 files) and `packages/soksak/dist/*.d.ts` (9 files) exist on main.
- `origin/main:scripts/check-boundaries.mjs:1-5` (header: core names no plugin or sidecar); `:25-44` (`components()`); `:33-35` (`allowed`); `:58-93` (the loop over declared components, which runs on import).
- `origin/main:scripts/workspace-registry.mjs:170` uses an entry guard (`import.meta.url` against `process.argv[1]`), the pattern change 1 applies.
- `origin/main:scripts/test/test-parity.test.mjs:195-204` asserts a "sidecar" error for `@soksak/sidecar-example` from name classification; `:215-218` asserts a "private" error for `@soksak/sidecar-example/src/private.js`. The private assertion stays with rule 5; the name assertions move.
- `origin/main:scripts/test/soksak-scripts.test.mjs:118-131` already tests the declared-name rule in `check-boundaries`.
- `origin/main:scripts/workspace-registry.json` declares plugins `browser, editor, files, hwp, terminal` and sidecars `files`, `vt-alacritty`.
- `origin/main:docs/spec/plugins.md:34` lists `browser, terminal, files` and `shell`; it disagrees with the registry and is corrected in change 5.
- Undeclared `@soksak/sidecar-vt` fixtures: `origin/main:packages/workbench/test/library-plugins.test.mjs:35` and `:98`; `origin/main:packages/workbench/test/plugin-operations.test.mjs:63`. The `@scope/sidecar-probe` fixtures already in core: `origin/main:packages/workbench/test/plugin-states.test.mjs:54,63,90`.

### Required changes

1. `scripts/check-boundaries.mjs`: add `ts`, `tsx` and `cjs` to `SOURCE` (`:17`). Wrap the top-level run (`:58-93` and the final report) in an entry guard `if (import.meta.url === pathToFileURL(process.argv[1]).href)`, so that tests import the module without running the whole-repo check. Export `components()` and `checkNames(components, files)`. `checkNames` adds the pattern rule of decision rule 2 to the loop; it adds one rule, it reads no new path. Remove the `allowed` exemption for plugin and sidecar names (`:33-35` and its use).
2. `scripts/check-test-parity.mjs` (`main` `:4514-4523`; `fix/decouple-F236` `:4482-4491`): remove the name classification of `packageOwner` (core literals, plugin and sidecar lists, `-example` and prefix branches). Keep `OWNER_ROOTS` and the path-based references. Replace the private gate with decision rule 5, reading core names from `packages/*/package.json`. The `main` change and the `fix/decouple-F236` change are separate commits.
3. Move the name assertions of `scripts/test/test-parity.test.mjs:195-204` to a `scripts/test/` test of `checkNames`, using injected file sets. Keep the private assertions (`:215-218`) in `check-test-parity` under rule 5. Add cases: `plugins/x/ui/a.js` importing `@soksak/plugin-api/src/private.js` fails as "private"; `@soksak/plugin-api` without a subpath passes; `apps/` and `e2e/` private paths fail.
4. Rename the `@soksak/sidecar-vt` fixtures to `@scope/sidecar-vt` in `library-plugins.test.mjs:35,98` and `plugin-operations.test.mjs:63`. Those tests do not exercise the real sidecar.
5. `docs/spec/plugins.md:34` (Repositories) is rewritten to the registry list (declared plugins `browser, editor, files, hwp, terminal`; repositories that are not declared are named separately). The same section adds: core names no plugin or sidecar; undeclared plain plugin ids are not detected; the scoped names `@soksak/plugin-*` and `@soksak/sidecar-*` are rejected in core sources. Owner: core `main`, with `.ko.md`.
6. `checkNames` tests in `scripts/test/`: `packages/**/x.js` with an undeclared `@soksak/plugin-foo` fails; the same name in `packages/**/x.ts` fails; a declared name such as `@soksak/sidecar-vt-alacritty` fails; `@soksak/sidecar-example` fails; `@soksak/plugin-api-x` fails (its base is not a core name); `@scope/sidecar-vt` passes; core `@soksak/plugin-api` passes. These cases fail on the current code only because `checkNames`, the `.ts` extension and the pattern rule do not exist yet. On main, `packageOwner` already gives `@soksak/plugin-foo` no owner, so rule 2 is a new rule, not a fix of a main defect; the prefix defect is on `fix/decouple-F236` (`:4484-4486`).

### Out of scope

Lane and count rows of `check-test-parity.mjs` (the counts change through `make parity-check` in the change that edits it).

---

## Round record

### Round 1

Auditors: two fresh Haiku subagents. Objections and answers are in the committed round-1 record.

### Round 2

Auditors: two fresh Haiku subagents. Objections and answers are in the committed round-2 record (transitive SDK resolution through `ui/`; `make test` running SDK tools; the self-matching rule test; the editor specifiers and hook; the missing `ui/` build output; the rule 2 and rule 4 contradiction; the duplicate rule in `check-test-parity`; the missing spec sentence; the `-example` clauses).

### Round 3

Auditors: two fresh Haiku subagents. Objections and answers are in the committed round-3 record (the whole-repo check on import; `.ts` excluded from `SOURCE`; the false red claim; the private-path loss; the duplicate rule and `allowed` exemption; the SDK bytes in fixtures; the missing build step; the interim hook; the screen-hash dependency; CI not running `make check`).

### Round 4

Auditors: two fresh Haiku subagents. Each objection was verified against the files and answered:

- D3 rule 2 cannot be achieved by extending the existing loop, because the loop builds its rules only from declared components (`check-boundaries.mjs:59-68`): accepted. Rule 2 is now a stated pattern rule added to the loop, which reads no new path; the claim "not a second rule" is withdrawn.
- D3 undeclared `@soksak/plugin-api-x` ambiguity: accepted. Rule 2 states it fails; change 6 has the case.
- D3 private-path rule dropped the plugin-to-core check (`check-test-parity.mjs:4553-4561`): accepted. Rule 5 is name-independent and does not exempt core names; change 3 adds the `@soksak/plugin-api/src/private.js` case.
- D1 direct SDK imports in plugin tests were not covered: accepted. Verified: `@soksak/plugin-api` is imported in 17 plugin test and test-helper files. Change 7 maps each group (binder, view imports, `INTERACTIVE`) to a rewritten fixture, a literal, or a Coverage row.
- D1 CI scope false for two repositories: accepted. Verified: `flowmark` has no `.github` folder; `shell` has `ci.yml` and no `release.yml`. Change 13 gives per-repository rows and records the open defects.
- D1 "no SDK file bytes" has no mechanism: accepted. Change 2 uses a marker-list line comparison inside the test, which reads no SDK file; the SHA-256 comparison runs only in `make check`.

Status: round 5 pending. Round 5 auditors receive this text.
