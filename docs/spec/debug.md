# Debug view

[한국어](debug.ko.md)

The debug view lets a person who meets a defect hand over every diagnostic record of the application. Every diagnostic file of an application is in `<config-dir>/logs/` ([hosts](hosts.md#application-log)); the debug view records the current state into that folder, lists its files, and saves one file or all of them where the person chooses.

## Opening

The Help menu of both hosts has 디버그 (Debug) ([host contract](host-contract.md#application-menu)). It runs `core.debug.open` in the key window, or in the main window when no window is key. The view is a `dialog` [native modal](native-modals.md) that closes with its × button (`core.debug.close`).

Opening records the state, then lists the files:

1. The page collects the value of every status that its registry serves, core statuses and the statuses of every surface, by name and surface, and sends them with the host call `debugRecord({page})`. A status whose read fails is recorded with its error.
2. The host writes `logs/state-<time>.json` with `{time, host, versions, windows, page}`: `host` is `wailsv3` or `tauriv2`; `versions` holds the core version, the macOS version and the content of `plugins/installed.json`; `windows` holds, for each window, `windows.list` entry, `host.window`, `host.sidecars` and `host.screens`; `page` is the value the page sent. `<time>` is the UTC time `YYYYMMDDTHHMMSSZ`.
3. In a diagnostic build the host writes a still capture of each window to `logs/captures/`.
4. The host call answers `{path}`, the path of the state file relative to `<config-dir>`.

A failure of a step is shown in the view through the error display and the other steps still run.

## Files

The host call `debugFiles()` answers `[{path, size, modified}]` for every file under `<config-dir>/logs/`, sorted by `path`: `path` is relative to `<config-dir>`, `size` is in bytes and `modified` is the modification time in milliseconds since the epoch. The view lists each file with its size and time and a 저장 button, and has 모두 저장 above the list.

- `core.debug.save {path}` runs the host call `debugSave({path})`, which shows the macOS save panel with the file name and copies the file to the chosen place. It answers `{saved}`, the chosen path, or `{saved: null}` when the person cancels. A `path` outside `logs/` or of no file is refused with an error that names it.
- `core.debug.saveAll` runs the host call `debugSaveAll()`, which shows the save panel with the name `soksak-<host>-debug-<time>.tar.gz` and writes a gzip-compressed tar file of `<config-dir>/logs/`. It answers like `debugSave`.

## Status

`core.debug` reports `{open, recorded, files, operation, error}`: whether the view is open, the path of the state file that opening wrote or `null`, the listed files, the running or last operation `{action, path, state}` with `state` `running`, `done` or `failed`, and the error of the last failed operation or `null`.
