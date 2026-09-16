# Sidecars

[한국어](sidecars.ko.md)

A sidecar is a native process that holds functionality for one domain, such as shell sessions. Plugins use it through the native host; the host relays messages and does not interpret their bodies. One sidecar implementation serves both Wails and Tauri.

## Declaration and startup

A plugin lists the sidecars its page uses in `plugin.json`, and a native application lists the sidecars it runs in `environment.json` ([plugins](plugins.md)). The host reads `environment.json` from its embedded frontend. It starts a declared sidecar when a page first sends to it, using the executable `soksak-<name>` in the directory of the application executable. The Makefile builds each sidecar and copies it there. A request for an undeclared sidecar, or after the host stops its sidecars, fails.

## Messages

Each message is one JSON object on one line.

| Direction | Message |
| --- | --- |
| Host → sidecar | `{"surface": id, "root": path, "body": value}` for a page request. `root` is the project directory of the window that owns the surface |
| Host → sidecar | `{"surface": id, "closed": true}` when the surface is removed or its window closes |
| Sidecar → host | `{"surface": id, "body": value}` |

The host records the window that first sends for a surface and delivers each sidecar message only to that window, as the `sidecar-message` event `{sidecar, surface, body}`. A request from another window for the same surface fails. When the application exits, the host closes each sidecar's standard input and waits for the process to end.

## Page interface

`page.sidecar(name)` returns `send(surface, body)` and `on(surface, fn)`. `on` returns a promise that resolves after the subscription is registered; a page subscribes before its first request.

## shell

`sidecars/shell` runs one shell process per surface in the surface's project directory. The shell is `$SHELL`, or `/bin/sh` when unset (`%COMSPEC%` or `cmd.exe` on Windows), and is not interactive.

| Body | Effect |
| --- | --- |
| `{"op": "open"}` | Starts the surface's shell; an open request for a running shell does nothing |
| `{"op": "write", "data": text}` | Writes `text` to the shell's standard input |

The sidecar sends each output line as `{"text": line}` including its newline, and each failed request as `{"error": message}`. A closed surface ends its shell. When standard input closes, the sidecar ends every shell and exits.

## Tests

Each sidecar tests its protocol in its own directory (`go test ./...` for `shell`). Each host tests its relay with a fake sidecar executable and does not start a real sidecar.
