# Development

[한국어](AGENTS.ko.md)

This workspace contains the headless layout library `soksak`, the workbench frontend, plugins, and applications. The [plugin specification](docs/spec/plugins.md) defines the directory roles and their interfaces.

## Implementation

- Choose the simplest implementation that satisfies the current contract. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Keep responsibilities separate. Add native platform code only when the required behavior cannot be implemented through existing APIs.
- Maintain the [private native API inventory](docs/operations/private-native-apis.md) with each API or call-condition change. Read it first when diagnosing failures after native source, framework, SDK, or OS updates; review each correction's necessity and actual API semantics.
- Remove harmful or unnecessary changes. Preserve correct unrelated changes separately and describe their actual purpose in the commit.
- Verify behavior before rewriting commits. Do not merge or push without authorization.

## Structure

- Core (`packages/`), plugins (`plugins/`), and sidecars (`sidecars/`) do not name each other in code or tests. Only declaration files connect them: `environment.json` lists plugins, `plugin.json` lists sidecar packages, and `sidecar.json` describes a sidecar. `make boundaries` checks this rule.
- Common functionality belongs to core so plugins do not reimplement it. Plugin functionality does not move into core. A sidecar holds native functionality for one domain.
- Platform-specific files live only under `platform/<os>/` (`darwin`, `windows`, `linux`) in the owning package. Do not add stub files for other platforms.
- Native code packages (Go, Rust, Objective-C) keep code in `src/`, tests in `tests/`, and manifests and build files at the root. Go and Rust files that serve the same role have the same name; test files end in `_test` in both languages. The [native host specification](docs/spec/hosts.md) lists the allowed differences.
- Private framework declarations live in the platform directory under `private/` (for macOS `native/darwin/src/private/`). Sources and tests include those headers instead of declaring private APIs themselves. Each private API is listed in `docs/operations/private-native-apis.md`, and it is used only for its intended purpose; do not fake framework state to work around a missing interface.
- A platform either implements an operation of the host platform interface or returns a `not implemented on <os>` error from `platform/<os>/unsupported.*`; a host that cannot provide a required operation fails at startup instead of running partially. `make platforms` and `make hosts-check` check the layout.
- Recordings made by checks are removed when the check ends.
- Every user operation of a document runs a declared command: controls point to it with `data-command`, and handlers run it through the registry instead of calling module functions. Continuous gestures have a command for their result, and shortcuts run commands. Commands are declared first, and elements are connected only to declared commands through the shared binder (`createBinder` in `@soksak/plugin-api`). Every visible state has a status, and every interactive element has a command binding and a dom name. Coverage is judged at runtime by the binder audit (`core.page.audit`, `unbound` in `core.surface.document`, `e2e/audit.test.mjs`), not by source patterns; `make exposure-check` checks only that names in sources are declared and declarations are registered. The [exposure specification](docs/spec/exposure.md) defines the rules.
- A surface shows a page of its plugin package. A page shows web documents only in document regions attached to its own elements ([native surfaces](docs/spec/native-surfaces.md#document-regions)); a web address is never a surface.
- Diagnostic code (host diagnostic methods, recording, and the page diagnostic module) exists only in diagnostic builds. Release staging omits the page diagnostic module.
- A command whose reply takes longer than 10 seconds declares `timeout` (milliseconds, at most 600000); the host relay uses it.

## Documentation

- Read the applicable specification before changing behavior. Update it first when the contract changes and mark incomplete implementation in [features](docs/features.md).
- Keep one canonical document per topic. `docs/spec/` defines contracts; `docs/features.md` separates implementation, validation, and release; `docs/operations/` contains current procedures; `CHANGELOG.md` records actual changes and validation.
- Keep README files limited to an introduction, minimum startup steps, and document links. Use `docs/plans/` only for pending proposals; remove a proposal after incorporating its approved content into the specification.
- Write documents in English. Update the matching `.ko.md` translation in the same change with the same information.
- Describe current behavior and actual reasons. Personal preferences and conversation context belong in memory outside Git.
- Use direct action names and explicit subjects and objects. State a cause in one sentence. Do not use metaphors, personification, or colloquial wording in comments, documents, logs, or commits.
- Comments in `packages/soksak` use English. Comments in other directories use Korean. Identifiers, logs, errors, and test names use English.
- Commit messages have no trailers, generated-by text, or session links.

## Verification

- Run `make docs-check` for every change and review the documents against the code; structural checks do not verify meaning.
- Run `pnpm test`, `make boundaries`, and `make exposure-check` for every code change; each package runs its own tests. Run `make native-test` for native code changes. Run `make verify` for library changes. Commit generated `dist/` changes together with their source; the final check requires no difference between source output and committed files.
- For native or example behavior, follow [example verification](docs/operations/examples.md). Build both hosts, then run the affected checks against those binaries.
- Window tests connect through `<config-dir>/endpoint.json` to applications already running with `--config-dir PATH`. They use only declared exposure entries and native input, wait on status notifications instead of timers (`make e2e-check`), a disposable configuration directory, and project folders. They must not launch applications or independently activate windows. Project-window checks may invoke the application’s project-open command, which creates or focuses windows as specified.
- A recording must include the full gesture at the requested rate. Missing frames or incomplete input is a failure, not a passing measurement.
- Verify input-method (IME) behavior only through activation-tier checks run with the user's approval (`make -C native/darwin test-activation`, `pnpm -F @soksak/e2e verify:activation`); the OS input method serves only the key window of the active application. Each run sends the same keys to an AppKit text-view control in the same window, and a result is evidence only when the control produces the expected document.
- Every declared workspace version is the current release version, 0.0.1; `scripts/check-versions.mjs` enforces it in `pnpm test`.
- Record the tested implementation and platform. Do not use an earlier result to validate later code or describe a test pass as a release.
- Reproduce and accept an intermittent failure through a tracked repeat target (for native tests, `make -C native/darwin repeat TEST=<name>_test COUNT=<n>` for one test and `make -C native/darwin repeat-suite COUNT=<n>` for the default suite; for Rust packages, `make rust-repeat PACKAGE=<package> COUNT=<n> [TEST=<name>]` repeats the tests and `make rust-tests-alone PACKAGE=<package>` runs each test alone to find a dependence on test order). A failing check reports the measured state needed to locate its cause. Commands typed in a shell session, temporary scripts, and temporary folders are not reproduction or acceptance evidence; a needed check becomes a tracked test or target.
