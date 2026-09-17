# Exposure: status, command, dom

[한국어](exposure.ko.md)

Core, the plugin API, the terminal plugin, and the macOS hosts implement this specification; [feature status](../features.md) records its validation.

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

### Surface documents

`@soksak/plugin-api/page` registers these core entries in every plugin surface page, so plugins do not implement them. Core declares them in `exposure.json`. They are the only core names that surface pages register.

| Kind | Name | Meaning |
| --- | --- | --- |
| status | `core.surface.document` | `{url, timeOrigin, readyState, themed, scale, body, viewport, filter}`: the document address, time origin, ready state, whether the first theme is applied, device pixel ratio, body and visual viewport sizes in CSS pixels, and the computed `filter` of the root element |
| status | `core.surface.input` | The last 32 trusted or untrusted input events of the document in order: `{sequence, type, trusted, x, y, key}` for `pointerdown`, `pointerup`, `pointermove`, `click`, `wheel`, and `keydown`. `sequence` starts at 1 and increases by one for each recorded event |
| command | `core.surface.hit` | `{x, y}` in CSS pixels; returns `true` when an element of the document is at the point |

### Modal documents

A native modal document reports its state to the main page through the modal answer channel with the key `document` after each render, placement, and theme change. The main page publishes it as status `core.modal`: `null` without an open modal, or `{id, mode, document}` where `document` is `null` until the first report and then `{mode, filter, htmlBackground, bodyBackground, rect}`: the rendered element's `data-native-modal`, the root's computed `filter`, the computed background colors of the root and the body, and the element rectangle in CSS pixels.

### Choosing a surface

Several surface pages can register the same name. A request for such a name can include `surface`, an identifier from `core.surfaces`, in `status.get`, `status.watch`, `status.unwatch`, `command.run`, `dom.rect`, and `dom.act`. Without `surface`, the main page chooses the active tab of the focused card, then the visible surfaces in the latest layout, then the latest registration. A `surface` that has not registered the name returns 1002.

## Windows

An application has one or more windows, and each window has its own main page and registry. Every method except `windows.list` takes `window`, the identifier that `windows.list` returns. A request for a window that no longer exists returns error 1003.

## Host entries

The native host declares entries with owner `host` in the same format and serves them itself.

Screen coordinates are points with the origin at the top-left corner of the primary display and y increasing downward. `order` is the drawing order of the webviews in the window: the main page is 0, and a larger value is drawn above a smaller one. `background` is `{draws, alpha}`: whether the modal webview paints its own background, and the alpha of its under-page background color.

| Kind | Name | Meaning |
| --- | --- | --- |
| status | `host.window` | `{frame, content, scale, key, active, children, controls, surfaces, modal}`: window frame, content size, backing scale, key-window state, whether the application is active, the number of child OS windows, window button frames with `hidden`, native surfaces `{id, frame, visible, order}`, and the open native modal `{id, mode, shown, frame, order, background}` or `null` |
| status | `host.windows` | The `windows.list` result. It changes when a window opens or closes and when a window title, project, key state, or page readiness changes |
| status | `host.screens` | `[{x, y, width, height, scale}]`: the displays in screen coordinates with their backing scale |
| status | `host.dock` | The titles of the application's Dock menu items in order |
| command | `host.window.close` | Closes the window through its normal close action |
| command | `host.window.move` | Moves the window frame origin to `{x, y}` in screen coordinates |
| command | `host.window.maximize` | Maximizes the window, or restores it with `{on: false}` |
| command | `host.window.resize` | Resizes the content area to `{width, height}` |
| command | `host.window.reload` | Reloads the main page and resolves after the new page reports ready; 1005 if it does not within 10 seconds |
| command | `host.window.presented` | Resolves after the main page and visible application documents have presented their current geometry |
| command | `host.hit` | Returns the owner of the point `{x, y}` in window coordinates: `{kind: "page"}`, `{kind: "surface", surface}`, or `{kind: "native", identifier}` |
| command | `host.dock.select` | Performs the Dock menu item with `{title}` |
| command | `host.quit` | Requests normal application termination, including pending saves |

## Methods

Clients call these JSON-RPC 2.0 methods.

| Method | Params | Result |
| --- | --- | --- |
| `windows.list` | none | `[{window, title, project, key, ready}]`. `project` is the root directory of the project last opened in the window, or `null`. `ready` is true after the main page of the window reports ready and false while it loads; requests for a window whose page is loading fail with 1003 |
| `exposure.list` | `{window}` | `{status, commands, dom}`: the declared entries of core, the host, and loaded plugins in the declaration format, each with `registered` |
| `status.get` | `{window, name}` | Current value |
| `status.watch` | `{window, name, surface?}` | `null`; the host then sends `status.changed` notifications `{window, name, surface?, value}` on each change until `status.unwatch` or until the connection closes. Watches with different `surface` values are separate |
| `status.unwatch` | `{window, name}` | `null` |
| `command.run` | `{window, name, params}` | Command result |
| `dom.rect` | `{window, name, index?}` | `{x, y, width, height}` in CSS pixels of the owning document, plus `{document}`: the document origin in window coordinates |
| `dom.act` | `{window, name, index?, action, value?, event?}` | `null`. `action` is `click`, `input`, or `dispatch`. The page receives synthetic DOM events with `isTrusted` false |
| `input.pointer` | `{window, x, y, phase, button?, deltaX?, deltaY?, activate?}` | `null`. Window coordinates. `phase` is `move`, `down`, `drag`, `up`, or `scroll`. `button` is `left` (default) or `right`. `deltaX` and `deltaY` are scroll distances in points. `activate` applies to `move` |
| `input.key` | `{window, key, text?, modifiers?, phase}` | `null`. `key` is a key name (`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `PageUp`, `PageDown`) or one character. `modifiers` is an array of `shift`, `control`, `option`, `command`. `phase` is `down` or `up` |

The host delivers `input.pointer` and `input.key` as native events, and the page receives trusted events. The application is not activated, except for `move` with `activate: true`. On macOS:

- Keys and scroll go through `-[NSWindow sendEvent:]`. Presses, drags, and releases go to the view under the point, because AppKit does not deliver a press in an inactive window to the view.
- WebKit updates hover (`pointerover`, `pointermove` without a button, `:hover`) only while the window is the key window. A `move` to a window that is not the key window returns 1006.
- With `activate: true`, the host activates the application and makes the window key, waits until every webview of the window has sent the active state to its web process, and then delivers the move. This takes the keyboard focus from the application the user is using. If the system does not activate the application within 5 seconds, the request returns 1006.

Tests that check a real input path use `input.pointer` and `input.key` only. Tests use `dom.act` only to set up state.

## Relay

The host and the pages exchange these messages. They are internal to core and not part of the endpoint.

| Direction | Message | Content |
| --- | --- | --- |
| host → main page | event `exposure-request` | `{id, method, params}` for `exposure.list`, `status.*`, `command.run`, `dom.*` of core and plugin names |
| main page → host | call `exposureReply` | `{id, result}` or `{id, error: {code, message}}` |
| main page → host | call `exposureChanged` | `{name, surface?, value}` for a watched status; `surface` is present when the watch named one |
| surface page → host | call `exposureRegister` | `{surface, kind, name}` |
| host → main page | event `exposure-registered` | `{surface, kind, name}`; `{surface, closed: true}` when the surface is removed. Surfaces outlive a reload of the main page, so after the main page reports ready the host sends every live registration again |
| main page → host | call `exposureForward` | `{id, surface, method, params}` for a name that a surface page registered |
| host → surface page | event `exposure-request` | `{id, method, params}` |
| main page → surface page (through `exposureForward`) | `status.watch`, `status.unwatch` | `{name}`. The surface page starts or stops following the value |
| main page → surface page (through `exposureForward`) | `status.next` | `{name, version}`. The surface page replies `{version, value}` when its value is newer than `version`, or `{closed: true}` after `status.unwatch`. The host applies no timeout to this request; it fails with 1003 when the surface closes |
| host → main page | event `diagnostics-tick` | No payload. Diagnostic builds only: one per step of `diagnostics.drag` |
| surface page → host | call `exposureReply` | `{id, result}` or `{id, error}`; the host returns it to the main page as the result of `exposureForward` |

The main page validates names against the declarations before it registers or forwards them. It keeps a registration from a surface that no loaded layout contains yet, and applies or rejects it when a layout containing the surface is loaded. `exposureReply` from the main page answers an `exposure-request` of the host; `exposureReply` from a surface page answers a forwarded request. The host identifies the caller by its webview.

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
| 1006 | The window is not active: a pointer `move` needs the key window, or the system did not activate the application |
| -32000 | A registered command or status handler failed; `message` is its error message |

The [local endpoint](endpoint.md) closes the connection after an undeclared method.
