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

## Tests

Each sidecar runs its tests in its own directory. `shell` tests its protocol, output order, directory reports, command input, `run` results, and interrupts with `go test ./...` and validates its `sidecar.json` with `node --test tests/`. Each host tests its relay in `tests/sidecars_test.*` and its resolution from staged manifests with a fake sidecar executable and does not start a real sidecar.
