# Local endpoint

[한국어](endpoint.ko.md)

The macOS hosts implement this specification; [feature status](../features.md) records its validation. Windows and Linux transports are not implemented.

The native host serves the [exposure](exposure.md) methods to local clients over a JSON-RPC 2.0 endpoint. Every build includes the endpoint because exposure is a product feature.

## Transport

| OS | Transport | Address and access |
| --- | --- | --- |
| macOS | Unix domain socket | Socket `<application>-<pid>.sock` in `soksak/` under the per-user temporary directory (`$TMPDIR`, as returned by Go `os.TempDir` and Rust `std::env::temp_dir`). The host creates the directory with mode 0700 and refuses to listen when the path is not a directory, belongs to another user, or has another mode. The socket has mode 0600 |
| Linux | Unix domain socket | Socket in `$XDG_RUNTIME_DIR/soksak`. The host creates the directory with mode 0700 |
| Windows | Named pipe | `\\.\pipe\soksak-<id>`. The security descriptor allows only the current user |

The socket is not placed in the configuration directory because socket paths are limited to 104 bytes on macOS and 108 bytes on Linux.

Implementation: `src/platform/<os>/endpoint.*` in each [native host](hosts.md).

## Discovery

The host listens first and writes `<config-dir>/endpoint.json` only after its first window is registered. A client that reads the file can therefore send requests for that window at once: `windows.list` lists it, and its host entries answer. Page entries return 1003 until `host.windows` reports the window as `ready`, so a client waits for that status notification. A host that cannot register its first window does not write the file and ends startup with an error.

The host also atomically creates `<config-dir>/process.lock` before listening. Its contents are the owning host PID. A configuration directory has exactly one owning application process; that process may own multiple windows. A second process using the same configuration directory exits with an explicit ownership error before writing or replacing `endpoint.json`. A process using a different configuration directory has independent settings, endpoint, lock, and sidecar state and may run at the same time. Normal shutdown removes the lock. After an unclean termination, the next host may remove the lock only when its recorded PID is no longer running; malformed or live locks are errors.

```json
{
  "transport": "unix",
  "address": "/path/to/socket",
  "pid": 1234,
  "application": "wailsv3",
  "version": "0.0.1",
  "executable": "/path/to/soksak-wailsv3",
  "started": "2026-09-17T09:00:00Z"
}
```

| Field | Value |
| --- | --- |
| `transport` | `unix` or `pipe` |
| `address` | Socket path or pipe name |
| `pid` | Host process id |
| `application` | `wailsv3` or `tauriv2` |
| `version` | Application version |
| `executable` | Absolute path of the host executable with symbolic links resolved |
| `started` | Start time in ISO 8601 |

The host removes the file and its socket on exit, including an exit requested by a termination signal (SIGTERM, SIGINT, SIGHUP), which runs the same quit as `host.quit`. A process that ends without that exit, such as one killed with SIGKILL, leaves its socket; the next host of the same application removes sockets named `<application>-<pid>.sock` whose process is no longer running before it listens. A client reads the file to connect. When the process with `pid` is not running, the client reports an error and does not connect.

## Framing

Each message is a 4-byte big-endian unsigned length followed by that many bytes of one UTF-8 JSON-RPC 2.0 object. The maximum length is 16 MiB.

A connection stays open for many requests. Requests are multiplexed by `id`, and replies can arrive in any order. Server notifications have no `id`.

Requests that change the subscriptions of a connection (`status.watch`, `status.unwatch`, `diagnostics.transcript`) are applied in the order the host receives them, including the messages the host forwards to the page for them. A client that ends one subscription and starts the same one again sends the two requests in that order.

## Closing

The host closes the connection when it receives any of the following:

- a length prefix larger than the maximum;
- a body that is not valid JSON;
- a JSON value that is not a JSON-RPC 2.0 object;
- an undeclared method.

An HTTP request line is read as a length prefix larger than the maximum or as invalid JSON, so the host closes the connection before any method runs.

## Startup

The host creates the endpoint before it shows windows. If the host cannot create the endpoint, the application exits with an error.

Registered WebView pointer receipt completion requires pending mouse processing to drain before sending and after receipt. Registration rejects an unavailable drain API. Capability loss before sending rejects delivery without sending the event; loss after receipt must fail completion and report the unavailable API. A wait that ends by timeout or unregistration before the pre-send drain finishes completes once and cancels that drain, so the event is not sent afterwards. Native non-WebView targets and deliberately unregistered WebViews retain their declared delivery-only contract.

## Diagnostic builds

The following methods exist only in diagnostic builds (Go build tag `diagnostics`, cargo feature `diagnostics`). Other builds reject them as undeclared methods. `make wailsv3-build` and `make tauriv2-build` produce diagnostic builds; the release targets do not.

| Method | Params | Purpose |
| --- | --- | --- |
| `diagnostics.fixture` | `{window, settings?}` | Creates `<config-dir>/test-project` with empty folder settings, removes other projects, resets common settings, applies the `settings` object over the defaults, opens the project in the window, and returns `{root}`; `settings` that is not an object is rejected |
| `diagnostics.drag` | `{window, axis, line, dx, dy, ms, times, capture?}` | Drags boundary `line` on `axis` by `dx, dy` over `ms` and back, `times` round trips, with host-timed steps. Returns the page's drag result `{from, steps, took, asked, late, deepest}` after the gesture has been presented. The page result also carries `boundary`, the boundary position before the drag and after each step, and `handled`, the milliseconds the page spent applying each step. With `capture: true` the host also records the window and adds `frames`, the frame directory, `ticks`, the time of each step, and `layouts`, one `{ticket, begun, presented, committed}` per native layout transaction with the time it began, the time the app DOM confirmed its presentation, and the commit time (`null` for a stage that did not occur); all times are milliseconds on the clock of the recorded frames. If the drag fails, the host stops the capture and removes the directory |
| `diagnostics.capture.start` | `{window}` | Starts recording the window at device-pixel resolution matching its backing scale once its first frame has arrived and the stream start has completed (a stop before that completion is rejected by the system), starts layout tracing, and returns `{frames}`, the frame directory When the window's device-pixel size changes during the recording, the recorder changes the stream output size to it; frames delivered before the stream applies the new size are recorded with their content scale in the header, and a stop waits for a frame at the new size |
| `diagnostics.capture.stop` | `{window, after?}` | Stops a capture once the stream has delivered the screen displayed at or after `after` (a `displayed` time from `host.window.presented`) or the request, whichever is later, and returns `{frames, count, limited, longestGap, layouts}`. `limited` is true when the recorder reached its frame cap; that is a normal bounded result, not a capture error. `longestGap` is the longest display interval in milliseconds between consecutive recorded frames. A state the application committed can reach the screen after the request, so a recording that must end with that state passes its display time |
| `diagnostics.modal.hold` | `{window, on}` | With `on`, holds the host's answers to the window's modal content requests; without, sends the held answers and stops holding |
| `diagnostics.modal.held` | `{window}` | Answers when the window holds a modal content answer or stops holding; fails when the window does not hold answers |
| `diagnostics.transcript` | `{window, on}` | Starts or stops `diagnostics.log` notifications `{window, line}` for host requests, replies, and page verification lines |
| `diagnostics.notifications` | `{}` | Returns the notifications of this application that the operating system's notification center still shows, as `[{identifier, title, body}]`; `identifier` is the JSON text of `[window, surface]` |
| `diagnostics.capture.still` | `{window}` | Writes a still PNG of the window at device-pixel resolution without focusing it and returns `{path}` inside a private `<config-dir>/captures/still-*` directory. It is observation material for development, not measurement; measurements use `diagnostics.capture.start`/`stop` frames. The requester removes the directory after viewing |
| `diagnostics.navigation.delay` | `{window, ms}` | Delays the host's handling of each later navigation callback of the window's main webview by `ms` milliseconds (integer 0–10000; 0 removes the delay) and returns `null`. Window checks use it to deliver a navigation callback after the replacement page has started |
| `diagnostics.input.source` | `{window, select?}` | With `select`, selects that enabled keyboard input source; returns `{current}`, the selected source identifier. A platform without keyboard input sources returns an error. Activation-tier window checks use it to reproduce a user's input-source sequence |

For direct capture.start/stop recordings, layouts is an array of `{ticket, begun, presented, committed}` transactions since start, with times in milliseconds on the frame clock. Stages that did not occur are null; no transactions means an empty array. diagnostics.drag retains its own timeline in its existing reply. Trace-stop failures remove the frame directory that the requester cannot receive and preserve errors.

Recording callbacks never wait for pending disk writes. Exhausting the 64-frame pending-write capacity rejects the recording with an explicit error; it is not a successful partial capture. Stop preserves recording errors and appends any stop error. The 600-frame burst cap remains a reported bounded result. A frame without a status, and a complete frame without an image, display time, content rectangle, content scale, or scale factor, rejects the recording with an error that names the frame number and the missing field; idle frames carry no image and are counted.

Recording frame files `frame-NNNN.bgra` carry a frame number that continues across the recordings of one process and has at least four digits, so readers order frames by the number, not by the file name text. They use one lossless LZ4 block format. The little-endian header contains three uint32 values (width, height, BGRA row stride), seven float64 values (content x/y/width/height, content scale, backing scale, display time in milliseconds), the four ASCII bytes `LZ4B`, a uint32 compressed-block byte count and a uint32 CRC-32 of every decoded pixel byte. The header is 80 bytes; exactly the declared compressed bytes follow it. The LZ4 block restores exactly stride × height bytes, including row padding, without downsampling or color conversion. Reject wrong markers, incomplete or extra bytes, invalid blocks, decoded-size mismatches and checksum errors; do not interpret old raw files as this format. Compression failure fails the recording explicitly.


Layout timeline replies have a capacity of 4096 transactions. When the actual record count exceeds capacity, the host returns an error and removes the recording directory that the requester cannot receive. A truncated timeline is never a successful reply.

The host writes large data, such as captures, to files under the configuration directory, and the reply contains the file paths. The requester removes the capture files after measurement.

`diagnostics.drag` drives the page's existing surface-input route with host-timed steps. Its native recording measures composition during that gesture; it does not establish OS mouse-button delivery. A composition check must also measure actual card movement and every requested round trip. Native pointer delivery is a separate `input.pointer` check.

## Clients

| Package | Role |
| --- | --- |
| `packages/client` | Library that reads `endpoint.json`, connects, and sends requests |
| `packages/cli` | `soksak` command with the subcommands `windows`, `list`, `status` (`--watch` prints each change), `run`, `dom`, `input`, and `capture` (diagnostic builds; a still window image for observation). Every subcommand requires `--config-dir` |
| `packages/mcp` | stdio MCP server. It generates its tools from `exposure.list` and opens no network port |

Window checks use `packages/client`.

## Checks

Each platform runs these checks against the endpoint:

- an HTTP request line closes the connection, and no method runs;
- a different user cannot connect;
- an undeclared method closes the connection;
- the host removes `endpoint.json` on normal exit;
- a termination signal requests the normal exit once, and the next one ends the process;
- sockets of ended processes of the same application are removed before listening.
- a second process using the same configuration directory is refused, and normal close removes `process.lock`.
