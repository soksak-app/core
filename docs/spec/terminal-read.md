# Terminal read

[한국어](terminal-read.ko.md)

This document defines how a caller, such as an agent, reads the text of a terminal: the visible text, the rows above the viewport, and the text of a full-screen program. It applies to both terminal pairs: the plugin `terminal` with the sidecar `vt`, and the plugin `term` with the sidecar `alacritty`. `<plugin>` names the plugin of the pair. Each sidecar implements the sidecar part and each plugin the plugin part in its own repository; the shared cases of `docs/spec/cases/terminal-read/` hold the inputs and the expected reads, and each repository runs a copy of them through its real engine or page.

Each read mode is one declared command with the same name in both plugins. A caller takes the first mode that holds the text that it needs; the program scroll comes last, because it writes input to the program.

| Mode | Command | Use it for | It cannot see |
| --- | --- | --- | --- |
| Visible | `<plugin>.screen.read` | the rows on the screen now | rows above the viewport |
| Kept rows | `<plugin>.screen.rows {screen, from, count}` | the primary history of a shell or of a program that draws inline, and the rows that a full-screen program scrolled off the alternate screen; no input reaches the program | rows that the program never drew |
| Program scroll | `<plugin>.screen.scroll.read {by}` | rows that a full-screen program never drew, as a last resort; it drives the program and scrolls it back | the absolute position inside the content of the program |

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

A row that the program never drew is held only by the program, and no terminal can read it. Only then the caller drives the program: `<plugin>.screen.scroll.read {by}` scrolls the program by `by` lines (positive toward older content), reads the screen after the program has drawn it, and scrolls back. The offset is relative to the position of the program when the read starts, because the terminal cannot know the absolute position inside the content of a program.

- Route: the scroll follows the wheel rules of the sidecar ([wheel input](#wheel-input)) without Shift: a mouse report of the wheel when the program enabled mouse tracking, the cursor keys `Up` and `Down` when the alternate screen is active and the alternate scroll mode applies, and the viewport of the primary screen otherwise.
- Steps: the command reads the screen, sends the scroll, waits until the program has drawn it, reads the screen, sends the scroll of `-by`, waits until the program has drawn it, reads the screen and compares it with the first read.
- Reply: `{route, changed, text, restored}`: `route` is `program`, `alternate_scroll` or `viewport`; `changed` is whether the screen after the scroll differs from the first read, so that a caller sees the end of the content; `text` is the plain text of each row after the scroll; `restored` is whether the last read equals the first read. When it is `false`, the reply also holds the first row of the first and of the last read, and the plugin shows the error through its error display path, because the program is not where it was; the command does not scroll again by a guessed difference.
- Input of the person: a read is refused when the person sends input to that session between its first and its last step, judged by the order of the inputs of the session: the input of the person runs, and the read ends with an error that names the input.
- Draw: the event that ends the wait for the draw is an open decision ([open decisions](#open-decisions)); a timer does not end it.

## Session state

The state of the session (`<plugin>.session`) reports what a caller needs for the choice of a mode, in three members that the sidecar sends and the plugin keeps as it receives them:

| Member | Form |
| --- | --- |
| `scrollback` | `{offset, history, dropped}`: the viewport offset and the kept history rows of the active screen, and the number of rows that the history limit dropped from the primary history, which is the number of the oldest kept primary row |
| `alternate` | `{active, history, dropped}`: whether the alternate screen is active, the number of rows kept above the alternate screen, and the number of kept rows that the bound dropped, which is the number of the oldest kept alternate row |
| `foreground` | `{pid, command, cwd}`: the leader of the foreground process group of the terminal of the session, the path of its executable and its working directory; `null` when the terminal has no foreground process group |

- Source: the sidecar carries `scrollback` and `alternate` in each `view` event, so they follow the screen that the person sees. It reads `foreground` from the terminal of the session (the foreground process group of the PTY, and the path and the working directory of its leader) after each output of the session, the first of which is the prompt of its shell, and sends the event `{event: "foreground", foreground}` when the value differs from the last value that it sent.
- A refused read: when the system refuses to name the executable or the working directory of the leader, such as for a process of another user, the member is `{pid, command: null, cwd: null, error}`, and `error` names the read and the reason; no value is guessed.
- Limit: a program that takes the foreground and writes no output is named at the next output of the session. No event of the system reports a change of the foreground process group, and a full-screen program draws, so its output names it; `alternate.active` and not `foreground` decides whether the kept alternate rows or the program scroll apply.

## Agent transcript

An agent program keeps its own transcript of the conversation. `sok conversation read` reads it from the session file on disk ([agent conversation](agent-conversation.md)); a caller that needs the conversation of an agent takes that path, not the screen.

## Wheel input

The sidecars route a wheel operation `scroll {lines, col, row, shift}` in this order: a mouse report when the program enabled mouse reporting and Shift is not held, the cursor keys of the alternate scroll when the alternate screen is active and the alternate scroll mode (DECSET 1007) is set, and the viewport of the primary screen otherwise. The page of each plugin sends the wheel of the person through this operation, and the program scroll sends the same operation.

## Open decisions

- Draw of the program scroll. Proposed rule: (1) a program that uses synchronized output (DECSET and DECRST 2026) ends its frame with the reset, so the first reset after the scroll input ends the wait, and the reply states `settledBy: "sync"`; the sidecar publishes a session event at the end of each synchronized frame. (2) For a program without synchronized output no event reports the end of a redraw, so then, and only then, the wait ends after a quiet interval with no output of the session after the last output that followed the input, counted in display frames of the window and not in milliseconds, so that the rule holds at every refresh rate; the reply states `settledBy: "quiet"` and the interval, which is a declared setting with its default in frames. (3) No output within the interval after the input gives `changed: false` with the screen unchanged. (4) The same rule ends the wait of the restore step. Reason: the reset of 2026 is the only event that a program sends at the end of a frame, and the frame count is the measure that does not assume a refresh rate.
  - Objection, answered: the display frames of a window reach a sidecar only as the ticks that answer its frame requests ([image regions](native-surfaces.md#image-regions)), and an occluded window or a region that does not draw delivers none. Answer: a frame request for a read, not for a draw, carries `purpose: "read"`, and the host answers it at the display frames of the screen of the window also while the window is occluded or the region does not draw, because the display link of a screen runs regardless of occlusion; a window on no screen refuses the read with an error that names the window. The session owns no clock.
  - Objection, answered: the quiet interval judges a program by the absence of output, so a program that answers after the interval, such as one that loads its content from a disk or a network, gives a reply that names a screen before its answer. Answer: `settledBy: "quiet"` does not prove that the program finished; the reply carries the interval, so that a caller reads again. The default interval is measured: the largest gap between the output bursts of one redraw of `less`, `vim` and `htop` under load, from a tracked measurement whose result and evidence this section states.
  - Remaining: the measurement of the default interval and a review round of the rule without objection.
