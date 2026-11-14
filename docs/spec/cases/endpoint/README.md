# Endpoint cases

[한국어](README.ko.md)

An endpoint case records one conversation between a client and the endpoint of the host ([endpoint](../../endpoint.md#checks)): the frames that a client sends, and the replies and notifications that the host sends back. The clients (`packages/client`, `packages/mcp`, the window-check session and `sok`) are the consumers, and the hosts are the producers: the window check `e2e/endpoint-contract.test.mjs` sends each case with `replay: true` to a running application, and the unit tests of the hosts play the cases that the endpoint answers alone.

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
| `variables` | no | The fields whose value the host chooses. Each variable is `"<name>": {"type": ..., "keys": [...], "example": ...}`; `keys` is optional and names the members that an object value has. |
| `steps` | yes | The ordered steps. |

A variable is written `$<name>` in a frame of the host. The first value that the host sends binds the variable, it must have the declared type and keys, and each later use of the variable must equal the first value. The client players (`packages/client/testing/case-player.js`) also accept a variable in a frame of the client, for a value that the host chose in an earlier reply and that the client repeats (a log position): the player replaces it with the value that the test gives or with the example, and a case with such a variable has `replay: false`.

## Steps

A step has exactly one of the members below. A step may also have `connection`, the name of the connection of the client that the step uses; a step without it uses the connection `client`. A connection is opened at its first step, and a `close` step of `client` ends it.

- `send`: the client writes one frame. The member is the JSON-RPC 2.0 request, or `{"raw_hex": "..."}` for the bytes of a frame that the client writes as they are.
- `reply` and `notify`: the next frame that the host sends on the connection equals the member (a response, or a notification without id), field by field; an absent field and a `null` are different values.
- `close`: `"host"` expects the host to close the connection without a frame, `"client"` closes it from the client.
- `page`: a step of the page, described below.
- `log`: a record of the application log. `{"line": "<text>"}` waits until the log holds a record whose text after the time is `<text>` (`info host endpoint: connection closed: peer closed`); `{"absent": "<text>"}` requires that no record holds `<text>`.
- `watching`: `{"window": ..., "name": ..., "value": true|false}` requires that the registry of watches of the endpoint holds a watch of the status without a surface, or not.
- `watched`: the list of the starts and ends of watches of host statuses that reached the host, `"<window> <name> on|off"`, in their order, which the host holds now.

## The page of a case

A case with `"page": "scripted"` runs on an endpoint whose page follows the `page` steps. The words are those of the [page-wire](../page-wire/README.md#steps) cases (`call`, `reply`, `notice`) seen from the other side: the endpoint is the host that sends the call to the page, and the page answers it.

- `{"page": {"call": {"name": ..., "payload": ...}}}`: the endpoint relays the request `name` with the params `payload` to the page, and the step waits until it has. `payload` is absent when the endpoint sends no params. A request that the endpoint relays and the case has no call for, with another name or other params than the next call, is a failure.
- `{"page": {"reply": {"result": ...}}}` or `{"page": {"reply": {"error": {"code": ..., "message": ...}}}}`: the answer of the page to the call before it; the step follows its call at once. `error` has the code and the message of the error, because the endpoint answers the code. `"held": true` keeps the reply until a `release` step, so the endpoint, its connection or its other requests act while the request waits.
- `{"page": {"release": true}}`: answers the oldest held reply.
- `{"page": {"notice": {"event": "status.changed", "payload": {"window": ..., "name": ..., "surface": ..., "value": ...}}}}`: the page announces a status change, which the endpoint sends to the connections that watch the status. `surface` is absent for a change of a watch without a surface.

The request, the reply and the end of the connection run through the relay of the host (`Relay` in `packages/host/go/src/exposure.go`), so the end of the connection of a held request ends it as it does in the host. A case fails when the endpoint sends a call that the case has no step for, when it sends fewer calls than the case has, when a held reply is never released, and when it reads a host status or runs a host command that the case has no step for.

## Producers

- The Go host plays the cases with `replay: true` that the endpoint answers alone and every case with `"page": "scripted"` (`packages/host/go/tests/endpoint_cases_test.go`). A test that judges a value that a case only types reads the value that its variable bound.
- The clients play the frames of the cases by name and ignore the steps `page`, `log`, `watching` and `watched`; the case form check of `packages/client/testing/case-player.js` accepts them only in a case with `"page": "scripted"`.
