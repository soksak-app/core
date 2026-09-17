# Local endpoint

[한국어](endpoint.ko.md)

This specification is not implemented yet; [feature status](../features.md) tracks its implementation.

The native host serves the [exposure](exposure.md) methods to local clients over a JSON-RPC 2.0 endpoint. Every build includes the endpoint because exposure is a product feature.

## Transport

| OS | Transport | Address and access |
| --- | --- | --- |
| macOS | Unix domain socket | Socket in `soksak/` under the per-user temporary directory (`confstr(_CS_DARWIN_USER_TEMP_DIR)` or `TMPDIR`). The host creates the directory with mode 0700 |
| Linux | Unix domain socket | Socket in `$XDG_RUNTIME_DIR/soksak`. The host creates the directory with mode 0700 |
| Windows | Named pipe | `\\.\pipe\soksak-<id>`. The security descriptor allows only the current user |

The socket is not placed in the configuration directory because socket paths are limited to 104 bytes on macOS and 108 bytes on Linux.

Implementation: `src/platform/<os>/endpoint.*` in each [native host](hosts.md).

## Discovery

When the endpoint is ready, the host writes `<config-dir>/endpoint.json`.

```json
{
  "transport": "unix",
  "address": "/path/to/socket",
  "pid": 1234,
  "application": "wailsv3",
  "version": "0.0.1",
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
| `started` | Start time in ISO 8601 |

The host removes the file on exit. A client reads the file to connect. When the process with `pid` is not running, the client reports an error and does not connect.

## Framing

Each message is a 4-byte big-endian unsigned length followed by that many bytes of one UTF-8 JSON-RPC 2.0 object. The maximum length is 16 MiB.

A connection stays open for many requests. Requests are multiplexed by `id`. Server notifications have no `id`.

## Closing

The host closes the connection when it receives any of the following:

- a length prefix larger than the maximum;
- a body that is not valid JSON;
- a JSON value that is not a JSON-RPC 2.0 object;
- an undeclared method.

An HTTP request line is read as a length prefix larger than the maximum or as invalid JSON, so the host closes the connection before any method runs.

## Startup

The host creates the endpoint before it shows windows. If the host cannot create the endpoint, the application exits with an error.

## Diagnostic builds

The following methods exist only in diagnostic builds (Go build tag `diagnostics`, cargo feature `diagnostics`). Other builds reject them as undeclared methods. `make wailsv3-build` and `make tauriv2-build` produce diagnostic builds; the release targets do not.

| Method | Params | Purpose |
| --- | --- | --- |
| `diagnostics.fixture` | `{window}` | Creates `<config-dir>/test-project` with empty folder settings, removes other projects, resets common settings, opens the project in the window, and returns `{root}` |
| `diagnostics.drag` | `{window, axis, line, dx, dy, ms, times, capture?}` | Drags boundary `line` on `axis` by `dx, dy` over `ms` and back, `times` round trips, with host-timed steps. With `capture: true` the host records the window and returns `{frames: directory}` after the gesture has been presented |
| `diagnostics.capture.stop` | `{window}` | Stops a capture and returns `{frames, count}` |
| `diagnostics.knob` | `{window, name, value}` | Sets a compositor test value (`latency`, `skew`) |
| `diagnostics.transcript` | `{window, on}` | Starts or stops `diagnostics.log` notifications `{window, line}` for host requests, replies, and page verification lines |

The host writes large data, such as captures, to files under the configuration directory, and the reply contains the file paths. The requester removes the capture files after measurement.

## Clients

| Package | Role |
| --- | --- |
| `packages/client` | Library that reads `endpoint.json`, connects, and sends requests |
| `packages/cli` | `soksak` command with the subcommands `status`, `run`, `dom`, `input`, and `watch` |
| `packages/mcp` | stdio MCP server. It generates its tools from `exposure.list` and opens no network port |

Window checks use `packages/client`.

## Checks

Each platform runs these checks against the endpoint:

- an HTTP request line closes the connection, and no method runs;
- a different user cannot connect;
- an undeclared method closes the connection;
- the host removes `endpoint.json` on normal exit.
