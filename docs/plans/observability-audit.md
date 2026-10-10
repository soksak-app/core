# Observability audit plan

[한국어](observability-audit.ko.md)

Status: pending proposal. The canonical task checklist is [features](../features.md) (F160, F161, F158, F159). This proposal records the result of the audit of 2026-10-11 and the decisions that the items implement; when an item is closed, its content moves to the specification and this text is removed.

## Proposition

Everything that happens is recorded in the event log ([logging](../spec/logging.md)). Each result of a test, success or failure, maps to a place in the logs. No source needs to change afterwards only to observe. Recording causes no performance problem. A criterion may change when the situation requires it, with the evidence in the related document; it is never lowered because a test is hard to meet.

## Result of the audit

The audit read the sources of core, of the sidecars and plugins, and of the verification; it ran nothing. The proposition is false today.

- **The checks prove names, not coverage.** `make events-check` finds each declared name as text in a source, so a comment satisfies it; it does not find an emitted name that is not declared, the required fields, or a source without an event. `scripts/check-fallbacks.mjs` demands a reason comment and sees only some forms (not an Objective-C observer, monitor, KVO or timer, a delegate, `return NO`, a Go `go` statement without `recover`, or a dropped channel).
- **Test results do not map to the logs.** No run identifier, test name or offset reaches a log. The runner keeps output in memory and prints a failure only. The audit `check-events.mjs --logs` runs by hand and not in CI, `auditLog` does not report an `error` event or the files of the sidecars, and the offsets file is overwritten at the end of each check. Stall files, crash reports and the standard error have no event.
- **No identifier links a chain.** No event of about 300,000 in the logs carries `cids`; no layer assigns the identifier of an input, and `native.input.key_down` is not in the catalog. A page command, a host call and a sidecar request, a window, a project, a change of settings and a plugin operation are matched only by surface and time.
- **Sources are silent.** Of about 36 registrations of observers, monitors, KVO and timers in the native library 13 are recorded. The Go host has about 21 `go` statements and no `recover()`. Endpoint methods are recorded only while the performance trace is on. Buffers of pending replies and closes grow without a bound. Only the terminal sidecar writes events; the two Go sidecars and the seven plugins have no catalog, no event file and no `cids`.
- **The performance of recording is designed, not measured.** No benchmark result is recorded; the input latency is never compared with recording on and off; the first responder is recorded on each frame with a dictionary on the main thread; the hex of `pty_read` allocates for each byte; `page.call` serializes all arguments before it cuts them.
- **The volume hides the signals.** A log of 139,068 events (47.8 MB) holds `error` 0.0%, `warn` 0.4%, `info` 4.8% and `debug` 94.8% (`page.call` 83,755 and `native.input.query` 42,621 events). Rotation at 100 MB in 5 generations holds about 7 hours of this volume.

## Decisions

Each decision states the reason, because a later reader must be able to judge it again.

1. **Record every level; reduce the cost at the producers and keep the evidence, instead of discarding.** The person requires that all of it is recorded, including `debug` (94.8% of the events of the measured log). A discard by minimum level would also give up the diagnosis of the stalled start of the editor page, which needed exactly a `debug` event (`page.call ready-1` without `loadFile`). The measured rate (at most 1,500 events/s, no loss) is far below the bound of the queue, so a discard in the writer saves no cost; the cost is in the producers (the serialization in `page.call`, the dictionary of the first responder on each frame, the allocation for each byte in the hex of `pty_read`). Therefore each producer builds its fields cheaply (a builder function, no whole-value serialization before the cut, no allocation for each byte), every level is stored, `error`, `warn` and `info` are written to `host-<boot>.jsonl` and `debug` and `trace` to `host-<boot>.debug.jsonl` so that a signal is readable, and rotation keeps every generation and never compresses it, because a compressed file cannot be searched in place. A file is deleted only by an explicit command or when a stated disk budget is exceeded, and each deletion is the event `log.pruned` (files, bytes, time range) in the next file, so that no loss is silent. Two questions go to the adversarial review below: how an event of the class `frame` (per frame, the highest rate) is stored completely, and how `debug`, which holds 94.8% of the events, is divided into more levels (candidates: a level `verbose` between `debug` and `trace`; numbered levels `debug1` to `debug3`; or no new level and the class decides) so that a person can read a part of it and a gate can name it.
2. **The structure must find a new silent source.** A guard that compares names passes a new silent source. One rule per language lists each source of occurrences without an event or a stated reason, with no baseline, and a command that every repository calls applies it (`soksak-events`).
3. **A test result is a range of the logs.** Each run has an identifier in `log.open` and a manifest; each test stores `test.start` and `test.end`; the output and the evidence of a failed run are kept until a record classifies them; the audit of the logs runs after each run and in CI.
4. **One entrance for each kind of source.** Native registrations, goroutines, endpoint methods, calls and plugin operations are recorded at one entrance each, so that a new source is covered without a record at each site.
5. **What is recorded must be findable.** The log is canonical and append-only (crash-safe JSON lines); an index built incrementally beside it answers a query by time range, level, layer, event name, surface, session, `cids`, run identifier and text, and the host returns one page of the result with a cursor. The debug view, `sok`, the judgment of each test (F160.16) and the audit of the logs use that one query; the page never loads a file. The timeline of the debug view stopped answering on a file of 100,000 rows because the page loaded and drew all of them (F157). Where the index lives (a file of offsets beside each log, or an embedded database) is a question of the adversarial review below.
6. **A number closes a performance item.** The numbers of the benchmarks, the input latency with the gate on and off, the allocations, the bytes per minute of each tier and the hours of retention are recorded in the logs and compared with the budget; the budget changes only with its evidence.

## Items

| Group | Items | Content |
| --- | --- | --- |
| A, contract and guard | F160.1 to F160.10 | both directions of `events-check`; the census rule; the native entrance; the goroutine entrance; endpoint methods; bounds and counted loss; tiers and gates; the input chain; the other chains; one result form |
| B, tests and logs | F160.11 to F160.16 | run identifier; markers of the start and end of a test; stored output and evidence; automatic audit; links of stall files, crash reports and the standard error; the judgment of each test by the log |
| C, performance | F160.17 to F160.20, F158, F159 | recorded benchmark numbers; the latency with recording on and off; the cost of native records; the budget of the volume; the observation of the stall and of the modal before their changes |
| D, outside core | F160.22, F160.23 | the guard command; the events of the two Go sidecars, the terminal sidecar and the seven plugins, as items of their own checklists |
| E, failures | F161 | the classification and repair of the failures of the full run of the window checks |

Order: the guard (F160.1, F160.2), the mapping of tests to logs (F160.11 to F160.16), the baseline of numbers (F160.17 to F160.20, F158, F159), the sources and chains in core (F160.3 to F160.10), the repositories outside core (D), the failures (F161), then the full run, the push and the release.

## Verification

A guard shows its Red by failing on a source or an event that a test adds on purpose. A run is judged by its manifest, the markers and the audit of the logs, with no undeclared `error`. A source is observed in both applications. A performance item is closed by recorded numbers. A closed item is not reopened; a missing observation becomes a follow-up item.

## Adversarial review

The decisions above are reviewed by agents that argue against them and propose solutions, repeatedly, until no objection remains. The objections, the answers and the resulting changes are recorded here.
