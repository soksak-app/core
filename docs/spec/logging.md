# Logging

[한국어](logging.ko.md)

This document is the contract of the records that the application writes about itself: what an event is, which classes of events exist and how each is stored, how a writer behaves, which files hold the events, and how events are declared and checked. [Diagnostics](diagnostics.md) lists the failure points and the files of `logs/`; [debug](debug.md) shows the files. The work that brings the implementation to this contract is [the observability plan](../plans/observability.md), and the parts that are not implemented are marked in [features](../features.md).

## Principles

1. **One event contract.** Every record of every layer is one event of the structure below. There is no second format. Text that a person reads is made from events by a viewer; it is not stored.
2. **A producer never blocks.** The UI thread, the input path and the frame path do no disk access, no IPC, no lock wait and no call from a thread of one runtime into another runtime to record. A disabled event costs one branch; an enabled event costs one copy into a bounded queue.
3. **Loss is counted and stated.** No queue, rate limit, rotation or truncation drops silently. Each loss is recorded as a `log.dropped` event, and every bound is stated in this document.
4. **The input path is complete.** Events of the class `input`, and the PTY writes and reads of the class `io`, hold every value and every byte that the layer saw. Their size is not limited by the writer.
5. **Events are declared.** Every event has an entry in the catalog of the repository that emits it. Development and continuous integration reject an undeclared event. At run time an undeclared event is still written, with the marker `undeclared`, and counted, so a naming error never drops evidence.
6. **Events of one kind enter at one entrance.** Page-to-host calls, window and application events, registry commands, sidecar lifetime and the display of errors each have one entrance that records. A call site does not write its own record for them.
7. **Records state facts.** An event states what happened, with the values at that time. It does not state who asked for it or why a person did it.

## Event

An event is one JSON object on one line:

```json
{"ts_us":1791500000000000,"mono_ns":123456789012,"seq":812,"level":"info","layer":"native",
 "event":"native.input.key_down","window":"w1","surface":"tab-x","session":"s7","cids":["b3.1042"],
 "fields":{"keyCode":36,"characters":"\r"}}
```

| field | meaning |
| --- | --- |
| `ts_us` | The wall clock in microseconds since the epoch. It orders events across layers. |
| `mono_ns` | The system-wide monotonic clock in nanoseconds (`mach_absolute_time` on macOS, `CLOCK_MONOTONIC` on Linux). It is comparable across processes of one boot and does not step. The page does not have it and omits the field. |
| `seq` | An integer assigned by the writer of the process when it serializes the event. Stored events of one process have consecutive `seq`; a gap is explained by a `log.dropped` event that names the range of the missing `seq` and is itself stored after the range it names. |
| `level` | `error`, `warn`, `info`, `debug` or `trace`. |
| `layer` | `native`, `host`, `page`, `plugin` or `sidecar`. |
| `event` | `<layer>.<subsystem>.<event>`, as the catalog declares it. The events of the writer itself are named `log.<event>` (`log.open`, `log.dropped`); their `layer` is the layer of the process that writes them. |
| `window`, `surface`, `session` | The identifiers of the object the event concerns, when it concerns one. |
| `cids` | The correlation identifiers of the inputs the event belongs to. It is omitted when there are none. |
| `fields` | The values of the event, as the catalog declares them. |

The first line of every file is `log.open`. It holds the schema number (`schema`), `pid`, the role of the process (`role`), the identifier of the run (`boot`), the version of the writer and the policy in force. A reader that meets a schema number it does not know rejects the file with an error that names the file and the number.

### Correlation identifier

A native input callback (a key event, a paste, a drop, a pointer report) receives one identifier `<boot>.<n>` from the layer that first sees it. The callbacks that it causes (`setMarkedText`, `insertText`, `commitThrough`) take the identifier of the callback that caused them. The identifier travels with the native report, the host relay and the page event; the plugin passes it with the send; the host puts it in the request envelope to the sidecar, so the body of the request stays the plugin's. A send that coalesces several inputs carries all of their identifiers, and the sidecar writes them in the events that the request causes, down to `pty_write`. A sidecar that does not know the envelope field ignores it.

## Classes and policy

An event belongs to one class, which the catalog declares. The class decides how it is stored.

| class | examples | rate | storage |
| --- | --- | --- | --- |
| `lifecycle` | window, application, sidecar and session lifetime; settings, project, plugin and update changes | low | always stored |
| `input` | keys, input method callbacks, paste, clicks | human speed | always stored, complete: the typed text, ranges, flags and the state before and after |
| `call` | page-to-host calls, registry commands, endpoint methods: name, arguments, result, microseconds | medium | stored. An argument over the size limit that the catalog declares is stored up to the limit and marked `truncated`. An argument that the catalog marks as redacted (a token, the body of a document) is stored as its size and a hash. |
| `io` | sidecar messages, PTY reads and writes | medium to high | stored complete. The only bound is the rotation of the file, which is recorded when it happens. |
| `frame` | image frames, screens, pointer moves, wheel, layout | high | aggregated: one summary event per declared interval holding the count, the extremes, the last value and the total microseconds. While the category is switched on, every event is stored. |

The setting `diagnostics.log` selects the categories that are stored in detail. The host writes the effective policy to `<config-dir>/log-policy.json`. Every process watches the file through file system events and reloads it when it changes; no protocol operation carries the policy. A process that cannot read the policy stores `lifecycle`, `input`, `call` and `io`.

A large value, such as the cells of a screen, is not written into an event; its size and hash are. The value is stored while the `frame` category is switched on.

## Writers

A writer is the part of a process that turns events into lines of a file.

- A producer checks the policy first (one branch). It then builds the event as an owned message and pushes it with a non-blocking push to a queue bounded by count and by bytes. A full queue increments a loss counter. A field that is costly to build is passed as a closure, or guarded by `enabled(name)`.
- One writer thread per process assigns `seq`, serializes the JSON, writes batches (every 100 ms, when 64 KB are queued, or at once after an `error`) and rotates the file. An `error` wakes the writer and returns; the producer does not wait for the disk.
- The writer turns the loss counter into `log.dropped` events `{from_seq, to_seq, class, count, bytes, reason}`. When a write fails (disk full, input/output error), the writer counts the loss, shows it in a status, and records `log.dropped` when writing works again. A heartbeat detects a writer thread that ended; the process then reports a fatal error and ends.
- Every exit path flushes the queue with a deadline before the process ends: shutdown of the Go host, exit of the Rust host, `panic = abort`, `os.Exit`.
- The native library has no writer. It owns a bounded lock-free ring in C; `sp_event` copies an event into the ring from any thread, and the writer thread of the host drains the ring by calling `sp_event_drain`. No producer thread calls into Go or Rust. Events written before the host writer exists wait in the ring.
- The page records through `context.log.<level>(event, fields)`. Events collect in an array and leave in one batch call to the host, on a timer of 100 ms, when a size bound is reached, and on `pagehide` and `visibilitychange`. The producer does not wait for the reply. `console.*`, global `error` events and `unhandledrejection` events enter the same entrance.
- A fatal signal handler writes a short line to a file descriptor that the process opened at start, with async-signal-safe calls only. A runtime fatal error of Go cannot be intercepted; its output goes to the crash file of the process, and `recover` at the entry of each goroutine writes an `error` event. The Rust host writes an `error` event and flushes from its panic hook.

Each repository that writes events carries its own small implementation of the writer, tested against the golden lines and the golden catalog in `packages/log-contract/fixtures`. No runtime code is shared between repositories, and no sidecar depends on a core release at run time.

## Files

A process run writes `logs/<role>-<boot>.jsonl` under the configuration directory. The host process also holds the events of the native library, the page and the plugins. Each writer rotates its own file at 100 MB and keeps 5 earlier generations (`.1` to `.5`); it never rotates another process's file. The only loss that rotation causes is the oldest generation, and the writer records the rotation.

Two raw files are not events: `logs/<role>-<boot>.stderr` holds the standard error of the process (output of the operating system and the frameworks), and `logs/<role>-<boot>.crash` holds the crash output of a runtime fatal error. The viewer lists them with the event files.

Files are created with mode `0600` in a folder with mode `0700` and are opened close-on-exec, so a child process does not inherit them.

The state files `logs/state-<time>.json` and the captures are not events; [debug](debug.md) writes them.

## Catalog

Each repository that emits events declares them in `events.json`: for each event the name, the layer, the class, the level, the required fields with their types, the arguments to redact, the size limit of arguments, and a description. The repository checks its own sources against its catalog, as it checks its own sources in every other check. This repository owns the schema of the catalog and the events of the layers `native` and `host` and of the page. A plugin or a sidecar declares its catalog in its manifest (`events`), and the viewer reads the catalogs of the installed manifests; this repository does not name them.

The catalog also declares the chains an input kind must leave, as the ordered list of events from the first layer to the last (for example `native.input.key_down`, the host relay, `page.terminal.send`, `sidecar.vt.pty_write`). An audit of a log requires every declared chain of an input to be complete.

### Entrances

These entrances record without a call site writing the record:

- the page calls of the host (one wrapper in the Go host, one invoke interceptor in the Rust host);
- window and application events (one registration helper in each host);
- registry commands (`timed` of the page);
- sidecar lifetime (launch and exit);
- the display of an error that a person sees, which emits the `error` event.

Sources that no entrance covers, such as notification observers, delegates, key-value observers, timers and the end of a task, are listed by a lint of the sources for events without a declaration or a reason comment. The lint is not proof. Coverage is judged at run time: a window check drives each declared source through declared commands and native input and requires its declared events.

## Checking

`soksak-log-check` (the package `@soksak/log-contract`, `packages/log-contract`) validates logs against the schema and the catalog: the line structure, declared events, consecutive `seq` with gaps explained by `log.dropped`, the declared chains of each input kind, and no `error` besides those a test declares. The unit tests and window checks leave their logs; the gate validates every log that remains, and logs of a failed run are kept until they are classified.

An input is checked against an independent receiver: the logged `pty_write` bytes equal the bytes that a stand-in for the shell wrote to a file.

## Privacy

Typed text is stored in `logs/` on this computer. It leaves the computer only when a person hands a file over. The actions that save a file or a selection warn that the file can hold what was typed. Arguments that the catalog marks as redacted are stored as a size and a hash.

## Limits

- Wall clocks step and can differ between a sleeping and a waking machine; `mono_ns` orders events of processes of one boot, and `cids` order the layers of one input. The page has only the wall clock.
- A signal handler may call only async-signal-safe functions, so it writes a short line prepared at start. The `info` events of the last batch interval (up to 100 ms) can be lost in a crash; an `error` is handed to the writer at once but is lost if the process dies before the writer runs.
- The page cannot write files, so it records through the host with batched calls. A batch not yet sent when the page process ends is lost (up to the flush interval).
- Rotation sheds the oldest generation when a flood of PTY output fills the files. The writer records each rotation.
- The input method answers only in the key window of the active application, so a check of composed input needs a run in which the application is active.
