# Terminal read

[한국어](terminal-read.ko.md)

This document defines how a caller, such as an agent, reads the text of a terminal: the visible text, the rows above the viewport, and the text of a full-screen program. It applies to both terminal pairs: the plugin `terminal` with the sidecar `vt`, and the plugin `term` with the sidecar `alacritty`. `<plugin>` names the plugin of the pair. Each sidecar implements the sidecar part and each plugin the plugin part in its own repository; the shared cases of `docs/spec/cases/terminal-read/` hold the inputs and the expected reads, and each repository runs a copy of them through its real engine or page.

Each read mode is one declared command with the same name in both plugins. A caller takes the first mode that holds the text that it needs; the program scroll comes last, because it writes input to the program.

| Mode | Command | Use it for | It cannot see |
| --- | --- | --- | --- |
| Visible | `<plugin>.screen.read` | the rows on the screen now | rows above the viewport |
| Kept rows | `<plugin>.screen.rows {screen, from, count}` | the primary history of a shell or of a program that draws inline, and the rows that a full-screen program scrolled off the alternate screen; no input is delivered to the program | rows that the program never drew |
| Program scroll | `<plugin>.screen.scroll.read {by}` | rows that a full-screen program never drew, as a last resort; it controls the program and scrolls it back | the absolute position inside the content of the program |

No terminal command reads a file or the transcript of an agent: an agent reads a file itself, and the transcript of an agent program through the conversation read ([agent transcript](#agent-transcript)). The state of the session reports what a caller needs to choose a mode ([session state](#session-state)).

## Visible text

`<plugin>.screen.read` returns the rows of the viewport of the active screen: the rows that the person sees. On the primary screen the rows follow the viewport offset of `<plugin>.scrollback.set`; on the alternate screen of a full-screen program they are the rows that the program drew. The sidecar answers it with `screen.read` without parameters ([screen message](persistent-services.md#screen-message)).

## Primary rows

`<plugin>.screen.rows {screen: "primary", from, count}` returns `count` rows (1 to 200) of the primary screen and its history, without moving the viewport, through the sidecar request `screen.read {screen: "primary", from, count}` ([screen message](persistent-services.md#screen-message)). Row 0 is the first row that entered the history; the oldest kept row is the number of rows dropped past the history limit (`dropped`), and the viewport at offset 0 starts `history` rows after it. The rows of a program that draws inline on the primary screen, such as an agent program that does not enter the alternate screen, are primary rows and are read on this path.

The range names primary rows also while the alternate screen is active: the primary screen and its history stay readable under a full-screen program. The `scrollback` member of the state of the session carries `offset`, `history` and `dropped`, so that a caller computes a range without a refused request; a range outside the kept rows is refused with `invalidParams` and a reason that names the kept range.

## Alternate rows

A full-screen program draws on the alternate screen, which has no history in a standard terminal. The sidecar keeps the rows that leave the top of the alternate screen by a scroll, so that a caller reads them without input to the program. The precedent is the setting of iTerm2 that saves lines to the scrollback in the alternate screen mode; this contract keeps the rows apart from the primary history, so that the primary rows and their numbers do not change.

- Kept rows: a row is kept when a scroll up moves it off the top of the alternate screen: a line feed, `IND` or `NEL` at the bottom margin, or `CSI n S`, while the top margin of the scroll region is the first row of the screen and no left or right margin is set. A scroll of a region whose top is below the first row keeps nothing, because the row stays inside the screen of the program. A repaint that writes the rows again without a scroll keeps nothing, because no row left the screen.
- Read: `<plugin>.screen.rows {from, count, screen: "alternate"}` sends `screen.read {from, count, screen: "alternate"}`. Row 0 is the first row that the sidecar kept since the alternate screen was entered, and the oldest kept row is the number of kept rows that the bound dropped; the kept rows come first and the rows of the alternate screen follow them. The reply is `screen.rows` with `screen`, `from`, `count` and `rows`. `screen` is required and is `primary` or `alternate`; a request without it or with another value is refused with `invalidParams`, in the plugin before any request and in the sidecar.
- Bound: the sidecar keeps at most as many rows as the history limit of the session. A row that the bound drops is counted in `dropped` of the `alternate` member of the state of the session (`{history, dropped}`), and the sidecar writes one record of each drop of a scroll with the number of rows that it dropped, as a bounded buffer that sheds data is reported ([AGENTS](../../AGENTS.md#implementation)).
- Life: the kept rows stay after the program leaves the alternate screen, so that a caller reads them after the program ended; they are removed when the alternate screen is entered again and when the session ends.

## Program scroll

A row that the program never drew is held only by the program, and no terminal can read it. Only then the caller controls the program: `<plugin>.screen.scroll.read {by}` scrolls the program by `by` lines (positive toward older content), reads the screen after the program has drawn it, and scrolls back. The offset is relative to the position of the program when the read starts, because the terminal cannot know the absolute position inside the content of a program.

- Route: the scroll follows the wheel rules of the sidecar ([wheel input](#wheel-input)) without Shift: a mouse report of the wheel when the program enabled mouse tracking, the cursor keys `Up` and `Down` when the alternate screen is active and the alternate scroll mode applies, and the viewport of the primary screen otherwise.
- Steps: the command reads the screen, sends the scroll, waits until the program has drawn it, reads the screen, sends the scroll of `-by`, waits until the program has drawn it, reads the screen and compares it with the first read.
- Reply: `{route, changed, text, restored, settledBy, quiet, refreshRate}`: `route` is `program`, `alternate_scroll` or `viewport`; `changed` is whether the screen after the scroll differs from the first read, so that a caller sees the end of the content; `text` is the plain text of each row after the scroll; `restored` is whether the last read equals the first read; `settledBy` is `{scroll, restore}`, the event that ended the wait of each step, `sync`, `quiet` or `viewport` ([draw of the program scroll](#draw-of-the-program-scroll)); `quiet` is the quiet interval in display frames that the read used; `refreshRate` is the refresh rate of the last tick of the read, or `null` when the read received no tick. When `restored` is `false`, the reply also holds `first`, the first row of the first and of the last read as `{before, after}`, and the plugin shows the error through its error display path, because the program is not where it was; the command does not scroll again by a guessed difference.
- Sidecar request: the plugin sends `screen.scroll.read {by, quiet}`, where `by` is an integer from -1000 to 1000 other than 0 and `quiet` is the quiet interval of its setting `scrollReadQuiet`, an integer from 1 to 120 display frames with the default 6; the sidecar answers with the event `screen.scroll` and the members of the reply, or with `invalidParams` and a reason for another value. A read while another read of the surface runs is refused with `invalidParams` and the reason `a scroll read is running`. A read of a surface without an attached image region is refused with `invalidParams` and the reason `a scroll read needs the display frames of an image region`, because the display frames are delivered to the sidecar only as ticks of that region. A read that input of the person ends is answered with the error `scrollReadInterrupted` and a reason that names the input (`input`, `paste`, `mouse`, `scroll` or `viewport`); a read that ends because the host refused its frame request, the image region was detached or the session ended is answered with the error `scrollReadFailed` and a reason that names the cause. The plugin rejects the command with that error.
- Input of the person: a read is refused when the person sends input to that session between its first and its last step, judged by the order of the inputs of the session: the input of the person runs, and the read ends with an error that names the input.
- Draw: the wait of each step ends by the rule of [draw of the program scroll](#draw-of-the-program-scroll); a timer does not end it.

## Session state

The state of the session (`<plugin>.session`) reports what a caller needs for the choice of a mode, in four members that the sidecar sends and the plugin keeps as it receives them:

| Member | Form |
| --- | --- |
| `scrollback` | `{offset, history, dropped}`: the viewport offset and the kept history rows of the active screen, and the number of rows that the history limit dropped from the primary history, which is the number of the oldest kept primary row |
| `alternate` | `{active, history, dropped}`: whether the alternate screen is active, the number of rows kept above the alternate screen, and the number of kept rows that the bound dropped, which is the number of the oldest kept alternate row |
| `foreground` | `{group, pid, command, arguments, cwd, started}`: the foreground program of the terminal of the session as a [process](process-list.md#process) of the process list, with its group, the path of its executable, its arguments, its working directory and its start time; `null` when the foreground process group of the terminal has no member that has not ended ([foreground program](process-list.md#foreground-program)) |
| `background` | The background jobs of the terminal of the session ([background jobs](process-list.md#background-jobs)), an array that is empty when the session has none |

- Source: the sidecar carries `scrollback` and `alternate` in each `view` event, so they follow the screen that the person sees. It reads `foreground` and `background` from the terminal of the session with one read of the process list after each output of the session, the first of which is the prompt of its shell, and sends the event `{event: "processes", foreground, background}` when the list differs from the last list that it sent; a failed read sets both members to `null` ([process list](process-list.md#session-state)).
- A refused read: when the system refuses a read of the process of the foreground program, such as the arguments or the working directory of a process of another user, the member is `{group, pid, command: null, arguments: null, cwd: null, started: null, error}`, and `error` names the read and the reason; no value is guessed.
- Limit: a program that takes the foreground and writes no output is named at the next output of the session. No event of the system reports a change of the foreground process group, and a full-screen program draws, so its output names it; `alternate.active` and not `foreground` decides whether the kept alternate rows or the program scroll apply.

## Agent transcript

An agent program keeps its own transcript of the conversation. `sok conversation read` reads it from the session file on disk ([agent conversation](agent-conversation.md)); a caller that needs the conversation of an agent takes that path, not the screen.

## Wheel input

The sidecars route a wheel operation `scroll {lines, col, row, shift}` in this order: a mouse report when the program enabled mouse reporting and Shift is not held, the cursor keys of the alternate scroll when the alternate screen is active and the alternate scroll mode (DECSET 1007) is set, and the viewport of the primary screen otherwise. The page of each plugin sends the wheel of the person through this operation, and the program scroll sends the same operation.

The mouse reports 1000 (presses and releases), 1002 (also the motion while a button is held) and 1003 (also every motion) are one mode: setting one replaces the others, so a program that sets 1000, 1002 and 1003 in turn reports by 1003, and the modes of the engine hold only that one. A mouse report of the wheel is the button 64 toward older content or 65 toward newer content, once per line, at the cell of the pointer, in the SGR encoding when DECSET 1006 is set and in the default encoding otherwise. The cursor keys of the alternate scroll follow the application cursor mode (DECSET 1), and the alternate scroll mode is set when a session starts. `docs/spec/cases/terminal-read/wheel-routes.json` holds the cases of the routes: the output of a program, the modes after it and the exact text that the session receives for each scroll. Each sidecar copies the file into its fixtures and runs each case through its real engine and its wheel route.

## Draw of the program scroll

No terminal event reports that a program finished a redraw, so the wait of the scroll step and of the restore step ends by this rule, which counts time in display frames of the window and not in milliseconds, so that it holds at every refresh rate.

- Ticks: while a step waits, the sidecar sends the frame request `{"image":{"want":{"name","generation","purpose":"read"}}}` of its region at each tick that answers it, so it receives one tick at each display frame of the screen of the window, also while the window is occluded or the region does not draw ([copy path frames](native-surfaces.md#copy-path-frames)). A refusal of the request, such as `noScreen` of a window on no screen, ends the read with an error that names the refusal and its window.
- Synchronized output: a program that uses synchronized output (DECSET and DECRST 2026) ends a frame with the reset. A step ends with `sync` at the first tick after a reset of an update that opened after the input of the step, when no output came between that reset and the tick and no update is open; output in that frame, such as a second update of the same redraw, waits for the next tick.
- Quiet interval: a step also ends with `quiet` at the tick at which `quiet` ticks came after the last output that followed the input of the step, or after the input when no output followed it. The quiet path holds whether or not the program uses synchronized output, so an update that opens and never closes ends by it; the reset only ends the wait earlier. No output in the scroll step gives `changed: false`.
- Viewport: on the route `viewport` the engine applies the scroll at once and no program draws, so each step ends at once with `viewport`.
- No proof: `quiet` does not prove that the program finished. A program that answers after the interval, such as one that loads its content from a disk or a network, gives a reply that names a screen before its answer; the reply carries `settledBy` and `quiet`, so that a caller reads again or raises the setting. A larger interval costs only time: two waits of `quiet` display frames, during which input of the person refuses the read.
- Default: `quiet` is 6 display frames. Ticks come at distinct display frames, one after each request, so `quiet` ticks after an output span at least `quiet - 1` full frame periods: 5 periods are 41.7 ms at 120 Hz and 83 ms at 60 Hz. The tracked measurement of vt S211 (`make measure-program-redraw` of the sidecar vt) ran `less` and `vim` on a numbered file of 2000 lines and `htop` in a real PTY of 40 by 120 cells and sent 20 scrolls of 50 cursor keys each, without load and with one busy process for each of 11 processors, on a screen of 120 Hz. The largest time from the keys to the first output and the largest gap between the outputs of one redraw were 0.1 and 0.1 ms for `less` without load and 3.7 and 3.4 ms with load, 1.1 and 0.3 ms and 3.4 and 0.3 ms for `vim`, and 2.1 and 0.6 ms and 4.5 and 5.4 ms for `htop`. The run of vt S213, after the measurement waited for the output with `poll` in place of a reading thread, found 0.9 and 0.3 ms and 6.9 and 11.8 ms for `less`, 8.9 and 0.3 ms and 8.3 and 0.3 ms for `vim`, and 2.7 and 1.7 ms and 7.4 and 7.6 ms for `htop`, at most 2 display frames at 120 Hz. The default is more than three times the largest measured time, 11.8 ms, at 120 Hz.

An adversarial review argued against the rule. Its objections and their answers:

- A reset of the first of two updates of one redraw ends the wait before the second (accepted): a step ends with `sync` only at a tick with no output after the reset, so a second update within the frame continues the wait.
- An update that opens and never closes ends no wait (accepted): the quiet path holds in every step, and the engine ends an update that is not closed at its bound.
- A reset of an update that started before the input ends the wait at once (accepted): only a reset of an update that opened after the input of the step counts.
- The two steps of a read can end by different events (accepted): `settledBy` names the event of each step.
- A slow program, such as one that loads from a disk, gives a screen before its answer (accepted as a limit): `settledBy` and `quiet` are in the reply, and the PTY tests of the sidecars cover a program that writes after the interval.
- The restore compares with a read that is already stale (rejected): the first read is the screen before the scroll input, not a read after a wait.
- The measurement covers only the cursor keys and three programs (rejected): a program redraws by the same code after a key and after a wheel report, and the reply states the limit of the quiet path; the observation bound of the measurement is its window and not a judgment of the rule.
- Ticks can bunch, so that `quiet` ticks span less time (rejected): the sidecar sends the next request only after a tick, and the host answers it at the next display frame, so two ticks never share a frame; a slower or skipped frame only lengthens the wait.
- The refresh rate changes the cost (accepted): the reply carries `refreshRate` of the last tick.
