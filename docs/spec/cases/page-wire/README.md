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

A step is one of three objects.

- `{"call": {"name": ..., "payload": ..., "cids": [...]}}`: the page calls the host method `name`. `payload` is the single argument of the call, and it is absent when the page sends no argument. `cids` lists the correlation identifiers that the page passes with the call, and it is absent when the page passes none.
- `{"reply": {"result": ...}}` or `{"reply": {"error": "..."}}`: the answer of the host to the call before it. `result` is the JSON value that the call resolves with (`null` when the host answers nothing). `error` is the text of the error that the call rejects with. `"held": true` makes the reader hold the reply until the test releases it, so a test can let the page act while a call is outstanding; the producer compares the reply as any other.
- `{"notice": {"event": ..., "payload": ...}}`: the host sends the notice `event` with the single argument `payload` to the listeners that the page registered for `event`; `payload` is absent when the notice has no argument.

A call step is followed by its reply step, and a notice stands between those pairs. Calls are compared with the page's calls exactly, field by field, after JSON encoding, so an absent field and a `null` are different values.

## Reader semantics

The workbench test runtime (`packages/workbench/test/runtime/page-wire.js`, selected by `selectPageWire` in `packages/workbench/test/runtime/index.js`) answers the calls of the page in the order of the steps:

- A call that is not the next call of the case rejects, and the difference is kept as a failure.
- A call after the last step of the case rejects, and is kept as a failure.
- The `calls` list of the reader holds every call of the page, so a test can compare it with the calls it expects.
- `release()` settles the oldest held reply.
- `deliverNotice()` plays the next step, which must be a notice, and calls each listener that the page registered for its event; a notice without a listener is a failure. The test delivers a notice at the point where the host would send it.
- With the environment variable `PAGE_WIRE_TRACE=1`, the reader writes each call that the page sends to the standard error, matched or not, so the author of a case reads the order of the calls of the page.
- `finish()` throws when a failure was kept, when a step of the case was not played or when a held reply was not released. A test calls it at the end of its body.

## Producer runs

Each package that hosts a page-wire producer runs the cases with `replay: true` against its real host. The Go producer runs the host without a window, and a notice reaches only the listeners of a window, so it refuses a case with `replay: true` that holds a notice; such a case has `replay: false` and its reason until a producer with windows runs it. A reply that the real host gives differently from the case is a defect of the host or of the case. The producer runner of the host is `packages/host/go/tests/page_wire_test.go` (`TestPageWire`), which runs each case with `replay: true` through the recording entry of the bindings (`host.RecordedCall`) and the operation of the host method of each call (`host.LogCommand` for `log`, `host.Workspace.Apply` for `workspace`). The replies of the cases in this directory are the values that the host source returns for the request: the call `log` in `packages/host/go/src/event_relay.go` (`LogCommand`, `Log`) and `packages/host/go/src/log_policy.go` (`setLogPolicy`), and the call `workspace` in `packages/host/go/src/workspace.go` (`snapshot`, `Apply`, `runWorkspace`).

## Limits

- A case states the state that the host reads, not how that state is built. A reply that depends on a project in the registry (for example a settings change of a project) needs a case that the producer can build that state for; the format does not name it yet.
