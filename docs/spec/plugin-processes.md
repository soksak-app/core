# Plugin processes

[한국어](plugin-processes.ko.md)

This specification states where plugin code runs and how its processes communicate: the layers of a plugin, the pass values of a plugin view, the declared UI snapshots, the calls across a process boundary, the origin and core root of a view, restarts, presentation, input, theme, the messages and events, the boundary between core and plugins, the process assignment of views, the binary path, the plugin host, the identity of a plugin, and the context of a view. [Declared UI](declared-ui.md) defines the declared UI schema, [native surfaces](native-surfaces.md#view-surfaces) defines the view channel and the placement of a view, and [plugins](plugins.md) defines the manifest.

## Decision

Plugin code runs outside the workbench page. Each plugin view is a separate web view on the `sok://<plugin id>` origin, with one view per tab. Declared UI is drawn by the workbench from [declared UI snapshots](native-surfaces.md#view-surfaces) that the plugin sends. A plugin host exists only for DOM-free logic that neither a view nor a sidecar can hold.

Measurements do not reverse this decision. They fix the process counts, the per-plugin budgets and the pass values. When a pass value is not met, the design reopens. It does not return to mounting plugin surfaces on the workbench page.

## Reasons

- Memory: WebKit delays the full JavaScript collection in proportion to the bytes allocated since the last collection (`heap/GCActivityCallback.cpp`, `didAllocate`). Plugin code on the workbench page allocates in the same heap as the workbench, so one plugin's allocation delays collection of the workbench's garbage too. No public API shortens the delay.
- Replaced documents remain in the `querySelectorAll` result cache until memory pressure.
- A newly started release build's main page process held about 70 MB; after reloads the main page processes held 446.6 MB (Wails) and 399.9 MB (Tauri).
- Closing one hidden browser tab returned 227 MB.
- Opening each document in a new process raised navigation time from 0.6 s to 1.1 s, and that policy was reverted.
- Failure isolation and measurement units: a plugin's failure, memory and measurements belong to its own process.

## Layer rules

- **Declared UI:** a sidebar section whose every element is one of list, tree, button or status-line is declared UI.
- **View:** any other screen is a view. A tree that needs inline rename, a tree with drag and drop, and a tree with a context menu placed at a pointer are views. A view holds free DOM, text input that needs IME, a canvas or an editor, and a screen with a document region or an image region.
- **Sidebar section:** only declared UI can be a sidebar section. A plugin whose sidebar section must show values while none of its views is open needs its [plugin host](#plugin-host). A section that needs a view becomes a card surface, and the sidebar holds only the declared item that opens it. The `core.declared-ui.tree.expand` command is declared in `packages/workbench/exposure.json` together with its handler.
- **Module section (today):** a module section is the current form of a sidebar section. The workbench mounts the module in the section element with a context of `card`, `surface`, `orientation`, the core `icon` function, `status(name, fn)` for the statuses of the plugin, and `bind(el, name, params, options)` for its commands. The module draws its own DOM, so the workbench checks neither its elements nor its names. Rule 1 says that plugin code does not run on the workbench page, so this form is the current form until the page mount is removed.
- **Plugin host:** created only when DOM-free logic cannot be held by a view or a sidecar. Its move to the files sidecar or to a files view is examined first, and a host is created only when that move is impossible.
- The layer of a screen is not chosen by measurement.

## Pass values

Each value is judged by the measurement named in its row, on a recording and not by a timer that runs in the application.

| criterion | pass condition |
|---|---|
| (i) total | The summed footprint of N views of one plugin is at most N times the footprint of one view, plus 10 MB. |
| (ii) reclaim | Applies to a view that shares no process with another view; views that share a process are measured as one unit with them. Closing a view opened and closed with a session history that holds only its initial document returns at least 90% of its footprint within 10 seconds, in 3 repeated runs. A process held by an engine cache counts as not returned. |
| (iii) first display | First display of a view whose process is already running: the time from the view start request to the first content frame in the recording, at most the DOM mount baseline plus 300 ms, where the DOM mount baseline is the median time from the surface start request to the first content frame in the recording of the same plugin's surface mount in the main page, measured by the same recording method. The median of `page.trace.surface.mount` is the trace value of the mount, not this baseline. |
| (iii-b) first display of a new process | First display of a new process: (the time from the view start request to its first content frame in the recording) minus (the median of five process start durations, each a duration from the process request (`host.trace.view.process-request`) to the first `host.trace.view.process-ready` that the view writes when its page runtime starts) is at most the DOM mount baseline plus 300 ms, over three repeated runs, measured with the performance trace on. |
| (v) display judgment | From a recording of a card layout change, the view's content frame at its new size appears within 100 ms of the first frame of that change. |
| (vi) restart limit | When a failure event arrives, the failure time is recorded and counted at that point; no timer is used. Reaching the fourth failure within the last 300 seconds stops the restarts. Failures older than 300 seconds are not counted (sliding window). After a stop, the failure record is kept. It is cleared only when the person opens a surface that needs the process, and the process then starts again. |
| (iv) editor measurement | The footprint of the editor view and the footprint of a hidden DOM editor are measured. When the view footprint exceeds 50 MB, the editor buffer and its analysis move to a sidecar. This is a measurement rule, not a pass condition. |
| (viii) drag | During a gesture: (a) the difference between the native frame boundary and the card boundary in each frame is at most 2 pt, with the same commit and an expected value of 0; (b) the interval between consecutive content frames (frames that the view draws into its own document, shown after the view's ResizeObserver and the next requestAnimationFrame) is at most 33 ms; (c) a state where the content frame size differs from the native frame size ends within 2 frames (33 ms) after the gesture ends. |

Every plugin view meets (i), (ii), (iii), (iii-b), (v) and (viii), and the restart window check meets (vi); (iv) is measured. A failure of a mechanism value ((v), (vi), (viii)) stops the work that depends on that mechanism. A failure of a plugin value ((i), (ii), (iii), (iii-b)) stops only that plugin, and its layer or view count is reopened in a revision of this specification that goes to adversarial review; the owner decides the revision.

## Rules

1. Plugin code does not run on the workbench page.
2. **Declared UI snapshots.** A plugin view or plugin host pushes its declared UI snapshot to the workbench (push). When the main page loads, including a reload, the workbench requests the current value of each declared status once, from the source chosen for it (pull). The workbench also pulls the current value of a declared status once when its source changes, and once when the section changes orientation. A running view has no other way to send its last value to a new reader, and a value discarded for the previous orientation may be valid for the new one, which only the source holds. No other pull is made. Message names and fields are in [messages and events](#messages-and-events).
   - A status has at most one snapshot in transit.
   - A change made while a snapshot is in transit marks the status dirty. When the acknowledgement arrives, the next snapshot carries the latest value.
   - The number of skipped values is counted in `losses.skipped` of the core status `core.plugin.losses`. The count reaches the main page as the field `skipped` of each snapshot message: the number of values of the status that were overwritten while a snapshot was in transit, since the previous snapshot of the status was sent. While the performance trace is on, the main page writes `page.trace.declared-ui.snapshot.skipped {plugin, status, count}` for each overwritten value. The host relays no snapshot and writes no event for it, because `host.*` events are written only by host code.
   - When a plugin process starts (or starts again), the first snapshot of each status is the full value of that status. The workbench discards the stopped snapshot and the pending acknowledgement of the previous process. A restarted plugin builds its values from its saved state (rule 5).
   - When the view process ends or the surface closes while an acknowledgement is pending, the value is counted in `losses.stalled` and no event is written. The receiver acknowledges each snapshot at once, so only the sender in the view waits for an acknowledgement; a sender that waits ends with its view process, and a surface close also ends the view. No live observer exists, so the next process sends full values, as rule 2 states for a restarted process. A restarted process sends the latest value of each status as its first snapshot and clears the dirty mark. When the surface is closed, the dirty values are discarded and the reason says so. No timer is used.
3. **Calls across a boundary.**
   - A command declares `timeout` as stated in [exposure](exposure.md) (at most 600000 ms; 10 seconds when omitted). The timer remains for a live peer that does not reply to a command, because no event reports a slow command reply. `host.trace.view.unresponsive` reports a view process that stops answering WebKit's responsiveness check; it is not a command reply, so it does not replace the timer. When the time limit passes, the call is rejected with -32000 and `command <name> did not reply within <ms>ms`, the error that exposure.md states at its command timeout entry. This design does not change the message. `host.call.timeout {plugin, command}` is written, and `losses.timeouts` counts it.
   - A view answers a request of the main page for its command with `{sok: 1, reply: id, result}` or `{sok: 1, reply: id, error}`, which the host forwards as `view-reply` ([native surfaces](native-surfaces.md#view-surfaces), view commands). The main page applies the command's declared time limit to that request, and a reply after the limit is discarded as a late reply.
   - When the peer disappears, the call ends before its time limit through an event. The peers whose end ends a call are: a view or host process that ends, a surface that closes, and a sidecar that ends. The promise is rejected with an error that gives the reason. The reason is one of `process-ended`, `surface-closed` or `sidecar-ended`. `host.call.peer-lost {plugin, command, reason}` is written for `process-ended`, which ends the view calls that the view has open (the calls that the main page has not answered); `surface-closed` writes no event and increments `losses.peerLost`. A sidecar end follows the sidecar failure contract instead: each request with correlation identifiers that waits for a reply gets a `host.sidecar.reply` error with its surface, its sidecar and its identifiers, and each surface that sent to the sidecar gets `sidecar-failure`; a host stop or detach records the same error for each waiting request. The sidecar request carries no command, so no `host.call.peer-lost` is written for it. `host.trace.view.unresponsive` does not end a call; it is written and used only by the presentation wait of rule 6 and by the status of the view. A call ends only by its declared timeout or by one of these peers.
   - A late reply to a call that has ended is discarded. It is not passed to any promise, and no error is sent to the document that sent it. The host writes `host.trace.call.late-reply {plugin, command, delay}` and increments `losses.lateReplies`. The host-contract cases `exposure-reply.removed-surface-discarded` and `exposure.relay.foreign-document-reply-ignored-timeout-1005` state this behavior.
   - The number of open calls, including snapshots waiting for acknowledgement, and the start time of the oldest open call are exposed as the core status `core.plugin.open-calls {plugin, count, oldestStartedAt}`.
   - The relay timeout is product behavior of exposure. The two paths are: the host applies the timeout to a command forwarded to a surface page, and the main page applies the timeout to a handler that it runs itself ([exposure](exposure.md), command `timeout`). exposure.md already states both paths (its command timeout entry and its relay section).
   - Cancellation is part of the call envelope: a call carries `id`, a reply carries the same `id` with a result or an error, and a cancel carries `id`. A binary payload uses the [binary path](#binary-path).
4. **Origin and core root.**
   - Each plugin HTML runs in its own web view on `sok://<plugin id>`. The plugin id of a request comes from the view configuration, never from the request.
   - The core root is the reserved host `core`, which a plugin id cannot use. `validateManifest` rejects that name.
   - The core root serves a view of plugin A only these files. Every other path answers not found:
     - the core targets are the files of `@soksak/plugin-api` and `soksak` that the import closure of `index.js`, `view.js` and `soksak/dist/index.js` reaches, each served at `sok://core/modules/<package>/<file>`. These are core files with no plugin content, so they are served from the package's named files, and a closure test computes the set and fails when a view import is not granted;
     - the module of a granted item of plugin B to a point of A, at `sok://core/modules/<B package>/<module path>`, where `<module path>` is the `module` of that item;
     - the file that `extends.<point>.modules` maps to a specifier, for a point of A that has a granted item of another plugin, or for a point to which A contributes a granted item, at `sok://core/shared/<plugin id>.<point>/<specifier>.js`.
   - A contribution item is connected (the workbench state) when its provider is installed and enabled, its `range` contains the `version` of the point, and it matches the `schema` of the point. A contribution item is granted when its provider is installed and enabled and its `range` contains the `version` of the point, using the range parser of the installer library, which both hosts already use. The core root grants by this granted item rule only, and it does not check the schema. An item that fails its schema is reported as `invalid` by the workbench (`core.contributions`) and is not imported; its declared module file is still granted, an over-grant limited to a file that the contributor declared in its own manifest, which this specification states. Both hosts apply the granted item rule. An item whose provider declares no `extends` entry for the point, or whose entry has no `version`, is not granted; so is a provider that is not installed or not enabled, and a `module` path that the owning manifest does not name as a file of the contributor's package. A `dependencies` entry grants no file.
   - The view import map has exactly four entries: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/view` and `@soksak/shared/` mapped to `sok://core/shared/`. It has no `@soksak/runtime` or `@soksak/workbench/` entry. The map is one constant `VIEW_IMPORTS` exported by `@soksak/plugin-api`. It is a static inline `<script type="importmap">` in the page HTML, which the plugin's build writes from that constant. `@soksak/plugin-api` offers `checkViewPage(html)`, which a plugin repository test calls, and a closure test checks that every import of a view page resolves to one of its entries. The host does not inject the map.
   - The view bridge `@soksak/plugin-api/view` is the file `packages/plugin-api/view.js`. It imports nothing under `runtime/` or `@soksak/workbench/`, and it exports the view side of the call layer (`calls.js`) and of the declared UI snapshots (`snapshots.js`) over the view channel.
   - The view channel is a document-start script that the host injects into each view configuration, as the theme script of rule 8 is. It defines one message handler, named in the host contract (`sok-view`). native/darwin registers the handler `sok-view` and the injected script in the view's web view configuration for both hosts, and the host contract declares the handler name. The host delivers each host-to-view message the way a document region receives one today: native code runs `window.postMessage(message, location.origin)` in the view's page world (the form of `sp_document_post`). The injected document-start script adds the `message` listener of the view at document start, before any page script runs, and keeps each message event whose source is the window in a queue until `createViewChannel()` attaches the handler of `onMessage`; `createViewChannel()` then passes the queued messages in order and every later one. The queue holds at most 256 messages, declared in the host contract with a contract case. When a message arrives with the queue full, the script writes `error: view channel: queue full for <plugin>` to the application log through the `sok-view` handler, and the host ends the view process, so no host message is shed silently. The bound is a chosen value, not a measured one: a view attaches its channel when its first module runs, so the queue holds only the messages posted before that. No host message is dropped. The injected document-start script posts a ready message through the `sok-view` handler, carrying a document identifier that the script generates. The host records the identifier of the current document of each view, and a host message is posted only to the document whose ready message the host has recorded; a post to a view with no recorded ready message returns false, and the caller writes `error: view channel: <view> has no ready document` to the application log. A navigation clears the recorded identifier until the ready message of the new document arrives. The queue holds the messages of one document; `core.plugin.views` reports `queued`, the number of messages in that queue that wait because the view has not attached, so a view that never attaches is visible. The host marks each host message with the field `sok: 1`; the channel reports a message without the field to the application log as an error and passes it to no handler. The injected script adds one global, `sokView`, whose `attach` is the only way to read host messages. The script is `packages/plugin-api/view-start.js`. The handler name and the delivery form are declared in the host contract. `@soksak/plugin-api/view` exports `createViewChannel()`, which returns `{send, onMessage}` over that handler, and it passes them to `createCalls` and `createSnapshotSender`. The handler name and the injected script are declared in the host contract with a contract case.
   - Contributed and shared modules are one self-contained ES module each. A relative import inside one is a build error of the owning plugin, checked in that plugin's repository (see [boundary](#boundary-no-coupling)). A contributed or shared module imports bare specifiers only from the four entries of the view import map; any other bare specifier is a build error of the owning plugin.
   - The core root never delegates to the application frontend. A view receives no `/runtime/` path. `/start.json`, `/environment.json`, `/index.html`, `/runtime/...` and every other path not listed above answer not found.
   - Each response to a view carries `Access-Control-Allow-Origin: sok://<plugin id>`, with the plugin id of the view configuration. It never carries the request `Origin`, and never `*`. A refused request carries no such header. WebKit measurement (test `core_root_cors_test` in `native/darwin/tests/core_root_cors_test.m`, macOS 26.6.2 arm64): a module import from a page at `sok://probe` to `sok://core/m.js` sends `Origin: sok://probe`. The import succeeds when the response carries `Access-Control-Allow-Origin: sok://probe`, and the bare specifier of an import map that maps to the same module succeeds under that header too. The import fails with no `Access-Control-Allow-Origin` header and with `Access-Control-Allow-Origin: sok://other`, with a TypeError that reports the CORS denial. The header rule of this section is the contract that the test asserts. WebKit also accepts `*`, which this rule still never sends.
   - A request for a file of plugin B that no granted item or shared target grants answers not found and writes `error: core root: <path> is not granted to <plugin>` in both hosts. Document regions receive no core root grant.
   - The core root is served through a callback that the host contract declares and each host registers with its scheme handler, with a contract case.
   - A request from a view of plugin A for a file of plugin B that no granted item names, for a file of a plugin that A lists in `dependencies`, for `/start.json`, `/environment.json`, `/index.html` or `/runtime/...`, and for a file of a contribution item whose point the provider does not declare each answers not found.
5. **Restarts.** Sidecars, plugin hosts and view processes restart within the limit of pass value (vi). When the limit is exceeded, the host reports `error:` and stops.
   - A view process that ends is created again by the host, and the new view restores its state from its saved tab state. The limit is counted per view surface. After the limit is exceeded, the card shows the error through the error display, and the view is created again only when the person reopens the tab.
   - After the limit is exceeded, the next request fails with `sidecar-failure` (reason `restart limit`) without starting the process. The failure record is kept. It is cleared only when the person opens a surface that needs the process; the process then starts, and the host writes `host.trace.sidecar.restart-reset {sidecar, surface}`. A plugin host writes `host.trace.plugin-host.restart-reset {plugin}`.
   - The restart limit of a sidecar of standard input and output is stated in [sidecars](sidecars.md#failure), and the restart rule of a persistent service in [terminal runtime](terminal-runtime.md).
   - A restart restores the state from the last saved value. A state that was not saved is lost, and each plugin states which state that is.
   - Fault injection exists only in diagnostic builds.
6. **Presentation.** A plugin view joins the presentation wait only at the first display after a card layout change (the first change of a gesture).
   - During a continuing gesture (a divider drag or a card drag), the native frame of a view is placed at the new geometry in the same commit as its card, in every frame. The wait for content drawing applies only to the first change. Later content may draw late, and that delay is measured by frame intervals.
   - A recording of a full drag gesture gives the frame intervals and the geometry error, which pass value (viii) judges.
   - The wait ends with the first of: the presentation completion of the view; the end of the view process; the view becoming invisible when the change ends (a `hidden` ancestor, an unselected tab, a closed surface, read from the state that the workbench already reports for each surface); and an unresponsive notification from `host.trace.view.unresponsive`. When the wait ends without presentation completion, the commit continues without that view, and `host.trace.view.presentation-abandoned {surface, reason}` is written and increments `losses.abandoned`. The host writes it, because the host owns the wait: it commits the transaction and observes each end. No timer is used.
   - Pass value (v) is not a runtime deadline. It is the judgment that the measurement of each view applies.
   - [Native surfaces](native-surfaces.md) states the presentation wait of the window transaction.
7. **Input.**
   - The keyboard shortcuts of the workbench are listed with their owner and command in [keyboard shortcuts](exposure.md#keyboard-shortcuts).
   - A shortcut whose owner is the native menu reaches a core command through the menu.
   - A view registers the shortcut table with the host when it starts. The table holds each workbench shortcut and its owner. Until the table is registered, a key keeps its default action, and the view writes `page.view.shortcut-table-missing {plugin}`.
   - The view decides synchronously inside itself, using that table.
     - Only a key whose owner is the workbench has its default action prevented, and the key is passed on with the event information.
     - A key whose owner is the view is handled by the view and is not passed on.
     - A key whose owner is the native menu does not prevent the view's default action, because the menu receives it first.
     - A key that is not in the table keeps its default action.
   - When a passed command fails, the failure is written as `page.input.shortcut.failed {plugin, key, command}`, and the default action is not run again.
   - IME input goes to the first responder of the view. The input method activation check verifies it.
   - The owner of Escape and of the text input keys is the view, because the first responder of the view receives them. The menu key equivalents of the View menu (Command `=`, `-`, `0`) are native menu shortcuts that run the text size commands ([text size](text-size.md)).
   - The complete shortcut table is [keyboard shortcuts](exposure.md#keyboard-shortcuts), with the machine-readable declaration `packages/workbench/shortcuts.json`. `scripts/test/shortcut-table.test.mjs` checks it against both hosts' menu table and the workbench key handlers.

8. **Theme and accessibility.**
   - When it creates a view, the host gives the view's configuration the token set of the current theme as a document-start user script. The page's first script therefore sees the tokens.
   - Later theme changes are sent through the post path, except to a document without a recorded ready message: the host sends the current theme after each ready message, so a change before ready is neither an error nor lost. The post rule of rule 4 (false and an error) applies to every other message.
   - A native operation adds the document-start user script to the view configuration in both hosts, with a contract case. The color of the first frame of a view is the card token color.
   - Accessibility: no accessibility claim is made for a view until a window check records whether its element tree reaches the platform accessibility interface.
9. **Regions of a view.** A region of a view (a document region or an image region) attaches to the surface host of that view. Each call that places or changes a region is verified against the view id of the call envelope. Insets are relative to the view frame. The presentation of the region is in the same window transaction under rule 6.
10. **Unload and restore of a view.** Unloading a tab closes its views and their processes. Restoring the tab creates a new view from the stored state. Pass value (ii) applies to each unload.

## Messages and events

**Messages**

| message | direction | fields | note |
|---|---|---|---|
| `declared-ui.snapshot` | plugin → workbench (event) | `{plugin, status, seq, value, skipped}`; `skipped` is the count of values overwritten since the previous snapshot of the status | the push of rule 2 |
| `declared-ui.snapshot.ack` | workbench → plugin (event) | `{plugin, status, seq}` | confirms receipt; releases the in-transit slot |
| `declared-ui.snapshot.request` | workbench → plugin (call) | `{status}`; the reply is `{seq, value}`, where `seq` is the seq of the source's last declared UI snapshot, or 0 when `value` is `null` | the pull of rule 2 (load, source change, orientation). `value` is `null` when the source has no value yet |

The RPC protocol number is 1 in the 0.0 series.

**Events.** Each event name starts with its layer (`host` or `page`). Its class names its concern (`call`, `lifecycle`, `input`). Each event is declared in the [event catalog](events.json) together with the code that emits it.

| event | class | level | fields |
|---|---|---|---|
| `page.trace.declared-ui.snapshot.skipped` | call | debug | `{plugin, status, count}`: values skipped while a snapshot was in transit; counter `losses.skipped`; written by the main page |
| `host.call.timeout` | call | error | `{plugin, command}`; counter `losses.timeouts` |
| `host.call.peer-lost` | call | error | `{plugin, command, reason}` for `process-ended` (view calls); `surface-closed` writes no event and counts `losses.peerLost`; a sidecar end follows the sidecar failure contract |
| `host.trace.call.late-reply` | call | debug | `{plugin, command, delay}`; counter `losses.lateReplies` |
| `host.trace.view.unresponsive` | call | debug | `{plugin, surface}`; state `core.plugin.views.responsive` |
| `host.trace.view.responsive` | call | debug | `{plugin, surface}`; state `core.plugin.views.responsive` |
| `host.trace.view.process-request` | call | debug | `{plugin, surface}` |
| `host.trace.view.process-ready` | call | debug | `{plugin, surface}` |
| `host.trace.view.presentation-abandoned` | call | debug | `{surface, reason}`; counter `losses.abandoned`; written by the host, which owns the wait |
| `page.view.shortcut-table-missing` | input | error | `{plugin}` |
| `page.input.shortcut.failed` | input | error | `{plugin, key, command}` |
| `host.plugin-host.restart` | lifecycle | error | `{plugin, attempt}` |
| `host.plugin-host.restart-limit` | lifecycle | error | `{plugin}` |
| `host.trace.plugin-host.restart-reset` | call | debug | `{plugin}` |
| `host.trace.sidecar.restart-reset` | call | debug | `{sidecar, surface}` |

The statuses `core.plugin.open-calls`, `core.plugin.losses` and `core.plugin.views` are declared in `packages/workbench/exposure.json`. The events of this specification have level `error` or `debug` only, within the class budget of the [event catalog](events.json). The restart state of a plugin host or a sidecar is shown in `core.plugin.views` or in the sidecar status.

**Event levels in a release.** A 0.0.x release stores only error events (AGENTS.md, Diagnostic code). Each occurrence of this design is therefore classified once:
(a) a failure or a rejected operation is an event at level `error`;
(b) a loss, a skip, a transient state or a presentation degradation is not an event. It is counted in the declared status `core.plugin.losses {plugin, skipped, stalled, abandoned, lateReplies, timeouts, peerLost}`, and it is a state of the declared status `core.plugin.views {plugin, surface, responsive, queued}`. Each count is notified to status watchers when it changes. The counts are per plugin and are kept until the application ends; they are not reset when a surface closes. A surface that closes with a dirty value increments `losses.stalled` before its values are discarded, so the loss is counted in every build.
While the performance trace is on (the 디버그 switch of the settings window), each change of a count also writes the trace event named in the table. The event log of a release stores only errors.

The identifiers in code use the names as written here.
## Boundary (no coupling)

- The core of this design provides only the mechanisms: view configuration kinds, the declared UI schema and its drawing, the RPC and binary channels, the core root, the restart limit, and the contract cases.
- The view channel of rule 4 is the only transport of a view.
- The layer of each plugin, the move of a plugin state to a sidecar, and the move of an editor buffer are work of the plugin and sidecar repositories. Core code and tests do not know plugin or sidecar names, paths or implementations.
- The [plugin host](#plugin-host) of core serves a plugin whose DOM-free logic fits neither a view nor a sidecar. It is built only when the contract requires it.
- Relations are declared only by the `dependencies`, `extends` and `contributes` fields of a manifest. The core root serves a plugin's file to another plugin only for a granted item or a shared target (rule 4), which the granted item rule decides from these declarations and the installation record.
- Plugin repository requirement: the repository of each plugin that contributes a module or provides a shared module checks in its own tests that each such module is one self-contained ES module. A relative import inside one is a build error of that plugin.
- Tests:
  - Core tests verify its boundary with fake plugin fixtures.
  - Common contract cases (RPC, snapshot, restart, shortcut table) are run by the owning package, core, and by both hosts. Core publishes the fixtures that a consumer needs. Each plugin repository tests only its own modules with those fixtures; it does not run core's cases or read core's paths.
  - Measurements with real plugins and window checks are end-to-end checks of the installed environment, not package tests.
## Tabs and processes

- A view is one per tab. No public API assigns processes.
- The repository has a private policy that forces a new process (`_WKNavigationActionPolicyAllowInNewProcess`, [`webview_navigation.m`](../../native/darwin/src/webview_navigation.m), [private native APIs](../operations/private-native-apis.md)). The main web view uses this policy (`native/darwin/src/window_facts.m`). The same policy was also used to open each document in a new process, which raised navigation time from about 0.6 s to 1.1 s and lost the process-local cache, and that use was reverted. Views do not use the policy, and no private API is added for it.
- Two views of one plugin were measured under (a) the default assignment and (b) the policy assignment, with the process count, the base cost of one process and the view creation time. Views use the default assignment.
- **Measurement** (`make -C native/darwin benchmark-view-processes`, load average 17):

  | views | processes | total | per process | load (default / forced) | processes ended after close |
  |---|---|---|---|---|---|
  | 1 | 1 | 10.8 MB | 10.8 MB | 0.24 / 0.13 s | 1/1 in 0.017 s |
  | 5 | 5 | 54 MB | 10.9 MB | 0.20 / 0.28 s | 5/5 in 0.015 s |
  | 10 | 10 | 110 MB | 11.0 MB | 0.44 / 0.58 s | 10/10 in 0.036 s |
  | 20 | 20 | 220 MB | 11.0 MB | 0.81 / 1.01 s | 20/20 in 0.05 s |
  | 40 | 40 | 422 MB | 10.5 MB | 1.46 / 2.10 s | 40/40 in 0.12 s |

- WebKit gives each view of the same origin its own process under the default assignment as well. Views are not grouped.
- The total grows linearly with the view count (about 11 MB per process for a small page). Closing the views ends every process within 0.13 s, and no process is reused.
- With 5 or more views the forced policy loads slower; with 1 view it loaded faster (0.13 s against 0.24 s). Process reuse was not measured.
- A run loop driven by hand needs an autorelease pool for each iteration, and reading an item from a weak array that grows autoreleases the item. Without this, a closed view is not released, and its process appears to remain.

## Binary path

A plugin document uploads bytes by `POST sok://<plugin>/.binary` and downloads them by `GET sok://<plugin>/.binary/<id>`, where the host mints the id and the document region keeps the bytes in its binary store ([native surfaces](native-surfaces.md#document-regions)). The owner check is the `view.plugin` of the region against the URL host. An upload is at most 16 MiB, which is the clipboard bound of both hosts (`MAX_BYTES` in the darwin clipboard, `clipboardMaxBytes` in wailsv3). A page holds at most 64 MiB, which is four uploads of the largest size per page. An id is released when a download finishes, when a native take returns its bytes, or when the region closes. The `.binary` path segment is refused in a plugin release: the host answers that path before it looks up a file, so a plugin file under it would be unreachable. The release check is `validateReleaseFiles` of `@soksak/plugin-api`, and `sok plugin pack` applies the same refusal.

## Plugin host

- A platform operation creates the plugin host web view. It attaches to the window, not to a `SurfaceHost`. Its throttling while hidden and its `requestAnimationFrame` behavior are measured before a plugin uses it.
- The exposure owner key of a plugin host is `plugin:<plugin id>`, because the plugin id is the identity of a plugin ([identity](#identity)). A view needs no new key: it registers under its surface id with the owner from the plugin of its tab, as every surface does.
- A plugin host restarts within the limit of rule 5, and its state is restored from the last saved value.

## Responsiveness

The private `WKNavigationDelegatePrivate` selectors `_webViewWebProcessDidBecomeUnresponsive:` and `_webViewWebProcessDidBecomeResponsive:` are the event source of `host.trace.view.unresponsive` and `host.trace.view.responsive`; no public API exists (the SDK's `WKNavigationDelegate.h` has only `webViewWebContentProcessDidTerminate:`). [Private native APIs](../operations/private-native-apis.md) lists them with their call condition. Each new private API is listed there with its call condition by the change that adds it.

## Identity

- The sok host identifier is the plugin id.
- The mapping from plugin id to plugin name is read from the installation record and the plugin folders. [Installation](installation.md#serving-installed-plugins) states the record: `plugins/installed.json` (format 3) maps each plugin id to its recorded `path`, and the plugin name is the `name` of the `package.json` in that folder. The record does not hold the name. The writer of `plugins/installed.json` is the installation process of the application. The readers are the hosts, which serve the installed record at `/installed-plugins.json` for each request, and `sok`, which reads the file from the recorded paths.
- The `id` in `plugin.json` must equal the plugin id of the record. A mismatch is rejected with an explicit error.

## Context of a view

| entry | form in a view |
|---|---|
| `root` | removed. A view uses its own `document` |
| `icon(name)`, `params`, `origin`, `project`, `declarations` | synchronous values received at start |
| `tab.*`, `runtime.native`, `runtime.command`, `runtime.sidecar`, `runtime.clipboard`, `runtime.links`, `tab.state` | asynchronous calls |
| `runtime.theme`, `runtime.settings`, `runtime.textSize`, `status.subscribe`, `events.on` | events |
| `contributions(point)` | synchronous list of modules, imported from the core root |
| `exposure`, binder | unchanged in the view. Registration goes through the channel |
