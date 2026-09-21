# Verification contracts

[한국어](verification.ko.md)

## Coverage and evidence

The canonical work status is [features](../features.md). A source-file inventory is structural evidence only. It must not report feature parity or application correctness.

Documentation checks require unique task identifiers, only waiting/in-progress/complete states, and identical checklist identifiers, ordering, indentation, and states in both translations. The text may be translated; the task state must not differ.

Additional work must receive a priority and acceptance criteria in that same checklist before implementation. A completed task retains its status and the scope of its evidence. A subsequent issue uses a linked identifier with a numeric suffix, such as `G1.1-1`, instead of reopening the completed task or starting another checklist.

Discover workspace packages, build manifests, implementation languages, public commands, statuses, settings, and host operations. Every supported feature maps to explicit implementation entry points, behavior test identifiers, expected outcomes, and required verification levels. JS/TS, Rust, Go, and Objective-C have the same evidence obligations. A shared native test does not replace integration through each host. Host comparisons use the same expected outcomes; identical incorrect results fail.

Missing implementations, missing tests, unregistered build targets, unresolved references, excluded required tests, zero tests, mandatory skips, stale evidence, crashes, and timeouts fail the applicable gate. Audit self-tests must demonstrate those failures. Behavioral mutation checks replace an implementation with a no-op or remove a required effect or response and require the corresponding test to fail. File names and source patterns do not establish behavior.

Evidence identifies the feature and test, verification level, language, host and platform, source and test content hashes including uncommitted content, build options, executable and sidecar hashes, expected and actual outcomes, and elapsed time. A changed dependency invalidates previous evidence. Structural coverage, behavior validation, and release approval are separate results.

## Bounded execution

Each independently executed case has its own timeout: 10 seconds for pure unit behavior, 30 seconds for native-process behavior, and 60 seconds for application behavior by default. A longer case must declare its limit and concrete reason. Build time is reported separately and is not a test result. A whole-suite timeout does not replace per-case limits.

The runner emits a start event, progress at least every five seconds while running, and a terminal pass, fail, timeout, or cancellation event. Every event identifies its case and elapsed milliseconds. Child stdout and stderr remain visible. A command exiting successfully is command evidence only, not proof that tests ran or that assertions passed. Language adapters must separately validate discovered test identities and outcomes. Empty or skipped execution cannot validate a required test. Retrying retains the initial failure.

The command supervisor takes an explicit identifier, executable/arguments, working directory, and positive timeout. It does not use a shell, silently substitute a missing executable, or convert nonzero exits to success. On timeout or cancellation it terminates only its own command process group and waits for cleanup; descendants cannot outlive a successfully completed supervised command. It must not terminate an independently running inspection application or persistent user session.

## Application acceptance

During stabilization, each change runs its local tests plus terminal, shell, browser, and modal basic behavior tests on the tested build. Verify declared input, resulting state, actual output, isolation, and cleanup, not only dispatch success. Window tests attach to disposable running instances and preserve reported failed windows. They do not start applications or compensate for incorrect state to obtain a pass.

Native geometry and pixel checks include complete gestures at the requested capture rate. Reaching a recording cap is a normal result with actual frame count and `limited: true`; it cannot validate a gesture whose end was not recorded. Remove recordings after checks. Repeat acceptance from two independent initial states and repeat create/use/close/recreate in the same instance. Run the complete required suite after all implementation changes, without weakening assertions or substituting old-build results.
