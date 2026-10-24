# Verification contracts

[한국어](verification.ko.md)

## Coverage and evidence

View display acceptance enumerates installed enabled view plugins and identifies the actual opened tab. Each plugin requires an explicit content case that checks its declared readiness and expected captured pixels. A missing case fails with the plugin and tab identifiers. Colour variation alone does not prove plugin content; rejecting a missing case removes a false pass without lowering the acceptance criterion.

The canonical work status is [features](../features.md). A source-file inventory is structural evidence only. It must not report feature parity or application correctness.

Documentation checks require unique task identifiers and only waiting (`[ ]`), in-progress (`[~]`), complete (`[o]`), or temporarily bypassed (`[!]`) states. A `[!]` item records a nonempty cause and retry condition in both translations. Checklist identifiers, ordering, indentation, and states must match across translations. The text may be translated; the task state must not differ. The changelog and its translation must have the same sections, the same number of entries in each section, and, at each position, the same task identifiers and code spans.

Additional work must receive a priority and acceptance criteria in that same checklist before implementation. A completed task retains its status and the scope of its evidence. A subsequent issue uses a linked identifier with a numeric suffix instead of reopening the completed task or starting another checklist.

Discover workspace packages, build manifests, implementation languages, public commands, statuses, settings, and host operations. Every supported feature maps to explicit implementation entry points, behavior test identifiers, expected outcomes, and required verification levels. Derive executable implementation languages from the repository inventory, and make `make parity-check` fail when the language adapter manifest omits an executable implementation language or declares a language with no implementation. Each language adapter executes named tests and reports actual counts, failures, skips, cancellations, todos, crashes, and timeouts through the same result contract. JS/TS, Rust, Go, Objective-C, and shell currently have the same evidence obligations. A shared native test does not replace integration through each host. Host comparisons use the same expected outcomes; identical incorrect results fail. The Wails and Tauri host tests declare the [host contract cases](host-contract.md) they execute, and `make host-contract-check` runs both hosts' tests and fails when a host has no passing test for a case in its scope. `make native-test` runs this check, so a host change that leaves a case without a passing test in either host fails the native gate.

Missing implementations, missing tests, unregistered build targets, unresolved references, excluded required tests, zero tests, mandatory skips, stale evidence, crashes, and timeouts fail the applicable gate. Audit self-tests must demonstrate those failures. Behavioral mutation checks replace an implementation with a no-op or remove a required effect or response and require the corresponding test to fail. File names and source patterns do not establish behavior.


Evidence identifies the feature and test, verification level, language, host and platform, source and test content hashes including uncommitted content, build options, executable and sidecar hashes, expected and actual outcomes, and elapsed time. A changed dependency invalidates previous evidence. Structural coverage, behavior validation, and release approval are separate results.

The language evidence recorder (`scripts/test-evidence.mjs`) stores those fields in schema version 1. `make language-test` emits one record for each declared executable-language case. Passing `--evidence-file PATH` persists the records; a later run appends a numbered attempt only when the immutable source, test, dependency, dirty-worktree, build-flag, and process snapshot is identical. It retains the first failure and rejects stale or malformed records. A required running host or sidecar must be supplied by PID and executable path and is hashed while it is alive; an empty process list is explicit evidence that the case owns no running process.

## Bounded execution

The E2E runner requires nonempty `SOKSAK_RUN_ID` and `SOKSAK_RUN_FOLDER` values together before it probes the frontmost application or starts a test child. Missing or partial metadata fails at the runner boundary. The runner passes the supplied values to the child unchanged; it does not synthesize an identifier or folder. This keeps every window-check child attributable to its run and audit output.

Each independently executed case has its own timeout: 10 seconds for pure unit behavior, 30 seconds for native-process behavior, and 60 seconds for application behavior by default. A longer case must declare its limit and concrete reason. Build time is reported separately and is not a test result. A whole-suite timeout does not replace per-case limits.

The runner emits a start event, progress at least every five seconds while running, and a terminal pass, fail, timeout, or cancellation event. Every event identifies its case and elapsed milliseconds. Child stdout and stderr remain visible. A command exiting successfully is command evidence only, not proof that tests ran or that assertions passed. Language adapters must separately validate discovered test identities and outcomes. Empty or skipped execution cannot validate a required test. Retrying retains the initial failure.

The command supervisor takes an explicit identifier, executable/arguments, working directory, and positive timeout. It does not use a shell, silently substitute a missing executable, or convert nonzero exits to success. On timeout or cancellation it terminates only its own command process group and waits for cleanup; descendants cannot outlive a successfully completed supervised command. It must not terminate an independently running inspection application or persistent user session.

## Application acceptance

A multi-host window-check session captures one frontmost application identity before starting its test workers. The session runner passes the same validated `{pid, name, bundle}` context to global setup and every test worker through `SOKSAK_WINDOW_CHECK_BASELINE`; a worker or host invocation does not capture a replacement baseline. Global setup rejects a missing or malformed context, a context whose process is no longer the same application, and a baseline PID that belongs to a tested host. Separate host invocations in one session receive and validate the same context. After every check, the harness restores this baseline when the checked host is frontmost. It reports another tested host that remains frontmost. If an unrelated application is frontmost, the harness leaves it undisturbed and rejects the check result because the shared baseline was not restored.

An acceptance condition without observation at its required verification level remains unresolved. Unit passes, successful command replies, and inferred behavior do not establish application acceptance.

During stabilization, each change runs its local tests plus terminal, shell, browser, and modal basic behavior tests on the tested build. Verify declared input, resulting state, actual output, isolation, and cleanup, not only dispatch success. Window tests attach to disposable running instances and preserve reported failed windows. They do not start applications or compensate for incorrect state to obtain a pass.

Input-method behavior is verified only by activation-tier checks run with the user's approval, because the OS input method serves only the key window of the active application. Each such run also sends the same keys to an AppKit text view in the same window; the result counts as evidence only when that control produces the expected document.

Native geometry and pixel checks include complete gestures at the requested capture rate. Reaching a recording cap is a normal result with actual frame count and `limited: true`; it cannot validate a gesture whose end was not recorded. Remove recordings after checks. Repeat acceptance from two independent initial states and repeat create/use/close/recreate in the same instance. Run the complete required suite after all implementation changes, without weakening assertions or substituting old-build results.
