# Sidecars

[한국어](sidecars.ko.md)

A sidecar is a native process that holds functionality for one domain, such as shell sessions. Plugins use it through the native host; the host relays messages and does not interpret their bodies. One sidecar implementation serves both Wails and Tauri.

The approved persistent terminal service is defined by [terminal runtime](terminal-runtime.md). Its process ownership, transport, close, and recovery rules apply to the terminal sidecar. Other stdio sidecar domains retain their own lifecycle. [Features](../features.md) records implementation and application verification separately.

## Declaration and startup

A sidecar is a program in its own repository with a `package.json` and a `sidecar.json` file ([repositories](plugins.md#repositories)). The `name` of its `package.json` identifies the sidecar, for example `@soksak/sidecar-shell`. [`validateSidecar`](../../packages/plugin-api/index.js) checks the file:

| Field | Meaning |
| --- | --- |
| `executable` | Path of the built executable inside the sidecar |
| `protocol` | Message format version. The current version is `1` |
| `helpers` | Optional array of helper programs. Each item has `name` (the `name` of the helper's `package.json`) and `executable` (the path inside the helper's folder) |

A plugin declares the sidecars its page uses, each with a version range, as the `dependencies` of its `plugin.json` ([plugins](plugins.md#pluginjson)). Installation extracts each sidecar's release into the configuration directory.

The host resolves sidecars from the installed plugins ([serving installed plugins](installation.md#serving-installed-plugins)):

1. `plugins/installed.json` lists the enabled plugins with their recorded folders and each sidecar with its recorded folder.
2. The `plugin.json` in each plugin folder lists its sidecars.
3. The `sidecar.json` in each sidecar folder gives the `executable` path and `protocol` of the sidecar.

The host declares the sidecars again after each plugin operation ([applying a change](installation.md#applying-a-change)), which replaces a sidecar whose folder changed. The host runs the `executable` inside that folder. It fails at startup when `installed.json` or a `sidecar.json` is missing or invalid, its `executable` is not a path inside the sidecar, or its `protocol` is not `1`. It starts a sidecar when a page first sends to it. A request for a sidecar that no plugin declares fails with `sidecar <name> is not declared by any plugin`; a request after the host stops its sidecars also fails.

Child processes spawned by a sidecar do not inherit the host's pipes or process group. When the host closes the sidecar's standard input, the sidecar must end within 2 seconds; if it does not, the host waits up to 5 seconds total before sending a force-kill signal, and writes `sidecar <name>: did not end within the stop timeout and was killed` to its log. While it waits, the host reads the sidecar's standard output until the output ends, so the sidecar's writes on its way out neither block nor fail. A sidecar that ends during the stop with an exit status other than 0 or by a signal is written to the log as `sidecar <name>: exited while stopping: <exit>`; the host writes no such line for a process that it killed or whose output it stopped reading after a [failure](#failure). `<exit>` is `exit status <code>` or `signal <number>` on both hosts.

Only a package that has a `sidecar.json` is a sidecar the host runs. Other packages of a sidecar repository are libraries and helper executables that its sidecars share.

## Messages

Each message is one JSON object on one line. A sidecar message on standard output ends with a newline and has at most 67108864 bytes (64 MiB) before the newline; both hosts use this limit. The limit holds a multi-megabyte message, such as a database schema snapshot, with more than ten times headroom, and it bounds the memory that the host holds for one message. The host enforces the limit while it reads: it does not buffer more than the limit and the newline of one message.

| Direction | Message |
| --- | --- |
| Host → sidecar | `{"surface": id, "root": path, "body": value}` for a page request. `root` is the project directory of the owning window when the host first sends for the surface; later requests for the surface keep that root after the window changes project, because a sidecar may identify a session by root and surface |
| Host → sidecar | `{"surface": id, "root": path, "closed": true}` when the surface is removed or its window closes, with the surface's root |
| Sidecar → host | `{"surface": id, "body": value}` |
| Sidecar → host | `{"surface": id, "closed": true}` once the sidecar has released the resources of a closed surface, such as its sessions, processes and watches, or `{"surface": id, "closed": true, "error": text}` when it could not release them |

The host records the window that first sends for a surface and delivers each sidecar message only to that window, as the `sidecar-message` event `{sidecar, surface, body}`, where `sidecar` is the `name` of the sidecar's `package.json`. A request from another window for the same surface fails. When the application exits, the host closes each sidecar's standard input and waits for the process to end.

The host remembers, for each sidecar process, every surface it has sent a request to, until the process ends. A message for such a surface that no longer has an owning window is discarded: the sidecar sent it after the host removed the surface and sent `closed`, before its answer to `closed`.

A sidecar answers every `closed` it receives. A surface that sends again after its close and is closed again before the answer has one pending close per `closed` sent, and each answer settles one of them. From sending `closed` until the answer, the host lists the surface in the application status `host.sidecars` as `{closing: [{sidecar, surface}]}`, sorted by sidecar and surface, and notifies the connections that watch it when the list changes. An answer with `error` is written to the host log as `sidecar <name>: close <surface>: <error>`; the surface has no owning window that could receive it. When a sidecar process ends or a persistent connection is lost, the host removes that sidecar's surfaces from the list, because their sessions ended with the process or the service completes the recorded close on its own. When the host stops its sidecars, it removes the surfaces of the standard input and output sidecars from the list, because those processes end. Such a sidecar still answers those closes on its way out; the host accepts each answer, writes an answer with `error` to its log as above, and does not treat it as a failure. A persistent service answers the closes that the host sent before the stop ahead of its close-owner reply, so the host keeps those surfaces until each answer arrives or the connection ends, and such an answer is not a failure. A message for a surface that the host never sent to that process is a [failure](#failure). The persistent transport keeps sessions across application processes, so a service may send for a surface that this application process has not sent to yet; it discards a message for a surface without an owning window.

The operation selector in a sidecar request body is an existing transport detail. A plugin manifest does not copy that wire spelling: it declares the readable `background.operation` name, and the workbench sends the corresponding sidecar request at one transport boundary. Missing operations and sidecar errors are failures; they are not replaced or discarded.

## Failure

A sidecar that uses standard input and output fails when:

- it sends a line longer than the message limit;
- it sends a line that is not a JSON object with a string `surface` and either a `body` or `closed` true;
- it answers `closed` for a surface that the host is not closing and whose close a stop did not remove from the list;
- it sends a message for a surface that the host never sent to that process;
- reading its standard output fails;
- its standard output ends, including when the process exits, while the host is not stopping its sidecars.

The protocol state after a failure is undefined, so the host reads no further messages from that process. The host removes the process from its running sidecars, sends it the force-kill signal, and waits for it to end. It then writes the failure to its log and delivers the `sidecar-failure` event `{sidecar, surface, reason}` to the owning window of each surface that sent a request to that process and still has an owner. `reason` is text that names the cause: `message exceeds 67108864 bytes`, `invalid message: <parser error>`, `unknown surface <surface>`, `unexpected close answer for <surface>`, `read: <error>`, or `output closed: <exit>`, where `<exit>` has the form of the stop rules in [declaration and startup](#declaration-and-startup). A request that the failed process did not answer gets no reply; the page observes the failure instead.

A send after a failure follows the start rule: the next request to that sidecar starts a new process. The new process has none of the sessions of the failed process, so a page that keeps a session opens it again. Each surface keeps its owning window and its first root.

While the host stops its sidecars, the end of output is not a failure. Any other failure during a stop is written to the host log as `sidecar <name>: failed: <reason>`, and the host sends no failure event, because a send after the stop fails and a page cannot open its session again; the stop rules in [declaration and startup](#declaration-and-startup) then end the process. When the host stops reading a sidecar's output after a failure, during a stop or not, it closes its end of the pipe, so the sidecar's later writes fail instead of blocking. These failure rules apply to the standard input and output transport; the persistent transport reports connection loss as [terminal runtime](terminal-runtime.md) defines.

## Log

A sidecar writes a line of its standard error as a text record `<time> <level> <layer> <where>: <text>` ([diagnostics](diagnostics.md#forms)) with the layer `sidecar` and its own name as `<where>`. A sidecar that the host starts with standard input and output may write any text: the host reads each line of its standard error and writes it as a record of level `info`. A persistent service opens no pipe to the host, so it writes the form itself, and its file `logs/<executable-name>.log` holds only records of that form.

## Page interface

`page.sidecar(name)` takes a sidecar and returns `send(surface, body)`, `on(surface, fn)`, and `onFailure(surface, fn)`. `on` calls `fn(body)` for each `sidecar-message` event of that sidecar and surface, and `onFailure` calls `fn(reason)` for each `sidecar-failure` event of that sidecar and surface. Both return a promise that resolves after the subscription is registered; a page subscribes before its first request. Sends of one sidecar reach the host in call order, and a send that fails rejects its caller, does not stop the sends after it, and is written to the application log as `error page sidecar <name>: send failed: <reason>`, by `page.report({level, where, text})` for a document of a surface and by the host call `report` for the main page, the call by which a document of a surface writes a record of the page layer (the host call `report` of the main page does the same).

In the application document, the workbench installs one `sidecar-failure` listener before it sends the first sidecar request. It calls the failure handlers that surface modules, state modules, and background sessions registered through the workbench for that sidecar and surface. When no handler is registered, the workbench reports the failure as a page error: it dispatches an `error` event to the window, which writes the failure to the application log and shows it in the application error alert.

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
| Format or token kind not supported, or nonce invalid | `{"image": {"error": "unsupported", "name": "...", "sequence": ...}}` | Format must be `bgra8` and token kind must be `iosurface-global`; nonce must be exactly 16 bytes when base64-decoded |
| IOSurface not found or access denied | `{"image": {"error": "notFound", "name": "...", "sequence": ...}}` | IOSurface lookup failed or permission denied |
| Declared size does not match the IOSurface's actual size | `{"image": {"error": "size", "name": "...", "sequence": ...}}` | Width and height in the envelope must match the actual IOSurface dimensions in pixels |
| Image scale differs from the window's backing scale factor | `{"image": {"error": "scale", "name": "...", "sequence": ...}}` | The image must be drawn at the window's current backing scale factor |
| Generation, raster revision, sequence, or expected dimensions are stale | `{"image": {"error": "stale", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | The frame cannot replace the current raster |
| Success | `{"image": {"consumed": {"name": "...", "generation": ..., "raster": ..., "sequence": ...}}}` | The host copied the transfer pixels into immutable host-owned presentation storage |

The nonce is a 16-byte value attached to the IOSurface that the host uses to verify the surface's identity when looking it up by global identifier. The generation identifies one page attachment, the raster revision identifies one exact native size and scale, and sequence numbers increase within that pair. The host includes all three in the response.

The host sends the authorized supplier a `configure` body containing the region name, generation, raster revision, exact pixel dimensions, and scale. The supplier must not derive these values from page geometry. It must not modify or reuse a sent transfer surface until `consumed` or an error arrives. The host never binds that mutable transfer surface directly to the presentation layer; the copy completed before `consumed` is the reuse boundary.

## shell

`@soksak/sidecar-shell` (repository `../sidecars/shell`) builds `build/soksak-shell` with `make build` and runs one shell session per surface. `open` may carry `directory`, an absolute path of an existing directory, in which the session starts; another value is an explicit error. Without it the session starts in the surface's project directory (`root`). The shell page sends its surface's `origin.directory` when it is not `null` and reports each directory event with `tab.directory` ([tab reports](plugins.md#tab-reports)), so a shell split from a shell starts where that shell was. It is a line console, not a terminal emulator. Its code is in `src/`: the entry point `src/main.go`, the protocol in the package `src/shell`, and the OS operations in `src/platform/{darwin,linux,windows}/`, which register through `src/platform/platform.go` ([platform selection](hosts.md#platform-selection)). Its tests are in `tests/`.

The session shell is `$SHELL` when it is a POSIX shell (`sh`, `bash`, `zsh`, `ksh`, `dash`) and `/bin/sh` otherwise, because the session script uses POSIX syntax. It runs in its own process group without a terminal and executes a script that:

- ignores the interrupt signal in the shell itself with `trap : INT`; commands started by the shell keep the default action;
- reads commands one line at a time from a separate command pipe (file descriptor 3) and runs each with `eval`, so a construct that spans lines must be written on one line;
- prints the current directory as a line that starts with the record separator (`\x1e`) and `cwd `, once at start and after each command.

The command's standard input is a second pipe. Standard output and standard error of the session share one pipe, so their lines keep their order.

A `write` goes to the command pipe while the shell has no child process, and to the running command's standard input while it has one; the sidecar counts the children of the shell process (`proc_listchildpids` on macOS, `/proc` on Linux). A line written before a command starts therefore becomes the next command, and a line written while it runs is that command's input.

| Body | Effect |
| --- | --- |
| `{"operation": "open"}` | Starts the surface's session; an open request for a running session does nothing |
| `{"operation": "write", "data": text}` | Writes `text` to the command pipe or to the running command, as described above |
| `{"operation": "run", "id": request, "command": text}` | Runs `text` once with `-c` in the last reported directory, in its own process group, and replies when it ends. The session's variables and directory do not change |
| `{"operation": "interrupt"}` | Sends the interrupt signal to the session's process group and to every running `run` command |

The sidecar sends these event bodies:

| Event body | Meaning |
| --- | --- |
| `{"text": line}` | One output line including its newline |
| `{"cwd": path}` | The session's current directory; the report line is not sent as text |
| `{"id": request, "output": text, "exit": code}` | The merged output and exit status of a `run` |
| `{"id": request, "error": message}` | A `run` that could not start or that lacks an id or a command |
| `{"error": message}` | Another failed request |

A closed surface ends its session and its `run` commands by terminating their process groups. A group whose processes have all ended or are exiting, which macOS answers with `EPERM` (closing the session's standard input ends the shell), is already terminated; any other failure is an error that names the remaining processes. When standard input closes, the sidecar ends every session and exits. On Windows every operation fails with `shell sessions are not implemented on windows`.

Public symbols in sidecars and their helpers that are diagnostic-only start with `sp_diag_`. The release build check uses this marker to reject binaries that contain diagnostic code. When a sidecar includes diagnostic symbols in a release build, the release check fails with an error message pointing to the symbol name.

## files

`@soksak/sidecar-files` (repository `../sidecars/files`) builds `build/soksak-files` with `make build` and lists and watches directories inside the session's `root`. Its code is in `src/`: the entry point `src/main.go`, the protocol in the package `src/files`, and directory watching in `src/platform/{darwin,linux,windows}/`, registered through `src/platform/platform.go`. macOS watches a directory or a regular file with a kqueue `EVFILT_VNODE` filter on it; Linux watches a directory with inotify and fails a regular file with `watching files is not implemented on linux`; Windows fails with `watching directories is not implemented on windows`. A session keeps only its watched paths. The sidecar reads request lines of up to 67108864 bytes, the limit of a sidecar output line, and writes replies without HTML escaping; an 8 MiB text escaped by JSON at most six times and the base64 of 32 MiB of bytes stay within that limit.

| Request body | Reply body |
| --- | --- |
| `{operation: "list", id, path}` | `{id, entries: [{name, directory}]}`: the entries of `root/path`, directories first, each group sorted by name; `path` is relative to `root`, `""` names `root` itself |
| `{operation: "watch", id, paths}` | `{id}`: replaces the session's watched paths with `paths` (relative to `root`, checked like `list`); an empty list stops watching. Afterwards the sidecar sends `{changed: path}` without `id` when an entry of a watched directory is created, removed, or renamed, and when the content of a watched regular file is written or extended (kqueue `NOTE_WRITE` or `NOTE_EXTEND` on the file) |
| `{operation: "git", id}` | `{id, entries: [{path, status}]}`: runs `git status --porcelain=v1 -z --untracked-files=all` in `root` and maps each entry to `added`, `deleted`, `modified`, `renamed`, or `untracked` with the path relative to the repository top level made relative to `root`; entries outside `root` are left out. When `root` is not inside a git repository, or git is not installed, `entries` is empty; another git failure is an error |
| `{operation: "read", id, path}` | `{id, text, version, newline, bom}`: the content of the regular file `root/path` as text; `version` is the lowercase hexadecimal SHA-256 of the file's bytes, `newline` is `lf`, `crlf`, `cr`, `mixed` or `none` (no line break), and `bom` is `true` when the file starts with the UTF-8 byte order mark, which `text` does not contain. A file that is not valid UTF-8 fails with `not UTF-8 text: <path>`, a file above 8388608 bytes fails with `file is <n> bytes, above the 8388608-byte limit: <path>` before its content is read, and a path that is not a regular file fails with `not a regular file: <path>` |
| `{operation: "write", id, path, text, expect, bom}` | `{id, version}`: writes `text`, after the UTF-8 byte order mark when `bom` is `true`, to `root/path` in place and returns the SHA-256 of the written bytes. With `expect` a version, the sidecar opens the existing regular file for writing without truncation, reads it through the same descriptor, and fails with `changed on disk: <path>` without writing when its SHA-256 differs from `expect`; otherwise it writes the whole content from the start, truncates the file to that length, and synchronizes it to disk. Writing in place keeps the file's inode, mode, extended attributes, access control list, hard links, and the target of a symbolic link. A failure after the first written byte fails with `write incomplete: <path>: <error>`, and the file may then hold part of the content. With `expect` `null`, the sidecar creates a new file with mode 0666 masked by the process umask and fails with `exists: <path>` when the path exists. A `text` above 8388608 bytes fails like a large `read` |
| `{operation: "readBytes", id, path}` | `{id, data, version}`: the bytes of the regular file `root/path` as standard base64 with padding in `data`, and their SHA-256 as `version`. A file above 33554432 bytes fails with `file is <n> bytes, above the 33554432-byte limit: <path>` before its content is read, and a path that is not a regular file fails with `not a regular file: <path>` |
| `{operation: "writeBytes", id, path, data, expect}` | `{id, version}`: writes the bytes that `data` holds as standard base64 with padding to `root/path` with the in-place, `expect` and creation rules of `write`, and returns their SHA-256. `data` that is not standard base64 fails with `writeBytes data is not base64`, and decoded bytes above 33554432 fail like a large `readBytes` |
| `closed` | stops the session's watches; no reply |
| any failure | `{id, error}`: a missing `root`, a `path` that is absolute or leaves `root` (after resolving symbolic links), or a directory that cannot be read |

## Terminal sidecar (vt-core)

The terminal sidecar (`@soksak/sidecar-vt-core`) is the client module for the persistent terminal service defined by [terminal runtime](terminal-runtime.md). The service is one process per application configuration directory and owns the independent PTYs, shell processes, VT state, scrollback, and IOSurface-backed rendering. The sidecar accepts requests to control a terminal session and supplies screen images to a region.

| Request | Body | Meaning |
| --- | --- | --- |
| `open` | `{image?: name}` | Create or attach to a terminal session in the persistent service and wait for the host's image `configure` before allocating and drawing the image region. Multiple `open` calls for the same creation identifier do nothing. |
| `input` | `{bytes?: base64-string \| keys?: [{key: name, text?: string, shift: bool, alt: bool, ctrl: bool}]}` | Send input to the terminal. Bytes are base64-encoded raw terminal input. Keys are decoded to terminal sequences based on the mode: function keys map to escape sequences, text input is sent as UTF-8, and modifier combinations are handled accordingly. Both `bytes` and `keys` can be present in one request. |
| `theme` | `{mode: "dark" \| "light", background, foreground, cursor, selection}` | Apply the effective application appearance to the attached image surface. The four colors are `#rrggbb` strings and are all required; they set the default background and foreground, the cursor color, and the selection background. `mode` selects the indexed ANSI palette. The session and cell metrics do not change. Another mode, a missing color, or a color in another form returns `invalidParams` and changes nothing. The answer is `{ack: true, event: "theme", mode, background}` with the applied background. |
| `cursor` | `{shape, blink, interval, idleTimeout, unfocused}` | Apply the terminal cursor policy. `shape` is `block`, `underline`, or `beam`; `blink` is `Never`, `Off`, `On`, or `Always`; `interval` is a positive integer in milliseconds; `idleTimeout` is a nonnegative integer in milliseconds; and `unfocused` is `hollow`, `solid`, `underline`, `beam`, or `unchanged`. Invalid values return `invalidParams` and are not replaced. |
| `font` | `{family: string, size: number}` | Select the terminal font and its size in points (4 to 128; the [text size](text-size.md) sets 13 × the effective factor) from a `;`-separated list of families in priority order. The service applies the first installed family; a family that is not installed is skipped and logged, not reported as an error. When no listed family is installed, the service uses the system fixed-pitch font and logs that. A list without any family is rejected with `{error: "invalidParams", reason, operation: "font"}`. Selecting a font recalculates cell metrics, terminal columns and rows, the session size, and the presented raster, and answers `{ack: true, event: "font", family, system, skipped, size}` with the applied family, whether it is the system fixed-pitch font, the skipped families, and the size. A missing or out-of-range size is rejected like an empty family list. Before the first `font` request the service uses the system fixed-pitch font at 13 points. The application bundles no font; the terminal page reports the applied family as `font` and `fontSystem` in `terminal.session`. |
| `screen.read` | `{}` | Request the current screen state. The sidecar responds with `{event: "screen", cols, rows, cursor: {col, row, shape, visible, blinking, blinkVisible, focused}, lines: [[cell, ...]]}`, where each cell has `{ch?: string, width: number, fg?: color, bg?: color, bold: bool, italic: bool, underline: bool, inverse: bool}`. <!-- cell size: pending code --> |
| `close` | `{}` | Close the terminal session and shut down the PTY. A host `{closed: true}` envelope uses the same close operation, so removing a surface cannot leave its PTY session alive. The service kills the session's process group; a group whose processes have all ended or are exiting, which macOS answers with `EPERM` (a shell that leaves unread output exits only after the terminal output drains), is already closed, and any other failure is an error that names the group and its remaining processes. |

The sidecar sends `{event: "screen", ...}` whenever the terminal screen changes, and sends image envelopes through the host's image relay when a new frame is drawn. Host `configure` replaces the page-driven `resize` request and is coalesced to its latest raster revision. While a transfer image awaits `consumed` or an error, the sidecar does not modify it. Screen and configuration changes remain pending, and the next frame uses the latest configuration after the response.

## Tests

Each sidecar runs its tests in its own directory. `shell` tests its protocol, output order, directory reports, command input, `run` results, and interrupts with `go test ./...` and validates its `sidecar.json` with `node --test tests/`. `files` tests listing, ordering, watching, git status, and the rejection of paths outside `root` with `go test ./...` and validates its `sidecar.json` the same way. Each host tests its relay, the message limit, and failure delivery in `tests/sidecars_test.*` and its resolution from staged manifests with a fake sidecar executable and does not start a real sidecar.
