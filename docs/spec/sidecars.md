# Sidecars

[한국어](sidecars.ko.md)

A sidecar is a native process that holds functionality for one domain, such as shell sessions. Plugins use it through the native host; the host relays messages and does not interpret their bodies. One sidecar implementation serves both Wails and Tauri.

The approved persistent service contract is defined by [persistent services](persistent-services.md). Its process ownership, transport, close, and recovery rules apply to every sidecar that declares `transport: "persistent"`. Other stdio sidecar domains retain their own lifecycle. [Features](../features.md) records implementation and application verification separately.

## Declaration and startup

A sidecar is a program in its own repository with a `package.json` and a `sidecar.json` file ([repositories](plugins.md#repositories)). The `name` of its `package.json` identifies the sidecar, for example `@soksak/sidecar-shell`. [`validateSidecar`](../../packages/plugin-api/index.js) checks the file:

| Field | Meaning |
| --- | --- |
| `executable` | Path of the built executable inside the sidecar |
| `displayName` | Required process display name in the form `soksak://sidecar/<id>`, where `<id>` is one lowercase identifier component. The sidecar applies this value, embedded from its own versioned `sidecar.json` at build time, to its operating-system process identity. It is independent of the dependency name and executable path. The host does not set this value in the child environment. |
| `protocol` | Message format version. The current version is `1` |
| `helpers` | Optional array of helper programs. Each item has `name` (the `name` of the helper's `package.json`) and `executable` (the path inside the helper's folder) |
| `events` | Optional path inside the package of the file with the event catalog of the sidecar ([logging](logging.md#catalog)); the release packs the file |
| `replay` | Optional `{role, executable, inputs}` of a sidecar that produces screens: `role` is the role of its event files (a lowercase word), `executable` is the path inside the sidecar of its replay executable ([replay](replay.md#replay-executable)), and `inputs` maps each kind of replay input (`output`, `write`, `resize`, `selection`, `viewport`, `theme`) to the name of the event that stores it, a name of the layer `sidecar` that starts with `sidecar.` ([replay](replay.md#records)) |

A plugin declares the sidecars its page uses, each with a version range, as the `dependencies` of its `plugin.json` ([plugins](plugins.md#pluginjson)). Installation extracts each sidecar's release into the configuration directory.

`sidecar.json` is a manifest of a versioned release, not user data. Installing another sidecar release extracts its versioned package into a different install path and updates the installed declaration to that package. A release that adds a required manifest field updates its package and its dependent plugin version range; installing that release replaces the old manifest. The current reader rejects an older manifest that lacks `displayName` with the manifest path and missing field. It does not infer a name or read both manifest forms. `protocol` remains the wire-message protocol and does not version the manifest.

The installer does not overwrite an existing sidecar version folder. Removing a plugin removes its package folder and prunes sidecar folders no remaining installed plugin declares; reinstalling then extracts the selected release again. This replaces installed package files, not project documents. A plugin may store its own data outside its package folder, so inspect its declared storage contract before removing it to replace a sidecar.

The host resolves sidecars from the installed plugins ([serving installed plugins](installation.md#serving-installed-plugins)):

1. `plugins/installed.json` lists the enabled plugins with their recorded folders and each sidecar with its recorded folder.
2. The `plugin.json` in each plugin folder lists its sidecars.
3. The `sidecar.json` in each sidecar folder gives the `executable` path, `protocol`, and required `displayName` of the sidecar.

The host declares the sidecars again after each plugin operation ([applying a change](installation.md#applying-a-change)), which replaces a sidecar whose folder changed. The host runs the `executable` inside that folder. It fails at startup when `installed.json` or a `sidecar.json` is missing or invalid, its `executable` is not a path inside the sidecar, or its `protocol` is not `1`. It starts a sidecar when a page first sends to it. A request for a sidecar that no plugin declares fails with `sidecar <name> is not declared by any plugin`; a request after the host stops its sidecars also fails.

Child processes spawned by a sidecar do not inherit the host's pipes or process group. When the host closes the sidecar's standard input, the sidecar must end within 2 seconds; if it does not, the host waits up to 5 seconds total before sending a force-kill signal, and writes `sidecar <name>: did not end within the stop timeout and was killed` to its log. While it waits, the host reads the sidecar's standard output until the output ends, so the sidecar's writes on its way out neither block nor fail. A sidecar that ends during the stop with an exit status other than 0 or by a signal is written to the log as `sidecar <name>: exited while stopping: <exit>`; the host writes no such line for a process that it killed or whose output it stopped reading after a [failure](#failure). `<exit>` is `exit status <code>` or `signal <number>` on both hosts.

Only a package that has a `sidecar.json` is a sidecar the host runs. Other packages of a sidecar repository are libraries and helper executables that its sidecars share.

## Messages

Each message is one JSON object on one line. A sidecar message on standard output ends with a newline and has at most 67108864 bytes (64 MiB) before the newline; both hosts use this limit. The limit holds a multi-megabyte message, such as a database schema snapshot, with more than ten times headroom, and it bounds the memory that the host holds for one message. The host enforces the limit while it reads: it does not buffer more than the limit and the newline of one message.

| Direction | Message |
| --- | --- |
| Host → sidecar | `{"surface": id, "root": path, "cids": [id, …], "body": value}` for a page request. `cids` is present only when the request continues inputs, and it lists their correlation identifiers (see [logging](logging.md#event)); a sidecar that records the request copies them into its events. `root` is the project directory of the owning window when the host first sends for the surface; later requests for the surface keep that root after the window changes project, because a sidecar may identify a session by root and surface |
| Host → sidecar | `{"surface": id, "root": path, "closed": true}` when the logical surface leaves every project layout outside persistent `retain` reconciliation, or its window closes, with the surface's root, to each sidecar process that received a request for the surface; a sidecar that never received it gets no notice. Removing only the native view while a project layout retains the surface closes stdio sessions but leaves persistent sessions open |
| Sidecar → host | `{"surface": id, "cids": [id, …], "body": value}`. `cids` is optional and lists the correlation identifiers of the requests that the message answers; a body that is an object with the member `error` states a failed request. The host stores such a message as the event `host.sidecar.reply` ([result form](logging.md#result-form)) |
| Sidecar → host | `{"surface": id, "closed": true}` once the sidecar has released the resources of a closed surface, such as its sessions, processes and watches, or `{"surface": id, "closed": true, "error": text}` when it could not release them |

The host records the window that first sends for a surface and delivers each sidecar message only to that window, as the `sidecar-message` event `{sidecar, surface, body}`, where `sidecar` is the `name` of the sidecar's `package.json`. A request from another window for the same surface fails. When the application exits, the host closes each sidecar's standard input and waits for the process to end.

The host remembers, for each sidecar process, every surface it has sent a request to, until the process ends. A message for such a surface that no longer has an owning window is discarded: the sidecar sent it after the host removed the surface and sent `closed`, before its answer to `closed`. A later request for the same surface may be sent before that answer; the host routes standard-output messages by the surface’s current owner, including a line already buffered before the close answer. The wire identifies the surface and optional request `cids`, not a separate session generation. A line without a line feed at the end of the output of a sidecar, which a process that ended while it wrote leaves, is not a message: the output ends there as the connection does, and the host records the size of the line. A discarded transfer image from a running sidecar is answered `closed` ([image consumption](native-surfaces.md#image-regions)). When the host is stopping a standard-input-and-output sidecar, a transfer image received after stop begins is canceled without a reply. The host records the cancellation and waits for the sidecar process to end; process exit releases the sidecar's transfer-image resources. A persistent service remains connected through `close-owner` and receives `closed` answers for discarded transfer images before the host sends `shutdown` and closes the transport.

Persistent layout reconciliation closes omitted sessions through `retain` and awaits `retained` ([persistent services](persistent-services.md#closing-and-recovery)); it does not require per-surface `closed` envelopes. `host.sidecars.closing` tracks only sent per-surface `closed` envelopes awaiting answers.

A sidecar answers every `closed` it receives. A surface that sends again after its close and is closed again before the answer has one pending close per `closed` sent, and each answer settles one of them. From sending `closed` until the answer, the host lists the surface in the application status `host.sidecars` as `{closing: [{sidecar, surface}]}`, sorted by sidecar and surface, and notifies the connections that watch it when the list changes. An answer with `error` is written to the host log as `sidecar <name>: close <surface>: <error>`; the surface has no owning window that could receive it. When a sidecar process ends or a persistent connection is lost, the host removes that sidecar's surfaces from the list, because their sessions ended with the process or the service completes the recorded close on its own. When the host stops its sidecars, it removes the surfaces of the standard input and output sidecars from the list, because those processes end. Such a sidecar still answers those closes on its way out; the host accepts each answer, writes an answer with `error` to its log as above, and does not treat it as a failure. A persistent service answers the closes that the host sent before the stop ahead of its close-owner reply, so the host keeps those surfaces until each answer arrives or the connection ends, and such an answer is not a failure. A message for a surface that the host never sent to that process is a [failure](#failure). The persistent transport keeps sessions across application processes, so a service may send for a surface that this application process has not sent to yet; it discards a message for a surface without an owning window.

The operation selector in a sidecar request body is an existing transport detail. A plugin manifest does not copy that wire spelling: it declares the readable `background.operation` name, and the workbench sends the corresponding sidecar request at one transport boundary. Missing operations and sidecar errors are failures; they are not replaced or discarded.

The host enqueues each immutable `host.sidecars` value while serializing its state mutation, so a fast answer cannot erase the pending-close transition or reverse notification order. A status read observes closing and outdated services from one state and declaration snapshot. The notification consumer only enqueues the supplied value; it does not read sidecar state or acquire the window registry. Window UI invalidation runs outside the sidecar state lock. Capturing a value under the lock but publishing it afterward does not preserve mutation order, and rereading state in a deferred UI task does not preserve transient values. Declaration replacement and its version-change publication are serialized by the same state lock. A rejected declaration leaves the value unchanged; a declaration with the same visible status sends no change. A stale connection ending cannot remove or announce the current connection. Version-only changes and outdated removal on current connection loss are published independently of pending closes. Stop publishes after removing the running entries. Authoritative retain publishes changed owned-session counts after removing omitted ordinary owners; plugin and state sessions keep their explicit lifecycles. Reusing a surface ID whose owner was removed publishes the restored count even when the process remembers that ID. Repeated operations with no visible status change publish nothing.

A sidecar declares its message form in `sidecar.json` as `message: {form, operationField}`: `form` is `json-object`, and `operationField` names the string field of a request body that selects the operation. A sidecar that lets a plugin host call operations lists them in `hostReadOperations`, the read-only operations that a plugin manifest may name in `hostOperations` ([plugins](plugins.md#pluginjson)). A sidecar with no list allows no operation to a plugin host. The main page checks each host request in the declared form and refuses every other operation before it reaches the sidecar ([plugin host](plugin-host.md#channel)). `@soksak/plugin-api` checks these declarations (`validateSidecar`, `checkHostOperations`).

## Failure

A sidecar that uses standard input and output fails when:

- it sends a line longer than the message limit;
- it sends a line that is not a JSON object with a string `surface` and either a `body` or `closed` true;
- it answers `closed` for a surface that the host is not closing and whose close a stop did not remove from the list;
- it sends a message for a surface that the host never sent to that process;
- reading its standard output fails;
- its standard output ends, including when the process exits, while the host is not stopping its sidecars.

The protocol state after a failure is undefined, so the host reads no further messages from that process. The host removes the process from its running sidecars, sends it the force-kill signal, and waits for it to end. It then writes the failure to its log and delivers the `sidecar-failure` event `{sidecar, surface, reason}` to the owning window of each surface that sent a request to that process and still has an owner. `reason` is text that names the cause: `message exceeds 67108864 bytes`, `invalid message: <parser error>`, `unknown surface <surface>`, `unexpected close answer for <surface>`, `read: <error>`, or `output closed: <exit>`, where `<exit>` has the form of the stop rules in [declaration and startup](#declaration-and-startup). A request that the failed process did not answer gets no reply; the page observes the failure instead.

A send after a failure follows the start rule: the next request to that sidecar starts a new process, unless the restart limit below stops it. The new process has none of the sessions of the failed process, so a page that keeps a session opens it again. Each surface keeps its owning window and its first root.

The restart limit applies to a sidecar of either transport: the failures of a standard input and output sidecar are the ones above, and the failures of a persistent service are the ones that [persistent services](persistent-services.md#service-transport) names. The host counts the failures of the sidecar by the time of each failure, which is taken when its failure event arrives; no timer runs. A failure more than 300 seconds before a new failure is not counted (a sliding window). When the fourth failure is counted, the host writes `error: sidecar <name>: restart limit: 4 failures within 300 s` to its log, writes the event `host.sidecar.restart-limit` `{sidecar}` at level `error`, and stops the restarts of that sidecar. While the sidecar is stopped, a request from any surface, whether the surface sent to the failed process or was opened later, does not start a process. The host writes `error: sidecar <name>: restart limit: request for <surface> refused`, delivers `sidecar-failure` `{sidecar, surface, reason: "restart limit"}` to the owning window of the surface, and the send fails with `sidecar <name>: restart limit`. The `sidecar-failure` delivery of a refused send is the report of the standard input and output transport; a persistent service reports the refused send through its connection notice, as [persistent services](persistent-services.md#service-transport) names.

Only the person's open of a surface or the person's enable of a plugin clears the stop. When the host creates a surface of a plugin whose `plugin.json` lists the sidecar in `dependencies`, or the person enables such a plugin, the host clears the failure record of that sidecar, writes the event `host.trace.sidecar.restart-reset` at level `debug` with `{sidecar, surface}` for the surface or `{sidecar, plugin}` for the enable, and the next request starts the process. A request from a surface that is already open does not clear the stop, and the creation of a surface of a plugin that does not list the sidecar does not clear it. These two actions are the clear triggers of a sidecar stop. Each of them clears, in the same step, the stop of the plugin host of its plugin (plugin-host.md#restarts), so the sessions that the plugin host opens again after that clear find the sidecar stop cleared too. An automatic restart of a plugin host within its limit clears no sidecar stop. A plugin with a host and no surface has no open, but it has an enable, so its stops are cleared by its enable.

While the host stops its sidecars, the end of output is not a failure. Any other failure during a stop is written to the host log as `sidecar <name>: failed: <reason>`, and the host sends no failure event, because a send after the stop fails and a page cannot open its session again; the stop rules in [declaration and startup](#declaration-and-startup) then end the process. When the host stops reading a sidecar's output after a failure, during a stop or not, it closes its end of the pipe, so the sidecar's later writes fail instead of blocking. These failure rules, except the restart limit, apply to the standard input and output transport; the persistent transport reports connection loss as [persistent services](persistent-services.md) defines.

## Plugin host sessions

A [plugin host](plugin-host.md#channel) sends to the sidecars that its plugin lists in `dependencies`. Its session id has the form `plugin:<plugin id>:<project id>:<sidecar name>`. No plugin id, project id or sidecar name contains `:`, so the form parses without ambiguity. A surface send to a `plugin:` session is refused with `sidecar session <id> is reserved for a plugin host`, and only the host of the plugin sends to it.

The main page of the window sends a request of the host with the host call `pluginHostSidecarSend {plugin, sidecar, id, body, cids}`. The host call refuses a caller that is not the main window, a sidecar that the plugin does not list, and a session id that names another plugin or sidecar. The send uses the folder root that the window records for the project id of the session; a project that the window does not hold, or whose recorded root is empty, is refused before any start. The owner record of the sidecar applies to the session as to any surface: the first send records the window as its owner.

A failure of a plugin session counts in the failure record of its sidecar, which every other session of the sidecar shares, and the restart limit applies to it as stated under [failure](#failure). The host closes its sessions: the main page calls `pluginHostSidecarClose {plugin}` when the host ends, which closes the sessions of the plugin that the calling window owns, and the host closes the sessions of a window when the window reloads or closes and when a project is released by its holding window. Each close sends `closed` for the session as [messages](#messages) states.

## Log

A sidecar writes a line of its standard error as a text record `<time> <level> <layer> <where>: <text>` ([diagnostics](diagnostics.md#forms)) with the layer `sidecar` and its own name as `<where>`. A sidecar that the host starts with standard input and output may write any text: the host reads each line of its standard error and writes it as a record of level `info`. A persistent service opens no pipe to the host, so it writes the form itself, and its file `logs/<executable-name>.log` holds only records of that form.

The host starts every sidecar with the argument `--log-dir <config-dir>/logs`, the folder of its event files, whether the sidecar uses standard input and output or is a persistent service (which also receives `--service-dir`). A sidecar that adopts the [event contract](logging.md#files) writes its event file `<role>-<boot>.jsonl` in that folder; a sidecar started without the argument writes no event file. A host created without a configuration directory has no such folder and passes no argument.

## Page interface

`page.sidecar(name)` takes a sidecar and returns `send(surface, body, cids)`, `on(surface, fn)`, and `onFailure(surface, fn)`; `cids` are the correlation identifiers of the inputs that the request continues, which the host call `sidecarSend` passes to the request line ([logging](logging.md#correlation-identifier)). `on` calls `fn(body)` for each `sidecar-message` event of that sidecar and surface, and `onFailure` calls `fn(reason)` for each `sidecar-failure` event of that sidecar and surface. Both return a promise that resolves after the subscription is registered; a page subscribes before its first request. Sends of one sidecar reach the host in call order, and a send that fails rejects its caller, does not stop the sends after it, and is written to the application log as `error page sidecar <name>: send failed: <reason>`, by `page.report({level, where, text})` for a document of a surface and by the host call `report` for the main page, the call by which a document of a surface writes a record of the page layer (the host call `report` of the main page does the same).

In the application document, the workbench installs one `sidecar-failure` listener before it sends the first sidecar request. It calls the failure handlers that views, plugin hosts, and background sessions registered through the workbench for that sidecar and surface. When no handler is registered, the workbench reports the failure as a page error: it dispatches an `error` event to the window, which writes the failure to the application log and shows it in the application error alert.

## Image envelope

A sidecar that supplies images to a [region](native-surfaces.md#image-regions) sends an image envelope to the host:

```json
{
  "surface": "surface-id",
  "body": {
    "image": {
      "name": "region-name",
      "generation": 2,
      "raster": 7,
      "token": {
        "kind": "iosurface-global",
        "id": 12345,
        "nonce": "base64-encoded-16-bytes"
      },
      "width": 800,
      "height": 600,
      "scale": 1.0,
      "format": "bgra8",
      "sequence": 1
    }
  }
}
```

The host validates the envelope and returns a response without an `op` field:

| Condition | Response | Meaning |
| --- | --- | --- |
| Region not declared, generation ended, or sender not authorized | `{"image": {"error": "notAttached", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | Region does not exist in the current declared composition, or belongs to a different generation or sidecar |
| Format or token kind not supported, or nonce invalid | `{"image": {"error": "unsupported", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | Format must be `bgra8` and token kind must be `iosurface-global`; nonce must be exactly 16 bytes when base64-decoded |
| IOSurface not found or access denied | `{"image": {"error": "notFound", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | IOSurface lookup failed or permission denied |
| Declared size does not match the IOSurface's actual size | `{"image": {"error": "size", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | Width and height in the envelope must match the actual IOSurface dimensions in pixels |
| Image scale differs from the window's backing scale factor | `{"image": {"error": "scale", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | The image must be drawn at the window's current backing scale factor |
| Generation, raster revision, sequence, or expected dimensions are stale | `{"image": {"error": "stale", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | The frame cannot replace the current raster |
| Success | `{"image": {"consumed": {"name": "...", "generation": ..., "raster": ..., "sequence": ...}}}` | The host copied the transfer pixels into immutable host-owned presentation storage |

The nonce is a 16-byte value attached to the IOSurface that the host uses to verify the surface's identity when looking it up by global identifier. The generation identifies one page attachment, the raster revision identifies one exact native size and scale, and sequence numbers increase within that pair. The host includes all three in the response.

The host sends the authorized supplier a `configure` body containing the region name, generation, raster revision, exact pixel dimensions, and scale. The supplier must not derive these values from page geometry. It must not modify or reuse a sent transfer surface until `consumed` or an error arrives. The host never binds that mutable transfer surface directly to the presentation layer; the copy completed before `consumed` is the reuse boundary.

When the host closes an image region but keeps its sidecar session, it sends `{"image":{"detach":{"request":"opaque-id","name":"region-name","generation":2}}}` to that region's supplier after closing the native region. The supplier replies only after it has removed that generation's render ownership, requested image, and pending configuration. It retains outstanding transfer images until their matching `consumed` or error response, or connection end, under the existing transfer ownership rules. The detach keeps the surface session and its process alive and leaves it headless, so an image-less `open` can continue the same session. The supplier returns one of these results in `image.detached`:

| Condition | Result | State change |
| --- | --- | --- |
| Exact current configured image name and generation | `{ok: true, result: "detached"}` | Removes that image ownership and configuration; retains the session and transfer leases |
| Same generation was already detached and no newer owner exists | `{ok: true, result: "alreadyDetached"}` | None |
| No image, request, or configuration exists for the surface | `{ok: true, result: "alreadyAbsent"}` | None |
| Matching requested image has no configuration yet | `{ok: true, result: "detached"}` | Clears the request and records the detached generation; retains the session |
| Requested image name differs from the current image name | `{ok: false, error: "imageNameMismatch"}` | None |
| Request generation is older than known current or retired generation | `{ok: false, error: "staleGeneration", currentGeneration}` | None |
| Request generation is newer than a configured attachment | `{ok: false, error: "futureGeneration", currentGeneration}` | None |
| Request id was previously used with another surface, image name, or generation | `{ok: false, error: "requestMismatch"}` | None |

Request identifiers must remain unique across application restarts because a persistent supplier can retain its request ledger after its client exits. Every result also echoes the opaque `request`, `name`, and `generation`. A replay of a request id with the same tuple returns its result only while no newer image owner has appeared; reuse with a different tuple is `requestMismatch`. The host associates an acknowledgement with its exact request id, sidecar, surface, image name, and generation; another surface, owner, request, or generation cannot settle it. The host recognizes `image.detached` from its declared path without materializing unrelated JSON members at the root, inside `image`, or inside the acknowledgement object; a deeper unrelated member does not prevent acknowledgement processing or cause the raw acknowledgement to be forwarded as an ordinary message. Page startup waits for all detach acknowledgements caused by reload before it allows a new page to open background sessions or attach replacement images. A failed or timed-out detach fails page startup with the sidecar, surface, image name, generation, and request id.

## Tests

Each sidecar runs its tests in its own directory. Each host tests its relay, the message limit, and failure delivery in `tests/sidecars_test.*` and its resolution from staged manifests with a fake sidecar executable and does not start a real sidecar.
