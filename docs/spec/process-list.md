# Process list

[한국어](process-list.ko.md)

This contract defines the process list of a terminal session: the foreground program and the background jobs of the session, each with its source. It defines the command `term.process.list` and the request and reply of the sidecar operation that serves it. Implementation and verification are tracked in [features](../features.md); approval of this contract does not establish implementation.

## Owner

- The plugin `term` declares and exposes the command `term.process.list` ([exposure](exposure.md)).
- The sidecar `alacritty` reads the process of the session and answers the operation. macOS is the first platform.
- Core declares only the contract and the wire shape in this document. Core does not read processes and does not name the sidecar or the plugin in code ([sidecars](sidecars.md)).

## Request

The plugin sends the request through the sidecar page interface ([page interface](sidecars.md#page-interface)). The host delivers it as a sidecar request line with the envelope of the [messages](sidecars.md#messages) section:

| Key | Value |
| --- | --- |
| `surface` | The surface of the terminal session |
| `root` | The project directory of the owning window, as for every request |
| `body` | `{"operation": <operation name>}` |

The body key `operation` names the operation selector. The sidecar declares its selector field in `sidecar.json` as `message.operationField` ([sidecars](sidecars.md#messages)). The value of `operationField` for `alacritty` is not fixed by this document (open question 1).

The operation name for this contract is not fixed by this document (open question 1).

## Reply

The sidecar replies with the envelope of its reply line: `{"surface": <surface>, "cids": [...], "body": <reply body>}` ([messages](sidecars.md#messages)). The reply body has these keys:

| Key | Value |
| --- | --- |
| `foreground` | An object with the foreground program, or `null` when the session has no foreground program that can be read |
| `background` | An array of background jobs, in the order that the source reports; an empty array when the session has no background job |

The foreground object has these keys:

| Key | Value |
| --- | --- |
| `name` | The name of the leader process of the foreground process group |
| `arguments` | The arguments of the leader process |
| `started` | The start time of the leader process (format open, question 6) |
| `source` | The source of the entry (see Sources) |

Each background job has these keys:

| Key | Value |
| --- | --- |
| `name` | The name of the job (open, question 7) |
| `pid` | The process id of the job, a positive integer |
| `state` | `running` or `stopped` |
| `source` | The source of the entry (see Sources) |

## Foreground program

The foreground program is the leader of the process group that owns the terminal of the session. The sidecar reads the foreground process group from the PTY of the session. The mechanism that names this process group on macOS is open (open question 2).

## Background jobs

A background job is a job of the shell of the session that is not the foreground program. Each job is listed with its `name`, `pid` and `state`, and the `state` values are `running` and `stopped`. The jobs are read from the process table of the session and not from the screen. The mechanism that identifies the jobs of the shell is open (open question 3).

## Sources

Each entry carries its source. The allowed sources are:

- `process-table`: the entry is read from the process table of the session.
- `osc-133`: the entry is taken from the OSC 133 command marks that the shell sends.

Whether `osc-133` applies to any entry is open (open question 4). The strings `process-table` and `osc-133` are the wire values chosen by this document; their final spelling is open (open question 8).

A process name alone does not identify an agent. An agent is identified by its arguments and its session file ([terminal plan](../plans/terminal-plan.md), Part 1, option 6). This document does not define agent identification.

## Failures

A failure is an explicit error. The sidecar replies with a body that is an object with the member `error` ([messages](sidecars.md#messages)). The host stores the reply as `host.sidecar.reply`. A missing operation or a sidecar error is a failure and is not replaced or discarded ([sidecars](sidecars.md#messages)). The following failures are defined:

| Condition | Reply `error` text |
| --- | --- |
| the session is closed | open (question 5) |
| the process of the session cannot be read | open (question 5) |
| the platform does not implement the operation | `<operation name> is not implemented on <os>` |

The platform form follows the platform rule of the repository: a platform that does not implement an operation returns `not implemented on <os>` from `platform/<os>/unsupported.*` (repository `AGENTS.md`, Platform-specific files), as the Windows file `packages/host/go/src/platform/windows/unsupported.go` does. The operation name in the text is the name of the operation of the request (open question 1). The `<os>` value is `darwin`, `linux` or `windows`, the names of the platform folders.

## Open decisions

1. The sidecar operation name and the value of `operationField`. The repository does not name the operation of `alacritty`. The plugin manifest declares the readable name in `background.operation` ([sidecars](sidecars.md#messages)), and the sidecar name is not in core. Reason: no declaration exists.
2. The macOS mechanism that names the foreground process group of the PTY. Plan V3 is open ([terminal plan](../plans/terminal-plan.md), Part 2, V3). Reason: no test names the process on macOS yet.
3. The mechanism that identifies the background jobs of the shell. The plan requires the jobs of the shell with name, pid and state but does not name how the sidecar obtains the job list from the process table. Reason: the plan does not fix it.
4. Whether `osc-133` applies to entries. The plan names OSC 133 marks as a possible source but does not say which entry uses it. Reason: the plan does not fix it.
5. The exact `error` text for a closed session and for an unreadable process. No existing convention covers these conditions. Reason: the repository has no text for them.
6. The format of `started`. Reason: the plan does not fix a time format.
7. The `name` of a background job: the executable name or the command line. Reason: the plan does not fix it.

8. The exact wire spelling of the source values `process-table` and `osc-133`. Reason: the plan names the sources in prose and does not fix a spelling.

