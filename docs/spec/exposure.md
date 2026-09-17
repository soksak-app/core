# Exposure: status, command, dom

[한국어](exposure.ko.md)

This specification is not implemented yet; [feature status](../features.md) tracks its implementation.

Core (the workbench and the native host) publishes declared status values, commands, and DOM elements to external clients through the [local endpoint](endpoint.md). No method executes arbitrary code.

## Declarations

A plugin declares its entries in `plugin.json` under `exposes` ([plugins](plugins.md)). Core declares its entries in `packages/workbench/exposure.json` with the same format.

```json
{
  "exposes": {
    "status": [],
    "commands": [],
    "dom": []
  }
}
```

Registration of an undeclared name fails. A request for a declared name that has no registration returns an error.

### Names

A name has the form `<owner>.<name>`. `owner` is `core`, `host`, or a plugin id. Names use lowercase letters, digits, dots, and hyphens.

### Entry fields

| Kind | Field | Meaning |
| --- | --- | --- |
| status | `name` | Entry name |
| status | `description` | One-sentence description |
| status | `schema` | Value schema |
| command | `name` | Entry name |
| command | `description` | One-sentence description |
| command | `params` | Parameter schema |
| command | `result` | Result schema |
| dom | `name` | Entry name |
| dom | `description` | One-sentence description |
| dom | `many` | Optional. `true` when several elements share the name; requests address one element with `index` |

A schema is a JSON Schema subset with the keywords `type`, `properties`, `items`, and `enum`.

The element for a dom entry carries the attribute `data-expose="<name>"`. Without `many`, exactly one element has the name.

## Registration

The workbench registers core entries in the registry of the main page. A plugin surface page registers its entries through `@soksak/plugin-api/page`.

| Function | Registers |
| --- | --- |
| `expose.status(name, read, subscribe)` | `read()` returns the current value; `subscribe(fn)` calls `fn(value)` on each change |
| `expose.command(name, run)` | `run(params)` returns the result or a promise of it |
| `expose.dom(name, element)` | The element for a dom entry |

The native host relays registrations and requests between a surface page and the registry of the main page in the same way that it relays [sidecar](sidecars.md) messages. When a surface page closes, the registry removes its registrations.

## Methods

Clients call these JSON-RPC 2.0 methods.

| Method | Params | Result |
| --- | --- | --- |
| `exposure.list` | none | Declared entries of core and loaded plugins |
| `status.get` | `{name}` | Current value |
| `status.watch` | `{name}` | `null`; the host then sends `status.changed` notifications `{name, value}` until `status.unwatch` |
| `status.unwatch` | `{name}` | `null` |
| `command.run` | `{name, params}` | Command result |
| `dom.rect` | `{name, index?}` | `{x, y, width, height, window}`: CSS pixels in the owning document, and the document position in window coordinates |
| `dom.act` | `{name, index?, action, value?, event?}` | `null`. `action` is `click`, `input`, or `dispatch`. The page receives synthetic DOM events with `isTrusted` false |
| `input.pointer` | `{window, x, y, phase, button?, scroll?}` | `null`. `phase` is `move`, `down`, `drag`, or `up` |
| `input.key` | `{window, key, text?, modifiers?, phase}` | `null`. `phase` is `down` or `up` |
| `host.status` | `{window}` | Window button frames, native view frames, backing scale, and presentation state |

The host delivers `input.pointer` and `input.key` as native events. On macOS it sends them through `-[NSWindow sendEvent:]`; the page receives trusted events, and the application is not activated.

Tests that check a real input path use `input.pointer` and `input.key` only. Tests use `dom.act` only to set up state.

## Errors

| Code | Meaning |
| --- | --- |
| -32601 | Undeclared method |
| -32602 | Invalid params |
| 1001 | Unknown name |
| 1002 | Name is declared but not registered |
| 1003 | Owner document no longer exists |
| 1004 | Native input is not available on this platform |

The [local endpoint](endpoint.md) closes the connection after an undeclared method.
