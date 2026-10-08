# Debug view

[한국어](debug.ko.md)

The debug view lets a person who meets a defect hand over every diagnostic record of the application. Every diagnostic file of an application is in `<config-dir>/logs/` ([diagnostics](diagnostics.md)) ([hosts](hosts.md#application-log)); the debug view records the current state into that folder, lists its files, and saves one file or all of them where the person chooses.

## Opening

The Help menu of both hosts has 디버그 (Debug) ([host contract](host-contract.md#application-menu)). It runs `core.debug.open` in the main page of the application's main window, the same window as the text-size items of the View menu ([text size](text-size.md)). The view is a `dialog` [native modal](native-modals.md) that closes with its × button (`core.debug.close`); opening it closes the settings modal, and opening the settings modal closes it. A page without the application host has no debug view, and `core.debug.open` fails there with an error.

Opening records the state, then lists the files:

1. The page collects the value of every status that its registry serves, core statuses and the statuses of every surface, by name and surface, and sends them with the host call `debugRecord({page})`. A status whose read fails is recorded with its error.
2. The host writes `logs/state-<time>.json` with `{time, host, versions, windows, page}`: `host` is `wailsv3` or `tauriv2`; `versions` holds the core version, the macOS version and the content of `plugins/installed.json`; `windows` holds, for each window, `windows.list` entry, `host.window`, `host.sidecars` and `host.screens`; `page` is the value the page sent. `<time>` is the UTC time `YYYYMMDDTHHMMSSZ`.
3. In a diagnostic build the host writes a still capture of each window to `logs/captures/`.
4. The host call answers `{path}`, the path of the state file relative to `<config-dir>`.

A failure of a step is shown in the view through the error display and the other steps still run.

## Files

The host call `debugFiles()` answers `[{path, size, modified}]` for every file under `<config-dir>/logs/`, sorted by `path`: `path` is relative to `<config-dir>`, `size` is in bytes and `modified` is the modification time in milliseconds since the epoch. The view lists each file with its size and time and a 저장 button, and has 모두 저장 above the list.

- `core.debug.save {path}` runs the host call `debugSave({path})`, which shows the macOS save panel with the file name and copies the file to the chosen place. It answers `{saved}`, the chosen path, or `{saved: null}` when the person cancels. A `path` outside `logs/` or of no file is refused with an error that names it.
- `core.debug.save-all` runs the host call `debugSaveAll()`, which shows the save panel with the name `soksak-<host>-debug-<time>.tar.gz` and writes a gzip-compressed tar file of `<config-dir>/logs/`. It answers like `debugSave`.

## Viewing

Each file that is text has a 보기 button. `core.debug.view {path}` runs the host call `debugRead({path})`, which answers `{path, size, truncated, text}`: `text` is the content of the file, or its last 262144 bytes (starting at a character boundary) when the file is larger, and `truncated` is true in that case. A `path` outside `logs/`, of no file, or of a file whose content is not UTF-8 text is refused with an error that names it. The view then shows the text with the path and the size, says `앞부분 생략` when `truncated` is true, and has a 목록 button that runs `core.debug.list` and shows the list again. A capture is not text, so its row has 저장 and no 보기.

## Status

`core.debug` reports `{open, recorded, entries, viewing, operation, error}`: whether the view is open, the path of the state file that opening wrote or `null`, the listed entries `{path, size, modified}`, the shown file `{path, size, truncated, length}` (`length` is the number of characters of the shown text) or `null`, the running or last operation `{action, path, state}` with `action` `save` or `save-all`, `path` the saved file or `null`, and `state` `running`, `done` or `failed`, and the error of the last failed step or operation or `null`. `core.screen` reports `modal` `debug` while the view is open.
