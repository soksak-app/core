# Command line `sok`

[한국어](cli.ko.md)

`sok` is the command line of a soksak application, and every command is public through it. Two packages implement it with one contract: `packages/sok/rust` in Rust for the Tauri application and `packages/sok/go` in Go for the Wails and the mygo application ([hosts](hosts.md#command-line-tree)). They do not link the application frameworks. Each application bundle holds its `sok` next to its executable (`Contents/MacOS/sok` on macOS), and the host runs that `sok` for the plugin commands of the settings window, so each language has one installation implementation. A `sok` uses the configuration directory of the application it belongs to (`app.soksak.tauri`, `app.soksak.wails` or `app.soksak.mygo`, with `.dev` in builds with the `dev` flag, see [projects](projects.md#persistence)) unless `--config-dir` names another, so the `sok` that `PATH` reaches decides the implementation and the configuration directory. `PATH` reaches a bundle through a path entry, `/etc/paths.d/<application identifier>`, that holds the bundle's executable directory. `sok path install` writes that entry for the `sok` that runs it and `sok path remove` deletes it; both need administrator rights (`sudo`), give the same result when repeated, and report a failed write with the file and the reason. A new shell reads the entry. The command line does not use symbolic links.

## Operating systems

`sok` runs on macOS and Linux. Its platform key is `<os>-<arch>` with `arm64` or `x64` ([installation](installation.md)). On Linux the configuration directory is the application identifier under `$XDG_CONFIG_HOME`, or under `~/.config` when that is not set, and the endpoint is a Unix socket as on macOS ([endpoint](endpoint.md)). Linux has no path entry folder, so `sok path install` and `sok path remove` fail there with `path entries are not implemented on linux`. Windows does not implement private event-log directories or files, or the process ownership lock file. These operations report `event log directory <path> is not implemented on windows`, `event log file <path> is not implemented on windows`, or `process lock file <path> is not implemented on windows` before creating the path. An event-log setup failure is reported on standard error and the command still runs without a record; a process-lock failure rejects the writing command.

The current Linux and Windows platform implementations report that process exit waiting is not implemented, and the Windows platform of the Rust CLI, which watches no interrupt signals, reports first that interrupt signals are not implemented, because the wait watches SIGINT and SIGTERM before it starts; `sok process wait` therefore fails explicitly on those systems. macOS uses the kernel process-exit notification.

## Commands

| Command | Action |
| --- | --- |
| `sok <command> [window] [--surface <id>] [--<parameter> <value>]... [--params <json>]` | Runs a command that core or a plugin declares in the running application, through the [endpoint](endpoint.md) method `command.run` |
| `sok commands [window] [--query <text>]` | Prints the `commands` list of `exposure.list`: each declared command with its description, parameter and result schemas; `--query` keeps the commands that the query matches ([discovery](#discovery)) |
| `sok windows` | Lists the windows of the running application |
| `sok exposures [window] [--kind status\|command\|element] [--query <text>]` | Lists every declared status, command and element entry; `--kind` keeps one list and `--query` keeps the entries that the query matches ([discovery](#discovery)) |
| `sok status <name> [window] [--surface <id>] [--watch]` | Prints a status value; `--watch` prints the value and then each change, one JSON line each. SIGINT or SIGTERM ends the watch: the routine that receives the signal closes the connection, stores the command with the result of the close and ends the process with status 0, or 1 with the error of the close, also while the command waits in a write to its standard output |
| `sok element rect\|click\|input\|dispatch <name> [window] [--surface <id>] [--index <n>] [--value <text>] [--event <json>]` | Acts on a declared element entry |
| `sok input pointer [window] --x <x> --y <y> --phase move\|down\|drag\|up\|scroll [--button left\|right] [--delta-x <n>] [--delta-y <n>] [--clicks <n>] [--activate]` | Sends native pointer input. A press belongs to the connection of its command, so the end of a command with `--phase down` releases the press at its point ([methods](exposure.md#methods)); a gesture over several points is `sok input gesture` |
| `sok input gesture [window] [--pointer <name>] [--button left\|right] [--clicks <n>] --points <x>,<y>[;<x>,<y>]...` | Sends one native gesture through one connection: `down` at the first point, a `drag` to each later point and `up` at the last point, so one point is a click. It prints nothing and ends after the delivered `up`; a step that fails ends the command with the error of that step and its number, and the end of the connection releases the press |
| `sok input text [window] --phase mark\|insert\|unmark [--text <text>] [--selection <start>,<length>] [--replacement <start>,<length>]` | Gives one step of a composition to the text input client of the key responder (`input.text`) |
| `sok input key [window] --key <key> --phase down\|up [--text <text>] [--modifiers shift,control,option,command]` | Sends native key input |
| `sok debug query [--channel <channel>] [--level <level>] [--class <class>] [--layer <layer>] [--event <name>] [--event-prefix <prefix>] [--surface <id>] [--session <id>] [--cid <id>] [--run <id>] [--text <text>] [--from <time>] [--to <time>] [--order asc\|desc] [--limit <n>] [--after <cursor>] [--around <cursor> [--earlier <n>] [--later <n>]]` | Prints one page of the events of the event files of the configuration directory that pass the filter, one text line each, through the indexes of the files, and names on the standard error each file of another schema number that it left out ([logging](logging.md#query), [debug](debug.md#timeline)); it does not need a running application |
| `sok debug replay <session> [--until <sequence>]` | Rebuilds the screen of a session from the stored inputs with the replay executable of its sidecar, compares every stored sidecar and page hash with the replayed one, and reports the first divergence as an `error` event naming the session, the sequence and the layer, with exit status 1 ([replay](replay.md#command)); it does not need a running application |
| `sok capture [window]` | Diagnostic builds: writes a still image of the window without focusing it |
| `sok app update --wait <pid> --bundle <path> --target <path> [-- <argument>...]` | Replaces the application bundle `<target>` with `<bundle>` after the process `<pid>` ended and starts it ([application update](installation.md#application-update)) |
| `sok app relaunch --wait <pid> --target <path> [-- <argument>...]` | Starts the application bundle `<target>` again with the arguments, without activating it, after the process `<pid>` ended ([diagnostic builds](endpoint.md#diagnostic-builds)) |
| `sok process wait <pid>` | Waits for the operating system to report that the process ID ended, without connecting to an application or service |
| `sok path install\|remove` | Writes or deletes the path entry of this application; `install` prints the file and the directory it holds |
| `sok skill print\|install` | Writes the agent skill to standard output, or into the skill folder of each agent folder that exists ([agent skill](#agent-skill)) |
| `sok mcp [window]` | Serves the endpoint of the application to an agent as an MCP server on standard input and output ([MCP server](#mcp-server)) |
| `sok mcp install` | Registers `sok mcp` with the `claude` command in its user scope ([MCP registration](#mcp-registration)) |
| `sok setup check` | Prints each setup part with its state and its install step, and changes nothing ([setup parts](#setup-parts)) |
| `sok setup install [path\|skill\|mcp]...` | Installs each missing setup part of the named kinds, of every kind without a name ([setup parts](#setup-parts)) |
| `sok setup environment` | Prints `{HOME, PATH, CLAUDE_CONFIG_DIR}` of its environment, for the host that reads the environment of the login shell ([agents in the application](#agents-in-the-application)) |
| `sok plugin install\|update\|remove\|enable\|disable <id>` | Changes the installed plugins ([installation](installation.md)) |
| `sok plugin list` | Lists the installed plugins |
| `sok registry use <index>` | Sets the registry index that installation reads |
| `sok registry build <directory>` | Validates a registry and writes its `index.json` |

A declared command name contains a dot (`core.card.split`, `terminal.input`), so it never collides with the command words above.

## Windows

`[window]` is `--window <name>` or `--project <directory>`. `--project` selects the window whose open project folder is the directory after both are resolved to canonical paths. Without either, the command uses the only window; with several windows it fails and lists them.

## Parameters

The flags of a declared command come from the parameter schema that `exposure.list` reports for the selected window; a command that a surface registers also needs `--surface`. A string parameter takes the text, a number parameter a finite number, an integer parameter a whole number, an enum parameter one of its values, and a boolean parameter `--<name>` for true or `--<name>=false`. An object or array parameter takes JSON text. A parameter whose type is a list accepts any of the listed types; the text `null` gives null when the list includes `null`. A flag takes its value after `=` or as the next argument, so a value that starts with `--` is given after `=`. `--params <json>` gives the whole parameter object and cannot be combined with parameter flags. A flag that the schema does not declare, or a value that does not match it, fails before the command is sent.

## Output and exit status

A command writes its result as JSON on standard output; a command without a result writes `null`. An error is written to standard error as `sok: <message>`, with the endpoint error code in parentheses when there is one. A failed file operation names the file and the operating system reason in lower case, `<path>: <reason>`, with the same text in both implementations. The exit status is 0 on success, 1 on a failed command, and 2 on a usage error, which also prints the usage; it is 3 when sok cannot write its error to standard error, and 4 when the command or one of its goroutines or threads panicked ([event log](#event-log)). A cleanup that fails after a failed write or extraction is appended to the error as `; cleanup <path>: <reason>`, and a temporary file that cannot be closed as `; close <path>: <reason>`. A connection to the application that cannot be closed reports `endpoint connection: <reason>`.

sok checks the arguments of a command before it connects to the application, so a usage error opens no endpoint connection and sends no request.

`process wait` requires a positive process ID no greater than 2147483647. The wait has no time limit: it prints `{"pid": <pid>, "ended": true}` when the operating system reports that the PID is absent or its exit event occurs, and a SIGINT or SIGTERM that `sok` receives ends it with exit 1, no standard output and `process <pid> wait was interrupted by <SIGINT or SIGTERM>`, so the caller ends a wait by a signal, as it ends `sok watch`. Platform errors, including an unsupported process wait, are reported as command failures. The command waits by process ID; it does not establish an identity guarantee across arbitrary PID reuse.

`process wait` takes no option besides `--help` and `--config-dir`, and an unknown option such as `--timeout-ms` exits 2 as for every command. The command uses the same option parser as the other CLI commands. As with other boolean flags, repeated `--help` is idempotent; repeated value options are rejected.

## Event log

Every run of `sok` writes its own event file, `logs/sok-<boot>.jsonl`, in the configuration directory that the command targets: the value of `--config-dir`, read before the command is parsed and only before an argument `--`, or the default directory of the application. A command that reads no configuration, such as `registry build`, records in the default directory. The file follows the [event contract](logging.md) with the layer `sok`, and its boot identifier is the start time in seconds and the process identifier. The tool creates `logs/` (mode 0700) and the file (mode 0600, created new) when they are absent. The file holds the levels `error`, `warn` and `info`; the events of the levels `debug` and `trace` (`sok.command` of a command that ends with status 0) are in `logs/sok-<boot>.debug.jsonl`, which the tool creates with its first such event and starts with `log.open`. A run stores:

- `log.open`, the first line;
- `sok.command` once, when the command ends: the command word (`name`), the arguments joined by spaces (`args`), the microseconds of the run, `ok`, the exit status (`status`) and, for a status other than 0, the first line of its standard error (`error`). `args` and `error` are cut to 1024 bytes on a character boundary and the event has `truncated: true` when either was cut. The level is `debug`, and `warn` for a status other than 0;
- `sok.replay.divergence` at the level `error` when `sok debug replay` finds a stored hash that differs from the replayed one: the session, the segment, the sequence, the layer, the expected and the found hash ([replay](replay.md#command));
- `sok.panic` for a panic, at the level `error`: the goroutine or thread that panicked (`main` for the command), the text of the panic and the stack at the panic. The tool writes `sok: panic: <text>` and the stack on the standard error, stores the event and `sok.command` with the status 4, flushes the file, and ends with the status 4. A panic of a goroutine or thread other than the command ends the process the same way.

Every goroutine of the Go tool starts through `Go` (`src/routine.go`) and every thread of the Rust tool through `spawn_named` (`src/routine.rs`), which are the only places of the tool that start one and recover a panic; the [event source check](logging.md#event-sources) requires it. The writer is the writer of the event contract with the bounds of [Bounds](logging.md#bounds); a run stores at most these events, so neither file is rotated. A folder or file that cannot be created is reported as `sok: event log: <path>: <reason>` on the standard error, and the command runs without a record and keeps its own status. The file of a run has no reader besides the audit of the logs and the person: the tool never reads it.

## Releases and the registry

These commands write files and do not need a running application.



Both releases are gzip-compressed tar files. They hold `package.json` and every path of `files`, a directory with the files under it, at their paths relative to the directory. Entries are sorted by path and have modification time 0, owner 0 and mode 0644, or 0755 for a file that has an executable bit. A listed path that does not exist, leaves the directory, or is or contains a symbolic link or a file that is neither regular nor a directory fails the command, which then writes nothing. The two implementations write the same entries, but their gzip streams differ, so the `sha256` of an release is the value printed by the `sok` that wrote it.

`sok registry build <directory>` reads `plugins/<id>.json`, `sidecars/<file name>.json`, `packs/<name>.json` and `revoked.json` (`{ plugins, sidecars }`) of a registry directory. Each file holds one entry of the [registry index](installation.md#registry-index) and its name matches the entry. The command checks the entries as one index, reads every release and compares its `sha256`, and checks that a plugin release holds `plugin.json` with the plugin id and the entry's sidecar ranges as `dependencies`, and a `package.json` with the entry's `name`, version and `engines.soksak`. Only when every check passes does it write `index.json` with each list sorted by id or name, two-space indentation and the field order of the [registry index](installation.md#registry-index) table, so both implementations write the same bytes; it replaces the file in one step. A missing `plugins`, `sidecars` or `packs` folder holds no entries; a missing `revoked.json` fails the build. It prints `{ index, plugins, sidecars, packs }` with the path and the number of entries.

## Installing plugins

These commands change the files of the [installation layout](installation.md#installation-layout) in the configuration directory. A configuration directory has one installation, so two commands must not change it at the same time.

`sok registry use <index>` reads the registry index at a path, an absolute `file:` URL or an `https:` URL ([fetching](installation.md#fetching)), checks it, and writes `plugins/registry.json` (`{ "format": 1, "index": "<URL>" }`), where a path becomes its absolute `file:` URL. It prints `{ index }`. An application sets the registry of its `environment.json` on its first run; this command sets another one, such as a local registry folder.

`sok plugin install <id>` reads the index that `plugins/registry.json` names and `plugins/installed.json` (none means nothing is installed), selects the versions for the core version of this `sok` and the platform it runs on ([version selection](installation.md#version-selection)), and then:

1. reads each selected release that is not installed yet, compares its `sha256`, and extracts it into a temporary folder beside its install path that it renames into place;
2. writes `plugins/installed.json` in one step: the plugin with its version, `enabled: true`, the sidecar ranges of that version and, when it replaces another version, `previous`; the selected sidecar versions; and no sidecar that no plugin names;
3. deletes every plugin folder and version folder other than the version in use and `previous` of an installed plugin, and every sidecar folder and version folder that `installed.json` does not name.

A plugin already installed at the selected version is left unchanged. A failure in step 1 or 2 leaves `installed.json` unchanged and reports the step; a failure in step 3 reports the folder it could not delete. Extraction accepts only regular files and folders at relative paths without `..`, and keeps mode 0755 for a file with an executable bit and 0644 otherwise. Before step 1 the command checks the `plugin.json` of each selected version with the rules of the [plugin release](installation.md#plugin-release); a refused manifest fails the command with its location and the reader's text, and nothing is changed. The command prints `{ plugin, sidecars }`: the entry of the plugin in `installed.json` and the sidecar versions it uses.

`sok plugin update <id>` installs the selected version of an installed plugin and fails for a plugin that is not installed. `sok plugin remove <id>` deletes the plugin from `installed.json` and then deletes `plugins/<id>` and the sidecar version folders that `installed.json` no longer names. `sok plugin enable <id>` and `sok plugin disable <id>` set `enabled`. Installing a plugin also installs its plugin dependencies, and `remove` and `disable` fail for a plugin that an enabled installed plugin requires ([version selection](installation.md#version-selection)). These three print the plugin entry, or `null` after removal. `sok plugin list` prints `installed.json`.

## Installation and a running application

The plugin and sidecar commands change the files of the configuration directory directly and do not need a running application. A running application does not observe the change: pages that load after it read the new plugin list, and the change takes effect when the application restarts ([plugin operations in the application](installation.md#plugin-operations-in-the-application)).

## Agents

An agent is a program on the machine of the person that runs commands and calls tools for the person. An agent learns the application from the agent skill and reaches the running application through `sok` or through the MCP server `sok mcp`, which both read the [endpoint](endpoint.md) of the configuration directory of their `sok`. Three kinds of setup part make this possible without anyone telling the agent: the path entry, which puts `sok` on `PATH`, the agent skill, and the MCP registration. `sok setup check` reports each setup part with its state and its install step, `sok setup install` installs the missing ones, and the settings window shows the same parts ([settings window](settings.md#에이전트)).

The commands of this section read `HOME`, `PATH` and `CLAUDE_CONFIG_DIR` from their environment. `<home>` is the value of `HOME`, and a command that needs it fails with `HOME is not set` when it is not set or empty. `<sok>` is the absolute path of the running `sok` with symbolic links resolved (Go `os.Executable` and `filepath.EvalSymlinks`, Rust `std::env::current_exe` and `std::fs::canonicalize`). In a step that a person types into a shell, `<sok>` is written as it is when it holds only `A-Z`, `a-z`, `0-9`, `/`, `.`, `_` and `-`, and otherwise between single quotes, with each single quote of the path written `'\''`.

### Agent sources

`packages/sok/agents/` holds the texts that an agent reads, in one copy for both implementations:

| File | Content |
| --- | --- |
| `SKILL.md` | The agent skill ([agent skill](#agent-skill)) |
| `mcp.json` | `{instructions, tools}`: the instructions of the MCP server, at most 4096 bytes of UTF-8, and each tool with its `name`, `description` and `inputSchema` in the order of `tools/list` ([MCP server](#mcp-server)) |

The Rust `sok` includes the files with `include_str!` from this folder. The Go `sok` embeds copies of them in `packages/sok/go/src/`, because `go:embed` reads only files below the folder of the embedding package; the Go test of `cli.agents.copies-equal-the-sources` compares each copy with its source, as `make check-exposure` holds the declaration copies of `packages/workbench-mygo` equal to theirs. The folder is no package: it has no manifest, and the tests of both packages read it as they read the cases of `docs/spec/cases`. Both servers register the tools with the input schemas of `mcp.json` as they are, not with schemas that the library derives from types, so both lists are the same JSON.

### Discovery

The application declares more commands, statuses and elements than an agent reads at once, and each installed plugin adds its own ([exposure](exposure.md#declarations)). An agent therefore finds the entries it needs when it needs them, from the exposure of the running application, never from a list written in advance: a plugin that is installed, removed, enabled or disabled changes `exposure.list` once a window starts its workbench again ([applying a change](installation.md#applying-a-change)), and the next discovery reads the changed list. A request for an entry that is no longer declared fails with the endpoint error that names it.

A query matches an entry when each word of the query is a part of the name or of the description of the entry. The words are the parts of the query between spaces, tabs and line breaks, and an empty part is no word; the letters `A` to `Z` and `a` to `z` match regardless of case, and every other character matches only itself. An empty query matches every entry. `sok exposures --query` and `sok commands --query` print the entries that match, in the order of `exposure.list` and with their full declarations; the MCP tool `exposure_search` uses the same rule.

### Agent skill

The agent skill is `packages/sok/agents/SKILL.md` in the form of the shared skill format: a front matter with `name: soksak`, which equals the name of its folder, and a `description` of at most 1024 Unicode scalar values that states when an agent uses it, then the instructions. An agent keeps only the name and the description in its context and reads the instructions when it uses the skill.

The skill is static. It holds no list of commands, statuses, elements or plugins, because such a list would be stale after a plugin change and too long to read, and no content of one installation, so a plugin change needs no new skill. It holds what holds for every installation:

- what soksak is, and that `sok` and the MCP tools reach the running application whose configuration directory that `sok` uses; the MCP tools exist only for an agent with which the MCP server is registered, and `sok` reaches the application from any shell;
- how to find the running application and its windows (`sok windows`, `windows_list`), and that a request without a running application fails with the text that the endpoint file does not exist;
- how to find entries ([discovery](#discovery)): `sok commands --query`, `sok exposures --kind --query`, `exposure_search`, and the declaration of one entry before its use (`exposure_describe`);
- how to run a command with the parameters of its schema (`sok <command>`, `command_run`), read and wait for a status (`sok status`, `status_get`, `status_watch_once`), act on an element (`sok element`, `element_rect`, `element_act`), and when native input is the tool (`sok input`, `input_pointer`, `input_key`, `input_text`);
- that plugins are changed through the declared commands `core.plugins.*` of the running application, because `sok plugin` beside a running application is refused ([installation](installation.md#plugin-operations-in-the-application));
- the rules an agent follows: it runs only declared commands; it reads the schema of a command before it runs it; it waits on statuses, not on time; a change that removes the work of the person, such as closing a modified tab, removing a plugin or quitting the application, is asked of the person first; an operation that needs the person, such as the answer of a system dialog, the activation of the application for an input method or administrator rights, is asked of the person and not worked around; an error is reported to the person with its text.

The skill does not run commands when an agent reads it, because agents do not all run them and a failing command would end the reading.

`sok skill print` writes the skill text to standard output, without an addition.

The agent folders are `<home>/.claude`, `$CLAUDE_CONFIG_DIR` when that variable is set and not empty, and `<home>/.agents`, in this order. An agent folder exists when it is a directory after symbolic links are followed; a missing agent folder belongs to an agent that the person does not run. The skill file of an agent folder is `<agent folder>/skills/soksak/SKILL.md`, and two agent folders whose skill folders resolve to the same canonical folder have one skill file, listed once at its first place in the order. A skill file is current when its bytes equal the skill text of the running `sok`.

`sok skill install` writes the skill file of each agent folder that exists, and fails with `no agent folder: neither <home>/.claude nor <home>/.agents is a directory; sok skill print writes the skill to standard output` when none exists, writing nothing; with `CLAUDE_CONFIG_DIR` set, the text names that folder after `<home>/.claude`. It first creates the missing folders `skills` and `skills/soksak` (mode 0755) of each existing agent folder, before it writes a file, because an agent follows changes of its `skills` folder in a running session only when that folder existed at the start of the session; it leaves a current skill file unchanged. It writes another one through a temporary file with a unique name in the same folder (Go `os.CreateTemp`, Rust `tempfile::NamedTempFile::new_in` and `persist`), which it renames over the skill file at mode 0644, so a reader never reads a partial skill and two writers at once never write into one temporary file. It prints `{"skills": [{"file": <path>, "state": "written" | "current"}]}`. A failed write fails the command with `<path>: <reason>` after the files written before it, and removes its temporary file. A repeated run prints `current` for every file and writes nothing.

A skill file that differs from the skill text, also one that a person edited, is replaced: the file belongs to `sok`, and the skill text of the running `sok` is the one that describes it. The text changes only with a release, so a rewrite follows an update of the application. Two installed applications of different releases write their own texts, and the application that starts last leaves its text. An agent that reads both `skills` folders reads two skills of the same name with the same bytes, which describe the same tools. An agent reads a new skill file in a session that it starts afterwards, and some agents also in a session that runs.

### MCP server

`sok mcp [window]` is a stdio MCP server: it reads MCP messages from standard input and writes only MCP messages to standard output, one JSON-RPC 2.0 message per line, and writes its diagnostics to standard error. It opens no network port. Each implementation uses the official MCP library of its language, `github.com/modelcontextprotocol/go-sdk` for Go and `rmcp` for Rust, and writes no protocol code that the library provides. Both answer the protocol revisions `2026-07-28` and `2025-11-25` and refuse every other revision, as the earlier server did, because these are the revisions whose messages the contract cases state: the Go server sets `ServerOptions.SupportedProtocolVersions` to these two, since the library otherwise also answers earlier revisions, and the Rust server sets the same list through the server options of its pinned `rmcp` release. The cases `mcp-protocol-2026-07-28`, `mcp-protocol-2025-11-25` and `mcp-protocol-unsupported` (a request of `2025-06-18`) hold this. The server information is `{"name": "soksak", "version": <core version>}`, and the instructions are those of `mcp.json`: what the tools reach, that an agent searches before it runs, and the rules of the skill in short, because an agent keeps the instructions of a server in its context.

At its start, before it reads the first message, `sok mcp` brings the skill current: it writes each skill file of an existing agent folder as `sok skill install` does. No agent folder is no error here, and a failed write is written to standard error as `sok: skill: <path>: <reason>` and stored in the event log; the server starts in each case.

The server serves while its standard input is open, also while no application runs and while the application ends or starts again. It connects to the endpoint at the first tool call that needs it, and again at the next call after the connection ended; a call while no application runs is a tool error with the text of the endpoint file that is missing or of the process that is not running, and the next call tries again. The window of a call is its `window` argument, else the `[window]` of the start (`--window <name>` or `--project <directory>`, as for every command), else the key window of `windows.list`, else its first window.

The tools are a fixed set; no tool is made from the exposure:

| Tool | Arguments | Endpoint requests and result |
| --- | --- | --- |
| `windows_list` | none | `windows.list` |
| `exposure_search` | `window?`, `kind?` (`status`, `command` or `element`), `query?`, `offset?`, `limit?` | `exposure.list` of the window; `{entries, total, next}`: the entries that match ([discovery](#discovery)) as `{kind, name, description, registered}`, without schemas, in the order of `exposure.list` from `offset` (default 0), at most `limit` of them (1 to 200, default 50), the number of matching entries, and the `offset` of the next page or `null` |
| `exposure_describe` | `window?`, `kind`, `name` | `exposure.list` of the window; the declaration of the entry with `registered`, and the tool error `<kind> <name> is not declared` for a name that the list lacks |
| `command_run` | `window?`, `surface?`, `name`, `params?` | `command.run` with `params`, or `{}` without them |
| `status_get` | `window?`, `name`, `surface?` | `status.get` |
| `status_watch_once` | `window?`, `name`, `surface?`, `equals?` | `status.watch`, `status.get`, `status.unwatch`: the value that equals `equals`, also the current one, or without `equals` the value of the next change; no time limit |
| `element_rect` | `window?`, `name`, `surface?`, `index?` | `element.rect` |
| `element_act` | `window?`, `name`, `surface?`, `index?`, `action`, `value?`, `event?` | `element.act` |
| `input_pointer` | `window?`, `x`, `y`, `phase`, `button?`, `deltaX?`, `deltaY?`, `clicks?`, `activate?` | `input.pointer` |
| `input_key` | `window?`, `key`, `text?`, `modifiers?`, `phase` | `input.key` |
| `input_text` | `window?`, `phase`, `text?`, `selection?`, `replacement?` | `input.text` |

`tools/list` sends no endpoint request and answers the tools of `mcp.json`. A result is the JSON text of the endpoint result, `null` for none. An endpoint error, a connection that ends, and an exposure list without the three lists or with a command without `params` are tool errors with the text `<message>`, followed by ` (<code>)` for an endpoint error. Because each discovery reads `exposure.list` of the running application, a plugin change reaches an agent at its next search without a change of the tool list, and the server declares `tools.listChanged` false.

A watch of `status_watch_once` belongs to its call. The server holds one endpoint watch per window, status and surface for the calls that wait on it, and sends `status.unwatch` when the last of them ends; a call that the client cancels ends without a result and ends its share of the watch in the same way.

The endpoint cases `mcp-*` of `docs/spec/cases/endpoint/` are the contract cases of the server, and both implementations replay them ([checks](endpoint.md#checks)). They change with this tool set: `mcp-tools-list` becomes `mcp-exposure-search`, the endpoint requests of `exposure_search` without a window (`windows.list`, then `exposure.list`); `mcp-exposure-without-element` and `mcp-exposure-without-params` state the replies that `exposure_search` and `exposure_describe` refuse; `mcp-tools-call` sends the command through `command_run` with the same `command.run` frame; the new `mcp-watch-shared` holds two waits of one status on one watch; `mcp-reconnect` also starts without an endpoint file; and the other cases keep their frames and name `sok mcp` as their client.

### MCP registration

The MCP registration is the entry `soksak` of the user scope of the `claude` command, and it applies when the `claude` command is on `PATH`. Its file is the configuration file of that command in the environment of the run: `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set and not empty, else `<home>/.claude.json`. A missing file holds no registration; a file that does not parse fails with `<file>: <reason>`. The registration is current when `mcpServers.soksak` of the file is an object with `type` `"stdio"`, `command` `<sok>` and `args` `["mcp"]`, and with no `env` or an empty one. The file is the configuration of another program: `sok` reads only `mcpServers.soksak` of it and changes it only through the `claude` command, because the `claude` command answers no registration without starting the server.

`sok mcp install` reads the registration, and:

- with a current one, it changes nothing and prints `{"registration": <entry>, "state": "current"}`;
- with another one, it runs `claude mcp remove --scope user soksak` and then `claude mcp add --scope user soksak -- <sok> mcp`; without one, it runs only the second. It then reads the file again, prints `{"registration": <entry>, "state": "registered"}` when the registration is current, and fails with `claude mcp add did not write the registration to <file>` otherwise.

A `claude` command that ends with a status other than 0 fails the install with `claude mcp <add or remove> failed with status <n>: <first line of its standard error>`; an add that fails after a remove adds `; the earlier registration <command> was removed`. Without the `claude` command on `PATH` the install fails with `the claude command is not on PATH; register the MCP server "<sok> mcp" (standard input and output) with the agent` and changes nothing. A registration names one `sok`, so it reaches the configuration directory of one application. A running agent session starts a server that was registered during the session only in its next session.

`<sok>` must outlast the run: a `sok` on a volume that is mounted read-only, such as a read-only disk image or the read-only mount from which the system runs a downloaded application that the person has not moved (App Translocation), is refused by `sok mcp install` and `sok path install` with `<sok> is on a read-only volume; move the application to a folder such as /Applications and start it again`. The read-only flag of the file system of `<sok>` decides it: Go reads `golang.org/x/sys/unix.Statfs` on both platforms and tests `Flags` with `unix.MNT_RDONLY` on macOS and with `unix.MS_RDONLY` on Linux, whose value is the kernel's `ST_RDONLY`, which that package does not define; Rust reads `rustix::fs::statvfs` and tests `StatVfsMountFlags::RDONLY`.

### Setup parts

| Part | Applies | File | Current when | Install step |
| --- | --- | --- | --- | --- |
| `path` | on a platform with a path entry folder | `/etc/paths.d/<application identifier>` | its content is the content that `sok path install` writes for `<sok>` | `sudo <sok> path install` |
| `skill` | for each agent folder that exists | `<agent folder>/skills/soksak/SKILL.md` | its bytes equal the skill text | `<sok> skill install` |
| `mcp` | when the `claude` command is on `PATH` | the configuration file of the `claude` command | the registration is current | `<sok> mcp install` |

`sok setup check` prints `{"parts": [{part, file, state, step, reason?, command?, error?}]}` with the members in this order, the parts in the order of the table and the skill files in the order of the agent folders. `state` is `ok`, `missing` or `error`. A missing part has `reason`: `absent` for a file or registration that does not exist, `differs` for one that differs from what the install writes, and `other` for a registration whose `command` is the `sok` of another installed application, which `command` then names: an absolute path other than `<sok>` to an executable regular file named `sok` whose folder is `Contents/MacOS` of a folder whose name ends in `.app` on macOS, or to an executable regular file named `sok` on Linux. Every other registration that is not current is `differs`. A part whose state cannot be read has `error`, the text of the failure. A part that does not apply is not listed: Linux has no `path` part. The command changes nothing, and exits 0 when every listed part is `ok`, else 1 with `sok: setup parts are not current: <part> <file>, ...` on standard error after the JSON on standard output.

`sok setup install` installs each listed part that is not `ok`, of the named kinds or of every kind, by the rules of its own command, and leaves an `ok` part unchanged. A missing path entry needs administrator rights, while the skill files and the registration belong to the person: the command never runs as another user, and when its standard input is a terminal it runs `sudo <sok> path install` as a child, which asks for the password there; otherwise it leaves the path entry missing. It prints the parts as `sok setup check` does after the install, each with `changed`, true for a part that it changed, and exits 0 when every listed part is `ok`, else 1 with `sok: setup parts are not current: <part> <file>, ...` followed by the error of each part whose install failed. A repeated run changes nothing.

### Agents in the application

The hosts run the setup operations with the setup library of their command line (`packages/sok`), as they run the plugin operations ([plugin operations in the application](installation.md#plugin-operations-in-the-application)), so the application and `sok setup` read and change the same files with the same code; `<sok>` is the `sok` of the application bundle.

A process that the system starts for an application receives the environment of the session, not the one of the person's shell, so its `PATH` lacks the folders that the shell adds and the `claude` command is not found there. The host therefore reads the environment of the person's login shell, the shell of the user database (`getpwuid`), once per host start: it runs `<shell> -l -i -c <sok> setup environment`, with `<sok>` quoted by the rule of a step and the command given as one argument, in a process group of its own (Go `Setpgid`, Rust `process_group(0)`) with standard input from `/dev/null`, and gives `HOME`, `PATH` and `CLAUDE_CONFIG_DIR` of the JSON line that `sok setup environment` prints to the setup library, so no shell syntax of the person's shell is involved. The read ends when that line arrives on standard output, not at the end of the output or of the shell, because a process that the shell's start files started can hold the output open; the host then ends the process group, and it ends it in every other outcome too. Standard output and standard error are read apart, and output of the start files before the line is left out. A shell that ends before the line fails the setup operations with `login shell <shell>: <reason>`, where the reason is its exit status and the first line of its standard error; a shell that gave no line within 10 s fails them with `login shell <shell>: no environment within 10 s`, because a shell that waits for input has no event that ends it. The read runs after the start of the first window, not on the start path. The environment of one agent session can differ from the login shell, such as a `CLAUDE_CONFIG_DIR` that a session sets: the settings window shows the parts of the login shell's environment, and `sok setup` in a session shows the parts of the session.

After the environment is read, the host brings the skill current as `sok mcp` does, and records a failed write as the error `host.setup.skill` with the file and the reason. It does not install the path entry or the registration, which change the configuration of the person's system and agent only when the person asks.

| Host call or event | Meaning |
| --- | --- |
| `setupState()` | Returns `{parts}` as `sok setup check` prints it, after the environment is read |
| `setupInstall({parts})` | Installs the named kinds of `skill` and `mcp` as `sok setup install` does and returns its `{parts}`. `path` is refused with `the path entry needs administrator rights: run <step> in a terminal`, because the application has no terminal for `sudo`. The host runs one setup operation at a time and refuses another with `another setup operation is running` |
| `setup-changed` | Sent to every window, without a value, after a `setupInstall` and after the skill write at start, so every window reads the parts again |

### Decisions

- The skill is static. Discovery from `exposure.list` covers every installed plugin at the time of the request, so content of one installation would be a second, stale copy of the exposure and would need a writer at each plugin change. The skill changes only with a release of `sok`.
- The MCP tools are a fixed set of stable names and schemas with search and describe tools, not one tool per declared command. The core declarations alone hold 115 commands, 36 statuses and 150 elements, about 60 KB of tool list as the earlier server made it, before the host and plugin entries. A tool list of that size takes the context of an agent in every session, lowers its choice of tools, and goes stale at each plugin change, while a changed tool list reaches a running session only through a client that follows `notifications/tools/list_changed`, which not every client does, and from an endpoint event of exposure changes, which does not exist. The fixed tools read the exposure at each call, so a plugin change needs no notification, and search results are pages that stay small.
- One source folder for the agent texts with checked Go copies, because `go:embed` cannot read outside the folder of its package, and the Rust package does not read a file of the Go package.
- `sok setup install` gets administrator rights only through `sudo` in a terminal, so the skill files and the registration are written by the person and never by the administrator account; the application shows the step of the path entry instead of running it.
- The registration is written only through the `claude` command, which owns its configuration file; `sok` reads that file only to decide whether the registration is current, and a format of the file that `sok` cannot read is an error that names the file.
- The setup state of the settings window is read when the group is shown, when the window becomes the key window (`window-active`), after `setup-changed` and by `core.setup.check`, not by watching files: the configuration file of the `claude` command is rewritten by every agent session, and the state matters when the person looks at it.

The review of this contract answered these objections:

- One registration name serves one application at a time. The application never registers on its own, so two installed applications do not take the registration from each other; the check reports the registration of another application as `other`, and the button of the settings window says that it replaces it.
- An agent session can set `CLAUDE_CONFIG_DIR`, so the agent folders take `<home>/.claude` and that folder both, one skill file per canonical skill folder, and the registration file is the one of the environment of the run.
- Several writers can bring the skill current at once (every agent session starts `sok mcp`), so each writes through a temporary file of a unique name and a rename.
- The libraries derive schemas from types in different forms, so the tool list is one JSON file whose schemas both servers register as they are.
- The library of Go answers earlier revisions unless it is given a list, so both servers are given the two revisions of the cases.
- A login shell that prints and then waits, or whose background process holds its output, ends no read by itself, so the read ends at its JSON line or at the bound, and the host ends the process group of the shell.
- A `sok` on a read-only mount disappears after the run, so the installs that write its path refuse it; the check reads the read-only flag of the file system, with `statfs` in Go and `statvfs` in Rust.
- Watching the configuration file of the `claude` command was rejected, because every agent session rewrites it; the state is read when the person looks at it.
- A `soksak` entry of a local or project scope of the `claude` command is not checked, because it depends on a working folder that the check does not have.
- A window that is loading answers 1003, which the tool error carries, so the tools need no readiness rule of their own.
