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

## Required deliverables

This plan delivers two methods, both for `term` and `terminal`:

- **Method A, read the TUI screen.** Read any slice of the visible screen by row (`from`, `count`) as cells and as plain text, with the
  cursor and the wrapped flags. Options 1 and 2 implement it.
- **Method B, find and read the conversation session.** Locate the session of the agent in the terminal (Claude Code or Codex) and read
  its messages in order from the session file on disk. Option 7 implements it, and its result states the file that it read.

Options 3 to 6 are not required by these two methods; each is decided separately after Method A and Method B are verified.

## Terminal state

The reads above return content. A caller also needs the state of each terminal: whether a program runs, is stopped, is idle at a
prompt, or waits for input. The state is an event that the sidecar publishes when it changes, not a value that a caller polls.

Facts from the current code:

- The `alacritty` engine parses OSC 133 marks `A` (prompt start), `B` (prompt end), `C` (command start) and `D` (command finished,
  with its exit code) (`alacritty/src/engine.rs`, `ShellMarker`). It records the prompt start and its absolute line. No event reports
  these marks yet.
- A TUI agent such as Claude Code or Codex emits no OSC 133 marks, so the marks show only the shell prompt, not the agent's own work.

Proposed states, derived in order from the earliest reliable signal:

- `idle`: the shell is at a prompt (after `A`/`B`, before `C`) with no command running.
- `running`: a command started (`C`) and has not finished (`D`).
- `exited`: the command finished (`D`), with the exit code.
- `waiting`: the program has been silent for a window and its screen shows a prompt or question. This is a heuristic and is marked
  as such in the result.
- `agent-busy` / `agent-waiting` (Claude Code, Codex): decided from the agent's own signal, for example its hook events, if the
  agents provide them (see the open-source comparison below). Output silence alone is not used as the decision.

Each change emits an event with the previous and new state, the source of the signal, and a sequence number. A state read returns the
current state, its source, and the sequence number of its last change.

### Open-source comparison (state signals)

- Orca (github.com/stablyai/orca) layers its signals: OSC 133 `A`/`D` marks, an agent status protocol (OSC 7501), agent hook events
  (Claude Code `SessionStart`, `UserPromptSubmit`, `Stop`, `PreToolUse`, `PermissionRequest`, `SessionEnd`), title glyphs, and output
  quiescence with a rendered-screen check. Its states are `working`, `permission`, `idle`, and `done` for hook state. An explicit report
  overrides a title-derived status, and idle from a title is accepted only after output has been quiet for a window.
- omp (github.com/can1357/oh-my-pi) is the reporter, not a detector: it writes its own run state (`idle`, `working`, `done`, `error`,
  `blocked` with `permission` or `question`) through the OSC 7501 record, from its event flow, and disables OSC 133 zones while a record is
  held.
- Claude Code provides hook events (`Stop`, `Notification` with `permission_prompt`/`idle_prompt`, `PermissionRequest`, `StopFailure`),
  which are event sources for `agent-busy` and `agent-waiting` without guessing from the screen.
- Codex: `notify` fires only on turn completion; approval events need the `PermissionRequest` hook. Its exact hook payloads are not
  verified (open item V4).

Decision for this plan: the agent states come from the agent's hook events when present; the screen heuristic is used only for a
terminal with no hook, and it is marked as a heuristic. Items V4 (Codex hook payloads) and V5 (Claude Notification payload fields) are
verified before the states are implemented.

## Terminal messaging (decision D3)

Terminals notify each other when a watched folder changes. The contract is one path for every agent:

- The only source of messaging events is a file event observed by the terminal sidecar. The sidecar watches the folders that a terminal
  registers and publishes an event for each change. It does not poll.
- Agent hooks (Claude Code `FileChanged`, Codex hook events) are not on the delivery path. They may enrich the agent state (see
  Terminal state), but a message is delivered the same way whichever agent wrote the file.
- A trigger acts through the terminal: it injects input into the registered terminal or runs a declared command. No agent API is used.
- The delivery latency is measured on the shared machine before any bound is written into the contract. The FSEvents delay recorded
  in the shared-machine measurement is 3 to 14 seconds, so no bound is claimed before that measurement (open item V6).

Why one path: Codex has no file-change event, and Claude's `FileChanged` runs only inside a Claude session. Two paths would deliver the
same message at different times or not at all.

## Agent delivery (decision D4)

The delivery channel for a message is chosen by one criterion: the better channel that the agent offers.

- Baseline: input injection into the registered terminal. The message, command or skill call uses one declared form. The TUI may queue
  the input; the queue is accepted behavior. The sidecar does not gate on terminal state and does not work around TUI behavior such as
  dialogs or timing.
- Better channel, where the agent offers it: MCP tools of the sok server (`messages.read`, `messages.wait`). The result is structured and
  leaves no input in the conversation. The agent uses it when its client supports MCP tools.
- Skills improve the usage of either channel. They are not required by the delivery.

Open item V7: the time limit of a waiting MCP tool call in each client (Claude Code, Codex), which decides how `messages.wait` returns.

## Unattended dialog handling (decision D5)

A product capability: when a terminal waits on a dialog and the user has enabled supervision for that terminal, the supervising agent
answers the dialog through this capability. The capability is not a one-time instruction; it applies whenever the situation occurs. The
supervisor decides by these rules:

- Destructive: the dialog would delete or overwrite files, discard uncommitted changes, rewrite or force-push history, remove processes or
  data, change permissions or credentials, or write to an external service. The supervisor cancels (Esc or Ctrl-C), then sends a message
  to the agent that states the reason and the safer path.
- Not destructive: the dialog is reversible and scoped to the project (for example, run tests, read a file inside the project, continue
  a paused turn). The supervisor selects the accepting option.
- Unclear: treated as destructive. The supervisor cancels and records the case.
- Every decision is written to the event log with the dialog text, the options, the decision, and the rule that decided it.

Requirement: cancel and select must work on any dialog. The keys and the option positions come from the terminal state of each agent
adapter. The supervisor runs only when enabled by the user for a terminal.

Status: not implemented. The terminal state, the dialog detection and the key commands are open work.

## TUI key adapters (decision D6)

Keys such as Ctrl-B (send the running command to the background), Ctrl-Enter (send the input now), Esc and Ctrl-C differ by TUI and by
version. Each agent adapter declares the keys it supports for each action. The supervisor and the messaging use the action, not the key:

- If the TUI supports the action, the adapter sends the TUI's own key.
- If it does not, the adapter uses the sok fallback for that action. The fallback is the sok behavior, for example a queued message
  delivered at the next idle state, or a cancel through the terminal's own interrupt.
- The adapter records which path it used for each action in the event log.

A foreground TUI that is busy or asleep does not receive a message until the background or send-now action runs, so that action is
required for delivery.

## What runs in a terminal (F899-3)

A caller needs the program that runs in each terminal, and the background jobs of its shell, by name. Proposed command `term.process.list`:

- Foreground: the process group that owns the terminal, its leader's name and arguments, and the time it started.
- Background: the jobs of the shell that the terminal reports (names, process ids, states such as running or stopped), read from the
  process table of the session, not from the screen.
- Each entry states its source (process table, or OSC 133 command marks when the shell sends them).
- A process name alone does not identify an agent; the agent is identified by its process arguments and its session file (method B).

## Reference: how other agents deliver messages (F899-2, F899-4 input)

Observed in the local Claude Code 2.1.327 binary and the open-source Codex repository. Strings and source names only; no run was done.

- Claude Code: cross-session messages carry a peer frame and the receiver shows them under a `[SYSTEM NOTIFICATION - NOT USER INPUT]`
  frame, so a message is not taken as the user's turn. A session states whether it accepts them (`crossSessionInbound`: accept, hold,
  refuse). The peer list is read from the server endpoint `/v1/code/sessions`. The idle notice tells the sender when the receiver is next
  idle. A same-machine direct channel was not found in the strings (open item V8).
- Codex: messages move only between agents of one runtime (`send_message`, `followup_task`, `wait_agent`, `list_agents`), through an
  in-memory mailbox (`codex-rs/core/src/agent/api.rs`). No cross-process or cross-session transport was found.
- Consequence for this plan: cross-session delivery between separately launched terminals has no agent-side transport in either agent.
  The plan keeps input injection as the baseline and the MCP tools as the better channel where the agent offers them.

## Destructive command guard (F899-6)

Requirement: a destructive shell command from an agent is stopped before it runs, on every agent the terminal hosts. Two open-source
guards were read (no code was run): a Rust hook with rule packs for many agents (dcg, MIT-style custom license), and a zero-dependency
Node hook that also tracks which process, port and worktree belongs to which session (claude-bulkhead, MIT).

Evaluation against our needs:

- Fit: both read the command text. Neither sees a script file, a shell function, or a value computed at run time. The cause of the
  reported deletions was mostly that kind of value, so these guards are a layer, not the protection.
- Failure mode: dcg fails open by default for input it cannot parse, and offers an opt-in fail-closed setting. The plan takes the
  opposite default for destructive guards: unparseable or undecidable input is refused, and the refusal is written to the event log.
- Bypass: both expose an environment variable that disables the guard. An agent that can set that variable can disable the guard, so
  the plan does not expose a bypass to the agent.
- Process ownership: claude-bulkhead tracks which session owns a process and a port. This matches the process list of F899-3 and is
  a model for it; the plan does not depend on the package.
- Dependencies: the guards are agent plugins, not libraries for our sidecar. The plan takes no dependency on either package.

Decision D7: build the destructive-command check in the terminal sidecar layer as a declared rule set, with fail-closed behavior and
an event for each decision. Use the two packages as references for rule coverage and for the process ownership model only.

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

## Status and verification by checklist item

Status: no item is implemented. Each item lists its Red test (fails on the current code) and its Green evidence (passes after the change). Owners are the repositories that hold the code.

| Item | Owner | Red test (to write first) | Green evidence | Status |
|---|---|---|---|---|
| F899-1 screen rows by range | sidecars `vt`, `alacritty`; plugins `terminal`, `term` | a `screen.read {from, count}` call returns rows outside the viewport | the same call returns the requested rows in both sidecars and both plugins | not started |
| F899-2 agent conversation read | sidecars or plugins (method B) | a session file of a known fixture yields its messages in order | the read returns the messages and names the file | not started |
| F899-3 process list | sidecar `alacritty` (macOS first) | a shell with a background job lists the job by name | `term.process.list` names the foreground and the background job with its source | not started |
| F899-4 terminal state | sidecars, adapters | a fixture shell prompt, a running command, and a finished command produce idle, running, exited events | each transition emits one event with its source and sequence number | not started |
| F899-5 key adapters and dialog handling | adapters; supervisor | a fixture TUI with a dialog ignores a key until the adapter sends the declared key | the adapter sends the TUI key when it has one, and the fallback otherwise, and logs the path | not started |
| F899-6 destructive command guard | sidecar layer | a destructive command fixture is refused, and an unparseable input is refused (fail-closed) | the refusal is in the event log with its rule | not started |

Each Red test is written in the owner repository and recorded as failing before the change. The checks of the owner repository run; no full suite runs for an item.

## Open items

Each item states its status, its owner, and the condition that closes it. No item is implemented.

- V1 (open): how `vt` handles OSC 133 marks. Owner: sidecar `vt`. Closes when a test shows the marks are parsed or the state is stated as absent.
- V2 (open): reproduce the scroll report in a running Claude Code or Codex session in `term` and `terminal`. Owner: plugins. Closes with a recorded wheel route and offset before and after.
- V3 (open): which process the sidecar can name as the foreground process on macOS. Owner: sidecar `alacritty`. Closes with a test that names it.
- V4 (open): Codex hook payloads for the events the state uses. Owner: adapter. Closes with a recorded payload from a real session.
- V5 (open): Claude Code `Notification` payload fields. Owner: adapter. Closes with a recorded payload.
- V6 (open): delivery latency of file events on the shared machine. Owner: sidecar. Closes with a measured bound; no bound is stated before it.
- V7 (open): time limit of a waiting MCP tool call in Claude Code and Codex. Owner: sok MCP server. Closes with a measured limit per client.
- V8 (open): whether Claude Code has a same-machine direct path for session messages. Owner: adapter. Closes with a recorded observation.
- D1 (open): byte bound of the transcript read (option 6). Owner: sidecar. Closes with a decision in this document.
- D2 (open): whether `history.find` searches cell text only or the cell style too. Owner: sidecar. Closes with a decision.
- D3 to D7: decided in their sections. Implementation is not started.


- V1: check how `vt` handles OSC 133 marks (`sidecars/vt`, `vt-core`).
- V2: reproduce the scroll report in a running Claude Code or Codex session in `term` and in `terminal` (the wheel route and the offset
  before and after), and check whether each TUI scrolls its own content when it receives the wheel.
- V3: check which process the sidecar can name as the foreground process of a session on macOS, for option 7.
- D1: choose the byte bound of the transcript (option 6) before implementation.
- D2: choose whether `history.find` searches cell text only or also the style of the cells.
