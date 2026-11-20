# Process list

[한국어](process-list.ko.md)

This contract defines the process list of a terminal session: the foreground program and the background jobs of the session, read from the process table of the system. It defines the command `<plugin>.process.list`, the sidecar operation `process.list` that serves it, the event `processes` that keeps the list in the session state, and the shared cases of the rule. Implementation and verification are tracked in [features](../features.md); approval of this contract does not establish implementation.

## Owner

- The plugins `terminal` and `term` each declare and expose the command `<plugin>.process.list` ([exposure](exposure.md)) and keep `foreground` and `background` in their status `<plugin>.session` ([terminal read](terminal-read.md#session-state)).
- The sidecars `vt` and `alacritty` each read the processes of the terminal of their sessions and answer the operation. The sidecar `vt` serves the plugin `terminal`, and the sidecar `alacritty` serves the plugin `term`. macOS is the first platform.
- Core declares only this contract, its wire shape and its shared cases (`docs/spec/cases/process-list/jobs.json`). Core does not read processes and does not name a sidecar or a plugin in code ([sidecars](sidecars.md)).

## Process

The foreground program and each background job have one form:

| Key | Value | Source on macOS |
| --- | --- | --- |
| `group` | The process group id, which identifies the program or the job while its members end | `pbsi_pgid` of `proc_pidinfo(PROC_PIDT_SHORTBSDINFO)` |
| `pid` | The process id of the process that the entry describes, a positive integer | the [members](#members) |
| `command` | The path of its executable | `proc_pidpath` |
| `arguments` | An array of strings: the arguments of the process after its program name, one string per argument, in the order of the process; an empty array when there are none | `sysctl(KERN_PROCARGS2)` |
| `cwd` | The path of its working directory | `proc_pidinfo(PROC_PIDVNODEPATHINFO)` |
| `started` | The start time of the process in milliseconds since the Unix epoch, an integer | `pbi_start_tvsec` and `pbi_start_tvusec` of `proc_pidinfo(PROC_PIDTBSDINFO)`, which the system refuses for a process of another effective user |

A background job carries `state` too ([background jobs](#background-jobs)).

- The process of an entry: the leader of the group, whose pid is the group id, when it has not ended; otherwise the member of the group with the lowest pid among the members that have not ended. A group without a member that has not ended has no entry.
- A refused read: when the system refuses one of the reads of the process of an entry, such as the start, the arguments or the working directory of a process of another effective user, the members `command`, `arguments`, `cwd` and `started` are `null` and the member `error` names the read and the reason; no value is guessed.
- An agent is identified by its `arguments` and its session file ([agent conversation](agent-conversation.md)); a process name alone does not identify an agent, and this contract does not define agent identification.

## Members

The members of the list are the processes whose controlling terminal is the terminal of the session: `proc_listpids` with `PROC_TTY_ONLY` and the device of the terminal, which is `e_tdev` of the shell of the session read when the shell starts, so that it stays known after the shell ends, and for each pid its group, its parent and its state from `proc_pidinfo(PROC_PIDT_SHORTBSDINFO)`, which makes no check of the user, so that a setuid program such as `top`, whose full BSD information `PROC_PIDTBSDINFO` refuses to the user of the session, is a member. A process that ends between the list and its read (`ESRCH`) is not a member. The state of a member follows `pbsi_status` and `pbsi_flags`:

| `pbsi_status` | State |
| --- | --- |
| `SZOMB`, or any status with `P_INEXIT` in `pbsi_flags` | `ended` |
| `SSTOP` | `stopped` |
| `SIDL`, `SRUN`, `SSLEEP` | `running` |

## Foreground program

The foreground program is the [process](#process) of the foreground process group of the terminal of the session, which `tcgetpgrp` on the master of the PTY names. It is `null` when that group has no member that has not ended, which includes a terminal without a foreground process group, for which `tcgetpgrp` names a group without members. While the shell waits at its prompt, the shell is the foreground program.

## Background jobs

A background job is a process group of the members other than the foreground process group and other than the process group of the session leader, which is the shell that the sidecar started; a session leader is the leader of its group, so that group id is the pid of the shell. The job table of the shell is held inside the shell, so the list shows the process groups of the terminal that the system names: a job that the shell no longer tracks, such as after `disown`, stays in the list while its group has a member, and a group that a program of the session creates with `setpgid` is in the list too.

- Order: one entry per process group, in ascending order of the group id.
- State: `stopped` when every member of the group that has not ended is stopped, and `running` otherwise.
- Limit: a shell without job control, such as zsh after `set +m`, keeps a process started with `&` in the process group of the shell, so that process is not a background job of this list; the list cannot tell it from a foreground command of that shell, which runs in the same group. The shells that the sidecars start are interactive and have job control, so each job of such a shell has its own process group.
- A subshell job, such as `(sleep 100) &`, is a fork of the shell, so its entry names the executable of the shell and its arguments.

The shared cases `docs/spec/cases/process-list/jobs.json` state the rule: each case gives the session leader, the foreground group and the members with their group and their state, and the expected foreground and background entries with their group, pid and state. Both sidecars run them through the function of the rule, and the real PTY tests of each sidecar run a shell with `sleep 100 &` and `less` in the foreground.

## Session state

The sidecar reads the process list after each output of the session, which includes the prompt of its shell, and sends the event `{event: "processes", foreground, background}` when the list differs from the last list that it sent. The plugin keeps both members in `<plugin>.session` ([terminal read](terminal-read.md#session-state)).

- A failed read: the sidecar sends `{event: "processes", error}` once until the next read differs, and the plugin sets `foreground` and `background` to `null`, which states that the list is not known, and shows the error through its error display path, which writes it to the application log.
- Events of the jobs: the sidecar holds one `kqueue` for each session. After each read it watches each member of the background jobs and the parent of each such member, other than `launchd` (pid 1), that it does not watch yet with `EVFILT_PROC`, `NOTE_EXIT`, `NOTE_EXEC` and `NOTE_SIGNAL`, and keeps each watch until its process ends. It reads the list again when a watched process ends, executes a program or receives a signal. A job is read between its fork and its `exec` with the command of the shell, and a read during the `exec` does not find the process; the event of the `exec` reads the list again with the new program, and a watch removed after a read that missed the process would drop that event, so a watch ends only with its process. A process receives a stop signal before it stops, so the watch of a member alone can read the list before the stop; its parent receives `SIGCHLD` after the member stopped, continued or ended, so the watch of the parent names the new state. The system removes the watch of a process when the process ends, so a watch never names a later process with the same pid; a process that has ended before its watch begins (`ESRCH`) makes the sidecar read the list again at once. Another refusal of a watch is recorded in the event log with the pid and the reason. The `kqueue` closes with the session.
- A new job: the shell starts a job with a fork and moves it to its own group afterwards, and an interactive shell writes the job number and pid of a job that it starts, so the output after the start names it.
- Cost: the read runs once for each output event of the session, which carries the bytes of one read of the PTY.

## Request

The plugin sends the request through the sidecar page interface ([page interface](sidecars.md#page-interface)), with the body `{"operation": "process.list"}`. The member `operation` is the operation field of every request of both sidecars ([messages](sidecars.md#messages)). The operation reads the process list at the time of the request; it does not answer from the last event.

## Reply

The sidecar replies with the body `{"event": "process.list", "foreground", "background"}`: `foreground` is a [process](#process) or `null`, and `background` is the array of the [background jobs](#background-jobs), empty when the session has none. The command `<plugin>.process.list` returns `{foreground, background}`.

## Failures

A failure is an explicit error. The sidecar replies with a body that has the member `error` and the request `{"operation": "process.list"}`, and the plugin rejects the command with that text through its error display path. A failed read of the [session state](#session-state) carries the same texts.

| Condition | `error` text |
| --- | --- |
| the surface has no open session | `Session not open` |
| the master of the session is closed | `session master is closed` |
| `tcgetpgrp` fails | `read the foreground of the session: <reason>` |
| the controlling terminal of the shell of the session cannot be read | `read the terminal of the session: <reason>` |
| the processes of the terminal cannot be listed | `list the processes of terminal <device>: <reason>` |
| the group and the state of a member cannot be read for a reason other than `ESRCH` | `read process <pid> of terminal <device>: <reason>` |
| the platform does not implement the operation | `process.list is not implemented on <os>` |

`<device>` is the device number of the terminal, `e_tdev` of the shell of the session, which is the session leader and holds the terminal as its controlling terminal; the sidecar reads it when the shell starts, and a failure of that read fails each read of the list. A member whose group and state cannot be read fails the list, because its job and the state of that job cannot be stated without them. A refused read of the process of an entry is not a failure of the list: the entry carries `error` ([process](#process)). The platform form follows the platform rule of the repository: a platform that does not implement an operation returns `not implemented on <os>`, where `<os>` is `darwin`, `linux` or `windows`.

## Decisions

The eight open decisions of the first draft are decided as follows, from the contract, the standard of the platform and the code of the sidecars.

1. Operation name and operation field: the operation is `process.list` in the member `operation`, which both sidecars read for every request; the reads of these sidecars name an object and a verb (`screen.read`, `shell.state.read`), and the reply of this read is a list.
2. Foreground mechanism: `tcgetpgrp` on the master of the PTY, which both sidecars already call for the foreground of the session state; the POSIX terminal interface defines the foreground process group of a terminal by this call. The sidecars call it themselves and report its failure, because the method of the PTY library that calls it answers a failure as no group.
3. Background jobs: the process groups of the controlling terminal of the session, read with `proc_listpids(PROC_TTY_ONLY)` and `proc_pidinfo(PROC_PIDT_SHORTBSDINFO)`. The job table of a shell is held inside the shell and no interface of the system reads it, while job control gives each job its own process group of the terminal; the list therefore names process groups of the terminal, which include groups that the shell does not track, as [background jobs](#background-jobs) states.
4. OSC 133: no entry uses it. The marks `A`, `B`, `C` and `D` carry the state of the prompt and the exit code, and no process id, name or job ([terminal state](terminal-state.md)), so every entry comes from the process table.
5. Error texts: the texts of the table of [failures](#failures); `Session not open` and `session master is closed` are the texts that both sidecars already reply for a surface without a session and for a closed master.
6. `started`: an integer of milliseconds since the Unix epoch, from `pbi_start_tvsec` and `pbi_start_tvusec`; it is the form of a time of the page (`Date.now()`), and with `pid` it tells a new process from an earlier process with the same id.
7. Name of a job: a job carries `command` and `arguments` like the foreground program, read from the process table, and not the command line that the shell shows in its job report, which is text of the shell before its expansion; one form serves both members, and `group` identifies the job while its leader and other members end.
8. Sources: the list has one source, the process table, so an entry carries no `source` member; a member with one possible value tells a reader nothing.

The arguments are read with `sysctl(KERN_PROCARGS2)` in the sidecars. The library `sysinfo` reads the same value, and it returns empty arguments when the system refuses the read, which a process without arguments also returns; the contract requires that a refused read is an error, so the sidecars read it themselves and state this in the code. The watches use `kqueue` through the system calls: the crate `kqueue` has no `NOTE_SIGNAL` on macOS and registers all its watches in one call, which a process that has ended stops, and the `Kqueue` type of `nix` gives no descriptor for the reactor of the sidecar.

## Review

Two review rounds raised fourteen objections, judged with evidence.

Round one, eight objections:

- Accepted: the limit of a shell without job control names the group of the shell; an entry carries `group`, because its `pid` changes when its leader ends; a process that ends during the read is not a member; the exits and the signals of the members of a job are events of `kqueue`, so the list follows them without output; the reason of decision 7 no longer calls the arguments text of the shell, and a subshell job is stated; the list names process groups of the terminal, which include groups that the shell does not track.
- Rejected: an error for a session without job control, because such a session has a foreground program and a valid list; a watch of the forks of the shell, because a fork comes before the move to the group of the job and the shell writes the start of a job; a new term for the job, because this contract defines the term and the job table of the shell cannot be read; a bound of the read rate, because the read runs once for each output event as the read of the foreground does, and performance is measured by benchmarks after development; shared cases for a subshell, for the end of a process during a read and for job control off, because the rule takes the members as input and these cases give no other input to it.

Round two, six objections:

- Accepted: the foreground program follows the rule of the process of an entry and carries `group`, with a shared case of an ended leader; the process of an entry is chosen only among the members that have not ended, with a shared case of a zombie leader; the watches are one `kqueue` for each session, added for new members, kept until each process ends, because a read during an `exec` does not find the process, and closed with the session; `tcgetpgrp` and a refused read of the group and the state of a member have their own failures; the source of each member and the states of `pbsi_status` are stated; a failed read of the session state is an event that the plugin shows and that sets both members to `null`.
- Rejected: a key of `pid` and `started` for a watch, because the system attaches the watch to the process and removes it when the process ends, so a later process with the same pid has no watch.
