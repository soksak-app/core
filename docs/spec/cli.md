# Command line `sok`

[한국어](cli.ko.md)

`sok` is the command line of a soksak application, and every command is public through it. Two packages implement it with one contract: `packages/sok/tauriv2` in Rust for the Tauri application and `packages/sok/wailsv3` in Go for the Wails application ([hosts](hosts.md#command-line-tree)). They do not link the application frameworks. Each application bundle holds its `sok` next to its executable (`Contents/MacOS/sok` on macOS), and the host runs that `sok` for the plugin commands of the settings window, so each language has one installation implementation. A `sok` uses the configuration directory of the application it belongs to (`com.soksak.tauri` or `com.soksak.wails`, see [projects](projects.md)) unless `--config-dir` names another, so the `sok` that `PATH` reaches decides the implementation and the configuration directory. `PATH` reaches a bundle through a path entry, `/etc/paths.d/<application identifier>`, that holds the bundle's executable directory. `sok path install` writes that entry for the `sok` that runs it and `sok path remove` deletes it; both need administrator rights (`sudo`), give the same result when repeated, and report a failed write with the file and the reason. A new shell reads the entry. The command line does not use symbolic links.

## Commands

| Command | Action |
| --- | --- |
| `sok <command> [window] [--surface <id>] [--<parameter> <value>]... [--params <json>]` | Runs a command that core or a plugin declares in the running application, through the [endpoint](endpoint.md) method `command.run` |
| `sok commands [window]` | Prints the `commands` list of `exposure.list`: each declared command with its description, parameter and result schemas |
| `sok windows` | Lists the windows of the running application |
| `sok exposures [window]` | Lists every declared status, command and DOM entry |
| `sok status <name> [window] [--surface <id>] [--watch]` | Prints a status value; `--watch` prints the value and then each change, one JSON line each |
| `sok dom rect\|click\|input\|dispatch <name> [window] [--surface <id>] [--index <n>] [--value <text>] [--event <json>]` | Acts on a declared DOM entry |
| `sok input pointer [window] --x <x> --y <y> --phase move\|down\|drag\|up\|scroll [--button left\|right] [--delta-x <n>] [--delta-y <n>] [--activate]` | Sends native pointer input |
| `sok input key [window] --key <key> --phase down\|up [--text <text>] [--modifiers shift,control,option,command]` | Sends native key input |
| `sok capture [window]` | Diagnostic builds: writes a still image of the window without focusing it |
| `sok path install\|remove` | Writes or deletes the path entry of this application; `install` prints the file and the directory it holds |
| `sok plugin install\|update\|remove\|enable\|disable <id>` | Changes the installed plugins ([installation](installation.md)) |
| `sok plugin list` | Lists the installed plugins |
| `sok registry use <index>` | Sets the registry index that installation reads |
| `sok plugin pack <directory> <output directory> [--diagnostics]` | Writes a plugin package archive; `--diagnostics` adds the plugin's diagnostic declarations |
| `sok sidecar release <directory> <output directory> [--platform <platform>]` | Writes a sidecar release archive and updates `SHA256SUMS` |
| `sok registry build <directory>` | Validates a registry and writes its `index.json` |

A declared command name contains a dot (`core.card.split`, `terminal.input`), so it never collides with the command words above.

## Windows

`[window]` is `--window <name>` or `--project <directory>`. `--project` selects the window whose open project folder is the directory after both are resolved to canonical paths. Without either, the command uses the only window; with several windows it fails and lists them.

## Parameters

The flags of a declared command come from the parameter schema that `exposure.list` reports for the selected window; a command that a surface registers also needs `--surface`. A string parameter takes the text, a number parameter a finite number, an integer parameter a whole number, an enum parameter one of its values, and a boolean parameter `--<name>` for true or `--<name>=false`. An object or array parameter takes JSON text. A parameter whose type is a list accepts any of the listed types; the text `null` gives null when the list includes `null`. A flag takes its value after `=` or as the next argument, so a value that starts with `--` is given after `=`. `--params <json>` gives the whole parameter object and cannot be combined with parameter flags. A flag that the schema does not declare, or a value that does not match it, fails before the command is sent.

## Output and exit status

A command writes its result as JSON on standard output; a command without a result writes `null`. An error is written to standard error as `sok: <message>`, with the endpoint error code in parentheses when there is one. A failed file operation names the file and the operating system reason in lower case, `<path>: <reason>`, with the same text in both implementations. The exit status is 0 on success, 1 on a failed command, and 2 on a usage error, which also prints the usage; it is 3 when sok cannot write its error to standard error. A cleanup that fails after a failed write or extraction is appended to the error as `; cleanup <path>: <reason>`, and a temporary file that cannot be closed as `; close <path>: <reason>`. A connection to the application that cannot be closed reports `endpoint connection: <reason>`.

## Packages, releases and the registry

These commands write files and do not need a running application.

`sok plugin pack <directory> <output directory>` reads `package.json` and `plugin.json` of a plugin directory, checks the [plugin package](installation.md#plugin-package) and that `soksak.sidecars` names exactly the `sidecars` of `plugin.json`, and writes `<id>-<version>.tgz`, where `<id>` is the `id` of `plugin.json`. It fails when the surface module, a section module or the state module of `plugin.json` is not inside a path that `files` lists, and when `files` lists `diagnostics.json` or the `module` that `diagnostics.json` names ([diagnostic declarations](plugins.md#diagnostic-declarations)). With `--diagnostics` and a `diagnostics.json` that names an existing JavaScript module inside the directory, the archive also holds `diagnostics.json` and that module; this diagnostic package is for diagnostic builds and window checks. It prints `{ id, version, archive, sha256 }` with the absolute archive path.

`sok sidecar release <directory> <output directory> [--platform <platform>]` reads `package.json` and `sidecar.json` of a sidecar directory, checks that `package.json` has a package `name`, a `version` and `files` that list `sidecar.json` and the `executable` of `sidecar.json`, and writes the [release asset](installation.md#sidecar-release-asset) `<file name>-<version>-<platform>.tar.gz`. The platform is the platform that `sok` runs on unless `--platform` names another; `sok` does not inspect the files, so another platform labels files that were built for it. It then writes `SHA256SUMS` in the output directory with one line `<sha256>  <archive name>` per archive, sorted by archive name, and replaces the line of an archive with the same name; it reads `SHA256SUMS` before writing the archive, so a malformed file fails the command without writing. It prints `{ name, version, platform, archive, sha256 }`.

Both archives are gzip-compressed tar files. They hold `package.json` and every path of `files`, a directory with the files under it, at their paths relative to the directory. Entries are sorted by path and have modification time 0, owner 0 and mode 0644, or 0755 for a file that has an executable bit. A listed path that does not exist, leaves the directory, or is or contains a symbolic link or a file that is neither regular nor a directory fails the command, which then writes nothing. The two implementations write the same entries, but their gzip streams differ, so the `sha256` of an archive is the value printed by the `sok` that wrote it.

`sok registry build <directory>` reads `plugins/<id>.json`, `sidecars/<file name>.json`, `packs/<name>.json` and `revoked.json` (`{ plugins, sidecars }`) of a registry directory. Each file holds one entry of the [registry index](installation.md#registry-index) and its name matches the entry. The command checks the entries as one index, reads every archive and compares its `sha256`, and checks that a plugin archive holds `plugin.json` with the plugin id and a `package.json` with the entry's package name, version, `engines.soksak` and sidecar ranges. Only when every check passes does it write `index.json` with each list sorted by id or name, two-space indentation and the field order of the [registry index](installation.md#registry-index) table, so both implementations write the same bytes; it replaces the file in one step. A missing `plugins`, `sidecars` or `packs` folder holds no entries; a missing `revoked.json` fails the build. It prints `{ index, plugins, sidecars, packs }` with the path and the number of entries.

## Installing plugins

These commands change the files of the [installation layout](installation.md#installation-layout) in the configuration directory. A configuration directory has one installation, so two commands must not change it at the same time.

`sok registry use <index>` reads the registry index at a path or an absolute `file:` URL, checks it, and writes `plugins/registry.json` (`{ "format": 1, "index": "<file: URL>" }`). It prints `{ index }`. The registry of version 0.0.2 is a local folder whose path differs per computer, so the location is set here instead of in the application.

`sok plugin install <id>` reads the index that `plugins/registry.json` names and `plugins/installed.json` (none means nothing is installed), selects the versions for the core version of this `sok` and the platform it runs on ([version selection](installation.md#version-selection)), and then:

1. reads each selected archive that is not installed yet, compares its `sha256`, and extracts it into a temporary folder beside its install path that it renames into place;
2. writes `plugins/installed.json` in one step: the plugin with its package, version, `enabled: true`, the sidecar ranges of that version and, when it replaces another version, `previous`; the selected sidecar versions; and no sidecar that no plugin names;
3. deletes every plugin folder and version folder other than the version in use and `previous` of an installed plugin, and every sidecar folder and version folder that `installed.json` does not name.

A plugin already installed at the selected version is left unchanged. A failure in step 1 or 2 leaves `installed.json` unchanged and reports the step; a failure in step 3 reports the folder it could not delete. Extraction accepts only regular files and folders at relative paths without `..`, and keeps mode 0755 for a file with an executable bit and 0644 otherwise. The command prints `{ plugin, sidecars }`: the entry of the plugin in `installed.json` and the sidecar versions it uses.

`sok plugin update <id>` installs the selected version of an installed plugin and fails for a plugin that is not installed. `sok plugin remove <id>` deletes the plugin from `installed.json` and then deletes `plugins/<id>` and the sidecar version folders that `installed.json` no longer names. `sok plugin enable <id>` and `sok plugin disable <id>` set `enabled`. These three print the plugin entry, or `null` after removal. `sok plugin list` prints `installed.json`.

## Installation and a running application

The plugin and sidecar commands change the files of the configuration directory directly and do not need a running application. A running application does not observe the change: pages that load after it read the new plugin list, and the change takes effect when the application restarts ([plugin operations in the application](installation.md#plugin-operations-in-the-application)).
