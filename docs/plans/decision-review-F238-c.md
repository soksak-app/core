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

A plugin repository's tests import and resolve no `@soksak/*` name (the SDK `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`, the shared kit, a sidecar), and read no installed package path. A plugin test checks that plugin's own code, manifest and fixtures.

Implementation modules under `ui/` keep their `@soksak/*` specifiers, because the page loads them through the import map. A test does not import `ui/` source. The build writes a test tree (`build/test/`) that copies `ui/` and rewrites each `@soksak/*` specifier to a plugin-local fixture (the SDK functions the page uses, as fakes at the consumer boundary) or to the vendored file that `plugin.json` names. Tests import only that tree, plugin-local fixtures and third-party public packages declared in `devDependencies`.

Command split: `make test` runs `pnpm test` only (`node --test`). `make check` runs the SDK-reading tools (`soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`) and `build-vendor --check`. `make pack` and CI depend on `make check`. Build and check scripts (not tests) may call SDK validators and read `VIEW_IMPORTS`.

### Argument

- The rule forbids a test from reading another package's SDK or implementation. The SDK tests its own formats and view bridge in core: `packages/plugin-api/test/view-page.test.mjs` (`checkViewPage`), `view.test.mjs` (`createViewBridge`), `binder.test.mjs` (`createBinder`), `view-imports.test.mjs` (`VIEW_IMPORTS`), `view-core-targets.test.mjs`, and `events-check.test.mjs` (census findings, `:26`, `:147`, `:161`).
- A test that imports `ui/` source resolves the SDK through that source. Rewriting the test-visible specifiers is the only way to keep SDK code out of a test run, and the rewrite is a build step, which the rule allows.
- A plugin-local fixture of the host contract tests the plugin at the consumer boundary and contains no SDK code.

### Evidence (sibling `../plugins/*`, branch `main`)

Test files that import or resolve `@soksak/*` (20): `appview/test/manifest.test.mjs`; `browser/test/{address-input,empty-state,manifest,page}.test.mjs` (`page.test.mjs:5` imports `INTERACTIVE`); `editor/test/{editor,manifest,view}.test.mjs` (`editor.test.mjs:6` imports `createBinder`; `:184` and `:198` name `@soksak/shared` specifiers); `editor/test/view-host.mjs`; `editor/test/shared-modules.mjs`; `editor/test/fixtures/upper-gutter.mjs:2` (imports `@soksak/shared/editor.extension/@codemirror/view.js`); `files/test/manifest.test.mjs`; `flowmark/ui/view.test.mjs`; `hwp/test/hwp.test.mjs`; `shell/test/{manifest,view}.test.mjs`; `terminal/test/{census,manifest,terminal}.test.mjs` (`terminal.test.mjs:4` imports `@soksak/plugin-api`).

Implementation modules loaded by tests that import the SDK (transitive): `terminal/ui/terminal.js:1-2` (`@soksak/plugin-api`, `@soksak/plugin-api/screen-hash`), loaded by `terminal/test/terminal.test.mjs:6`; `browser/ui/sections/tabs.js:3` and `history.js:3` (`drawList`), loaded by `browser/test/section-lists.test.mjs:22`; `files/ui/sections/tree-horizontal.js:2`, loaded by `files/test/section-lists.test.mjs:43`; `editor/ui/view.js:7-8` and `flowmark/ui/view.js:7`, loaded by `editor/test/view.test.mjs` and `flowmark/ui/view.test.mjs`.

Resolver hooks: `editor/test/shared-modules.mjs:4-18` (`registerHooks`, `POINT` `@soksak/shared/editor.extension/`), run by `editor/package.json:23` through `--import`. Helpers that resolve or read the SDK: `flowmark/ui/view-host.mjs` (`require.resolve("@soksak/plugin-api")`), `editor/test/view-host.mjs` (reads `view-start.js` from the installed SDK).

Makefile targets that run SDK tools inside `make test`: `editor/Makefile:16-20` and `terminal/Makefile:16-20` (`soksak-exposure`, `soksak-engines`, `soksak-events --census`); `flowmark/Makefile:10-14` (`soksak-engines`, `soksak-events`, `soksak-records`). `build-vendor --check` runs in `editor/package.json:22` and in `files/package.json` `scripts.test`.

Shipped files: `flowmark/package.json` `files` is `plugin.json`, `events.json`, `ui`; its test script is `node --test ui/`.

### Required changes

1. Build test tree: `build/test/` is written by the plugin build. It copies `ui/` and `test/fixtures/`, and rewrites every `@soksak/*` specifier to a plugin-local fixture module (for the SDK names the page uses) or to the vendored file named by `plugin.json` `extends.extension.modules`. Tests import `build/test/` by relative path. The fixtures implement the host call names and the SDK functions the page calls, with no SDK code.
2. Test rule: a test in each plugin's `test/` builds its needle from parts (for example `"@" + "soksak/"`), so it does not match its own source. It asserts that every file under `test/**` and every `ui/**/*.test.mjs` contains no `@soksak/` specifier. The only `ui/` code that tests import is the build output.
3. Resolver hooks: `editor/test/shared-modules.mjs` is deleted when the build tree of change 1 lands, and `editor/package.json:23` drops its `--import`. Until then the hook is a named exception with its own sub-item and owner (the editor repository). It is not kept silently.
4. `editor/test/editor.test.mjs:184` and `:198` and `editor/test/fixtures/upper-gutter.mjs:2` import the vendored file through the build tree. Each assertion keeps its meaning.
5. `editor/test/view-host.mjs` and `flowmark/ui/view-host.mjs` load `build/test/` or a fixture of the start values, and do not read the installed SDK. The build writes `test/fixtures/view-start-fixture.js`; `--check` compares the SDK `view-start.js` with the hash that the fixture records.
6. Flowmark moves its tests and helper from `ui/` to `test/`; its `test` script becomes `node --test test/`. `ui/` ships only its page files.
7. `terminal/test/census.test.mjs` is deleted (`:24` and `:29`). The census of plugin sources runs in `make check`. The probe case is covered by `packages/plugin-api/test/events-check.test.mjs` (`:26`, `:147`, `:161`).
8. `make test` runs `pnpm test` only. `make check` runs `soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records` and `build-vendor --check`. `make pack` and CI depend on `make check`. `scripts.test` in `editor/package.json:22-23` and `files/package.json` keeps only `node --test`.
9. `browser/test/page.test.mjs:5` replaces the `INTERACTIVE` import with a literal constant fixture. The binder contract stays tested in `packages/plugin-api/test/binder.test.mjs`.
10. Manifest and diagnostics validation runs in the plugin build with the SDK validators. Manifest tests read the built output and check its values as literals.
11. Spec: `docs/spec/plugins.md:40` changes from "`make test` runs the tests of a plugin repository" and "depends on `@soksak/plugin-api` for its tests" to: `make test` runs the plugin tests; `make check` runs the SDK tools; the plugin repository depends on `@soksak/plugin-api` as a build dependency. `docs/spec/plugins.md:171` ("a plugin repository test calls `checkViewPage`") changes to: the plugin build calls `checkViewPage`. Owner: core `main`, with `.ko.md` mirrors.

### Coverage

Each removed plugin assertion maps to a core test or a plugin fixture assertion. The table is written in the sub-item before any test is deleted: plugin file and test name, then core test file and name or the new fixture assertion. No assertion is dropped without a row.

### Out of scope

Fixture comment wording and exact fixture file names (chosen in the sub-item). The build-tree change of change 1 is its own sub-item, with the editor and flowmark repositories as owners.

---

## D3. Owner classification by declared name

### Decision

The name rule for `@soksak/plugin-*` and `@soksak/sidecar-*` moves to `scripts/check-boundaries.mjs`, which already reads the declared folders and already states in its header that core names no plugin or sidecar. `scripts/check-test-parity.mjs` keeps only its path-based owner roots and no longer classifies names.

1. Core names are the `name` of each `packages/*/package.json` and `packages/host/*/package.json` (`components()` in `check-boundaries.mjs`).
2. Any `@soksak/plugin-*` or `@soksak/sidecar-*` package name that appears in `packages/**` sources and is not a core name fails the check, declared or not. The declared set is not an exemption.
3. A reference is matched by its two-segment base (`@scope/name`) with exact equality; `@soksak/plugin-api-x` is not `@soksak/plugin-api`.
4. Other scopes are not owners and are not classified. Undeclared plain plugin ids are not detected. `docs/spec/plugins.md` (Repositories) will state this limit (change 5).
5. Core test fixtures use `@scope/`. Existing `@soksak/sidecar-vt` fixtures are renamed.
6. The `-example` clauses are removed. A name such as `@soksak/sidecar-example` is not an exemption; a fixture of that form under `packages/**` fails rule 2.

### Argument

- A prefix is not a contract. `docs/spec/plugins.md` gives GitHub repository names and no npm-name rule. A list in core is knowledge of plugins in core, which the boundary rule forbids.
- `check-boundaries.mjs` already reads the declared folders' `package.json` names and `plugin.json` ids (`origin/main:scripts/check-boundaries.mjs:27-40`), and its header states the rule. Adding the name rule there adds no new reading across repositories. Placing it in `check-test-parity.mjs` would add a new read there, so the name rule is not placed there.
- Rule 2 needs no declared set for an exemption. A declared name in core is rejected by the same rule as an undeclared one.
- `startsWith` would classify `@soksak/plugin-api-x` as a plugin; exact base matching does not.

### Evidence

- `origin/main:scripts/check-test-parity.mjs:4514-4522`: `packageOwner` with core literals `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench` (`:4516`), the plugin list `:4517-4519` with `base.endsWith("-example")` (`:4517`), and the sidecar list `:4520-4522` with `base.endsWith("-example")` (`:4520`). `fix/decouple-F236:scripts/check-test-parity.mjs:4482-4491` has the prefix branches at `:4484-4486`.
- `origin/main:scripts/check-boundaries.mjs:1-5` (header: core names no plugin or sidecar); `:27-40` (`components()` from `packages/`, `packages/host/` and the declared folders through `workspace-registry.mjs`).
- `origin/main:scripts/test/test-parity.test.mjs:195-204` asserts a "sidecar" error for `@soksak/sidecar-example` from name classification; `:215-218` asserts a "private" error for `@soksak/sidecar-example/src/private.js`. These name assertions move with the name rule.
- `origin/main:scripts/workspace-registry.json` declares plugins `browser, editor, files, hwp, terminal` and sidecars `files`, `vt-alacritty`.
- `origin/main:docs/spec/plugins.md:34` lists `browser, terminal, files` and `shell`; this disagrees with the registry and is corrected in change 5.
- Undeclared `@soksak/sidecar-vt` fixtures: `origin/main:packages/workbench/test/library-plugins.test.mjs:35` and `:98`; `origin/main:packages/workbench/test/plugin-operations.test.mjs:63`. The `@scope/sidecar-probe` fixtures already in core: `origin/main:packages/workbench/test/plugin-states.test.mjs:54,63,90`.

### Required changes

1. `scripts/check-boundaries.mjs`: export `components()` and a pure `checkNames(components, files)` function that implements rules 2 and 3. The top-level run stays. The check runs in the `make boundaries` lane, which already reads the declared sibling manifests.
2. `scripts/check-test-parity.mjs` (`main` `:4514-4522`; `fix/decouple-F236` `:4482-4491`): remove the name classification of `packageOwner` (the core literals, the plugin and sidecar lists, and the `-example` and prefix branches). Its path-based owner roots (`OWNER_ROOTS`) stay. The `main` change and the `fix/decouple-F236` change are separate commits.
3. Move the name assertions of `scripts/test/test-parity.test.mjs:195-218` to a `scripts/test/` test of `check-boundaries.mjs`, using an injected file set. The path-based assertions stay.
4. Rename the `@soksak/sidecar-vt` fixtures to `@scope/sidecar-vt` in `library-plugins.test.mjs:35,98` and `plugin-operations.test.mjs:63`. Those tests do not exercise the real sidecar.
5. `docs/spec/plugins.md:34` (Repositories) is rewritten to the registry list (declared plugins `browser, editor, files, hwp, terminal`; repositories that are not declared are named separately). The same section adds: core names no plugin or sidecar; undeclared plain plugin ids are not detected. Owner: core `main`, with `.ko.md`.
6. `scripts/test/` tests of `checkNames`: exact base match (`@soksak/plugin-api-x` is not an owner); an undeclared `@soksak/plugin-foo` in `packages/**` fails; a declared name such as `@soksak/sidecar-vt-alacritty` in `packages/**` fails; `@soksak/sidecar-example` fails; `@scope/sidecar-vt` passes; `@soksak/plugin-api` in core passes. Red on current code: `packageOwner` exempts `-example` names and classifies `@soksak/plugin-foo` by prefix.

### Out of scope

Lane and count rows of `check-test-parity.mjs` (the counts change through `make parity-check` in the change that edits it).

---

## Round record

### Round 1

Auditors: two fresh Haiku subagents. Objections and answers are recorded in the round-1 section of the committed record .

### Round 2

Auditors: two fresh Haiku subagents, each given the revised text. Both reported substantive objections. Each was verified against the files and answered:

- D1 transitive SDK resolution through `ui/` modules (auditor A, D1-A): accepted. Change 1 builds a test tree with rewritten specifiers; the test rule is change 2.
- D1 `make test` runs SDK tools (auditor A, D1-B): accepted. Change 8 splits `make test` and `make check`.
- D1 rule-test self-match (auditor A, D1-C; auditor B, O1): accepted. Change 2 builds the needle from parts and has no exclusion.
- D1 editor specifiers and shared-module hook (auditor B, O1-O2): accepted. The premise "npm `@codemirror/view`" was wrong for the current test, which resolves the vendored file through `plugin.json`. The build output path is named in change 1; the hook is an exception with an owner (change 3).
- D1 `ui/` build output does not exist (auditor B, O3): accepted; change 1 names the output path `build/test/`.
- D3 contradiction between rule 4 and test 4 (auditor B, O4): accepted; rule 2 applies to declared and undeclared names alike, and the declared set is no exemption.
- D3 new cross-repository read in `check-test-parity` (auditor B, O5): accepted; the name rule moves to `check-boundaries.mjs`, which already reads the declared folders.
- D3 spec sentence not yet present (auditor B, O6): accepted; the Decision says "will state" and change 5 adds it.
- D3 `-example` clauses and their assertions (auditor A, D3-A): verified at `origin/main:4517,4520` and `test-parity.test.mjs:195-218`; accepted in change 3 and rule 6.

Status: round 3 pending. Round 3 auditors receive this text.
