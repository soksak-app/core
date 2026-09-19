# Sidecars

[한국어](sidecars.ko.md)

A sidecar is a native process that holds functionality for one domain, such as shell sessions. Plugins use it through the native host; the host relays messages and does not interpret their bodies. One sidecar implementation serves both Wails and Tauri.

## Declaration and startup

A sidecar is a package in `sidecars/<name>` with a `sidecar.json` file. The sidecar identity is its package name, for example `@soksak/sidecar-shell`. [`validateSidecar`](../../packages/plugin-api/index.js) checks the file:

| Field | Meaning |
| --- | --- |
| `executable` | Path of the built executable inside the package |
| `protocol` | Message format version. The current version is `1` |
| `helpers` | Optional array of helper packages. Each item has `package` (package name) and `executable` (path inside that package) |

A plugin lists the sidecar package names its page uses in `plugin.json` and declares each one as a dependency in its `package.json` ([plugins](plugins.md)). `soksak-stage --executables <dir>` copies each `sidecar.json` into the staged frontend and each built executable into `<dir>`.

The host reads only the staged frontend to resolve sidecars:

1. `environment.json` lists the plugin packages.
2. `modules/<plugin>/plugin.json` lists the sidecar packages of each plugin.
3. `modules/<sidecar>/sidecar.json` gives the `executable` path and `protocol` of each sidecar.

The host runs `<application executable directory>/<file name of executable>`. It fails at startup when a `sidecar.json` is missing, its `executable` is not a path inside the package, or its `protocol` is not `1`. It starts a sidecar when a page first sends to it. A request for a sidecar that no plugin declares fails with `sidecar <name> is not declared by any plugin`; a request after the host stops its sidecars also fails.

Child processes spawned by a sidecar do not inherit the host's pipes or process group. When the host closes the sidecar's standard input, the sidecar must end within 2 seconds; if it does not, the host waits up to 5 seconds total before sending a force-kill signal.

Only a package in `sidecars/` that has a `sidecar.json` is a sidecar the host runs. The others are libraries and helper executables that sidecars share.

## Messages

Each message is one JSON object on one line.

| Direction | Message |
| --- | --- |
| Host → sidecar | `{"surface": id, "root": path, "body": value}` for a page request. `root` is the project directory of the window that owns the surface |
| Host → sidecar | `{"surface": id, "closed": true}` when the surface is removed or its window closes |
| Sidecar → host | `{"surface": id, "body": value}` |

The host records the window that first sends for a surface and delivers each sidecar message only to that window, as the `sidecar-message` event `{sidecar, surface, body}`, where `sidecar` is the package name. A request from another window for the same surface fails. When the application exits, the host closes each sidecar's standard input and waits for the process to end.

## Page interface

`page.sidecar(name)` takes a sidecar package name and returns `send(surface, body)` and `on(surface, fn)`. `on` returns a promise that resolves after the subscription is registered; a page subscribes before its first request.

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

`sidecars/shell` (`@soksak/sidecar-shell`) builds `build/soksak-shell` with `pnpm run build` and runs one shell session per surface in the surface's project directory. It is a line console, not a terminal emulator. Its code is in `src/`: the entry point `src/main.go`, the protocol in the package `src/shell`, and the OS operations in `src/platform/{darwin,linux,windows}/`, which register through `src/platform/platform.go` ([platform selection](hosts.md#platform-selection)). Its tests are in `tests/`.

The session shell is `$SHELL` when it is a POSIX shell (`sh`, `bash`, `zsh`, `ksh`, `dash`) and `/bin/sh` otherwise, because the session script uses POSIX syntax. It runs in its own process group without a terminal and executes a script that:

- ignores the interrupt signal in the shell itself with `trap : INT`; commands started by the shell keep the default action;
- reads commands one line at a time from a separate command pipe (file descriptor 3) and runs each with `eval`, so a construct that spans lines must be written on one line;
- prints the current directory as a line that starts with the record separator (`\x1e`) and `cwd `, once at start and after each command.

The command's standard input is a second pipe. Standard output and standard error of the session share one pipe, so their lines keep their order.

A `write` goes to the command pipe while the shell has no child process, and to the running command's standard input while it has one; the sidecar counts the children of the shell process (`proc_listchildpids` on macOS, `/proc` on Linux). A line written before a command starts therefore becomes the next command, and a line written while it runs is that command's input.

| Body | Effect |
| --- | --- |
| `{"op": "open"}` | Starts the surface's session; an open request for a running session does nothing |
| `{"op": "write", "data": text}` | Writes `text` to the command pipe or to the running command, as described above |
| `{"op": "run", "id": request, "command": text}` | Runs `text` once with `-c` in the last reported directory, in its own process group, and replies when it ends. The session's variables and directory do not change |
| `{"op": "interrupt"}` | Sends the interrupt signal to the session's process group and to every running `run` command |

The sidecar sends these event bodies:

| Event body | Meaning |
| --- | --- |
| `{"text": line}` | One output line including its newline |
| `{"cwd": path}` | The session's current directory; the report line is not sent as text |
| `{"id": request, "output": text, "exit": code}` | The merged output and exit status of a `run` |
| `{"id": request, "error": message}` | A `run` that could not start or that lacks an id or a command |
| `{"error": message}` | Another failed request |

A closed surface ends its session and its `run` commands by terminating their process groups. When standard input closes, the sidecar ends every session and exits. On Windows every operation fails with `shell sessions are not implemented on windows`.

Public symbols in sidecars and their helpers that are diagnostic-only start with `sp_diag_`. The release build check uses this marker to reject binaries that contain diagnostic code. When a sidecar includes diagnostic symbols in a release build, the release check fails with an error message pointing to the symbol name.

## ptyd

`sidecars/ptyd` is a shared helper that manages PTY sessions for sidecars. It runs as a daemon and handles session creation, input/output routing, and session lifecycle. The daemon listens on a Unix socket and serves multiple clients concurrently.

**Session lifecycle**: When a consumer (typically from a host that owns a sidecar) attaches to a session, the daemon runs the session's child process. Sessions remain alive after a consumer detaches (`detach` operation), but terminate when all consumers disconnect and the session receives a close request (`close` operation). A session with no consumers and no clients (total of 0 active connections) starts an idle timeout; if no activity occurs within the timeout period, the daemon shuts itself down. In debug builds the idle timeout is 60 seconds; in release builds it is 5 minutes. The timeout can be overridden with the `PTYD_IDLE_TIMEOUT` environment variable, parsed as a Go duration (e.g., `"30s"`, `"2m"`).
The daemon belongs to the sidecar that started it. If that parent sidecar exits, the daemon closes its listener and PTY sessions and exits; it must not remain as an orphan adopted by the system process.

**Logging**: The daemon logs to stderr by default when the application is attached to a terminal. To redirect logs to a file, set `PTYD_LOG` to the file path. This is useful for debugging daemon lifecycle and request handling.

## Terminal sidecar (vt-core)

The terminal sidecar (`@soksak/sidecar-vt-core`) implements a terminal emulator that renders to an image region. It accepts requests to control the terminal and supplies screen images to a region. The sidecar is a Rust process that uses an Alacritty engine for terminal emulation and IOSurface-backed drawing.

| Request | Body | Meaning |
| --- | --- | --- |
| `open` | `{image?: name}` | Create a terminal session. The sidecar opens a PTY session through the ptyd daemon and waits for the host's image `configure` before allocating and drawing the image region. Multiple `open` calls for the same surface do nothing. |
| `input` | `{bytes?: base64-string \| keys?: [{key: name, text?: string, shift: bool, alt: bool, ctrl: bool}]}` | Send input to the terminal. Bytes are base64-encoded raw terminal input. Keys are decoded to terminal sequences based on the mode: function keys map to escape sequences, text input is sent as UTF-8, and modifier combinations are handled accordingly. Both `bytes` and `keys` can be present in one request. |
| `screen.read` | `{}` | Request the current screen state. The sidecar responds with `{event: "screen", cols, rows, cursor: {col, row}, lines: [[cell, ...]]}`, where each cell has `{ch?: string, width: number, fg?: color, bg?: color, bold: bool, italic: bool, underline: bool, inverse: bool}`. <!-- cell size: pending code --> |
| `close` | `{}` | Close the terminal session and shut down the PTY. The sidecar sends `{closed: true}` in response to a host `{closed: true}` envelope, which ends the session but keeps the daemon alive (detach behavior). |

The sidecar sends `{event: "screen", ...}` whenever the terminal screen changes, and sends image envelopes through the host's image relay when a new frame is drawn. Host `configure` replaces the page-driven `resize` request and is coalesced to its latest raster revision. While a transfer image awaits `consumed` or an error, the sidecar does not modify it. Screen and configuration changes remain pending, and the next frame uses the latest configuration after the response.

## Tests

Each sidecar runs its tests in its own directory. `shell` tests its protocol, output order, directory reports, command input, `run` results, and interrupts with `go test ./...` and validates its `sidecar.json` with `node --test tests/`. Each host tests its relay in `tests/sidecars_test.*` and its resolution from staged manifests with a fake sidecar executable and does not start a real sidecar.
