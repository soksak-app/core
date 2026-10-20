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

- **Declared UI:** a screen whose every element is expressed with the declared vocabulary (lists, trees, menus, commands, status lines) is declared UI.
- **View:** any other screen is a view. A view holds free DOM, text input that needs an input method (IME), a canvas or an editor, or a screen that holds a document region or an image region.
- **Sidebar section:** only declared UI can be a sidebar section. A section that needs a view becomes a card surface, and the sidebar holds only a declared item that opens it.
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
| (iii-b) first display of a new process | First display of a new process: (the time from the view start request to its first content frame in the recording) minus (the median of five process start durations of F212.7a, each a duration from the process request (`host.view.process-request`) to the first `host.view.process-ready` that the view writes when its page runtime starts; both are declared in F212.3 (class lifecycle, level debug)) is at most the DOM mount baseline plus 300 ms, over three repeated runs. |
| (v) display judgment | From a recording of a card layout change, the view's content frame at its new size appears within 100 ms of the first frame of that change. Fixed before F212.7. |
| (vi) restart limit | When a failure event arrives, the failure time is recorded and counted at that point; no timer is used. Reaching the fourth failure within the last 300 seconds stops the restarts. Failures older than 300 seconds are not counted (sliding window). After a stop, the failure record is kept. It is cleared only when the person opens a surface that needs the process, and the process then starts again. |
| (iv) editor measurement | The footprint of the editor view and the footprint of a hidden DOM editor are measured. When the view footprint exceeds 50 MB, a checklist item for moving the buffer and analysis to a sidecar is added after F212.9. This is a measurement and item-addition rule, not a pass condition. |
| (viii) drag | During a gesture: (a) the difference between the native frame boundary and the card boundary in each frame is at most 2 pt, with the same commit and an expected value of 0; (b) the interval between consecutive content frames (frames that the view draws into its own document, shown after the view's ResizeObserver and the next requestAnimationFrame) is at most 33 ms; (c) a state where the content frame size differs from the native frame size ends within 2 frames (33 ms) after the gesture ends. These values are judged on a recording, not by a timer running in the application. Fixed before F212.7c. |

When a value is not met, the measured values are recorded in the checklist. A failure of an infrastructure value ((v), (vi), (viii)) stops the infrastructure items (F212.7b, F212.7c, F212.8a) and the items that depend on them (F212.8 and later). A failure of a plugin value ((i), (ii), (iii), (iii-b)) stops only that plugin's earlier items. The layer or view count of that plugin is then reopened in a new revision of this document, which goes to adversarial review. The decision on the revision belongs to the owner.

## Rules

1. Plugin code does not run on the workbench page.
2. **Declared UI snapshots.** A plugin view or plugin host pushes its declared UI snapshot to the workbench (push). When the main page loads, including a reload, the workbench requests one snapshot for each declared status of each view and host that its surfaces declare (pull). No other pull is made. Message names and fields are in [messages and events](#messages-and-events).
   - A status has at most one snapshot in transit.
   - A change made while a snapshot is in transit marks the status dirty. When the acknowledgement arrives, the next snapshot carries the latest value.
   - The number of skipped values is counted in `losses.skipped` of the core status `core.plugin.losses`. In diagnostic builds, each change of the count also writes `host.declared-ui.snapshot.skipped`.
   - When a plugin process starts (or starts again), the first snapshot of each status is the full value of that status. The workbench discards the stopped snapshot and the pending acknowledgement of the previous process. A restarted plugin builds its values from its saved state (rule 5).
   - When the view process ends or the surface closes while an acknowledgement is pending, the workbench writes `host.status.stalled {plugin, status, reason}`. A restarted process sends the latest value of each status as its first snapshot and clears the dirty mark. When the surface is closed, the dirty values are discarded and the reason says so. No timer is used.
3. **Calls across a boundary.**
   - A command declares `timeout` as stated in [exposure](../spec/exposure.md) (at most 600000 ms; 10 seconds when omitted). The timer remains for a live peer that does not reply to a command, because no event reports a slow command reply. `host.view.unresponsive` reports a view process that stops answering WebKit's responsiveness check; it is not a command reply, so it does not replace the timer. When the time limit passes, the call is rejected with an error that names the elapsed time and the timeout, as the current contract states, and `host.call.timeout {plugin, command}` is written, and `losses.timeouts` counts it.
   - When the peer disappears, the call ends before its time limit through an event. The peers whose end ends a call are: a view or host process that ends, a surface that closes, and a sidecar that ends. The promise is rejected with an error that gives the reason. The reason is one of `process-ended`, `surface-closed` or `sidecar-ended`. `host.call.peer-lost {plugin, command, reason}` is written for `process-ended` and `sidecar-ended`; `surface-closed` writes no event and increments `losses.peerLost`. `host.view.unresponsive` does not end a call; it is written and used only by the presentation wait of rule 6 and by the status of the view. A call ends only by its declared timeout or by one of these peers.
   - A late reply to a call that has ended is discarded. It is not passed to any promise, and no error is sent to the document that sent it. The host writes `host.call.late-reply {plugin, command, delay}` and increments `losses.lateReplies`. The host-contract cases `exposure-reply.removed-surface-discarded` and `exposure.relay.foreign-document-reply-ignored-timeout-1005` state this behavior.
   - The number of open calls, including snapshots waiting for acknowledgement, and the start time of the oldest open call are exposed as the core status `core.plugin.open-calls {plugin, count, oldestStartedAt}`. The name and location are fixed here; F212.3 declares the status.
   - The relay timeout is product behavior of exposure. The two paths are: the host applies the timeout to a command forwarded to a surface page, and the main page applies the timeout to a handler that it runs itself ([exposure](../spec/exposure.md), command `timeout`). Both paths are written in exposure.md in F212.2.
   - Cancellation is part of the call envelope. A binary payload uses a separate channel (open item 2).
4. **Origin and shared modules.**
   - Each plugin HTML runs in its own web view on `sok://<plugin id>`.
   - Shared modules are served from the reserved host `core`, which a plugin id cannot use. `validateManifest` rejects that name; F212.6 adds this check, which is not present now.
   - The core root path form is `sok://core/<plugin id>/<path>`, where `<plugin id>` is the plugin that owns the file.
   - The core root serves the core modules and the files of plugin B that match either of these cases. Each request is checked against the installation record:
     - plugin A's view requests the file, and B declares a contribution to an extension point that A declares in `extends`;
     - A's `dependencies` names B.
   - Any other path answers not found, as in [native surfaces](../spec/native-surfaces.md#document-regions).
   - Red test: a request from a view of plugin A for a file of plugin B, when B neither contributes to an extension point of A nor is in A's dependencies, receives not found.
5. **Restarts.** Sidecars and plugin hosts restart within the limit of pass value (vi). When the limit is exceeded, the host reports `error:` and stops.
   - After the limit is exceeded, the next request fails with `sidecar-failure` (reason `restart limit`) without starting the process. The failure record is kept. It is cleared only when the person opens a surface that needs the process; the process then starts, and the host writes `host.sidecar.restart-reset {sidecar, surface}`. A plugin host writes `host.plugin-host.restart-reset {plugin}`.
   - This rule changes two specification locations. The `## Failure` section of [sidecars](../spec/sidecars.md) at line 67 states that the next request after a failure starts a new process without a limit. F212.8a replaces that sentence with the limit of rule 5. The restart rule that [terminal runtime](../spec/terminal-runtime.md) states at line 43 (one attempt per disconnect, with the next send retrying the same path) changes in F212.8a as well.
   - A restart restores the state from the last saved value. A state that was not saved is lost, and each plugin states which state that is.
   - Fault injection exists only in diagnostic builds.
6. **Presentation.** A plugin view joins the presentation wait only at the first display after a card layout change (the first change of a gesture).
   - During a continuing gesture (a divider drag or a card drag), the native frame of a view is placed at the new geometry in the same commit as its card, in every frame. The wait for content drawing applies only to the first change. Later content may draw late, and that delay is measured by frame intervals.
   - F212.7c records a full drag gesture, measures the frame intervals and the geometry error, and judges them with pass value (viii).
   - The wait ends with the first of: the presentation completion of the view; the end of the view process; the view becoming invisible when the change ends (a `hidden` ancestor, an unselected tab, a closed surface, read from the state that the workbench already reports for each surface); and an unresponsive notification from `host.view.unresponsive`. When the wait ends without presentation completion, the commit continues without that view, and `page.view.presentation-abandoned {surface, reason}` is written and increments `losses.abandoned`. No timer is used.
   - Pass value (v) is not a runtime deadline. It is the judgment that F212.7b and each plugin item measure.
   - F212.7b records a card entering full screen and a tab change for a card with a view, and checks that both waits end.
   - [native surfaces](../spec/native-surfaces.md) is corrected for this rule.
7. **Input.**
   - The keyboard shortcuts of the workbench are listed with their owner in the table below.
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

   | shortcut | owner | reason |
   |---|---|---|
   | Command `=`, `-`, `0` (View menu: text size, [text size](../spec/text-size.md)) | native menu → core commands `core.text.larger`, `core.text.smaller`, `core.text.reset` | a menu key equivalent works whatever view has focus |
   | Escape | view | a view consumes Escape for its own text input; the measurement of F212.6a verifies the round trip against the menu close and records the result; it does not choose the owner |
   | text input and IME keys | view | the first responder of the view receives them |

   The full list of workbench shortcuts is taken from the menu declarations of both hosts and from the workbench key handlers. The table lists only the shortcuts the specifications declare now; F212.6a adds the rest to this table before F212.7 starts.

8. **Theme and accessibility.**
   - When it creates a view, the host gives the view's configuration the token set of the current theme as a document-start user script. The page's first script therefore sees the tokens.
   - Later theme changes are sent through the post path.
   - F212.7d compares the color of the first frame with the card token color. The document-start user script is open item 9.
   - Accessibility: F212.12 records whether the element tree of a view reaches the platform accessibility interface. Until a check exists, no accessibility claim is made.
9. **Regions of a view.** A region of a view (a document region or an image region) attaches to the surface host of that view. Each call that places or changes a region is verified against the view id of the call envelope. Insets are relative to the view frame. The presentation of the region is in the same window transaction under rule 6. F212.7 names the contract cases for this rule.
10. **Unload and restore of a view.** Unloading a tab closes its views and their processes. Restoring the tab creates a new view from the stored state. Pass value (ii) applies to each unload.

## Messages and events

**Messages**

| message | direction | fields | note |
|---|---|---|---|
| `declared-ui.snapshot` | plugin → workbench (event) | `{plugin, status, seq, value}` | the push of rule 2 |
| `declared-ui.snapshot.ack` | workbench → plugin (event) | `{plugin, status, seq}` | confirms receipt; releases the in-transit slot |
| `declared-ui.snapshot.request` | workbench → plugin (call) | `{status}`; the reply is `{seq, value}` | the one pull of load time |

The RPC protocol number is 1 in the 0.0 series.

**Events.** Each event name starts with its layer (`host` or `page`). Its class names its concern (`call`, `lifecycle`, `input`). The events are declared in F212.3, except `host.sidecar.restart-reset`, which F212.8a declares.

| event | class | level | fields |
|---|---|---|---|
| `host.declared-ui.snapshot.skipped` | call | debug | `{plugin, status, count}`: values skipped while a snapshot was in transit; counter `losses.skipped` |
| `host.status.stalled` | lifecycle | debug | `{plugin, status, reason}`; counter `losses.stalled` |
| `host.call.timeout` | call | error | `{plugin, command}`; counter `losses.timeouts` |
| `host.call.peer-lost` | call | error | `{plugin, command, reason}` for `process-ended` and `sidecar-ended`; `surface-closed` writes no event and counts `losses.peerLost` |
| `host.call.late-reply` | call | debug | `{plugin, command, delay}`; counter `losses.lateReplies` |
| `host.view.unresponsive` | lifecycle | debug | `{plugin, surface}`; state `core.plugin.views.responsive` |
| `host.view.responsive` | lifecycle | debug | `{plugin, surface}`; state `core.plugin.views.responsive` |
| `host.view.process-request` | lifecycle | debug | `{plugin, surface}` |
| `host.view.process-ready` | lifecycle | debug | `{plugin, surface}` |
| `page.view.presentation-abandoned` | lifecycle | debug | `{surface, reason}`; counter `losses.abandoned` |
| `page.view.shortcut-table-missing` | input | error | `{plugin}` |
| `page.input.shortcut.failed` | input | error | `{plugin, key, command}` |
| `host.plugin-host.restart` | lifecycle | error | `{plugin, attempt}` |
| `host.plugin-host.restart-limit` | lifecycle | error | `{plugin}` |
| `host.plugin-host.restart-reset` | lifecycle | debug | `{plugin}` |
| `host.sidecar.restart-reset` | lifecycle | debug | `{sidecar, surface}`, declared by F212.8a |

F212.3 declares the statuses `core.plugin.open-calls`, `core.plugin.losses` and `core.plugin.views`. The events of this design are declared with level `error` or `debug` only; check the class budget in [events](../spec/events.json) before writing catalog entries (F212.3). The restart state of a plugin host or a sidecar is shown in `core.plugin.views` or in the sidecar status.

**Event levels in a release.** A 0.0.x release stores only error events (AGENTS.md, Diagnostic code). Each occurrence of this design is therefore classified once:
(a) a failure or a rejected operation is an event at level `error`;
(b) a loss, a skip, a transient state or a presentation degradation is not an event. It is counted in the declared status `core.plugin.losses {plugin, skipped, stalled, abandoned, lateReplies, timeouts, peerLost}`, and it is a state of the declared status `core.plugin.views {plugin, surface, responsive}`. Each count is notified to status watchers when it changes. The counts are per surface and reset when the surface closes.
In diagnostic builds, a change of a count also writes the `debug` event named in the table, so that the diagnostic record has the occurrence in order. The debug event is not stored in a release.

The identifiers in code use the names as written here.

## Boundary (no coupling)

- The core of this design provides only the mechanisms: view configuration kinds, the declared UI schema and its drawing, the RPC and binary channels, the reserved module root, the restart limit, and the contract cases.
- The plugin table above is the input of the migration items in each plugin repository's checklist. Core code and tests do not know plugin or sidecar names, paths or implementations.
  - Moving the files state to a sidecar is an item of the files plugin and files sidecar repositories.
  - Whether the editor buffer moves is an item of the editor repository.
- Core F212.9 is the plugin host mechanism for a plugin whose DOM-free logic fits neither a view nor a sidecar. It is built only when the contract requires it.
- Relations are declared only by the `dependencies`, `extends` and `contributes` fields of a manifest. The core root serves a plugin's file to another plugin only on the basis of these declarations and the installation record.
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
2. Call ids, acknowledgements and cancellation are added to the call envelope: a call carries `id`, a reply carries the same `id` with a result or an error, and a cancel carries `id`. The binary path is native in F212.4, on the two hosts.
3. A platform operation creates the plugin host web view. It attaches to the window, not to a `SurfaceHost`. Its throttling while hidden and its `requestAnimationFrame` behavior are measured in F212.1 and F212.9a.
4. Wails has no call path to a web view that the application creates (H3). The path is made in the Objective-C host, and the contract cases verify that both hosts behave the same way (F212.4).
5. The reserved module root of core is built in F212.5. It uses no copy and no link.
6. The region page receives an import map in F212.5.
7. The exposure owner key of a plugin host is `plugin:<plugin id>`. The key uses the plugin id, which is the identity of a plugin (see [identity](#identity)).
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

Each step is one checklist item with one unit of function: specification, Red, implementation, Green, record, commit. The main branch is green after each step.

Step order: F212.7, F212.7b, F212.7d, F212.10-editor, F212.7a, F212.7c, F212.8, F212.8a, F212.9, F212.9a, F212.10 (other plugins), F212.11 to F212.15. F212.7c measures the editor view created by F212.10-editor, so it follows F212.10-editor and F212.7a. F212.7a and F212.7c both depend on F212.10-editor.

1. **F212.1 Measurement.** WebContent totals per window; base cost of a web view; cost and throttle of a plugin host; DOM editor and flowmark with memory saving on and off, and the same screen as a view; two views of one plugin under (a) and (b); process-sharing pairs (two views of one plugin, two plugins, a view and a document region of one plugin); the main page of two windows; the DOM mount time of every surface plugin in the installed record (page trace, recorded with the plugin version; the (iii) baseline is F212.1-3); the first display time, the first status time, and the start time of a new WebContent process. The page writes `page.trace.surface.mount {plugin, surface, ms}` at each surface mount when the trace is on, and `make events-check` compares the workbench `trace(` calls with the catalog.
   - **F212.1-3:** the recorded DOM mount baseline of every installed surface plugin (first content frame in a recording), the baseline of (iii). The median of F212.1-2 (`page.trace.surface.mount`) is the trace value of the mount, not the (iii) baseline.
2. **F212.2 Design document.** This document and its Korean translation. The review result is recorded in [objections answered](#objections-answered).
3. **F212.3 Call message layer (plugin-api).** Declares the events of [messages and events](#messages-and-events) in the event catalog, except `host.sidecar.restart-reset` (declared by F212.8a); declares the statuses `core.plugin.open-calls`, `core.plugin.losses` and `core.plugin.views`; adds the unresponsive selectors to `native/darwin/src/private/webkit.h` and to [private native APIs](../operations/private-native-apis.md) with the call condition and the source lines read from the WebKit source of the SDK revision in use (open item 10); and runs `make events-check`.
4. **F212.4 Binary path** (native code and both hosts).
5. **F212.5 Reserved module root and import map.** Changes `/modules` and `/shared` in [installation](../spec/installation.md) and adds the core root path form.
6. **F212.6 Identity, exposure registration, and the reserved core check.** Adds the reserved `core` check to `validateManifest`, the plugin id mapping, and the exposure registration.
   - **F212.6a:** shortcut table. Measures the round trip of Escape against the menu close and records the result; the owner of Escape is the view and the measurement does not choose it. It then adds every other workbench shortcut from both hosts' menu declarations and workbench key handlers to the table of rule 7. It is completed before F212.7.
7. **F212.7 View configuration kinds** (manifest, workbench, native placement, and the `view` composition kind). F212.7 adds the `view` kind and removes `dom` in the same item. The plugins of the check environment migrate in their own F212.10 items against the F212.7 branch; F212.7 merges into main when those plugin releases are published with an `engines` range that requires it. From F212.7 on the reader rejects `dom` with an explicit error that names the plugin and the manifest field. Rollback is by plugin release with the previous `engines` range, not by a second reader form. Rules 9 and 10 are implemented here, and F212.7 names their contract cases.
   - **F212.7b:** presentation wait participation and budget (v).
   - **F212.7d:** first-frame theme user script (open item 9).
   - **F212.10-editor:** the editor plugin migrates to a view (its own repository item), before F212.7a and F212.7c.
   - **F212.7a:** after F212.10-editor, the editor view measures (i), (ii), (iii), (iii-b), (v) and (viii) through the drag recording of F212.7c.
   - **F212.7c:** drag recording and geometry error (viii). The first view (the editor view of F212.10-editor) is the measured view. Every plugin view is measured in its own F212.10 item and in F212.14. It follows F212.10-editor and F212.7a.
8. **F212.8** Declared UI schema and drawing in the workbench, including sidebar sections.
   - **F212.8a:** restart limit (vi) in the `## Failure` section of [sidecars](../spec/sidecars.md) and in [terminal runtime](../spec/terminal-runtime.md) line 43, and their translations. Red tests in the host packages that own sidecar failure (Go, Rust, and the contract cases). F212.8a precedes F212.9. It declares `host.sidecar.restart-reset`.
9. **F212.9** Plugin host mechanism (platform operation, owner key, restart). The files repository first completes its item that moves the state to a sidecar. A host is built only when a plugin still needs it.
   - **F212.9a:** when a plugin host is built, its footprint and throttle are measured before F212.10.
10. **F212.10** Plugin migrations (one item per plugin repository, with `engines.soksak`). The named items F212.10-shell-layer and F212.10-browser-sections are completed before the shell and browser migrations. Each plugin item measures (iii), (v) and (viii) for its views before its release.
11. **F212.11** Removal of the remaining page-mount code paths only (page mount, parking, section and state mounts on the page).
12. **F212.12** Window checks by function (display, input and focus, drag, restart). One item per function.
13. **F212.13** IME activation check (with the user's approval).
14. **F212.14** At the final layout, every plugin view is measured again for (i), (ii), (iii), (iii-b) and (v), and every plugin view is measured for (viii). (vi) is covered by the restart window check of F212.12.
15. **F212.15** Core release. Plugins are released in their own repositories.

## Verification

- Each item: the unit Red and Green tests of the owning module, and the structural checks that the change touches. A full suite is not run to complete an item.
- Completion: (i), (ii), (iii), (iii-b), (v), (vi) and (viii) must pass. (iv) must be measured; when it is over its limit, the follow-up item must exist in the checklist.

## Rollback

- A core stage is rolled back only after the plugin releases that require it are rolled back to their previous `engines` range and released.
- Order: stages F212.3 to F212.6 add mechanisms and do not change the behavior of existing plugins, so they are rolled back by reverting their commits. Stages F212.7 to F212.9, with F212.10-editor, are rolled back after any plugin release that uses them is rolled back. Stage F212.10 is rolled back by releasing each plugin with its previous `engines` range. Stage F212.11 removes the old paths; it is rolled back by reverting its commit only after F212.10 is rolled back.
- The rollback order of each stage is recorded in the checklist item of that stage when the stage is written.

## Specification changes

Each specification location that this design contradicts, with the stage that changes it.

| location | change | stage |
|---|---|---|
| [native surfaces](../spec/native-surfaces.md) lines 14, 23, 57 | the app DOM presentation wait; document regions leave the wait (rule 6) | F212.7b |
| native surfaces lines 110, 111 | region placement under the calling view and insets relative to the view frame (rule 9) | F212.7 |
| native surfaces line 113 | region addresses, including the `sok` core root path form (rule 4) | F212.5 |
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
| [installation](../spec/installation.md) lines 129-130 | `/modules` and `/shared` paths and the core root path form `sok://core/<plugin id>/<path>` | F212.5 |
| [terminal runtime](../spec/terminal-runtime.md) line 43 | the restart rule of a sidecar connection (rule 5) | F212.8a |
| [sidecars](../spec/sidecars.md) `## Failure` | the restart limit (rule 5) | F212.8a |

## Risks

- High risk: IME, dragging and layout, process count and first display time, and the Wails call path.

## Objections answered

The objections below are the answers of the first, second, third and fourth reviews. Each entry gives the objection, the verdict and the resolution, which a rule of this proposal records. The entries of the second review use the review's ids (C, H, M). The entries of the third review use the review's ids (N, D). The three wrong answers of the second review are the answers to C1, C7 and H3.

**First review**

- Objection: every view runs in a new process by policy, to isolate each document. Verdict: rejected. Resolution: the measured new-process policy gave no gain and loaded more slowly (F196.27-1, F196.27-2); the default assignment is kept and the policy is not used.
- Objection: a crashing process restarts without end and keeps the page busy. Verdict: accepted. Resolution: a sliding window of 300 seconds stops restarts at the fourth failure, and opening the surface clears the record (rule 5, pass value (vi)).
- Objection: the current sidecar failure rule restarts without a limit, with the same risk. Verdict: accepted. Resolution: the limit applies to every sidecar; the contract change is made in F212.8a with Red tests in the host packages.
- Objection: a timer on each call polls for a reply. Verdict: partly accepted. Resolution: events end a call when its peer is lost (`host.call.peer-lost`); the timeout remains only for a live peer that does not reply, and the reason is recorded in rule 3.
- Objection: waiting for a view's presentation can block a commit indefinitely. Verdict: accepted. Resolution: the wait ends at the first of the events of rule 6, with no timer, and `page.view.presentation-abandoned` is written when it ends without presentation (rule 6). The second review corrected the event list (C1, below).
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

- C1: unresponsive detection. Verdict: accepted. Resolution: open item 10 is decided. The private selectors `_webViewWebProcessDidBecomeUnresponsive:` and `_webViewWebProcessDidBecomeResponsive:` are adopted as an event source and used for their purpose, and they are listed in `native/darwin/src/private/webkit.h` and [private native APIs](../operations/private-native-apis.md) with call conditions in F212.3. Rules 2, 3 and 6 name `host.view.unresponsive` and `host.view.responsive` as definite ends. The first-review answer on the presentation wait named four events, one of which was not decided; the wait now ends with the events of rule 6, which includes the unresponsive notification.
- C2: events lack a layer prefix, class and level. Verdict: accepted. Resolution: every event has a layer prefix and a class, level and fields table (messages and events). The status `core.plugin.open-calls` is declared in F212.3.
- C3: late replies. Verdict: accepted. Resolution: a late reply is discarded, with no error to the document; the host-contract cases `exposure-reply.removed-surface-discarded` and `exposure.relay.foreign-document-reply-ignored-timeout-1005` state this, and `host.call.late-reply` is written (rule 3).
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
- H6: the `view` composition kind next to `dom`. Verdict: accepted in the third review (D1), which reverses the earlier rejection. Resolution: F212.7 adds the `view` kind and removes `dom` in the same item. The plugins of the check environment migrate in their own F212.10 items against the F212.7 branch; F212.7 merges into main when those plugin releases are published with an `engines` range that requires it. From F212.7 on the reader rejects `dom` with an explicit error that names the plugin and the manifest field. Rollback is by plugin release with the previous `engines` range, not by a second reader form (F212.7).
- H7: RPC protocol number. Verdict: accepted. Resolution: the RPC protocol number is 1 in the 0.0 series (Messages).
- M1: core root path form. Verdict: accepted. Resolution: the core root path form is `sok://core/<plugin id>/<path>`, and installation.md lines 129-130 are added to the specification changes (rule 4, Specification changes).
- M2: terms. Verdict: accepted. Resolution: the terms card surface, presentation wait, shortcut table, call envelope, reserved module root, installation record, owner key, snapshot in transit and plugin name are added to `packages/plugin-api/terms.json`. The identity section uses "plugin name" instead of "package name". The term "declared UI snapshot" cites [native surfaces](../spec/native-surfaces.md), where its section is written in the spec move, not this plan.
- M3: the files state as the only host. Verdict: accepted. Resolution: the sentence that the files state module is the only such module today is removed (Layer rules).
- M4: forced policy measurement. Verdict: accepted. Resolution: the measurement sentence is replaced: with 5 or more views the forced policy loads slower; with 1 view it loaded faster (0.13 s against 0.24 s); process reuse was not measured (Tabs and processes).
- M5: reason 3 and the hidden region. Verdict: accepted. Resolution: reason 3 gives the release main page process size and the reload sizes (G1.4-107), and reason 4 uses the F198.5 wording "hidden browser tab".
- M6: blank numbering. Verdict: accepted. Resolution: every "blank N" is renamed "open item N".
- M7: shortcut default action before registration. Verdict: accepted. Resolution: rule 7 keeps a key's default action until the table is registered, and the view writes `page.view.shortcut-table-missing` at error level.

**Third review**

- N1: step order. Verdict: accepted. Resolution: the Steps section fixes the order F212.7, F212.7b, F212.7d, F212.10-editor, F212.7a, F212.7c, F212.8, F212.8a, F212.9, F212.9a, F212.10 (other plugins), F212.11 to F212.15. F212.7c measures the editor view created by F212.10-editor, so it follows F212.10-editor and F212.7a. F212.7a and F212.7c both depend on F212.10-editor, and F212.7a measures (viii) through the drag recording of F212.7c.
- N2: peer-lost reasons. Verdict: accepted. Resolution: `host.view.unresponsive` does not end a call. The peers whose end ends a call are a view or host process that ends, a surface that closes, and a sidecar that ends; their reasons are `process-ended`, `surface-closed` and `sidecar-ended` (rule 3). `host.view.unresponsive` is written and used only by the presentation wait of rule 6 and by the status of the view. The reason `unresponsive` is removed everywhere.
- N3: open item 10. Verdict: accepted. Resolution: open item 10 is restated as a decision. The private `WKNavigationDelegatePrivate` selectors are the event source, because the public API has only termination. F212.3 adds them with their call conditions and the WebKit source lines read for the SDK revision in use, and rule 6 uses them only after that record exists.
- N4: (iii) baseline. Verdict: accepted. Resolution: the DOM mount baseline of (iii) is the median time from the surface start request to the first content frame in the recording of the same plugin's surface mount in the main page, measured by the same recording method. It is measured by F212.1-3. The median of `page.trace.surface.mount` in F212.1-2 is the trace value of the mount and is not the (iii) baseline.
- N5: process start durations of (iii-b). Verdict: accepted. Resolution: each duration runs from `host.view.process-request` to the first `host.view.process-ready`. Both events are declared in F212.3 (class lifecycle, level debug). The durations are measured within F212.7a; no separate F212.1-4 item is added.
- N6: sidecar restart text. Verdict: accepted. Resolution: the `## Failure` sentence of sidecars.md at line 67, which states a restart without a limit, is replaced by F212.8a with the limit of rule 5. The terminal runtime sentence at line 43 also changes in F212.8a (rule 5).
- N7: event levels. Verdict: accepted. Resolution: replaced by the fourth review (below), which sets the event levels of a release.
- D1: the `view` kind replaces `dom` in one item. Verdict: accepted in the third review; it reverses H6. Resolution: F212.7 adds the `view` kind and removes `dom` in the same item, with the migration and reader rules stated in H6 and in Steps. F212.11 removes only the remaining page-mount code paths.
- D2: owner of Escape. Verdict: partly accepted. Resolution: the owner of Escape is the view, because a view consumes Escape for its own text input. F212.6a verifies the round trip against the menu close and records the result; it does not choose the owner. The shell layer and the browser sections stay with their plugin repository items (F212.10-shell-layer and F212.10-browser-sections): core does not decide a plugin's internal layout, because plugin functionality belongs to its plugin repository and each repository keeps its own checklist.

**Fourth review**

- Objection: the N7 answer made every event that records a loss or a failure warn or higher, while a 0.0.x release stores only error events. Verdict: accepted. Resolution: each occurrence is classified once. A failure or a rejected operation is an `error` event. A loss, a skip, a transient state or a presentation degradation is counted in the status `core.plugin.losses` or the state `core.plugin.views`, and a `debug` event is written with the count in diagnostic builds ([messages and events](#messages-and-events), event levels in a release). `lateReplies` is removed from `core.plugin.open-calls`, and its count is reported only in `core.plugin.losses`.
