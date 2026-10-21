# Plugin host

[한국어](plugin-host.ko.md)

A plugin host is a process of a plugin, with a platform web view attached to the window, that runs DOM-free logic which neither a view nor a sidecar can hold; it exists only when the contract requires it. A plugin whose sidebar section must show values while none of its views is open needs its plugin host, because a [declared status source](declared-ui.md#declared-status) is the view of the active tab first and the plugin host second. A host is created only when moving its logic to a sidecar or into a view is impossible.

Plugin code does not run on the workbench page, and the main page never runs the code of a plugin host: the host page is a separate web view on the `sok://<plugin id>` origin, like the view of a view surface ([plugin processes](plugin-processes.md) rule 1). The native hosts and the workbench implement this specification; [feature status](../features.md) records its implementation.

## Declaration

The manifest declares the plugin host in `plugin.json` under `host`:

```json
{
  "host": {
    "page": "ui/host.html",
    "state": { "format": 1, "maxBytes": 65536 }
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `page` | yes | The page of the host web view. It follows the page rules of a `view` composition: a path inside the plugin release, relative, without a leading slash, with no empty, `.` or `..` segment and no `.binary` segment, ending in `.html`, and listed in the `files` of `package.json`; `sok plugin pack` fails when the page is not listed |
| `state` | no | The state that the host page saves across a restart of its process, as `{ "format": <positive integer>, "maxBytes": <positive integer> }`, in the form of `surface.unload` ([plugins](plugins.md#memory-saver)); an object with other fields or with a value that is not a positive integer is an error that names the plugin. Without it the host saves no state ([state](#state)) |

The `host` declaration requires nothing beyond the requirement of a plugin to declare `surface`, `sections` or `contributes`. The host web view of a plugin exists only while the manifest of the loaded plugin declares it.

## Web view and configuration

The host creates one plugin host web view per plugin per window, with the configuration of a [view](native-surfaces.md#view-surfaces):

- `isView` set, so that the configuration dispatches the `core` scheme to the core root resolver;
- the plugin id of the plugin, which sets the `sok://<plugin id>` origin of the page and the `Access-Control-Allow-Origin` of its core root responses;
- the document-start user script with the text of `packages/plugin-api/view-start.js`, the [view channel](native-surfaces.md#view-surfaces) script;
- the document-start user script with the theme tokens;
- the script message handler `sok-view`;
- the persistent website data store of the plugin, keyed by the plugin id.

The host loads `sok://<plugin id>/<page>` from the folder that `plugins/installed.json` records for the plugin, as it loads the page of a view. The page declares the [view import map](plugins.md#view-surfaces) of four entries and passes `checkViewPage`; it imports the [view bridge](plugins.md#view-surfaces) and calls `createViewChannel()` over the `sok-view` handler.

The web view is attached to the window, not to a surface host. It is not a surface: it holds no `SurfaceHost`, no surface frame, no regions, and no presentation wait. The host places it hidden and shows nothing: the web view holds a zero frame, is submitted as invisible, draws nothing on the screen, takes no hit testing, and never becomes the first responder. The host page receives no input and registers no shortcut table. `host.hit` never reports it.

## Lifetime

The host creates the plugin host web view of a plugin when the main page of the window loads a plugin whose manifest declares `host`, so the declared sections of the plugin have their source before any view of the plugin is open. It disposes the web view when the plugin is removed or disabled, when the application applies a plugin change that reloads the window, and when the window closes. The host page process ends with its web view and is created again within the [restart limit](#restarts).

The host page holds no surface context: it receives the synchronous values of the plugin (`icon(name)`, `origin`, `project` and `declarations`, without `params`, which belong to a tab) as a view page does, reaches asynchronous operations through the view bridge, and gets `contributions(point)` as the connected items of the point.

## Channel

The plugin host channel is the [view channel](native-surfaces.md#view-surfaces) on the web view configuration above: the same document-start script, the same `sok-view` handler, the same ready message with the document identifier that makes the ready document, the same queue of at most 256 messages, the same `sok: 1` marker of host messages, the same delivery with `window.postMessage(message, location.origin)`, and the same refusal of a message without the marker. A message that arrives with the queue full is not queued: the script reports the reason `queue full for <plugin>` through `sok-view` in a `view.error` message, the host writes `error: plugin host channel: queue full for <plugin>` to the application log, and the host closes the plugin host and creates it again within the restart limit. No host message is dropped without a record.

What differs from a view is the peer and the calls:

- Every relayed message carries the plugin and no surface, because the host page holds no surface.
- The host forwards each call request `{sok: 1, id, command, params}` of the page whose `id` is an integer and whose `command` is a registration call of [exposure](#exposure) to the main page of the window as the event `plugin-host-call {plugin, id, command, params}`, and each cancel `{sok: 1, id, cancel: true}` as `plugin-host-call {plugin, id, cancel: true}`. The main page answers with `pluginHostReply {plugin, id, result}` or `pluginHostReply {plugin, id, error: {code, message}}`, and the host posts `{sok: 1, id, result}` or `{sok: 1, id, error}` to the ready document. A message with any other invalid field is written to the application log as `error: plugin host channel: <reason>` and is not forwarded.
- The page answers a request with `{sok: 1, reply: id, result}` or `{sok: 1, reply: id, error: {code, message}}` through `sok-view`, as a view answers a [view command](native-surfaces.md#view-surfaces). The declared `timeout` of the command bounds the wait, and a reply after the limit is discarded as a late reply.
- The calls of the page that the channel serves are the registration calls of [exposure](#exposure), which the main page answers, and the calls of [state](#state), which the host answers itself; a [snapshot](#declared-ui-snapshots) is a message of the page, not a call. The host answers a call request of any other non-empty command itself with `{sok: 1, id, error: {code: -32000, message: "plugin host call <name> is not served"}}` and forwards nothing. A plugin host has no `tab.state` call, no region operation, no sidecar send, and no clipboard or link call: the logic that needs them belongs in a view or a sidecar, not in a plugin host.
- The theme reaches the host page as it reaches a view: the document-start script carries the tokens, and each later theme change is sent as a host message after each ready message.
- The first ready message after the host created the web view writes `host.trace.plugin-host.process-ready {plugin, window}` at level `debug`, as the first ready message of a view writes `host.trace.view.process-ready`.
- When the host disposes the plugin host web view of a plugin on its removal or disable or on a queue overflow, or the page process of the host ends, it sends the event `plugin-host-ended {plugin}` to the main page of the window. The main page removes every registration under `plugin:<plugin id>` ([exposure](#exposure)) and ends each of its open requests to the host with `surface-closed`, as the close of a view ends them. A reload or the close of the window sends no event, because the main page that holds the registrations is replaced or ends with it.

## Exposure

A plugin host page registers its declared statuses, commands and dom entries through the channel, with the calls a view page uses: `runtime.command.register` for a command, and the exposure registration (`page.exposure.register(kind, name)`) of [exposure](exposure.md) for a status and a dom entry. The owner key of every registration of the plugin host is `plugin:<plugin id>`; a surface page registers under its surface id with the owner from its plugin. A name that the `exposes` of the plugin does not declare is refused with the registry error. The registration of a plugin host ends with its process, and a process that is created again within the restart limit registers again under the same key.

The plugin host is not a surface: a request without `surface` for a name that a plugin host registered is answered by its registration when no surface page and no state module registered the name ([choosing a surface](exposure.md#choosing-a-surface)). A request that names a `surface` is never answered by a plugin host. The plugin host answers `command.run` by running the registered command through the channel within its declared time limit, and `status.get` by the pull of the status ([declared UI snapshots](#declared-ui-snapshots)), whose reply `{seq, value}` is returned as `{value, version: seq}`. It pushes its statuses as declared UI snapshots, so a `status.watch`, a `status.unwatch` or a dom request that only a plugin host would answer is refused with `plugin host <plugin id> does not serve <method>`.

## Declared UI snapshots

A plugin host pushes a [declared UI snapshot](declared-ui.md) of each declared status that it registered and answers the pull request, as a view does. The snapshot carries the plugin and no surface; the pull is the `declared-ui.snapshot.request` call and its reply is `{seq, value}` ([plugin processes](plugin-processes.md) rule 2). When the plugin host starts or starts again, the first snapshot of each status is the full value of that status, and a restarted plugin host builds its values from its saved state ([state](#state)); the workbench discards the stopped snapshot and the pending acknowledgement of the previous process ([plugin processes](plugin-processes.md) rule 2). A status that only a state module registers has no source, and a declared status that the host registered is served again by the new host process, which registers it again and pushes the full first snapshot, as the transitions of [declared status](declared-ui.md#declared-status) state; a view of the plugin that registers it becomes the source ([declared status](declared-ui.md#declared-status)).

## Restarts

The restart limit of a plugin host is the limit of a sidecar of standard input and output ([sidecars](sidecars.md#failure)): the failure record and the restart limit are per plugin: the failures of the host pages of the plugin in every window count in one record, and the stop of the limit stops the host page in every window. The saved state of the state calls is one value per plugin, which the host page of every window reads and writes. The host counts the failures of the plugin host by the time of each failure, which is taken when its failure event arrives; no timer runs. A failure more than 300 seconds before a new failure is not counted (a sliding window). A failure of a plugin host is an end of its page process that the host did not cause by its own disposal (plugin removal or disable, a plugin change that reloads the window, the close of the window), or the queue-full error of its channel. When the fourth failure is counted, the host writes `error: plugin host <plugin>: restart limit: 4 failures within 300 s` to its log, writes the event `host.plugin-host.restart-limit {plugin}` at level `error`, and stops the restarts of that plugin host. Each restart of the page process writes the event `host.plugin-host.restart {plugin, attempt}` at level `error`, where `attempt` counts the restarts of the plugin host since the last reset.

While the plugin host is stopped, the host creates it again for no request: its registrations are removed, a request for one of its names returns the error of a name that is declared but not registered, and the declared sections it served stay cleared. The stop clears no failure record by itself.

Only the person's open of a surface of the plugin clears the stop. When the person opens a surface of the plugin while its plugin host is stopped, the host clears the failure record of its plugin host, writes the event `host.trace.plugin-host.restart-reset {plugin}` at level `debug`, and creates the plugin host again in every window, as the stopped sidecar of [sidecars](sidecars.md#failure) is cleared. The open of a surface while the plugin host is not stopped clears nothing, and the creation of a surface of another plugin clears nothing.

A restart restores the state from the last saved value ([state](#state)). A state that was not saved is lost, and each plugin states in its own documentation which state that is.

## State

The plugin host state is the value that the host page of a plugin saves through its channel and that the host keeps for the next start of the page.

- When the `host` declaration names `state`, the channel serves the calls `state.write {value}` and `state.read`, which the host answers itself and forwards to no page. `state.write` refuses params without a `value` and a value whose compact JSON exceeds `maxBytes` bytes with an error that names the plugin and the size, and otherwise replaces the saved value of the plugin and returns `null`. `state.read` returns `{value}`, the last saved value, or `{value: null}` when nothing is saved. A page reads its state at its start and saves it whenever it changes, so a restart within the limit restores it.
- The host keeps the last saved value until the application ends or the plugin is removed or disabled. The value is held in the host process and survives a restart of the plugin host page, not the end of the application.
- The saved value carries the declared `format`. A page that reads a value of another format is refused with an error that names the plugin, the format found and the declared format, as a tab state of another format is refused ([plugins](plugins.md#memory-saver)).
- Without the `state` field both calls are refused with an error that names the plugin, and a restart starts the page with no saved state.
