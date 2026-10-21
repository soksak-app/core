# Decoupling handoff

[한국어](decouple-handoff.ko.md)

This document holds the text that core removes because it describes the implementation of a plugin or a sidecar. The parent delivers each section to the repository that owns it; core removes the section when that repository holds it. Remove this document after every section is delivered.

## Sidecar implementation sections (F236-8)

The three sections below were in [sidecars](../spec/sidecars.md). Each one moves to the specification of its sidecar repository (`../sidecars/shell`, `../sidecars/files`, `../sidecars/vt`). The links point at the core specifications until the owning repository replaces them with its own paths.

### shell

`@soksak/sidecar-shell` (repository `../sidecars/shell`) builds `build/soksak-shell` with `make build` and runs one shell session per surface. `open` may carry `directory`, an absolute path of an existing directory, in which the session starts; another value is an explicit error. Without it the session starts in the surface's project directory (`root`). The shell page sends its surface's `origin.directory` when it is not `null` and reports each directory event with `tab.directory` ([tab reports](../spec/plugins.md#tab-reports)), so a shell split from a shell starts where that shell was. It is a line console, not a terminal emulator. Its code is in `src/`: the entry point `src/main.go`, the protocol in the package `src/shell`, and the OS operations in `src/platform/{darwin,linux,windows}/`, which register through `src/platform/platform.go` ([platform selection](../spec/hosts.md#platform-selection)). Its tests are in `tests/`.

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

### files

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

### Terminal sidecar (vt-core)

The terminal sidecar (`@soksak/sidecar-vt-core`) is the client module for the persistent terminal service defined by [terminal runtime](../spec/terminal-runtime.md). The service is one process per application configuration directory and owns the independent PTYs, shell processes, VT state, scrollback, and IOSurface-backed rendering. The sidecar accepts requests to control a terminal session and supplies screen images to a region.

| Request | Body | Meaning |
| --- | --- | --- |
| `open` | `{image?: name}` | Create or attach to a terminal session in the persistent service and wait for the host's image `configure` before allocating and drawing the image region. Multiple `open` calls for the same creation identifier do nothing. |
| `input` | `{bytes?: base64-string \| keys?: [{key: name, text?: string, shift: bool, alt: bool, ctrl: bool}]}` | Send input to the terminal. Bytes are base64-encoded raw terminal input. Keys are decoded to terminal sequences based on the mode: function keys map to escape sequences, text input is sent as UTF-8, and modifier combinations are handled accordingly. Both `bytes` and `keys` can be present in one request. |
| `theme` | `{mode: "dark" \| "light", background, foreground, cursor, selection}` | Apply the effective application appearance to the attached image surface. The four colors are `#rrggbb` strings and are all required; they set the default background and foreground, the cursor color, and the selection background. `mode` selects the indexed ANSI palette. The session and cell metrics do not change. Another mode, a missing color, or a color in another form returns `invalidParams` and changes nothing. The answer is `{ack: true, event: "theme", mode, background}` with the applied background. |
| `cursor` | `{shape, blink, interval, idleTimeout, unfocused}` | Apply the terminal cursor policy. `shape` is `block`, `underline`, or `beam`; `blink` is `Never`, `Off`, `On`, or `Always`; `interval` is a positive integer in milliseconds; `idleTimeout` is a nonnegative integer in milliseconds; and `unfocused` is `hollow`, `solid`, `underline`, `beam`, or `unchanged`. Invalid values return `invalidParams` and are not replaced. |
| `font` | `{family: string, size: number}` | Select the terminal font and its size in points (4 to 128; the [text size](../spec/text-size.md) sets 13 × the effective factor) from a `;`-separated list of families in priority order. The service applies the first installed family; a family that is not installed is skipped and logged, not reported as an error. When no listed family is installed, the service uses the system fixed-pitch font and logs that. A list without any family is rejected with `{error: "invalidParams", reason, operation: "font"}`. Selecting a font recalculates cell metrics, terminal columns and rows, the session size, and the presented raster, and answers `{ack: true, event: "font", family, system, skipped, size}` with the applied family, whether it is the system fixed-pitch font, the skipped families, and the size. A missing or out-of-range size is rejected like an empty family list. Before the first `font` request the service uses the system fixed-pitch font at 13 points. The application bundles no font; the terminal page reports the applied family as `font` and `fontSystem` in `terminal.session`. |
| `screen.read` | `{}` | Request the current screen state. The sidecar responds with the `screen` message defined in [terminal runtime](../spec/terminal-runtime.md#screen-message). |
| `close` | `{}` | Close the terminal session and shut down the PTY. A host `{closed: true}` envelope uses the same close operation, so removing a surface cannot leave its PTY session alive. The service kills the session's process group; a group whose processes have all ended or are exiting, which macOS answers with `EPERM` (a shell that leaves unread output exits only after the terminal output drains), is already closed, and any other failure is an error that names the group and its remaining processes. |

The sidecar sends `{event: "screen", ...}` whenever the terminal screen changes; its `frame` is `{generation, raster, sequence}` of the frame that shows that screen (the next frame while changes wait for the answer of a sent one), or null while the surface has no image, and sends image envelopes through the host's image relay when a new frame is drawn. Host `configure` replaces the page-driven `resize` request and is coalesced to its latest raster revision. While a transfer image awaits `consumed` or an error, the sidecar does not modify it. Screen and configuration changes remain pending, and the next frame uses the latest configuration after the response.

## Terminal plugin acceptance criteria (F236-12)

The terminal plugin repository holds these two criteria of image regions in its own specification and checks them in its window checks. Core keeps the generic criteria of [surface composition](../spec/surface-composition.md#acceptance).

- A terminal image preserves its logical text while resizing: narrowing reduces terminal columns and reflows long logical rows onto multiple screen rows; widening increases columns and reflows those rows back without truncation or permanent narrow wrapping.
- Terminal cell width and height are stable presentation metrics during layout; divider movement changes the surface and raster geometry, not the font or cell metrics, and native geometry changes do not animate.
