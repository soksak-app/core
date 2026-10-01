# Performance trace

[한국어](performance-trace.ko.md)

The performance trace is a permanent instrument, present in every build, that records what the application spends time and memory on. It is not a diagnostics-build feature and is never removed after use. The switch is the declared setting `diagnostics.performance` ([settings](settings.md)); while it is false no layer does any logging work — no file is created and no formatting runs.

The page does not format or relay events while disabled or awaiting enable acknowledgment. Switch requests and event relays preserve their order: disabling stops new events immediately and waits behind already accepted relays. Switch failures reject the settings operation; relay failures are reported explicitly and do not replace the result of the measured command.

## Output

Events append to `logs/performance.ndjson` under the configuration directory. Every line is one event object with at least `ts` (ISO-8601 with milliseconds), `pid` (the writing process), `layer` (`page`, `host`, `vt-core`, `files`, `shell`, `sampler`), and `event`; further fields depend on the event. One file carries every layer, so one timeline reads the whole application. The file rotates at 10 MB to `performance.ndjson.1`, keeping one previous generation; rotation and the file itself belong to the trace, so an old log survives a restart with the flag off. A `session_start` event marks each process start and carries the role of the writer.

## Producers

Every layer is a producer; the trace is not defined by one of them.

- **Page** — every `core.*` and plugin command with name, duration, and result class; exposure watch notification volume; layout queue waits and supersessions; grid renders; card and tab operations; surface mount lifecycle; surface registration phases (`pending`, `registered`, `closed`, `disposed`) with document `timeOrigin`, `hasPort`, and registered `names` at the event; compositor publishes and clip updates; screen-event handling time; settings, project, and reload markers; JS heap readings; user action markers with values (a window resize carries its size, a tab switch its ids). The page owns no filesystem, so its lines relay through a host command that appends them.
- **Host** (both hosts as a parity pair) — every endpoint method with name, duration, and result class; window events with values (size, move, focus, occlusion, scale); surface lifecycle with geometry (created, destroyed, placed, visibility); document, image, and composition operations including presentation barrier wait durations; protocol rejections with the offending payload values; a process registry naming every spawned pid and its role; sidecar spawn and exit.
- **Sidecars** (`vt-core`, `files`, `shell`) — request handling with operation, duration, and result. `vt-core` adds frame events with the reason the frame was drawn (`output`, `blink`, `resize`, `metrics`, `selection`), the draw, transfer, and consumed-wait timings as separate fields, and the raster size; PTY read byte counts and PTY resizes with the grid before and after; and session lifecycle.
- **Sampler** — every five seconds, the resident size of every process the registry names, so memory readings attribute themselves. A reading that cannot obtain a size records `error` instead of the size.

## Flag propagation

The page reads `diagnostics.performance` from the settings it already loads and tells the host through the `host.performance` command — `on` when the setting turns true, `off` when it turns false, and once at startup when a stored setting is already true. `on` makes the host write a `performance` flag file carrying the log path into each sidecar's service directory; a sidecar checks the flag at start and on each accepted connection, so the protocol between host and sidecar does not change. `line` relays a page event and is refused while the trace is off, so an off trace never creates the file.

The host owns the runtime switch at `<config-dir>/performance`, containing the log path. Here `<config-dir>` is the host-resolved configuration directory with symlinks resolved, rather than a command-line path alias. Service flags are derived outputs and do not determine host state. Startup removes stale runtime and service flags before the page propagates its effective setting. Enabling works with no service directories; an already disabled switch writes no events. Invalid page events and filesystem failures reject switch or relay requests. Passive instrumentation reports failures without replacing the measured operation result. Missing runtime or service paths mean disabled or no installed services respectively; other read errors are explicit failures.

## Reading

The file is NDJSON, so field tools answer questions directly: the frame reasons of an idle terminal (`select(.event=="frame") | group_by(.reason)`), the raster values a drag through collapse produced (`select(.event=="configure")`), whether tab switching recreated webviews (`select(.event=="surface")`), and what memory did around a user action (`select(.event=="action")`).
