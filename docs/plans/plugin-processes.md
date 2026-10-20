# Plugin process structure

[한국어](plugin-processes.ko.md)

Status: pending proposal for F212.2. The canonical task checklist is [features](../features.md) (F212). This proposal describes work before it starts. When a contract is accepted, it moves into the specifications, and this proposal is removed after the specifications hold it.

## Decision

Plugin code runs outside the workbench page. Each plugin view is a separate web view on the `sok://<plugin id>` origin, with one view per tab. Declared UI is drawn by the workbench from declared UI snapshots that the plugin sends. A plugin host exists only for DOM-free logic that neither a view nor a sidecar can hold.

Measurements do not reverse this decision. They fix the process counts, the per-plugin budgets and the pass values. When a pass value is not met, the design reopens. It does not return to mounting plugin surfaces on the workbench page.

## Reasons

- Memory: WebKit decides the timing of garbage collection from allocation (`heap/GCActivityCallback.cpp`, `didAllocate`; `runtime/OptionsList.h`; F196.20-2). Plugin code on the workbench page shares one heap with the workbench, so one plugin's allocation starts collection for all of them.
- Replaced documents remain in the `querySelectorAll` result cache until memory pressure (G1.4-64-1-4).
- The release workbench page is about 70 MB (G1.4-107).
- Closing one hidden document region returned 227 MB (F198.5).
- Opening each document in a new process raised navigation time from 0.6 s to 1.1 s (F196.27-1, F196.27-2), and that policy was reverted.
- Failure isolation and measurement units: a plugin's failure, memory and measurements belong to its own process.

Values not yet measured are measured in F212.1 before a stage depends on them.

## Layer rules

- **Declared UI:** a screen whose every element is expressed with the declared vocabulary (lists, trees, menus, commands, status lines) is declared UI.
- **View:** any other screen is a view. A view holds free DOM, text input that needs an input method (IME), a canvas or an editor, or a screen that holds a document region or an image region.
- **Sidebar section:** only declared UI can be a sidebar section. A section that needs a view becomes a card surface, and the sidebar holds only a declared item that opens it.
- **Plugin host:** created only when DOM-free logic cannot be held by a view or a sidecar. The files state module is the only such module today. Its move to the files sidecar or to a files view is examined first, and a host is created only when that move is impossible.
- The layer of a screen is not chosen by measurement.

## Placement

| plugin | surface | section | state and logic | extension point | sidecar |
|---|---|---|---|---|---|
| editor | view (CodeMirror, IME) | – | – | imports the modules that contributing plugins declare, from the core module root | files |
| flowmark | view (free DOM) | – | – | – | existing |
| shell | view, unless the design shows that declared UI expresses it | – | – | – | shell |
| files | – | declared tree | moves to the sidecar; a host only when that is impossible | – | files |
| hwp | view with a document region | – | – | – | files |
| browser | view with a document region | four sections become declared UI or card surfaces | – | – | – |
| terminal | view with an image region and overlay screens | – | – | – | vt |

- The modal page is out of scope, because no plugin uses it.
- Whether the editor buffer and its analysis move to a sidecar is set by pass value (iv).

## Pass values

The values below are fixed before stage F212.1 starts. Each value is judged by the measurement named in its row.

| criterion | pass condition |
|---|---|
| (i) total | The summed footprint of N views of one plugin is at most N times the footprint of one view, plus 10 MB. |
| (ii) reclaim | Applies to a view that shares no process with another view; views that share a process are measured as one unit with them. Closing a view opened without a browsing record returns at least 90% of its footprint within 10 seconds, in 3 repeated runs. A process held by an engine cache counts as not returned. |
| (iii) first display | For a view whose process is already running: the DOM mount time of the same plugin plus at most 300 ms. |
| (iii-b) first display of a new process | For a view that starts a new process: the first display time minus the start time of the new process (measured in F212.1) meets (iii). The start time is the median of 5 runs, recorded with the load average. 3 repeated runs. |
| (v) display judgment | Applies to a view whose process is running and whose page is loaded. After a card layout change, the frame of that view reaches its new size within 100 ms, which is 6 frames at 60 Hz (16.7 ms per frame). Fixed before F212.7. |
| (vi) restart limit | When a failure event arrives, the failure time is recorded and counted at that point; no timer is used. Reaching the fourth failure within the last 300 seconds stops the restarts. Failures older than 300 seconds are not counted (sliding window). After a stop, the failure record is cleared and the process starts again when the person opens a surface that needs it. |
| (iv) editor measurement | The footprint of the editor view and the footprint of a hidden DOM editor are measured. When the view footprint exceeds 50 MB, a checklist item for moving the buffer and analysis to a sidecar is added after F212.9. This is a measurement and item-addition rule, not a pass condition. |
| (viii) drag | During a gesture: (a) the difference between the native frame boundary and the card boundary in each frame is at most 2 pt, with the same commit and an expected value of 0; (b) the interval between consecutive content frames (frames that the view draws into its own document, shown after the view's ResizeObserver and the next requestAnimationFrame) is at most 33 ms; (c) a state where the content frame size differs from the native frame size ends within 2 frames (33 ms) after the gesture ends. These values are judged on a recording, not by a timer running in the application. Fixed before F212.7c. |

When a value is not met, the measured values are recorded in the checklist. A failure of an infrastructure value ((v), (vi), (viii)) stops the infrastructure items (F212.7b, F212.7c, F212.8a) and the items that depend on them (F212.8 and later). A failure of a plugin value ((i), (ii), (iii), (iii-b)) stops only that plugin's earlier items. Whether to accept the cost or to change that plugin's layer is an owner decision; this design does not choose between them.

## Rules

1. Plugin code does not run on the workbench page.
2. **Declared UI snapshots.** A plugin view or plugin host pushes its declared UI snapshot to the workbench (push). When the main page loads, including a reload, the workbench requests one snapshot for each declared status of each view and host that its surfaces declare (pull). No other pull is made. Message names and fields are in [messages and events](#messages-and-events).
   - A status has at most one snapshot in transit.
   - A change made while a snapshot is in transit marks the status dirty. When the acknowledgement arrives, the next snapshot carries the latest value.
   - The number of skipped values is recorded in the event log.
   - When a plugin process starts (or starts again), the first snapshot of each status is the full value of that status. The workbench discards the stopped snapshot and the pending acknowledgement of the previous process. A restarted plugin builds its values from its saved state (rule 5).
   - When the view process ends or the surface closes while an acknowledgement is pending, the workbench writes `status.stalled {plugin, status, reason}`. A restarted process sends the latest value of each status as its first snapshot and clears the dirty mark. When the surface is closed, the dirty values are discarded and the reason says so. No timer is used.
3. **Calls across a boundary.**
   - A command declares `timeout` as stated in [exposure](../spec/exposure.md) (at most 600000 ms; 10 seconds when omitted). The timer remains only for the case where a live peer does not reply, because no event reports a slow live reply. This reason is recorded here. When the time limit passes, the call is rejected with an error that names the elapsed time and the timeout, as the current contract states, and `call.timeout {plugin, command}` is written.
   - When the peer disappears, the call ends before its time limit through an event. The peers are: a view or host process that ends, a surface that closes, and a sidecar that ends. The promise is rejected with an error that gives the reason, and `call.peer-lost {plugin, command, reason}` is written. Unresponsive detection (blank 10) adds its own event only when it is decided.
   - A late reply to a call that has ended is not passed to the promise. The host answers the document that sent the reply with the error defined in [host contract](../spec/host-contract.md), and it counts the reply in `call.late-reply {plugin, command, delay}`.
   - The number of open calls, including snapshots waiting for acknowledgement, and the start time of the oldest open call are exposed as the core status `core.plugin.open-calls {plugin, count, oldestStartedAt}`. The name and location are fixed here; F212.3 declares the status.
   - The relay timeout is product behavior of exposure. The two paths are: the host applies the timeout to a command forwarded to a surface page, and the main page applies the timeout to a handler that it runs itself ([exposure](../spec/exposure.md), command `timeout`). Both paths are written in exposure.md in F212.2.
   - Cancellation is part of the call envelope. A binary payload uses a separate channel (blank 2).
4. **Origin and shared modules.**
   - Each plugin HTML runs in its own web view on `sok://<plugin id>`.
   - Shared modules are served from the reserved host `core`, which a plugin id cannot use. `validateManifest` rejects that name.
   - The core root serves the core modules and the files of plugin B that match either of these cases. Each request is checked against the installation record:
     - plugin A's view requests the file, and B declares a contribution to an extension point that A declares in `extends`;
     - A's `dependencies` names B.
   - Any other path answers not found, as in [native surfaces](../spec/native-surfaces.md#document-regions).
   - Red test: a request from a view of plugin A for a file of plugin B, when B neither contributes to an extension point of A nor is in A's dependencies, receives not found.
5. **Restarts.** Sidecars and plugin hosts restart within the limit of pass value (vi). When the limit is exceeded, the host reports `error:` and stops.
   - After the limit is exceeded, the next request fails with `sidecar-failure` (reason `restart limit`) without starting the process. When the person opens a surface that needs the process, the record is cleared and the process starts again, and the host writes `sidecar.restart-reset {sidecar, surface}`. A plugin host writes `plugin.host.restart-reset`.
   - This rule changes the `## Failure` section of [sidecars](../spec/sidecars.md), which states that a failed sidecar is started again at the next request without a limit. That change belongs to F212.8a.
   - A restart restores the state from the last saved value. A state that was not saved is lost, and each plugin states which state that is.
   - Fault injection exists only in diagnostic builds.
6. **Presentation.** A plugin view joins the presentation wait only at the first display after a card layout change (the first change of a gesture).
   - During a continuing gesture (a divider drag or a card drag), the native frame of a view is placed at the new geometry in the same commit as its card, in every frame. The wait for content drawing applies only to the first change. Later content may draw late, and that delay is measured by frame intervals.
   - F212.7c records a full drag gesture, measures the frame intervals and the geometry error, and judges them with pass value (viii).
   - The wait ends with the first of: the presentation completion of the view; the end of the view process; the view becoming invisible when the change ends (a `hidden` ancestor, an unselected tab, a closed surface, read from the state that the workbench already reports for each surface); and, when blank 10 decides it, an unresponsive notification. When the wait ends without presentation completion, the commit continues without that view, and `view.presentation-abandoned {surface, reason}` is written. No timer is used.
   - Pass value (v) is not a runtime deadline. It is the judgment that F212.7b and each plugin item measure.
   - F212.7b records a card entering full screen and a tab change for a card with a view, and checks that both waits end.
   - [native surfaces](../spec/native-surfaces.md) is corrected for this rule.
7. **Input.**
   - The keyboard shortcuts of the workbench are listed with their owner in the table below.
   - A shortcut whose owner is the native menu reaches a core command through the menu.
   - A view registers the shortcut table with the host when it starts. The table holds each workbench shortcut and its owner.
   - The view decides synchronously inside itself, using that table.
     - Only a key whose owner is the workbench has its default action prevented, and the key is passed on with the event information.
     - A key whose owner is the view is handled by the view and is not passed on.
     - A key whose owner is the native menu does not prevent the view's default action, because the menu receives it first.
     - A key that is not in the table keeps its default action.
   - When a passed command fails, the failure is written as an event, and the default action is not run again.
   - F212.12 measures the round trip of Escape against the menu close.
   - IME input goes to the first responder of the view. The activation check (F212.13) verifies it.

   | shortcut | owner | reason |
   |---|---|---|
   | Command `=`, `-`, `0` (View menu: text size, [text size](../spec/text-size.md)) | native menu → core commands `core.text.larger`, `core.text.smaller`, `core.text.reset` | a menu key equivalent works whatever view has focus |
   | Escape | set by the measurement of F212.12 (menu close or view) | measured against the menu close in F212.12 |
   | text input and IME keys | view | the first responder of the view receives them |

   The full list of workbench shortcuts is taken from the menu declarations of both hosts and from the workbench key handlers. The table lists only the shortcuts the specifications declare now; the rest is added to this table before F212.7 starts.

8. **Theme and accessibility.**
   - When it creates a view, the host gives the view's configuration the token set of the current theme as a document-start user script. The page's first script therefore sees the tokens.
   - Later theme changes are sent through the post path.
   - F212.7d compares the color of the first frame with the card token color. The document-start user script is blank 9.
   - Accessibility: F212.12 records whether the element tree of a view reaches the platform accessibility interface. Until a check exists, no accessibility claim is made.

## Messages and events

**Messages**

| message | direction | fields | note |
|---|---|---|---|
| `declared-ui.snapshot` | plugin → workbench (event) | `{plugin, status, seq, value}` | the push of rule 2 |
| `declared-ui.snapshot.ack` | workbench → plugin (event) | `{plugin, status, seq}` | confirms receipt; releases the in-transit slot |
| `declared-ui.snapshot.request` | workbench → plugin (call) | `{status}`; the reply is `{seq, value}` | the one pull of load time |

**Events** (declared in F212.3, except `sidecar.restart-reset`)

| event | fields |
|---|---|
| `declared-ui.snapshot.skipped` | `{plugin, status, count}`: values skipped while a snapshot was in transit |
| `status.stalled` | `{plugin, status, reason}` |
| `call.timeout` | `{plugin, command}` |
| `call.peer-lost` | `{plugin, command, reason}` |
| `call.late-reply` | `{plugin, command, delay}` |
| `view.presentation-abandoned` | `{surface, reason}` |
| `input.shortcut.failed` | `{plugin, key, command}` |
| `plugin.host.restart` | `{plugin, attempt}` |
| `plugin.host.restart-limit` | `{plugin}` |
| `plugin.host.restart-reset` | `{plugin}` |
| `sidecar.restart-reset` | `{sidecar, surface}`, declared by F212.8a |

The message and event names above are the names of the stages that declare them. Identifiers in code use the names as written here.

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
- The repository has a private policy that forces a new process (`_WKNavigationActionPolicyAllowInNewProcess`, [`webview_navigation.m`](../../native/darwin/src/webview_navigation.m), [private native APIs](../operations/private-native-apis.md)). It was used to open each document in a new process, which raised navigation time from about 0.6 s to 1.1 s and lost the process-local cache, and it was reverted (F196.27-1, F196.27-2).
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
- The forced new-process policy brings no gain and loads more slowly, so the default assignment is used and the policy is not.
- Finding during measurement: a run loop driven by hand needs an autorelease pool for each iteration, and reading an item from a weak array that grows autoreleases the item. Without this, a closed view is not released, and its process appears to remain.
- If pass value (i) is not met, the owner decides between this design and the alternative of one view per plugin per window that draws all tabs of that plugin. The alternative reduces the process count, but a failure in one tab then reaches every tab of the same plugin.

## Existing base and open items

**Present**

- Document region: a separate WKWebView, inset placement, input and focus, theme, memory saving and restore, and `sok://` files.
- JSON channel `post` and `document-message` (`document_view.m:39,855`, `surface-modules.js:98-100`, `documents.go:41`, `documents.rs:42`).
- Exposure delivery (`exposure.js:95,108`).
- The separate document runtime frame (`page.js`).

**Open items (blanks)**

1. [native surfaces](../spec/native-surfaces.md) line 113 says region documents receive "no application bridge", and line 115 describes the `post` channel. The correction states that a region document receives no bridge, and that its messages are only `window.postMessage` with the origin checked, which the host sends and receives. The correction is made in F212.4.
2. Call ids, acknowledgements and cancellation are added to the call envelope: a call carries `id`, a reply carries the same `id` with a result or an error, and a cancel carries `id`. The binary path is native in F212.4, on the two hosts.
3. A platform operation creates the plugin host web view. It attaches to the window, not to a `SurfaceHost`. Its throttling while hidden and its `requestAnimationFrame` behavior are measured in F212.1 and F212.9a.
4. Wails has no call path to a web view that the application creates (H3). The path is made in the Objective-C host, and the contract cases verify that both hosts behave the same way (F212.4).
5. The reserved module root of core is built in F212.5. It uses no copy and no link.
6. The region page receives an import map in F212.5.
7. The exposure owner key of a plugin host is `plugin:<plugin id>`. The key uses the plugin id, which is the identity of a plugin (see [identity](#identity)).
8. Each new private API is listed in [private native APIs](../operations/private-native-apis.md) with its call condition when it is added (F212.4). No new private API is decided in this document.
9. A native operation adds the document-start user script to the view configuration, on both hosts, with a contract case (F212.7d).
10. Unresponsive detection: the public API is checked first. No check of a public or private API is recorded in this proposal yet. Until the check is recorded, this design has no unresponsive event, and a stalled view appears only as the open-call status `core.plugin.open-calls`. When the check finds a private API, its call condition is recorded in [private native APIs](../operations/private-native-apis.md) before use.

## Identity

- The sok host identifier is the plugin id.
- The mapping from plugin id to package name is read from the installation record and the plugin folders. [Installation](../spec/installation.md#serving-installed-plugins) states the record: `plugins/installed.json` (format 3) maps each plugin id to its recorded `path`, and the name of a plugin is the `name` of the `package.json` in that folder. The record does not hold the name. The writer of `plugins/installed.json` is the installation process of the application. The readers are the hosts, which serve the installed record at `/installed-plugins.json` for each request, and `sok`, which reads the file from the recorded paths.
- The `id` in `plugin.json` must equal the plugin id of the record. A mismatch is rejected with an explicit error.
- Fixes: `page.js:77,169` and `index.js:1127` are changed to use the mapping. A Red test covers a plugin whose id and package name differ. `e2e/audit.test.mjs:12` silently skips a plugin in this case; the skip becomes a failure.

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

1. **F212.1 Measurement.** WebContent totals per window; base cost of a web view; cost and throttle of a plugin host; DOM editor and flowmark with memory saving on and off, and the same screen as a view; two views of one plugin under (a) and (b); process-sharing pairs (two views of one plugin, two plugins, a view and a document region of one plugin); the main page of two windows; the DOM mount time of every surface plugin in the installed record (the baseline of (iii), recorded with the plugin version); the first display time, the first status time, and the start time of a new WebContent process. The page writes `page.trace.surface.mount {plugin, surface, ms}` at each surface mount when the trace is on, and `make events-check` compares the workbench `trace(` calls with the catalog.
2. **F212.2 Design document.** This document and its Korean translation. The review result is recorded in [objections answered](#objections-answered).
3. **F212.3 Call message layer (plugin-api).** Declares the events of [messages and events](#messages-and-events) in the event catalog, except `sidecar.restart-reset` (declared by F212.8a), and runs `make events-check`.
4. **F212.4 Binary path** (native code and both hosts).
5. **F212.5 Reserved module root and import map.**
6. **F212.6 Identity, exposure registration, and an audit that does not skip.**
7. **F212.7 View configuration kinds** (manifest, workbench, native placement).
   - **F212.7b:** presentation wait participation and budget (v).
   - **F212.7c:** drag recording and geometry error (viii). The first view (the editor view of F212.7a) is the measured view. Every plugin view is measured in its own F212.10 item and in F212.14.
   - **F212.7d:** first-frame theme user script (native item 9).
   - **F212.7a:** after F212.7b to F212.7d and before F212.8, the first view (editor) measures (i), (ii), (iii), (iii-b), (v) and (viii).
8. **F212.8** Declared UI schema and drawing in the workbench, including sidebar sections.
   - **F212.8a:** restart limit (vi) in the `## Failure` section of [sidecars](../spec/sidecars.md) and its translation. Red tests in the host packages that own sidecar failure (Go, Rust, and the contract cases). F212.8a precedes F212.9.
9. **F212.9** Plugin host mechanism (platform operation, owner key, restart). The files repository first completes its item that moves the state to a sidecar. A host is built only when a plugin still needs it.
   - **F212.9a:** when a plugin host is built, its footprint and throttle are measured before F212.10.
10. **F212.10** Plugin migrations (one item per plugin repository, with `engines.soksak`). Each plugin item measures (iii), (v) and (viii) for its views before its release.
11. **F212.11** Removal of the old paths (page mount, parking, the `dom` composition, section and state mounts on the page). The manifest accepts only the new form.
12. **F212.12** Window checks by function (display, input and focus, drag, restart). One item per function.
13. **F212.13** IME activation check (with the user's approval).
14. **F212.14** At the final layout, every plugin view is measured again for (i), (ii), (iii), (iii-b) and (v), and every plugin view is measured for (viii). (vi) is covered by the restart window check of F212.12.
15. **F212.15** Core release. Plugins are released in their own repositories.

## Verification

- Each item: the unit Red and Green tests of the owning module, and the structural checks that the change touches. A full suite is not run to complete an item.
- Completion: (i), (ii), (iii), (iii-b), (v), (vi) and (viii) must pass. (iv) must be measured; when it is over its limit, the follow-up item must exist in the checklist.

## Rollback

- A core stage is rolled back only after the plugin releases that require it are rolled back to their previous `engines` range and released.
- Order: stages F212.3 to F212.6 add mechanisms and do not change the behavior of existing plugins, so they are rolled back by reverting their commits. Stage F212.7a to F212.9 are rolled back after any plugin release that uses them is rolled back. Stage F212.10 is rolled back by releasing each plugin with its previous `engines` range. Stage F212.11 removes the old paths; it is rolled back by reverting its commit only after F212.10 is rolled back.
- The rollback order of each stage is recorded in the checklist item of that stage when the stage is written.

## Risks

- High risk: IME, dragging and layout, process count and first display time, and the Wails call path.

## Objections answered

The plan records no single list of objections. Each entry below is an objection that a rule of this proposal was changed to answer, with the verdict and the resolution recorded in that rule.

- Objection: every view runs in a new process by policy, to isolate each document. Verdict: rejected. Resolution: the measured new-process policy gave no gain and loaded more slowly (F196.27-1, F196.27-2); the default assignment is kept and the policy is not used.
- Objection: a crashing process restarts without end and keeps the page busy. Verdict: accepted. Resolution: a sliding window of 300 seconds stops restarts at the fourth failure, and opening the surface clears the record (rule 5, pass value (vi)).
- Objection: the current sidecar failure rule restarts without a limit, with the same risk. Verdict: accepted. Resolution: the limit applies to every sidecar; the contract change is made in F212.8a with Red tests in the host packages.
- Objection: a timer on each call polls for a reply. Verdict: partly accepted. Resolution: events end a call when its peer is lost (`call.peer-lost`); the timeout remains only for a live peer that does not reply, and the reason is recorded in rule 3.
- Objection: waiting for a view's presentation can block a commit indefinitely. Verdict: accepted. Resolution: the wait ends at the first of four events, with no timer, and `view.presentation-abandoned` is written when it ends without presentation (rule 6).
- Objection: waiting for every content frame during a drag makes the drag lag. Verdict: accepted. Resolution: only the first change waits; the native frame moves in the same commit as its card, and later frames are judged by their intervals under pass value (viii) (rule 6).
- Objection: a view that handles every key blocks native menu shortcuts. Verdict: accepted. Resolution: each shortcut has an owner in the table, menu keys do not prevent the default action, and view-owned keys are handled inside the view (rule 7).
- Objection: copying shared modules into each plugin duplicates code and versions. Verdict: rejected. Resolution: a reserved core root serves the modules, with no copy and no link (rule 4, blank 5).
- Objection: the core root would serve any plugin file to any view. Verdict: accepted. Resolution: only files named by `extends`/`contributes` and `dependencies` are served; other paths answer not found, with a Red test (rule 4).
- Objection: the theme tokens would appear after the first script runs, so the first frame flashes. Verdict: accepted. Resolution: a document-start user script carries the tokens (rule 8, blank 9), verified in F212.7d.
- Objection: a view would be claimed accessible without an element tree check. Verdict: partly accepted. Resolution: no accessibility claim is made until the F212.12 check records the platform interface (rule 8).
- Objection: the files state needs a plugin host. Verdict: partly accepted. Resolution: the state moves to the files sidecar first, and a host is built only when that move is impossible (layer rules, F212.9).
- Objection: a plugin id and its package name can differ, and the audit silently skips such a plugin. Verdict: accepted. Resolution: the mapping comes from the installation record, a mismatched `id` is rejected, the audit skip becomes a failure, and a Red test covers the case (identity).
- Objection: pushing every change of a declared UI floods the workbench. Verdict: accepted. Resolution: one snapshot is in transit per status, changes mark the status dirty, and skipped values are counted in the event log (rule 2).
- Objection: the editor buffer must move to a sidecar now. Verdict: rejected as a rule; accepted as a measurement. Resolution: pass value (iv) measures the footprint, and a follow-up item is added when it exceeds 50 MB.
- Objection: one view per plugin per window uses fewer processes. Verdict: rejected for now. Resolution: it is kept as the alternative to the owner when pass value (i) is not met, because one tab's failure would reach every tab of the same plugin.
