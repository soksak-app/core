# Page-wire cases

[한국어](README.ko.md)

A page-wire case records one exchange of calls between the workbench page and its host: each call that the page sends through the `host` transport of `@soksak/runtime` (`host.call(name, payload, options)`), and the reply that the host gives to it. The workbench page reads the transport in [host.js](../../../../packages/workbench/host.js) and in [log-policy.js](../../../../packages/workbench/log-policy.js); the application runtimes implement it (for example [apps/wailsv3/runtime/index.js](../../../../apps/wailsv3/runtime/index.js), `host.call`).

A case is one tracked JSON file in this directory. The consumer is the workbench page: its tests answer the calls of the page with the replies of a case, and the producer is the host package, which runs the same case against the real host and checks that each reply is the one the case records. The [test kinds](../../../operations/examples.md#test-kinds) rule requires this for a wire consumer.

## File

- The file name is `<name>.json`, and the `name` member equals the file name without `.json`.
- One area per file name prefix: `log-`, `workspace-`.

## Members

| Member | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The name of the case, equal to the file name. |
| `description` | yes | One sentence on what the call does and what the reply is, in English. |
| `replay` | yes | `true` when the producer runs the case against the real host. `false` needs `reason`. |
| `reason` | when `replay` is `false` | Why the producer does not run the case. |
| `variables` | no | The values that the host chooses. Each variable is `"<name>": {"type": "...", "example": ...}`. |
| `writer` | no | The state of the event writer of the host that the case runs against. `policy` is `true` when the writer has a policy file (`log-policy.json` of the configuration directory). Without the member, the writer has no policy file. |
| `steps` | yes | The ordered exchanges. An empty array means that the page sends no call. |

A variable name has the form of lower-case letters, digits and hyphens. A reply value that is the string `$<name>` stands for the value that the host chooses for that variable; the reader substitutes the `example` value, and the producer accepts any value of the declared `type`. A variable is used only in reply values: the page sends the values it chooses, so a call step has no variables.

## Steps

A step is one of two objects.

- `{"call": {"name": ..., "payload": ..., "cids": [...]}}`: the page calls the host method `name`. `payload` is the single argument of the call, and it is absent when the page sends no argument. `cids` lists the correlation identifiers that the page passes with the call, and it is absent when the page passes none.
- `{"reply": {"result": ...}}` or `{"reply": {"error": "..."}}`: the answer of the host to the call before it. `result` is the JSON value that the call resolves with (`null` when the host answers nothing). `error` is the text of the error that the call rejects with.

A call step is followed by its reply step, and a case ends with a reply step. Calls are compared with the page's calls exactly, field by field, after JSON encoding, so an absent field and a `null` are different values.

## Reader semantics

The workbench test runtime (`packages/workbench/test/runtime/page-wire.js`, selected by `selectPageWire` in `packages/workbench/test/runtime/index.js`) answers the calls of the page in the order of the steps:

- A call that is not the next call of the case rejects, and the difference is kept as a failure.
- A call after the last step of the case rejects, and is kept as a failure.
- The `calls` list of the reader holds every call of the page, so a test can compare it with the calls it expects.
- `finish()` throws when a failure was kept or when a step of the case was not played. A test calls it at the end of its body.
- A case has no notices. The listeners that the page registers with `on` are never called.

## Producer runs

Each package that hosts a page-wire producer runs the cases with `replay: true` against its real host. A reply that the real host gives differently from the case is a defect of the host or of the case. The producer runner of the host is `packages/host/go/tests/page_wire_test.go` (`TestPageWire`), which runs each case with `replay: true` through the recording entry of the bindings (`host.RecordedCall`) and the operation of the host method of each call (`host.LogCommand` for `log`, `host.Workspace.Apply` for `workspace`). The replies of the cases in this directory are the values that the host source returns for the request: the call `log` in `packages/host/go/src/event_relay.go` (`LogCommand`, `Log`) and `packages/host/go/src/log_policy.go` (`setLogPolicy`), and the call `workspace` in `packages/host/go/src/workspace.go` (`snapshot`, `Apply`, `runWorkspace`).

## Limits

- Notices are not recorded. The host notifies each window of a workspace change (`workspace-changed`) after a `workspace` call that writes, and the cases of this directory do not record that notice. A case with a notice needs a format extension that is not defined yet.
- A case states the state that the host reads, not how that state is built. A reply that depends on a project in the registry (for example a settings change of a project) needs a case that the producer can build that state for; the format does not name it yet.
- Calls whose requests hold instants or generated values are not recorded yet, because a case compares the request exactly.
