# Observability plan

[한국어](observability.ko.md)

Status: pending proposal. The canonical task checklist is [features](../features.md) (F149, F150, F151). This proposal describes the work before it starts; the contract that the work produces belongs in the specification, and this proposal is removed after the specification holds it.

## Why the structure is rebuilt

- Records have two formats: the text record of `application.log` ([diagnostics](../spec/diagnostics.md#forms)) and the JSON lines of `performance.ndjson` ([performance trace](../spec/performance-trace.md)). Writers exist once per language and per purpose: the native library (`sp_log_*`), the Go host, the Rust host, the page (`performance.js`), and the terminal sidecar (`performance.rs`, `service_log.rs`). The Go sidecars (files, shell) have none. Parsers are separate too (`readErrors` of the window check and the parsers of individual checks).
- The cost is in the structure. The page trace makes one host call per event and serializes the calls in a promise chain. The native library writes each record with `write(2)` on the calling thread, which includes the UI thread. A screen event carries the whole cell array. Nothing classifies event volume.
- Omissions are structural. Each place that must record an event depends on someone remembering to write the record. An audit of the native library, both hosts, the page, the plugins and the sidecars lists hundreds of event sources without a record: 17 native source files with none, 68 of 69 Rust page commands, about 88 silent task or connection ends in the terminal sidecar, every operation of the Go sidecars. Nothing stops a new source from entering without a record.
- Records written before the log opens go to the terminal; the Go host has no panic hook; no identifier follows one input from the native callback to the PTY write, so a change of the typed text between two layers cannot be located.
- F145.6 made the failure handler of `orderedSidecar` mandatory without changing its caller in `packages/workbench/host.js`. After one failed send, every later send of the same sidecar name on the main page is rejected. The change is not part of a release.

## Principles

1. **One event contract.** Every record of every layer is one event of one structure. The text record format and the trace format are merged and removed. Text that a person reads is a view, not a stored format.
2. **A producer never blocks.** The UI thread, the input path and the frame path do no disk access, no IPC, no lock wait and no large allocation to record. A disabled event costs one branch; an enabled event costs one fixed-size enqueue.
3. **Loss is counted.** No queue, rate limit or truncation drops silently. The number and bytes of dropped events are recorded as `log.dropped` events.
4. **Events are declared.** Every event is declared in the catalog `docs/spec/events.json` with its name, layer, class, default level and required fields. An undeclared event fails a test; a declared event that nothing emits fails the audit.
5. **Choke points record automatically.** Events of one kind are recorded at one entrance: page-to-host calls, window and application events, registry commands, sidecar lifecycle, the display of errors. A call site does not write its own record.
6. **The structure is complete before it is closed.** A threshold is never lowered, a feature is never switched off, and a layer is never left out to meet a goal. A part that a standard design cannot provide is stated under *Limits*.
7. **No backward compatibility.** When the new contract exists, the old writers, file formats and parsers are removed. A reader that meets another schema rejects the file with an error that names the file and the value it found.

## Design

### Event model (`docs/spec/logging.md` holds the contract)

```
{"ts_us":1791..., "seq":812, "level":"info", "layer":"native", "event":"native.input.key_down",
 "window":"w1", "surface":"tab-x", "session":"...", "cid":"b3.1042", "fields":{...}}
```

- `ts_us` is the wall clock in microseconds and orders events across layers. `seq` increases within a process and orders events inside one microsecond and shows lost events. The identity of the process (`pid`, `process`, `boot`) is written once in the first line `log.open`, which also holds the schema number.
- `level` is `error`, `warn`, `info`, `debug` or `trace`. `layer` is `native`, `host`, `page`, `plugin` or `sidecar`.
- A name is `<layer>.<subsystem>.<event>` (`native.input.key_down`, `host.endpoint.close`, `page.terminal.send`, `sidecar.vt.pty_write`). The catalog defines the names.
- `cid` is the correlation identifier. The layer that first sees an input issues it (`<boot>.<n>`), and it travels with the native report, the host relay, the page event, the plugin send, the sidecar request and the `pty_write` of that input. It joins the layers of one input.
- Files: one per process, `logs/<process>.jsonl`; the host process also holds the native, page and plugin events. The raw standard error of a process (operating system and framework output) goes to `logs/<process>.stderr`, separate from events. Rotation is 100 MB with 5 earlier generations.

### Classes and policy

| class | examples | rate | default policy |
| --- | --- | --- | --- |
| `lifecycle` | window, application, sidecar and session lifetime; settings, project, plugin and update changes | low | always stored |
| `input` | keys, input method callbacks, paste, clicks | human speed | always stored, with the typed text, ranges and flags |
| `call` | page-to-host calls, registry commands, endpoint methods (name, arguments, result, microseconds) | medium | stored; an argument over the size limit is stored up to the limit and marked `truncated` |
| `io` | sidecar messages, PTY reads and writes | medium to high | writes stored; reads limited by a token bucket, and the excess counted in `log.dropped` |
| `frame` | image frames, screens, pointer moves, wheel, layout | high | flight recorder: kept in a memory ring; the ring of the last seconds is stored as `log.ring_dump` on an error, a fatal signal or a request; stored continuously when the category is switched on |

- The setting `diagnostics.log` selects the policy and replaces `diagnostics.performance`. The host passes it to every process; a sidecar receives the protocol operation `log.policy` when it connects and when the policy changes. In a 0.0.x diagnostic build the default stores `lifecycle`, `input`, `call` and `io`, and holds `frame` in the ring.
- A large value such as a screen body is not written into an event; a size and a hash are. The body is available when the `frame` class is switched on.

### Writers

- A producer checks whether the event is enabled (one branch), copies a fixed-size structure into a bounded multi-producer queue with a non-blocking push, and a dedicated writer thread serializes JSON and writes batches (100 ms or 64 KB). An `error` is flushed at once. A fatal signal handler writes a short JSON line prepared in advance with `write(2)`.
- Location: `packages/log/{rust,go,js}` in core. The hosts and the sidecars use the same library. Sidecars in other repositories take it as a dependency pinned to a core tag, as plugins pin `@soksak/plugin-api`. Each library runs the contract tests (golden JSON lines and the checker `soksak-log-check`) in its own package.
- Native: the library has no writer. The C interface `sp_event(level, class, name, fields)` hands the event to the sink that the host installs; events before the sink exists wait in a bounded startup buffer and are written when the sink is installed. A native test without a host uses a default sink.
- Page: `context.log.<level>(event, fields)` collects events in an array and sends them with one `logBatch(events)` call in a microtask or animation frame. `console.*`, global `error` and `unhandledrejection` enter the same entrance. Surface and modal documents use the same `page.log`.
- The Go sidecars have no records today and use the Go library from the start.

### Catalog and automatic entrances

- `docs/spec/events.json` declares each event: name, layer, class, level, required field names and types, description. A test rejects an event that the catalog does not declare.
- Automatic entrances replace hundreds of call sites: one wrapper for the page calls of the Go `Host`, one invoke interceptor for the Rust host, one registration helper for window and application events, `timed` of `exposure.js` for registry commands, launch and exit for sidecar lifetime, and the single display path of errors that a person sees, which emits the `error` event.
- Sources that an entrance cannot cover (native notification observers, delegates, key-value observers, timers, task ends of the sidecars) are matched by patterns in `make events-check`; each needs a declared event or a reason comment. The check has no baseline: the unrecorded sources of the audit enter the catalog first, so the count starts at zero.

## Steps

Each step ends with a failing test recorded before the change and passing after it, the specification in English and Korean, the changelog, the parity inventory, the full gate, an observation in running applications, and a commit. Each step removes the old path it replaces in the same series.

- **S0 Cleanup.** Fix the regression of F145.6 (failing test: a second send after a failed send on the main page is delivered). Commit the open records (endpoint timeout, native fields, input path check) so that the working tree is clean; their old-format records are a seed for the catalog. Register F149, F150 and F151.
- **S1 Contract.** `logging.md`: principles, event model, classes and policy, files, clocks, correlation identifier, loss counting, privacy (typed text stays in `logs/` of this computer and leaves only when a person hands it over). The catalog schema, golden fixtures, `soksak-log-check`, terms (`event`, `class`, `cid`, `ring`), and the changes of the rules in AGENTS.md. Performance budget: a disabled event costs one branch; an enabled enqueue is at most 1 microsecond at the 99th percentile; a producer thread never blocks; dedicated benchmarks measure it, and the input latency from key injection to `pty_write` is measured with logging on and off.
- **S2 Libraries.** Rust, Go, JavaScript and the C sink with their contract tests and benchmarks (enabled and disabled enqueue, writer throughput, counted loss with a full queue, startup buffer, JavaScript batching).
- **S3 Core.** Move the Go host, the Rust host, the native library and the page API to the new writer. Remove `application_log.*`, `performance.*`, `sp_log_*`, `performance.js`, the `report` and `log` host calls, and the old parsers of the window check and the checks. Startup buffer, panic hook and fatal handling (new in Go), standard error separation. All window checks pass on both hosts.
- **S4 Sidecars and plugins.** The terminal sidecar (remove `performance.rs` and `service_log.rs`), files and shell (new), the protocol fields `cid` and the operation `log.policy`, and the plugins on `context.log`. `cid` crosses every layer of one input.
- **S5 Catalog.** Declare every unrecorded source that the audit lists, by class; add the automatic entrances and the native observers (application active and resign, key and main window, occlusion, workspace, input source change, pasteboard, first responder change before and after, `keyDown` branch, input method queries), the host events (windows, sidecars, endpoint, settings, projects, plugins, updates, shutdown), the terminal sidecar (task ends, refusals, empty key bytes, truncated `Char` with control or alt, replay truncation) and the page (dropped input branches). `make events-check` joins the gate. F145.13 to F145.18 are part of this step.
- **S6 Viewer.** Debug view on the same parser: a timeline with filters (layer, level, event, surface, session, text, time range), following by file change notification, following one `cid`, context lines; a state view for `state-*.json` with comparison; the file list; saving a selection. A command `sok debug timeline` prints the same list. Commands, statuses and DOM names are declared by the exposure rules.
- **S7 Observation and closing.** Input in running applications of both hosts: Enter, English text, composed Korean text (activation tier), paste, control and alt keys, and 2000 characters in a burst. One `cid` joins every layer from the native callback to the PTY, and the recorded bytes equal the input. Budgets measured. Documents updated. Release of core 0.0.11 and its registry entry.

## Documents, rules and memory

- Specification: `logging.md` and `events.md` with `events.json` (new, English and Korean); replace the record forms of `diagnostics.md`, `performance-trace.md` and the log sections of `hosts.md`, `native-host.md` and `sidecars.md`; update `debug.md`; replace the `log.*` rows of the host contract by rows of the new contract tests.
- AGENTS.md and its Korean copy: replace the text record rule and the wording about the performance trace of diagnostic builds with event and policy terms; add that a new event source is declared in the catalog, that a producer never blocks, that loss is counted, and that `console` is captured through the entrance.
- The text record format of F138 is replaced by a linked follow-up item; a completed item is not reopened.

## Alternatives rejected

- Adding fields and records to the present structure: two formats, five writers and hundreds of call sites remain, so omissions and the cost repeat.
- A binary or memory-mapped format (the system log approach): it survives a crash better, but tools, checks and reading by a person cost more than this need justifies. JSON lines with an immediate flush of `error` is enough.
- One aggregator in the host for all processes: the persistent terminal service outlives the host, and evidence disappears when the host dies. One file per process, merged in the viewer.
- Keeping text as the stored format: two parsers and two rules remain and fields are not structured. Text is made in the view.
- One shared binary library: it does not fit the repository boundaries or the toolchains of Go, Rust, JavaScript and Objective-C. A contract, a thin library per language and the same contract tests are the standard design.

## Limits

- The monotonic clocks of different processes cannot be compared. Order across layers comes from the wall clock and from `cid`; the order of events of different processes inside one microsecond without a `cid` cannot be determined.
- A signal handler may call only async-signal-safe functions, so it writes a short JSON line prepared in advance. The `info` events of the last batch interval (up to 100 ms) can be lost; an `error` is flushed at once and is not.
- The page cannot write files, so it records through the host with batched calls. A batch not yet sent when the page process ends is lost (at most one frame).
- The input method answers only in the key window of the active application, so observing composed Korean input needs an activation-tier run.

## Verification

- Cross-check at every step. Three sources must agree before a step closes: the assertions of the tests (failing before, passing after), the logs that the unit and window tests leave, and an observation in running applications. Before the change, the failing test and the absence of the event in the log are recorded together. After it, the test passes, the remaining log holds the expected event with its fields, and holds no unexpected `error`, no `log.dropped` and no gap in `seq`. A log audit gate validates every log that the tests leave with `soksak-log-check` (schema, declared events only, continuous `seq`, complete `cid` chains, no `error` besides declared expected errors); logs of a failed run are kept until classified. The same scenario in a running application of each host is compared with the log of the test in event, fields and order; a difference is a defect.
- Gate: `make docs-check native-test boundaries exposure-check parity-check platforms hosts-check rust-format-check go-format-check rust-clippy-check host-contract-check events-check`, then `pnpm test`, chained with `&&` and judged by the end line; the CI of each push is read.
- The applications of a person and their data folders are only read. Check applications use their own configuration folders and processes.
