# Terminal reads of the screen and the history

[한국어](terminal-reads.ko.md)

This proposal adds the reads that a person or an agent needs to read more than the visible screen of a terminal. It applies to both
terminal plugins, `terminal` (sidecar `vt-alacritty`) and `term` (sidecar `alacritty`), and to both sidecars. Each command has the same
name, parameters and result in both plugins, and each sidecar checks the same shared contract cases, so a change applies to both
terminals in the same way.

## Facts found in the current code

- `terminal.screen.read` and `term.screen.read` return only the viewport: `screen_lines` rows of the grid at the current display offset
  (`sidecars/alacritty/alacritty/src/engine.rs`, `fn screen`). Nothing returns the rows above the viewport as data.
- `terminal.scrollback.set` and `term.scrollback.set` change the display offset, which the sidecar reports as `scrollback.offset` and
  `scrollback.history` in the session status. The offset does not return text.
- The `alacritty` sidecar already parses OSC 133 shell marks (`A`, `B`, `C`, `D`) and tracks a prompt start and an absolute line
  number (`dropped + history + line`) that stays stable while history is kept (`engine.rs`, `fn absolute`). No command exposes these.
- The `vt` sidecar and the OSC 133 handling of `vt-core` are not verified yet (open item V1).
- Why scrolling does not move the screen of a TUI agent (Claude Code, Codex): a TUI runs on the alternate screen. The engine keeps no
  history for the alternate screen (`alacritty/tests/engine_test.rs`, `alternate_screen_is_separate_from_primary_scrollback`). The
  wheel is routed by `WheelRoute::of` (`alacritty-core/src/protocol.rs`): with mouse reporting and no Shift it goes to the program; on the
  alternate screen with alternate scroll it becomes cursor keys to the program; only the primary screen moves the viewport. The viewport
  command clamps the offset to the history (`SurfaceCommand::Viewport`), which is empty on the alternate screen, so the screen does not
  move. The plugin shows no message for this case. This explains the report; V2 confirms it in a running TUI before a change.
- A TUI agent keeps its conversation in a file on disk, not in the terminal: Claude Code writes `~/.claude/projects/<cwd>/<session>.jsonl`
  (records `user`, `assistant`), and Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (records `response_item`, `event_msg`,
  with `session_meta` carrying the working directory). These files hold the conversation whatever the screen shows.

## Options and their results

Each option is a command. Results are bounded: every read takes a `count` with an upper limit, and a read beyond the limit fails with
an explicit error.

1. **Viewport slice** (`screen.read {from, count}`). Returns the rows `from` to `from + count` of the viewport. Existing calls without
   parameters keep their result.
2. **Plain text** (`screen.text {from, count}` and `history.text {from, count}`). Returns each row as text without its trailing blanks
   and with a `wrapped` flag, so a reader does not parse cells. The cell form stays available through option 1.
3. **History by absolute line** (`history.read {from, count, format}`). Reads rows from the retained history by absolute line number.
   The result holds `first` (the oldest retained line), `last` (the newest line) and `dropped`. An absolute number keeps its meaning
   until the history is erased, which the `dropped` count reports.
4. **Search** (`history.find {pattern, from, limit}`). Returns the absolute line numbers and the matching text of each match, at most
   `limit` matches; the pattern is a regular expression, and an invalid pattern fails with its error text.
5. **Command output by shell mark** (`command.list {limit}` and `command.read {index, format, from, count}`). Each command is the rows
   between a `C` mark and the following `D` mark, with the exit code of `D`. `command.list` gives each command's index, absolute start
   and end, and exit code. A terminal without shell integration answers an empty list, and `command.list` states that no mark was seen.
7. **Agent conversation** (`agent.conversation {limit, after}`). Finds the agent of the session from its foreground process
   (`claude` or `codex`) and reads its session file, returning the messages in order with their role, text and time. The file is read
   from the disk of the same user; the sidecar does not decode the screen. Which file belongs to the session comes from the working
   directory of the session and the newest file of that directory (Claude) or the `session_meta` working directory (Codex). Each result
   states the file it read and whether a file was found.
6. **Raw output log** (`transcript.read {offset, bytes}`). Returns the PTY output bytes of the session from an offset, from a log with a
   fixed byte bound. This option needs a memory bound decision before implementation (decision D1).

Every read is idempotent: it changes no state, and the same request returns the same result until the content changes. A result carries
`generation`, which the sidecar increments on each change of content, so a caller can detect that a result is stale.

## Where each option lives

- Sidecars: options 1 to 5 are implemented in both `vt` and `alacritty`. Option 5 needs the `vt` handling of OSC 133 (V1); if `vt` does
  not parse the marks, its command list stays empty and its specification says so.
- Plugins: `terminal` and `term` declare each command with its schema and expose it through the same status and command names.
  Each plugin checks the shared contract cases of its sidecar; no plugin test reads the other plugin's files.
- Core: no change. The commands use the declared exposure of the plugins.

## Versions and release order

1. Sidecar `alacritty` and sidecar `vt` each release the commands with their own version.
2. Plugins `term` and `terminal` each raise the sidecar dependency to the release that has the commands, then release.
3. Core is not changed by this proposal.

Versions are decided at release time under the rule of the repository that owns each part.

## Verification

- Each option has a Red test in the sidecar that owns it, with the failing assertion recorded before the change.
- The shared contract cases for each command run in both sidecars and both plugins.
- Options 3 and 5 are checked with a long session that exceeds the retained history, with the absolute numbers compared before and after.
- Measurement of cost (time and memory per read) happens after development, as the plan of the owning repository states.

## Open items

- V1: check how `vt` handles OSC 133 marks (`sidecars/vt`, `vt-core`).
- V2: reproduce the scroll report in a running Claude Code or Codex session in `term` and in `terminal` (the wheel route and the offset
  before and after), and check whether each TUI scrolls its own content when it receives the wheel.
- V3: check which process the sidecar can name as the foreground process of a session on macOS, for option 7.
- D1: choose the byte bound of the transcript (option 6) before implementation.
- D2: choose whether `history.find` searches cell text only or also the style of the cells.
