# Terminal state

[한국어](terminal-state.ko.md)

This document defines the state of a terminal that the terminal sidecars publish and the terminal plugins show. It applies to both terminal pairs: the plugin `terminal` with the sidecar `vt`, and the plugin `term` with the sidecar `alacritty`. Each sidecar and each plugin implements the same contract, and each runs the shared cases of [cases](#shared-cases) against its own implementation. Implementation and verification are tracked in [features](../features.md).

## States

A terminal state is one of the following names. The sidecar publishes a state when it changes, as an event; a caller does not poll it ([AGENTS](../../AGENTS.md#implementation)).

| State | Meaning | Source |
| --- | --- | --- |
| `idle` | The shell is at its prompt: the last mark is the prompt start `A`, the explicit prompt start `P` or the prompt end `B` of OSC 133 | `osc133` |
| `running` | A command runs: the last mark is the command start `C` | `osc133` |
| `exited` | The command finished: the last mark is the command finished mark `D`, with its exit code | `osc133` |

What a program in the terminal does while it runs as one command is not a state of the marks: the program reports it itself ([program status](#program-status)).

A session whose shell sends no OSC 133 mark has no state: the sidecar does not infer a state from output, and the state stays `null`. The shell integration of each sidecar sends the marks for zsh and bash.

## Marks

The sidecar reads the OSC 133 marks from the output of the session (`ESC ] 133 ; <mark> [; <parameter>]… BEL` or `ST`). The marks `A`, `P` and `B` give `idle`, `C` gives `running` and `D` gives `exited`. `P` starts one line of a prompt explicitly; its parameter `k` names the kind of the line: `i` the first line of a prompt, which is the kind when `k` is absent, `c` or `s` a continuation line, and `r` a right prompt. A `P` with another kind is a malformed mark. The first parameter of `D` is the exit code of the command when it is present and is not a named parameter of the form `<name>=<value>`; it is a decimal integer from 0 to 255, the range of a shell exit status. A `D` without that parameter gives `exited` with the exit code `null`. A `D` whose first parameter is neither a named parameter nor a decimal integer from 0 to 255 is a malformed mark: the engine rejects it as it rejects every malformed sequence, with `sequence.rejected`, and the state does not change.

A mark changes the state only when it gives a state that differs from the current state; a repeated mark, such as `B` after `A`, gives no change.

## Prompt region

The engine of each sidecar keeps the marks of the primary screen as facts of rows, so that a resize keeps the prompt that the shell draws again after `SIGWINCH`. The order of the resize is that of kitty: the engine takes the prompt out of the reflow before it reflows and puts it back after.

- Recorded rows: `A` first moves the cursor to the start of the next line when it is not at column 0, removes every recorded row and records the cursor row. A `P` of kind `i`, `c` or `s` records the cursor row; a `P` of kind `r` records none. `C` and `D` remove every recorded row. A recorded row is an absolute row: the rows dropped past the history limit, plus the history rows, plus the screen row, so the number of a row stays the same while output scrolls it into the history and while the history drops its oldest rows. An ED 2 at a prompt replaces the recorded rows with the top row, because the shell draws its prompt there again without a new `A`.
- Redraw: the parameter `redraw` of a mark sets the region that the shell draws again: `1` the whole prompt, `last` only the logical line that holds the cursor (readline draws again only the last line of its prompt), and `0` no region. `A` without `redraw` sets `1`, so each `A` ends a `redraw=0`; `P` and `B` without `redraw` keep the current value. Another value is a malformed mark.
- Region: at a prompt (the last mark is `A`, `P` or `B`) with `redraw` other than `0`, the region is the rows from the nearest recorded row at or above the cursor through the bottom of the screen; with `redraw=last` it starts at the first row of the logical line of the cursor when that row lies below the recorded row. There is no region after `C` or `D`, with `redraw=0`, without a recorded row and on the alternate screen.
- Resize with a region: the engine copies the rows of the region; it clears them, so that the reflow keeps each cleared row from the first row of the region through the cursor row as one row that continues no row, and the rows below the cursor empty; it moves the cursor to column 0; it reflows the screen and the history to the new size; then it puts the copies back from the row that lies as many rows above the cursor as the first row of the region lay above it before the resize, cut at the new width. A wide character that the cut splits and the spacer of a wrapped wide character stand empty, and no row that is put back continues another. The recorded rows of the region move with their copies; the recorded rows above the region are removed, because the reflow changed their rows. zsh and readline move the cursor up by the rows that they drew above it and draw again from there, which is the first row that is put back, so the screen that is presented before the shell draws again shows the prompt of the previous width instead of empty rows, and the shell writes over it.
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
- `exit` is the exit code of the last finished command, an integer or `null` when its mark gave none. It is the code of `exited` and of an `idle` that follows that `exited` before the next `running`, because the failure of a command lasts until the next command starts ([activity](#activity)) and a page that attaches later reads it from the state; it is `null` for `running` and for an `idle` that no `exited` precedes.

The sidecar also writes each change to its event log as `sidecar.<sidecar>.shell.state` (`sidecar.vt.shell.state`, `sidecar.alacritty.shell.state`) at the level `info` in the class `lifecycle`, with the members `from`, `to`, `source`, `sequence` and `exit`. The sidecar follows the marks of every output, also while the image region of the surface is not drawing, so the state stays current; the surface event is sent under the same rule as the other vendor events of the surface.

## State read

The operation `shell.state.read` returns the current state of the session of the surface. Its reply is the surface event `{event: "shell.state.current", state, source, sequence, exit}`: `state` is the current state or `null` before the first change, `source` is the source of that state or `null`, `sequence` is the `sequence` of the last change or 0 before the first, and `exit` is as in the change event. The reply echoes the `cids` of the request. A read without an open session fails with the error that the sidecar returns for any session operation without a session, and it returns no state. A read changes nothing, so a repeated read returns the same reply until the next change ([AGENTS](../../AGENTS.md#implementation)).

A page reads the state after it opens or attaches to a session, because a persistent session keeps its state while no page shows it ([persistent services](persistent-services.md)), and then follows the change events. The surface sends no event while it has no image region, so the page reads the state again each time it configures the image region of the surface after a time without one, and when a change event has a `sequence` other than one more than the value that it holds; a reply whose `sequence` is lower than the value that it holds is a sidecar error, because the reply and the events share one ordered channel, and the page reports it through the error path of the session and keeps its value. The reply and the events of a surface arrive on one ordered channel, so the page applies each in the order of arrival.

## Plugin status

Each terminal plugin declares the status `<plugin>.state` (`terminal.state`, `term.state`) for each terminal surface. Its value is `{state, source, sequence, exit}` with the meaning of the [state read](#state-read): `{state: null, source: null, sequence: 0, exit: null}` before the reply of the first read, the reply of the read, and then the members `to`, `source`, `sequence` and `exit` of each change event. A change event or a read reply that is not of this form is a sidecar error: the page reports it through the error path of the session and keeps the previous value. A new session of the surface starts again from the value before the first read.

## Program status

A program that runs as one command, such as an agent, a build or a package manager, keeps the state of the marks at `running` for as long as it runs. What it does inside that command, working, resting at its own prompt, waiting for an approval or an answer, or failing, only the program knows, so the terminal takes it from what the program reports and from nothing else: the sidecar reads two declared signals of the output of the session and the input of the person, and it guesses nothing from the screen, the title, the output or its silence.

- **Report**: the Program Status Protocol (OSC 7501, revision 0.4 of 2026-10-10, `https://www.superlogical.com/rex/docs/build/program-status`), `ESC ] 7501 ; <key>=<value>[:<key>=<value>]… BEL` or `ST`. The sidecar keeps the records of the session as the protocol defines them ([records](#records)).
- **Notice**: a notification of the program, OSC 9 `ESC ] 9 ; <message>` other than the progress report `9;4`, OSC 777 `ESC ] 777 ; notify ; <title> ; <body>`, or a BEL byte outside a control string (the BEL that ends an OSC sequence is its terminator). A notice tells the person that the program called them; it states no state of the program and has no end that the program reports ([notice](#notice)).

A program that sends neither signal is unknown to the terminal: the activity of its terminal stays `running` while it runs, and that level states only that a command runs, not that the program works, because nothing states what the program does. In a session whose shell sends no OSC 133 mark, no mark ends a record, so a `working` or `blocked` record that the program leaves ends only at `clear`, at a full reset or at the end of the session.

### Records

The engine of each sidecar parses each report; the tracker of the session (`program_status.rs` of each sidecar core) keeps the records:

- Syntax: the pairs are separated by `:`, and a pair is split at its first `=` into its key and its value. A key is `[a-z]+` of at most 16 bytes, a value is `[A-Za-z0-9_.,+/=-]*`, and whitespace around a key and a value is removed. A pair of another form is a malformed pair: the engine reports it with `sequence.rejected` and applies the rest of the report. A key that the protocol does not define is ignored without a report, because the protocol requires it so that a later revision can add keys. A repeated key keeps its last value.
- `state` is `idle`, `working`, `blocked`, `done`, `error` or `clear`; a report without `state` or with another value is rejected whole. `kind` is `permission`, `question` or `auth` and is kept only with `blocked`; `progress` is one to three ASCII digits of a value from 0 to 100 and is kept only with `working` and `blocked`; `app` is `[A-Za-z0-9_.+-]{1,32}`. An invalid `kind`, `progress` or `app`, and a `kind` or `progress` with a state that does not take it, is reported with `sequence.rejected` and treated as absent, as the protocol states. `title` and `msg` are standard base64, with optional padding, of UTF-8 text without the control characters U+0000 to U+001F, U+007F and U+0080 to U+009F; an empty value is the empty text.
- Limits: a sequence of more than 4096 bytes from its `ESC` through its terminator, a `msg` of more than 2732 encoded or 2048 decoded bytes, a `title` of more than 256 encoded or 192 decoded bytes, base64 that does not decode, a decoded text that is not UTF-8 or holds a control character, and an `id` that is empty or is not one to eight segments of 1 to 32 bytes of `[A-Za-z0-9_.+-]` joined by `/` within 128 bytes reject the report whole: the engine reports `sequence.rejected` with the reason and applies nothing of it.
- `id` names the record; a report without `id` names the root record. Each report replaces its record whole and makes it the record updated most recently, also when the record does not change. A report whose `state` is `clear` creates no record and takes no key other than `id`, and another key of the protocol in it is reported with `sequence.rejected` and treated as absent, so the clear still applies unless a limit rejects the report whole: it removes the record that it names and every record below it (`build` holds `build/test`), and without `id` it removes every record. A record without `app` takes the `app` of its nearest ancestor among the records present at each event, and the root record is the ancestor of every record that has an `id`.
- The tracker keeps at most 256 records of a session and removes the record updated least recently when a report adds one more, as the protocol states for its limit; the removal is the log event `sidecar.<sidecar>.program.status.evicted` at `warn` with the removed `id`, and the change event shows it.
- The query `ESC ] 7501 ; ? <terminator>` is answered with `ESC ] 7501 ; ? <terminator>` with the terminator of the query, the only bytes that the protocol lets a terminal write back, and changes no record; the reply lists no `states` and `kinds`, because the terminal reads exactly the defaults of the protocol. A program that reports only after this answer reports to this terminal because of it. A program may send the query in one write with other queries and the primary device attributes request `CSI c`, and take the answer only when it arrives before the reply to `CSI c`, which ends its wait for the earlier queries: the engine answers the queries of an output in the order of their bytes, so the answer precedes that reply.
- End of records: a command finished mark `D` and a prompt start mark (`A`, or `P` of kind `i`) remove the `working`, `blocked` and `idle` records, because the command of the program ended and the shell draws its prompt only after it; the protocol requires the first two at the exit of the process and at a new prompt and permits the third. A command start mark `C` removes the `done` and `error` records, because the person started another command in this terminal after the result; the protocol keeps them past the exit and the prompt and leaves to the terminal when it stops showing them. A full reset (RIS, `ESC c`) removes every record, and a soft reset does not. The end of the session removes every record and the notice, and its change event is sent before the exit event of the session; a new session of the surface starts without records.

### Notice

The tracker holds one notice of the session, `true` or `false`:

- It becomes `true` at an OSC 9 notification, an OSC 777 `notify` and a BEL while the surface does not have the keyboard focus. The focus is the keyboard focus of the image region of the surface, which the page reports with the `focus` actions of its input and sends again each time its session opens or is attached; a surface without a region has no focus. A notice while the surface has the focus changes nothing, because the person is at the terminal, so a shell that rings the bell while the person edits its line gives none.
- It becomes `false` when the surface gets the keyboard focus; when the person types into it, which is an input transaction of the region with a text, a key or a command action, a command action being an editing command of the text system that a key of the person gives, such as `insertNewline:`; at a command finished mark `D` and a prompt start mark (`A`, or `P` of kind `i`), because the program that called has ended; at a full reset; and when its session ends. A paste operation, an action of a menu and any other write that does not come from the input transaction of the region leave it, because such a write is not the person looking at the terminal.
- The focus of the region follows the key status of its window ([image regions](native-surfaces.md#image-regions)), so a program in a window behind another application gives a notice, and the sidecar sends its program the DEC 1004 focus-out.

An OSC 9 whose first field is `4` is the progress report of ConEmu, `ESC ] 9 ; 4 ; <state> [; <progress>]`, which other terminals and programs use: it is not a notification. The engine gives it as the event `progress` `{state, progress}`, with `state` one digit from 0 to 4 and `progress` one to three digits of a value from 0 to 100 or `null`, and the terminal takes no state from it, so it changes neither the records nor the notice: a progress report has no state for a wait and no end at the end of the program, the protocol of the records states that a terminal SHOULD stop mapping OSC 9;4 once it has received an OSC 7501 report, and a command that reports progress is already `running` by its marks. This terminal neither shows OSC 9;4 nor takes a state from it, so it has no mapping to stop; the `progress` event only carries the report to the page, which keeps the last one in `vendor.progress` of `<plugin>.session`, `{state, progress}`, and sets it to `null` at the start of each session of the surface, as it keeps the last notification in `vendor.notification`. Another form of it is rejected with `sequence.rejected` and is no notice. OSC 777 with a first field other than `notify` and OSC 99 are not read: they stay unsupported selectors with `sequence.rejected`; a program sends OSC 99 only to a terminal that it identifies as kitty or foot by its name or its answers, and this terminal claims neither.

### Program status event

Each change of the records or the notice is one surface event `{event: "program.status", records, notice, sequence}`:

- `records` lists the records, the root record first and then by `id` in code point order, each `{id, state, kind, progress, app, title, msg}`: `id` is `null` for the root record, `app` is the reported or the inherited value, `title` and `msg` are the decoded texts, and an absent member is `null`.
- `notice` is the notice.
- `sequence` is the number of the change in the session, 1 for the first; a new session starts at 1 again.

A report that leaves the records as they were and a notice that leaves the notice as it was give no event. The sidecar sends the events of a surface in the order in which it applies their causes, the bytes of the output and the input of the page alike, on the one ordered channel of the surface, so `shell.state` and `program.status` of one output arrive in the order of their bytes. The sidecar writes each change to its event log as `sidecar.<sidecar>.program.status` at `info` in the class `lifecycle`, with `sequence`, `notice` and `records` as `{id, state, kind, app}`, without `title` and `msg`, because a program may write the command that it asks to approve. The tracker follows every output also while the surface does not draw.

The operation `program.status.read` returns `{event: "program.status.current", records, notice, sequence}`, with `sequence` 0 and no records before the first change; it echoes the `cids` of the request, changes nothing, and fails without an open session as `shell.state.read` does. A page reads it and follows its events by the rules of the [state read](#state-read): after it opens or attaches to a session, after a time without an image region, at a gap of the `sequence`, and with a lower `sequence` of a reply as a sidecar error.

### States of a running terminal

The records and the notice give the state of a terminal whose command runs, for each kind of program:

| What the program reports | The program |
| --- | --- |
| a `working` record | works |
| an `idle` or `done` record, and no `working`, `blocked` or `error` record | rests at its own prompt and waits for the next instruction |
| a `blocked` record | waits for an approval or an answer of the person, such as a permission prompt; it waits until it reports another state for that record |
| an `error` record | failed |
| no record, and a notice | called the person; whether it still waits is not reported |
| no record and no notice | is unknown: the terminal knows only that the command runs |

Only a `blocked` record states that a program waits for an answer and how long it waits. A notice states that the program called once: it ends when the person looks at the terminal or types into it, whether the program still waits or not. A running command without records is a program that reports nothing, and `<plugin>.program` shows it with no records; the activity `running` alone does not tell it from a working program. A consumer that must not answer a prompt by mistake, such as an operation that writes into the terminal, reads `<plugin>.program` and `<plugin>.state` and not only the activity: a `blocked` record is a wait, a notice is a call, and a running command without records is a program whose wait is unknown. Nothing waits for an answer exactly while no record is `blocked` and either the session has records, or the notice is `false` and `state` is `idle` or `exited`. A notice of a program without records gives `attention` also when the program called because its turn ended, because the notice does not say why the program called.

## Plugin program status

Each terminal plugin declares the status `<plugin>.program` (`terminal.program`, `term.program`) for each terminal surface. Its value is `{records, notice, sequence}` with the meaning of the [program status event](#program-status-event): `{records: [], notice: false, sequence: 0}` before the reply of the first read, the reply of the read, and then each change event. An event that is not of this form is a sidecar error: the page reports it through the error path of the session and keeps the previous value. A new session of the surface starts again from the value before the first read.

## Activity

Each terminal plugin also declares the status `<plugin>.activity` (`terminal.activity`, `term.activity`) for each terminal surface, and declares it for core with `activity: true`, so that core aggregates the activity of the tab, its cards, its space and its project (core F982). Its value is a core activity level or `null` for no activity. The plugin decides the level, because it knows the state, the exit code and the program status; core only aggregates the levels. The value follows each value of `<plugin>.state` and `<plugin>.program`, in this order:

1. When the session has records, the highest level of its records in the core order (`attention` > `failed` > `running` > `idle`), because a program that reports its state states also whether it still waits after it called the person:

   | Record `state` | Level |
   | --- | --- |
   | `blocked` | `attention` |
   | `error` | `failed` |
   | `working` | `running` |
   | `idle`, `done` | `idle` |

2. Otherwise a notice gives `attention`.
3. Otherwise the state of the marks:

   | `state` of `<plugin>.state` | `<plugin>.activity` |
   | --- | --- |
   | `null`, before the first change | `null` |
   | `idle` with `exit` 0 or `null` | `idle` |
   | `running` | `running` |
   | `exited` or `idle` with an `exit` other than 0 | `failed` |
   | `exited` with `exit` 0, or with `exit` `null` | `null` |

An `exited` state whose mark gives no exit code reports no failure, because no code shows one. A failure of the last command lasts until the next command starts, as a record of `error` does: the prompt start that a shell sends right after `D`, such as `A` from the `precmd` of zsh, gives `idle` to the state with the exit code of the command and keeps `failed` to the activity, and the next `running` ends it. The sidecar keeps the exit code in the state, so a page that attaches after the command, or attaches again, reads the same activity as the page before it. The records of a program decide also over the exit code of its command: a program that reported `done` and whose command exits with a nonzero code gives `idle` until the next command starts, and one that reported `error` gives `failed`. An `error` record gives `failed` also beside a `working` record, because the highest level decides. The status changes only when its value changes, and a new session of the surface starts again at `null`.

`attention` holds exactly while the session has a `blocked` record, or has no record and the notice is `true`. So it is entered at the report of a `blocked` record and at a notice of a session without records, and it is left when the program replaces or clears its last `blocked` record, at a command finished mark and a prompt start mark, which end that record and the notice, at a full reset, when the session ends, and, for a notice, when the person focuses or types into the terminal. A report of a record does not change the notice: a session with records gives no `attention` from it, and its `attention` returns when the records are cleared while the notice is `true`. `failed` of a record is left when the program replaces or clears the record, when a command starts, at a full reset and when the session ends.

### Decision

The rule takes the state of a running program only from signals that a program declares: the records of OSC 7501 and the notifications. OSC 7501 is defined by its sequence and not by a program: terminals (kitty, the parser of libghostty-vt, tuios, the addon of xterm.js) read it, and programs of several kinds write it (agents such as Codex CLI, opencode, Crush and omp, Claude Code after the answer to its query, and libraries and tools such as bubbletea, Symfony, Composer and Pulumi), so reading it reads no program. The notifications are the fallback of a program that writes no record, such as one that rings the bell when its turn ends. These candidates were rejected, because each guesses from one program: output silence for a window together with a screen that shows a prompt needs a fixed window, which is a timer, and patterns of prompts, which name programs; a spinner in the title or on the screen is the drawing of one program; the hook events of an agent need a configuration of that agent and a path from it to its terminal, and their events differ by agent. The core levels express the states without a new level: a program at its own prompt does no work and has no approval or answer pending, which is `idle`.

The adversarial review raised these objections in six rounds; each is judged with its evidence:

- *A notice beside records gives `attention` after each turn that a program ends while the person is away, so a program at its prompt shows a wait and an operation that writes into the terminal stops.* Accepted: records decide over a notice, because a program that reports its state states also whether it waits after it called; a notice decides only for a session without records.
- *A notice that ends at focus or typing makes `attention` unreliable for a prompt that is still shown.* Accepted as a limit and stated: only a `blocked` record states a wait, and a consumer that must not answer a prompt reads `<plugin>.program` and `<plugin>.state` ([states of a running terminal](#states-of-a-running-terminal)). A notice has no end that a program reports, and ending it at the attention of the person is the rule of kitty (`clear_needs_attention` at focus), tmux (`winlink_clear_flags` at the selection of the window), iTerm2 (the bell ends at the keys sent to the session) and Ghostty (the bell title ends at focus or a key).
- *A bell at a shell prompt waits for nothing, so it must not give `attention`.* Rejected: a bell while the person is away is a call, which kitty, tmux and Ghostty mark the same way, and a bell while the person edits the line gives no notice because the terminal has the focus.
- *A notice of a program that writes no record gives `attention` also for a turn that ended, so a program that rests at its prompt shows a wait.* Accepted as a limit and stated: a notification does not say why the program called, so the terminal shows the call; a program that states its rest writes a record. Restricting the notice to a running command would hide the bell of a job that ends behind the prompt.
- *A notice that outlives the program that called gives `attention` at the next shell prompt.* Accepted: the command finished mark and the prompt start mark end the notice, because the program that called has ended.
- *A paste that a key of the person starts is the person at the terminal, yet it leaves the notice.* Rejected: a paste of the person reaches the region only while the region has the focus, and the focus already ended the notice; only a paste that another operation sends arrives without the focus.
- *A reply of the state read with a lower `sequence` must not be dropped silently, and `shell.state` loses events without an image region as `program.status` does.* Accepted: such a reply is reported as a sidecar error, and the page reads both again at a gap and after a time without an image region ([state read](#state-read)).
- *The condition under which nothing waits must follow the precedence of records over a notice, and the root record must be an ancestor for `app`.* Accepted and stated.
- *A notice that a record report ends contradicts the rule that `attention` holds exactly while no record exists and the notice is `true`, and a clear with another key is ambiguous.* Accepted: a record report leaves the notice, and the clear applies without the other key.
- *The engine must give no `progress` event once a record arrives.* Rejected: the event carries the report of the program to the page, which keeps it in `vendor.progress` of `<plugin>.session`, and the terminal takes no state from it in either case; the protocol asks a terminal to stop mapping OSC 9;4, and this terminal maps no state from it at all.
- *A clear with an overlong or undecodable `msg` is applied by one reading and rejected by another, the protocol speaks of mapping OSC 9;4 and not of taking state, and the place where the page keeps a progress report is not named.* Accepted: a limit rejects any report whole, the clause of the protocol is stated, and `vendor.progress` is named.
- *A sixth round checked these three corrections: `vendor.progress` has no rule for a new session, and "maps no state" leaves open whether the event is a mapping.* Accepted: `vendor.progress` is `null` at the start of each session, and the text states that this terminal shows no progress and takes no state from it, so the event is no mapping that the protocol asks to stop.
- *A session without OSC 133 marks never ends its records, and a background window gives no notice.* Accepted as limits and stated in the text.
- *A paste or an injected write ends a notice that the person has not seen.* Accepted: only an input transaction of the region ends it.
- *A prompt start of any kind of `P` removes live records, and the command finished mark is the exit of the process that the protocol names.* Accepted: `D`, `A` and `P` of kind `i` end the records of a running program.
- *The level of a nonzero exit lasts only from `D` to the next `A`, which zsh sends at once.* Accepted: the failure of the last command lasts until the next command starts, the moment that ends an `error` record.
- *A failure that the page derives from the change events is lost when a page attaches after the command or attaches again, because the read gives `idle`.* Accepted: the `idle` after an `exited` carries its exit code in the state of the sidecar, so the read gives the same activity as the events.
- *The focus of the region does not change when the window loses the key status, so a bell from a window in the background gives no notice, and DEC 1004 reports no focus-out.* Accepted: the focus of a region follows the key status of its window ([image regions](native-surfaces.md#image-regions)).
- *`done` is "finished, not seen" and becomes `idle`.* Partly accepted. A program that rests at its prompt has no approval or answer pending, which is the meaning of `idle`, and a fifth level would change the order and the icons of core for a state that the program itself ends (a program reports `idle` once the person acknowledges). The meaning of `idle` in [activity](activity.md#activities) states it.
- *Clearing `done` and `error` at the next command start breaks the protocol.* Rejected: the protocol keeps them past the exit and the prompt and leaves to the terminal when it stops showing them, and a command that the person starts in the same terminal shows that the person saw the result.
- *A `blocked` record must not be evicted, because its eviction ends `attention` while the prompt shows.* Rejected twice, in two rounds: the protocol states that the record updated least recently is removed when the cap is exceeded; a program reaches it only with more than 256 records of its own, the eviction is logged at `warn` and shown by the change event, and keeping a `blocked` record against the protocol would let one program hold the records of the session.
- *OSC 99 and OSC 777 with another first field must be ignored without a report.* Rejected: the engine reports every sequence that it does not act on (the OSC inventory of the protocol document of each sidecar), and the report acts on nothing.
- *The sidecar must derive the activity, because an unloaded tab derives none.* Rejected: a tab without a surface has no activity in core ([activity](activity.md#activity-of-a-tab)), and the tracker of the sidecar keeps the records for the page that attaches.
- *Each status event needs one counter over all events of a session.* Rejected: the events of a surface arrive on one ordered channel in the order of the bytes that give them; a gap of the `sequence` of `program.status` makes the page read again.
- *The texts `title` and `msg` in `<plugin>.program` expose the command that a program asks to approve.* Rejected: `<plugin>.screen` exposes the same text on the screen; the log omits them, because the log is kept after the session.
- *The cases depend on how a read cuts the output.* Accepted: each sidecar runs each case also with its output fed one byte at a time.

## Shared cases

`docs/spec/cases/terminal-state/osc133.json` holds the cases of the marks: each case has the output of the session, the change events that the output gives in order, the state read after the output, and whether the output holds a rejected mark. A sidecar copies the file into its fixtures and runs each case through its real engine and its state tracker; a plugin copies it and applies the change events and the read reply of each case to its page, and compares the value of its status. A change of the contract replaces the copies.

`docs/spec/cases/terminal-state/program-status.json` holds the cases of the [program status](#program-status): each case has steps, each an output that the engine reads, a `focus` that the page reports or an `input` of the person, then the `program.status`, `shell.state` and `sequence.rejected` events that the steps give in order, the program status read after the steps, and the activity that the plugin derives. A sidecar runs each case through its real engine and its trackers, with the output of each step fed in one piece and again one byte at a time; a plugin applies the events and the read reply of each case to its page and compares `<plugin>.program` and `<plugin>.activity`.

`docs/spec/cases/terminal-state/prompt-region.json` holds the cases of the [prompt region](#prompt-region): each case has the size of the screen and steps, and each step is an output that the engine reads or a resize, with the rows of the screen (each row without its trailing blanks), the rows of the history from the oldest, the cursor and the errors that the engine reports after the step, when the step states them; a step that states no errors expects none. Each sidecar copies the file into its fixtures and runs each case through its real engine.
