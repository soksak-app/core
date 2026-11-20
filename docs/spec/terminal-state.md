# Terminal state

[한국어](terminal-state.ko.md)

This document defines the state of a terminal that the terminal sidecars publish and the terminal plugins show. It applies to both terminal pairs: the plugin `terminal` with the sidecar `vt`, and the plugin `term` with the sidecar `alacritty`. Each sidecar and each plugin implements the same contract, and each runs the shared cases of [cases](#shared-cases) against its own implementation. Implementation and verification are tracked in [features](../features.md); items listed in [held states](#held-states) are not implemented until their condition is met.

## States

A terminal state is one of the following names. The sidecar publishes a state when it changes, as an event; a caller does not poll it ([AGENTS](../../AGENTS.md#implementation)).

| State | Meaning | Source |
| --- | --- | --- |
| `idle` | The shell is at its prompt: the last mark is the prompt start `A`, the explicit prompt start `P` or the prompt end `B` of OSC 133 | `osc133` |
| `running` | A command runs: the last mark is the command start `C` | `osc133` |
| `exited` | The command finished: the last mark is the command finished mark `D`, with its exit code | `osc133` |
| `waiting` | A program waits for input from the person | held ([held states](#held-states)) |
| `agent-busy` | An agent in the terminal works on a turn | held ([held states](#held-states)) |
| `agent-waiting` | An agent in the terminal waits for the person | held ([held states](#held-states)) |

A session whose shell sends no OSC 133 mark has no state: the sidecar does not infer a state from output, and the state stays `null`. The shell integration of each sidecar sends the marks for zsh and bash.

## Marks

The sidecar reads the OSC 133 marks from the output of the session (`ESC ] 133 ; <mark> [; <parameter>]… BEL` or `ST`). The marks `A`, `P` and `B` give `idle`, `C` gives `running` and `D` gives `exited`. `P` starts one line of a prompt explicitly; its parameter `k` names the kind of the line: `i` the first line of a prompt, which is the kind when `k` is absent, `c` or `s` a continuation line, and `r` a right prompt. A `P` with another kind is a malformed mark. The first parameter of `D` is the exit code of the command when it is present and is not a named parameter of the form `<name>=<value>`; it is a decimal integer from 0 to 255, the range of a shell exit status. A `D` without that parameter gives `exited` with the exit code `null`. A `D` whose first parameter is neither a named parameter nor a decimal integer from 0 to 255 is a malformed mark: the engine rejects it as it rejects every malformed sequence, with `sequence.rejected`, and the state does not change.

A mark changes the state only when it gives a state that differs from the current state; a repeated mark, such as `B` after `A`, gives no change.

## Prompt region

The engine of each sidecar keeps the marks of the primary screen as facts of rows, so that a resize keeps the prompt that the shell draws again after `SIGWINCH`. The order of the resize is that of kitty: the engine takes the prompt out of the reflow before it reflows and puts it back after.

- Recorded rows: `A` first moves the cursor to the start of the next line when it is not at column 0, removes every recorded row and records the cursor row. A `P` of kind `i`, `c` or `s` records the cursor row; a `P` of kind `r` records none. `C` and `D` remove every recorded row. A recorded row is an absolute row: the rows dropped past the history limit, plus the history rows, plus the screen row, so the number of a row stays the same while output scrolls it into the history and while the history drops its oldest rows. An ED 2 at a prompt replaces the recorded rows with the top row, because the shell draws its prompt there again without a new `A`.
- Redraw: the parameter `redraw` of a mark sets the region that the shell draws again: `1` the whole prompt, `last` only the logical line that holds the cursor (readline draws again only the last line of its prompt), and `0` no region. `A` without `redraw` sets `1`, so each `A` ends a `redraw=0`; `P` and `B` without `redraw` keep the current value. Another value is a malformed mark.
- Region: at a prompt (the last mark is `A`, `P` or `B`) with `redraw` other than `0`, the region is the rows from the nearest recorded row at or above the cursor through the bottom of the screen; with `redraw=last` it starts at the first row of the logical line of the cursor when that row lies below the recorded row. There is no region after `C` or `D`, with `redraw=0`, without a recorded row and on the alternate screen.
- Resize with a region: the engine copies the rows of the region; it clears them, so that the reflow keeps each cleared row from the first row of the region through the cursor row as one row that continues no row, and the rows below the cursor empty; it moves the cursor to column 0 for the reflow; it reflows the screen and the history to the new size; then it puts the copies back from the row that lies as many rows above the cursor as the first row of the region lay above it before the resize, cut at the new width, and puts the cursor back at its column: the column after the last cell that the program wrote on the cursor row, which is the cursor column, plus one when the next character waits for the next row, at most the last column, and the next character waits for the next row when that column lies at or past the new width. The cursor stays where the program left it, as kitty keeps its column and Ghostty clamps it to the new width; a screen that is presented between the resize and the redraw of the shell, which the surface presents at once, otherwise shows the prompt with the cursor on its first cell. A wide character that the cut splits and the spacer of a wrapped wide character stand empty, and no row that is put back continues another. The recorded rows of the region move with their copies; the recorded rows above the region are removed, because the reflow changed their rows. zsh and readline move the cursor up by the rows that they drew above it and draw again from there, which is the first row that is put back, so the screen that is presented before the shell draws again shows the prompt of the previous width instead of empty rows, and the shell writes over it.
- Resize without a region: the engine reflows and clears nothing, and removes every recorded row.
- Errors: when the nearest recorded row lies above the screen, in the history or dropped past it, the engine reports `terminal resize: the prompt start row <row> lies above the screen`, with the screen row, and resizes without a region. When rows are recorded and none lies at or above the cursor, it reports `terminal resize: no prompt row is recorded at or above the cursor row` and resizes without a region. When the first row of the region lies above the screen after the reflow, because the screen has fewer rows than the region, the copies stand from the top row, where the shell starts to draw because it cannot move above it, and the engine reports `terminal resize: the prompt region starts at the screen row <row> after the reflow, above the screen`.
- A resize to the current dimensions changes nothing, because the PTY sends no `SIGWINCH` for it. The engine does not delay a resize or the `SIGWINCH` that follows it.

The shell integration of each sidecar sends the marks that the region needs: zsh sends `A` from its `precmd` hook and adds `P;k=i` at the start and `B` at the end of `PS1`, and `P;k=s` at the start and `B` at the end of `PS2`, so that each prompt that zsh draws again records its row; bash sends `A;redraw=last` before each prompt and adds `P;k=s` after each line break of `PS1`, so that the region is the last line of the prompt that readline draws again.

## Change event

Each change of the state is one surface event of the sidecar, `{event: "shell.state", from, to, source, sequence, exit}`:

- `from` is the state before the change, or `null` for the first change of the session.
- `to` is the new state.
- `source` is the signal that decided the state; for the marks it is `osc133`.
- `sequence` is the number of the change in the session: 1 for the first change, one more for each later change. A new session of the surface starts at 1 again.
- `exit` is the exit code of `exited`, an integer or `null` when the mark gave none; it is `null` for every other state.

The sidecar also writes each change to its event log as `sidecar.<sidecar>.shell.state` (`sidecar.vt.shell.state`, `sidecar.alacritty.shell.state`) at the level `info` in the class `lifecycle`, with the members `from`, `to`, `source`, `sequence` and `exit`. The sidecar follows the marks of every output, also while the image region of the surface is not drawing, so the state stays current; the surface event is sent under the same rule as the other vendor events of the surface.

## State read

The operation `shell.state.read` returns the current state of the session of the surface. Its reply is the surface event `{event: "shell.state.current", state, source, sequence, exit}`: `state` is the current state or `null` before the first change, `source` is the source of that state or `null`, `sequence` is the `sequence` of the last change or 0 before the first, and `exit` is as in the change event. The reply echoes the `cids` of the request. A read without an open session fails with the error that the sidecar returns for any session operation without a session, and it returns no state. A read changes nothing, so a repeated read returns the same reply until the next change ([AGENTS](../../AGENTS.md#implementation)).

A page reads the state after it opens or attaches to a session, because a persistent session keeps its state while no page shows it ([persistent services](persistent-services.md)), and then follows the change events. The reply and the events of a surface arrive on one ordered channel, so the page applies each in the order of arrival.

## Plugin status

Each terminal plugin declares the status `<plugin>.state` (`terminal.state`, `term.state`) for each terminal surface. Its value is `{state, source, sequence, exit}` with the meaning of the [state read](#state-read): `{state: null, source: null, sequence: 0, exit: null}` before the reply of the first read, the reply of the read, and then the members `to`, `source`, `sequence` and `exit` of each change event. A change event or a read reply that is not of this form is a sidecar error: the page reports it through the error path of the session and keeps the previous value. A new session of the surface starts again from the value before the first read.

## Activity

Each terminal plugin also declares the status `<plugin>.activity` (`terminal.activity`, `term.activity`) for each terminal surface, and declares it for core with `activity: true`, so that core aggregates the activity of the tab, its cards, its space and its project (core F982). Its value is a core activity level or `null` for no activity. The plugin decides the level, because it knows the state and the exit code; core only aggregates the levels. The value follows each value of `<plugin>.state`:

| `state` of `<plugin>.state` | `<plugin>.activity` |
| --- | --- |
| `null`, before the first change | `null` |
| `idle` | `idle` |
| `running` | `running` |
| `exited` with an `exit` other than 0 | `failed` |
| `exited` with `exit` 0, or with `exit` `null` | `null` |
| `waiting`, `agent-waiting` (held) | `attention` |
| `agent-busy` (held) | `running` |

An `exited` state whose mark gives no exit code reports no failure, because no code shows one. The rows of the held states apply when those states are defined ([held states](#held-states)). The status changes only when its value changes, and a new session of the surface starts again at `null`.

## Held states

- `waiting`: the plan defines it as output silence for a window together with a screen that shows a prompt or a question ([terminal plan, 2.3](../plans/terminal-plan.md#23-states)). No length of the window is measured and no pattern of a prompt or a question is declared, and a fixed silence window is a timer where the marks and the agent signals are the event sources. Held until the window and the patterns are decided in this document with their evidence.
- `agent-busy` and `agent-waiting`: they come from the hook events of the agent ([terminal plan, 2.5](../plans/terminal-plan.md#25-decision-for-the-state-rule)). The payload fields of the Codex hook events (plan item V4) and of the Claude Code `Notification` event (plan item V5) are not recorded from a real session, and the path by which a hook event reaches the sidecar of its terminal is not defined. Held until a payload of each event is recorded from a real session and this document defines the path and the fields.

## Shared cases

`docs/spec/cases/terminal-state/osc133.json` holds the cases of the marks: each case has the output of the session, the change events that the output gives in order, the state read after the output, and whether the output holds a rejected mark. A sidecar copies the file into its fixtures and runs each case through its real engine and its state tracker; a plugin copies it and applies the change events and the read reply of each case to its page, and compares the value of its status. A change of the contract replaces the copies.

`docs/spec/cases/terminal-state/prompt-region.json` holds the cases of the [prompt region](#prompt-region): each case has the size of the screen and steps, and each step is an output that the engine reads or a resize, with the rows of the screen (each row without its trailing blanks), the rows of the history from the oldest, the cursor and the errors that the engine reports after the step, when the step states them; a step that states no errors expects none. Each sidecar copies the file into its fixtures and runs each case through its real engine.
