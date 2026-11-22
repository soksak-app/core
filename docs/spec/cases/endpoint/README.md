# Endpoint cases

[한국어](README.ko.md)

An endpoint case records one conversation between a client and the endpoint of the host ([endpoint](../../endpoint.md#checks)): the frames that a client sends, and the replies and notifications that the host sends back. The clients (`packages/client`, the window-check session and `sok` with its MCP server `sok mcp`) are the consumers, and the hosts are the producers: the window check `e2e/endpoint-contract.test.mjs` sends each case with `replay: true` to a running application, and the unit tests of the hosts play the cases that the endpoint answers alone.

A case is one tracked JSON file in this directory. The file name is `<name>.json`, and the `name` member equals the file name without `.json`.

## Members

| Member | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The name of the case. |
| `description` | yes | One sentence on what the endpoint does, in English. |
| `replay` | yes | `true` when the window check sends the case to a running application. `false` needs `reason`. |
| `reason` | when `replay` is `false` | Why the window check does not send the case. |
| `page` | no | `"scripted"` when the page of the case is a script of the case. The case needs `replay: false`, because a running application has a page of its own. |
| `windows` | no | The names of the windows that exist when the case runs on a host without windows. Without the member there is none. |
| `ready` | no | The names of the windows of `windows` whose page reports that it is ready, which `windows.list` lists with `ready` true. Without the member every window is listed as loading. |
| `variables` | no | The fields whose value the host chooses. Each variable is `"<name>": {"type": ..., "keys": [...], "example": ...}`; `keys` is optional and names the members that an object value has. |
| `steps` | yes | The ordered steps. |
| `mcp` | no | The client steps of the MCP server `sok mcp` ([the mcp member](#the-mcp-member)). |

A variable is written `$<name>` in a frame of the host. The first value that the host sends binds the variable, it must have the declared type and keys, and each later use of the variable must equal the first value. The client players (`packages/client/testing/case-player.js`) also accept a variable in a frame of the client, for a value that the host chose in an earlier reply and that the client repeats (a log position): the player replaces it with the value that the test gives or with the example, and a case with such a variable has `replay: false`. The players of `sok` (`packages/sok/go/tests/case_player_test.go`, `packages/sok/rust/tests/support/case_player.rs`) also take a raw JSON text for a variable, which the host frame holds as it is, for a value that a case file cannot hold because a case file holds decoded values, such as a string with a lone surrogate escape; such a case has `replay: false`.

## Steps

A step has exactly one of the members below. A step may also have `connection`, the name of the connection of the client that the step uses; a step without it uses the connection `client`. A connection is opened at its first step, and a `close` step of `client` ends it.

- `send`: the client writes one frame. The member is the JSON-RPC 2.0 request, or `{"raw_hex": "..."}` for the bytes of a frame that the client writes as they are.
- `reply` and `notify`: the next frame that the host sends on the connection equals the member (a response, or a notification without id), field by field; an absent field and a `null` are different values.
- `close`: `"host"` expects the host to close the connection without a frame, `"client"` closes it from the client.
- `page`: a step of the page, described below.
- `log`: a record of the application log. `{"line": "<text>"}` waits until the log holds a record whose text after the time is `<text>` (`info host endpoint: connection closed: peer closed`); `{"absent": "<text>"}` requires that no record holds `<text>`.
- `watching`: `{"window": ..., "name": ..., "value": true|false}` requires that the registry of watches of the endpoint holds a watch of the status without a surface, or not.
- `watched`: the list of the starts and ends of watches of host statuses that arrived at the host, `"<window> <name> on|off"`, in their order, which the host holds now.

## The page of a case

A case with `"page": "scripted"` runs on an endpoint whose page follows the `page` steps. The words are those of the [page-wire](../page-wire/README.md#steps) cases (`call`, `reply`, `notice`) seen from the other side: the endpoint is the host that sends the call to the page, and the page answers it.

- `{"page": {"call": {"window": ..., "name": ..., "payload": ...}}}`: the endpoint relays the request `name` with the params `payload` to the page, and the step waits until it has. `payload` is absent when the endpoint sends no params. `window` is optional and names the window whose page receives the request, for a request that the endpoint sends to the pages of several windows. A request that the endpoint relays and the case has no call for, with another name, other params or another window than the next call, is a failure.
- `{"page": {"reply": {"result": ...}}}` or `{"page": {"reply": {"error": {"code": ..., "message": ...}}}}`: the answer of the page to the call before it; the step follows its call at once. `error` has the code and the message of the error, because the endpoint answers the code. `"held": true` keeps the reply until a `release` step, so the endpoint, its connection or its other requests act while the request waits.
- `{"page": {"release": true}}`: answers the oldest held reply.
- `{"page": {"notice": {"event": "status.changed", "payload": {"window": ..., "name": ..., "surface": ..., "value": ...}}}}`: the page announces a status change, which the endpoint sends to the connections that watch the status. `surface` is absent for a change of a watch without a surface.

The request, the reply and the end of the connection run through the relay of the host (`Relay` in `packages/host/go/src/exposure.go`), so the end of the connection of a held request ends it as it does in the host. A case fails when the endpoint sends a call that the case has no step for, when it sends fewer calls than the case has, when a held reply is never released, and when it reads a host status or runs a host command that the case has no step for.

## The mcp member

A case of the MCP server `sok mcp` ([MCP server](../../cli.md#mcp-server)) has the member `mcp`, and the tests of both `sok` implementations (`packages/sok/go/tests/mcp_server_test.go`, `packages/sok/rust/tests/mcp_server_test.rs`) start `sok mcp` over real pipes, play the steps of the case as the endpoint, and run the steps of `mcp` as the MCP client. The server starts with a disposable home and without `CLAUDE_CONFIG_DIR`, so it writes no skill file of the person who runs the test.

| Member | Required | Meaning |
| --- | --- | --- |
| `arguments` | no | The arguments that follow `sok mcp --config-dir <the directory of the case>`, such as `["--window", "main"]`. |
| `environment` | no | The variables of the environment of the server, such as `{"CODEX_THREAD_ID": "thread-1"}`; an empty value sets the variable empty. |
| `endpoint` | no | `"later"` starts the endpoint of the case only at the step `start`, so the server first runs without an application. |
| `steps` | yes | The ordered steps of the client. |

Before the first step the test opens a session of the revision `2025-11-25` with `initialize` and `notifications/initialized`, unless the first step is `client`, which then opens the session itself. Each step has one of these members:

- `tool`: a `tools/call` of the tool with `arguments` (`{}` without the member). `result` states the value of the JSON text of the result, `error` the text of a tool error, and without both the call must not be a tool error. With `as` the step starts the call under that name and does not wait for its answer.
- `await`: waits for the answer of the call that `as` named and checks its `result` or `error`.
- `cancel`: sends `notifications/cancelled` for the call that `as` named; the call must get no answer until the end of the test.
- `received`: waits until the endpoint has received that many requests of the method, counting each `received` step of the method up to this one; with `contains`, the last request of the method that the endpoint received, as the client wrote it, holds that text.
- `stderr`: waits until the server wrote the line to its standard error.
- `start`: starts the endpoint of the case (`endpoint: "later"`).
- `client`: writes the message as it is; with `server`, waits for the answer, the message with the `id` of the client message, and checks that it holds each member that `server` states with the same value.
- `line`: writes the string as one message line as it is, for a message that a JSON value of the case cannot state, such as a lone surrogate escape or the text of a number; with `server`, waits for a new answer with the `id` that `server` states, the `id` null for a line that the server cannot read, and checks it as `client` does.
- `hex`: writes the bytes of the hex text as one message line, for a line that a string of the case cannot hold, such as bytes that are not valid UTF-8; `server` is checked as for `line`.

A string of a step that is `$config`, `$version`, `$instructions` or `$tools` stands for the configuration directory of the case, the core version, and the instructions and the tools of `mcp.json`; `$config` inside a string stands for the directory too, and `$<name>` of a case variable stands for its example or the value that the test gives it.

## Producers

- The Go host plays the cases with `replay: true` that the endpoint answers alone and every case with `"page": "scripted"` (`packages/host/go/tests/endpoint_cases_test.go`). A test that judges a value that a case only types reads the value that its variable bound.
- The clients play the frames of the cases by name and ignore the steps `page`, `log`, `watching` and `watched`; the case form check of `packages/client/testing/case-player.js` accepts them only in a case with `"page": "scripted"`.
