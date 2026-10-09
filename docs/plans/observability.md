# Observability plan

[한국어](observability.ko.md)

Status: pending proposal, revised after an adversarial review. The canonical task checklist is [features](../features.md) (F149, F150, F151). This proposal describes the work before it starts; the contract that the work produces belongs in the specification, and this proposal is removed after the specification holds it.

## Why the structure is rebuilt

- Records have two formats: the text record of `application.log` ([diagnostics](../spec/diagnostics.md#forms)) and the JSON lines of `performance.ndjson` ([performance trace](../spec/performance-trace.md)). Writers exist once per language and per purpose: the native library (`sp_log_*`), the Go host, the Rust host, the page (`performance.js`), and the terminal sidecar (`performance.rs`, `service_log.rs`). The Go sidecars (files, shell) write no structured record; the host wraps their standard error lines. Parsers are separate too (`readErrors` of the window check and the parsers of individual checks).
- The cost is in the structure. The page trace makes one host call per event and serializes the calls in a promise chain. The native library writes each record with `write(2)` on the calling thread, which includes the UI thread. A screen event carries the whole cell array (one Enter produced about 40 records). Nothing classifies event volume.
- Omissions are structural. Each place that must record an event depends on someone remembering to write the record. An audit of the native library, both hosts, the page, the plugins and the sidecars lists hundreds of event sources without a record: 17 native source files with none, 68 of 69 Rust page commands, about 88 silent task or connection ends in the terminal sidecar, every operation of the Go sidecars. Nothing stops a new source from entering without a record.
- Records written before the log opens go to the terminal; the Go host has no recovery for a runtime fatal error; no identifier follows one input from the native callback to the PTY write, so a change of the typed text between two layers cannot be located.
- F145.6 made the failure handler of `orderedSidecar` mandatory without changing its caller in `packages/workbench/host.js`. After one failed send, every later send of the same sidecar name on the main page is rejected. The change is not part of a release.

## Principles

1. **One event contract.** Every record of every layer is one event of one structure. The text record format and the trace format are merged and removed. Text that a person reads is a view, not a stored format.
2. **A producer never blocks.** The UI thread, the input path and the frame path do no disk access, no IPC, no lock wait and no call from a foreign thread into another runtime to record. A disabled event costs one branch; an enabled event costs one copy into a bounded queue.
3. **Loss is counted and stated.** No queue, rate limit, rotation or truncation drops silently. The number and bytes of dropped events are recorded as `log.dropped` events, and every bound is documented in the contract.
4. **Nothing the layer saw is cut in the input path.** Records of the `input` class and the PTY writes and reads of the `io` class hold every value and every byte, as [diagnostics](../spec/diagnostics.md#rules) already requires. Events are variable-length.
5. **Events are declared.** Every event is declared in a catalog with its name, layer, class, default level and required fields. The repository that emits an event owns its catalog. Development and CI reject an undeclared event; at run time an undeclared event is still written, marked `undeclared` and counted, so evidence is never dropped by a naming error.
6. **Choke points record automatically.** Events of one kind are recorded at one entrance: page-to-host calls, window and application events, registry commands, sidecar lifecycle, the display of errors. A call site does not write its own record.
7. **The structure is complete before it is closed.** A threshold is never lowered, a feature is never switched off, and a layer is never left out to meet a goal. A part that a standard design cannot provide is stated under *Limits*.
8. **No backward compatibility in the end state.** When a layer moves to the new contract, its old writer, file format and parser are removed in the same series. A reader that meets another schema rejects the file with an error that names the file and the value it found. Transitional adapters that keep an old call signature while the backend changes are named as such and are removed before the work closes.

## Design

### Event model (`docs/spec/logging.md` holds the contract)

```
{"ts_us":1791..., "mono_ns":..., "seq":812, "level":"info", "layer":"native", "event":"native.input.key_down",
 "window":"w1", "surface":"tab-x", "session":"...", "cids":["b3.1042"], "fields":{...}}
```

- `ts_us` is the wall clock in microseconds. `mono_ns` is the system-wide monotonic clock (`mach_absolute_time` on macOS, `CLOCK_MONOTONIC` on Linux), which is comparable across processes of one boot and does not step; the page has only `ts_us`. `seq` is assigned by the writer when it serializes, so stored events of one process have contiguous `seq` without a shared counter on the producers; drops are recorded separately as `log.dropped` with the range they cover. The identity of the process (`pid`, `role`, `boot`) is written once in the first line `log.open`, which also holds the schema number.
- `level` is `error`, `warn`, `info`, `debug` or `trace`. `layer` is `native`, `host`, `page`, `plugin` or `sidecar`.
- A name is `<layer>.<subsystem>.<event>` (`native.input.key_down`, `host.endpoint.close`, `page.terminal.send`, `sidecar.vt.pty_write`). The catalog defines the names.
- `cids` is the list of correlation identifiers. One native input callback (a key event, a paste, a drop, a pointer report) gets one identifier `<boot>.<n>` from the layer that first sees it; callbacks that it triggers (`setMarkedText`, `insertText`, `commitThrough`) inherit it. A send that coalesces several inputs carries all their identifiers. The identifier travels with the native report, the host relay and the page event, is passed by the plugin with the send, and is carried by the host in the request envelope to the sidecar, so the plugin body stays the plugin's own.
- Files: `logs/<role>-<boot>.jsonl`, one per process run; the host process also holds the native, page and plugin events. Each writer rotates its own file (100 MB, 5 earlier generations) and never another process's file. Raw standard error of a process goes to `logs/<role>-<boot>.stderr`, and the crash output of a runtime fatal error to `logs/<role>-<boot>.crash`; both are raw files, listed by the viewer, and are not events. Files are created with mode 0600 in a folder with mode 0700 and opened close-on-exec.

### Classes and policy

| class | examples | rate | default policy |
| --- | --- | --- | --- |
| `lifecycle` | window, application, sidecar and session lifetime; settings, project, plugin and update changes | low | always stored |
| `input` | keys, input method callbacks, paste, clicks | human speed | always stored, complete: typed text, ranges, flags, state before and after |
| `call` | page-to-host calls, registry commands, endpoint methods (name, arguments, result, microseconds) | medium | stored; an argument over the declared size limit is stored up to the limit and marked `truncated`; the catalog marks arguments to redact (tokens, document bodies) and stores their size and hash |
| `io` | sidecar messages, PTY reads and writes | medium to high | stored complete; the bound is the rotation of the file, which is documented as the only shedding and recorded when it happens |
| `frame` | image frames, screens, pointer moves, wheel, layout | high | aggregated: one summary event per declared interval (count, extremes, last value, total microseconds); full detail is stored while the category is switched on |

- The policy is a file `<config-dir>/log-policy.json` written by the host from the setting `diagnostics.log`. Every process watches the file with a file system event and reloads on change; no sidecar protocol operation is added. The setting replaces `diagnostics.performance`; S1 verifies and specifies how the settings loader treats the old key.
- A large value such as a screen body is not written into an event; a size and a hash are. The body is available when the `frame` category is switched on.

### Writers

- Producer: check the policy (one branch), build the event as an owned message, and push it with a non-blocking push to a queue bounded by count and bytes; a full queue increments a loss counter that the writer turns into `log.dropped`. Fields that are costly to build are passed as a closure or guarded by `enabled(name)`. A dedicated writer thread assigns `seq`, serializes JSON, writes batches (100 ms, 64 KB or an `error` at once) and rotates. An `error` wakes the writer and returns; the producer never waits for the disk.
- Failure of the writer: a write error (disk full, input/output error) is counted, shown in a status and a `log.dropped` event when writing works again; a dead writer thread is detected by a heartbeat and ends the process with a fatal report. Every exit path calls `Flush(deadline)` before the process ends: Go shutdown, Rust exit, `panic = abort`, `os.Exit`.
- Libraries are small and per repository: the Go host and the Rust host in core, the terminal sidecar, and the two Go sidecars in their own repositories. Core holds the contract: the specification, the schema, golden JSON lines and the checker `soksak-log-check`. Each repository tests its library against the golden lines (core's fixtures are consumed as a test-only dependency, as plugins consume `@soksak/plugin-api` today). No runtime code is shared across repositories, and no sidecar depends on a core tag at run time. Libraries follow the platform layout (`src/`, `src/platform/<os>/`, `tests/`) and have declared test lanes in the parity inventory.
- Native: the library owns a bounded lock-free ring in C. `sp_event` copies the event into it from any thread; the host writer thread drains it with a pull call `sp_event_drain`. No producer thread calls into Go or Rust. Events before the host writer exists wait in the ring, so records of the start are not lost; a native test without a host drains the ring itself.
- Page: `context.log.<level>(event, fields)` collects events and sends them with one `logBatch(events)` call; the flush runs on a 100 ms timer, on a size bound, and on `pagehide` and `visibilitychange`, and the producer never awaits the reply. `console.*`, global `error` and `unhandledrejection` enter the same entrance. Surface and modal documents use the same `page.log`.
- Fatal: a signal handler writes a short line to a file descriptor that was opened at start, using only async-signal-safe calls. Go cannot intercept a runtime fatal error; `debug.SetCrashOutput` sends its output to the `.crash` file, and `recover` at goroutine entries writes an `error` event. Rust uses a panic hook that writes an `error` event and flushes.

### Catalog and coverage

- Each repository declares its events in `events.json` (name, layer, class, level, required field names and types, redacted arguments, description) and checks its own sources, as every repository already checks its own sources. Core owns the schema and the events of the layers `native` and `host` and the page. A plugin or sidecar declares its catalog in its manifest (`events`), and the viewer reads the catalogs of the installed manifests; core does not name them.
- Chains: the catalog declares which hops one input kind must leave (`native.input.key_down`, host relay, `page.terminal.send`, `sidecar.vt.pty_write`), so a missing hop is a failure and not only a shorter list.
- Automatic entrances replace hundreds of call sites: one wrapper for the page calls of the Go `Host`, one invoke interceptor for the Rust host, one registration helper for window and application events, `timed` of `exposure.js` for registry commands, launch and exit for sidecar lifetime, and the single display path of errors that a person sees, which emits the `error` event.
- Coverage is judged at run time, as the exposure rules require for commands and statuses: window checks drive each declared source through declared commands and native input and assert that the declared events appear. A lint over sources (`NSNotificationCenter addObserver`, `observeValueForKeyPath`, delegates, timers, `makeFirstResponder`, `TISSelectInputSource`, task ends) lists sources without a declared event or reason comment; it is a lint, not proof.

## Steps

Each step ends with a failing test recorded before the change and passing after it, the specification in English and Korean, the changelog, the parity inventory, the full gate, an observation in running applications, and a commit. Each commit leaves the tree green. Every unit of work gets its own checklist ID; completed items are not reopened.

- **R0 Finish open units.** Fix the regression of F145.6 (failing test: a second send after a failed send on the main page is delivered; `orderedSidecar` rejects a missing failure handler at the boundary and `host.js` reports the failure). Finish F145.12 (endpoint timeout record), the native input state fields (`responder`, `keyWindow`, `active`) and the input path check as their own units. Register the new IDs.
- **R1 Contract (documents only).** `logging.md`: principles, event model, classes and policy, files, clocks, correlation identifiers and their scope, loss accounting, permissions, privacy (typed text stays in `logs/` of this computer and leaves only when a person hands it over, with a warning at the save action), redaction, crash path, per-language budgets. Amend [diagnostics](../spec/diagnostics.md) and [performance trace](../spec/performance-trace.md) where the contract changes them. Schema, golden fixtures, `soksak-log-check`, terms (`event`, `class`, `cid`), and the changes of the rules in AGENTS.md. Verify and specify the treatment of the old setting key.
- **R2 Prototype and measurement.** The C ring with its pull call, the Rust and Go writers, and the page batch relay, with contract tests and dedicated benchmarks measured on the real hosts across cgo and FFI: disabled cost, enabled enqueue cost per host and language, writer throughput, loss counting with a full queue, startup buffering, and the input latency from key injection to the PTY write with logging on and off. The budgets (a disabled event costs one branch; an enabled enqueue is a short copy; a producer never blocks) are targets that the benchmarks record; a missed target changes the design, not the target.
- **R3 Host backend.** Swap the backend of the existing record calls (`LogError`, `LogInfo`, `log_error`, `log_info`, `sp_log_*`, `report`, `log`) to the new writer while their signatures stay, in the same commit as the window-check parser and the tests that assert exact lines; remove the old writers and formats. The signature adapters are transitional and are removed in R5 when the call sites move to declared events. Startup buffering, standard error and crash files.
- **R4 Page.** Replace the per-event promise chain of `performance.js` with the batch relay; capture `console.*` and global errors.
- **R5 Entrances and call sites.** One commit per entrance (page-to-host calls, registry commands, window and application events, sidecar lifetime, errors), each adding catalog entries and removing the call sites it covers; then move the remaining call sites to declared events and remove the adapters. F145.13 to F145.18 are part of this step.
- **R6 Sidecars and plugins, in their repositories.** The terminal sidecar (remove `performance.rs` and `service_log.rs`), files and shell (new), each with its own copy of the library, its catalog and its checklist item and release. The request envelope carries `cids` (additive; sidecars that do not know the field ignore it); `sidecar.send(surface, body, { cids })` is added to the plugin API and the plugins pass it. The policy reaches sidecars through the watched file.
- **R7 Viewer.** Debug view on the same parser: a timeline with filters (layer, level, event, surface, session, text, time range), following by file change notification, following one correlation identifier, context lines; a state view for `state-*.json` with comparison; the file list including raw files; saving a selection. A command `sok debug timeline` prints the same list. Commands, statuses and DOM names are declared by the exposure rules.
- **R8 Native observers and the run-time audit.** Declare and record the native sources the audit lists (application active and resign, key and main window, occlusion, workspace, input source change, pasteboard, first responder change before and after, `keyDown` branch, input method queries), the host events (windows, sidecars, endpoint, settings, projects, plugins, updates, shutdown), the terminal sidecar (task ends, refusals, empty key bytes, truncated `Char` with control or alt, replay truncation) and the page (dropped input branches), each as its own unit, with the window checks that drive them.
- **R9 Observation and closing.** Input in running applications of both hosts: Enter, English text, composed Korean text (activation tier), paste, control and alt keys, and 2000 characters in a burst. One correlation identifier joins every layer from the native callback to the PTY, and the logged `pty_write` bytes equal the bytes that an independent receiver captured (a shell stand-in that writes what it reads to a file). Benchmarks recorded. Documents updated. Release of core 0.0.11 with the version declared in every manifest, and releases and registry entries of the sidecars and plugins that changed.

## Documents, rules and memory

- Specification: `logging.md` and `events.md` with the schema (new, English and Korean); replace the record forms of `diagnostics.md`, `performance-trace.md` and the log sections of `hosts.md`, `native-host.md` and `sidecars.md`; update `debug.md`, `settings.md` and `plugins.md` (the `events` manifest field); replace the `log.*` rows of the host contract by rows of the new contract tests.
- AGENTS.md and its Korean copy: replace the text record rule and the wording about the performance trace of diagnostic builds with event and policy terms; add that a new event source is declared in the catalog of its repository, that a producer never blocks, that loss is counted, and that `console` is captured through the entrance.
- The text record format of F138 is replaced by a linked follow-up item.
- Memory outside the repository records the preferences about design from the ground up, performance, and standard methods.

## Alternatives rejected

- Adding fields and records to the present structure: two formats, five writers and hundreds of call sites remain, so omissions and the cost repeat.
- A binary or memory-mapped format (the system log approach): it survives a crash better, but tools, checks and reading by a person cost more than this need justifies. JSON lines with a prompt flush of `error` is enough; the plan does not promise records of the last batch interval after a crash.
- A flight recorder (memory ring dumped on error): a dump triggered in another process needs a new wire operation and an interprocess call to a possibly hung page, and a crash loses the ring when it matters. Aggregated `frame` summaries and a switchable detail category give the same coverage without those paths.
- One aggregator in the host for all processes: the persistent terminal service outlives the host, and evidence disappears when the host dies. One file per process, merged in the viewer.
- Keeping text as the stored format: two parsers and two rules remain and fields are not structured. Text is made in the view.
- A shared library consumed by tag from core: Go modules in a subdirectory need path-prefixed tags that core does not make, offline builds of the sidecars would need the network, and a sidecar would depend on a core release at run time. A contract, golden fixtures and a small library per repository avoid all three.
- A callback from the native library into the Go writer: a call from a thread that the Go runtime did not create costs microseconds to tens of microseconds. The host pulls from a native ring instead.

## Limits

- Wall clocks step and can differ between a sleeping and a waking machine; `mono_ns` orders events of processes of one boot, and `cids` order the layers of one input. The page has only the wall clock.
- A signal handler may call only async-signal-safe functions, so it writes a short line to a descriptor opened at start. The `info` events of the last batch interval (up to 100 ms) can be lost in a crash; an `error` is handed to the writer at once but is lost if the process dies before the writer runs.
- The page cannot write files, so it records through the host with batched calls. A batch not yet sent when the page process ends is lost (up to the flush interval).
- The input method answers only in the key window of the active application, so observing composed Korean input needs an activation-tier run.
- Rotation sheds the oldest records of a file when a flood of PTY output fills it; the contract states this bound.

## Verification

- Cross-check at every step. Three sources must agree before a step closes: the assertions of the tests (failing before, passing after), the logs that the unit and window tests leave, and an observation in running applications. Before the change, the failing test and the absence of the event in the log are recorded together. After it, the test passes, the remaining log holds the expected event with its fields, and holds no unexpected `error` and no unexplained `log.dropped`. A log audit gate validates every log that the tests leave with `soksak-log-check` (schema, declared events, continuous `seq`, drops explained by `log.dropped`, the declared chains complete for each input kind, no `error` besides declared expected errors); logs of a failed run are kept until classified.
- An independent oracle: for input, the bytes that a shell stand-in received are compared with the logged `pty_write` bytes, so the check does not compare the log with itself. The same scenario in a running application of each host is compared with the log of the test in event, fields and order; a difference is a defect.
- Gate: `make docs-check native-test boundaries exposure-check parity-check platforms hosts-check rust-format-check go-format-check rust-clippy-check host-contract-check`, then `pnpm test`, chained with `&&` and judged by the end line; the CI of each push is read. Benchmarks are recorded after the development of a step and do not hold an item open for load-dependent timing.
- The applications of a person and their data folders are only read. Check applications use their own configuration folders and processes.
