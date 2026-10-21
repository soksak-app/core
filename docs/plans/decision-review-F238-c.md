# Decision review F238-c: plugin test imports (D1) and owner classification (D3)

[한국어](decision-review-F238-c.ko.md)

This record reviews two decisions. Each states its argument, its evidence with file and line, and the exact required changes. Fresh auditor subagents object only where a decision is wrong or incomplete, and each objection carries a concrete solution. Wording and citation corrections are applied directly and are not objections. A round repeats until both auditors of the round report no substantive objection. A standard changes only with evidence and is never lowered because a test cannot reach it.

Scope: what each decision must settle; what counts as substantive (a wrong premise, a case the rule still breaks, a required change that cannot achieve the rule, a false cited fact, a conflict with AGENTS.md). Out of scope: wording, cases every implementation resolves the same way, details settled by unit tests.

## Evidence base

- Main is `origin/main`. Other branches are read with `git show <branch>:<path>` only.
- Plugin repositories are sibling folders `../plugins/<id>` on their `main` branches.
- Rule source, `AGENTS.md` (Structure): "Tests must not read another package's paths, SDK, build, or implementation names." and "consumer tests use fakes or fixtures at the consumer boundary".

---

## D1. Plugin tests import no SDK code

### Decision

A plugin repository's tests import and resolve no `@soksak/*` name, read no installed package path, and load no SDK bytes. The `@soksak/*` names of the SDK are `@soksak/plugin-api`, `@soksak/runtime` and `@soksak/workbench`, plus sidecar names. A plugin test checks that plugin's own code, manifest and fixtures.

Two things are not SDK and may be loaded by tests: (a) third-party packages declared in `devDependencies`; (b) the bundles that the plugin's own `build-vendor` writes into `ui/vendor/`, which are third-party packages built into the plugin (CodeMirror and its extensions), not SDK code. Tests load (b) by relative path.

Implementation modules under `ui/` keep their `@soksak/*` specifiers, because the page loads them through the import map. A test does not import `ui/` source. The plugin build writes a test tree, `build/test/`, that copies `ui/` and rewrites each SDK specifier to a plugin-authored fixture (the SDK functions the page uses, implemented as fakes at the consumer boundary, with no SDK code). Each plugin's `test` script runs the test-tree build first: `node scripts/build-test.mjs && node --test test/`.

SDK behaviour is tested only in its owning package. A plugin test that asserts an SDK value moves that assertion to the owning core test, and the plugin keeps a literal constant or a fake that the test asserts.

Command split: `make test` runs the plugin test script only. `make check` runs the SDK-reading tools (`soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`), the SHA-256 comparison of the SDK `view-start.js` with a constant held in the check script, the literal-equality checks of values that a fixture holds (the `VIEW_IMPORTS` entries, the screen-message vector), and `build-vendor --check`. Every plugin repository has a `check` target in its Makefile; `pack` depends on `check`. Build and check scripts (not tests) may call SDK validators.

Fakes stay faithful to the SDK through a conformance check. Core commits an export-surface snapshot (export names, arity and declared types) of `@soksak/plugin-api`, `@soksak/runtime` and `@soksak/workbench`. Shape is not enough, so core also commits contract vectors: for each exported function that a fake covers, the input and the expected output, taken from core's own tests. Each plugin's `check` target compares the export names and arity of every fake its test tree uses with the snapshot, runs each fake against the vectors of the functions it covers, and fails on any drift. A check may read SDK files; a test may not.

The decision takes effect for each plugin repository when that repository's sub-items land. Until then the current form is an open defect with an owner, not compliance.

### Argument

- The SDK tests its own formats and view bridge in core: `packages/plugin-api/test/view-page.test.mjs` (`checkViewPage`), `view.test.mjs` (`createViewBridge`), `binder.test.mjs` (`createBinder`), `view-imports.test.mjs` (`VIEW_IMPORTS`), `view-core-targets.test.mjs`, `events-check.test.mjs` (census findings, `:26`, `:147`, `:161`), and `packages/log-contract/test/screen-hash.test.mjs` (screen hash vectors).
- A test that imports `ui/` source resolves the SDK through that source. Rewriting the test-visible specifiers in a build output is the only way to keep SDK code out of a test run.
- A fixture that holds an SDK file or a copy of core data is a copy of SDK bytes in the test run. Literal values that `make check` compares with the core file are allowed; copies are not.

### Evidence (sibling `../plugins/*`, branch `main`)

Files that import `@soksak/plugin-api` in tests or test helpers (17): `appview/test/manifest.test.mjs`; `browser/test/{address-input,empty-state,manifest,page}.test.mjs` (`page.test.mjs:5` imports `INTERACTIVE`; `address-input:5` and `empty-state:5` import `createBinder`); `editor/test/{editor,view,manifest}.test.mjs` (`editor.test.mjs:6` imports `createBinder`; `view.test.mjs:7` imports `VIEW_IMPORTS` and `checkViewPage`); `editor/test/view-host.mjs`; `files/test/manifest.test.mjs`; `hwp/test/hwp.test.mjs:6` (`createBinder`, `validateManifest`; `:158` calls `validateManifest`); `shell/test/{manifest,view}.test.mjs` (`view.test.mjs:7` imports `VIEW_IMPORTS` and `checkViewPage`); `terminal/test/{census,manifest,terminal}.test.mjs` (`terminal.test.mjs:4` imports `createBinder`; `manifest.test.mjs:4` imports `validateDiagnostics` and `validateManifest`); `flowmark/ui/view.test.mjs:7` (`VIEW_IMPORTS`, `checkViewPage`).

Test files that import `@soksak/shared` specifiers: `editor/test/editor.test.mjs:184` and `:198`; `editor/test/fixtures/upper-gutter.mjs:2`; `editor/test/shared-modules.mjs`.

Implementation modules loaded by tests and importing the SDK (transitive): `terminal/ui/terminal.js:1-2` (`@soksak/plugin-api`, `@soksak/plugin-api/screen-hash`), loaded by `terminal/test/terminal.test.mjs:6`; `browser/ui/sections/tabs.js:3` and `history.js:3` (`drawList`), loaded by `browser/test/section-lists.test.mjs:22`; `files/ui/sections/tree-horizontal.js:2`, loaded by `files/test/section-lists.test.mjs:43`; `editor/ui/view.js:7-8` and `flowmark/ui/view.js:7`.

SDK value assertions in plugin tests: `terminal/test/terminal.test.mjs:3874-3885` (golden vector `vector.hash`), `:3880-3888` (frame record fields the page writes), `:3903-3911` (`terminal.screen.alter` changes the next message before hashing).

Copied core data in a plugin fixture: `terminal/test/terminal.test.mjs:3853` says `test/fixtures/screen-message.json` is a copy of `packages/log-contract/fixtures/replay/screen-message.json`, and the test loads it.

SDK bytes loaded by plugin hosts: `packages/plugin-api/view-start.js:1-12` is the injected start script; `editor/test/view-host.mjs:14` and `flowmark/ui/view-host.mjs:13` read it.

Resolver hooks: `editor/test/shared-modules.mjs:4-18` (`registerHooks`, `POINT` `@soksak/shared/editor.extension/`), run by `editor/package.json:23` through `--import`.

SDK tools inside `make test`: `editor/Makefile:16-20` and `terminal/Makefile:16-20` (`soksak-exposure`, `soksak-engines`, `soksak-events --census`); `flowmark/Makefile:10-14` (`soksak-engines`, `soksak-events`, `soksak-records`). `build-vendor --check` runs in `editor/package.json:22` and `files/package.json` `scripts.test`.

Makefiles: no repository defines a `check` target (checked on each `Makefile`).

CI: `ci.yml:23` runs `make test` in `appview`, `browser`, `editor`, `files`, `hwp`, `shell`, `terminal`. `release.yml` exists in `appview`, `browser`, `editor`, `files`, `hwp`, `terminal`. `shell` has no release workflow. `flowmark` has no `.github` folder.

Build scripts: `browser`, `appview`, `shell`, `terminal`, `flowmark` have no `build` script; `editor` and `files` have one that runs `build-vendor` only.

Shipped files: `flowmark/package.json` `files` is `plugin.json`, `events.json`, `ui`; its test script is `node --test ui/`.

### Required changes

1. Test tree: each plugin gains `scripts/build-test.mjs`, which writes `build/test/`. It copies `ui/`, and rewrites every SDK specifier (`@soksak/plugin-api`, `@soksak/plugin-api/*`, `@soksak/runtime`, `@soksak/workbench`) to a plugin-authored fixture module with no SDK code. It leaves third-party specifiers and `ui/vendor/` bundles as they are. The plugin `test` script runs it first. Owner: each plugin repository, one sub-item per repository. `shell` and `flowmark`, which have no build script, gain this script; `browser`, `appview`, `terminal` gain it too.
2. Test rule, per plugin `test/` directory: no line of `test/**` and no line of `ui/**/*.test.mjs` contains the SDK needle, which the test builds from parts (for example `"@" + "soksak/"`) so it does not match its own source; the rule covers the `@soksak/` specifiers of SDK and shared kits, and excludes the `@soksak/shared/editor.extension/` vendored bundles, which change 4 moves to relative paths. The test reads no SDK file. The `view-start.js` comparison is only in `make check`.
3. Resolver hook: `editor/test/shared-modules.mjs` is deleted when change 1 lands, and `editor/package.json:23` drops its `--import`. Until then the hook is an open defect with the editor repository as owner.
4. `editor/test/editor.test.mjs:184` and `:198` and `editor/test/fixtures/upper-gutter.mjs:2` import the vendored bundles by relative path (`ui/vendor/...`). Each assertion keeps its meaning.
5. View host fixtures (`editor/test/view-host.mjs`, `flowmark/ui/view-host.mjs`) read no SDK file and run no SDK script. They use a plugin-authored literal of the start values named in `docs/spec/plugins.md:171` and a plugin-written `sokView` stub. The bridge behaviour of `view-start.js` is tested only in `packages/plugin-api/test/view.test.mjs`.
6. Terminal (`terminal/test/terminal.test.mjs`):
   - The golden-vector assertion (`:3874-3885`) asserts the fake `screenHash` returns a literal. The hash-value equality is mapped to the vector loop in `packages/log-contract/test/screen-hash.test.mjs`, matched by vector name, which asserts the SDK hash on the same vectors.
   - The page-wiring assertions (`:3880-3888` frame fields and `:3903-3911` the altered screen reaching the hash) stay in `terminal/test/`, against the plugin-authored fake `screenHash`, which records its input. They have no core home, so they are not mapped to one.
   - `terminal/test/fixtures/screen-message.json` (the copy of core data at `:3853`) is replaced by a plugin-authored literal of the one vector the test uses. `make check` compares that literal with `packages/log-contract/fixtures/replay/screen-message.json`.
   - The import of `@soksak/plugin-api/screen-hash` in `ui/terminal.js` is rewritten by change 1 to the fake.
7. Direct SDK imports in plugin tests are removed (all 17 files):
   - `createBinder` users (`editor/test/editor.test.mjs:6`, `browser/test/address-input.test.mjs:5`, `browser/test/empty-state.test.mjs:5`, `hwp/test/hwp.test.mjs:6`, `terminal/test/terminal.test.mjs:4`) import the rewritten binder fixture from `build/test/`. Each binder-contract assertion has a Coverage row to `packages/plugin-api/test/binder.test.mjs`; an assertion of the plugin's own binder wiring stays as a fixture-backed assertion.
   - `VIEW_IMPORTS` and `checkViewPage` users (`editor/test/view.test.mjs:7`, `shell/test/view.test.mjs:7`, `flowmark/ui/view.test.mjs:7`): the test reads a literal copy of the four import-map entries; `make check` compares the literal with `VIEW_IMPORTS`. `checkViewPage` runs in the plugin build script of change 8. Coverage rows to `packages/plugin-api/test/view-imports.test.mjs` and `view-page.test.mjs`.
   - `INTERACTIVE` in `browser/test/page.test.mjs:5` is a literal constant with a Coverage row to `packages/plugin-api/test/binder.test.mjs`.
8. SDK validators run in the plugin build script (`scripts/build-test.mjs` or the existing build), not in tests:
   - `validateManifest` in `appview`, `browser`, `editor`, `files`, `hwp` (`hwp/test/hwp.test.mjs:158`), `shell`, `terminal` (`manifest.test.mjs:22`); `validateDiagnostics` in `terminal` (`manifest.test.mjs:4`). Manifest tests read the built output and check its values as literals.
   - `checkViewPage` in `editor`, `shell`, `flowmark` (the three with a view page).
9. `terminal/test/census.test.mjs` is deleted (`:24`, `:29`). The census of plugin sources runs in `make check`. The probe case is covered by `packages/plugin-api/test/events-check.test.mjs` (`:26`, `:147`, `:161`).
10. Flowmark moves its tests and helper from `ui/` to `test/`; its `test` script becomes `node scripts/build-test.mjs && node --test test/`. `ui/` ships only its page files.
11. Makefiles: each plugin repository (`appview`, `browser`, `editor`, `files`, `hwp`, `shell`, `terminal`, `flowmark`) gains a `check` target that runs the change-12 list. `pack` gains `check` as a prerequisite. For `hwp`, whose `pack` already depends on `studio`, the rule is `pack: studio check`.
12. `make check` runs `soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`, the view-start SHA-256 comparison, the literal-equality checks of change 5, 6 and 7, and `build-vendor --check`. Each repository's `check` target runs the subset its files need, and the spec lists the repositories and their subsets.
13. CI and release, per repository (no repository is assumed to have a file it lacks):
    - `appview`, `browser`, `editor`, `files`, `hwp`, `terminal`: `ci.yml` and `release.yml` run `make check` after `make test`.
    - `shell`: `ci.yml` runs `make check` after `make test`. It has no `release.yml`; the sub-item records that as an open defect with owner `shell`, so `make pack` runs only by hand.
    - `flowmark`: no `.github` folder exists. Its sub-item adds `ci.yml` that runs `make test` and `make check`, or records the absence as an open defect with owner `flowmark`.
14. Spec: `docs/spec/plugins.md:40` changes from "`make test` runs the tests of a plugin repository" and "depends on `@soksak/plugin-api` for its tests" to: `make test` runs the plugin tests; `make check` runs the SDK tools; the plugin repository depends on `@soksak/plugin-api` as a build dependency. `docs/spec/plugins.md:171` ("a plugin repository test calls `checkViewPage`") changes to: the plugin build calls `checkViewPage`. Owner: core `main`, with `.ko.md` mirrors.


15. Conformance: core commits a generated export-surface snapshot (names, arity and declared types) of `@soksak/plugin-api`, `@soksak/runtime` and `@soksak/workbench`. Core also commits contract vectors (input and expected output per exported function, taken from core's tests). Each plugin's `check` target compares every fake of its test tree with that snapshot, runs each fake against the vectors of the functions it covers, and fails on drift. Owner: core `main` for the snapshot; each plugin repository for the comparison.

### Coverage

Each removed assertion maps to a core test, a fake-backed assertion in the plugin, or a literal check in `make check`. The table is written in the sub-item before any test is deleted. Rows required from the start: `terminal/test/terminal.test.mjs:3874-3885` (hash equality to `screen-hash.test.mjs` vectors; page wiring stays), `:3880-3911` (stay, against the fake), `terminal/test/census.test.mjs:24,29` (to `events-check.test.mjs`), `browser/test/page.test.mjs:5` (to `binder.test.mjs`), the binder assertions at `editor/test/editor.test.mjs:6`, `browser/test/address-input.test.mjs:5`, `browser/test/empty-state.test.mjs:5`, `hwp/test/hwp.test.mjs:6`, `terminal/test/terminal.test.mjs:4` (to `binder.test.mjs`), the `VIEW_IMPORTS`/`checkViewPage` assertions at `editor/test/view.test.mjs:7`, `shell/test/view.test.mjs:7`, `flowmark/ui/view.test.mjs:7` (to `view-imports.test.mjs` and `view-page.test.mjs`), and the validator assertions at `hwp/test/hwp.test.mjs:158` and `terminal/test/manifest.test.mjs:4,22` (to `packages/plugin-api/test/` manifest and diagnostics tests). No assertion is dropped without a row.

### Out of scope

Fixture comment wording and exact fixture file names (chosen in the sub-item).

---

## D3. Owner classification by declared name

### Decision

Ownership of a plugin or sidecar name is decided from the declarations. Core names come from `packages/*/package.json` and `packages/host/*/package.json`. A plugin or sidecar name is a `@soksak/plugin-*` or `@soksak/sidecar-*` base that is not a core name.

1. `scripts/check-boundaries.mjs` (which reads the declared folders and already states that core names no plugin or sidecar) adds a pattern rule to its loop: every tracked source file of the workspace (every extension the check reads, including `.ts`, `.tsx`, `.cjs`), except the declared plugin and sidecar folders that rule 2 covers, that contains an `@soksak/` base which is not an exact core package name fails, declared or not. The rule uses no declarations, so a declared `@soksak/plugin-browser` in core fails too, and an undeclared `@soksak/hwp` in `apps/`, `e2e/` or `scripts/` fails. The rule reads only the tracked source files of the workspace. The `allowed` exemption (`check-boundaries.mjs:33-35`) is removed for these names; the only core `package.json` that names one is `@soksak/plugin-api`, a core name.
2. `scripts/check-test-parity.mjs` keeps the owner check of plugin and sidecar code: a reference from one owner's implementation or test to another owner's implementation is a finding. The owner of a base is the `kind` of the declared component whose `package.json` name equals it (`components()` of `check-boundaries.mjs`, reading `scripts/workspace-registry.json`). An undeclared `@soksak/` base in plugin or sidecar code is a finding ("undeclared"); no prefix classifies it.
3. Exact match: a base is a core name only when it equals a core package name exactly. `@soksak/plugin-api-x` is not `@soksak/plugin-api`.
4. Names outside the `@soksak/` scope are not owners and are not checked. `docs/spec/plugins.md` (Repositories) states this limit (change 6).
5. Private-path rule, declaration-based: in `check-test-parity.mjs` `auditOwnership`, a `@soksak/` reference with a subpath fails as "private" unless the subpath is listed in the `exports` map of the target package's `package.json` (a package without an `exports` map exposes no subpath), or the reference names the referencing package's own declared name. The target package is read from the declared workspace packages, and the referencing name is the `name` of the nearest `package.json` above the file; both are read through an injected reader. No segment list and no core list is used.
6. The reference extraction covers `import`, `from`, `require(`, `import(` and the bare `require.resolve("@soksak/...")` form; a bare reference with a private subpath is matched by the same pattern.
7. Core test fixtures use `@scope/`. Existing `@soksak/sidecar-vt` fixtures are renamed. The `-example` clauses are removed.

### Argument

- A prefix is not a contract, and `docs/spec/plugins.md` gives no npm-name rule. A list of plugin names in core is knowledge of plugins in core, which the boundary rule forbids. Rule 1 needs neither a prefix nor declarations: every `@soksak/` base outside the plugin and sidecar folders that is not an exact core name is a finding, so a name fails whatever its shape or declaration. Rule 2 classifies by declared kind only, and an undeclared reference is reported as a finding.
- `check-boundaries.mjs` already reads the declared folders (`origin/main:scripts/check-boundaries.mjs:25-44`). Rule 1 is one pattern in its existing loop and reads no new path. Rule 2 is the owner check that `check-test-parity` already performs, now using declared names instead of literals; it reads the declarations through the same `components()` function.
- A segment list is not a contract: `PRIVATE_SEGMENT` would pass `@soksak/runtime/lib/x.js` and `@soksak/workbench/internal.js` unless they were named, so the declared `exports` map decides which subpaths are public.
- The private rule is independent of owner classification: without it, a plugin that imports a private subpath of a core package passes, and `apps/` and `e2e/` (not checked by `check-boundaries`) escape any finding.
- `startsWith` would classify `@soksak/plugin-api-x` as a plugin; exact base matching does not, and rule 1 fails `@soksak/plugin-api-x` only because its base is not a core name.

### Evidence

- `origin/main:scripts/check-test-parity.mjs:4514-4523`: `packageOwner` gives the core literals `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench` the owner `core` (`:4516`), the plugin list `:4517-4519` and sidecar list `:4520-4522` (each with an `-example` clause) their owners, and returns `null` otherwise (`:4523`). So on main `@soksak/plugin-foo` has no owner. On `fix/decouple-F236` the prefix branches at `:4484-4486` classify every `@soksak/plugin-*` and `@soksak/sidecar-*` name.
- `origin/main:scripts/check-test-parity.mjs:4553-4563`: the private error fires when the referenced owner differs from the referencing owner (`:4556-4557`), and a plugin or sidecar reference to another owner's implementation is a finding at `:4563`. On main, a plugin importing `@soksak/plugin-api/src/private.js` is flagged.
- `origin/main:scripts/check-test-parity.mjs:4527-4531` (`ownerReferences`) collects `IMPORT_SPECIFIER` matches and `PACKAGE_REFERENCE` matches. `PACKAGE_REFERENCE` (`:4504`) matches only `plugin-` and `sidecar-` names, so a bare `require.resolve("@soksak/runtime/src/x.js")` is missed on main.
- `origin/main:scripts/check-boundaries.mjs:17`: `SOURCE` is `/\.(js|mjs|html|css|json|go|rs|m|h|toml)$/`, which excludes `.ts`, `.tsx`, `.cjs`. `packages/soksak/src/*.ts` (8 files) and `packages/soksak/dist/*.d.ts` (9 files) exist on main.
- `origin/main:scripts/check-boundaries.mjs:1-5` (header); `:25-44` (`components()`); `:33-35` (`allowed`); `:58-93` (the declared loop, which runs on import).
- `origin/main:scripts/workspace-registry.mjs:170` uses an entry guard (`import.meta.url` against `process.argv[1]`).
- `origin/main:scripts/test/test-parity.test.mjs:195-218` asserts the "sidecar" finding for `plugins/example/ui/module.js` importing `@soksak/sidecar-example` (`:203-209`) and the "private" finding for `@soksak/sidecar-example/src/private.js` (`:215-218`).
- `origin/main:scripts/workspace-registry.json` declares plugins `browser, editor, files, hwp, terminal` and sidecars `files`, `vt-alacritty`.
- `origin/main:docs/spec/plugins.md:34` lists `browser, terminal, files` and `shell`; it disagrees with the registry and is corrected in change 8.
- Undeclared `@soksak/sidecar-vt` fixtures: `origin/main:packages/workbench/test/library-plugins.test.mjs:35` and `:98`; `origin/main:packages/workbench/test/plugin-operations.test.mjs:63`. `@scope/sidecar-probe` fixtures already in core: `origin/main:packages/workbench/test/plugin-states.test.mjs:54,63,90`.

### Required changes

1. `scripts/check-boundaries.mjs`: add `ts`, `tsx`, `cjs` to `SOURCE` (`:17`). Wrap the top-level run in an entry guard `if (import.meta.url === pathToFileURL(process.argv[1]).href)`. Export `components()` and `checkNames(components, files)`, which adds the pattern rule of decision rule 1 to the loop. Remove the `allowed` exemption for plugin and sidecar names, and add the rule that fails every `@soksak/` base outside the declared plugin and sidecar folders that is not an exact core package name, declared or not, scanning the tracked source files of the workspace.
2. `scripts/check-test-parity.mjs` (`main` `:4514-4523`; `fix/decouple-F236` `:4482-4491`): remove the core literals and the plugin and sidecar lists from `packageOwner`, and the `-example` and prefix branches. Build the owner lookup from `components()` of `check-boundaries.mjs` (rule 2). Keep `OWNER_ROOTS`. Add the private rule of decision rule 5 and the extraction of rule 6 to `auditOwnership`, with an injected reader of the declared packages' `package.json` files (names and `exports` maps). The `main` change and the `fix/decouple-F236` change are separate commits.
3. `scripts/test/test-parity.test.mjs:195-218`: the "sidecar" assertion becomes a `check-test-parity` owner-check case (rule 2), and the "private" assertion stays under rule 5. New cases: `plugins/x/ui/a.js` importing `@soksak/sidecar-y` fails as "sidecar" when `sidecar-y` is declared; `plugins/x/ui/a.js` importing `@soksak/plugin-api/src/private.js` fails as "private"; `plugins/x/ui/a.js` with `require.resolve("@soksak/runtime/src/x.js")` fails as "private"; `@soksak/plugin-api` without a subpath passes; `apps/` and `e2e/` private paths fail; `@soksak/runtime/lib/x.js` fails as "private" when `lib/x.js` is not in the `exports` map, and a subpath listed in the `exports` map passes; `@soksak/hwp` in a core source fails as undeclared.
4. Rename `@soksak/sidecar-vt` fixtures to `@scope/sidecar-vt` in `library-plugins.test.mjs:35,98` and `plugin-operations.test.mjs:63`. Those tests do not exercise the real sidecar.
5. `checkNames` tests in `scripts/test/`: `packages/**/x.js` with an undeclared `@soksak/plugin-foo` fails; the same name in `packages/**/x.ts` fails; a declared `@soksak/sidecar-vt-alacritty` fails in core; `@soksak/sidecar-example` fails; `@soksak/plugin-api-x` fails; undeclared `@soksak/hwp` fails; a declared `@soksak/plugin-browser` in `packages/**/x.js` fails; `@soksak/hwp` in `apps/` fails; `@scope/sidecar-vt` passes; core `@soksak/plugin-api` passes. These fail on the current code only because `checkNames`, the `.ts` extension and the rule do not exist yet. On main, `packageOwner` gives `@soksak/plugin-foo` no owner, so rule 1 is a new rule; the prefix defect is on `fix/decouple-F236` (`:4484-4486`).
6. `docs/spec/plugins.md:34` (Repositories) is rewritten to the registry list (declared plugins `browser, editor, files, hwp, terminal`; repositories that are not declared named separately). The same section adds: core names no plugin or sidecar; undeclared `@soksak/` names are rejected in core sources, and undeclared references in plugin and sidecar code are findings; names outside `@soksak/` are not checked. Owner: core `main`, with `.ko.md`.

### Out of scope

Lane and count rows of `check-test-parity.mjs` (the counts change through `make parity-check` in the change that edits it).

---

## Round record

### Rounds 1 to 4

Recorded in the committed history of this file (git log of `docs/plans/decision-review-F238-c.md`, rounds 1 to 4). Each round's objections and answers are in the record of its commit.

### Round 5

Two fresh Haiku subagents reported substantive objections. Each was checked against the files:

- D1 line-equality cannot match an import line (the `@soksak/` needle is a substring of `import ... from "@soksak/plugin-api"`): accepted. The rule now tests containment.
- D1 `view-start.js` first line held as a literal copies SDK bytes: accepted. The marker list keeps only a plugin-authored token, and the SHA-256 comparison is in `make check`.
- D1 `checkViewPage` moved into a build step that no change creates: accepted. Change 8 adds `checkViewPage` to the build of the three view-page plugins, and `shell` and `flowmark` gain a build script (change 1).
- D1 `check` target not created in any Makefile (verified: no `check:` line in any plugin Makefile): accepted. Change 11 adds it per repository with `pack: check`; `hwp` is `pack: studio check`.
- D1 terminal assertions mapped to a target that cannot test page wiring (`terminal.test.mjs:3880-3911`): accepted. Hash equality maps to the vector loop; the page wiring stays in terminal against the fake.
- D1 `terminal/test/fixtures/screen-message.json` is a copy of core data (verified at `:3853`): accepted. Change 6 replaces it with a literal checked by `make check`.
- D1 "shared kit" conflicts with the vendored bundles: accepted. The decision states that `ui/vendor/` bundles are third-party code built into the plugin, not SDK, and tests load them by relative path (change 4).
- D1 `hwp` and `terminal` validators omitted (verified: `hwp/test/hwp.test.mjs:158`, `terminal/test/manifest.test.mjs:4,22`): accepted. Change 8 names them.
- D3 the name-owner check has no home after the change (`test-parity.test.mjs:203-209`): accepted. Rule 2 keeps the owner check in `check-test-parity` with declared names and the prefix for undeclared references, stated as a limit.
- D3 bare `require.resolve` form missed by `ownerReferences` (`check-test-parity.mjs:4504`, `:4527-4531`): accepted. Rule 6 adds the bare form.
- D3 self-exemption has no mechanism (no package name reaches `auditOwnership`): accepted. Rule 5 names the injected nearest-`package.json` reader. The "core names" wording is removed from rule 5, so the rule does not depend on core names.

### Round 6

Two fresh Haiku auditors, asked only whether D1 or D3 itself is wrong, reported objections:

- D1 has no check that the plugin fakes match the SDK surface, so a changed SDK signature passes every plugin test. Accepted: change 15 adds a core export-surface snapshot and a comparison in each plugin's `check` target.
- D3 rule 5 uses `PRIVATE_SEGMENT`, a segment list, so an unlisted subpath passes. Accepted: the rule uses the declared `exports` map.
- D3 rules 1 and 2 select names by prefix, so an undeclared plain name such as `@soksak/hwp` passes. Accepted: rule 1 fails every `@soksak/` base that is neither a core name nor declared; rule 2 classifies by declared kind only.

### Round 7

Two fresh Haiku auditors, asked only whether D1 or D3 itself is wrong, reported objections:

- D1: a shape-only check (names, arity, declared types) cannot catch a behaviour change, so a fake can keep the signature and return different values. Accepted: core commits contract vectors (input and expected output per exported function, from core's tests), and each plugin's `check` runs its fakes against them (change 15).
- D3: rule 1 failed only bases that were neither a core name nor declared, so a declared `@soksak/plugin-browser` in core passed, and rule 1 scanned only `packages/**`, so an undeclared `@soksak/hwp` in `apps/`, `e2e/` or `scripts/` passed. Accepted: rule 1 scans every tracked source file outside the declared plugin and sidecar folders and fails any `@soksak/` base that is not an exact core package name, declared or not. Declarations are used only by rule 2.

Status: round 8 pending. Round 8 auditors receive this text.
