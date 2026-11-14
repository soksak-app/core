# Page-wire cases

[한국어](README.ko.md)

A page-wire case records one exchange between the workbench page and its host: each call that the page sends through the `host` transport of `@soksak/runtime` (`host.call(name, payload, options)`), the reply that the host gives to it, and each notice that the host sends to the listeners that the page registered with `host.on(event, listener)`. The workbench page reads the transport in [host.js](../../../../packages/workbench/host.js) and in [log-policy.js](../../../../packages/workbench/log-policy.js); the application runtimes implement it (for example [apps/wailsv3/runtime/index.js](../../../../apps/wailsv3/runtime/index.js), `host.call`).

A case is one tracked JSON file in this directory. The consumer is the workbench page: its tests answer the calls of the page with the replies of a case, and the producer is the host package, which runs the same case against the real host and checks that each reply is the one the case records. The [test kinds](../../../operations/examples.md#test-kinds) rule requires this for a wire consumer.

## File

- The file name is `<name>.json`, and the `name` member equals the file name without `.json`.
- The prefix of a file name is the area of the calls (`log-`, `overlay-`, `workspace-`) or the name of the test file that plays the case, without `.test.mjs` (for example `exposure-trace-` for the trace tests of `exposure.test.mjs`).

## Members

| Member | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The name of the case, equal to the file name. |
| `description` | yes | One sentence on what the call does and what the reply is, in English. |
| `replay` | yes | `true` when the producer runs the case against the real host. `false` needs `reason`. |
| `reason` | when `replay` is `false` | Why the producer does not run the case. |
| `variables` | no | The values that the host or the page chooses. Each variable is `"<name>": {"type": ..., "example": ..., "source": ...}`. |
| `writer` | no | The state of the event writer of the host that the case runs against. `policy` is `true` when the writer has a policy file (`log-policy.json` of the configuration directory). Without the member, the writer has no policy file. |
| `steps` | yes | The ordered exchanges. An empty array means that the page sends no call. |

A variable name has the form of lower-case letters, digits and hyphens. `type` is one of `string`, `number`, `integer`, `boolean`, `object`, `array` and `null`, or a list of them, and `example` is a value of that type. `source` is `host` (the default) or `page`.

- A host variable stands for a value that the host chooses, in a reply or a notice: the string `$<name>` there is that value. The reader substitutes the `example` value, and the producer accepts any value of the declared `type`.
- A page variable stands for a value that the page chooses and cannot repeat from one run to the next, such as an instant of `performance.now()` or a generated identifier, in a call. The reader accepts any value of the declared `type` at that place; the first value binds the variable, each later use in a call must equal it, and a later use in a reply or a notice is that value. The producer sends the `example` value in the call.
- A call holds no host variable.

## Steps

A step is one of four objects.

- `{"call": {"name": ..., "payload": ..., "cids": [...]}}`: the page calls the host method `name`. `payload` is the single argument of the call, and it is absent when the page sends no argument. `cids` lists the correlation identifiers that the page passes with the call, and it is absent when the page passes none.
- `{"reply": {"result": ...}}` or `{"reply": {"error": "..."}}`: the answer of the host to the call before it. `result` is the JSON value that the call resolves with (`null` when the host answers nothing). `error` is the text of the error that the call rejects with: the host answers a failed call with text, and the runtime of each application rejects with an `Error` that holds it (the `RuntimeError` of the Wails runtime, `hostInvoke` of the Tauri runtime with an `Error` around the value of the command), so a page never receives a rejection that is not an `Error`, and a structured error object with a code and data is not a value of the wire. `"held": true` makes the reader hold the reply until the test releases it, so a test can let the page act while a call is outstanding; the producer compares the reply as any other.
- `{"notice": {"event": ..., "payload": ...}}`: the host sends the notice `event` with the single argument `payload` to the listeners that the page registered for `event`; `payload` is absent when the notice has no argument.
- `{"listen": {"event": ...}}` or `{"listen": {"event": ..., "error": "...", "held": true}}`: the page registers a listener for `event` with `host.on(event, listener)`. Without `error`, the registration resolves with its unsubscribe function. With `error`, the registration rejects with that text, and the listener is not registered. `"held": true` makes the reader hold the settlement of the registration until the test releases it, as for a reply. `"unsubscribeError": "..."` makes the unsubscribe function of a registration that resolves remove the listener and then throw an error with that text; a registration with `error` has none.

A call step is followed by its reply step, and a notice or a listen step stands between those pairs. Calls are compared with the page's calls exactly, field by field, after JSON encoding, so an absent field and a `null` are different values.

## Reader semantics

The workbench test runtime (`packages/workbench/test/runtime/page-wire.js`, selected by `selectPageWire` in `packages/workbench/test/runtime/index.js`) answers the calls of the page in the order of the steps. The check of the form of a case and the matching of the calls, the variables, the held entries and the end of the case are `@soksak/plugin-api/wire-case`, which the view-wire reader (`openView` of `@soksak/plugin-api/testing`) shares:

- A call that is not the next call of its stream rejects, and the difference is kept as a failure. The calls of the host method `log` form one stream, and every other call, notice and listen step forms the other stream. The page sends `log` calls at instants that no other call determines (the clock anchor and the report of the gated count run on timers), so the reader matches a `log` call with the next unplayed `log` step in the order among the `log` steps, and every other call with the next unplayed step in the order among the other steps; a call of either stream that deviates from its stream fails.
- A call after the last step of its stream rejects, and is kept as a failure.
- The `calls` list of the reader holds every call of the page, so a test can compare it with the calls it expects.
- A case without a listen step does not record the registrations of the page: each `host.on` registers its listener and resolves at once. A case with at least one listen step records every registration of the page, so each `host.on` is answered by the next step, which must be the listen step of its event; a registration that is not the next step rejects, and the difference is kept as a failure, as for a call. A registration after the last step is a failure as well. The producer does not run a case with a listen step, because the registration belongs to a page.
- `release(key)` settles a held reply or held registration. Without `key` it settles the oldest one. A number `key` is the index of the step of the case that holds it (the call step of a reply, the listen step of a registration), and a string `key` is the name of the call or of the event, which settles the oldest held entry of that name, so a test settles held entries in any order. A `key` that no held entry has is a failure that `release` throws and `finish()` reports.
- `unsubscribed` lists the events whose listener the page removed with the function that its registration resolved with, in the order of the removals.
- With the environment variable `PAGE_WIRE_TRACE=1`, the reader writes each call that the page sends to the standard error, matched or not, so the author of a case reads the order of the calls of the page.
- `deliverNotice()` plays the next step, which must be a notice, and calls each listener that the page registered for its event; a notice without a listener is a failure. The test delivers a notice at the point where the host would send it.
- `finish()` throws when a failure was kept, when a step of the case was not played (of either stream) or when a held reply was not released. A test calls it at the end of its body.

## Producer runs

Each package that hosts a page-wire producer runs the cases with `replay: true` against its real host. The Go producer runs the host without a window, and a notice reaches only the listeners of a window, so it refuses a case with `replay: true` that holds a notice or a listen step; such a case has `replay: false` and its reason until a producer with windows runs it. A reply that the real host gives differently from the case is a defect of the host or of the case. The producers run the steps in the order of the case and do not distinguish the two streams: the reply of a `log` call depends only on the state of the event writer and the reply of a `workspace` call only on the storage, so the order between the two streams does not change any reply that a producer compares. The producer runner of the host is `packages/host/go/tests/page_wire_test.go` (`TestPageWire`), which runs each case with `replay: true` through the recording entry of the bindings (`host.RecordedCall`) and the operation of the host method of each call (`host.LogCommand` for `log`, `host.Workspace.Apply` for `workspace`). The replies of the cases in this directory are the values that the host source returns for the request: the call `log` in `packages/host/go/src/event_relay.go` (`LogCommand`, `Log`) and `packages/host/go/src/log_policy.go` (`setLogPolicy`), and the call `workspace` in `packages/host/go/src/workspace.go` (`snapshot`, `Apply`, `runWorkspace`). The Rust producer runner is `packages/host/rust/tests/page_wire_test.rs`, which shares the comparison and the example values with the view-wire runner (`packages/host/rust/tests/support/wire_replay.rs`), reads the cases with the same rules and runs `log` through `event_relay::log_command` and `workspace` through `Workspace::apply`; its replies are those of `packages/host/rust/src/event_relay.rs` and `packages/host/rust/src/workspace.rs`.

## Limits

- A case states the state that the host reads, not how that state is built. A reply that depends on a project in the registry (for example a settings change of a project) needs a case that the producer can build that state for; the format does not name it yet.
