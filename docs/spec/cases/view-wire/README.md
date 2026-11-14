# View-wire cases

[한국어](README.ko.md)

A view-wire case records one exchange between a view page and its host: each call that the view sends through the `sok-view` handler (`window.webkit.messageHandlers["sok-view"].postMessage({sok: 1, id, command, params, cids})`, built by [view.js](../../../../packages/plugin-api/view.js)), the reply that the host gives to it, each notice that the host posts to the view (`{sok: 1, event, data}`), and each request that the host posts to the view (`{sok: 1, id, command, params}`). The [native surfaces](../../native-surfaces.md#view-surfaces) specification defines the channel, and `docs/spec/host-contract.md` lists its behavior.

The form is the form of the [page-wire cases](../page-wire/README.md): one tracked JSON file per case, the members `name`, `description`, `replay`, `reason` and `variables`, the steps `call`, `reply` and `notice`, the held reply, the streams, the variables and their substitution follow that file. This file lists only what a view wire adds or changes.

The consumer is the test of a view page: `openView(name, options)` of [testing.js](../../../../packages/plugin-api/testing.js) opens the real view bridge and the real exposure over a jsdom window and answers each call of the view with the reply of a case. The producer is the host package, which runs the cases that its view handler answers by itself.

## File

- The file name is `<name>.json`, and the `name` member equals the file name without `.json`.
- The prefix of a file name is `log-` for the calls that the host answers by itself, and the name of the test file that plays the case, without `.test.mjs`, for the others.

## Members

| Member | Required | Meaning |
| --- | --- | --- |
| `name`, `description`, `replay`, `reason`, `variables` | as for page-wire | The members of a page-wire case. |
| `plugin` | yes | The id of the plugin of the view. The reader opens the page on `soksak://<plugin>/`. |
| `steps` | yes | The ordered exchanges. |

A page-wire case has the member `writer` for the state of the event writer of the host. A view-wire case has no such member: the producer starts the writer of the host without a policy file.

## Steps

A step is one of four objects.

- `{"call": {"command": ..., "params": ..., "cids": [...]}}`: the view calls `command`. `params` is the single argument of the call, and it is absent when the view sends none (a call of the view bridge without an argument sends `null`, which a case records as `null`). `cids` lists the correlation identifiers that the call carries, and it is absent when the call carries none. A call holds no host variable.
- `{"reply": {"result": ...}}`, `{"reply": {"error": "..."}}` or the same with `"held": true`: the answer of the host to the call before it, as for page-wire. The error is the message of the reply `{sok: 1, id, error: {code, message}}`; the code is -32000, which the workbench and the log handler of the host use for every failure.
- `{"notice": {"event": ..., "data": ...}}`: the host posts the event `event` with `data` to the view (`{sok: 1, event, data}`); `data` is absent when the event carries none. The exposure requests of the host are notices of the event `exposure-request` with `data` `{id, method, params}`.
- `{"request": {"id": ..., "command": ..., "params": ...}}`: the host posts a request of the command `command` of the view with the identifier `id` (`{sok: 1, id, command, params}`). The reply of the view is not a step: it is a message that the view sends and the test judges.

A case has no `listen` step: a view registers its listeners in the page, not through a call that the host answers.

An identifier that the host chooses (`id` of a request, `data.id` of an exposure request) is a number that the case writes: the host numbers its requests from 1001 and counts one for each request, in the order of the steps. A call of the view that answers an exposure request (`runtime.native.call` with `name` `exposureReply`) carries that number in its payload.

## Reader semantics

`openView` in `packages/plugin-api/testing.js` answers the calls of the view in the order of the steps:

- The calls of the command `runtime.log` form one stream (the page writes them at instants that no other call determines), and every other call forms the other stream; a call that deviates from the next call of its stream, or that comes after the last step of its stream, is answered with an error and kept as a failure.
- The reply is delivered after the call returned to its caller, as a host on the other side of the handler does.
- `calls` lists every call of the view as `{command, params}`, with `cids` when the call carries them.
- `deliverNotice(event, data)` plays the next step, which must be a notice of `event`; when `data` is given, the notice must carry that data (compared as JSON values). `run(command, params)` plays the next step, which must be a request of `command` with `params`, and returns the result of the reply of the view. `status(name)`, `command(name, params)` and `exposed(method, params)` play the next step, which must be the exposure request of that method.
- `release(key)` settles the oldest held reply, or the held reply that `key` names: a number is the index of its call step, a string is the name of its command ([page-wire](../page-wire/README.md#reader-semantics)).
- With the environment variable `VIEW_WIRE_TRACE=1`, the reader writes each call that the view sends to the standard error, matched or not.
- `close()` ends the view as a page ends and then throws when a failure was kept, when a step of the case was not played (of either stream) or when a held reply was not released.

## Producer runs

The reader shares the check of a case, the matching of the calls and the held entries with the page-wire reader (`@soksak/plugin-api/wire-case`).

The producer of the view wire is `packages/host/go/src/view_wire_test.go` (`TestViewWire`, diagnostics build) and `packages/host/rust/tests/view_wire_test.rs`. It runs each case with `replay: true` through the view handler of the host: the call goes through `answerViewLog` of a view with a ready document, and the reply is compared with the reply of the case. The host answers only the calls of the command `runtime.log` by itself (`viewLogCommand` in `packages/host/go/src/event_relay.go`: the clock request answers the clocks of the host, a batch of the page records answers `null`, and a refused batch answers the error that names the record). It forwards every other call to the page of the workbench as the event `view-call`, and the page answers it with `viewReply` (`answerViewCall` in `packages/workbench/view-calls.js`). Only a running application answers those calls, so a case that holds one has `replay: false` and its reason. The Rust producer runs the request through `view_log_command` of `packages/host/rust/src/event_relay.rs`, the function that the view handler of the Tauri host calls (`view_log_message` in `packages/host/rust/src/documents.rs`), with the plugin, surface, document and time origin of the ready view, and it compares the message of an error; the code -32000 of the reply is the constant of `view_log_reply_message`, which the unit tests of the host judge. The `log-` cases of this directory hold only `runtime.log` calls, and the plugin `probe`, which the ready view of the producer belongs to.

The replies of the other cases are the values that the page of the workbench returns for the call: `tab.state.read`, `tab.state.write`, `runtime.native.on`, `runtime.native.call`, `runtime.command.register`, `runtime.sidecar.send`, `runtime.textSize.read`, `runtime.textSize.on`, `composition.declaration`, `composition.place`, `document.attach`, `image.attach` and the others return what `run` of `packages/workbench/view-calls.js` and the operations that it calls return, and `core.file.open` returns what `core.file.open` of `packages/workbench/core-exposure.js` and `checkOpenPath` of `packages/workbench/file-open.js` return.

## Limits

- A case holds the calls of one view. A test that opens several views plays one case for each view.
- A case does not state how the page of the workbench builds a reply: the value of the reply, for example the composition of the manifest of the plugin, is data of the case.
