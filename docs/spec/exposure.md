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

## Windows

An application has one or more windows, and each window has its own main page and registry. Every method except `windows.list` takes `window`, the identifier that `windows.list` returns. A request for a window that no longer exists returns error 1003.

## Host entries

The native host declares entries with owner `host` in the same format and serves them itself.

| Kind | Name | Meaning |
| --- | --- | --- |
| status | `host.window` | `{frame, content, scale, key, controls, surfaces, modal}`: window frame, content size, backing scale, key-window state, window button frames, native surface frames with their visibility and layer, and the open native modal |
| command | `host.window.close` | Closes the window through its normal close action |
| command | `host.window.maximize` | Maximizes the window, or restores it with `{on: false}` |
| command | `host.window.resize` | Resizes the content area to `{width, height}` |
| command | `host.window.reload` | Reloads the main page |
| command | `host.window.presented` | Resolves after the main page and visible application documents have presented their current geometry |
| command | `host.hit` | Returns the owner of the point `{x, y}` in window coordinates: `{kind: "page"}`, `{kind: "surface", surface}`, or `{kind: "native", identifier}` |
| command | `host.quit` | Requests normal application termination, including pending saves |

## Methods

Clients call these JSON-RPC 2.0 methods.

| Method | Params | Result |
| --- | --- | --- |
| `windows.list` | none | `[{window, title, project, key}]` |
| `exposure.list` | `{window}` | Declared entries of core, the host, and loaded plugins, each with `registered` |
| `status.get` | `{window, name}` | Current value |
| `status.watch` | `{window, name}` | `null`; the host then sends `status.changed` notifications `{window, name, value}` on each change until `status.unwatch` or until the connection closes |
| `status.unwatch` | `{window, name}` | `null` |
| `command.run` | `{window, name, params}` | Command result |
| `dom.rect` | `{window, name, index?}` | `{x, y, width, height}` in CSS pixels of the owning document, plus `{document}`: the document origin in window coordinates |
| `dom.act` | `{window, name, index?, action, value?, event?}` | `null`. `action` is `click`, `input`, or `dispatch`. The page receives synthetic DOM events with `isTrusted` false |
| `input.pointer` | `{window, x, y, phase, button?, deltaX?, deltaY?}` | `null`. Window coordinates. `phase` is `move`, `down`, `drag`, `up`, or `scroll` |
| `input.key` | `{window, key, text?, modifiers?, phase}` | `null`. `phase` is `down` or `up` |

The host delivers `input.pointer` and `input.key` as native events. On macOS it sends them through `-[NSWindow sendEvent:]`; the page receives trusted events, and the application is not activated.

Tests that check a real input path use `input.pointer` and `input.key` only. Tests use `dom.act` only to set up state.

## Relay

The host and the pages exchange these messages. They are internal to core and not part of the endpoint.

| Direction | Message | Content |
| --- | --- | --- |
| host → main page | event `exposure-request` | `{id, method, params}` for `exposure.list`, `status.*`, `command.run`, `dom.*` of core and plugin names |
| main page → host | call `exposureReply` | `{id, result}` or `{id, error: {code, message}}` |
| main page → host | call `exposureChanged` | `{name, value}` for a watched status |
| surface page → host | call `exposureRegister` | `{surface, kind, name}` |
| host → main page | event `exposure-registered` | `{surface, kind, name}`; `{surface, closed: true}` when the surface is removed |
| main page → host | call `exposureForward` | `{id, surface, method, params}` for a name that a surface page registered |
| host → surface page | event `exposure-request` | `{id, method, params}` |
| surface page → host | call `exposureReply` | `{id, result}` or `{id, error}`; the host returns it to the main page as the result of `exposureForward` |

The main page validates names against the declarations before it registers or forwards them. `exposureReply` from the main page answers an `exposure-request` of the host; `exposureReply` from a surface page answers a forwarded request. The host identifies the caller by its webview.

The runtime modules map these calls to framework bindings:

| Call | Wails method | Tauri command |
| --- | --- | --- |
| `exposureReply` | `ExposureReply` | `exposure_reply` |
| `exposureChanged` | `ExposureChanged` | `exposure_changed` |
| `exposureForward` | `ExposureForward` | `exposure_forward` |
| `exposureRegister` | `ExposureRegister` (surface bridge) | `exposure_register` |

The page interface for surface pages is `page.exposure`: `register(kind, name)`, `onRequest(fn)` where `fn({id, method, params})` is called for each forwarded request, and `reply(id, payload)`. The main page uses `host.on("exposure-request", fn)`, `host.on("exposure-registered", fn)`, and `host.call(...)` with the calls above.

## Errors

| Code | Meaning |
| --- | --- |
| -32601 | Undeclared method |
| -32602 | Invalid params |
| 1001 | Unknown name |
| 1002 | Name is declared but not registered |
| 1003 | Owner document no longer exists |
| 1004 | Native input is not available on this platform |
| 1005 | Request timed out: the owning document did not reply within 10 seconds |

The [local endpoint](endpoint.md) closes the connection after an undeclared method.
