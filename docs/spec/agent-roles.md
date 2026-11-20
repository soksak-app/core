# Agent roles

[한국어](agent-roles.ko.md)

This document defines how a tab of an agent CLI receives its role and how soksak confirms that the agent read it. Implementation and verification are tracked in [features](../features.md). A change message reaches the agent through the injection path of [messaging](messaging.md#injected-message).

## Decision

- A tab that starts an agent CLI gives the CLI a stable identity through its launch adapter. The identity names the absolute path of the role file of the tab. The agent reads its role from that file; the role text is never pasted into the terminal or put into a message.
- The role file belongs to one surface and lies in the configuration directory of the application, never in a repository of the person. Each unit of its definition ends with a fragment line, and the agent returns the list of all fragments to soksak with `sok role confirm`, which proves that the whole file was read.
- A role assignment or change rewrites the role file atomically and sends a short change message. The change message names the path of the role file and carries no role text and no confirmation value.
- A CLI without a launch adapter receives the same identity, with the same path, in its first message.
- A resume never changes the launch instructions of a CLI. A resumed tab sends a re-read message that names the same path.
- An agent does not write its role into any persistent memory of its CLI. The role is held only in the session context and in the role file.
- Role operations of one surface are serialized in arrival order, and each change raises the generation of the tab.

Reason: the measured facts listed in [measured facts](#measured-facts) show that a launch flag applies to a new session only, that `resume` keeps the instructions of the session start, and that an agent given a pointer to a role file reads the file and, after a change message, reads it again. A role written as text into a message or a launch can only be replaced by a later message. A file is the one place that holds the current role, and a confirmation value that the agent reads from the end of that file is the proof that it read the file to the end.

## Measured facts

Measured with Claude Code 2.1.329 and Codex 0.171.0, both as interactive TUIs, in an application with a disposable configuration directory. Each row is one run and records the observed answer of the agent.

| # | Launch or action | Observed result |
| --- | --- | --- |
| 1 | `claude --append-system-prompt-file F`, F holding a role text | The role of F applied in the TUI. |
| 2 | `claude --resume ID --append-system-prompt-file G` | The session kept the instructions of its start; G did not apply. |
| 3 | A message in a running Claude session that assigns a new role | The new role replaced the launch role. |
| 4 | `codex --no-daemon -c developer_instructions="..."` | The instructions applied in the TUI, and the global `AGENTS.md` of the person stayed in effect beside them. |
| 5 | A user message in a running Codex session that assigns a new role | The developer-instruction role was kept. |
| 6 | `codex resume --no-daemon ID -c developer_instructions=...` | The developer instructions of the session start were kept. |
| 7 | Codex with the stable identity and role messages that begin with the prefix | The latest role message defined the role. |
| 8 | Codex with a launch that only points to a role file; the file changed; a change message sent | The agent read the file at its first answer and read it again after the change message, and took the new role. |
| 9 | Claude Code with no flag and the pointer in its first message; the file changed; a change message sent | The agent read the file, and after the change it read the file again and took the new role. |
| 10 | `claude --model haiku --append-system-prompt-file <identity file>`, the identity file holding only the pointer and the rule to read it again after a change message | The agent read the role file; after the file changed and a change message was sent, it read the file again and took the new role. |

Rows 8 to 10 were checked against the session records of the agent, without timestamps, and each is one run. Rows 3 and 7 show only that the agent follows a change message that names the new role; they do not show that the agent reads a file. Not measured for either CLI: a context compaction, a change message after a resume, a change message while the agent is busy, a subagent or a second session in the same tab, and whether auto memory or the Codex memories are shared between sessions. The rules that depend on these are stated as rules of this contract, not as measured behaviour. The rule against persistent memory is an instruction only; no measured launch option of either CLI disables memory, so the launch does not enforce it.

The `blocked` hold of Claude Code is not measured: whether Claude Code reports a permission prompt as `blocked` through the program state of [terminal state](terminal-state.md), which decides whether a change message is held at a prompt ([messaging](messaging.md#evidence-of-the-hold)). Until it is measured, change messages are not sent to Claude Code while a prompt may be open, and the acceptance steps that send them to Claude Code are held.

## Launch adapters

A launch adapter is the part of a CLI launch that carries the stable identity. Only an adapter that adds to the built-in instructions of its CLI is used.

| CLI | Launch form | Effect on the built-in instructions | Status |
| --- | --- | --- | --- |
| Claude Code | `claude --append-system-prompt-file <identity file>` | Adds to the system prompt. The identity-only launch that names the role file applies and the agent reads the role file (row 10). | In use |
| Codex | `codex --no-daemon -c developer_instructions="<identity>"` | Adds developer instructions beside the global `AGENTS.md`. Applies in the interactive TUI and the agent reads the role file after a change message (rows 4 and 8). | In use |
| Kimi | `--agent-file` | Not measured. | Candidate, not in use |
| Copilot | `--agent <name>` | Not measured. | Candidate, not in use |
| OpenClaw | `tui --local agent:<name>` | Not measured. | Candidate, not in use |
| Qwen | `--append-system-prompt` | Not measured. | Candidate, not in use |
| Goose | `session --system` | Not measured; the flag may replace the instructions. | Candidate, not in use |

A candidate is added after its launch behaviour is verified in the TUI: the instructions apply to a new session, they add to the built-in instructions, and a change message makes the agent read the role file again. A candidate that replaces the built-in instructions is not added.

Resume forms: `claude --resume <id>` and `codex resume --no-daemon <id>` keep the instructions of the session start and ignore the adapter flags of the resume command (rows 2 and 6). A launch adapter is therefore used only at a new launch.

An agent CLI starts only in a folder that the CLI already trusts. A CLI that asks for folder trust or an update submits the Enter of an injection to its own prompt, as measured in [evidence of the hold](messaging.md#evidence-of-the-hold). The check of folder trust is not defined by this contract.

## Stable identity

The stable identity is the text that a tab's launch delivers. It is written in English and has this form, where `<role file>` is the absolute path of the role file of the tab:

> soksak assigns your role with messages that begin with [soksak 역할]; the latest such message defines your role. Your role is written in the file <role file>. Read that file before your first answer, and read it again when a message that begins with [soksak 역할] says that the role changed. Do not write your role into any persistent memory of yours, such as automatic memory or saved memories; the role file is the only record of your role.

- The identity names the message prefix, so the agent recognizes a change message as the authority over its role.
- The identity names the path of the role file, so the agent reads the role from the file at its first answer and after each change message.
- The rule against persistent memory keeps the role out of memory that other sessions could read. A role written into the memory of a CLI could reach another tab if that memory is shared between sessions; whether it is shared is not measured.
- The path is absolute and comes from the configuration directory of the application. It contains no quote or control character; the launch refuses a configuration directory path that does.
- The identity is the same text in a launch and in the first message of a CLI without an adapter.

## Role file

- Path: `<config-dir>/agents/<surface>/role.md`, where `<config-dir>` is the configuration directory of the application ([installation layout](installation.md#installation-layout)) and `<surface>` is the surface of the tab. Each surface has its own file.
- Units: the definition text is split into units. A unit is a paragraph, a block of non-empty lines separated from the next block by a blank line. When the definition has fewer than 4 paragraphs, its units are its non-empty lines instead. A definition with fewer than 4 units is refused with the error `definition needs at least 4 paragraphs or lines`, so the confirmation value has at least 64 bits.
- Fragment of unit `i` of `n`: the first 4 lowercase hexadecimal characters of the SHA-256 digest of the UTF-8 bytes of the role identifier, one line feed (U+000A), the decimal number `i`, one line feed, and the text of the unit as stored, without its fragment line. The identifier has no line break, so the separators are unambiguous. The fragment depends only on the identifier, the position and the text; the same definition always gives the same fragments.
- Fragment line of unit `i`: `[soksak i/n frag_i]`, written as the last line of that unit in the file.
- Confirmation value: the fragments in order, `frag_1-frag_2-...-frag_n`. Each fragment sits at the end of its own unit, so producing the value needs every unit; about 16 bits are added per unit, and with at least 4 units the value has at least 64 bits. The agent never computes it; soksak computes it from the stored definition to compare.
- Layout, in this order:
  1. the instruction line: `Read this whole file. It defines your role. Each unit ends with a fragment line `[soksak i/n frag]`. When you have read the whole file, confirm with `sok role confirm`, giving the fragments of all units in order, joined by hyphens.` The instruction line gives no value;
  2. for each unit in order: the unit text, then its fragment line, then one blank line, except after the last unit.
  Each line ends with one line feed. A tab without a role has a file with no unit: the instruction line only, and its confirmation value is the empty string, which soksak treats as `null`.
- A confirmation that gives the value of the stored definition proves that every fragment was computed from the text of its unit. Producing the value without the text is not possible, so the value shows that the fragments were seen; it does not show that the agent understood the text. The read evidence of the acceptance (layer 2 of [acceptance](#acceptance)) is the proof of the reading.
- Content limit: the definition text is at most 8 KiB.
- The file holds no generation and no token. The generation is a stored value of the tab ([tab role state](#tab-role-state)).
- The file belongs to the configuration directory and never to a repository of the person.
- Mode: the directory `<config-dir>/agents/<surface>/` is created with mode 0700, and `role.md` and the identity file are written with mode 0600. The mode of the temporary file is checked before the rename, so a file with another mode is never visible under the final name; the write then fails with an explicit error and removes the temporary file.
- Atomic write: the host writes the new content to a temporary file in the same folder and renames it over `role.md`. A reader sees the whole earlier file or the whole new one, never a mixture.
- Writer: the host writes the file. The terminal page creates no file. A write that fails is an error that names the path and the reason; the stored role does not change for a failure before the rename, as the [failure rules](#tab-role-state) state.
- Lifecycle: the host creates the directory before the launch. When the tab is removed from the layout, the host stops the program of the tab, waits for a write in progress to end, refuses a later role change of that tab with an explicit error, and removes the directory. A removed tab cannot be resumed.
- Launch record: each launch stores in the session record the identity path and a launch identifier. A resume checks that the stored path equals the current path of the role file and that the file exists. A mismatch, which happens when the configuration directory was moved, or a missing file, fails the resume with an explicit error that names the path and the reason.

The identity file of the Claude Code adapter is `<config-dir>/agents/<surface>/identity.txt`, written at the launch beside the role file by the same write rule. The Codex adapter passes the identity text inline, quoted as a TOML string.

### Confirmation value reference cases

The algorithm is tested by the shared case file `docs/spec/cases/agent-roles/confirmation value.json`. Each case gives the identifier, the definition text, the units that the split must produce, and the expected confirmation value; the `refused` case gives the error of a definition with too few units. Each host (Go and Rust) runs every case and checks the units and the value it computes, including the cases with non-ASCII text and line breaks. The values are computed from the algorithm above and are the same for both hosts.

## Role definitions

A role definition is the text that a role file holds. soksak holds the definitions in one stored file, `<config-dir>/roles.json`, beside `settings.json` and `projects.json` ([stored data formats](installation.md#stored-data-formats)). The file is numbered: its member `format` is `1`, and a reader accepts only that number and refuses another with `<file>: roles: format must be 1, found <value>`.

```json
{"format": 1, "roles": {"reviewer": {"text": "You review the changes of the other agents in this project."}}}
```

- A role identifier matches `[a-z][a-z0-9-]*` with at most 64 characters. Another identifier is refused with an error that names it.
- `text` is UTF-8 text of at most 8 KiB, and it is written into the role file as it is.
- A role that a tab names and `roles.json` does not define is refused with `unknown agent role <id>`, and the tab keeps its earlier role. No built-in definition is used in its place.

The editor of the file is a separate checklist item.

## Tab role state

Each tab of an agent CLI has one agent role, or none. The stored role record of the tab is an entry of the layout of `projects.json`, and it holds:

- `role`: the role identifier, or `null` when the tab has no role;
- `generation`: an integer that starts at 1 and rises by one at each change of the role or of its definition;
- `value`: the confirmation value of the current role file;
- `confirmedValue`: the confirmation value that the agent confirmed, or `null` until the confirmation.

Adding this record changes the form of `projects.json`, so its format number rises from 2 to 3 as [stored data formats](installation.md#stored-data-formats) requires. No migration is written, and the reader refuses format 2.

A role change is the command `core.tab.role {tab, role}`, which runs through the registry like every other command. Setting the role the tab already has, with the same definition, writes no file, changes no generation, and sends no message; it answers the current `{role, generation, state}`. The only repeated assignment that sends a message is one made while the state is `unconfirmed`: it sends the change message once, with no file write and no generation change, and it is the way a person resolves that state.

A change runs in this order, and each step starts only when the previous one succeeds:

1. the host writes the new role file under its temporary name, with the instruction line, its units with their fragment lines, and checks its mode;
2. the host stores the new `role`, `generation`, `value` and `confirmedValue: null` in `projects.json`;
3. the host renames the temporary file to `role.md`;
4. the host publishes the status `core.tab.role` with `{role, generation, state: "pending", seq}`;
5. the page of the terminal sends the change message ([change message](#change-message)).

Failure rules: a failure in step 1 removes the temporary file, and nothing is stored. A failure in step 2 removes the temporary file, leaves the stored role unchanged, and is reported as an error. A failure in step 3 after step 2 restores the earlier record in `projects.json` before the error is reported, so the record and the file agree. When the host ends between steps, the next launch of the tab writes the role file from `projects.json` before the CLI starts. A launch also removes any temporary file of the directory that an earlier end left.

The status `core.tab.role` is published as an event with the value `{role, generation, state, seq}`: `state` is `pending`, `ready` or `unconfirmed`, `null` when the tab has no role, and `seq` a counter that rises at each change. The status and the replies never carry the confirmation value, so the agent learns it only from the last line of its file. The page follows the status with `runtime.status.watch` and does not poll.

Leadership of a plane does not change a role in this contract. [Groups](groups.md#model) states that the leader is a mark that changes no command, focus or drawing order. A caller that wants the leader of a plane to have a role sets it with `core.tab.role`. Whether the leader mark itself drives a role is a question that the person decides.

## Confirmation

A role is ready only when soksak has mechanically confirmed it. The states are:

- `pending`: the role file holds a confirmation value that the agent has not confirmed. A role assignment, a role change and the launch of a tab with a role set this state.
- `ready`: the stored `confirmedValue` equals the confirmation value of the current role file.
- `unconfirmed`: the agent's program was not busy after an injection of a change message or of a first message while the state was `pending` ([idle rule](#idle-rule)).
- `null`: the tab has no role.

A role change sets the state back to `pending`, because its generation and confirmation value are new.

The agent confirms by running `sok role confirm <confirmation value>` with the confirmation value on the last line of the role file, which the instruction line names. `sok` sends the request to the application with the surface that the process chain of the agent gives ([processes of a surface](sidecars.md#processes-of-a-surface)), so a process outside the tab cannot confirm for it. The host judges the request inside the serialization of the surface ([concurrency](#concurrency)), against the state at its turn:

- the confirmation value equals the confirmation value of the current role file, in state `pending` or `unconfirmed`: `confirmedValue` is stored, the state becomes `ready`, `seq` rises, and the held work messages are released;
- the confirmation value equals the current one, in state `ready`: nothing changes and the answer is a success;
- the confirmation value differs from the current one, because it belongs to an older file: refused as stale, without a retry. The error names the path of the current role file and the current generation, and says to read that file again. It names no confirmation value. The state stays `pending`;
- a tab without a role, or a surface without a tab: refused with an explicit error that names the surface.

The confirmation command is a declared command of the CLI; its contract is [command line](cli.md#commands).

### Held messages

While the state is not `ready`, the page holds the work messages of the tab, which are the agent messages of the registration ([messaging](messaging.md#injected-message)). Held messages keep their order and are injected one at a time when the state becomes `ready`. Each is delivered once: the delivery record keys it by its file name, so a second `ready` does not inject it again. The first message of a session and the change messages are not held. The hold reason is `role-pending`, and the delivery status names it ([messaging](messaging.md#hold-for-the-person)).

A change while messages wait keeps them queued; they are delivered after the `ready` of the new generation.

### Idle rule

The page watches the program state of the tab ([terminal state](terminal-state.md)). When the program reports that it is not busy after an injection of a change message or of a first message, while the state is `pending`, the host sets the state to `unconfirmed`, reports it through the error display path, writes it to the application log, and the page sends the change message once more. When the program is not busy again while the state is `unconfirmed`, the state stays `unconfirmed`, the held messages stay held, and the person resolves it by a repeated assignment, which sends the change message once ([tab role state](#tab-role-state)). No timer decides these transitions. The not-busy report that each CLI gives is part of its adapter verification.

## Idempotency

Every step of the role handshake repeats without a change of the result:

- a repeated `core.tab.role` with the same role and definition writes no file, changes no generation, sends no message, and answers the current `{role, generation, state}`, except in state `unconfirmed` as [tab role state](#tab-role-state) states;
- a new generation is made only when the role or its definition changes;
- `sok role confirm` with the confirmation value of the current file, repeated, answers `ready` and changes nothing, including `seq`;
- a change message that is sent again names the same path, so reading the file again and confirming it again gives the same `ready`;
- a work message is delivered exactly once, even when `ready` is reached twice;
- after a restart of the application or of the agent, the state is rebuilt from the stored record and the file without new input: `ready` when `confirmedValue` equals the confirmation value of the file, otherwise `pending`. A file whose confirmation value differs from the stored one is rewritten from the record first;
- a resume gives `pending` with the same confirmation value, because a resume keeps the launch text but not the proof that the agent read the file. The host clears `confirmedValue` at the resume, and the resumed tab sends the re-read message, which names the same path.

A confirmation value that does not change for a repeated definition is what makes these repetitions natural: a file rewritten with the same text is the same content.

### Tests of the repetitions

- Repeated assignment of the same role and definition: no write of the role file (its inode and content stay the same), no new generation, no change message, and the answer equals the current `{role, generation, state}`.
- Changed definition with the same role: a new generation and one change message.
- Changes A to B to A: the confirmation value of A returns, and a confirmation of it gives `ready`.
- Repeated confirmation of the current confirmation value: `ready` both times, and `seq` unchanged after the second.
- Confirmation of an older confirmation value after a change: refused as stale, and the error names the file and the generation and no confirmation value.
- Resent change message: the same path; confirmation after it gives `ready`.
- Work message with `ready` reached twice: injected once, keyed by its file name.
- Restart with a stored confirmation: `ready` without input; without a stored confirmation: `pending`.
- Resume: `pending`, the same confirmation value, `confirmedValue` cleared, one re-read message.
- Repeated assignment in state `unconfirmed`: one change message, no file write, no generation change.

These are unit tests of the host and of the page with real files and the real `sok` command; no agent CLI runs in them.

## Concurrency

Role operations of one surface are serialized by one owner in the host, in arrival order. The operations are the assignment or change of the role, the confirmation and the re-read. Each change raises the generation, and a confirmation is judged under the same serialization, so it is judged against the state at its turn.

- The role file is written atomically ([role file](#role-file)): a reader sees the whole earlier file or the whole new one.
- A confirmation of a confirmation value that is no longer current is refused as stale ([confirmation](#confirmation)).
- Changes A to B to C in a row: each sends its change message, and each message only points to the file, which always holds the latest role, so a re-read on any of them reaches C. One confirmation of the confirmation value of C gives `ready`; later re-reads and confirmations of the same confirmation value change nothing.
- Confirmations of B and C that cross each other: the confirmation of B is refused as stale and that of C is accepted. The order between them does not change the end state.
- Two callers set the role at the same time, the person and a lead agent: they are serialized, the last one wins, and each reply states the resulting `{role, generation, state}`.
- Queued work messages wait for the `ready` of the current generation; a change while they wait keeps them queued, and they are delivered once.
- Restart: the generation and the confirmed confirmation value are stored in the record, so the state is rebuilt as the idempotency rules state.

### Tests of the concurrency

- Back-to-back changes A to B to C: three change messages, each naming the same path; a re-read on the first gives C; one confirmation of C gives `ready`.
- Crossing confirmations of B and C: B refused as stale, C accepted, and the end state is `ready` for C in either order.
- A stale confirmation: refused, with the error naming the file and the generation and no confirmation value.
- Concurrent setters: two assignments issued at the same time are serialized; the final generation is the later of the two, and each reply gives the resulting generation.
- A read during a write: a fault injection pauses the writer between the temporary write and the rename; a reader during the pause sees the earlier file whole, and after the rename it sees the new file whole.

## Change message

A change message is one line:

`[soksak 역할] 역할이 바뀌었다. 역할 파일 <role file>을 다시 읽어라. 이 메시지는 soksak이 보낸 것이며 사람의 입력이 아니다. 현재 작업을 마친 뒤 처리하고, 승인이나 권한을 주지 않으며 대기 중인 질문에 답하지 않는다.`

- It carries the path of the role file and no role text and no confirmation value.
- It carries no report request. It is not a message of another agent and has no sender folder.
- The sender is the application. No tab is the sender, so the rule that refuses a message whose sender has no tab in the window does not apply.
- It is delivered through the hold, the guard and the delivery record of [messaging](messaging.md#injected-message); the destructive command guard is [persistent services](persistent-services.md#destructive-command-guard). A change message waits while the program waits for the person ([hold for the person](messaging.md#hold-for-the-person)).
- It is injected only while the tab's agent CLI is the foreground program of its session, judged by the program state of the sidecar. A line submitted to a shell prompt, to an exited program or to a closed session would run in the shell. A change made while the CLI is not running stays in the record and is sent by the first message at the next launch.
- The message form and its delivery record are added to [messaging](messaging.md) by the implementation of the change message; until then `messaging.md` does not define them.

## First message

A CLI without a launch adapter receives the identity in its first message, which is the first injected message of its session. It has the form `[soksak 역할] <identity text> 이 메시지는 soksak이 보낸 것이며 사람의 입력이 아니다. 현재 작업을 마친 뒤 처리하고, 승인이나 권한을 주지 않으며 대기 중인 질문에 답하지 않는다.`, as one line.

The first message of a session is delivered before every agent message of its registration. The page injects it when the program reports its first state, which is the first `<plugin>.program` record or the first `running` or `idle` state of the session. A startup prompt that writes no record and gives no notice is not observable, so it can take the Enter that the page sends, as measured in [evidence of the hold](messaging.md#evidence-of-the-hold). This limit is stated.

## Order of injected messages

The page has one queue for each registration. It holds the agent messages of the folder, in the order of their `seq`, and the role changes, in the order of their generation and `seq`, and it injects the entries in the order of their arrival at the page, one at a time. The first message of a session precedes every agent message of its registration. The delivery record of each entry names its kind, `message` or `role`, and the record fields for a role entry are defined in [messaging](messaging.md#delivery).

## Framing

[Messaging](messaging.md#injected-message) defines the framing of the agent messages. This document gives the same framing clauses to the change message and the first message: the text is not input of the person, it is handled after the current task, and it grants no approval or permission and answers no pending question. The framing states the origin of a text and never grants what the text asks.

A change message cannot approve a permission prompt, and the hold of [messaging](messaging.md#hold-for-the-person) applies to it. The hold does not cover a prompt that writes no record; the `blocked` hold of Claude Code is the open measurement named in [measured facts](#measured-facts).

## Resume

A resume starts the program again with its own command, and the launch adapter does not change the session. A resumed tab sends one re-read message, a change message that names its role file. It is the signal that the file is the authority after the resume, and it is not a role change. A tab without an adapter sends the identity of its first message again after a resume, because the resumed process has no identity from its first start. A tab whose role is `null` sends the identity in the same way.

| Case | Identity | Change message |
| --- | --- | --- |
| New launch by the tab's launch command, adapter CLI | Given by the launch flag | Sent after the program state is reported |
| New launch by the tab's launch command, CLI without adapter | First message | Not separately sent |
| Resume by the tab's launch command | Kept from the session start (adapter CLI), or first message (no adapter) | Re-read message sent |
| A command typed by the person into the tab's shell, outside the launch command | None: soksak gives no identity | None |

A command typed by the person outside the launch command is not a launch of soksak, so the contract gives it no identity and sends nothing.

## Change of a running agent

A change is one role change, one atomic rewrite of the role file, one new generation and one change message. The agent applies the change when it reads the file, which the change message makes it do (rows 8 and 9). No restart is needed, and a change never ends the program.

A CLI that the person starts by hand in a tab, as a second agent in the same shell, has no identity from soksak. The change message reaches the foreground program whatever it is, so the contract states this limit: the launch record names the one process that holds the identity, and the page sends change messages only to that launch. A second agent that the person starts by hand is outside the contract.

The behaviour of a change message that arrives while the agent is busy is not measured for either CLI. Until a measurement settles it, a change message is injected only after the program reports that it is not busy, and the rule that the message is handled after the current task is the framing clause, not a measured guarantee.

## Tests

### Unit tests

- The launch adapters: the argument list and the identity file that each adapter produces, compared with the expected values. No agent CLI runs in a unit test.
- The terminal launch path: a recording program that the launch starts as the agent command. It records the arguments and the first input it receives and does nothing else. The launch starts it as a real process; the test does not replace the launch function.
- Role file write: real files. A test-controlled fault point in the host writer fails the write at step 1 (before the temporary file exists), at step 2 (the `projects.json` write) and at step 3 (the rename), and each case states the stored record and the file afterwards.
- Mode: the temporary file is created with mode 0600 and the directory with 0700; a changed mode of the temporary file before the rename makes the write refuse without renaming.
- Layout and confirmation value: the layout has the instruction line, the definition and the confirmation value line; the confirmation value of each reference case in `docs/spec/cases/agent-roles/confirmation value.json` is equal in the Go host and in the Rust host.
- Path: a configuration directory path with a quote or a control character makes the launch refuse with an explicit error.
- Resume: the stored path equal to the current one and the file present start the program; a different stored path or a missing file fails the resume with the error that names the path.
- First message: the form of [first message](#first-message), sent once per session.
- Stored confirmation: the stored generation and `seq` survive a restart, so a page that loads again injects nothing with a `seq` at or below the delivered one.
- Cleanup: a launch deletes a temporary file left by an earlier end and keeps `role.md`.
- Format: the `projects.json` reader refuses format 2 with the stored data error, and the writer writes format 3.
- Repetition and concurrency: the tests of [idempotency](#tests-of-the-repetitions) and [concurrency](#tests-of-the-concurrency).
- `roles.json`: the format number, the identifier rule, the text bound and the unknown role refusal, each with its error text.
- Change message: its form, the absence of role text and of confirmation value in it, and no send while the program is not the agent CLI.

### Acceptance

The acceptance target is `test-app-agent-role`. Core declares no window check that names an agent CLI or a plugin, so the target is declared by the repository of the terminal plugin, which owns the page that sends change messages. It runs the real Claude Code and Codex in an application with that plugin installed, in a disposable configuration directory and a project folder that the CLI already trusts. It runs only locally, needs a display, and runs only when the person runs it. The window-check rules of [AGENTS](../../AGENTS.md#verification) apply, and it is not part of `make test-app`.

Two things are judged for each CLI:

1. Value: the target writes each role definition with a random nonce of its own in one unit, so no value is known before the agent reads the file. The target computes the expected confirmation value from `roles.json` with the algorithm above. The `sok role confirm` call of the agent must give exactly that value. This proves that all fragments were seen and computed from the file, and it does not by itself prove comprehension.
2. Read evidence (the proof of the reading): the session record must hold one tool output whose text is the whole role file. For Claude Code the `Read` tool result of `role.md` in the session transcript; for Codex the output of the `exec_command` call `cat <role file>` in the session rollout. The target compares the SHA-256 digest of that output text with the digest of the file, after it removes the line-number prefix that the `Read` tool adds to each line, and the comparison must be byte-equal. A tool output that holds only some fragment lines, such as a `grep` of them, fails this layer. The target reads both with `sok conversation read --agent <claude-code|codex> --cwd <project folder>` ([agent conversation](agent-conversation.md)), whose reply must give each record its transcript index, its timestamp and its tool output text. The target refuses a read of any path other than `role.md`.

The read evidence needs `sok conversation read` to return tool calls and their output text; the current contract returns message text only, so the target cannot pass until the agent conversation contract and its implementation provide that output. Until then the target fails at the read step with the error `no tool record of the role file in <file>`.

For each CLI the target:

1. opens a tab with the CLI and the role `reviewer` through `core.layout.open`, with a definition that holds the nonce of the run, and waits for the status `core.tab.role` and the program state, not for a timer;
2. asks the agent to answer with the confirmation value on the last line of its role file; requires the confirmation value of the current file in the answer and a session read of the file that shows it;
3. sets the role `leader` with `core.tab.role`, whose definition holds a new nonce; asks again; requires the new confirmation value in the answer, no old confirmation value in it, and a session read after the change message that shows the new file;
4. requires that the status reached `ready` only after the agent ran `sok role confirm` with the current confirmation value, and that the session record shows the read of the file before that confirmation;
5. resumes the session, requires the re-read message, asks again, and requires the current confirmation value in the answer and a session read after the re-read;
6. requires that no nonce and no confirmation value of a role appears in the persistent memory files of the CLI or in `AGENTS.md` and `CLAUDE.md` of the project folder.

Steps 3 and 5 for Claude Code are held until the `blocked` hold of Claude Code is measured ([measured facts](#measured-facts)). A held step is reported as `held` with its condition, not as passed.

Failure outcomes, each a failed test with its error text:
- no session file for the project folder: `no session file for <folder>`;
- more than one session file for the folder in the window of the test: `more than one session file for <folder>: <files>`, because the most recent file could belong to another session;
- `skipped` records of the read that the target needs: `skipped records in <file>: <count>`;
- an answer with a confirmation value and no read of the role file that holds it: `confirmation value <fp> in the answer without a read of the role file`;
- an answer without the current confirmation value: `answer does not hold the confirmation value of the current role file`.

A missing `claude` or `codex` command fails the target with the error that names it, and no test is skipped. Each test has its own time limit and prints `running`, `finished`, `passed` or `failed` with its elapsed time ([AGENTS](../../AGENTS.md#verification)).

## Verification boundaries

The adapter table is verified for each CLI when the acceptance target runs for it, and again for each new version of the CLI that changes its launch options. Until the target exists and its run is recorded in [features](../features.md), the claims that depend on it are unverified.

## Review

The decision was reviewed by adversarial reviewers, each arguing against the draft with evidence and an answer for each objection. The rounds and their answers, as applied in this document:

- Round 1, consistency with the existing contracts: the leader of a plane may be a group card that holds no tab, so the role is attached to tabs only; the leader mark changes no command ([groups](groups.md#model)), so it does not drive a role here; the role queue is separate from the folder queue and is ordered by arrival; `roles.json` and the tab role are stored formats; the guard anchor is [persistent services](persistent-services.md#destructive-command-guard).
- Round 1, runtime behaviour: a role change is injected only while the agent CLI is the foreground program; the first message waits for the first program state, and the startup-prompt limit is stated; the Claude Code `blocked` hold is open; the last delivered role `seq` is kept in the record, so a page reload cannot repeat it; a failed identity write fails the launch with an explicit error.
- Round 1, scope and tests: the unit tests check the arguments and identity file of each adapter, and the recording program is a real process that records what it receives; the acceptance target lives in the terminal plugin repository, because core declares no window check that names a plugin.
- Round 2, pointer design and runtime: the role directory lives as long as the tab; resume checks the stored path and the file and fails with an explicit error otherwise; the write order is record first, then file rename, and the file is rewritten from the record at the next launch; the role file mode is 0700 and 0600; the relaunch cases are listed; compaction, busy receiver, second session and memory sharing are listed as not measured.
- Round 2, records and terms: the measurement date and the account description are removed; other work is referred to by description, not by checklist ID; measured rows are worded as observed.
- Round 3, evidence and runtime: the read evidence needs tool output from `sok conversation read`, which the contract does not yet return; the failure outcomes are listed; the read is ordered by transcript index and timestamp; the unit tests cover each rule with a named fault point; the token became a confirmation value of the definition, so it is not a secret that a message could carry.
- Round 3, contract consistency: `role-pending` and the role delivery record are contract changes of `messaging.md`, which this document names as part of the change message implementation; the stale confirmation error names no confirmation value; the generation is stored in the record.
- Round 3, failure modes and tests: the write order and failure rules are stated as one sequence; each rule has a unit test; the lifecycle of a removed tab stops its program first.

Open objections, not resolved by this document: the `blocked` hold of Claude Code is unmeasured, so steps 3 and 5 for Claude Code are held; the leader-to-role question is for the person; the messaging contract changes and the `projects.json` format change belong to the implementing items; and the record of the confirmation value algorithm in the Go and the Rust hosts depends on their implementation.
