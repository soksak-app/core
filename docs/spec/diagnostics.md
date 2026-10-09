# Diagnostics

[한국어](diagnostics.ko.md)

A defect that appears once on a user's machine is located only from records that the application wrote before the defect appeared. This document is the one place that states which records exist, who writes them, their form, and where each failure leaves its record. [Hosts](hosts.md#application-log), the [performance trace](performance-trace.md) and the [debug view](debug.md) state the details of their own parts and refer here for the table of files and the rules.

## Folder

Every diagnostic file of an application is under `<config-dir>/logs/`. A person who meets a defect hands over this folder, and the [debug view](debug.md) lists and saves it. No other folder holds a diagnostic file. Operating files such as `webkit-children.json` are not records and stay outside `logs/`.

## Files

| File | Writer | Form | Bound |
|---|---|---|---|
| `application.log` | both hosts, the page through `report`, the native library through `sp_log_error`, the standard error of the sidecars that the host starts | text records of one form ([Forms](#forms)) | renamed to `application.log.1` at 10 MB, when a run opens it |
| `<executable-name>.log` | a persistent service, opened by the host as the standard error of the service | text records of the same form, written by the service | renamed to `<name>.1` at 10 MB, when the host starts the service |
| `performance.ndjson` | the page, both hosts, the sidecars and the sampler | one JSON event per line | rotated at 10 MB to `performance.ndjson.1` |
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
- A record holds kinds and lengths, never typed text or file content.
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
| the WebContent process of a window ends | `error host page process: <window>: terminated` |
| a native call fails | `error native <where>: <text>` from `sp_log_error` |
| a fatal signal or an uncaught exception of the Tauri host | one `error native fatal: <signal name>` or `error native fatal: uncaught exception <name>: <reason>` record, then the process ends; the Go runtime writes the report of a fatal signal of the Wails host to the standard error |
| the Rust host panics | `error host panic: <file>:<line>: <message>` from the panic hook; the Go runtime writes the stack of a panic of the Wails host to the standard error |
| a sidecar process of standard input and output ends while the host runs | `error host sidecar <name>: failed: output closed: <exit status>` |
| the connection to a persistent service ends while the host runs | `error host sidecar <name>: connection lost; restarted`, or `connection lost; restart failed: <reason>` |

A failure that the caller of an operation receives, and that the caller shows through the error display, is recorded by that display: a request of the endpoint answers its failure to its client, a `sok` command ends with its status and its message on the standard error, and a plugin shows the failed navigation of its document region, which the host reports as the `failure` of the document, with `tab.error` ([plugins](plugins.md)), whose display writes `error page tab error <tab id>: <text>`.

## Reading

The application log answers what failed and where, the performance trace answers when and in what order, and the state file answers what the application held at one time. A report of a defect names the files of `logs/` and the time of the defect.
