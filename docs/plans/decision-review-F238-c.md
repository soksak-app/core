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

SDK behaviour is tested only in its owning package. A plugin test does not repeat it. Where a plugin test today asserts an SDK value, the value moves to the owning core test; the plugin keeps a literal constant with a fake that returns it.

Command split: `make test` runs the plugin test script only. `make check` runs the SDK-reading tools (`soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`), the byte-equality check of the SDK view start script against a hash held in the check script, and `build-vendor --check`. Each plugin's CI workflow and its release workflow run `make check` after `make test`; `make pack` depends on `make check`. Build and check scripts (not tests) may call SDK validators and read `VIEW_IMPORTS`.

The decision takes effect for each plugin repository when that repository's sub-items (the build test tree and the CI change) land. Until then the current form is recorded as an open defect with its owner, not as compliance.

### Argument

- The rule forbids a test from reading another package's SDK or implementation. The SDK tests its own formats and view bridge in core: `packages/plugin-api/test/view-page.test.mjs` (`checkViewPage`), `view.test.mjs` (`createViewBridge`), `binder.test.mjs` (`createBinder`), `view-imports.test.mjs` (`VIEW_IMPORTS`), `view-core-targets.test.mjs`, `events-check.test.mjs` (census findings, `:26`, `:147`, `:161`), and `packages/log-contract/test/screen-hash.test.mjs` (screen hash contract).
- A test that imports `ui/` source resolves the SDK through that source. Rewriting the test-visible specifiers in a build output is the only way to keep SDK code out of a test run, and it is a build step, which the rule allows.
- A test fixture that holds an SDK file or a copy of one runs SDK code in the test run, so no fixture holds SDK bytes.

### Evidence (sibling `../plugins/*`, branch `main`)

Test files that import or resolve `@soksak/*` (20): `appview/test/manifest.test.mjs`; `browser/test/{address-input,empty-state,manifest,page}.test.mjs` (`page.test.mjs:5` imports `INTERACTIVE`); `editor/test/{editor,manifest,view}.test.mjs` (`editor.test.mjs:6` imports `createBinder`; `:184` and `:198` name `@soksak/shared` specifiers); `editor/test/view-host.mjs`; `editor/test/shared-modules.mjs`; `editor/test/fixtures/upper-gutter.mjs:2` (imports `@soksak/shared/editor.extension/@codemirror/view.js`); `files/test/manifest.test.mjs`; `flowmark/ui/view.test.mjs`; `hwp/test/hwp.test.mjs`; `shell/test/{manifest,view}.test.mjs`; `terminal/test/{census,manifest,terminal}.test.mjs` (`terminal.test.mjs:4` imports `@soksak/plugin-api`).

Implementation modules loaded by tests that import the SDK (transitive): `terminal/ui/terminal.js:1-2` (`@soksak/plugin-api`, `@soksak/plugin-api/screen-hash`), loaded by `terminal/test/terminal.test.mjs:6`; `browser/ui/sections/tabs.js:3` and `history.js:3` (`drawList`), loaded by `browser/test/section-lists.test.mjs:22`; `files/ui/sections/tree-horizontal.js:2`, loaded by `files/test/section-lists.test.mjs:43`; `editor/ui/view.js:7-8` and `flowmark/ui/view.js:7`, loaded by `editor/test/view.test.mjs` and `flowmark/ui/view.test.mjs`.

SDK value assertions in plugin tests: `terminal/test/terminal.test.mjs:3874-3885` (the SDK golden-vector hash `vector.hash`) and `:3909-3911` (an altered message hashes differently). These are SDK contract checks and move to `packages/log-contract/test/screen-hash.test.mjs`.

SDK bytes loaded by plugin hosts: `packages/plugin-api/view-start.js:1-12` is the injected start script. `editor/test/view-host.mjs:14` and `flowmark/ui/view-host.mjs:13` read it and run it in a window.

Resolver hooks: `editor/test/shared-modules.mjs:4-18` (`registerHooks`, `POINT` `@soksak/shared/editor.extension/`), run by `editor/package.json:23` through `--import`. `flowmark/ui/view-host.mjs` resolves `@soksak/plugin-api` with `require.resolve`.

Makefile targets that run SDK tools inside `make test`: `editor/Makefile:16-20` and `terminal/Makefile:16-20` (`soksak-exposure`, `soksak-engines`, `soksak-events --census`); `flowmark/Makefile:10-14` (`soksak-engines`, `soksak-events`, `soksak-records`). `build-vendor --check` runs in `editor/package.json:22` and in `files/package.json` `scripts.test`.

CI: `appview`, `browser`, `editor`, `files`, `hwp`, `shell` and `terminal` each run `make test` at `.github/workflows/ci.yml:23`; none runs `make check`.

Build scripts: `browser`, `appview`, `shell`, `terminal` and `flowmark` have no `build` script; `editor` and `files` have one that runs `build-vendor` only.

Shipped files: `flowmark/package.json` `files` is `plugin.json`, `events.json`, `ui`; its test script is `node --test ui/`.

### Required changes

1. Test tree build: each plugin gains `scripts/build-test.mjs`, which writes `build/test/`. It copies `ui/`, and rewrites every `@soksak/*` specifier to a plugin-authored fixture module (the SDK names the page uses, implemented with the host call names and no SDK code) or to the vendored file named by `plugin.json` `extends.extension.modules`. The plugin `test` script runs it first, then `node --test test/`. Owner: each plugin repository, one sub-item per repository.
2. Test rule: a test in each plugin's `test/` builds its needle from parts (for example `"@" + "soksak/"`), so it does not match its own source. It asserts that every file under `test/**` and every `ui/**/*.test.mjs` contains no `@soksak/` specifier and no SDK file bytes. The only `ui/` code that tests import is the build output.
3. Resolver hooks: `editor/test/shared-modules.mjs` is deleted when the test tree of change 1 lands, and `editor/package.json:23` drops its `--import`. Until then the hook is recorded as an open defect with the editor repository as owner.
4. `editor/test/editor.test.mjs:184` and `:198` and `editor/test/fixtures/upper-gutter.mjs:2` import the vendored file through the test tree. Each assertion keeps its meaning.
5. The view host fixtures (`editor/test/view-host.mjs`, `flowmark/ui/view-host.mjs`) do not read or run `packages/plugin-api/view-start.js`. They use a plugin-authored literal of the start values named in `docs/spec/plugins.md:171` (`window.sokSurface` `{surface, params, origin, project, declarations}`) and a plugin-written `sokView` stub. `make check` compares the SHA-256 of the SDK `view-start.js` with a constant held in the check script, and no SDK file is written into `test/`. The bridge behaviour of `view-start.js` is tested only in `packages/plugin-api/test/view.test.mjs`.
6. `terminal/test/terminal.test.mjs:3874-3885` and `:3909-3911`: the golden-vector and altered-message assertions move to `packages/log-contract/test/screen-hash.test.mjs`, which already holds the screen-hash contract. In terminal, `ui/terminal.js` `@soksak/plugin-api/screen-hash` is rewritten by change 1 to a plugin-authored fake `screenHash` whose result the plugin test asserts as a literal constant.
7. Flowmark moves its tests and helper from `ui/` to `test/`; its `test` script becomes `node scripts/build-test.mjs && node --test test/`. `ui/` ships only its page files.
8. `terminal/test/census.test.mjs` is deleted (`:24` and `:29`). The census of plugin sources runs in `make check`. The probe case is covered by `packages/plugin-api/test/events-check.test.mjs` (`:26`, `:147`, `:161`).
9. `make test` runs the plugin test script only. `make check` runs `soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`, the view-start hash check and `build-vendor --check`. Each plugin's `.github/workflows/ci.yml` and `release.yml` run `make check` after `make test`; `make pack` depends on `make check`. Owner: each plugin repository (one row per repository in its sub-item).
10. `browser/test/page.test.mjs:5` replaces the `INTERACTIVE` import with a literal constant. The binder contract stays tested in `packages/plugin-api/test/binder.test.mjs`.
11. Manifest and diagnostics validation runs in the plugin build with the SDK validators. Manifest tests read the built output and check its values as literals.
12. Spec: `docs/spec/plugins.md:40` changes from "`make test` runs the tests of a plugin repository" and "depends on `@soksak/plugin-api` for its tests" to: `make test` runs the plugin tests; `make check` runs the SDK tools; the plugin repository depends on `@soksak/plugin-api` as a build dependency. `docs/spec/plugins.md:171` ("a plugin repository test calls `checkViewPage`") changes to: the plugin build calls `checkViewPage`. Owner: core `main`, with `.ko.md` mirrors.

### Coverage

Each removed plugin assertion maps to a core test or a plugin fixture assertion. The table is written in the sub-item before any test is deleted: plugin file and test name, then core test file and name or the new fixture assertion. The rows that are required at the start are `terminal/test/terminal.test.mjs:3874-3885` and `:3909-3911` (to `packages/log-contract/test/screen-hash.test.mjs`), `terminal/test/census.test.mjs:24,29` (to `events-check.test.mjs`), and `browser/test/page.test.mjs:5` (to `binder.test.mjs`). No assertion is dropped without a row.

### Out of scope

Fixture comment wording and exact fixture file names (chosen in the sub-item). The sub-items for each repository are recorded with their owners in the final round.

---

## D3. Owner classification by declared name

### Decision

The name rule for `@soksak/plugin-*` and `@soksak/sidecar-*` lives in `scripts/check-boundaries.mjs`, which already reads the declared folders and already states that core names no plugin or sidecar. It is extended, not duplicated. `scripts/check-test-parity.mjs` keeps its path-based owner roots and gains a name-free private-path rule. It no longer classifies plugin or sidecar names.

1. Core names are the `name` of each `packages/*/package.json` and `packages/host/*/package.json` (`components()` in `check-boundaries.mjs`).
2. Any `@soksak/plugin-*` or `@soksak/sidecar-*` name in a core source (`packages/**`, every extension the check reads, including `.ts`, `.tsx`, `.cjs`) that is not a core name fails the check. The declared set is not an exemption. The current `allowed` exemption (a core package's own dependency keys, `check-boundaries.mjs:33-35`) is removed for these names; no core `package.json` names a plugin or sidecar today (verified: the only `@soksak/plugin-*` names in core `package.json` files are `@soksak/plugin-api`).
3. A reference is matched by its two-segment base (`@scope/name`) with exact equality; `@soksak/plugin-api-x` is not `@soksak/plugin-api`.
4. Other scopes are not owners and are not classified. Undeclared plain plugin ids are not detected. `docs/spec/plugins.md` (Repositories) will state this limit (change 5).
5. Private-path rule (name-free): in `scripts/check-test-parity.mjs` `auditOwnership`, any `@soksak/` reference whose two-segment base is not a core name and whose subpath matches the private-segment pattern fails as "private", in every owner root (`packages/`, `plugins/`, `sidecars/`, `native/`, `apps/`, `e2e/`). The core names come from `packages/*/package.json`, read as in change 1.
6. Core test fixtures use `@scope/`. Existing `@soksak/sidecar-vt` fixtures are renamed.
7. The `-example` clauses are removed. A name such as `@soksak/sidecar-example` is not an exemption; a fixture of that form under `packages/**` fails rule 2.

### Argument

- A prefix is not a contract. `docs/spec/plugins.md` gives GitHub repository names and no npm-name rule. A list in core is knowledge of plugins in core, which the boundary rule forbids.
- `check-boundaries.mjs` already reads the declared folders' `package.json` names and `plugin.json` ids (`origin/main:scripts/check-boundaries.mjs:25-44`), and already flags declared names in core sources (`:58-93`). Extending that loop adds no new reading across repositories. A second rule in `check-test-parity.mjs` would add one, so the name rule is not placed there.
- The private rule is independent of names classified by owner. Without it, `apps/` and `e2e/` (not checked by `check-boundaries`) could import another repository's private path with no finding.
- `startsWith` would classify `@soksak/plugin-api-x` as a plugin; exact base matching does not.

### Evidence

- `origin/main:scripts/check-test-parity.mjs:4514-4523`: `packageOwner` on main classifies the core literals `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench` (`:4516`), and the names in the plugin list `:4517-4519` and sidecar list `:4520-4522`, each with an `-example` clause. A name outside these lists returns `null` (`:4523`), so `@soksak/plugin-foo` has no owner on main. On `fix/decouple-F236` the prefix branches at `:4484-4486` classify every `@soksak/plugin-*` and `@soksak/sidecar-*` name.
- `origin/main:scripts/check-test-parity.mjs:4553-4556`: the private error is raised only when the referenced owner from `packageOwner` is non-null.
- `origin/main:scripts/check-boundaries.mjs:17`: `SOURCE` is `/\.(js|mjs|html|css|json|go|rs|m|h|toml)$/`, which excludes `.ts` and `.tsx`. `packages/soksak/src/*.ts` (8 files) and `packages/soksak/dist/*.d.ts` (9 files) exist on main.
- `origin/main:scripts/check-boundaries.mjs:1-5` (header: core names no plugin or sidecar); `:25-44` (`components()`); `:33-35` (`allowed`); `:58-93` (the core loop, which runs on import).
- `origin/main:scripts/workspace-registry.mjs:170` uses an entry guard (`import.meta.url` against `process.argv[1]`), the pattern change 1 applies.
- `origin/main:scripts/test/test-parity.test.mjs:195-204` asserts a "sidecar" error for `@soksak/sidecar-example` from name classification; `:215-218` asserts a "private" error for `@soksak/sidecar-example/src/private.js`. The private assertion stays with the private rule; the name assertions move.
- `origin/main:scripts/test/soksak-scripts.test.mjs:118-131` already tests the declared-name rule in `check-boundaries`.
- `origin/main:scripts/workspace-registry.json` declares plugins `browser, editor, files, hwp, terminal` and sidecars `files`, `vt-alacritty`.
- `origin/main:docs/spec/plugins.md:34` lists `browser, terminal, files` and `shell`; it disagrees with the registry and is corrected in change 5.
- Undeclared `@soksak/sidecar-vt` fixtures: `origin/main:packages/workbench/test/library-plugins.test.mjs:35` and `:98`; `origin/main:packages/workbench/test/plugin-operations.test.mjs:63`. The `@scope/sidecar-probe` fixtures already in core: `origin/main:packages/workbench/test/plugin-states.test.mjs:54,63,90`.

### Required changes

1. `scripts/check-boundaries.mjs`: add `ts`, `tsx` and `cjs` to `SOURCE` (`:17`). Wrap the top-level run (`:58-93` and the final report) in an entry guard `if (import.meta.url === pathToFileURL(process.argv[1]).href)`, so that tests can import the module without running the whole-repo check. Export `components()` and `checkNames(components, files)`. `checkNames` implements rules 2 and 3 in the existing loop; it is not a second rule. Remove the `allowed` exemption for plugin and sidecar names (`:33-35` and its use). The check runs in the `make boundaries` lane, which already reads the declared sibling manifests.
2. `scripts/check-test-parity.mjs` (`main` `:4514-4523`; `fix/decouple-F236` `:4482-4491`): remove the name classification of `packageOwner` (core literals, plugin and sidecar lists, `-example` and prefix branches). Keep `OWNER_ROOTS` and the path-based references. Add the name-free private rule of decision rule 5 to `auditOwnership`, reading core names from `packages/*/package.json`. The `main` change and the `fix/decouple-F236` change are separate commits.
3. Move the name assertions of `scripts/test/test-parity.test.mjs:195-204` to a `scripts/test/` test of `checkNames`, using injected file sets. Keep the private assertions (`:215-218`) in `check-test-parity` under the private rule. Add private-path cases for `apps/` and `e2e/`.
4. Rename the `@soksak/sidecar-vt` fixtures to `@scope/sidecar-vt` in `library-plugins.test.mjs:35,98` and `plugin-operations.test.mjs:63`. Those tests do not exercise the real sidecar.
5. `docs/spec/plugins.md:34` (Repositories) is rewritten to the registry list (declared plugins `browser, editor, files, hwp, terminal`; repositories that are not declared are named separately). The same section adds: core names no plugin or sidecar; undeclared plain plugin ids are not detected. Owner: core `main`, with `.ko.md`.
6. `scripts/test/` tests of `checkNames`: exact base match (`@soksak/plugin-api-x` is not an owner); an undeclared `@soksak/plugin-foo` in a `packages/**` `.js` file fails; the same name in a `packages/**` `.ts` file fails; a declared name such as `@soksak/sidecar-vt-alacritty` fails; `@soksak/sidecar-example` fails; `@scope/sidecar-vt` passes; `@soksak/plugin-api` in core passes. These cases are red only because `checkNames` and the `.ts` extension do not exist yet. On main, `packageOwner` already gives `@soksak/plugin-foo` no owner, so rule 2 is a new rule, not a fix of a prefix defect on main; the prefix defect is on `fix/decouple-F236` (`:4484-4486`).

### Out of scope

Lane and count rows of `check-test-parity.mjs` (the counts change through `make parity-check` in the change that edits it).

---

## Round record

### Round 1

Auditors: two fresh Haiku subagents. Objections and answers are in the committed round-1 record.

### Round 2

Auditors: two fresh Haiku subagents. Objections and answers are in the committed round-2 record (transitive SDK resolution through `ui/`; `make test` running SDK tools; the self-matching rule test; the editor specifiers and hook; the missing `ui/` build output; the rule 2 and rule 4 contradiction; the duplicate rule in `check-test-parity`; the missing spec sentence; the `-example` clauses).

### Round 3

Auditors: two fresh Haiku subagents. Each objection was verified against the files and answered:

- D3 unit test runs the whole-repo check on import: accepted. Change 1 adds an entry guard, following `workspace-registry.mjs:170`.
- D3 `.ts` sources excluded by `SOURCE`: accepted. Change 1 adds `ts`, `tsx`, `cjs`; rule 2 names them; change 6 tests a `.ts` case.
- D3 false "red on current code" claim: accepted and corrected. On main, `packageOwner` gives `@soksak/plugin-foo` no owner; the prefix defect is on `fix/decouple-F236`. Change 6 states both.
- D3 private-path loss in `check-test-parity`: accepted. Rule 5 and change 2 keep a name-free private rule in every owner root, and change 3 adds `apps/` and `e2e/` cases.
- D3 second rule duplicates `check-boundaries` and the `allowed` exemption: accepted. No parallel `checkNames` is added; the existing loop is extended and the `allowed` exemption for these names is removed. Verified: the only `@soksak/plugin-*` names in core `package.json` files are `@soksak/plugin-api`, so no core dependency loses its exemption.
- D1 the view-start copy runs SDK code: accepted. Change 5 uses a plugin-authored start literal; `make check` compares a SHA-256 constant; no SDK bytes enter `test/`. The `view-start.js` bridge is tested in `packages/plugin-api/test/view.test.mjs`.
- D1 the build step is missing: accepted. Change 1 adds `scripts/build-test.mjs` to each plugin, run first by its `test` script; the build-script gap is recorded per repository.
- D1 interim hook described as an exception: accepted. The decision takes effect per repository when its sub-item lands; the current state is an open defect, not compliance.
- D1 `@soksak/plugin-api/screen-hash` has no rewrite target and the terminal golden-vector assertions depend on the SDK: accepted. Change 6 moves the golden-vector assertions to `packages/log-contract/test/screen-hash.test.mjs` and rewrites `screenHash` to a plugin-authored fake in terminal; Coverage rows are listed.
- D1 CI does not run `make check`: accepted. Verified: all seven plugin `ci.yml` files run `make test` at line 23. Change 9 adds `make check` to CI and release, one row per repository.

Status: round 4 pending. Round 4 auditors receive this text.
