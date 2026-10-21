# Plugin process structure

[한국어](plugin-processes.ko.md)

Status: pending proposal for F212.2. The canonical task checklist is [features](../features.md) (F212). This proposal describes work before it starts. When a contract is accepted, it moves into the specifications, and this proposal is removed after the specifications hold it.

## Decision

Plugin code runs outside the workbench page. Each plugin view is a separate web view on the `sok://<plugin id>` origin, with one view per tab. Declared UI is drawn by the workbench from [declared UI snapshots](../spec/native-surfaces.md) that the plugin sends. A plugin host exists only for DOM-free logic that neither a view nor a sidecar can hold.

Measurements do not reverse this decision. They fix the process counts, the per-plugin budgets and the pass values. When a pass value is not met, the design reopens. It does not return to mounting plugin surfaces on the workbench page.

## Reasons

- Memory: WebKit delays the full JavaScript collection in proportion to the bytes allocated since the last collection (`heap/GCActivityCallback.cpp`, `didAllocate`; features F196.20-2). Plugin code on the workbench page allocates in the same heap as the workbench, so one plugin's allocation delays collection of the workbench's garbage too. No public API shortens the delay (F196.20-2).
- Replaced documents remain in the `querySelectorAll` result cache until memory pressure (G1.4-64-1-4).
- A newly started release build's main page process held about 70 MB; after reloads the main page processes held 446.6 MB (Wails) and 399.9 MB (Tauri) (G1.4-107).
- Closing one hidden browser tab returned 227 MB (F198.5).
- Opening each document in a new process raised navigation time from 0.6 s to 1.1 s (F196.27-1, F196.27-2), and that policy was reverted.
- Failure isolation and measurement units: a plugin's failure, memory and measurements belong to its own process.

Values not yet measured are measured in F212.1 before a stage depends on them.

## Layer rules

- **Declared UI:** a sidebar section whose every element is one of list, tree, button or status-line is declared UI.
- **View:** any other screen is a view. A tree that needs inline rename, a tree with drag and drop, and a tree with a context menu placed at a pointer are views.
- **Sidebar section:** only declared UI can be a sidebar section. A plugin whose sidebar section must show values while none of its views is open needs its plugin host, so such a plugin requires F212.9. The `core.declared-ui.tree.expand` command is declared in `packages/workbench/exposure.json` together with its handler when the tree element is built (F212.8-2).
- **Module section (today):** a module section is the current form of a sidebar section. The workbench mounts the module in the section element with a context of `card`, `surface`, `orientation`, the core `icon` function, `status(name, fn)` for the statuses of the plugin, and `bind(el, name, params, options)` for its commands. The module draws its own DOM, so the workbench checks neither its elements nor its names. Rule 1 says that plugin code does not run on the workbench page, so this form is the current form until the page mount is removed (F212.11).
- **Plugin host:** created only when DOM-free logic cannot be held by a view or a sidecar. Its move to the files sidecar or to a files view is examined first, and a host is created only when that move is impossible.
- The layer of a screen is not chosen by measurement.

## Placement

| plugin | surface | section | state and logic | extension point | sidecar |
|---|---|---|---|---|---|
| editor | view (CodeMirror, IME) | – | – | imports the modules that contributing plugins declare, from the core module root | files |
| flowmark | view (free DOM) | – | – | – | existing |
| shell | view; its layer is set by item F212.10-shell-layer, completed before the shell migration | – | – | – | shell |
| files | – | declared tree | moves to the sidecar; a host only when that is impossible | – | files |
| hwp | view with a document region | – | – | – | files |
| browser | view with a document region | the four sections each become declared UI or a card surface, as set by item F212.10-browser-sections, completed before the browser migration | – | – | – |
| terminal | view with an image region and overlay screens | – | – | – | vt |

- The named items F212.10-shell-layer and F212.10-browser-sections are recorded in the checklist of the shell and browser plugin repositories. Each is completed before the F212.10 migration of its plugin. No cell of this table is left open without such an item.
- The modal page is out of scope, because no plugin uses it.
- Whether the editor buffer and its analysis move to a sidecar is set by pass value (iv).

## Pass values

The values below are fixed before stage F212.1 starts. Each value is judged by the measurement named in its row.

| criterion | pass condition |
|---|---|
| (i) total | The summed footprint of N views of one plugin is at most N times the footprint of one view, plus 10 MB. |
| (ii) reclaim | Applies to a view that shares no process with another view; views that share a process are measured as one unit with them. Closing a view opened and closed with a session history that holds only its initial document returns at least 90% of its footprint within 10 seconds, in 3 repeated runs. A process held by an engine cache counts as not returned. |
| (iii) first display | First display of a view whose process is already running: the time from the view start request to the first content frame in the recording, at most the DOM mount baseline plus 300 ms, where the DOM mount baseline is the median time from the surface start request to the first content frame in the recording of the same plugin's surface mount in the main page, measured by the same recording method. |
| (iii-b) first display of a new process | First display of a new process: (the time from the view start request to its first content frame in the recording) minus (the median of five process start durations of F212.7a, each a duration from the process request (`host.trace.view.process-request`) to the first `host.trace.view.process-ready` that the view writes when its page runtime starts; both are declared in F212.3 (class call, level debug)) is at most the DOM mount baseline plus 300 ms, over three repeated runs. F212.7a runs this measurement with the performance trace on. |
| (v) display judgment | From a recording of a card layout change, the view's content frame at its new size appears within 100 ms of the first frame of that change. Fixed before F212.7. |
| (vi) restart limit | When a failure event arrives, the failure time is recorded and counted at that point; no timer is used. Reaching the fourth failure within the last 300 seconds stops the restarts. Failures older than 300 seconds are not counted (sliding window). After a stop, the failure record is kept. It is cleared only when the person opens a surface that needs the process, and the process then starts again. |
| (iv) editor measurement | The footprint of the editor view and the footprint of a hidden DOM editor are measured. When the view footprint exceeds 50 MB, a checklist item for moving the buffer and analysis to a sidecar is added after F212.9. This is a measurement and item-addition rule, not a pass condition. |
| (viii) drag | During a gesture: (a) the difference between the native frame boundary and the card boundary in each frame is at most 2 pt, with the same commit and an expected value of 0; (b) the interval between consecutive content frames (frames that the view draws into its own document, shown after the view's ResizeObserver and the next requestAnimationFrame) is at most 33 ms; (c) a state where the content frame size differs from the native frame size ends within 2 frames (33 ms) after the gesture ends. These values are judged on a recording, not by a timer running in the application. Fixed before F212.7c. |

When a value is not met, the measured values are recorded in the checklist. A failure of an infrastructure value ((v), (vi), (viii)) stops the infrastructure items (F212.7b, F212.7c, F212.8a) and the items that depend on them (F212.8 and later). A failure of a plugin value ((i), (ii), (iii), (iii-b)) stops only that plugin's earlier items. The layer or view count of that plugin is then reopened in a new revision of this document, which goes to adversarial review. The decision on the revision belongs to the owner.

## Rules

1. Plugin code does not run on the workbench page.
2. **Declared UI snapshots.** A plugin view or plugin host pushes its declared UI snapshot to the workbench (push). When the main page loads, including a reload, the workbench requests one snapshot for each declared status of each view and host that its surfaces declare (pull). The workbench also pulls the current value of a declared status once when its source changes, and once when the section changes orientation. A running view has no other way to send its last value to a new reader, and a value discarded for the previous orientation may be valid for the new one, which only the source holds. No other pull is made. Message names and fields are in [messages and events](#messages-and-events).
   - A status has at most one snapshot in transit.
   - A change made while a snapshot is in transit marks the status dirty. When the acknowledgement arrives, the next snapshot carries the latest value.
   - The number of skipped values is counted in `losses.skipped` of the core status `core.plugin.losses`. The count reaches the main page as the field `skipped` of each snapshot message: the number of values of the status that were overwritten while a snapshot was in transit, since the previous snapshot of the status was sent. While the performance trace is on, the main page writes `page.trace.declared-ui.snapshot.skipped {plugin, status, count}` for each overwritten value. The host relays no snapshot and writes no event for it, because `host.*` events are written only by host code.
   - When a plugin process starts (or starts again), the first snapshot of each status is the full value of that status. The workbench discards the stopped snapshot and the pending acknowledgement of the previous process. A restarted plugin builds its values from its saved state (rule 5).
   - When the view process ends or the surface closes while an acknowledgement is pending, the value is counted in `losses.stalled` and no event is written. The receiver acknowledges each snapshot at once, so only the sender in the view waits for an acknowledgement; a sender that waits ends with its view process, and a surface close also ends the view. No live observer exists, so the next process sends full values, as rule 2 states for a restarted process. A restarted process sends the latest value of each status as its first snapshot and clears the dirty mark. When the surface is closed, the dirty values are discarded and the reason says so. No timer is used.
3. **Calls across a boundary.**
   - A command declares `timeout` as stated in [exposure](../spec/exposure.md) (at most 600000 ms; 10 seconds when omitted). The timer remains for a live peer that does not reply to a command, because no event reports a slow command reply. `host.trace.view.unresponsive` reports a view process that stops answering WebKit's responsiveness check; it is not a command reply, so it does not replace the timer. When the time limit passes, the call is rejected with -32000 and `command <name> did not reply within <ms>ms`, the error that exposure.md states at its command timeout entry. This design does not change the message. `host.call.timeout {plugin, command}` is written, and `losses.timeouts` counts it.
   - A view answers a request of the main page for its command with `{sok: 1, reply: id, result}` or `{sok: 1, reply: id, error}`, which the host forwards as `view-reply` ([native surfaces](../spec/native-surfaces.md#view-surfaces), view commands). The main page applies the command's declared time limit to that request, and a reply after the limit is discarded as a late reply.
   - When the peer disappears, the call ends before its time limit through an event. The peers whose end ends a call are: a view or host process that ends, a surface that closes, and a sidecar that ends. The promise is rejected with an error that gives the reason. The reason is one of `process-ended`, `surface-closed` or `sidecar-ended`. `host.call.peer-lost {plugin, command, reason}` is written for `process-ended`, which ends the view calls that the view has open (the calls that the main page has not answered); `surface-closed` writes no event and increments `losses.peerLost`. A sidecar end follows the sidecar failure contract instead: each request with correlation identifiers that waits for a reply gets a `host.sidecar.reply` error with its surface, its sidecar and its identifiers, and each surface that sent to the sidecar gets `sidecar-failure`; a host stop or detach records the same error for each waiting request. The sidecar request carries no command, so no `host.call.peer-lost` is written for it. `host.trace.view.unresponsive` does not end a call; it is written and used only by the presentation wait of rule 6 and by the status of the view. A call ends only by its declared timeout or by one of these peers.
   - A late reply to a call that has ended is discarded. It is not passed to any promise, and no error is sent to the document that sent it. The host writes `host.trace.call.late-reply {plugin, command, delay}` and increments `losses.lateReplies`. The host-contract cases `exposure-reply.removed-surface-discarded` and `exposure.relay.foreign-document-reply-ignored-timeout-1005` state this behavior.
   - The number of open calls, including snapshots waiting for acknowledgement, and the start time of the oldest open call are exposed as the core status `core.plugin.open-calls {plugin, count, oldestStartedAt}`. The name and location are fixed here; F212.3 declares the status.
   - The relay timeout is product behavior of exposure. The two paths are: the host applies the timeout to a command forwarded to a surface page, and the main page applies the timeout to a handler that it runs itself ([exposure](../spec/exposure.md), command `timeout`). exposure.md already states both paths (its command timeout entry and its relay section).
   - Cancellation is part of the call envelope. A binary payload uses a separate channel (open item 2).
4. **Origin and core root.**
   - Each plugin HTML runs in its own web view on `sok://<plugin id>`. The plugin id of a request comes from the view configuration, never from the request.
   - The core root is the reserved host `core`, which a plugin id cannot use. `validateManifest` rejects that name. The reserved-id check (F212.5-9) is completed before the core root resolver of F212.5-6.
   - The core root serves a view of plugin A only these files. Every other path answers not found:
     - the core targets are the files of `@soksak/plugin-api` and `soksak` that the import closure of `index.js`, `view.js` and `soksak/dist/index.js` reaches, each served at `sok://core/modules/<package>/<file>`. These are core files with no plugin content, so they are served from the package's named files, and the closure test (F212.5-4) computes the set and fails when a view import is not granted;
     - the module of a granted item of plugin B to a point of A, at `sok://core/modules/<B package>/<module path>`, where `<module path>` is the `module` of that item;
     - the file that `extends.<point>.modules` maps to a specifier, for a point of A that has a granted item of another plugin, or for a point to which A contributes a granted item, at `sok://core/shared/<plugin id>.<point>/<specifier>.js`.
   - A contribution item is connected (the workbench state) when its provider is installed and enabled, its `range` contains the `version` of the point, and it matches the `schema` of the point. A contribution item is granted when its provider is installed and enabled and its `range` contains the `version` of the point, using the range parser of the installer library, which both hosts already use. The core root grants by this granted item rule only, and it does not check the schema. An item that fails its schema is reported as `invalid` by the workbench (`core.contributions`) and is not imported; its declared module file is still granted, an over-grant limited to a file that the contributor declared in its own manifest, which the design states. F212.5-3 implements the granted item rule in both hosts. An item whose provider declares no `extends` entry for the point, or whose entry has no `version`, is not granted; so is a provider that is not installed or not enabled, and a `module` path that the owning manifest does not name as a file of the contributor's package. A `dependencies` entry grants no file.
   - The view import map has exactly four entries: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/view` and `@soksak/shared/` mapped to `sok://core/shared/`. It has no `@soksak/runtime` or `@soksak/workbench/` entry. The map is one constant `VIEW_IMPORTS` exported by `@soksak/plugin-api`. It is a static inline `<script type="importmap">` in the page HTML, which the plugin's build writes from that constant. `@soksak/plugin-api` offers `checkViewPage(html)`, which a plugin repository test calls, and a closure test checks that every import of a view page resolves to one of its entries. The host does not inject the map.
   - The view bridge `@soksak/plugin-api/view` is the file `packages/plugin-api/view.js`. It imports nothing under `runtime/` or `@soksak/workbench/`, and it exports the view side of the call layer (`calls.js`) and of the declared UI snapshots (`snapshots.js`) over the view channel.
   - The view channel is a document-start script that the host injects into each view configuration, as the theme script of rule 8 is. It defines one message handler, named in the host contract (`sok-view`). native/darwin registers the handler `sok-view` and the injected script in the view's web view configuration for both hosts, and the host contract declares the handler name. The host delivers each host-to-view message the way a document region receives one today: native code runs `window.postMessage(message, location.origin)` in the view's page world (the form of `sp_document_post`). The injected document-start script adds the `message` listener of the view at document start, before any page script runs, and keeps each message event whose source is the window in a queue until `createViewChannel()` attaches the handler of `onMessage`; `createViewChannel()` then passes the queued messages in order and every later one. The queue holds at most 256 messages, declared in the host contract with a contract case. When a message arrives with the queue full, the script writes `error: view channel: queue full for <plugin>` to the application log through the `sok-view` handler, and the host ends the view process, so no host message is shed silently. The bound is a chosen value, not a measured one: a view attaches its channel when its first module runs, so the queue holds only the messages posted before that, and F212.5-4 and F212.5-7 record the largest queue length that they observe. No host message is dropped. The injected document-start script posts a ready message through the `sok-view` handler, carrying a document identifier that the script generates. The host records the identifier of the current document of each view, and a host message is posted only to the document whose ready message the host has recorded; a post to a view with no recorded ready message returns false, and the caller writes `error: view channel: <view> has no ready document` to the application log. A navigation clears the recorded identifier until the ready message of the new document arrives. F212.5-4 tests the ready message with a fake handler, and F212.5-7 tests a post during a navigation in a window check. F212.5-4 tests the queue with a message delivered before `createViewChannel()` is called, and F212.5-7 tests the delivery of the first pull in a window check. The queue holds the messages of one document; `core.plugin.views` reports `queued`, the number of messages in that queue that wait because the view has not attached, so a view that never attaches is visible. The host marks each host message with the field `sok: 1`; the channel reports a message without the field to the application log as an error and passes it to no handler. The injected script adds one global, `sokView`, whose `attach` is the only way to read host messages. The script is `packages/plugin-api/view-start.js`. The handler name and the delivery form are declared in the host contract, and F212.5-4 tests `createViewChannel()` with a fake handler in both directions. `@soksak/plugin-api/view` exports `createViewChannel()`, which returns `{send, onMessage}` over that handler, and it passes them to `createCalls` and `createSnapshotSender`. The handler name and the injected script are declared in the host contract with a contract case. The view configuration exists only with F212.7, so F212.5-4 tests `createViewChannel()` with a fake handler, and F212.7 connects it to the host.
   - Contributed and shared modules are one self-contained ES module each. A relative import inside one is a build error of the owning plugin, checked in that plugin's repository (see [boundary](#boundary-no-coupling)). A contributed or shared module imports bare specifiers only from the four entries of the view import map; any other bare specifier is a build error of the owning plugin.
   - The core root never delegates to the application frontend. A view receives no `/runtime/` path. `/start.json`, `/environment.json`, `/index.html`, `/runtime/...` and every other path not listed above answer not found.
   - Each response to a view carries `Access-Control-Allow-Origin: sok://<plugin id>`, with the plugin id of the view configuration. It never carries the request `Origin`, and never `*`. A refused request carries no such header. WebKit measurement (F212.5-2, test `core_root_cors_test` in `native/darwin/tests/core_root_cors_test.m`, macOS 26.6.2 arm64): a module import from a page at `sok://probe` to `sok://core/m.js` sends `Origin: sok://probe`. The import succeeds when the response carries `Access-Control-Allow-Origin: sok://probe`, and the bare specifier of an import map that maps to the same module succeeds under that header too. The import fails with no `Access-Control-Allow-Origin` header and with `Access-Control-Allow-Origin: sok://other`, with a TypeError that reports the CORS denial. The header rule of this section is the contract that the test asserts. WebKit also accepts `*`, which this rule still never sends.
   - A request for a file of plugin B that no granted item or shared target grants answers not found and writes `error: core root: <path> is not granted to <plugin>` in both hosts. Document regions receive no core root grant.
   - The core root is served through a callback that the host contract declares and each host registers with its scheme handler, with a contract case (F212.5-6).
   - Red test: a request from a view of plugin A for a file of plugin B that no granted item names, for a file of a plugin that A lists in `dependencies`, and for `/start.json`, `/environment.json`, `/index.html` or `/runtime/...`, each receives not found, and a file of a contribution item whose point the provider does not declare receives not found.
5. **Restarts.** Sidecars, plugin hosts and view processes restart within the limit of pass value (vi). When the limit is exceeded, the host reports `error:` and stops.
   - A view process that ends is created again by the host, and the new view restores its state from its saved tab state. The limit is counted per view surface. After the limit is exceeded, the card shows the error through the error display, and the view is created again only when the person reopens the tab.
   - After the limit is exceeded, the next request fails with `sidecar-failure` (reason `restart limit`) without starting the process. The failure record is kept. It is cleared only when the person opens a surface that needs the process; the process then starts, and the host writes `host.trace.sidecar.restart-reset {sidecar, surface}`. A plugin host writes `host.trace.plugin-host.restart-reset {plugin}`.
   - This rule changes two specification locations. The `## Failure` section of [sidecars](../spec/sidecars.md) at line 67 states that the next request after a failure starts a new process without a limit. F212.8a replaces that sentence with the limit of rule 5. The restart rule that [terminal runtime](../spec/terminal-runtime.md) states at line 43 (one attempt per disconnect, with the next send retrying the same path) changes in F212.8a as well.
   - A restart restores the state from the last saved value. A state that was not saved is lost, and each plugin states which state that is.
   - Fault injection exists only in diagnostic builds.
6. **Presentation.** A plugin view joins the presentation wait only at the first display after a card layout change (the first change of a gesture).
   - During a continuing gesture (a divider drag or a card drag), the native frame of a view is placed at the new geometry in the same commit as its card, in every frame. The wait for content drawing applies only to the first change. Later content may draw late, and that delay is measured by frame intervals.
   - F212.7c records a full drag gesture, measures the frame intervals and the geometry error, and judges them with pass value (viii).
   - The wait ends with the first of: the presentation completion of the view; the end of the view process; the view becoming invisible when the change ends (a `hidden` ancestor, an unselected tab, a closed surface, read from the state that the workbench already reports for each surface); and an unresponsive notification from `host.trace.view.unresponsive`. When the wait ends without presentation completion, the commit continues without that view, and `host.trace.view.presentation-abandoned {surface, reason}` is written and increments `losses.abandoned`. The host writes it, because the host owns the wait: it commits the transaction and observes each end. No timer is used.
   - Pass value (v) is not a runtime deadline. It is the judgment that F212.7b and each plugin item measure.
   - F212.7b records a card entering full screen and a tab change for a card with a view, and checks that both waits end.
   - [native surfaces](../spec/native-surfaces.md) is corrected for this rule.
7. **Input.**
   - The keyboard shortcuts of the workbench are listed with their owner and command in [keyboard shortcuts](../spec/exposure.md#keyboard-shortcuts).
   - A shortcut whose owner is the native menu reaches a core command through the menu.
   - A view registers the shortcut table with the host when it starts. The table holds each workbench shortcut and its owner. Until the table is registered, a key keeps its default action, and the view writes `page.view.shortcut-table-missing {plugin}`.
   - The view decides synchronously inside itself, using that table.
     - Only a key whose owner is the workbench has its default action prevented, and the key is passed on with the event information.
     - A key whose owner is the view is handled by the view and is not passed on.
     - A key whose owner is the native menu does not prevent the view's default action, because the menu receives it first.
     - A key that is not in the table keeps its default action.
   - When a passed command fails, the failure is written as `page.input.shortcut.failed {plugin, key, command}`, and the default action is not run again.
   - F212.6a measures the round trip of Escape against the menu close before F212.7 starts and records the result. The owner of Escape is the view; the measurement does not choose it.
   - IME input goes to the first responder of the view. The activation check (F212.13) verifies it.

   - The owner of Escape and of the text input keys is the view, because the first responder of the view receives them. The menu key equivalents of the View menu (Command `=`, `-`, `0`) are native menu shortcuts that run the text size commands ([text size](../spec/text-size.md)).
   - The complete shortcut table is [keyboard shortcuts](../spec/exposure.md#keyboard-shortcuts), with the machine-readable declaration `packages/workbench/shortcuts.json`. `scripts/test/shortcut-table.test.mjs` checks it against both hosts' menu table and the workbench key handlers.

8. **Theme and accessibility.**
   - When it creates a view, the host gives the view's configuration the token set of the current theme as a document-start user script. The page's first script therefore sees the tokens.
   - Later theme changes are sent through the post path, except to a document without a recorded ready message: the host sends the current theme after each ready message, so a change before ready is neither an error nor lost. The post rule of rule 4 (false and an error) applies to every other message.
   - F212.7d compares the color of the first frame with the card token color. The document-start user script is open item 9.
   - Accessibility: F212.12 records whether the element tree of a view reaches the platform accessibility interface. Until a check exists, no accessibility claim is made.
9. **Regions of a view.** A region of a view (a document region or an image region) attaches to the surface host of that view. Each call that places or changes a region is verified against the view id of the call envelope. Insets are relative to the view frame. The presentation of the region is in the same window transaction under rule 6. F212.7 names the contract cases for this rule.
10. **Unload and restore of a view.** Unloading a tab closes its views and their processes. Restoring the tab creates a new view from the stored state. Pass value (ii) applies to each unload.

## Messages and events

**Messages**

| message | direction | fields | note |
|---|---|---|---|
| `declared-ui.snapshot` | plugin → workbench (event) | `{plugin, status, seq, value, skipped}`; `skipped` is the count of values overwritten since the previous snapshot of the status | the push of rule 2 |
| `declared-ui.snapshot.ack` | workbench → plugin (event) | `{plugin, status, seq}` | confirms receipt; releases the in-transit slot |
| `declared-ui.snapshot.request` | workbench → plugin (call) | `{status}`; the reply is `{seq, value}` | the load pull of rule 2. `value` is `null` when the source has no value yet |

The RPC protocol number is 1 in the 0.0 series.

**Events.** Each event name starts with its layer (`host` or `page`). Its class names its concern (`call`, `lifecycle`, `input`). The events are declared in F212.3, except `host.trace.sidecar.restart-reset`, which F212.8a declares.

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
| `host.trace.view.presentation-abandoned` | call | debug | `{surface, reason}`; counter `losses.abandoned` |
| `page.view.shortcut-table-missing` | input | error | `{plugin}` |
| `page.input.shortcut.failed` | input | error | `{plugin, key, command}` |
| `host.plugin-host.restart` | lifecycle | error | `{plugin, attempt}` |
| `host.plugin-host.restart-limit` | lifecycle | error | `{plugin}` |
| `host.trace.plugin-host.restart-reset` | call | debug | `{plugin}` |
| `host.trace.sidecar.restart-reset` | call | debug | `{sidecar, surface}`, declared by F212.8a |

F212.3 declares the statuses `core.plugin.open-calls`, `core.plugin.losses` and `core.plugin.views`. The events of this design are declared with level `error` or `debug` only; check the class budget in [events](../spec/events.json) before writing catalog entries (F212.3). The restart state of a plugin host or a sidecar is shown in `core.plugin.views` or in the sidecar status.

**Event levels in a release.** A 0.0.x release stores only error events (AGENTS.md, Diagnostic code). Each occurrence of this design is therefore classified once:
(a) a failure or a rejected operation is an event at level `error`;
(b) a loss, a skip, a transient state or a presentation degradation is not an event. It is counted in the declared status `core.plugin.losses {plugin, skipped, stalled, abandoned, lateReplies, timeouts, peerLost}`, and it is a state of the declared status `core.plugin.views {plugin, surface, responsive, queued}`. Each count is notified to status watchers when it changes. The counts are per plugin and are kept until the application ends; they are not reset when a surface closes. A surface that closes with a dirty value increments `losses.stalled` before its values are discarded, so the loss is counted in every build.
While the performance trace is on (the 디버그 switch of the settings window), each change of a count also writes the trace event named in the table. The event log of a release stores only errors.

The identifiers in code use the names as written here.

## Boundary (no coupling)

- The core of this design provides only the mechanisms: view configuration kinds, the declared UI schema and its drawing, the RPC and binary channels, the core root, the restart limit, and the contract cases.
- The view channel of rule 4 is the only transport of a view.
- The plugin table above is the input of the migration items in each plugin repository's checklist. Core code and tests do not know plugin or sidecar names, paths or implementations.
  - Moving the files state to a sidecar is an item of the files plugin and files sidecar repositories.
  - Whether the editor buffer moves is an item of the editor repository.
- Core F212.9 is the plugin host mechanism for a plugin whose DOM-free logic fits neither a view nor a sidecar. It is built only when the contract requires it.
- Relations are declared only by the `dependencies`, `extends` and `contributes` fields of a manifest. The core root serves a plugin's file to another plugin only for a granted item or a shared target (rule 4), which the granted item rule decides from these declarations and the installation record.
- Plugin repository requirement: the repository of each plugin that contributes a module or provides a shared module checks in its own tests that each such module is one self-contained ES module. A relative import inside one is a build error of that plugin.
- Tests:
  - Core tests verify its boundary with fake plugin fixtures.
  - Common contract cases (RPC, snapshot, restart, shortcut table) are run by the owning package, core, and by both hosts. Core publishes the fixtures that a consumer needs. Each plugin repository tests only its own modules with those fixtures; it does not run core's cases or read core's paths.
  - Measurements with real plugins and window checks (F212.1, F212.7a, F212.12, F212.14) are end-to-end checks of the installed environment, not package tests.

## Tabs and processes

- A view is one per tab. No public API assigns processes.
- The repository has a private policy that forces a new process (`_WKNavigationActionPolicyAllowInNewProcess`, [`webview_navigation.m`](../../native/darwin/src/webview_navigation.m), [private native APIs](../operations/private-native-apis.md)). The main web view uses this policy (`native/darwin/src/window_facts.m:43-44`). The same policy was also used to open each document in a new process, which raised navigation time from about 0.6 s to 1.1 s and lost the process-local cache, and that use was reverted (F196.27-1, F196.27-2). Views do not use the policy, because the F212.1 measurement showed no gain for them.
- F212.1 measures two views of one plugin under (a) the default assignment and (b) the policy assignment, and records the process count, the base cost of one process and the view creation time. The choice between them is made in F212.2 (this document). Under the default assignment the policy is not used, so no private API is added for it.
- **Measurement** (F212.1, `make -C native/darwin benchmark-view-processes`, load average 17):

  | views | processes | total | per process | load (default / forced) | processes ended after close |
  |---|---|---|---|---|---|
  | 1 | 1 | 10.8 MB | 10.8 MB | 0.24 / 0.13 s | 1/1 in 0.017 s |
  | 5 | 5 | 54 MB | 10.9 MB | 0.20 / 0.28 s | 5/5 in 0.015 s |
  | 10 | 10 | 110 MB | 11.0 MB | 0.44 / 0.58 s | 10/10 in 0.036 s |
  | 20 | 20 | 220 MB | 11.0 MB | 0.81 / 1.01 s | 20/20 in 0.05 s |
  | 40 | 40 | 422 MB | 10.5 MB | 1.46 / 2.10 s | 40/40 in 0.12 s |

- WebKit gives each view of the same origin its own process under the default assignment as well. This design does not group them.
- The total grows linearly with the view count (about 11 MB per process for a small page). Closing the views ends every process within 0.13 s, and no process is reused.
- With 5 or more views the forced policy loads slower; with 1 view it loaded faster (0.13 s against 0.24 s). Process reuse was not measured. The default assignment is used for views.
- Finding during measurement: a run loop driven by hand needs an autorelease pool for each iteration, and reading an item from a weak array that grows autoreleases the item. Without this, a closed view is not released, and its process appears to remain.
- If pass value (i) is not met, the layer or view count of that plugin is reopened in a new revision of this document, which goes to adversarial review. The owner decides the revision.

## Existing base and open items

**Present**

- Document region: a separate WKWebView, inset placement, input and focus, theme, memory saving and restore, and `sok://` files.
- JSON channel `post` and `document-message` (`document_view.m:39,855`, `surface-modules.js:98-100`, `documents.go:41`, `documents.rs:42`).
- Exposure delivery (`exposure.js:95,108`).
- The separate document runtime frame (`page.js`).

**Open items**

1. [native surfaces](../spec/native-surfaces.md) line 113 says region documents receive "no application bridge", and line 115 describes the `post` channel. The correction states that a region document receives no bridge, and that its messages are only `window.postMessage` with the origin checked, which the host sends and receives. The correction is made in F212.4.
2. Call ids, acknowledgements and cancellation are added to the call envelope: a call carries `id`, a reply carries the same `id` with a result or an error, and a cancel carries `id`. The binary path is native in F212.4, on the two hosts. Decision (F212.4-2): a plugin document uploads bytes by `POST sok://<plugin>/.binary` and downloads them by `GET sok://<plugin>/.binary/<id>`, where the host mints the id and the document region keeps the bytes in its binary store ([native surfaces](../spec/native-surfaces.md#document-regions)). The owner check is the `view.plugin` of the region against the URL host. An upload is at most 16 MiB, which is the clipboard bound of both hosts (`MAX_BYTES` in the darwin clipboard, `clipboardMaxBytes` in wailsv3). A page holds at most 64 MiB, which is four uploads of the largest size per page. An id is released when a download finishes, when a native take returns its bytes, or when the region closes. The `.binary` path segment is refused in a plugin release: the host answers that path before it looks up a file, so a plugin file under it would be unreachable. The release check is `validateReleaseFiles` of `@soksak/plugin-api`, and `sok plugin pack` applies the same refusal in F212.4-4.
3. A platform operation creates the plugin host web view. It attaches to the window, not to a `SurfaceHost`. Its throttling while hidden and its `requestAnimationFrame` behavior are measured in F212.1 and F212.9a.
4. Wails has no call path to a web view that the application creates (H3). The path is made in the Objective-C host, and the contract cases verify that both hosts behave the same way (F212.4).
5. The core root is built in F212.5-4 and F212.5-6, and its scheme is served in F212.5-7. It uses no copy and no link.
6. The view import map is one constant `VIEW_IMPORTS` of `@soksak/plugin-api`, written into each view page by the plugin's build as an inline importmap and checked by `checkViewPage` and a closure test in F212.5-4 (rule 4). Document regions receive no core root grant.
7. The exposure owner key of a plugin host is `plugin:<plugin id>`. A view needs no new key: it registers under its surface id with the owner from the plugin of its tab, as every surface does (F212.6-3). The key uses the plugin id, which is the identity of a plugin (see [identity](#identity)).
8. Each new private API is listed in [private native APIs](../operations/private-native-apis.md) with its call condition in the stage that adds it. The unresponsive selectors of open item 10 are listed in F212.3. No other new private API is decided in this document.
9. A native operation adds the document-start user script to the view configuration, on both hosts, with a contract case (F212.7d).
10. Decision: the private `WKNavigationDelegatePrivate` selectors `_webViewWebProcessDidBecomeUnresponsive:` and `_webViewWebProcessDidBecomeResponsive:` are the event source; no public API exists (the SDK's `WKNavigationDelegate.h` has only `webViewWebContentProcessDidTerminate:`). They are not declared yet. F212.3 adds them to `native/darwin/src/private/webkit.h` and to [private native APIs](../operations/private-native-apis.md) with the call condition and the source lines read from the WebKit source of the SDK revision in use (ResponsivenessTimer, its default and its trigger). Rule 6 uses them only after that record exists.

## Identity

- The sok host identifier is the plugin id.
- The mapping from plugin id to plugin name is read from the installation record and the plugin folders. [Installation](../spec/installation.md#serving-installed-plugins) states the record: `plugins/installed.json` (format 3) maps each plugin id to its recorded `path`, and the plugin name is the `name` of the `package.json` in that folder. The record does not hold the name. The writer of `plugins/installed.json` is the installation process of the application. The readers are the hosts, which serve the installed record at `/installed-plugins.json` for each request, and `sok`, which reads the file from the recorded paths.
- The `id` in `plugin.json` must equal the plugin id of the record. A mismatch is rejected with an explicit error.
- Fixes: `index.js:1127` in pagePackage, `page.js:78` and `page.js:169` are changed to use the mapping. A Red test covers a plugin whose id and plugin name differ.

## Context entries

| entry | new form |
|---|---|
| `root` | removed. A view uses its own `document` |
| `icon(name)`, `params`, `origin`, `project`, `declarations` | synchronous values received at start |
| `tab.*`, `runtime.native`, `runtime.command`, `runtime.sidecar`, `runtime.clipboard`, `runtime.links`, `tab.state` | asynchronous calls |
| `runtime.theme`, `runtime.settings`, `runtime.textSize`, `status.subscribe`, `events.on` | events |
| `contributions(point)` | synchronous list of modules, imported from the core root |
| `exposure`, binder | unchanged in the view. Registration goes through the channel |

## Steps

Each step is one checklist item with one unit of function: specification, Red, implementation, Green, record, commit. The main branch is green after each step that merges. The items F212.7, F212.7b, F212.7d, F212.10-editor, F212.7a, F212.7c, F212.8, F212.8a, F212.9 and F212.9a are developed on the branch `feat/view-kind-F212.7`, one checklist item per commit, and main keeps the `dom` kind until the branch is merged. The branch is merged once, after F212.9a and the migrations of every plugin that declares `dom` are merged into their repositories and verified against the branch build. Plugin releases with an `engines.soksak` range are not published before the core release of F212.15; each plugin release is a checklist item of its plugin repository, recorded as unreleased until F212.15 publishes the core version it requires.

Step order: F212.7, F212.7b, F212.7d, F212.10-editor, F212.7a, F212.7c, F212.8, F212.8a, F212.9, F212.9a, F212.10 (other plugins), F212.11 to F212.15. F212.7c measures the editor view created by F212.10-editor, so it follows F212.10-editor and F212.7a. F212.7a and F212.7c both depend on F212.10-editor.

1. **F212.1 Measurement.** WebContent totals per window; base cost of a web view; cost and throttle of a plugin host; DOM editor and flowmark with memory saving on and off, and the same screen as a view; two views of one plugin under (a) and (b); process-sharing pairs (two views of one plugin, two plugins, a view and a document region of one plugin); the main page of two windows; the DOM mount time of every surface plugin in the installed record (page trace, recorded with the plugin version; the (iii) baseline is F212.1-3); the first display time, the first status time, and the start time of a new WebContent process. The page writes `page.trace.surface.mount {plugin, surface, ms}` at each surface mount when the trace is on, and `make events-check` compares the workbench `trace(` calls with the catalog.
   - **F212.1-3:** the recorded DOM mount baseline of every installed surface plugin (first content frame in a recording), the baseline of (iii). The median of F212.1-2 (`page.trace.surface.mount`) is the trace value of the mount, not the (iii) baseline.
2. **F212.2 Design document.** This document and its Korean translation. The review result is recorded in [objections answered](#objections-answered).
3. **F212.3 Call message layer (plugin-api).** Declares the events of [messages and events](#messages-and-events) in the event catalog, except `host.trace.sidecar.restart-reset` (declared by F212.8a); declares the statuses `core.plugin.open-calls`, `core.plugin.losses` and `core.plugin.views`; adds the unresponsive selectors to `native/darwin/src/private/webkit.h` and to [private native APIs](../operations/private-native-apis.md) with the call condition and the source lines read from the WebKit source of the SDK revision in use (open item 10); and runs `make events-check`.
4. **F212.4 Binary path** (native code and both hosts).
5. **F212.5 Core root and view import map.** Changes `/modules` and `/shared` in [installation](../spec/installation.md) and adds the core root paths of rule 4. The items are F212.5-1 (design), F212.5-2 (the WebKit Origin measurement, before the CORS rule is final), F212.5-3 (the granted item rule in `packages/sok`), F212.5-4 (the view bridge, the view channel and the import map constant), F212.5-5 (the page origin), F212.5-9 (the reserved-id check), F212.5-6 (the resolver, after the reserved-id check of F212.5-9), F212.5-7 (the native scheme) and F212.5-8 (the level of refused page requests).
6. **F212.6 Identity and exposure registration.** Adds the plugin id mapping and the exposure registration.
   - **F212.6a:** shortcut table. Measures the round trip of Escape against the menu close and records the result; the owner of Escape is the view and the measurement does not choose it. It then adds every other workbench shortcut from both hosts' menu declarations and workbench key handlers to the table of rule 7. It is completed before F212.7.
7. **F212.7 View configuration kinds** (manifest, workbench, native placement, and the `view` composition kind). F212.7 adds the `view` kind and removes `dom` in one commit on the branch `feat/view-kind-F212.7`. The plugins migrate in their F212.10 items against that branch, and their migrations are merged into their repositories without a release. The merge of the branch to main happens before F212.10 releases, and the plugin releases follow F212.15. After the merge, the reader rejects `dom` with an explicit error that names the plugin and the manifest field. Rollback is by plugin release with the previous `engines` range, not by a second reader form. Rules 9 and 10 are implemented here, the view channel of rule 4 is connected to both hosts here, and F212.7 names their contract cases.
   - **F212.7b:** presentation wait participation and budget (v).
   - **F212.7d:** first-frame theme user script (open item 9).
   - **F212.10-editor:** the editor plugin migrates to a view (its own repository item), before F212.7a and F212.7c.
   - **F212.7a:** after F212.10-editor, the editor view measures (i), (ii), (iii), (iii-b), (v); (viii) is measured by F212.7c, which runs after F212.7a. It runs (iii-b) with the performance trace on.
   - **F212.7c:** drag recording and geometry error (viii). The first view (the editor view of F212.10-editor) is the measured view. Every plugin view is measured in its own F212.10 item and in F212.14. It follows F212.10-editor and F212.7a.
8. **F212.8** Declared UI schema and drawing in the workbench, including sidebar sections.
   - **F212.8a:** restart limit (vi) in the `## Failure` section of [sidecars](../spec/sidecars.md) and in [terminal runtime](../spec/terminal-runtime.md) line 43, and their translations. Red tests in the host packages that own sidecar failure (Go, Rust, and the contract cases). F212.8a precedes F212.9. It declares `host.trace.sidecar.restart-reset`.
9. **F212.9** Plugin host mechanism (platform operation, owner key, restart). The files repository first completes its item that moves the state to a sidecar. A host is built only when a plugin still needs it.
   - **F212.9a:** when a plugin host is built, its footprint and throttle are measured before F212.10.
10. **F212.10** Plugin migrations (one item per plugin repository, with `engines.soksak`). The named items F212.10-shell-layer and F212.10-browser-sections are completed before the shell and browser migrations. Each plugin item measures (iii), (v) and (viii) for its views before its release.
11. **F212.11** Removal of the remaining page-mount code paths only (page mount, parking, section and state mounts on the page).
12. **F212.12** Window checks by function (display, input and focus, drag, restart). One item per function.
13. **F212.13** IME activation check (with the user's approval).
14. **F212.14** At the final layout, every plugin view is measured again for (i), (ii), (iii), (iii-b) and (v), and every plugin view is measured for (viii). (vi) is covered by the restart window check of F212.12.
15. **F212.15** Core release. The plugin releases of F212.10 are published after this release, each with the `engines.soksak` range of the core version it requires.

## Verification

- Each item: the unit Red and Green tests of the owning module, and the structural checks that the change touches. A full suite is not run to complete an item.
- Completion: (i), (ii), (iii), (iii-b), (v), (vi) and (viii) must pass. (iv) must be measured; when it is over its limit, the follow-up item must exist in the checklist.

## Rollback

- A core stage is rolled back only after the plugin releases that require it are rolled back to their previous `engines` range and released. Each F212.10 plugin release is rolled back by its previous `engines` range.
- Order: stages F212.3 to F212.6 add mechanisms and do not change the behavior of existing plugins, so they are rolled back by reverting their commits. Stages F212.7 to F212.9, with F212.10-editor, are rolled back after any plugin release that uses them is rolled back. Stage F212.10 is rolled back by releasing each plugin with its previous `engines` range. Stage F212.11 removes the old paths; it is rolled back by reverting its commit only after F212.10 is rolled back.
- The rollback order of each stage is recorded in the checklist item of that stage when the stage is written.

## Specification changes

Each specification location that this design contradicts, with the stage that changes it.

| location | change | stage |
|---|---|---|
| [native surfaces](../spec/native-surfaces.md) lines 14, 23, 57 | the app DOM presentation wait; document regions leave the wait (rule 6) | F212.7b |
| native surfaces lines 110, 111 | region placement under the calling view and insets relative to the view frame (rule 9) | F212.7 |
| native surfaces line 113 | region addresses, including the core root paths, and the rule that document regions receive no core root grant (rule 4) | F212.5 |
| native surfaces line 114 | plugin address served from the installed folder, by plugin id mapping (identity) | F212.6 |
| native surfaces line 115 | the `post` channel and the bridge statement (open item 1) | F212.4 |
| [plugins](../spec/plugins.md) line 51 | a surface module mounts into the app DOM; the view kind (rule 1) | F212.7 |
| plugins line 96 | a section imports its module into the sidebar element (declared UI sections) | F212.8 |
| plugins line 151 | one app DOM WebView owns the DOM mounted by plugins | F212.11 |
| plugins lines 183-215 | unload and restore of tabs with views (rule 10) | F212.7 |
| plugins lines 183-215, DOM tabs paragraph | DOM tabs | F212.11 |
| [surface composition](../spec/surface-composition.md) line 9 | single app DOM statement | F212.11 |
| surface composition line 104 | a reload of the app DOM does not replace views (rule 1 and rule 2) | F212.7 |
| [exposure](../spec/exposure.md) line 160 | coordinates of mounted plugin modules in the shared app DOM | F212.11 |
| [endpoint](../spec/endpoint.md) line 99 | `diagnostics.surface.hold` of exposure replies, with late replies discarded (rule 3) | F212.6 |
| [installation](../spec/installation.md) lines 129-130 | `/modules` and `/shared` paths, and the core root paths `sok://core/modules/<package>/<path>` and `sok://core/shared/<plugin id>.<point>/<specifier>.js` (rule 4) | F212.5 |
| [terminal runtime](../spec/terminal-runtime.md) line 43 | the restart rule of a sidecar connection (rule 5) | F212.8a |
| [sidecars](../spec/sidecars.md) `## Failure` | the restart limit (rule 5) | F212.8a |

## Risks

- High risk: IME, dragging and layout, process count and first display time, and the Wails call path.

## Objections answered

The objections below are the answers of the first, second, third, fourth, fifth and sixth reviews, and of the core root reviews 1, 2 and 3. Each entry gives the objection, the verdict and the resolution, which a rule of this proposal records. The entries of the second review use the review's ids (C, H, M). The entries of the third review use the review's ids (N, D). The three wrong answers of the second review are the answers to C1, C7 and H3.

**First review**

- Objection: every view runs in a new process by policy, to isolate each document. Verdict: rejected. Resolution: the measured new-process policy gave no gain and loaded more slowly (F196.27-1, F196.27-2); the default assignment is kept and the policy is not used.
- Objection: a crashing process restarts without end and keeps the page busy. Verdict: accepted. Resolution: a sliding window of 300 seconds stops restarts at the fourth failure, and opening the surface clears the record (rule 5, pass value (vi)).
- Objection: the current sidecar failure rule restarts without a limit, with the same risk. Verdict: accepted. Resolution: the limit applies to every sidecar; the contract change is made in F212.8a with Red tests in the host packages.
- Objection: a timer on each call polls for a reply. Verdict: partly accepted. Resolution: events end a call when its peer is lost (`host.call.peer-lost`); the timeout remains only for a live peer that does not reply, and the reason is recorded in rule 3.
- Objection: waiting for a view's presentation can block a commit indefinitely. Verdict: accepted. Resolution: the wait ends at the first of the events of rule 6, with no timer, and `host.trace.view.presentation-abandoned` is written when it ends without presentation (rule 6). The second review corrected the event list (C1, below).
- Objection: waiting for every content frame during a drag makes the drag lag. Verdict: accepted. Resolution: only the first change waits; the native frame moves in the same commit as its card, and later frames are judged by their intervals under pass value (viii) (rule 6).
- Objection: a view that handles every key blocks native menu shortcuts. Verdict: accepted. Resolution: each shortcut has an owner in the table, menu keys do not prevent the default action, and view-owned keys are handled inside the view (rule 7).
- Objection: copying shared modules into each plugin duplicates code and versions. Verdict: rejected. Resolution: a reserved core root serves the modules, with no copy and no link (rule 4, open item 5).
- Objection: the core root would serve any plugin file to any view. Verdict: accepted. Resolution: only files named by `extends`/`contributes` and `dependencies` are served; other paths answer not found, with a Red test (rule 4).
- Objection: the theme tokens would appear after the first script runs, so the first frame flashes. Verdict: accepted. Resolution: a document-start user script carries the tokens (rule 8, open item 9), verified in F212.7d.
- Objection: a view would be claimed accessible without an element tree check. Verdict: partly accepted. Resolution: no accessibility claim is made until the F212.12 check records the platform interface (rule 8).
- Objection: the files state needs a plugin host. Verdict: partly accepted. Resolution: the state moves to the files sidecar first, and a host is built only when that move is impossible (layer rules, F212.9).
- Objection: a plugin id and its plugin name can differ. Verdict: accepted. Resolution: the mapping comes from the installation record, and a mismatched `id` is rejected; a Red test covers the case (identity). The audit claim of the first review was wrong and is removed (H3, below).
- Objection: pushing every change of a declared UI floods the workbench. Verdict: accepted. Resolution: one snapshot is in transit per status, changes mark the status dirty, and skipped values are counted in the event log (rule 2).
- Objection: the editor buffer must move to a sidecar now. Verdict: rejected as a rule; accepted as a measurement. Resolution: pass value (iv) measures the footprint, and a follow-up item is added when it exceeds 50 MB.

**Second review**

- C1: unresponsive detection. Verdict: accepted. Resolution: open item 10 is decided. The private selectors `_webViewWebProcessDidBecomeUnresponsive:` and `_webViewWebProcessDidBecomeResponsive:` are adopted as an event source and used for their purpose, and they are listed in `native/darwin/src/private/webkit.h` and [private native APIs](../operations/private-native-apis.md) with call conditions in F212.3. Rules 2, 3 and 6 name `host.trace.view.unresponsive` and `host.trace.view.responsive` as definite ends. The first-review answer on the presentation wait named four events, one of which was not decided; the wait now ends with the events of rule 6, which includes the unresponsive notification.
- C2: events lack a layer prefix, class and level. Verdict: accepted. Resolution: every event has a layer prefix and a class, level and fields table (messages and events). The status `core.plugin.open-calls` is declared in F212.3.
- C3: late replies. Verdict: accepted. Resolution: a late reply is discarded, with no error to the document; the host-contract cases `exposure-reply.removed-surface-discarded` and `exposure.relay.foreign-document-reply-ignored-timeout-1005` state this, and `host.trace.call.late-reply` is written (rule 3).
- C4: contradicted specification locations. Verdict: accepted. Resolution: the section Specification changes lists each location with its stage.
- C5: regions of a view. Verdict: accepted. Resolution: rule 9 attaches each region to the surface host of its view, verifies each call against the view id of the call envelope, makes insets relative to the view frame, and places the presentation in the same window transaction under rule 6. F212.7 names the contract cases.
- C6: definitions of pass values. Verdict: accepted. Resolution: the definitions of (iii), (iii-b), (v) and (ii) are replaced with the review's definitions (pass values).
- C7: failed plugin value and the one-view alternative. Verdict: partly accepted. Resolution: a failed pass value stops the named items, and the layer or view count of that plugin is reopened in a new revision of this document, which goes to adversarial review. The decision on the revision belongs to the owner. The alternative of one view per plugin per window is removed from the design text and from these answers.
- C8: failure record. Verdict: accepted. Resolution: the failure record is kept after the limit and cleared only when the person opens a surface that needs the process (rule 5, pass value (vi)).
- C9: step order. Verdict: accepted. Resolution: the steps run in the order F212.7, 7b, 7c, 7d, F212.10-editor, 7a, 8, 8a, 9, 9a, 10 (others), 11 to 15, with F212.6a before F212.7 (Steps).
- H1: the main web view policy. Verdict: accepted. Resolution: the main web view uses the new-process policy (`native/darwin/src/window_facts.m:43-44`). Views do not use it, because the F212.1 measurement showed no gain (Tabs and processes).
- H2: reason 1 of the Reasons section. Verdict: accepted. Resolution: the memory reason states the collection delay by allocated bytes and the shared heap, and that no public API shortens the delay.
- H3: identity and audit. Verdict: accepted. Resolution: the fix sites are `index.js:1127` in pagePackage and `page.js:78` and `page.js:169`; F212.6 adds the reserved core check to `validateManifest`. The claim about `e2e/audit.test.mjs:12` was wrong and is removed. The first-review answer on the audit is corrected the same way.
- H4: shell layer, browser sections and the Escape measurement. Verdict: partly accepted. Resolution: the shell layer and the four browser sections are decided in each plugin repository's named items (F212.10-shell-layer and F212.10-browser-sections) before that plugin's F212.10 migration; Escape and the remaining shortcuts are collected into the table by F212.6a before F212.7. No open cell remains without an item (Placement, Steps).
- H5: unload and restore of views. Verdict: accepted. Resolution: rule 10 closes a tab's views and processes on unload, creates a new view from the stored state on restore, and applies pass value (ii) to each unload.
- H6: the `view` composition kind next to `dom`. Verdict: accepted in the third review (D1), which reverses the earlier rejection. Resolution: F212.7 adds the `view` kind and removes `dom` in the same item. The plugins of the check environment migrate in their own F212.10 items against the F212.7 branch; F212.7 merges into main after F212.9a and the plugin migrations are merged into their repositories, before the F212.10 releases (Steps, F212.7). From F212.7 on the reader rejects `dom` with an explicit error that names the plugin and the manifest field. Rollback is by plugin release with the previous `engines` range, not by a second reader form (F212.7).
- H7: RPC protocol number. Verdict: accepted. Resolution: the RPC protocol number is 1 in the 0.0 series (Messages).
- M1: core root path form. Verdict: accepted. Resolution: the core root path form is `sok://core/<plugin id>/<path>`, and installation.md lines 129-130 are added to the specification changes (rule 4, Specification changes).
- M2: terms. Verdict: accepted. Resolution: the terms card surface, presentation wait, shortcut table, call envelope, core root, installation record, owner key, snapshot in transit and plugin name are added to `packages/plugin-api/terms.json`. The identity section uses "plugin name" instead of "package name". The term "declared UI snapshot" cites [native surfaces](../spec/native-surfaces.md), where its section is written in the spec move, not this plan.
- M3: the files state as the only host. Verdict: accepted. Resolution: the sentence that the files state module is the only such module today is removed (Layer rules).
- M4: forced policy measurement. Verdict: accepted. Resolution: the measurement sentence is replaced: with 5 or more views the forced policy loads slower; with 1 view it loaded faster (0.13 s against 0.24 s); process reuse was not measured (Tabs and processes).
- M5: reason 3 and the hidden region. Verdict: accepted. Resolution: reason 3 gives the release main page process size and the reload sizes (G1.4-107), and reason 4 uses the F198.5 wording "hidden browser tab".
- M6: blank numbering. Verdict: accepted. Resolution: every "blank N" is renamed "open item N".
- M7: shortcut default action before registration. Verdict: accepted. Resolution: rule 7 keeps a key's default action until the table is registered, and the view writes `page.view.shortcut-table-missing` at error level.

**Third review**

- N1: step order. Verdict: accepted. Resolution: the Steps section fixes the order F212.7, F212.7b, F212.7d, F212.10-editor, F212.7a, F212.7c, F212.8, F212.8a, F212.9, F212.9a, F212.10 (other plugins), F212.11 to F212.15. F212.7c measures the editor view created by F212.10-editor, so it follows F212.10-editor and F212.7a. F212.7a and F212.7c both depend on F212.10-editor, and F212.7a measures (i), (ii), (iii), (iii-b) and (v), and (viii) is measured by F212.7c.
- N2: peer-lost reasons. Verdict: accepted. Resolution: `host.trace.view.unresponsive` does not end a call. The peers whose end ends a call are a view or host process that ends, a surface that closes, and a sidecar that ends; their reasons are `process-ended`, `surface-closed` and `sidecar-ended` (rule 3). `host.trace.view.unresponsive` is written and used only by the presentation wait of rule 6 and by the status of the view. The reason `unresponsive` is removed everywhere.
- N3: open item 10. Verdict: accepted. Resolution: open item 10 is restated as a decision. The private `WKNavigationDelegatePrivate` selectors are the event source, because the public API has only termination. F212.3 adds them with their call conditions and the WebKit source lines read for the SDK revision in use, and rule 6 uses them only after that record exists.
- N4: (iii) baseline. Verdict: accepted. Resolution: the DOM mount baseline of (iii) is the median time from the surface start request to the first content frame in the recording of the same plugin's surface mount in the main page, measured by the same recording method. It is measured by F212.1-3. The median of `page.trace.surface.mount` in F212.1-2 is the trace value of the mount and is not the (iii) baseline.
- N5: process start durations of (iii-b). Verdict: accepted. Resolution: each duration runs from `host.trace.view.process-request` to the first `host.trace.view.process-ready`. Both events are declared in F212.3 (class call, level debug). The durations are measured within F212.7a with the performance trace on; no separate F212.1-4 item is added.
- N6: sidecar restart text. Verdict: accepted. Resolution: the `## Failure` sentence of sidecars.md at line 67, which states a restart without a limit, is replaced by F212.8a with the limit of rule 5. The terminal runtime sentence at line 43 also changes in F212.8a (rule 5).
- N7: event levels. Verdict: accepted. Resolution: replaced by the fourth review (below), which sets the event levels of a release.
- D1: the `view` kind replaces `dom` in one item. Verdict: accepted in the third review; it reverses H6. Resolution: F212.7 adds the `view` kind and removes `dom` in the same item, with the migration and reader rules stated in H6 and in Steps. F212.11 removes only the remaining page-mount code paths.
- D2: owner of Escape. Verdict: partly accepted. Resolution: the owner of Escape is the view, because a view consumes Escape for its own text input. F212.6a verifies the round trip against the menu close and records the result; it does not choose the owner. The shell layer and the browser sections stay with their plugin repository items (F212.10-shell-layer and F212.10-browser-sections): core does not decide a plugin's internal layout, because plugin functionality belongs to its plugin repository and each repository keeps its own checklist.

**Fourth review**

- Objection: the N7 answer made every event that records a loss or a failure warn or higher, while a 0.0.x release stores only error events. Verdict: accepted. Resolution: each occurrence is classified once. A failure or a rejected operation is an `error` event. A loss, a skip, a transient state or a presentation degradation is counted in the status `core.plugin.losses` or the state `core.plugin.views`, and a `debug` event is written with the count in diagnostic builds ([messages and events](#messages-and-events), event levels in a release). `lateReplies` is removed from `core.plugin.open-calls`, and its count is reported only in `core.plugin.losses`.

**Fifth review**

- F1: the N1 answer named F212.7a as the measurer of (viii), but F212.7a runs before F212.7c. Verdict: accepted. Resolution: F212.7a measures (i), (ii), (iii), (iii-b) and (v), and (viii) is measured by F212.7c (Steps, F212.7a and N1).
- F2: removing `dom` in F212.7 on main would precede the migration of the plugins that declare `dom`. Verdict: accepted. Resolution: F212.7 is developed on the branch `feat/view-kind-F212.7` and merges to main after F212.9a and the migrations of every plugin that declares `dom` are merged into their repositories, before the F212.10 releases (Steps, F212.7).
- F3: the counts were reset when a surface closed, so a dirty value lost at close was not counted. Verdict: accepted. Resolution: the counts are per plugin and are kept until the application ends, and a surface that closes with a dirty value increments `losses.stalled` (event levels in a release).
- F4: the diagnostic-build gate on the debug events does not follow the release rule. Verdict: accepted. Resolution: the performance trace gates the writes of the trace events, which are renamed `host.trace.<event>` and `page.trace.<event>` (rule 2, rule 3, (iii-b), messages and events).
- F5: the call timeout error text was not stated. Verdict: accepted. Resolution: the call is rejected with -32000 and `command <name> did not reply within <ms>ms`, the error that exposure.md states; this design does not change the message (rule 3).
- F6: the reviewer counted English strings in the Korean file. Verdict: rejected. Resolution: the Korean file has the same sections, table rows, steps and objection entries, and the fourth-review changes in Korean. The section comparison found four differences, all fixed: the field name `contributes` missing from English rule 4; the `requestAnimationFrame` code span missing from Korean open item 3; the F212.2 reference missing from Korean in Tabs and processes; and a Korean-only translation note in the Korean M6 answer, which is removed.

**Sixth review**

- K1: the merge of F212.7 and the order of the plugin releases. Verdict: accepted. Resolution: the branch merges once, after F212.9a and the plugin migrations are merged into their repositories and before the F212.10 releases. Plugin releases follow the F212.15 core release, and each F212.10 release is rolled back by its previous `engines` range (Steps, F212.7, F212.10, F212.15, Rollback).
- F6: the objection was withdrawn after the identifiers and section counts were checked. Verdict: withdrawn. Resolution: the fifth-review answer stands.

**Core root review 1**

- C1: paths served to a view. Verdict: accepted. Resolution: only the module of a connected contribution item of plugin B to a point of A (under `/modules/<B package>/`) and the `extends.<point>.modules` target of a point to which A contributes (under `/shared/`) are served; every other path of B answers not found (rule 4). Contributed and shared modules are one self-contained ES module each, and the relative import check is a plugin repository requirement (rule 4, boundary). This supersedes the path form of M1 and the first-review answer on the files that the core root serves.
- C2: no `/runtime/` for views. Verdict: accepted. Resolution: the view bridge is `@soksak/plugin-api/view`, the file `packages/plugin-api/view.js`, served at `sok://core/modules/@soksak/plugin-api/view.js`. It imports nothing under `runtime/` or `@soksak/workbench/`, and it exports the view side of `calls.js` and `snapshots.js` over the view channel (rule 4, F212.5-4).
- C3: view import map. Verdict: accepted. Resolution: the view import map has exactly four entries: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/view` and `@soksak/shared/` mapped to `sok://core/shared/`. It has no `@soksak/runtime` or `@soksak/workbench/` entry. The staging tool writes it from one constant, and a closure test checks it (rule 4, F212.5-4).
- C4: CORS header. Verdict: accepted. Resolution: each response to a view carries `Access-Control-Allow-Origin: sok://<plugin id>` from the view configuration, never the request `Origin` and never `*`; a refused request carries no such header. The WebKit behavior of this header is recorded by a native test before the rule is final (rule 4, F212.5-2).
- C5: no delegation to the application frontend. Verdict: accepted. Resolution: the core root never delegates to the application frontend. `/start.json`, `/environment.json`, `/index.html`, `/runtime/...` and every other path not listed in rule 4 answer not found (rule 4).
- C6: dependency grant. Verdict: accepted. Resolution: the dependency grant is removed. A `dependencies` entry grants no file, which supersedes the first-review answer on the core root's files (rule 4).
- C7: connected rule. Verdict: accepted. Resolution: the connected rule (the provider is installed and enabled, the item's `range` contains the point's `version`, and the item matches the point's `schema`) is in the installer library of `packages/sok`, in Go and Rust, with a shared host contract case (rule 4, F212.5-3).
- N1: document regions. Verdict: accepted. Resolution: document regions receive no core root grant (rule 4, open item 6).
- N2: callback. Verdict: accepted. Resolution: the core root is served through a callback that the host contract declares and each host registers, with a contract case (rule 4, F212.5-6).
- N3: refusal error. Verdict: accepted. Resolution: a refused grant writes `error: core root: <path> is not granted to <plugin>` in both hosts (rule 4, F212.5-6).
- Order: the reserved-id check of F212.6 lands before the resolver of F212.5-6, so the resolver never serves a plugin under `core` (Steps, F212.5). The first native step of F212.5 is the WebKit Origin measurement of F212.5-2.

**Core root review 2**

- R1: core targets of the view import map. Verdict: accepted. Resolution: the core targets are the files of `@soksak/plugin-api` and `soksak` that the import closure of `index.js`, `view.js` and `soksak/dist/index.js` reaches, each served at `sok://core/modules/<package>/<file>`; the closure test of F212.5-4 computes the set and fails when a view import is not granted (rule 4).
- R2: shared target. Verdict: accepted. Resolution: `extends.<point>.modules` is served for a point of A that has a granted item of another plugin, and for a point to which A contributes a granted item (rule 4).
- R3: reserved id. Verdict: accepted. Resolution: the reserved-id check is the item F212.5-9, completed before the resolver of F212.5-6. F212.6 no longer contains the check (rule 4, Steps).
- R4: connected item and granted item. Verdict: accepted. Resolution: the connected item remains the workbench state and checks the schema. The core root grant uses the separate term granted item: a contribution item whose provider is installed and enabled and whose range contains the version of the point. The grant does not check the schema, so the declared module file of an item that fails its schema is granted; this over-grant is limited to a file that the contributor declared in its own manifest, and the design states it. F212.5-3 implements the granted item rule in both hosts (rule 4).
- R5: view channel. Verdict: accepted. Resolution: the view channel is a document-start script that the host injects into each view configuration, with one message handler named `sok-view` in the host contract. `@soksak/plugin-api/view` exports `createViewChannel()` over that handler. F212.5-4 tests it with a fake handler, and F212.7 connects it to the host (rule 4, Boundary).
- N1: header rule. Verdict: accepted. Resolution: the header rule of rule 4 is provisional until F212.5-2 records the WebKit result. If WebKit rejects `Access-Control-Allow-Origin: sok://<plugin id>` for a custom-scheme module, the section is revised in a new review round before F212.5-7 starts (rule 4).

**Core root review 3**

- S1: the view channel had no host-to-view path, and its delivery form was not declared. Verdict: partly accepted. Resolution: the host delivers each host-to-view message with `window.postMessage(message, location.origin)` in the view's page world, the form of `sp_document_post` that document regions already use, and `createViewChannel()` passes each message event whose source is the window to the handler of `onMessage`. The proposed global function `sokViewDeliver` is rejected, and no global function is added to the page, so regions and views share one delivery form. The handler name and the delivery form are declared in the host contract, and F212.5-4 tests both directions with a fake handler (rule 4).
- S2: the granted item rule did not state three cases: a provider that does not declare the point, an entry without `version`, and a `module` path that the owning manifest does not name. Verdict: accepted. Resolution: none of these items is granted, and the rule states the cases (rule 4). A Red test covers a file of a contribution item whose point the provider does not declare (rule 4).
- N1: the native registration of the handler and the injected script had no owner. Verdict: accepted. Resolution: native/darwin registers the handler and the injected script in the view's web view configuration for both hosts, and the host contract declares the handler name (rule 4).
- N2: a bare import in a contributed or shared module had no rule. Verdict: accepted. Resolution: such a module imports bare specifiers only from the four entries of the view import map; any other bare specifier is a build error of the owning plugin (rule 4).

**Core root review 4**

- S3: a host message that arrives before `createViewChannel()` attaches its handler had no queue, and a view that never attaches was not visible. Verdict: accepted. Resolution: the injected document-start script queues the messages of the view from document start until the attach, and `createViewChannel()` passes the queue in order and every later message, so no host message is dropped. A message posted to a view whose document has not committed the script fails in `sp_document_post` and is written to the application log as an error. The queue count is reported as `queued` in `core.plugin.views`. F212.5-4 and F212.5-7 test it (rule 4).
- N4: the handler registration was stated in two sentences of rule 4. Verdict: accepted. Resolution: the registration is stated once, as native/darwin registering the handler `sok-view` and the injected script for both hosts, with the host contract declaring the handler name (rule 4).
- N5: the channel accepted a message without a host marker. Verdict: accepted. Resolution: the host marks each host message with the field `sok: 1`; the channel reports a message without the field to the application log as an error and passes it to no handler (rule 4).
**Core root review 5**

- T1: a post during a navigation passed the URL check and was lost. Verdict: accepted. Resolution: a ready message with a document identifier; posts go only to a recorded ready document.
- T2: the queue had no bound. Verdict: accepted. Resolution: a chosen bound of 256 messages, whose observed length F212.5-4 and F212.5-7 record; a full queue is an error and ends the view process.

**Declared UI schema review**

The objections below are the answers of the adversarial review of [declared UI](../spec/declared-ui.md) (F212.8-0). Each entry gives the objection, the verdict and the resolution, which the specification records.

- D1: the scope did not say what happens to a tree that needs inline rename, drag and drop or a context menu placed at a pointer. Verdict: accepted. Resolution: such a tree is a view under the layer rule. Core declares no element for those interactions. The plugin's repository declares each of its surfaces as declared UI or as a view.
- D2: a tree above the node limit had no defined behaviour, and lazy loading would hide the cut from the workbench. Verdict: accepted. Resolution: core never truncates and has no lazy loading. A plugin with a larger value uses a view, or it cuts its own value and states the cut in a status-line.
- D3: the limits had no reasons. Verdict: accepted. Resolution: each limit is marked as chosen, with its reason as the work of the main page for one snapshot. The limits of list items and tree nodes are revised from a measured draw time of 5000 tree nodes and 1000 list items (F212.8-7).
- D4: a kept tree state keyed by node key breaks when keys repeat under different parents, and its lifetime is undefined. Verdict: accepted. Resolution: the kept state is keyed by the path of node keys from the root. A changed `expanded` value from the plugin wins over it. The kept state resets when the plugin process restarts, it is not saved with the space, and it is removed when its path is absent from an accepted value.
- D5: `selected` had no defined kept state. Verdict: partly accepted. Resolution: the rule that a changed plugin value wins over the kept state applies to `expanded`. `selected` keeps no workbench state, because no core command changes it, so the plugin's value applies in every accepted value. The reason is that a kept `selected` would have no writer.
- D6: a toggle command repeats its change when it runs twice. Verdict: accepted. Resolution: `core.declared-ui.tree.expand {status, tree, path, expanded}` sets the kept state, so the same arguments give the same result.
- D7: the section dom names duplicated the existing `core.sidebar.section.*` names, and `core.sidebars` did not say which elements it counts. Verdict: accepted. Resolution: `core.sidebar.section.header` and `core.sidebar.section.control` are reused, and `core.declared-ui.section-header` is removed. `core.sidebars` counts the control elements of the body, the mounted state from the first accepted value, and the text of the current rejection.
- D8: `data-key` was not in the exposure specification. Verdict: accepted. Resolution: exposure states `data-key` for the elements that a declared UI value draws, and for no other element.
- D9: the roles implied an accessibility claim. Verdict: accepted. Resolution: no accessibility claim is made and no ARIA role is defined until F212.12 records the platform interface (rule 8).
- D10: a rejection could be shown twice, once in the log and once in the section, and a repeated rejection could be written again. Verdict: accepted. Resolution: the section shows the text that `showError` writes. The log line is written once for the same place and text, because `showError` keeps the shown text. The next accepted value withdraws the display.
- D11: a plugin cannot learn that its value was rejected. Verdict: partly accepted. Resolution: the acknowledgement confirms receipt, not validity, so the plugin receives no rejection signal, and the rejection is shown only in the section. A rejection message would need a new message in the snapshot channel, and no consumer requires it.
- D12: the `fill` and empty-list rules were not specified. Verdict: accepted. Resolution: `fill` has the meaning that plugins gives a module section. Each list has a required `empty` text. A tree in a horizontal section is rejected.
- D13: the menu element, the busy tone and the list label have no consumer. Verdict: accepted. Resolution: they are removed, and the menu's commands, dom names and limit are removed with the element. The checklist ID of the removed menu sub-item is not reused.
- D14: a progress or badge element is needed. Verdict: rejected. Resolution: no consumer is named, so no element is added.
- D15: a rejected value should keep the last accepted tree drawn. Verdict: rejected. Resolution: the kept tree is a fallback. It shows a value that the plugin no longer sends as current, and it hides the rejection. Whole-value rejection stays.
- D16: the tree label was removed by the same rule as the list label. Verdict: accepted as a judgement of the revision, not as a request of the review. Resolution: no consumer names a tree, and a section header names its content.

**Declared UI schema review round 2**

The objections below are the answers of the second adversarial review of [declared UI](../spec/declared-ui.md). All twelve are accepted. Each entry gives the objection, the verdict and the resolution, which the specification records.

- R2-1: the follow of a declared section's status had no rule, because the section has no context. Verdict: accepted. Resolution: the workbench follows the status with the `context.status` rules of plugins, using the card and the active tab of the sidebar that draws the section.
- R2-2: the content of a section before its first value was not defined. Verdict: accepted. Resolution: the section shows no tree before the first accepted value. The rejection text is the only content it can show before that, and it shows it only after a rejected value.
- R2-3: the expand command was described as declared, but no declaration existed. Verdict: accepted, with a change of the resolution. Resolution: a declaration without a handler fails `make exposure-check` with `declared but not registered`, so the declaration is not added in this revision. The specification states that the command is declared in `packages/workbench/exposure.json` together with its handler, when the tree element is implemented.
- R2-4: `data-key` was carried by every element, and a request had no defined address. Verdict: accepted. Resolution: `data-key` is carried by interactive elements only, and a request addresses an element by its section id and the path of keys from the root element. The path is unique because keys are unique among siblings. The exposure specification states it.
- R2-5: one status could back several sections. Verdict: accepted. Resolution: a second section that names the same status is rejected when the manifest is read, with an error that names both sections. The horizontal tree check stays a value check, because the section orientation is known only when a value is accepted.
- R2-6: a tree had no `empty` text, and `expanded` was accepted on a leaf. Verdict: accepted. Resolution: a tree requires `empty`, like a list. `expanded` is allowed only on a branch, which is a node whose `children` is present and not empty. A leaf that carries `expanded` is rejected.
- R2-7: the rejection templates were not one template, and the field and pointer of a size error were not defined. Verdict: accepted. Resolution: every rejection text has the form `<pointer>: <reason>`, and a limit reason has the form `exceeds <n> <unit>`. `<field>` is the JSON field name, and the pointer of the root and of the size of the whole value is `/`. The table gains the rows for the parameter key length of 64 characters and the parameter string value of 1000 characters.
- R2-8: the kind `command` collided with the command term, and menus stayed in the declared UI term. Verdict: accepted. Resolution: the kind is renamed to `button` in both specification languages. Menus are removed from the declared UI term in the term list and from the layer rule of this plan in both languages.
- R2-9: the count field, the cleared state, `mounted` after a rejection, and the exposure descriptions were not defined. Verdict: accepted. Resolution: the count field is `controls`. A section is cleared when it has no accepted value, which is before its first accepted value and after a rejected value. `mounted` is false when the section is cleared. The descriptions of `core.sidebar.section`, `core.sidebar.section.control` and `core.sidebar.section.header` in the workbench exposure now cover declared sections.
- R2-10: the change of the sections form in the plugin specification was deferred. Verdict: accepted. Resolution: the change is made in this revision. A section declares `module` or `status`, with exactly one of them, and the manifest row and the sections paragraph of the plugin specification state it in both languages.
- R2-11: a plugin value could name a core command, and the idempotence of the expand control was not argued. Verdict: accepted. Resolution: a plugin value names only commands of its own plugin, and a core command in a value is rejected with `command <name> is not a command of plugin <plugin>`. The workbench draws the branch control with `core.declared-ui.tree.expand`. The control's next request carries the kept state at the time the workbench draws it, so a repeated request before a redraw sends the same arguments and sets the same state, and a request after a redraw carries the redrawn state.
- R2-12: no rule said when a status is declared UI. Verdict: accepted. Resolution: a status is declared UI when a sidebar section names it with the `status` form. No schema marker is used. The surface route of the first answer is removed in round 3 (R3-1).

**Declared UI schema review round 3**

The objections below are the answers of the third adversarial review of [declared UI](../spec/declared-ui.md). All ten are accepted.

- R3-1: a surface could declare a status as declared UI, but the specification defines no declaration form for it. Verdict: accepted. Resolution: both surface clauses are removed, from the scope and from the status rule. A status is declared UI only through the section `status` form. R2-12 is reworded to match.
- R3-2: a change of section orientation did not run the check again on the accepted value. Verdict: accepted. Resolution: a change of orientation runs the check on the accepted value again. A value that fails it is rejected with the existing rows, its tree is removed, and the section is cleared.
- R3-3: the term list and the plan named the vocabulary with commands and command. Verdict: accepted. Resolution: the declared UI term and its layer rule, in the term list and in the plan in both languages, name a sidebar section whose elements are list, tree, button or status-line. The declared element term names button.
- R3-4: the limits were described as not final, and the revision cells stated an unfinished contract. Verdict: accepted. Resolution: the limits of the table are the contract (1000 items per list, 5000 nodes per tree). The sentence "before they are final" and the revision cells are removed. The measurement stays in the checklist sub-item for the draw time and in this record.
- R3-5: list items and tree nodes had no explicit unknown-field row. Verdict: accepted. Resolution: the row `unknown field <field>` covers a root, an element, a list item and a tree node. Its pointer is that object, and `/` at the root.
- R3-6: a name with no owner and a name of core could match two rows, and the order of the rows was not stated. Verdict: accepted. Resolution: the first row in table order applies, and the naming row (a name with no `.`, so no owner) comes before the ownership row (owner core or another plugin). A name with the prefix `core.` is therefore reported as a command of core, not as unnamed.
- R3-7: the `core.sidebars` description did not state the fields of declared sections. Verdict: accepted. Resolution: the description in the workbench exposure gives `mounted`, `error`, `text` and `controls` for declared sections as R2-9 defines them, and for module sections as their mount state, mount error, drawn text and control count.
- R3-8: module sections run plugin code on the workbench page, which plan rule 1 forbids. Verdict: accepted. Resolution: the module form is the current form until it is removed with the page mount (F212.11). The declared UI specification states that a sidebar section with the `status` form is declared UI, and that a section that needs a view becomes a card surface. The plugin specification describes the module form as current and as removed with the page mount. The "as today" wording is corrected.
- R3-9: a rejected value could change the kept state. Verdict: accepted. Resolution: a rejection does not change the kept state, and the comparison uses the last accepted value.
- R3-10: the follow rule of a declared section was a reference and not a rule, and the snapshot term omitted `skipped`. Verdict: accepted. Resolution: the follow rule is stated with its order: the state module first, then the surface of the active tab when it registered the name, then the default surface, then null until a surface registers the name, chosen again when registrations change, with a page error on failure. The declared UI snapshot term includes `skipped`.

**Declared UI schema review round 4**

The objections below are the answers of the fourth adversarial review of [declared UI](../spec/declared-ui.md). All ten are accepted.

- R4-1: the follow rule of a declared status had a state-module step, and it referred to the plugin specification, which referred back to it. Verdict: accepted. Resolution: the state-module step is removed. The source order is stated in the declared UI specification: the view of the active tab of the card that holds the sidebar, when that view's page registered the status; then the plugin host of the plugin; otherwise the section is cleared until one of them registers it.
- R4-2: a plugin whose sidebar section must show values while none of its views is open needs its plugin host. Verdict: accepted. Resolution: the consequence is recorded in the layer rule of the sidebar section and as a note on the plugin host item, so such a plugin requires that item.
- R4-3: the card of a window sidebar was not stated. Verdict: accepted. Resolution: for a fixed window sidebar, the card is the focused content card and its active tab while a plugin override applies, as `core.sidebars` reports them. When no override applies, the view step is skipped. The plugin specification is aligned.
- R4-4: "registered" was not defined. Verdict: accepted. Resolution: a process registers a status when its page calls `page.exposure.register("status", name)`, and the registration belongs to that process.
- R4-5: the declared UI specification used "snapshot" where it means a declared UI snapshot. Verdict: accepted. Resolution: "declared UI snapshot" is used at the lines that describe the snapshot of a declared status: the schema subset, the full value, and the drawing, in both languages.
- R4-6: the terms declared UI status, branch and declared section had no entries. Verdict: accepted. Resolution: the three terms are added to the term list. The term documents give rules and no list of terms, so no mirror needs an update.
- R4-7: the count and length reasons did not name the value that exceeds the limit. Verdict: accepted. Resolution: a limit reason points to the array, object or string that exceeds the limit. The template paragraph gives the pointer of each limit, and the serialized value is `/`.
- R4-8: no row covered `params` or `enabled` without `command`. Verdict: accepted. Resolution: the row `<field> requires command` is added.
- R4-9: the three view cases (inline rename, drag and drop, and a context menu placed at a pointer) were missing from the layer rule. Verdict: accepted. Resolution: they are added to the view rule in both languages.
- R4-10: the specification carried a tracking identifier, a pending sentence in the sections paragraph of the plugin specification, the section "What sections draw today", the statement "This is the current form", and the words "in this version". Verdict: accepted. Resolution: the identifier is removed, and the accessibility sentence names the check instead. The pending sentence is removed. The section is removed, and its description of module sections is in the layer rules of this plan. The statement is removed from the module bullet, and the module form is described in this plan. The words "in this version" are removed from the specification.

**Declared UI schema review round 5**

The objections below are the answers of the fifth adversarial review of [declared UI](../spec/declared-ui.md). All nine are accepted.

- R5-1: the source of a declared status changes, but the specification did not say what a change does. Verdict: accepted. Resolution: the transitions are stated in the specification. (a) The source is chosen again when the active tab of the sidebar's card, the focused card of a fixed window sidebar, or a registration changes. (b) On a change of source, the section is cleared until the first value from the new source is accepted, and the kept state survives by path. (c) On a change of source, the workbench pulls the current value from the new source once. (d) A process end removes its registrations, and the source is chosen again as in (a). Plan rule 2 allows a pull at the load of the main page and at a change of source, and at no other time, because a running view has no other way to send its last value to a new reader.
- R5-2: the manifest rejected a status served only by a state module, but the manifest does not say which statuses a state module serves. Verdict: accepted. Resolution: the manifest-time rejection is deleted. `exposes.status` means the entries of `exposes.status` in `plugin.json` only.
- R5-3: the sentences that describe the status of a section repeated the contract. Verdict: accepted. Resolution: the description sentences are removed from the plugin specification and from the declared UI specification. The contract stays.
- R5-4: the pointer rule was not stated for every row. Verdict: accepted. Resolution: one pointer rule applies to every row, and the table has a Pointer column in both languages. A duplicate key points at the second key. A field-presence row points at the object that holds the field. A count or size limit points at the value that exceeds it.
- R5-5: the array of the expand command's path was not typed in its message. Verdict: accepted. Resolution: `<path>` is a JSON array of strings.
- R5-6: the elements that carry the native button were not listed. Verdict: accepted. Resolution: the specification lists them: the `button`, a list item with `command`, a tree node with `command`, and the expand control of a tree branch.
- R5-7: the terms paragraph omitted three terms, and "declared UI value" was not a term. Verdict: accepted. Resolution: the terms paragraph lists them, and "declared UI value" is added to the term list. The control character range is U+0000 to U+001F, U+007F, and U+0080 to U+009F, in the declared UI specification. The plugin specification states no range, so there is no conflict.
- R5-8: the timing of the expand command was in the specification, and some "snapshot" uses were bare. Verdict: accepted. Resolution: only the implementation timing of the expand command moved to the layer rule of this plan (F212.8-2). The requirement that the command is declared together with its handler stays in the specification. The bare uses at the lines named by the objection are replaced by "declared UI snapshot", and the two further bare uses of the same kind, in the rule for a request without a registration and in the rule for the previous process, are replaced too.
- R5-9: the row `requires command` also applied to buttons, where a missing command is already a missing field. Verdict: accepted. Resolution: the row is limited to list items and tree nodes.

**Declared UI schema review round 6**

The objections below are the answers of the sixth adversarial review of [declared UI](../spec/declared-ui.md). Eight are accepted, and one is partly accepted.

- R6-1: the state paragraph of the plugin specification restated the order in which a declared section takes its status. Verdict: accepted. Resolution: the sentence is deleted, and the link to the declared UI description of the source is kept.
- R6-2: the idempotence sentence of the binding part was read as a report of progress. Verdict: partly accepted. Resolution: the sentence states a contract, that repeated requests set the same state, and it stays. Only the implementation timing of the expand command moved in round 5, and R5-8 says so.
- R6-3: module-form and removal sentences remained in the plugin specification and in the declared UI specification, although the previous round's report said they were removed. The cause was that the check covered the paragraph wording and not the module bullet and the sections form. Verdict: accepted. Resolution: the sentences are removed in both languages, and a search of both languages for the current-form and removal wording finds none in the declared UI specification or in the sections paragraph of the plugin specification.
- R6-4: a root that is not an object and an `elements` field that is not an array shared one row and one pointer. Verdict: accepted. Resolution: they are two rows. A root that is not an object points to `/` and is reported as `root must be an object`. An `elements` field that is not an array points to `/elements`.
- R6-5: `unknown kind` followed `unknown field`, while the field rows of an element use the field list of the kind that its `kind` value selects. Verdict: accepted. Resolution: `unknown kind` comes above the field rows, and the text states the order.
- R6-6: a path that becomes a leaf kept its kept state. Verdict: accepted. Resolution: a leaf path loses its kept state, and a branch with no kept state takes the plugin's `expanded` value.
- R6-7: the address of an element had no role, although a tree node has two controls. Verdict: accepted. Resolution: the address is the section id, the path of keys, and the role (`label` or `expand`), in the declared UI specification and in the exposure specification, in both languages.
- R6-8: a rejection leaves no value to draw again, and a change of orientation had no pull from the source. Verdict: accepted. Resolution: a rejection discards the value. A change of orientation is a third pull moment in rule 2, because a value discarded for the previous orientation may be valid for the new one, and only the source holds it.
- R6-9: a pull reply with `value: null` was not defined. Verdict: accepted. Resolution: `value: null` means that the source has no value yet, and the section stays cleared until the first push. The message table of this plan and the declared UI specification define it.

**Declared UI schema review round 7**

The objections below are the answers of the seventh adversarial review of [declared UI](../spec/declared-ui.md). All eight are accepted.

- R7-1: the round 6 record reported three plan changes as done: the orientation pull of rule 2, the `null` value in the message table, and the order of the `unknown kind` row. The files did not contain the first two. The cause is that the round 6 write of the plan appended its record to a fresh read of the file, which dropped the three plan edits made earlier in that round, including the amendment of R5-8. Verdict: accepted. Resolution: the orientation pull is in rule 2, the message row names the load pull of rule 2, and R5-8 is restored. Each change is checked by search in both languages before the commit.
- R7-2: the message table did not say that `value` is `null` when the source has no value yet. Verdict: accepted. Resolution: the last column of the `declared-ui.snapshot.request` row says so, in both languages.
- R7-3: the `unknown kind` row was not above the row that depends on the kind. Verdict: accepted. Resolution: the row is above the list-items row in both tables, because the kind decides which limits and field rows apply to an element.
- R7-4: the owner of a command name was not defined where the rejection rows use `<owner>`. Verdict: accepted. Resolution: `<owner>` is the plugin id of the status, defined beside the rejection template.
- R7-5: a change of source, a process end, and a surface close did not clear the error of a status. Verdict: accepted. Resolution: each calls `hideError` for the status and sets `error` to null.
- R7-6: the idempotence paragraph described the next request as carrying the kept state. Verdict: accepted. Resolution: the request carries the `expanded` value that the control requests, which is the opposite of the kept state when the workbench draws it.
- R7-7: "serialized value" did not define its length. Verdict: accepted. Resolution: it is the UTF-8 byte length of `JSON.stringify` of the value.
- R7-8: pointers were not identified with a standard. Verdict: accepted. Resolution: pointers are JSON Pointers (RFC 6901).
