# Exposure: status, command, dom

[한국어](exposure.ko.md)

Core, the plugin API, the shell and browser plugins, and the macOS hosts implement this specification; [feature status](../features.md) records its validation.

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
| command | `timeout` | Optional. How long a command may take to reply, in milliseconds from 1 to 600000; the default is 10 seconds. The host applies it to a command forwarded to a surface page, and the main page applies it to the handler of a command it runs itself, which then fails with -32000 and `command <name> did not reply within <ms>ms`. A handler that throws, synchronously or asynchronously, fails the command with its own error, and the timeout ends with it. A core command then waits for its layout to present; that wait is not part of the timeout, because each step of the presentation path fails with its own error within its own limit ([native host](native-host.md)) |
| dom | `name` | Entry name |
| dom | `description` | One-sentence description |
| dom | `many` | Optional. `true` when several elements share the name; requests address one element with `index`, or with `address` where [declared UI](declared-ui.md) defines one |

A schema is a JSON Schema subset with the keywords `type`, `properties`, `items`, and `enum`.

The element for a dom entry carries the attribute `data-expose="<name>"`. Without `many`, exactly one element has the name. An interactive element that a [declared UI](declared-ui.md) value draws carries the attributes and the address that [declared UI](declared-ui.md) defines.

## User interface

People and external clients operate a document through the same entries.

- Every user operation of a document runs a declared command. A control points to its command with `data-command="<name>"` and, for fixed parameters, `data-params` with a JSON object. A control that enters a value adds it as the parameter named by `data-value` (`value` by default). Commands are declared first (`exposure.json`, `plugin.json`); a document connects elements only to declared commands with `createBinder(run)` of `@soksak/plugin-api`: `bind(element, name, params, {event, when, stop, failed})` runs the command on an event, `mark(element, name, params, valueName)` sets the attributes, and `delegate(root)` runs clicks and value changes of marked descendants that `bind` has not connected; an element connected with `bind` runs its command only on its own event, so a text field bound to Enter does not run its command again on the `change` that the same Enter fires. Binding or marking an undeclared name throws. The workbench uses `packages/workbench/commands.js` (a binder over the registry), and a plugin page uses `expose.bind`, `expose.mark`, and `expose.delegate`, which run the commands the page registered. Handlers do not call module functions themselves. A continuous gesture, such as a tab drag, has a command that produces its result (`core.tab.move`), and keyboard shortcuts run commands.
- Every visible state of a document can be read through a status.
- Every interactive element (`button`, `input`, `select`, `textarea`, `role="button"`, and `contenteditable`) is connected to a command, either bound or carrying `data-command` under a delegated root, and has a dom name.
- A declared UI tree node with `open` handles Enter keydown by running `open` and preventing the native click. Its click handler runs `open` on the second click of a double press (`event.detail === 2`), instead of its ordinary `command`. No other declared UI element has a key handler ([declared UI](declared-ui.md#binding)).
- A redraw keeps every control that stays in the document in its place and moves a control only when its order is wrong. WebKit sends no `click` for a press whose element left the document between the press and the release, and moving an element with `insertBefore` takes it out of the document first, so a redraw that moved a control lost a click pressed during it. A plugin page draws a list of controls with `drawList` of `@soksak/plugin-api`, which keeps the element of each key in place.
- A native modal renders a copy of its element and answers with the control's key; the main page runs the command of the matching control in its own element.

Coverage is judged in the running document. The binder's `audit(root)` lists interactive elements that are not connected or have no dom name as `{tag, expose, command, text}`; the main page publishes it as `core.page.audit` and every plugin page as `unbound` in `core.surface.document`. A visible view surface whose page does not expose `core.surface.document` fails the audit, because a view is a separate document that the audit cannot judge otherwise. `e2e/audit.test.mjs` visits every screen, modal section, menu, editing state, and visible plugin surface of both applications and requires empty lists. `scripts/check-exposure.mjs` (`make exposure-check`) checks only what the workbench sources state through `exposure-check.js` of `@soksak/plugin-api`: every name written in a source is declared, every declared status and command is registered, and every declared dom name is written as an exposed value. A plugin section module may also name core statuses and bind core commands ([sections](plugins.md#sections)), and a surface module may run a core command through `runtime.command` ([surface module ownership](plugins.md#surface-module-ownership)); those names must be declared by core; a plugin repository checks the names of its own pages and sections with the same module, `soksak-exposure`, which reads the core names from `core-exposure.json` of the package. `make exposure-check` fails when that file differs from the workbench declaration, and `node scripts/check-exposure.mjs --write` writes it.

## Keyboard shortcuts

Every keyboard shortcut of the workbench has one owner and one command. The machine-readable table is [shortcuts.json](../../packages/workbench/shortcuts.json) (`packages/workbench/shortcuts.json`); the table below is its copy. `scripts/test/shortcut-table.test.mjs` requires that both match, that every key equivalent of the [application menu](host-contract.md#application-menu) is a `native menu` row, and that every key comparison of the workbench key handlers has a `workbench` or `view` row. The owners follow [plugin processes](plugin-processes.md) rule 7:

- `native menu`: a key equivalent of an application menu item. The menu receives the key before the view, so the view's default action is not prevented. A row with a core command reaches it through the menu; a row with `framework role` runs the role of the item.
- `workbench`: a key that the workbench page or its native modals handle and prevent by default. The row names the command that the key runs.
- `view`: a key that the view handles itself, or a workbench command that the view runs with `runtime.command` for a key that it forwards under [plugin processes](plugin-processes.md) rule 7. A view row names no command, because the view decides synchronously; it is a rule, not a binding.

In a key, `cmd` is the Command key on macOS and the Control key on the other hosts (`CmdOrCtrl`). `Enter` and `Escape` are key names.

The view reads the rows that it may forward with the view call `runtime.shortcuts.read`: the rows whose owner is `workbench` or `view` ([native surfaces](native-surfaces.md#view-surfaces), Input). A view registers no table.

| Key | Owner | Command | Menu item | When |
|---|---|---|---|---|
| `cmd+h` | native menu | framework role | app/hide | Any focus |
| `opt+cmd+h` | native menu | framework role | app/hide-others | Any focus |
| `cmd+q` | native menu | framework role | app/quit | Any focus |
| `cmd+w` | native menu | framework role | file/close-window | Any focus |
| `cmd+z` | native menu | framework role | edit/undo | Any focus |
| `shift+cmd+z` | native menu | framework role | edit/redo | Any focus |
| `cmd+x` | native menu | framework role | edit/cut | Any focus |
| `cmd+c` | native menu | framework role | edit/copy | Any focus |
| `cmd+v` | native menu | framework role | edit/paste | Any focus |
| `cmd+a` | native menu | framework role | edit/select-all | Any focus |
| `cmd+=` | native menu | core.text.larger | view/text-larger | Any focus |
| `cmd+-` | native menu | core.text.smaller | view/text-smaller | Any focus |
| `cmd+0` | native menu | core.text.reset | view/text-default | Any focus |
| `shift+cmd+n` | native menu | core.window.new | window/new-window | Any focus |
| `shift+cmd+n` | workbench | core.window.new | — | No host chrome (browser build) |
| `cmd+k` | workbench | core.focus.set | — | The library is shown |
| `Enter` | workbench | core.rename.commit | — | The tab rename field has focus |
| `Escape` | workbench | core.rename.cancel | — | The tab rename field has focus |
| `Enter` | workbench | core.library.form.submit | — | A library form field has focus |
| `Escape` | workbench | core.picker.close | — | A picker layer is open |
| `Escape` | workbench | core.modal.dismiss | — | A native modal menu is open and has keyboard focus |
| `Escape` | view | none | — | A plugin view has keyboard focus; the view handles the key itself, and runs the Escape command of an open picker only when it forwards the key |
| `text input keys` | view | none | — | A plugin view has a text input focused; the view handles the key itself and it keeps its default action |

## Registration

The workbench registers core entries in the registry of the main page. A plugin surface page registers its entries through `@soksak/plugin-api/page`. A core command answers after its handler has finished, including the asynchronous work that the handler starts, and after the plane has drawn the newest layout, so a caller that reads the layout after a command that changes it reads the drawn layout. The wait waits for the newest layout and waits again when a newer layout was scheduled while it waited, because a layout that a newer layout replaces ends without a draw. It then reads the surface slots of that draw and waits for the declared composition of each surface they name. A surface that this command or a later one removed therefore has no slot when the wait reads them; a slot that names a surface that is not mounted after the newest draw is a defect, and the wait fails with `surface <id> is not mounted`. When the newest layout fails, the layout queue shows that failure, and the wait ends without reading slots, because that layout was not presented. A failure of the wait itself is written as `exposure settled failed: <text>`. In both cases the command answers with its handler's result, and the failure has one line in the [application log](hosts.md#application-log).

| Function | Registers |
| --- | --- |
| `expose.status(name, read, subscribe)` | `read()` returns the current value; `subscribe(fn)` calls `fn(value)` on each change |
| `expose.command(name, run)` | `run(params)` returns the result or a promise of it |
| `expose.dom(name, element)` | The element for a dom entry |

The native host relays registrations and requests between a surface page and the registry of the main page in the same way that it relays [sidecar](sidecars.md) messages. When a surface page closes, the registry removes its registrations.

A page registers under a key that identifies it, the owner key of the registration. A surface page registers under its surface id with the owner from its plugin. A plugin host page registers through its channel under the owner key `plugin:<plugin id>` ([plugin host](plugin-host.md#exposure)); the registration of a plugin host ends with its process, and a process that is created again within the restart limit registers again under the same key.

### Surface documents

`@soksak/plugin-api/page` registers these core entries in every plugin surface page, so plugins do not implement them. Core declares them in `exposure.json`. They are the only core names that surface pages register.

| Kind | Name | Meaning |
| --- | --- | --- |
| status | `core.surface.document` | `{url, timeOrigin, readyState, themed, scale, body, viewport, filter, unbound}`: the document address, time origin, ready state, whether the first theme is applied, device pixel ratio, `body`, the size of the surface content (the surface element's box plus the content that overflows or scrolls past it) and `viewport`, the size of the surface element's visible box, both in CSS pixels, so `body` exceeds `viewport` only when the content does not fit, the computed `filter` of the root element, and the audit of its interactive elements (as in `core.page.audit`) |
| status | `core.surface.input` | The last 32 trusted or untrusted input events of the document in order: `{sequence, type, trusted, x, y, key, modifiers}` for `pointerdown`, `pointerup`, `pointermove`, `click`, `wheel`, and `keydown`. `modifiers` lists the modifier keys the event carries (`shift`, `alt`, `control`, `command`). `sequence` starts at 1 and increases by one for each recorded event |
| command | `core.surface.hit` | `{x, y}` in CSS pixels; returns `true` when an element of the document is at the point |

A mounted module owns its request callback in the application document. Disposal removes that callback and its registrations before the same logical surface identifier can be mounted again. Repeated disposal has no effect on a later owner of that identifier. Requests after disposal are not dispatched to the disposed module.

Core and plugin entries of a native-backed module register only after its native surface is authorized. A closure received while authorization is pending cannot remove only the core entries of the subsequent mount.

### Modal documents

A native modal document reports its state to the main page through the modal answer channel with the key `document` after each render, placement, and theme change. The main page publishes it as status `core.modal`: `null` without an open modal, or `{id, mode, document}` where `document` is `null` until the first report and then `{mode, filter, htmlBackground, bodyBackground, scrimBackground, loaded, rect}`: the rendered element's `data-native-modal`, the root's computed `filter`, the computed background colors of the root and the body, the computed `body::before` background used for the dialog scrim, whether the document has handled the answer to its first content request (also when it dropped that answer as older than applied changes), and the element rectangle in CSS pixels.

Escape in a native menu answers with the key `core.modal.dismiss`, which names the declared command that closes the menu, and the answer carries an empty value. The main page runs that command through the registry; the native view runs no command itself.

A reply of a modal document reaches the main page only while that modal is the open one. The host drops a reply whose modal id and instance are not those of the open modal and records `host.overlay.dropped` `{id, instance, key, open}`; the main page drops a reply of a modal that it does not show, or that has no receiver, and records `page.overlay.dropped` `{id, shown, key}`. A closing modal still sends its last state report, so a drop is an `info` event and not an error, and no reply is dropped without a record.

### Choosing a surface

Several surface pages can register the same name. A request for such a name can include `surface`, an identifier from `core.surfaces`, in `status.get`, `status.watch`, `status.unwatch`, `command.run`, `dom.rect`, and `dom.act`. Without `surface`, the main page chooses the active tab of the focused card, then the visible surfaces in the latest layout, then the latest registration. A `surface` that has not registered the name returns 1002. A request without `surface` for a name that a [plugin state module](plugins.md#plugin-state) registered is answered by that module in the application document. A request without `surface` for a name that a [plugin host](plugin-host.md) registered and that no surface page and no state module registered is answered by the registration of the plugin host; a request that names a `surface` is never answered by a plugin host, because a plugin host is not a surface.

## Tab memory

The [memory saver](plugins.md#memory-saver) of the main page has these entries.

- Status `core.tab.memory`: `{enabled, delay, pressure: {level, seq}, tabs: [{tab, plugin, state, reasons, hiddenAt, unloadAt, checkedAt}]}`, notified on each change. `enabled` is the setting `memorySaver`, `delay` the setting `memorySaverDelay` in minutes, and `pressure` the last [memory pressure](hosts.md#memory-pressure) report. `state` is `loaded`, `unloaded` or `restoring`; `reasons` lists the reasons that protect the tab, from the one enumeration `shown`, `recent`, `keep:modified`, `keep:busy`, `media`, `media-unknown`, `capture`, `form`, `kept`, `off`, `undeclared`, `background`; `hiddenAt` is the time the tab was hidden or `null`, `unloadAt` its next delay deadline or `null`, and `checkedAt` the time of the last decision that read `media`, `media-unknown` and `capture`, or `null`. `core.surfaces` reports the same `state` for each tab, and a request to an unloaded surface fails with `tab <id> is unloaded`.
- Command `core.tab.unload {tab}` unloads a hidden tab now. As the person's own decision it does not wait for `recent`, `media`, `media-unknown`, `capture` or `form`; it fails with the error `tab <id> is protected: <reasons>` for the remaining reasons (`shown`, `keep:modified`, `keep:busy`, `kept`, `off`, `undeclared`, `background`) and with the reasons that ended the attempt, and with -32602 (invalid params) for an unknown tab.
- Command `core.tab.keep {tab, keep}` sets (`true`) or clears (`false`) the person's mark `kept` and stores it in `tab-state.json`. It is idempotent and emits one `page.tab.keep.changed` per change; it fails with -32602 for an unknown tab or a `keep` that is not a boolean, and with `tab <id> can never be unloaded: <reason>`, the reason `undeclared` or `background`, for a tab that can never be unloaded.
- Each tab button carries `data-tab-state` with its `state` (`loaded`, `unloaded` or `restoring`); protections are shown only through `reasons`.
- Command `core.tab.menu {tab, x, y}` opens the tab context menu in the selection layer at `x` and `y` of the window; a right click on a tab button runs it when the menu has an item. It fails with -32602 for an unknown tab and with `tab <id> has no menu items` for a tab that can never be unloaded.
- The tab context menu item with the dom name `core.tab.menu-keep` is picked through the binder with `core.picker.pick` and runs `core.tab.keep` with the toggled mark; it is `active` in `core.picker` while `kept` is in the reasons of `core.tab.memory`, and is absent for a tab that can never be unloaded. Its name has the prefix `core.` like every dom name that core declares, because the exposure check reads only names with that prefix.

## Plugin processes

The main page publishes three statuses of the [plugin process design](plugin-processes.md#messages-and-events). Each status is a list of records that carry the plugin id. Each list is `[]` until a plugin process connects its call layer, which reports the open calls and the losses of its plugin to the main page.

- Status `core.plugin.open-calls`: `[{plugin, count, oldestStartedAt}]`, the open calls of each plugin that has one, including snapshots waiting for acknowledgement. `oldestStartedAt` is the start time of the oldest open call, or `null`.
- Status `core.plugin.losses`: `[{plugin, skipped, stalled, abandoned, lateReplies, timeouts, peerLost}]`, the counts of each plugin's losses, kept until the application ends.
- Status `core.plugin.views`: `[{plugin, surface, responsive}]`, the responsiveness of each plugin view surface.
- Status `core.surfaces`: each surface entry carries `composition`, the kind of its declared composition (`view` or `hybrid`), or `null` when the plugin declares no surface for it.

## Windows

An application has one or more windows, and each window has its own main page and registry. Every method except `windows.list` and `log.query` takes `window`, the identifier that `windows.list` returns. A request for a window that no longer exists returns error 1003 `window "<name>" does not exist`. This includes a window that closes after the host accepted the request: the host reads the native window in the main-thread step that passes it to native code, and a window that closed before that step fails the request with 1003 without reaching native code. A `host.window` change of such a window notifies nothing; the window's removal from `host.windows` reports the close.

## Host entries

The native host declares entries with owner `host` in the same format and serves them itself.

Screen coordinates are points with the origin at the top-left corner of the primary display and y increasing downward. `shown` is true once the modal webview is visible and has received keyboard focus. `order` is the drawing order of the webviews in the window: the main page is 0, and a larger value is drawn above a smaller one. `background` is `{draws, alpha}`: whether the modal webview paints its own background, and the alpha of its under-page background color.

| Kind | Name | Meaning |
| --- | --- | --- |
| status | `host.window` | `{frame, pointer, content, scale, refreshRate, maximized, key, active, occluded, children, pageProcess, quitting, controls, webviews, surfaces, documents, regions, modal, responder}`: window frame, the system pointer location `{x, y}` in screen coordinates when the status was read, content size, backing scale, the maximum refresh rate of the screen the window is on (`null` when it is on no screen), whether the frame is the maximized frame, key-window state, whether the application is active, the process identifier of the WebContent process that draws the app page (`pageProcess`, 0 before that process starts), whether other windows cover the whole window (the AppKit occlusion state, in which a window stays visible while any part of it or its shadow shows, so two windows at the same frame do not cover each other; the host notifies `host.window` watchers when it changes; WebKit renders a covered window less often, so display measurements require it to be false), the number of child OS windows, window button frames with `hidden`, webview frames `{frame, main, document, visible, focused, order}` in window coordinates, native surfaces `{id, frame, visible, order}`, [document regions](native-surfaces.md#document-regions) `{surface, document, frame, visible, focused, order, process}`, [image regions](native-surfaces.md#image-regions) `{surface, name, frame, visible, focused, presented, error}`, where `presented` is `{width, height, scale, generation, raster, sequence}` of the presented image, and `generation`, `raster` and `sequence` identify the frame that the host marked presented (`presented` is `null` while no frame of the current raster is presented), the open native modal `{id, mode, shown, frame, order, background}` or `null`, and the window's first responder `{class, owner, surface, document}`, where `owner` is `page`, `surface`, `document`, `modal`, `webview` (an unregistered webview), or `native` (a view outside every webview, such as an image region) |
| status | `host.windows` | The `windows.list` result. It changes when a window opens or closes and when a window title, project, key state, or page readiness changes |
| status | `host.screens` | `[{x, y, width, height, scale, visible}]`: the displays in screen coordinates with their backing scale, and `visible`, the area not covered by the menu bar and Dock, which is the maximized window frame |
| status | `host.dock` | The titles of the application's Dock menu items in order |
| status | `host.log` | `{path, size, notices, coalesced}`: the latest notice of a change of the event log ([following](debug.md#files)). `path` is the event file under the configuration folder (`logs/<name>`) and `size` its size in bytes; `notices` counts the notices published since the start, at most one per 250 ms, and `coalesced` counts the announcements that were folded into a later notice. Before the first notice the value is `{path: "", size: 0, notices: 0, coalesced: 0}`. The host notifies `host.log` watchers with each notice; a line announces a change except the record of a call that only reads the log, so a client that queries `log.query` after a notice does not cause the next notice |
| status | `host.buttons` | `{mask}`: the mouse buttons that AppKit reports as pressed (`+[NSEvent pressedMouseButtons]`: bit 0 left, bit 1 right, higher bits other buttons). The host reads the mask when AppKit delivers a mouse button press or release to the application (a local event monitor) or to another application (a global event monitor), and notifies `host.buttons` watchers when the mask changes. A person's button therefore changes it while another application is frontmost. A synthetic `input.pointer` press or release goes to a view, not through AppKit's event dispatch, and does not change it |
| status | `host.sidecars` | `{closing: [{sidecar, surface}], outdated: [{sidecar, running, installed, sessions}]}`: the surfaces whose `closed` the host has sent and the sidecar has not answered ([sidecars](sidecars.md#messages)), and the persistent sidecars whose service runs another version than the installed one ([persistent services](persistent-services.md#updates)) |
| command | `host.menu.select` | Performs the application menu item `{menu, title}`: the item with `title` in the submenu with the title `menu` |
| status | `host.menu` | The application menu: `[{title, items: [{title, key}]}]` for each submenu without separators, where `key` is the key equivalent written as the modifiers `ctrl`, `opt`, `shift`, `cmd` in that order joined by `+` before the key, or empty |
| command | `host.window.close` | Closes the window through its normal close action |
| command | `host.window.move` | Moves the window frame origin to `{x, y}` in screen coordinates |
| command | `host.window.maximize` | Maximizes the window, or restores it with `{on: false}` |
| command | `host.window.fullscreen` | Enters full screen, or leaves it with `on` false. It answers after the transition; macOS ignores a request made during one, so the host applies it when that transition ends |
| command | `host.window.resize` | Resizes the content area to `{width, height}` |
| command | `host.window.reload` | Reloads the main page and resolves after the new page reports ready; 1005 if it does not within 10 seconds |
| command | `host.window.presented` | Resolves after the main page and visible application documents have presented their current geometry and every visible image region has presented its exact current raster. It waits for the window's open surface layout transactions to commit first and fails if the current raster does not arrive within the command timeout ([native surfaces](native-surfaces.md), [surface composition](surface-composition.md)). Returns `{displayed}`, the time in milliseconds of the display refresh that shows that state, on the clock of recorded frame times (the next refresh of the window's screen after the presentation; the call time when the window is on no screen) |
| command | `host.hit` | Returns the owner of the point `{x, y}` in window coordinates: `{kind: "page"}` for the main page, which includes DOM surfaces and image regions because both take DOM input ([surface composition](surface-composition.md)), `{kind: "document", surface, document}` for a document region, or `{kind: "native", identifier, view}` for a native hit. `view` is `null` when no native view was hit, or `{class, frame}` for the actual leaf view that received hit testing, with its frame in window content coordinates |
| command | `host.dock.select` | Performs the Dock menu item with `{title}` |
| command | `host.quit` | Requests normal application termination, including pending saves |

## Methods

Clients call these JSON-RPC 2.0 methods.

| Method | Params | Result |
| --- | --- | --- |
| `windows.list` | none | `[{window, title, project, key, ready}]`. `project` is the root directory of the project last opened in the window, or `null` when the window holds no open project; releasing the last project of a window also returns its title to the library title. `ready` is true after the main page of the window reports ready and false while it loads; requests for a window whose page is loading fail with 1003 |
| `log.query` | the query parameters, no `window` | `{rows, next, tail, scanned}`: one page of the events of the event files of the configuration directory ([endpoint](endpoint.md#log-query), [logging](logging.md#query)) |
| `exposure.list` | `{window}` | `{status, commands, dom}`: the declared entries of core, the host, and loaded plugins in the declaration format, each with `registered` |
| `status.get` | `{window, name, surface?}` | Current value |
| `status.watch` | `{window, name, surface?}` | `null`; the host then sends `status.changed` notifications `{window, name, surface?, value}` on each change until `status.unwatch` or until the connection closes. Watches with different `surface` values are separate |
| `status.unwatch` | `{window, name, surface?}` | `null` |
| `command.run` | `{window, name, params, surface?}` | Command result |
| `dom.rect` | `{window, name, index?, address?}` | `{x, y, width, height}` in CSS pixels of the owning document, plus `{document}`: the document origin in window coordinates |
| `dom.act` | `{window, name, index?, address?, action, value?, event?}` | `null`. `action` is `click`, `input`, or `dispatch`. The page receives synthetic DOM events with `isTrusted` false |
| `input.pointer` | `{window, x, y, phase, button?, deltaX?, deltaY?, activate?}` | `null`. Window coordinates. `phase` is `move`, `down`, `drag`, `up`, or `scroll`. `button` is `left` (default) or `right`. `deltaX` and `deltaY` are scroll distances in points. `activate` applies to `move` |
| `input.key` | `{window, key, text?, modifiers?, phase}` | `null`. `key` is a key name (`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `PageUp`, `PageDown`) or one character. `modifiers` is an array of `shift`, `control`, `option`, `command`. `phase` is `down` or `up` |

A request gives either `index` or `address`, never both. `index` is a non-negative integer. A control address is `{sidebar, section, key, path?, role?}`, as [declared UI](declared-ui.md) defines it, with `sidebar`, `section`, and `key` as strings and `path` as an array of strings. The `core.sidebar.section.control` dom entry is declared `many`, so its requests give `index` or `address`. A request with both, an `address` given for another dom entry, a value of the wrong type, or a forbidden or missing `path` or `role` is refused with -32602, and a control address that matches no control is refused with 1009.

Native pointer injection retains the pressed view separately for each window and button. Drag and release go to that view even when the pointer crosses another view; release receipt waits for the pressed document. A drag or release without a matching press, a second press while that button is held, or a removed pressed view returns an explicit input rejection. Scroll and button-free movement continue to use the current pointer position.

All mounted plugin modules, including hybrid compositions with native regions, share the application DOM document. Their `dom.rect` rectangles already use application-document coordinates and their `document` origin is `{x: 0, y: 0}`. Surface placement must not be added to this origin. A native modal has its own document: its rectangles remain modal-local and its `document` origin is the actual modal frame origin. Clients add the reported document origin exactly once; they must not compensate for surface kind or card placement.

The host delivers `input.pointer` and `input.key` as native events, and the page receives trusted events. The application is not activated, except for `move` with `activate: true`. On macOS:

- A key to the key window goes through `-[NSApplication sendEvent:]` with the window's number, like a person's key, so AppKit decides key equivalents such as Command+C and Command+V; a check of a key equivalent therefore runs in the activation tier. A key to a window while another window is the key window is not delivered and returns 1006, because a person's key cannot reach that window. Without a key window, in an inactive application, a key goes to the window's `-[NSWindow sendEvent:]`, because a person's key does not reach an inactive application and checks that do not activate the application target each window. Scroll goes through `-[NSWindow sendEvent:]`. A press goes directly to the view under the point because AppKit does not deliver a press in an inactive window to that view; subsequent drags and release retain that pressed view. The real-input tier checks the window-server path of a person's pointer.
- A `down` or `up` into a web view returns after that view's document has received the trusted `pointerdown` or `pointerup`. A script in a separate WebKit content world, which the page cannot see, reports the receipt. While a text field has focus, WebKit passes mouse events to the input method asynchronously first, so a press and a release sent one after the other could otherwise reach the document in the opposite order. If the document does not receive the event within 2 seconds, the request returns 1005. A `scroll` is delivered after the web view under the point has presented its current state, because WebKit does not scroll a new document with a wheel event received before its scrolling tree is presented; if the view does not present within 2 seconds, the request returns 1005.
- WebKit updates hover (`pointerover`, `pointermove` without a button, `:hover`) only while the window is the key window. A `move` to a window that is not the key window returns 1006. The key window of the active application also receives the system pointer location as a move, for example when it becomes key, and such a move between a synthetic `down` and `up` reaches the document as a drag, so activation-tier checks keep the window away from the system pointer.
- WebKit reads the pressed buttons of a mouse event from AppKit (`+[NSEvent pressedMouseButtons]`), not from the event. If AppKit reports a nonzero button mask, a synthetic press or release may reach the document as `pointermove` instead of `pointerdown` or `pointerup`, so a `down` or `up` is refused with 1007. The mask alone does not identify what produced that state, so the error message reports the mask and the frontmost application measured in the same main run-loop turn as the refusal: `AppKit reports NSEvent.pressedMouseButtons mask <mask> while <application> is frontmost; the synthetic press or release was not delivered`. `<mask>` is the mask in lowercase hexadecimal with a `0x` prefix. `<application>` is `<bundle identifier> (pid <pid>)`, `an application without a bundle identifier (pid <pid>)`, or, when AppKit reports no frontmost application, the clause reads `while no application is frontmost`. Both hosts produce the same text.
- A press stays open from a delivered `down` until a delivered `up` of the same button in that window, and a refused `up` keeps it open, so a later `up` releases it on the view that received the press. A `down` of a button whose press is open in that window is refused with 1008. `host.buttons` reports the mask that the 1007 refusal reads, so a press whose `up` was refused can be ended once `host.buttons` reports mask 0. A check session ends every press it left open when it ends: it waits through `status.watch` until `host.buttons` reports mask 0, without a timer, and then sends `up`, which must be delivered.
- With `activate: true`, the host activates the application and makes the window key, waits until every webview of the window has sent the active state to its web process, and then delivers the move. This takes the keyboard focus from the application the user is using. If activation does not finish within 5 seconds, the request returns 1006 with the step that stopped: the system did not activate the application, the window did not become key, the webviews did not apply the active state, or the window lost activation before they did. Except for the webview step, the message names the frontmost application. macOS refuses an application's own activation request while the user has not activated it since it was launched in the background (cooperative activation), so an activation-tier check first activates the application through `NSRunningApplication` from the check process, as a person switching to it does, and the host request then completes the key window and webview steps.
- The OS input method serves only the active input context of the key window of the active application. `input.key` to a window that is not that key window is either rejected, while another window is the key window, or delivered without reaching the input method, in an application without a key window, so its result is not input-method evidence. A view that passes a character key to its input context, such as the terminal image region, receives no text for it in an application without a key window once the application has been active: the input context accepts the key and the input method does not answer. The terminal image region reports such a key as the error `input method did not answer native keyCode=<code> outside the key window of the active application`. Named keys and Control or Option combinations that the region reports itself are delivered in any window. A web view passes character keys to its input context in the same way, so a document region also takes typed characters only in the key window of the active application once the application has been active; an application that has never been active, such as a native test that forbids activation, still receives them. Character typing into a terminal or a document region and input-method behavior are verified only by activation-tier checks.

Tests that check a real input path use `input.pointer` and `input.key` only. Tests use `dom.act` only to set up state.

## Relay

The host and the pages exchange these messages. They are internal to core and not part of the endpoint.

| Direction | Message | Content |
| --- | --- | --- |
| host → main page | event `exposure-request` | `{id, method, params}` for `exposure.list`, `status.*`, `command.run`, `dom.*` of core and plugin names. The host waits 10 seconds for the answer, except for `command.run`, which the main page answers within the command's timeout, whether it forwards the command or answers it itself; a main page that is not ready returns 1003, and requests to a main page that reloads or closes end with 1003 |
| main page → host | call `exposureReply` | `{id, result}` or `{id, error: {code, message}}` |
| main page → host | call `exposureChanged` | `{name, surface?, value}` for a watched status; `surface` is present when the watch named one. The host refuses a name that starts with `host.` with `the page cannot change host status <name>`; only the host changes a host status |
| surface page → host | call `exposureRegister` | `{surface, kind, name}`. The page of a view has no surface bridge: it calls `runtime.native.call` with `{name: "registered", payload: {kind, name}}` through the view channel ([view surfaces](native-surfaces.md#view-surfaces)), and the main page relays it with this call. A relay from the main page is accepted only for a surface that has a view |
| host → main page | event `exposure-registered` | `{surface, kind, name}`; `{surface, closed: true}` when the surface is removed. Surfaces outlive a reload of the main page, so after the main page reports ready the host sends every live registration again |
| main page → host | call `exposureForward` | `{id, surface, method, params, timeout?}` for a name that a surface page registered. `timeout` is an integer from 1 to 600000 milliseconds, taken from the command declaration; without it the host waits 10 seconds. `status.next` takes no `timeout`. An invalid `timeout` returns -32602 |
| host → surface page | event `exposure-request` | `{id, method, params}`. For a view, the event carries `surface` and the main page relays it to the view through the view's `exposure-request` subscription (`runtime.native.on`), with `data` `{id, surface, method, params}` |
| main page → surface page (through `exposureForward`) | `status.watch`, `status.unwatch` | `{name}`. The surface page starts or stops following the value |
| main page → surface page (through `exposureForward`) | `status.next` | `{name, version}`. The surface page replies `{version, value}` when its value is newer than `version`, or `{closed: true}` after `status.unwatch`. The host applies no timeout to this request; it fails with 1003 when the surface closes |
| host → main page | event `diagnostics-tick` | No payload. Diagnostic builds only: one per step of `diagnostics.drag` |
| surface page → host | call `exposureReply` | `{id, result}` or `{id, error}`; the host returns it to the main page as the result of `exposureForward`. The page of a view answers through `runtime.native.call` with `{name: "exposureReply", payload: {id, result|error}}`, which the main page sends as this call with the surface of the view |

The main page validates names against the declarations before it registers or forwards them. It keeps a registration from a surface that no loaded layout contains yet, and applies or rejects it when a layout containing the surface is loaded. `exposureReply` from the main page answers an `exposure-request` of the host; `exposureReply` from a surface page answers a forwarded request. The host identifies the caller by its webview. For a `core.sidebar.section.control` request, the main page validates `index` or `address` before it answers, and the hosts relay the request unread.

A surface page can answer a forwarded request after its surface was removed, for example a `status.next` that it answers as the surface closes. The host already ended every request to that surface with 1003 when it removed the surface, so the reply has no request to answer: the host discards it and writes the observation `exposure reply <id> of removed surface "<surface>" arrived after its request ended` to the application log instead of refusing the call.

The runtime modules map these calls to framework bindings:

| Call | Wails method | Tauri command |
| --- | --- | --- |
| `exposureReply` | `ExposureReply` | `exposure_reply` |
| `exposureChanged` | `ExposureChanged` | `exposure_changed` |
| `exposureForward` | `ExposureForward` | `exposure_forward` |
| `exposureRegister` | `ExposureRegister` (surface bridge and main page) | `exposure_register` |

The page interface for surface pages is `page.exposure`: `register(kind, name)`, `onRequest(fn)` where `fn({id, method, params})` is called for each forwarded request, and `reply(id, payload)`. The main page uses `host.on("exposure-request", fn)`, `host.on("exposure-registered", fn)`, and `host.call(...)` with the calls above. A reply without `surface` answers a request of the window's main document; a reply with `surface` answers a request of that surface document and names it with a nonempty string. A `surface` that is `null`, empty, or not a string is rejected as an error, not treated as a main-document reply.

## Errors

| Code | Meaning |
| --- | --- |
| -32601 | Undeclared method |
| -32602 | Invalid params, including a `core.sidebar.section.control` request with both `index` and `address`, an `address` given for another dom entry, a value of the wrong type, or a forbidden or missing `path` or `role` |
| 1001 | Unknown name |
| 1002 | Name is declared but not registered |
| 1003 | Owner document no longer exists |
| 1004 | Native input is not available on this platform |
| 1005 | Request timed out: the owning document did not reply within 10 seconds |
| 1006 | The window is not active: a pointer `move` needs the key window, or the system did not activate the application |
| 1007 | AppKit reports a nonzero `NSEvent.pressedMouseButtons` mask, so a synthetic pointer `down` or `up` was not delivered; the message reports the mask and the frontmost application at the refusal |
| 1008 | A synthetic press of that button is still open in the window, so a pointer `down` was not delivered |
| 1009 | No control matches the `address` of a `core.sidebar.section.control` request |
| -32000 | A registered command or status handler failed; `message` is its error message |

A 1005 error of a relayed request has the message `the document did not reply within <ms> ms`. Both hosts remember the 256 most recent requests that timed out, dropping the oldest; a reply to one of them fails with `exposure reply <id> arrived <ms> ms after it was sent; its request timed out after <ms> ms`, and a reply to no remembered request fails with `exposure reply <id> has no matching request`, so the delay of a late reply is in the error that the page reports. A command forwarded to a surface page that times out writes the event `host.call.timeout` with its plugin and command, and a late reply to such a command writes `host.trace.call.late-reply` with its delay.

The [local endpoint](endpoint.md) closes the connection after an undeclared method.
