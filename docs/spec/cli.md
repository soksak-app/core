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
| `sok plugin pack <directory> <output directory>` | Writes a plugin package archive |
| `sok sidecar release <directory> <output directory> [--platform <platform>]` | Writes a sidecar release archive and updates `SHA256SUMS` |
| `sok registry build <directory>` | Validates a registry and writes its `index.json` |

A declared command name contains a dot (`core.card.split`, `terminal.input`), so it never collides with the command words above.

## Windows

`[window]` is `--window <name>` or `--project <directory>`. `--project` selects the window whose open project folder is the directory after both are resolved to canonical paths. Without either, the command uses the only window; with several windows it fails and lists them.

## Parameters

The flags of a declared command come from the parameter schema that `exposure.list` reports for the selected window; a command that a surface registers also needs `--surface`. A string parameter takes the text, a number parameter a finite number, an integer parameter a whole number, an enum parameter one of its values, and a boolean parameter `--<name>` for true or `--<name>=false`. An object or array parameter takes JSON text. A parameter whose type is a list accepts any of the listed types; the text `null` gives null when the list includes `null`. A flag takes its value after `=` or as the next argument, so a value that starts with `--` is given after `=`. `--params <json>` gives the whole parameter object and cannot be combined with parameter flags. A flag that the schema does not declare, or a value that does not match it, fails before the command is sent.

## Output and exit status

A command writes its result as JSON on standard output; a command without a result writes `null`. An error is written to standard error as `sok: <message>`, with the endpoint error code in parentheses when there is one. The exit status is 0 on success, 1 on a failed command, and 2 on a usage error, which also prints the usage.

## Installation and a running application

The plugin and sidecar commands change the files of the configuration directory directly and do not need a running application. The running application observes `plugins/installed.json` and loads the change.
