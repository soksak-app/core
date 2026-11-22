# Terminal plan: reads, state, messaging, dialogs, and command guard

[한국어](terminal-plan.ko.md)

This plan covers the terminal plugins `terminal` (sidecar `vt-alacritty`) and `term` (sidecar `alacritty`). It has five parts. Each part
states its facts, its decisions, its test plan and its open items. No part is implemented. The checklist items are F899-1 to F899-7
in [features](../features.md).

| Part | Subject | Checklist item | Decisions | Open items |
|---|---|---|---|---|
| 1 | Reads of the screen and the conversation | F899-1, F899-2 | D1, D2 | V1, V2 |
| 2 | Terminal state and the process list | F899-3, F899-4 | state rule | V3, V4, V5 |
| 3 | Messaging between terminals and agents | F899-7 | D3, D4 | V6, V7, V8 |
| 4 | Dialogs and TUI keys | F899-5 | D5, D6 | none |
| 5 | Destructive command guard | F899-6 | D7 | none |

Part 6 holds the shared release order, verification rules and the status table. Part 7 indexes the decisions.

## Part 1: Reads of the screen and the conversation

### 1.1 Facts from the current code

- `terminal.screen.read` and `term.screen.read` return only the viewport: `screen_lines` rows at the current display offset
  (`sidecars/alacritty/alacritty/src/engine.rs`, `fn screen`). No command returns the rows above the viewport.
- `terminal.scrollback.set` and `term.scrollback.set` change the display offset. The sidecar reports the offset and the history length
  as `scrollback.offset` and `scrollback.history` in the session status. The offset does not return text.
- Scrolling does not move the screen of a TUI agent (Claude Code, Codex), because the TUI runs on the alternate screen. The engine keeps no
  history for the alternate screen (`alacritty/tests/engine_test.rs`, `alternate_screen_is_separate_from_primary_scrollback`). The wheel
  is routed by `WheelRoute::of` (`alacritty-core/src/protocol.rs`): with mouse reporting and without Shift it goes to the program, and on
  the alternate screen with alternate scroll it becomes cursor keys. Only the primary screen moves the viewport. The viewport command
  clamps the offset to the history (`SurfaceCommand::Viewport`), which is empty on the alternate screen. The plugin shows no message for
  this case. V2 confirms it in a running TUI.
- A TUI agent keeps its conversation in a file on disk, not in the terminal. Claude Code writes
  `~/.claude/projects/<cwd>/<session>.jsonl` (records `user` and `assistant`). Codex writes
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (records `response_item` and `event_msg`; `session_meta` carries the working directory).

### 1.2 Methods

- **Method A, read the TUI screen.** Read any row range of the visible screen as cells and as plain text, with the cursor and the
  wrapped flags. Options 1 and 2 implement it.
- **Method B, read the conversation session.** Find the session of the agent in the terminal (Claude Code or Codex) and read its messages
  in order from the session file. Option 6 implements it. The result names the file that it read.

### 1.3 Options

Each option is a command. Every read takes a `count` with an upper limit; a read beyond the limit fails with an explicit error. Every read
is idempotent: it changes no state, and the same request returns the same result until the content changes. A result carries a
`generation` that the sidecar increments on each change of content, so a caller can detect a stale result.

1. **Viewport slice** (`screen.read {from, count}`). Rows `from` to `from + count` of the viewport. A call without parameters keeps its
   current result.
2. **Plain text** (`screen.text {from, count}`, `history.text {from, count}`). Each row as text without trailing blanks, with a `wrapped`
   flag.
3. **History by absolute line** (`history.read {from, count, format}`). Rows of the retained history by absolute line number. The result
   holds `first`, `last` and `dropped`. An absolute number keeps its meaning until the history is erased, which `dropped` reports.
4. **Search** (`history.find {pattern, from, limit}`). Absolute line numbers and matching text, at most `limit` matches. The pattern is a
   regular expression; an invalid pattern fails with its error text.
5. **Command output by shell mark** (`command.list {limit}`, `command.read {index, format, from, count}`). A command is the rows between a
   `C` mark and the following `D` mark, with the exit code of `D`. A terminal without shell integration returns an empty list, and
   `command.list` states that no mark was seen.
6. **Agent conversation** (`agent.conversation {limit, after}`). Method B. Finds the agent of the session from its foreground process
   (`claude` or `codex`) and reads its session file. Returns the messages in order with role, text and time. The file is chosen from the
   session working directory: the newest file of that directory (Claude Code), or the file whose `session_meta` carries that directory
   (Codex). The result states the file it read, or states that no file was found.
7. **Transcript log** (`transcript.read {offset, bytes}`). PTY output bytes from an offset, from a log with a fixed byte bound. Needs
   decision D1 before implementation.

### 1.4 Where each option lives

- Sidecars: options 1 to 5 in both `vt` and `alacritty`. Option 5 needs the OSC 133 handling of `vt` (V1). If `vt` does not parse the
  marks, its command list is empty, and its specification says so.
- Plugins: `terminal` and `term` declare each command with its schema under the same names. Each plugin checks the shared contract
  cases of its sidecar, and no plugin test reads another plugin's files.
- Core: no change.

### 1.5 Red and Green

- Red: a `screen.read {from, count}` call returns rows outside the viewport (fails on the current code).
- Green: the same call returns the requested rows in both sidecars and both plugins.
- Red for option 6: a fixture session file yields no messages in order. Green: the messages are returned in order, and the file name is
  stated.
- Options 3 and 5 are checked with a long session that exceeds the retained history, comparing absolute numbers before and after.

### 1.6 Open items in Part 1

- V1 (open): how `vt` handles OSC 133 marks. Owner: sidecar `vt`. Closes when a test shows the marks are parsed, or when the absence is
  stated in its specification.
- V2 (open): reproduce the scroll report in a running Claude Code or Codex session in `term` and `terminal`. Owner: plugins. Closes with
  the wheel route and the offset recorded before and after.
- D1 (open): byte bound of the transcript log (option 7). Owner: sidecar. Closes with a decision in this document.
- D2 (open): whether `history.find` searches cell text only, or the cell style too. Owner: sidecar. Closes with a decision.

## Part 2: Terminal state and the process list

### 2.1 Requirement

A caller needs the state of each terminal: whether a program runs, has stopped, is idle at a prompt, or waits for input. The state is an
event that the sidecar publishes when it changes. A caller does not poll it.

### 2.2 Facts from the current code

- The `alacritty` engine parses OSC 133 marks `A` (prompt start), `B` (prompt end), `C` (command start) and `D` (command finished, with its
  exit code) (`alacritty/src/engine.rs`, `ShellMarker`). It records the prompt start and its absolute line. No event reports these marks.
- A TUI agent such as Claude Code or Codex emits no OSC 133 marks. The marks show the shell prompt, not the agent's own work.

### 2.3 States

- `idle`: the shell is at a prompt (after `A` or `B`, before `C`) with no command running.
- `running`: a command started (`C`) and has not finished (`D`).
- `exited`: the command finished (`D`), with its exit code.
- `waiting`: the program has been silent for a window and its screen shows a prompt or a question. This is a heuristic, and the result marks it as one.
- `agent-busy` and `agent-waiting` (Claude Code, Codex): from the agent's own signal, such as its hook events. Output silence alone does not
  decide them.

Each change emits an event with the previous state, the new state, the source of the signal, and a sequence number. A state read returns
the current state, its source, and the sequence number of its last change.

### 2.4 Open-source comparison

- Orca (github.com/stablyai/orca) layers its signals: OSC 133 `A` and `D` marks, an agent status protocol (OSC 7501), agent hook events,
  title glyphs, and output quiescence with a rendered-screen check. An explicit report overrides a status derived from a title. Idle from
  a title is accepted only after output has been quiet for a window.
- omp (github.com/can1357/oh-my-pi) reports its own run state through the OSC 7501 record, from its event flow. It does not detect state
  from the screen, and it disables OSC 133 zones while a record is held.
- Claude Code provides hook events (`Stop`, `Notification`, `PermissionRequest`, `StopFailure`), which are event sources for
  `agent-busy` and `agent-waiting`.
- Codex: `notify` fires only on turn completion. Approval events need the `PermissionRequest` hook. Its exact payloads are not verified (V4).

### 2.5 Decision for the state rule

The agent states come from the agent's hook events when they exist. The screen heuristic applies only to a terminal without hooks, and the
result marks it as a heuristic. V4 and V5 verify the payloads before the states are implemented.

### 2.6 Process list (`term.process.list`)

- Foreground: the process group that owns the terminal, its leader's name and arguments, and its start time.
- Background: the jobs of the shell that the terminal reports, with name, process id and state (running or stopped), read from the process
  table of the session and not from the screen.
- Each entry states its source: the process table, or the OSC 133 command marks when the shell sends them.
- A process name alone does not identify an agent. The agent is identified by its arguments and its session file (Part 1, option 6).

### 2.7 Red and Green

- Red for F899-3: a shell with a background job does not list the job by name.
- Green for F899-3: `term.process.list` names the foreground program and the background job, each with its source.
- Red for F899-4: a fixture shell prompt, a running command and a finished command produce no idle, running and exited events.
- Green for F899-4: each transition emits one event with its source and sequence number.

### 2.8 Open items in Part 2

- V3 (open): which process the sidecar can name as the foreground process on macOS. Owner: sidecar `alacritty`. Closes with a test that
  names it.
- V4 (open): Codex hook payloads for the events the state uses. Owner: adapter. Closes with a payload recorded from a real session.
- V5 (open): Claude Code `Notification` payload fields. Owner: adapter. Closes with a recorded payload.

## Part 3: Messaging between terminals and agents

### 3.1 Requirement

A terminal registers a folder. When the folder changes, the registered terminal learns of the change as an event, and a trigger can act
on it. A terminal can also send a message to an agent in another terminal. This part is checklist item F899-7.

### 3.2 Event path (decision D3)

- The only source of messaging events is a file event that the terminal sidecar observes. The sidecar watches the folders that a terminal
  registers and publishes one event per change. It does not poll.
- Agent hooks (Claude Code `FileChanged`, Codex hook events) are not on the delivery path. They may enrich the agent state (Part 2). A
  message is delivered the same way whichever agent wrote the file.
- A trigger acts through the terminal. It injects input into the registered terminal, or it runs a declared command. No agent API is used.
- Delivery latency is measured on the shared machine before any bound is written. The FSEvents delay recorded in that measurement is 3 to
  14 seconds, so no bound is stated before V6 closes.

Why one path: Codex has no file-change event, and Claude's `FileChanged` runs only inside a Claude session. Two paths would deliver the same
message at different times, or not at all.

### 3.3 Delivery channel to the agent (decision D4)

The channel for a message is the better channel that the agent offers.

- Baseline: input injection into the registered terminal. A message, command or skill call uses one declared form. The TUI may queue the
  input, and the queue is accepted behavior. The sidecar does not gate on terminal state, and it does not work around TUI behavior such
  as dialogs or timing.
- Better channel, where the agent offers it: MCP tools of the sok server, `messages.read` and `messages.wait`. The result is structured,
  and no input enters the conversation. An agent uses them when its client supports MCP tools.
- Skills improve the use of either channel. Delivery does not depend on a skill.

### 3.4 Observed delivery of other agents

Observed in the local Claude Code 2.1.327 binary and in the open-source Codex repository. Strings and source names only; nothing was run.

- Claude Code: a cross-session message carries a peer frame, and the receiver shows it under a `[SYSTEM NOTIFICATION - NOT USER INPUT]`
  frame, so it is not taken as the user's turn. A session states whether it accepts such messages (`crossSessionInbound`: accept, hold,
  refuse). The peer list is read from the server endpoint `/v1/code/sessions`. An idle notice tells the sender when the receiver is next
  idle. A same-machine direct path was not found in the strings (V8).
- Codex: messages move only between agents of one runtime (`send_message`, `followup_task`, `wait_agent`, `list_agents`), through an
  in-memory mailbox (`codex-rs/core/src/agent/api.rs`). No cross-process or cross-session transport was found.
- Consequence: no agent provides a transport between separately launched terminals. The plan keeps input injection as the baseline and
  MCP tools as the better channel.

### 3.5 Red and Green for F899-7

- Red: a file created in a registered folder produces no event for the observing terminal (fails on the current code).
- Green: one event per change, with its source and sequence number, is delivered to the registered terminal. The message is then delivered to the agent
  through the channel chosen in 3.3.

### 3.6 Open items in Part 3

- V6 (open): delivery latency of file events on the shared machine. Owner: sidecar. Closes with a measured bound. No bound is stated before.
- V7 (open): time limit of a waiting MCP tool call in Claude Code and Codex. Owner: sok MCP server. Closes with a limit measured per client.
- V8 (open): whether Claude Code has a same-machine direct path for session messages. Owner: adapter. Closes with a recorded observation.

## Part 4: Dialogs and TUI keys

### 4.1 TUI key adapters (decision D6)

Keys such as Ctrl-B (send the running command to the background), Ctrl-Enter (send the input now), Esc and Ctrl-C differ by TUI and by
version. Each agent adapter declares, for each action, the keys that it supports. The supervisor and the messaging use the action, not the key.

- If the TUI supports the action, the adapter sends the TUI's own key.
- If it does not, the adapter uses the sok fallback for that action, for example a queued message delivered at the next idle state, or a
  cancel through the terminal's interrupt.
- The adapter records which path it used for each action in the event log.

A foreground TUI that is busy does not receive a message until the background or send-now action runs. That action is therefore required
for delivery.

### 4.2 Unattended dialog handling (decision D5)

Dialog handling is a product capability. When a terminal waits on a dialog and the user has enabled supervision for that terminal, the
supervising agent answers the dialog through this capability. It applies whenever the situation occurs; it is not a one-time instruction.

- Destructive: the dialog would delete or overwrite files, discard uncommitted changes, rewrite or force-push history, remove processes or
  data, change permissions or credentials, or write to an external service. The supervisor cancels (Esc or Ctrl-C), then sends the agent
  a message that states the reason and the safer path.
- Not destructive: the dialog is reversible and scoped to the project, for example running tests, reading a project file, or continuing a
  paused turn. The supervisor selects the accepting option.
- Unclear: treated as destructive. The supervisor cancels and records the case.
- Every decision is written to the event log with the dialog text, the options, the decision, and the rule that decided it.

Cancel and select must work on any dialog. The keys and option positions come from the terminal state of each agent adapter. The
supervisor runs only for terminals that the user has enabled.

### 4.3 Red and Green for F899-5

- Red: a fixture TUI with a dialog does not respond to the declared key.
- Green: the adapter sends the TUI's own key when it has one, and the sok fallback otherwise. The path used is recorded in the event log.

Status: not implemented.

## Part 5: Destructive command guard

### 5.1 Requirement

A destructive shell command from an agent is stopped before it runs, on every agent that the terminal hosts. This part is checklist item F899-6.

### 5.2 Evaluation of two open-source guards (no code was run)

- A Rust hook with rule packs for many agents, under a custom license.
- A zero-dependency Node hook that also tracks which process, port and worktree belongs to which session. It is MIT licensed.

Evaluation against the requirement:

- Fit: both read the command text. Neither sees a script file, a shell function, or a value computed at run time. The reported deletions
  were mostly caused by such values, so these guards are one layer, not the whole protection.
- Failure mode: dcg fails open by default for input it cannot parse, and it offers an opt-in fail-closed setting. This plan takes the
  opposite default for destructive guards: unparseable or undecidable input is refused, and the refusal is written to the event log.
- Bypass: both expose an environment variable that disables the guard. An agent that can set it can disable the guard, so this plan
  gives the agent no bypass.
- Process ownership: claude-bulkhead tracks which session owns a process and a port. This matches the process list of Part 2 and is a
  model for it.
- Dependencies: both are agent plugins, not libraries for our sidecar. This plan depends on neither.

### 5.3 Decision D7

Build the destructive-command check in the terminal sidecar layer as a declared rule set. It fails closed and writes an event for each
decision. The two packages serve as references for rule coverage and for the process ownership model only.

### 5.4 Red and Green for F899-6

- Red: a destructive command fixture is not refused, or an unparseable input is not refused.
- Green: the destructive command is refused, the unparseable input is refused (fail-closed), and each refusal is in the event log with its rule.

Status: not implemented.

## Part 6: Shared rules

### 6.1 Release order

1. Sidecars `alacritty` and `vt` release their commands and events, each with its own version.
2. Plugins `term` and `terminal` raise the sidecar dependency to the release that has them, then release.
3. Core changes only where the declared exposure needs it. Versions are decided at release time under the rule of the repository that owns each part.

### 6.2 Verification rules

- Each item has a Red test in the owner repository, recorded as failing before the change, and a Green result after it.
- The shared contract cases of each command run in both sidecars and both plugins.
- Only the checks of the owner repository run for an item. No full suite runs for an item.
- Cost measurement (time and memory per read, and CPU per frame) happens after development, as the owning repository's plan states.

### 6.3 Status by checklist item

No item is implemented.

| Item | Part | Owner | Red test (to write first) | Green evidence | Status |
|---|---|---|---|---|---|
| F899-1 screen rows by range | 1 | sidecars `vt`, `alacritty`; plugins `terminal`, `term` | `screen.read {from, count}` returns no rows outside the viewport | the call returns the requested rows in both sidecars and both plugins | not started |
| F899-2 conversation read | 1 | sidecars or plugins (method B) | a fixture session file yields no messages in order | the messages are returned in order with the file name | not started |
| F899-3 process list | 2 | sidecar `alacritty` (macOS first) | a shell with a background job does not list it by name | `term.process.list` names the foreground and background job with their sources | not started |
| F899-4 terminal state | 2 | sidecars, adapters | a fixture prompt, running command and finished command produce no state events | each transition emits one event with its source and sequence number | not started |
| F899-5 key adapters and dialogs | 4 | adapters; supervisor | a fixture TUI with a dialog does not respond to the declared key | the TUI key or the fallback is sent, and the path is logged | not started |
| F899-6 destructive command guard | 5 | sidecar layer | a destructive command fixture is not refused | the refusal is in the event log with its rule, and unparseable input is refused | not started |
| F899-7 messaging | 3 | sidecar, adapters, sok MCP server | a file created in a registered folder produces no event | one event per change is delivered to the registered terminal through the chosen channel | not started |

## Part 7: Decisions

- D1 (open, Part 1): byte bound of the transcript log.
- D2 (open, Part 1): whether `history.find` searches cell style.
- D3 (decided, Part 3): file events from the terminal sidecar are the only messaging path.
- D4 (decided, Part 3): input injection is the baseline; MCP tools are the better channel where offered.
- D5 (decided, Part 4): supervised dialog handling with destructive, non-destructive and unclear rules.
- D6 (decided, Part 4): TUI keys by adapter; the sok fallback when the TUI has none.
- D7 (decided, Part 5): destructive command check in the sidecar layer, fail-closed, with an event per decision.
