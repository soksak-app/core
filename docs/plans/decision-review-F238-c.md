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

A plugin repository's tests import and resolve no `@soksak/*` name (the SDK `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`, a shared kit, or a sidecar), and read no installed package path. A test of a plugin checks that plugin's own code, manifest and fixtures. Build and check scripts (not tests) may call the SDK validators, read `VIEW_IMPORTS`, and run the census; the build runs them and the test suite does not.

### Argument

- The rule forbids a test from reading another package's SDK or implementation. The SDK already tests its own formats and view bridge in core: `packages/plugin-api/test/view-page.test.mjs` (`checkViewPage`), `view.test.mjs` (`createViewBridge`), `binder.test.mjs` (`createBinder`), `view-imports.test.mjs` (`VIEW_IMPORTS`), `view-core-targets.test.mjs`, and `events-check.test.mjs` (census findings, including the `rs`, `go` and `m` cases at lines 147 and 161). A plugin test that repeats these checks tests the SDK inside the plugin repository.
- A plugin-local fixture written to the host contract names tests the plugin at the consumer boundary. It contains no SDK code.

### Evidence: plugin test files that import or resolve `@soksak/*` (sibling `../plugins/*`, branch `main`)

Test files (20): `appview/test/manifest.test.mjs`, `browser/test/{address-input,empty-state,manifest,page}.test.mjs` (`page.test.mjs:5` imports `INTERACTIVE`), `editor/test/{editor,manifest,view}.test.mjs`, `editor/test/view-host.mjs`, `editor/test/shared-modules.mjs`, `editor/test/fixtures/upper-gutter.mjs`, `files/test/manifest.test.mjs`, `flowmark/ui/view.test.mjs`, `hwp/test/hwp.test.mjs`, `shell/test/{manifest,view}.test.mjs`, `terminal/test/{census,manifest,terminal}.test.mjs`. Helpers that resolve a package path: `flowmark/ui/view-host.mjs` (`require.resolve("@soksak/plugin-api")`), `editor/test/view-host.mjs` (reads `view-start.js` from the installed SDK).

Build and check commands that the test targets run: `editor/package.json:22-23` (`scripts.test` runs `build-vendor --check` and `--import ./test/shared-modules.mjs`); `editor/Makefile:16-20` and `terminal/Makefile:16-20` (`test` runs `pnpm exec soksak-exposure`, `soksak-engines`, `soksak-events --census`); `flowmark/Makefile:10-14` (`test` runs `soksak-engines`, `soksak-events`, `soksak-records`); `files/package.json` `scripts.test` runs `build-vendor --check`.

Shipped files: `flowmark/package.json` `files` is `plugin.json`, `events.json`, `ui`. Its test script is `node --test ui/`, so the flowmark tests and their helper sit in a shipped folder.

`editor/ui/editor.js:5-12` and `ui/vendor/libraries.js` import `@soksak/shared/...`. Tests resolve those specifiers through the hook in `test/shared-modules.mjs`.

### Required changes

1. Literal fixtures replace SDK imports. The import map fixture lists the four entries of the view import map and their targets, as the spec states them. `docs/spec/plugins.md` (Page section, `origin/main:171`) gains the target list in the same change.
2. The view bridge and binder fakes are plugin-local fixture modules under the plugin's `test/fixtures/` folder. They implement only the call names of the host contract. They contain no SDK code and are not copies of SDK files.
3. The view-host helpers of `editor` and `flowmark` do not execute the SDK `view-start.js`. They load `test/fixtures/view-start-fixture.js`, a plugin-local fixture of the start values that the page consumes. The build copies the SDK file to `build/` only for `--check`, which compares the copy with the SDK file; no test executes it.
4. Flowmark moves its tests and helper from `ui/` to `test/`, and its `package.json` `test` script becomes `node --test test/`. `ui/` ships only its page files, which keeps test code out of the `files` list.
5. `terminal/test/census.test.mjs` is deleted (both of its tests, `:24` and `:29`). The census of the plugin sources runs in the `check` target (`soksak-events --census`). The probe case is covered by `packages/plugin-api/test/events-check.test.mjs` (`:26`, `:147`, `:161`).
6. `editor` and `terminal` `test` targets keep only `pnpm test`. The `soksak-exposure`, `soksak-engines`, `soksak-events` and `soksak-records` lines move to a `check` target, which the `make test` entry runs before `pnpm test`. The `build-vendor --check` step moves from `scripts.test` to `check`, and `files` does the same. Each plugin's `test` script runs only `node --test`.
7. `editor/test/editor.test.mjs` and `editor/test/view.test.mjs` run against the build output, not the source tree. The build resolves the `@soksak/shared` specifiers of `ui/` into a vendored tree that the tests import by relative path. Until that build change lands, the hook is a named exception with its own sub-item; it is not kept silently. The `shared-modules.mjs` file is deleted when the vendored tree lands.
8. `editor.test.mjs` takes `EditorView` from the vendored file (`ui/vendor/...`), not from npm `@codemirror/view`, so that facet and DOM lookups use one module instance. The assertions that check the vendored instance (`EditorView.darkTheme`, `findFromDOM`) keep their meaning.
9. `browser/test/page.test.mjs` replaces the `INTERACTIVE` import with a literal constant fixture. The binder contract stays tested in `packages/plugin-api/test/binder.test.mjs`.
10. Manifest and diagnostics validation (`validateManifest`, `validateDiagnostics`) runs in the plugin build with the SDK validators. Manifest tests read the built output and check its values as literals.
11. A rule test in each plugin's `test/` asserts that no file under `test/**`, and no `ui/**/*.test.mjs`, names an `@soksak/` specifier. The check scans those files only; `ui/` implementation files are not scanned.
12. Spec: `docs/spec/plugins.md:40` ("depends on `@soksak/plugin-api` for its tests") changes to: a plugin repository depends on `@soksak/plugin-api` only as a build dependency, used by its build to validate the manifest and write fixtures. `docs/spec/plugins.md:171` ("a plugin repository test calls `checkViewPage`") changes to: the plugin build calls `checkViewPage`. Owner: core `main`, with `.ko.md` mirrors.

### Coverage

Each removed plugin assertion maps to a core test or to a plugin fixture assertion. The mapping table is written in the sub-item before any test is deleted: plugin file and test name, then core test file and name or the new fixture assertion. No assertion is dropped without a row.

### Out of scope

Fixture comment wording; the exact fixture file names (chosen in the sub-item); the editor vendored-tree build change, which is its own sub-item with its owner (the editor repository).

---

## D3. Owner classification by declared name

### Decision

The owner audit (`packageOwner` in `scripts/check-test-parity.mjs`) does not classify by name prefix and holds no name list. Owners come from declarations:

1. Core names are the `name` of each `packages/*/package.json` and `packages/host/*/package.json` (the set `components()` in `scripts/check-boundaries.mjs` builds).
2. Plugin and sidecar names are the `name` of the `package.json` in each folder that `scripts/workspace-registry.json` declares (`plugins`, `sidecars`), read through `scripts/workspace-registry.mjs` as `check-boundaries.mjs` does. A declared folder without a `package.json` fails.
3. A reference is an owner match only by exact equality of its two-segment base (`@scope/name`); `@soksak/plugin-api-x` is not `@soksak/plugin-api`.
4. A package name of the form `@soksak/plugin-*` or `@soksak/sidecar-*` that appears in `packages/**` sources, and that is neither a core name nor a declared name, fails the audit. Other scopes are not owners and are not classified. Undeclared plain plugin ids are not detected; `docs/spec/plugins.md` (Repositories) states this limit.
5. Fixtures under `packages/**` use the `@scope/` form. Existing `@soksak/sidecar-vt` fixtures are renamed in the same change (see the required changes).

### Argument

- A prefix is not a contract. `docs/spec/plugins.md` gives GitHub repository names and no npm-name rule. A prefix in core is knowledge of plugins in core, which the boundary rule forbids.
- The declared set already exists and `check-boundaries.mjs` already reads it (`origin/main:scripts/check-boundaries.mjs:27-40`). Reusing it adds no new reading across repositories.
- A `startsWith` prefix test classifies `@soksak/plugin-api-x` as a plugin; exact matching does not.

### Evidence

- `origin/main:scripts/check-test-parity.mjs:4514-4522`: `packageOwner` with the literals `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench` (`:4516`), a list of plugin names `@soksak/plugin-browser`, `@soksak/plugin-files`, `@soksak/plugin-shell`, `@soksak/plugin-terminal` (`:4517-4519`), and a list of sidecar names `@soksak/sidecar-files`, `@soksak/sidecar-shell`, `@soksak/sidecar-vt-alacritty`, `@soksak/sidecar-vt-core` (`:4520-4522`). The same literals with prefix tests are on `fix/decouple-F236:scripts/check-test-parity.mjs:4482-4491` (`:4484-4486`).
- `origin/main:scripts/check-boundaries.mjs:27-40` builds components from `packages/`, `packages/host/` and the declared folders through `workspace-registry.mjs`.
- `origin/main:scripts/workspace-registry.json` declares plugins `browser, editor, files, hwp, terminal` and sidecars `files` and `vt-alacritty`.
- `origin/main:docs/spec/plugins.md:34` lists the plugins as `browser, terminal, files` and `shell`. That list disagrees with the registry and is corrected by the required changes.
- Existing `@soksak/sidecar-vt` fixtures, which are not declared and fail rule 4: `origin/main:packages/workbench/test/library-plugins.test.mjs:35` (`name: "@soksak/sidecar-vt"`), `:98` (`"사이드카 @soksak/sidecar-vt 0.1.2"`), and `origin/main:packages/workbench/test/plugin-operations.test.mjs:63` (`const vt = "@soksak/sidecar-vt"`).
- The `@scope/sidecar-probe` fixtures already in core are at `origin/main:packages/workbench/test/plugin-states.test.mjs:54,63,90`.

### Required changes

1. `scripts/check-test-parity.mjs`: remove the three core literals, the plugin-name list and the sidecar-name list, and the prefix branches (on `main` `:4514-4522`; on `fix/decouple-F236` `:4484-4486`). `packageOwner` looks up the name in two sets built from the core packages and the declared folders (through `workspace-registry.mjs`). A declared folder without `package.json` fails with an explicit message. The `main` change and the `fix/decouple-F236` change are separate commits; the branch change applies on top of the `main` change.
2. Rule 4 is implemented in the same function: an undeclared `@soksak/plugin-*` or `@soksak/sidecar-*` name fails with the file, line and name.
3. Rename the three fixtures `@soksak/sidecar-vt` to `@scope/sidecar-vt` in `library-plugins.test.mjs` (`:35`, `:98`) and `plugin-operations.test.mjs` (`:63`). The test does not exercise the real sidecar, so the declared name `@soksak/sidecar-vt-alacritty` is not used.
4. A test in `scripts/test/` covers: exact match (`@soksak/plugin-api-x` is not an owner); an undeclared `@soksak/plugin-foo` in `packages/**` fails; a declared plugin name in core implementation fails; the renamed `@scope/sidecar-vt` fixtures pass; a declared folder without `package.json` fails. The test is Red on the current code: the prefix branch classifies `@soksak/plugin-foo` as an owner with no declaration check.
5. `docs/spec/plugins.md:34` (Repositories) is rewritten to the registry's list (`browser, editor, files, hwp, terminal` as declared plugins, with the repositories that are not declared named separately), and the sentence is added: core names no plugin or sidecar; owners are the declared folders; undeclared plain plugin ids are not detected. Owner: core `main`, with `.ko.md`.

### Out of scope

Lane and count rows of `check-test-parity.mjs` (the counts change through `make parity-check`, in the change that makes the edit).

---

## Round record

### Round 1

Auditors: two fresh Haiku subagents, each given both decisions and the evidence. Both reported substantive objections. Each objection was checked against the files; the answers:

- D1 view-start copy executes SDK code (auditor 2, D1-A): accepted. Required change 3 now loads a plugin-local fixture; the copy is only compared by `--check`.
- D1 flowmark tests under the shipped `ui/` folder (auditor 1 D1-1; auditor 2 "flowmark has no `test/`"): accepted, and the flowmark move is required change 4. The auditor's claim that flowmark has no `test/` is correct as a statement of the current tree; the change creates it.
- D1 editor shared-module hook and npm `@codemirror/view` instance (auditor 2 D1-B): accepted. The hook is named as an exception with a sub-item; the test imports the vendored file (required changes 7 and 8).
- D1 `check` targets still run SDK validators (auditor 2 D1-C): accepted; required change 6 lists the lines (`editor/Makefile:16-20`, `terminal/Makefile:16-20`, `flowmark/Makefile:10-14`).
- D1 census second test and `INTERACTIVE` import (auditor 2 D1-D): accepted; required changes 5 and 9.
- D1 coverage table missing (auditor 1 D1-2): accepted; the Coverage section requires the table before deletion.
- D3 fixture citation wrong, `@scope/sidecar-probe` is not at `library-plugins.test.mjs:98` (auditor 1 D3-1, auditor 2 D3-A): accepted; the citation is corrected and the three real `@soksak/sidecar-vt` fixtures are renamed (required change 3).
- D3 `main` lists were stated conditionally (auditor 2 D3-B): verified present at `origin/main:4514-4522`; stated as present.
- D3 spec line lists `shell` against the registry (auditor 2 D3-C): accepted; required change 5.

Status: round 2 pending. Round 2 auditors receive this revised text.
