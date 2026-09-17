# Sidecars

[한국어](sidecars.ko.md)

A sidecar is a native process that holds functionality for one domain, such as shell sessions. Plugins use it through the native host; the host relays messages and does not interpret their bodies. One sidecar implementation serves both Wails and Tauri.

## Declaration and startup

A sidecar is a package in `sidecars/<name>` with a `sidecar.json` file. The sidecar identity is its package name, for example `@soksak/sidecar-shell`. [`validateSidecar`](../../packages/plugin-api/index.js) checks the file:

| Field | Meaning |
| --- | --- |
| `executable` | Path of the built executable inside the package |
| `protocol` | Message format version. The current version is `1` |

A plugin lists the sidecar package names its page uses in `plugin.json` and declares each one as a dependency in its `package.json` ([plugins](plugins.md)). `soksak-stage --executables <dir>` copies each `sidecar.json` into the staged frontend and each built executable into `<dir>`.

The host reads only the staged frontend to resolve sidecars:

1. `environment.json` lists the plugin packages.
2. `modules/<plugin>/plugin.json` lists the sidecar packages of each plugin.
3. `modules/<sidecar>/sidecar.json` gives the `executable` path and `protocol` of each sidecar.

The host runs `<application executable directory>/<file name of executable>`. It fails at startup when a `sidecar.json` is missing, its `executable` is not a path inside the package, or its `protocol` is not `1`. It starts a sidecar when a page first sends to it. A request for a sidecar that no plugin declares fails with `sidecar <name> is not declared by any plugin`; a request after the host stops its sidecars also fails.

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

## shell

`sidecars/shell` (`@soksak/sidecar-shell`) builds `build/soksak-shell` with `pnpm run build` and runs one shell process per surface in the surface's project directory. The shell is `$SHELL`, or `/bin/sh` when unset (`%COMSPEC%` or `cmd.exe` on Windows), and is not interactive.

| Body | Effect |
| --- | --- |
| `{"op": "open"}` | Starts the surface's shell; an open request for a running shell does nothing |
| `{"op": "write", "data": text}` | Writes `text` to the shell's standard input |

The sidecar sends each output line as `{"text": line}` including its newline, and each failed request as `{"error": message}`. A closed surface ends its shell. When standard input closes, the sidecar ends every shell and exits.

## Tests

Each sidecar runs its tests in its own directory. `shell` tests its protocol with `go test ./...` and validates its `sidecar.json` with a Node test. Each host tests its relay and its resolution from staged manifests with a fake sidecar executable and does not start a real sidecar.
