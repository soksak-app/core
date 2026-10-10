# Debug view

[한국어](debug.ko.md)

The debug view lets a person who meets a defect hand over every diagnostic record of the application. Every diagnostic file of an application is in `<config-dir>/logs/` ([diagnostics](diagnostics.md)) ([hosts](hosts.md#application-log)); the debug view records the current state into that folder, lists its files, and saves one file or all of them where the person chooses.

## Opening

The Help menu of both hosts has 디버그 (Debug) ([host contract](host-contract.md#application-menu)). It runs `core.debug.open` in the main page of the application's main window, the same window as the text-size items of the View menu ([text size](text-size.md)). The view is a `dialog` [native modal](native-modals.md) that closes with its × button (`core.debug.close`); opening it closes the settings modal, and opening the settings modal closes it. A page without the application host has no debug view, and `core.debug.open` fails there with an error.

Opening records the state, then lists the files:

1. The page collects the value of every status that its registry serves, core statuses and the statuses of every surface, by name and surface, and sends them with the host call `debugRecord({page})`. A status whose read fails is recorded with its error.
2. The host writes `logs/state-<time>.json` with `{time, host, versions, windows, page}`: `host` is `wailsv3` or `tauriv2`; `versions` holds the core version, the macOS version and the content of `plugins/installed.json`; `windows` holds, for each window, `windows.list` entry, `host.window`, `host.sidecars` and `host.screens`; `page` is the value the page sent. `<time>` is the UTC time `YYYYMMDDTHHMMSSZ`. After it writes a state file, the host removes the oldest `logs/state-<time>.json` files beyond the newest 20, so the folder keeps a bounded number of them.
   After it writes the file, the host removes the oldest `logs/state-<time>.json` files beyond the newest 20, so the folder holds a bounded number of them.
3. In a diagnostic build the host writes a still capture of each window to `logs/captures/`.
4. The host call answers `{path}`, the path of the state file relative to `<config-dir>`.

A failure of a step is shown in the view through the error display and the other steps still run.

## Files

The host call `debugFiles()` answers `[{path, size, modified}]` for every file under `<config-dir>/logs/`, sorted by `path`: `path` is relative to `<config-dir>`, `size` is in bytes and `modified` is the modification time in milliseconds since the epoch. The view lists each file with its size and time, newest first (by `modified`, then by `path`), and a 저장 button, and has 모두 저장 above the list.

- `core.debug.save {path}` runs the host call `debugSave({path})`, which shows the macOS save panel with the file name and copies the file to the chosen place. It answers `{saved}`, the chosen path, or `{saved: null}` when the person cancels. A `path` outside `logs/` or of no file is refused with an error that names it.
- `core.debug.save-all` runs the host call `debugSaveAll()`, which shows the save panel with the name `soksak-<host>-debug-<time>.tar.gz` and writes a gzip-compressed tar file of `<config-dir>/logs/`. It answers like `debugSave`.
- The host call `debugSaveText({name, text})` saves text that the page built (for example the selected rows of the timeline): the host refuses a `name` that is not a file name (empty, `.`, `..`, or holding `/` or `\`) and a `text` that is empty or over 16 MiB with an error that names what it found, shows the save panel with `name`, writes the text to the chosen place, and answers `{saved}` like `debugSave`.

## Viewing

Each file has a 보기 button and a 저장 button, in the same columns of every row. `core.debug.view {path}` runs the host call `debugRead({path})`, which answers `{path, size, truncated, kind, text}` for a text file or `{path, size, truncated, kind, image}` for a PNG file. `kind` is `text` or `image`. For a text file, `text` is the content of the file, or its last 262144 bytes (starting at a character boundary) when the file is larger, and `truncated` is true in that case. For a PNG file, `image` is the `data:image/png;base64,` address of the whole file and `truncated` is false. A `path` outside `logs/`, of no file, of a PNG file larger than 16 MB, of a file named `.png` that does not start with the PNG signature, or of another file whose content is not UTF-8 text is refused with an error that names it, and the view shows that error. The view shows the text or the image with the path and the size, says `앞부분 생략` when `truncated` is true, and has a 목록 button that runs `core.debug.list` and shows the list again. The text keeps the order in which it was written, the oldest line first, and the view opens scrolled to the end of the text, where the newest lines are.

## Timeline

The 타임라인 button above the list runs `core.debug.timeline`, which reads the event files of the host process (`logs/host-<boot>.jsonl`, [logging](logging.md#files); rotated generations `.1` to `.5` are not read) with `debugRead` and shows their events as one list of rows. It fails with an error when the folder has no such file.

- A file must follow the event structure of [logging](logging.md#event): every line is a JSON object with an integer `ts_us` and `seq`, a `level` and a `layer` the contract declares, a string `event`, and `fields` that is an object when present; the first line is `log.open` with the schema number that the reader knows. A file that breaks this is refused with an error that names the file, the line and what was found, and the view shows that error. When the text of a file is truncated (`truncated` is true), its first line is partial: the reader skips it, does not require `log.open`, and the view says `앞부분 생략`.
- The rows of all files are sorted by `ts_us`, then `seq`, then file path. Each row is one text line: the UTC time with microseconds, `level`, `layer`, `event`, `window=`, `surface=`, `session=` and `cids=` when present, and each field as `name=<JSON value>`.
- `core.debug.timeline.filter {level, layer, text}` sets the filter; a member that is not given keeps its value and at least one is required. `level` is the least severe level shown (`error`, `warn`, `info`, `debug` or `trace`; a row of that level or a more severe one passes), `layer` is `all` or a layer, and `text` is a case-insensitive part of the text line of a row. A new timeline starts with `trace`, `all` and no text. The view has a selection box for the level, one for the layer and a text field, each pointing to this command, and a 목록 button that runs `core.debug.list`.
- The view opens scrolled to the end, where the newest rows are, and keeps its scroll position when the filter changes.

## State

The list shows every file of `logs/`, including the raw `.stderr` and `.crash` files of the processes ([logging](logging.md#files)); `core.debug.view` shows their text like any other text file. A state file `logs/state-<time>.json` also has a 상태 button that runs `core.debug.state {path}`, which reads the file with `debugRead` and shows it as a tree. A `path` that is not a state file of the list is refused with an error that names it.

- A state file must be a JSON object with a string `time`, a `host` of `wailsv3` or `tauriv2`, objects `versions` and `page`, and an array `windows`. A file that breaks this, whose text is truncated at the read limit, or that is not text is refused with an error that names the file and what was found, and the view shows that error.
- The tree has one line for each key in file order, indented by depth: `key: <JSON value>` for a value, `key {n}` or `key [n]` for an object or an array with `n` members, and `key: {}` or `key: []` for an empty one.
- `core.debug.state.compare {with}` compares the shown state file with another state file of the list and lists above the tree each path whose value differs, as `path: <value in the shown file> -> <value in the other file>`. A path is the keys from the top, joined by `.`, with `[index]` for an array element and `["key"]` for a key that is not an identifier. A path that only one file has shows `(없음)` for the other. The differences are the paths of the shown file in file order, then the paths that only the other file has. An empty `with` ends the comparison; a `with` that is not another state file of the list is refused with an error that names it. The view has a selection box of the other state files, pointing to this command, and a 목록 button that runs `core.debug.list`.

## Status

`core.debug` reports `{open, recorded, entries, viewing, timeline, state, scroll, operation, error}`: whether the view is open, the path of the state file that opening wrote or `null`, the listed entries `{path, size, modified}` in the order of the list, the shown file `{path, size, truncated, kind, length}` (`length` is the number of characters of the shown text, 0 for an image) or `null`, the shown timeline `{sources, truncated, total, shown, level, layer, text}` (the read sources, the sources whose text was truncated, the number of rows and the number that pass the filter, and the filter) or `null`, the shown state file `{path, lines, with, differences}` (the number of tree lines, the state file it is compared with or `null`, and the number of differences) or `null`, the scroll position of the shown content in points (negative while the content is pulled past its start, as the native modal reports it; a value that is not a number is refused), the running or last operation `{action, path, state}` with `action` `save` or `save-all`, `path` the saved file or `null`, and `state` `running`, `done` or `failed`, and the error of the last failed step or operation or `null`. `core.screen` reports `modal` `debug` while the view is open.
