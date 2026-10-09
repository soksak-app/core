# Diagnostics

[한국어](diagnostics.ko.md)

A defect that appears once on a user's machine is located only from records that the application wrote before the defect appeared. This document is the one place that states which records exist, who writes them, their form, and where each failure leaves its record. [Hosts](hosts.md#application-log), the [performance trace](performance-trace.md) and the [debug view](debug.md) state the details of their own parts and refer here for the table of files and the rules.

## Folder

Every diagnostic file of an application is under `<config-dir>/logs/`. A person who meets a defect hands over this folder, and the [debug view](debug.md) lists and saves it. No other folder holds a diagnostic file. Operating files such as `webkit-children.json` are not records and stay outside `logs/`.

## Files

| File | Writer | Form | Bound |
|---|---|---|---|
| `application.log` | both hosts, the page through `report`, the native library through `sp_log_error`, the standard error of the sidecars that the host starts | text records of one form ([Forms](#forms)) | renamed to `application.log.1` at 100 MB, when a run opens it, and the five earlier generations are kept |
| `<executable-name>.log` | a persistent service, opened by the host as the standard error of the service | text records of the same form, written by the service | renamed to `<name>.1` at 100 MB, when the host starts the service, and the five earlier generations are kept |
| `performance.ndjson` | the page, both hosts, the sidecars and the sampler | one JSON event per line | rotated at 100 MB to `performance.ndjson.1`, and the five earlier generations are kept |
| `state-<time>.json` | both hosts, when the debug view opens | one JSON document | none; one file for each opening |
| `captures/…` | both hosts, in a diagnostic build | PNG and frame files | the requester removes them |

`<time>` is the UTC time `YYYYMMDDTHHMMSSZ`. A stall sample is written by the window-check harness and not by the application.

## Forms

Three forms of record exist, and each fact has the form that fits it. The two line forms, the text record and the event, put the time first and the same layer names in them, so one reader can order both.

1. **Text record.** One line of `application.log` or of a service log: `<time> <level> <layer> <where>: <text>`, separated by single spaces.
   - `<time>` is the UTC time `YYYY-MM-DDTHH:MM:SS.mmmZ` of the write, the form of `ts` of an event.
   - `<level>` is `error` for a failure and `info` for a state without a failure.
   - `<layer>` is who wrote the record: `page`, `host`, `native`, or `sidecar`.
   - `<where>` names the operation or the object, may contain spaces, and ends at the first `: `.
   - `<text>` is the rest of the line. A line feed in it is written as the two characters `\n`, so one record is always one line.

   Every failure writes a record of level `error`, and every other record is of level `info`. A writer has one helper for each level (`LogError` and `LogInfo` in Go, `log_error` and `log_info` in Rust, `sp_log_error` and `sp_log_info` in the native library, `report` with the level in the page), and a site that both hosts have writes the same `<where>` and `<text>` in both. A host writes each line of the standard error of a sidecar that it reads as a record of level `info`, layer `sidecar`, and `<where>` the name of the sidecar; a persistent service writes its own standard error in this form with the same layer and `<where>`. The crash output of a runtime (the Go panic and fatal signal report, and the message of the Rust default panic hook) is the only text that has no form, because the runtime writes it.
2. **Event.** One line of `performance.ndjson`: a JSON object with `ts` (ISO-8601 with milliseconds), `pid`, `layer` and `event`, and the fields of its event. An event records what happened and when, in the order of one timeline across the layers.
3. **State file.** `state-<time>.json`: the state of the application at one time, with `time`, `host`, `versions`, `windows` and `page`. A part that the writer cannot read is recorded with its error and does not stop the file.

## Rules

- A failure point has its record in the table below. A failure point that the table does not list is a defect of this document.
- A record is written at the moment of the failure, by the event that reports it. A timer or polling does not search for failures. One cause writes one line; a repeated report of the same cause adds nothing.
- Each file has a size bound that its writer applies when it opens the file. The performance trace, which has one writer, also applies it while it writes; the application log and the service logs have several writers of one descriptor, so they grow until the next open.
- A record of the input path holds everything that the layer saw: the typed text, every range and flag, every byte read from or written to the PTY, the state of the input document before and after, and a time. A defect of the input is located from the files alone, so a record is never cut and a layer never leaves out a value that it can see. The files are in `logs/` of the computer of the person, and the text that a person typed, a password included, is in them; the person hands the folder over when a defect is reported. The content of a file that a person opens is not an input and is not recorded.
- The records of the input path: the native library writes `info native input method` for each callback of the input method (`keyDown`, `insertText`, `setMarkedText`, `unmarkText`, `doCommandBySelector`, `commitThrough`, `reportPreedit`, `clearDocument`, `commitPending`, `inputSourceChanged`, `becomeFirstResponder`, `resignFirstResponder`) as a JSON object with its arguments and the `before` and `after` state of the document (`document`, `committed`, `marked`, `selected`, `reportedPreedit`, `source`, `focus`, `closed`, `reports`), and `info native input report` for each JSON report that it sends to the page; a callback that drops its input says so in its record (`"dropped":"noop"` for a `noop:` command, `"dropped":"not text"` for an insert or marked text that is not text), and a report to a region that is closed is written as `info native input report dropped`; the native library writes `info native input inject` for each pointer or key input that the endpoint injects, as a JSON object with its arguments (`x`, `y`, `phase`, `button`, `deltaX`, `deltaY`, or `key`, `text`, `modifiers`, `down`), its `result` (`delivered`, `rejected`, `inactive`, `unreceived`, `button held`, `press open`) and the `reason` of a refusal; the plugin writes the trace events `region`, `ime`, `input`, `send`, `send.result` and `sidecar.event` with their whole bodies; the hosts write the trace events of the layer `host` `region` (each event of a native region, with `surface`, `name` and the whole `body`), `sidecar.send` and `sidecar.receive` (each request to and message from a sidecar, with `sidecar`, `surface` and the whole `body`); the terminal sidecar writes `request` with the whole body, `pty_write` and `pty_read` with the length, the text and the hexadecimal bytes of every chunk, and `session_open`, `pty_eof`, `pty_read_error` and `session_exit`.
- A writer that cannot write its record reports the error where it can: the host that cannot open its application log does not start.
- Each failure point has a test that causes the failure and reads the record.
- The state file is complete from values that the host holds, so a window whose page did not start is in it with its `ready` value and its last error line.

## Failure points

A row shows a record without its time, as `<level> <layer> <where>: <text>`.

| Failure | Record |
|---|---|
| a module of the main page fails to load or throws while it loads | `error page start: <text> @ <file>:<line>` ([page start](native-host.md#page-start)) |
| the host cannot serve a file that the page requests | `error host page asset: <path>: not found`, once for each path |
| the main page throws or rejects after its first screen | `error page <where>: <text>` of the page's error display |
| the WebContent process of a surface or a modal ends in the Wails host | `error native surface webview: web content process terminated: <address>`; the Tauri host writes the end of every web view, including a surface and a modal, as `error host page process: <label>: terminated` |
| the WebContent process of a window ends | `error host page process: <window>: terminated` |
| a native call fails | `error native <where>: <text>` from `sp_log_error` |
| a fatal signal or an uncaught exception of the Tauri host | one `error native fatal: <signal name>` or `error native fatal: uncaught exception <name>: <reason>` record, then the process ends; the Go runtime writes the report of a fatal signal of the Wails host to the standard error |
| the Rust host panics | `error host panic: <file>:<line>: <message>` from the panic hook; the Go runtime writes the stack of a panic of the Wails host to the standard error |
| a sidecar process of standard input and output ends while the host runs | `error host sidecar <name>: failed: output closed: <exit status>` |
| the connection to a persistent service ends while the host runs | `error host sidecar <name>: connection lost; restarted`, or `connection lost; restart failed: <reason>` |
| a synthetic pointer input does not complete in a webview | `error native webview input: receipt of <type> did not arrive within <seconds> seconds`, `send of <type> was refused`, `_setIgnoresMouseMoveEvents: is unavailable`, `_doAfterProcessingAllPendingMouseEvents: is unavailable`, or `receipt message ignored: <reason>`; `info native webview input: wait for <type> ended by the end of the registration` and `receipt of <type> arrived without a wait` |
| a message of a sidecar has no window that owns its surface, or a closed notice waits for the full queue of a sidecar | `info host sidecar <name>: message for surface <surface> dropped: no window owns the surface: <body>` and `info host sidecar <name>: close <surface>: outbox full, buffered` |
| a document region fails to navigate, refuses an address, cannot find a plugin file, receives a message without data, or loses its WebContent process | `info native document view: navigation failed: <reason> (<domain> <code>) <address>`, `navigation refused: <address> is not a web address`, `plugin file not found: <address>`, `message without data: <reason> (<address>)`, and `error native document view: web content process terminated: <address>`; the failure also reaches the page that owns the region as the `failure` of the document |
| the host refuses a frame of an image region, or an image field is not an envelope | `info host image frame: surface=<s> name=<n> sender=<sidecar> generation=<g> raster=<r> sequence=<q> refused: <reason> current <state>` for a frame of a sidecar that does not own the region or of an old raster (`notAttached`, `stale`), `error host image frame: ... refused: unsupported ...` for a format, token or nonce that the host does not present, and `error host image frame: surface=<s> sender=<sidecar> malformed image envelope: <image>` |
| a script of the document of a surface or a modal throws, a module of it does not load, or a promise of it is rejected without a handler | `error page surface <id>: <message> @ <file>:<line>`, `cannot load <address>` or the message of the rejection; a document without a surface id writes the place `document`; the same text is written once |
| the host narrates a diagnostic step of a window (a modal rendered, a drag, a navigation callback), or the Wails host fails to read the window state or to ask the page to watch again | `info host transcript <window>: <line>`, and in the Wails host `error host host.window <window>: <error>` and `error host rewatch <name> <window>: <error>`; the transcript of the connections that asked for it receives the same lines |
| a send of a page to a sidecar fails | `error page sidecar <name>: send failed: <reason>`, written through `page.report` of the document of the surface |
| files dropped on the window cannot be given to a surface | `error page drop: <reason>` (the drop is invalid, no surface is under the drop point, the plugin declares no drop command, or the command fails); every drop also writes `info page drop: received <payload>` and, when a command accepts it, `info page drop: command <name> accepted <n> file(s) on surface <id>` |
| a connection of the endpoint closes | `info host endpoint: connection closed: <reason>`, written before the socket closes, where the reason is `peer closed`, `frame of <n> bytes exceeds the limit of <limit>`, `frame is not a JSON-RPC 2.0 request: <body>`, `method "<name>" is not declared`, `the endpoint closed`, or, in the Wails host, `the output queue is full`, `write failed` and `the reply cannot be encoded` |

A failure that the caller of an operation receives, and that the caller shows through the error display, is recorded by that display: a request of the endpoint answers its failure to its client, a `sok` command ends with its status and its message on the standard error, and a plugin shows the failed navigation of its document region, which the host reports as the `failure` of the document, with `tab.error` ([plugins](plugins.md)), whose display writes `error page tab error <tab id>: <text>`.

## Reading

The application log answers what failed and where, the performance trace answers when and in what order, and the state file answers what the application held at one time. A report of a defect names the files of `logs/` and the time of the defect.
