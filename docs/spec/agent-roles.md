# Agent roles

[한국어](agent-roles.ko.md)

This document defines how a tab of a terminal agent receives its role, and how soksak confirms that the agent has the role. Implementation and verification are tracked in [features](../features.md). Messages reach the agent through the injection path of [messaging](messaging.md#injected-message).

## Decision

- A tab that starts an agent CLI gives the CLI a stable identity through its launch adapter. The identity names the absolute path of the role file of the tab. The agent reads the role from that file; the role text is not pasted into the terminal when the agent can read files.
- A surface is the surface of one tab, so the role file of a surface belongs to one tab. The role file lies in the configuration directory of the application, never in a repository of the person. Keep a role definition short, because the agent reads the whole file at each change; soksak accepts a definition of any length. Its last line is the fingerprint of the role.
- The fingerprint is deterministic: the same role name and definition always give the same fingerprint. The agent reads it from the last line of the file; it never computes it.
- The agent confirms by one of two declared ways: the command `sok role confirm <fingerprint>`, or a line `soksak role <fingerprint>` in its answer. A role is `ready` only when soksak has received the current fingerprint.
- An agent that does not confirm gets two reread requests, each counted by an event, and then the state `unconfirmed` shows through the error display and stays so until the person assigns the role again. No timer decides any step.
- A role assignment or change rewrites the role file atomically and sends a change message that names the path of the file; an agent that cannot read files receives the paste form instead ([agents that cannot read files](#agents-that-cannot-read-files)). Operations of one surface are serialized in arrival order.
- An agent does not write its role into any persistent memory of its CLI.

Reason: the measured facts listed in [measured facts](#measured-facts) show that a launch flag applies to a new session only, that `resume` keeps the instructions of the session start, and that an agent given a pointer to a role file reads the file, and reads it again after a change message. A role held as text in a message or a launch can only be replaced by a later message; a file is the one place that holds the current role.

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
| 11 | Claude Code 2.1.329 with `--permission-mode default`, with a Bash permission prompt open, and a change message sent during the prompt | `<plugin>.program` showed `{state: blocked, kind: permission}` and `<plugin>.messages` held the message with `{reason: blocked, kind: permission}` and `pending` 1, with nothing pasted. When the person closed the prompt with Esc, the message was injected and Claude Code acted on it. |

Rows 3 and 7 show only that the agent follows a change message that names the new role; they do not show that the agent reads a file. Each row is one run. The rule against persistent memory is an instruction only; no measured launch option of either CLI disables memory.

Claude Code reports a permission prompt as `blocked` through the program status of [terminal state](terminal-state.md) (row 11), so the `blocked` hold of [messaging](messaging.md#hold-for-the-person) holds the change messages and reread requests while the prompt is open.

## Launch adapters

A launch adapter is the part of a CLI launch that carries the stable identity. Only an adapter that adds to the built-in instructions of its CLI is used.

| CLI | Launch form | Effect on the built-in instructions | Status |
| --- | --- | --- | --- |
| Claude Code | `claude --append-system-prompt-file <identity file>` | Adds to the system prompt. The identity-only launch applies and the agent reads the role file (row 10). | In use |
| Codex | `codex --no-daemon -c developer_instructions="<identity>"` | Adds developer instructions beside the global `AGENTS.md`. The agent reads the role file after a change message (rows 4 and 8). | In use |

A CLI is added to this table after its launch behaviour is measured in the TUI: the instructions apply to a new session, they add to the built-in instructions, and a change message makes the agent read the role file again. A flag that replaces the built-in instructions is not used.

Resume: `claude --resume <id>` and `codex resume --no-daemon <id>` keep the instructions of the session start and ignore the adapter flags of the resume command (rows 2 and 6). A launch adapter is used only at a new launch.

Each adapter and each CLI declares which confirmation ways apply to it ([confirmation](#confirmation)). An agent that cannot read files receives the paste form in every message that names the role file, and confirms by a line in its answer ([agents that cannot read files](#agents-that-cannot-read-files)).

An agent CLI starts only in a folder that the CLI already trusts. A CLI that asks for folder trust or an update submits the Enter of an injection to its own prompt, as measured in [evidence of the hold](messaging.md#evidence-of-the-hold).

## Start parameters

A terminal tab that runs an agent CLI takes these parameters of `core.layout.open` for the terminal plugin, in `params`:

- `program`: the name or the path of the agent CLI. Absent means that the tab starts the shell, as before.
- `args`: an array of texts, the arguments of the program. Absent means an empty array.
- `role`: `null` or an agent role identifier. A tab with a role takes the adapter of `program` ([launch adapters](#launch-adapters)), and its role file is written before the launch, and its identity is the identity file for Claude Code or the inline text for Codex ([role file](#role-file)).

Core composes the argument list: the adapter arguments of `program`, with the identity (the file path for Claude Code, the inline text for Codex), come first, and then `args` in their order. A `role` with a `program` that has no adapter is refused with `program <name> has no launch adapter`, and no program starts. A `role` without a `program` is refused with `role requires program`, and `args` without a `program` is refused with `args require program`; in both cases no program starts.

Sidecar protocol change: the `open` request of a terminal session gains the members `program` (text) and `args` (array of texts) beside `directory`. With `program` present, the sidecar starts `program` with `args` as its argument vector, without a shell, and resolves `program` through the PATH of the environment that the application gives its sidecars ([sok setup environment](cli.md#commands)). A `program` that the PATH does not contain fails the start with the error `program not found: <program>`. Without `program`, the sidecar starts the shell as before. The terminal page sends the composed `program` and `args` and no other argument of the launch. Each terminal sidecar implements this change; its follow-up items are tracked in [features](../features.md).

## Stable identity

The stable identity is the text that a tab's launch delivers. It is written in English and has this form, where `<role file>` is the absolute path of the role file of the tab:

> [soksak role] Your role is defined in the file <role file>. Read the whole file before your first answer. Read the file again when a message starts with [soksak role] and says that the role changed. Do not save your role in any persistent memory. The role file is the only record of your role.

- The identity names the message prefix, so the agent recognizes a change message as the authority over its role.
- The identity names the path of the role file, so the agent reads the role from the file.
- The path is absolute and comes from the configuration directory of the application. A path with a quote or a control character is refused with `configuration directory <path> holds a quote or a control character`, and the launch starts no program.
- The identity is the same text in a launch and in the first message of a CLI without an adapter.

## Role file

- Path: `<config-dir>/agents/<surface>/role.md`, where `<config-dir>` is the configuration directory of the application ([installation layout](installation.md#installation-layout)) and `<surface>` is the surface of the tab. A surface identifier that contains a path separator, a `..` segment or a control character is refused with `surface "<value>" holds a path part or a control character`, where `<value>` is the surface identifier. Nothing is written when it is refused.
- Layout, in order:
  1. the first line: ``Read this whole file. Follow the role it defines. Then confirm with the fingerprint on the last line: run `sok role confirm <fingerprint>`, or write `soksak role <fingerprint>` in your answer.``;
  2. the definition text, exactly as stored in `roles.json`;
  3. the last line: the fingerprint.
  Each line ends with one line feed. A definition whose stored text lacks a final line feed gets one in the file; the fingerprint is computed over the stored text unchanged. A tab without a role has no role file and no identity ([tab role state](#tab-role-state)).
- Fingerprint: the first 16 lowercase hexadecimal characters of the SHA-256 digest of the UTF-8 bytes of the role identifier, one line feed (U+000A), and the definition text as stored. The identifier has no line break, so the separator is unambiguous. The fingerprint depends only on the identifier and the text: the same definition always gives the same fingerprint.
- Length: soksak writes the definition as it is, whatever its length. The spec recommends a short definition, because the agent reads the whole file at each change.
- The file belongs to the configuration directory and never to a repository of the person.
- Mode: the directory `<config-dir>/agents/<surface>/` is created with mode 0700, and `role.md` and the identity file are written with mode 0600. The mode of the temporary file is checked before the rename, so a file with another mode is never visible under the final name; the write then fails with `role file <path>: mode <mode> is not 0600` and removes the temporary file. A failed write step fails with `role file <path>: write failed: <os error>`, where `<path>` is the path that the step used.
- Atomic write: the host writes the new content to a temporary file named `.role-<random>.tmp` in the same folder and renames it over `role.md`. A reader sees the whole earlier file or the whole new one. Before its first write, a launch deletes the files of its surface folder whose names match `.role-*.tmp`, which an earlier crash left.
- Writer: the host writes the file; the terminal page creates no file. A failed write is an error with the text `role file <path>: write failed: <os error>`, which names the path and the reason. A failed role file or identity file write at a launch is refused with that text, and no program starts.
- Lifecycle: the host creates the directory before the launch. When the tab is removed from the layout, the host stops the program of the tab, waits for a write in progress to end, refuses a later role change of that tab with `tab <tab> was removed; its role cannot change`, and removes the directory. A failed rename after the removal removes the temporary file and is logged. The held messages of the removed tab are discarded, each with a delivery record of state `skipped` and reason `tab removed`. A removed tab cannot be resumed.
- Launch record: each launch stores the identity path in the session record of the tab. A resume of a session launched with the identity by flag checks that the stored path equals the current path and that the file exists; an adapter-less session re-sends its first message with the current path, so no check applies; a mismatch, which happens when the configuration directory was moved, or a missing file fails the resume with `identity path <stored> is not the current path <current>` when the path differs, or with `identity file <path> is missing` when the file is absent.

The identity file of the Claude Code adapter is `<config-dir>/agents/<surface>/identity.txt`, written at the launch beside the role file by the same write rule. The Codex adapter passes the identity text inline, quoted as a TOML string.

## Fingerprint reference cases

The algorithm is tested by the shared case file `docs/spec/cases/agent-roles/fingerprint.json`. Each case gives the identifier, the definition text and the expected fingerprint. The same file pins the English texts of the role file first line, the identity, the change message, the reread request, the first message suffix, the lead text of the paste form and the fingerprint line, and the [phrase test](#phrase-test) compares the host output with them after the placeholders are filled. The Go host and the Rust host each run every case and compare the fingerprint they compute. The cases include non-ASCII text and line breaks, so the UTF-8 encoding and the separator are both checked. The values are the same for both hosts.

## Role definitions

A role definition is the text that a role file holds. soksak holds the definitions in one stored file, `<config-dir>/roles.json`, beside `settings.json` and `projects.json` ([stored data formats](installation.md#stored-data-formats)). The file is numbered: its member `format` is `1`, and a reader accepts only that number and refuses another with `<file>: roles: format must be 1, found <value>`.

```json
{"format": 1, "roles": {"reviewer": {"text": "You review the changes of the other agents in this project."}}}
```

- A role identifier matches `[a-z][a-z0-9-]*` with at most 64 characters.
- `text` is UTF-8 text, written into the role file as it is.
- A role that a tab names and `roles.json` does not define is refused with `unknown agent role <id>`, and the tab keeps its earlier role.

`<file>` is the path of `roles.json`. A read or a write refuses the whole file with one of these texts, which names the file, and writes nothing:

- `<file>: roles: format must be 1, found <value>`: `<value>` is the compact JSON text of the member `format`, or `null` when the member is absent or the document is not an object.
- `<file>: roles: unknown field <name>`: a top-level member other than `format` and `roles`.
- `<file>: roles: roles must be an object`
- `<file>: roles: invalid role identifier <id>`: the first identifier that does not match, in the sorted order of the identifiers.
- `<file>: roles: role <id> must be an object`
- `<file>: roles: role <id> unknown field <name>`: a member of a definition other than `text`.
- `<file>: roles: role <id> text must be a string`

The editor of the file is a separate checklist item.

## Tab role state

Each tab of an agent CLI has one agent role, or none. The stored role record of the tab is an entry of the layout of `projects.json`, and it holds:

- `role`: the role identifier, or `null`;
- `generation`: an integer that starts at 1 and rises by one at each change of the role or of its definition;
- `fingerprint`: the fingerprint of the current role file;
- `confirmedFingerprint`: the fingerprint that the agent confirmed, or `null`;
- `requests`: the number of reread requests sent since the last change or confirmation, 0 to 2.

Adding this record changes the form of `projects.json`, so its format number rises from 2 to 3 as [stored data formats](installation.md#stored-data-formats) requires. No migration is written, and the reader refuses format 2 with `<file>: projects: format must be 3, found 2`.

A role change is the command `core.tab.role {tab, role}`, which runs through the registry. Setting the role the tab already has, with the same definition, writes no file, changes no generation and sends no message, and answers the current `{role, generation, state, fingerprint}`. The one exception is state `unconfirmed`, where the same assignment sets the state to `pending` with `requests` at 0 and sends one reread request ([requests](#requests)).

A running tab cannot lose its role: `core.tab.role` with `role` `null` on a tab with a role is refused with the error `a running tab keeps its role; close the tab to remove it`. A tab launched without a role has no role file and no identity.

A change runs in this order, and each step starts only when the previous one succeeds:

1. the host writes the new role file under its temporary name, with the new fingerprint, and checks its mode;
2. the host stores the new `role`, `generation`, `fingerprint`, `confirmedFingerprint: null` and `requests: 0` in `projects.json`;
3. the host renames the temporary file to `role.md`;
4. the host publishes the status `core.tab.role` with `{role, generation, state: "pending", seq, fingerprint}`;
5. the page of the terminal sends the change message ([change message](#change-message)).

Failure rules: a failure in step 1 removes the temporary file and stores nothing. A failure in step 2 removes the temporary file, leaves the stored role unchanged and is reported. A failure in step 3 removes the temporary file and then restores the earlier record in `projects.json`; when the restore also fails, both errors are reported: the write error and `projects.json <path>: restore failed: <os error>`. When the host ends between steps, the next launch writes the role file from the record in `projects.json` and the definition text in `roles.json` before the CLI starts; a fingerprint that differs from the record refuses the write with `role file <path>: fingerprint differs from the record`.

The status `core.tab.role` has the value `{role, generation, state, seq, fingerprint}`: `state` is `pending`, `ready` or `unconfirmed`, `null` without a role; `fingerprint` is the fingerprint of the current role file, `null` without a role; and `seq` rises at each change. The replies of the role commands carry `fingerprint` too. The page composes the reread request from the `fingerprint` of the status, and no error text carries a fingerprint. The page follows the status with `runtime.status.watch` and does not poll.

Leadership of a plane does not change a role in this contract. [Groups](groups.md#model) states that the leader is a mark that changes no command, focus or drawing order. A caller that wants the leader of a plane to have a role sets it with `core.tab.role`. Whether the leader mark drives a role is a question for the person.

## Confirmation

The states are:

- `pending`: the role file holds a fingerprint that the agent has not confirmed. A role assignment, a role change and the launch of a tab with a role set this state.
- `ready`: `confirmedFingerprint` equals the fingerprint of the current role file.
- `unconfirmed`: two reread requests were sent and the agent has not confirmed ([requests](#requests)).
- `null`: the tab has no role.

A change sets the state back to `pending`, because its generation and fingerprint are new.

An agent confirms in one of two declared ways, and either one counts. The command form runs the declared command `core.tab.role.confirm {fingerprint}`, which [cli](cli.md#commands) exposes as `sok role confirm`:

- (a) the command `sok role confirm <fingerprint>`, for an agent with a shell. `sok` sends the request to the application with the surface that `agent.surface` answers for the process ([processes of a surface](sidecars.md#processes-of-a-surface)), so a process outside the tab cannot confirm for it.
- (b) a line `soksak role <fingerprint>` in the answer of the agent. The terminal plugin matches the line against the visible rows of the screen that `<plugin>.screen.read` reads, after each change of the visible rows that it receives, so a visible line of tool output also counts. A row matches when its text, without the spaces at both ends, is the line. The pattern is the exact line form with 16 lowercase hexadecimal characters; the bare fingerprint line of the file does not match. The match confirms through the same per-surface serialization. A confirmation line that the terminal wraps at its width does not match; the state stays `pending` and a reread request asks again. A line whose row scrolls off the screen before the update is read does not match either. The line shows that the agent holds the fingerprint of the current file; it does not show that the agent read the file.

Each adapter and each CLI declares which of the two ways apply ([launch adapters](#launch-adapters)). A way that does not apply to an agent is not offered to it.

soksak judges a confirmation inside the serialization of the surface, against the state at its turn:

- a value that is not 16 lowercase hexadecimal characters is refused as an invalid-argument error with `fingerprint <value> is not 16 lowercase hexadecimal characters` before the serialization. The stale rule below applies only to valid values;
- the fingerprint equals the current one, in state `pending` or `unconfirmed`: `confirmedFingerprint` is stored, the state becomes `ready`, `seq` rises, the requests counter is reset, and the held work messages are released;
- the fingerprint equals the current one, in state `ready`: nothing changes, and the answer is a success;
- the fingerprint differs from the current one, because it belongs to an earlier file: refused as stale, without a retry. The error is `stale fingerprint: read the role file again at <path>`, which names the path of the current role file. It names no fingerprint. The state stays as it was;
- a tab without a role, or a surface without a tab: refused with `surface "<value>" has no tab`, or, for a tab without a role, with `tab <tab> has no role`.

### Requests

The page watches the program state of the tab ([terminal state](terminal-state.md)). A reread request is a message that names the path of the role file and asks the agent to read the file and confirm with its last line. The change message and the first message are not counted as requests. While the state is `pending`, the page counts each report of the program that it is not busy:

- the first such report after the change message or the first message sends request 1 and sets the counter to 1; the assignment request in state `unconfirmed` and the resume request also wait for such a report, and each counts as request 1 of its cycle;
- the next such report sends request 2 and sets the counter to 2;
- the next such report, with the counter at 2, sets the state to `unconfirmed` and sends nothing.

The host reports `unconfirmed` through the error display path with the text `unconfirmed role: tab <tab> did not confirm the role file <path>`, and writes it to the application log. The state stays `unconfirmed` until the person assigns the role again. The person can assign the role again; that sets the state to `pending` with the counter at 0; the reread request is sent at the next not-busy report and counts as request 1, with no file write and no generation change ([idempotency](#idempotency)).

Each request names the same path and the same fingerprint, so it repeats without a change of result. No timer decides these steps. The counter is part of the stored record, so a restart does not reset it.

The not-busy report that each CLI gives is part of its adapter verification. An agent whose CLI gives no such report stays `pending` and shows through the error display instead of passing.

## Held messages

While the state is `pending` or `unconfirmed`, the page holds the work messages of the tab, which are the agent messages of the registration. Held messages keep their order and are injected one at a time when the state becomes `ready`. Each is delivered once: the delivery record keys it by its file name. The first message of a session and the requests are not held by the `role-pending` hold; the `blocked` hold of [messaging](messaging.md#hold-for-the-person) still holds them while a prompt is open. The hold reason `role-pending` is named in the hold list of [messaging](messaging.md#hold-for-the-person).

A change while messages wait keeps them queued; they are delivered after the `ready` of the new generation.

## Idempotency

These rules act on the stored role record of the tab, not on the file write: the idempotency of each step, the generation, the per-surface serialization of the [concurrency](#concurrency) and the stale-fingerprint refusal are judged on that record, and the file is written only when the record decides it.

Every step of the role handshake repeats without a change of the result:

- a repeated `core.tab.role` with the same role and definition writes no file, changes no generation and sends no message. In state `unconfirmed` it starts the one reread request of [requests](#requests); a repeat of that call in state `pending` changes nothing;
- a new generation is made only when the role or its definition changes;
- `sok role confirm` or the answer line with the current fingerprint, repeated, answers `ready` and changes nothing, including `seq`;
- a reread request that is sent again names the same path and the same fingerprint, so reading the file again and confirming again gives the same `ready`;
- a work message is delivered exactly once, even when `ready` is reached twice;
- after a restart of the application while the program keeps running, the state is rebuilt from the stored record and the file: `ready` when `confirmedFingerprint` equals the fingerprint of the file; otherwise `pending` with the stored request count when that count is 0 or 1, and `unconfirmed` when it is 2. A file whose fingerprint differs from the record is rewritten from `roles.json` first, and a rewrite whose fingerprint still differs from the record is refused with `role file <path>: fingerprint differs from the record`;
- a resume gives `pending` with the same fingerprint, because a resume keeps the launch text but not the proof that the agent read the file. The host clears `confirmedFingerprint` and the requests counter at the resume, and the resumed tab sends one reread request at its next not-busy report, which counts as request 1; a new launch clears `confirmedFingerprint` and the counter as a resume does.

A role A changed to B and back to A has the fingerprint of A again, so a confirmation of it is correct: the content is the same.

### Tests of the repetitions

- Repeated assignment of the same role and definition in state `pending` or `ready`: no write of the role file (its inode and content stay the same), no new generation, no change message, and the answer equals the current `{role, generation, state, fingerprint}`.
- Repeated assignment in state `unconfirmed`: the state becomes `pending` with the counter at 0, one reread request is sent, and no file is written and no generation changes; a repeat of that assignment in `pending` writes nothing.
- Changed definition with the same role: a new generation and one change message.
- Changes A to B to A: the fingerprint of A returns, and a confirmation of it gives `ready`.
- Repeated confirmation with the current fingerprint: `ready` both times, and `seq` unchanged after the second.
- Confirmation of an earlier fingerprint after a change: refused as stale with `stale fingerprint: read the role file again at <path>`; the error names no fingerprint.
- A confirmation value that is not 16 lowercase hexadecimal characters: refused as invalid input with `fingerprint <value> is not 16 lowercase hexadecimal characters`, and the stale error is not sent.
- Two reread requests without confirmation: `unconfirmed`, one error-display record and one log record, and no third request.
- Work message with `ready` reached twice: injected once, keyed by its file name.
- Restart with a stored confirmation: `ready` without input; with a stored counter of 1: `pending` with that counter; with a stored counter of 2: `unconfirmed` without input.
- Resume: `pending`, the same fingerprint, the confirmation and the counter cleared, one reread request.

These are unit tests with real files and the real `sok` command; no agent CLI runs in them. The host tests run in the Go host package and in the Rust host package. The page tests run in the terminal plugin repository, which owns the page.

## Concurrency

Role operations of one surface are serialized by one owner in the host, in arrival order. The operations are the assignment or change of the role, the confirmation (both ways), the request, the reread and the removal of the tab; a confirmation after a removal is refused with `tab <tab> has no role`. Each change raises the generation, and a confirmation is judged under the same serialization, so it is judged against the state at its turn.

- The role file is written atomically, so a reader sees the whole earlier file or the whole new one.
- Consecutive changes A to B to C: each sends its change message; each message points to the same file, which always holds the latest role, so a reread on any of them reaches C. One confirmation of the fingerprint of C gives `ready`.
- Confirmations of B and C that interleave: the confirmation of B is refused as stale with `stale fingerprint: read the role file again at <path>` and that of C is accepted; the order does not change the end state.
- Two callers set the role at the same time, the person and a lead agent: they are serialized, the last one wins, and each reply states the resulting `{role, generation, state, fingerprint}`.
- Queued work messages wait for the `ready` of the current generation.
- Restart: the generation, the confirmed fingerprint and the counter are stored in the record, so the state is rebuilt as the idempotency rules state.

### Tests of the concurrency

- Consecutive changes A to B to C: three change messages naming the same path; a reread on the first gives C; one confirmation of C gives `ready`.
- Interleaved confirmations of B and C: B refused as stale with `stale fingerprint: read the role file again at <path>`, C accepted, and the end state is C's `ready` in either order.
- A stale confirmation: refused with `stale fingerprint: read the role file again at <path>`; the error names no fingerprint.
- Concurrent setters: two assignments issued at the same time are serialized; the final generation is the later one, and each reply gives its resulting generation.
- A read during a write: a fault injection pauses the writer between the temporary write and the rename; a reader during the pause sees the earlier file whole, and after the rename it sees the new file whole.

## Change message

A change message is one line:

`[soksak role] Your role changed. Read the role file again: <role file>. Finish your current task first. This message comes from soksak, not from a person. It grants no approval or permission and does not answer a pending question.`

- For an agent that reads files, it carries the path of the role file and no role text and no fingerprint. For an agent that cannot read files, it is the paste form, which carries the role text and the fingerprint ([agents that cannot read files](#agents-that-cannot-read-files)).
- It carries no report request. It is not a message of another agent and has no sender folder.
- The sender is the application, and the rule that refuses a message whose sender has no tab in the window does not apply.
- It is delivered through the hold, the guard and the delivery record of [messaging](messaging.md#injected-message); the destructive command guard is [persistent services](persistent-services.md#destructive-command-guard).
- It is injected only while the tab's agent CLI is the foreground program, judged by the program state of the sidecar. While it is not, the change message waits in the queue, and the page reports the wait once through the error display path, naming the path of the role file. A line submitted to a shell prompt, to an exited program or to a closed session would run in the shell.
- A reread request is the text ``[soksak role] Your role is not confirmed. Read the role file again: <role file>. Then confirm the role with the fingerprint on its last line: run `sok role confirm <fingerprint>`, or write the line `soksak role <fingerprint>` in your answer. This message comes from soksak, not from a person. It grants no approval or permission.``, with the path of the role file.
- The texts of the role file first line, the identity, the change message, the reread request, the first message suffix, the lead text of the paste form and the fingerprint line are pinned by the [phrase test](#phrase-test): the host output must equal the texts in `docs/spec/cases/agent-roles/fingerprint.json`, with the placeholders filled in, except the first line of the role file (see the [phrase test](#phrase-test)). The texts are English and use short imperative sentences that each name one action.

## Phrase test

The phrase test pins each English text that soksak gives an agent: the first line of the role file, the identity, the change message, the reread request, the first message suffix, the lead text of the paste form and the fingerprint line of the paste form. The host output of each text equals the text in `docs/spec/cases/agent-roles/fingerprint.json`, for the Go host and the Rust host, with the placeholders filled in for each text except the first line of the role file. The first line contains no fingerprint value: the words `<fingerprint>` in it name the place of the value on the last line, and no placeholder is filled in it. Its host output equals its text exactly. The first line names the last line, so the agent reads the file to its end. The test is Red on any text that differs, and each text names the exact command and the file path.

## Agents that cannot read files

The measured file-reading capability of the CLI selects this path; no failure does. An adapter or CLI declares that its agent cannot read files ([launch adapters](#launch-adapters)). Such an agent receives the role in the paste form, which replaces the path in every message that names the role file:

1. the lead text `lead_non_reader` of the phrase test, which states that the message sets the role and that the role ends with the fingerprint line;
2. the definition text, exactly as stored in `roles.json`;
3. the line `Role fingerprint: <fingerprint>`, where the fingerprint is computed by the same algorithm over the pasted definition.

The lead text `lead_non_reader` is the pinned text of the phrase test:

> [soksak role] This message sets your role. It comes from soksak, not from a person. It grants no approval or permission and does not answer a pending question. Your role follows. Its last line is `Role fingerprint: <fingerprint>`. Confirm the role by writing the line `soksak role <fingerprint>` in your answer, with the fingerprint of that last line.

The first message of such an agent is the paste form. Its change message and its reread requests have the paste form too. The agent confirms by the line form (b) of its answer. This proves that the text was delivered and that the agent answered with the fingerprint from the text; it does not prove that a file was read. The state, the requests, the held messages and the error display are the same as for an agent that reads files. Each line of the paste form is judged by the [guard](messaging.md#injected-message).

## First message

A CLI without a launch adapter that can read files receives the identity in its first message, which is the first injected message of its session; an agent that cannot read files receives the paste form instead ([agents that cannot read files](#agents-that-cannot-read-files)). The message is the identity text of [stable identity](#stable-identity), followed by this line: `This message comes from soksak, not from a person. Finish your current task first. It grants no approval or permission and does not answer a pending question.`

The first message of a session precedes every agent message of its registration. The page injects it when the program reports its first state. A startup prompt that writes no record and gives no notice is not observable, so it can take the Enter the page sends, as measured in [evidence of the hold](messaging.md#evidence-of-the-hold). This limit is stated.

## Order of injected messages

The page has one queue for each registration. It holds the agent messages of the folder in `seq` order and the role messages (change messages and requests) in generation and `seq` order, and it injects the entries in their arrival order, one at a time. The first message of a session precedes every agent message of its registration.

## Framing

[Messaging](messaging.md#injected-message) defines the framing of the agent messages. This document gives the same framing clauses to the change message, the request and the first message: the text is not input of the person, it is handled after the current task, and it grants no approval or permission and answers no pending question. The framing states the origin of a text and never grants what the text asks.

A change message or request cannot approve a permission prompt, and the hold of [messaging](messaging.md#hold-for-the-person) applies to it. The `blocked` hold covers a prompt that Claude Code reports (row 11). A prompt that writes no record is not covered; its measurement is in [messaging](messaging.md#evidence-of-the-hold).

## Resume

A resume starts the program with its own command, and the launch adapter does not change the session. The resumed tab sends one reread request, which names its role file and counts as request 1, and the state is `pending` with the same fingerprint. An adapter-less tab sends the identity of its first message again after a resume, because the resumed process has no identity from its first start.

| Case | Identity | Message |
| --- | --- | --- |
| New launch by the tab's launch command, adapter CLI | Given by the launch flag | Change message after the program state is reported |
| New launch by the tab's launch command, CLI without adapter | First message | None separately |
| Resume by the tab's launch command | Kept from the session start, or first message for a CLI without adapter | One reread request |
| A command typed by the person into the tab's shell, outside the launch command | None: soksak gives no identity | None |

## Change of a running agent

A change is one role change, one atomic rewrite of the role file, one new generation and one change message. The agent applies the change when it reads the file, which the change message makes it do (rows 8 and 9). No restart is needed, and a change never ends the program.

A CLI that the person starts by hand in a tab, as a second agent in the same shell, has no identity from soksak; it is outside the contract. The behaviour of a change message that arrives while the agent is busy is not measured for either CLI; until it is measured, messages are injected only after the program reports that it is not busy.

## Tests

### Unit tests

- The launch adapters: the argument list and the identity file that each adapter produces, compared with the expected values. No agent CLI runs in a unit test.
- The terminal launch path: a recording program that the launch starts as the agent command. It records the arguments and the first input and does nothing else; the launch starts it as a real process.
- The role file write: real files. A fault point in the host writer fails the write at step 1, step 2 and step 3, and each case asserts `role file <path>: write failed: <os error>` and states the stored record and the file afterwards.
- Mode: the temporary file is created with mode 0600 and the directory with 0700; a changed mode before the rename makes the write fail with `role file <path>: mode <mode> is not 0600` without renaming.
- Phrase test: the host output of each pinned text equals the text in `docs/spec/cases/agent-roles/fingerprint.json`, as described in the [phrase test](#phrase-test).
- Paste form: a change to an agent that cannot read files, and its first message, contain the lead text, the definition text exactly and the fingerprint line, and the fingerprint is computed over the pasted definition.
- Layout and fingerprint: the layout has the first line, the definition and the last line; a definition without a final line feed gets one in the layout and its fingerprint is computed over the stored text. The Go host and the Rust host compute the fingerprint of each case in `docs/spec/cases/agent-roles/fingerprint.json`, and the values are equal. The cases include non-ASCII text and line breaks.
- Length: a long definition (5,000 characters) is written whole, and its fingerprint covers all of it.
- Path: a configuration directory path with a quote or a control character is refused with `configuration directory <path> holds a quote or a control character`; a surface identifier with a path separator, a `..` segment or a control character is refused with `surface "<value>" holds a path part or a control character`, and nothing is written.
- Launch failure: a failed identity or role file write at a launch is refused with `role file <path>: write failed: <os error>` and starts no program.
- Leftover files: a launch deletes the `.role-*.tmp` files of its surface folder before it writes.
- Removal: a removed tab stops its program, refuses a later change with `tab <tab> was removed; its role cannot change`, and discards its held messages with one `skipped` record each.
- Resume: the stored path equal to the current one and the file present start the program; a different path fails the resume with `identity path <stored> is not the current path <current>`, and a missing file with `identity file <path> is missing`.
- Confirmation: both ways, `sok role confirm` and the answer line, give `ready` for the current fingerprint and the stale error `stale fingerprint: read the role file again at <path>` for an older one; each way is tested only where its adapter declares it.
- Requests: the first and second request, the `unconfirmed` state, and the error-display record for each.
- Format: the `projects.json` reader refuses format 2 with `<file>: projects: format must be 3, found 2`, and the writer writes format 3.
- Repetition and concurrency: the tests of [idempotency](#tests-of-the-repetitions) and [concurrency](#tests-of-the-concurrency).
- `roles.json`: format number, identifier rule and unknown role refusal, each with its error text: `<file>: roles: format must be 1, found <value>`, `<file>: roles: invalid role identifier <id>` and `unknown agent role <id>`.

### Acceptance

The acceptance target is `test-app-agent-role`. Core declares no window check that names an agent CLI or a plugin, so the target is declared by the repository of the terminal plugin. It runs the real Claude Code and Codex in an application with that plugin installed, in a disposable configuration directory and a project folder that the CLI already trusts. It runs only locally, needs a display, and runs only when the person runs it. The window-check rules of [AGENTS](../../AGENTS.md#verification) apply, and it is not part of `make test-app`.

The target judges the role state only. For each CLI it:

1. writes a role definition holding a random nonce of the run, opens a tab with the CLI and the role through `core.layout.open`, and waits for the status `core.tab.role` and the program state, not for a timer;
2. waits for `ready`, and requires that the confirmed fingerprint in the record equals the fingerprint that the target computes from `roles.json` with the algorithm of this document; the nonce is unknown before the agent reads the file, so this proves that the agent read the last line of the file;
3. changes the role with `core.tab.role` to a new definition with a new nonce, and waits for `ready` for the new generation with the new fingerprint;
4. resumes the session and waits for `ready` with the same fingerprint after the reread request;
5. for an agent declared to use only line form (b), repeats step 2 with the answer line, and for an agent with a shell, repeats it with `sok role confirm`;
6. requires that no nonce appears in the persistent memory files of the CLI or in `AGENTS.md` and `CLAUDE.md` of the project folder.

An agent that never confirms ends in `unconfirmed` and the target reports `unconfirmed role: tab <tab> did not confirm the role file <path>`; the target never reports a pass for an unconfirmed state.

A missing `claude` or `codex` command fails the target with `command not found: <program>`, and no test is skipped. Each test has its own time limit and prints `running`, `finished`, `passed` or `failed` with its elapsed time ([AGENTS](../../AGENTS.md#verification)).

## Verification boundaries

The adapter table is verified for each CLI when the acceptance target runs for it, and again for each new version of the CLI that changes its launch options. Until the target exists and its run is recorded in [features](../features.md), the claims that depend on it are unverified.

## Review

Objections were raised against each revision of this decision and are answered below. Objections about wording are answered by the wording of the sections above.

Answered and applied:

- The change message is not a reread request; the count of requests starts at the first not-busy report after the change message.
- An assignment of the same role in state `unconfirmed` starts one reread request; the other states write nothing.
- A line in the answer shows that the agent holds the fingerprint of the current file, not that it read the file.
- The fingerprint reference file pins the texts of the role file, the identity, the change message, the reread request, the first message suffix and the paste-form texts.
- A restart with a stored request count of 2 gives `unconfirmed`.
- A running tab cannot lose its role.
- The first message suffix is a pinned text.
- The hold reason `role-pending` is named in the hold list of messaging.
- The tool output of the program counts for the line form, and the spec states it.
- A confirmation value that is not 16 lowercase hexadecimal characters is invalid input and is not compared with the stale rule.
- A stored definition without a final line feed gets one in the file; its fingerprint uses the stored text.
- A surface identifier that contains a path separator, a `..` segment or a control character is refused with `surface "<value>" holds a path part or a control character`, and nothing is written.
- A surface is one tab, so its role file belongs to that tab only.
- A failed identity or role file write at a launch starts no program.
- A removed tab discards its held messages, each with a `skipped` record.
- A launch deletes leftover `.role-*.tmp` files before it writes.
- A restart with the program running keeps the stored record; a resume clears it.
- Tests name their owning packages.
- The English and Korean texts state the same rules.
- A change to an agent that cannot read files carries the paste form with the role text; its confirmation is the fingerprint of the pasted definition.
- The start parameters `program`, `args` and `role` reach the sidecar `open` request, and a role with a program that has no adapter is refused.
- The status `core.tab.role` and the role command replies carry `fingerprint` and `generation`, so the page composes the reread request from them.
- The line form is matched against the visible rows that `<plugin>.screen.read` reads after each change of the visible rows; a wrapped line or a line that scrolls off does not match.
- The memory statement is limited to the measured launch options.

Answered without change:

- The paste path for an agent that cannot read files and the first message for a CLI without an adapter are delivery forms selected by the CLI's measured capability, not failures; they add no path for an agent that can use the file path.

- A confirmation line that the terminal wraps does not match, and the state stays `pending`; a reread request asks again. The spec already states this, so no rule is added.
- Product names stay in the adapter table, because the table states the launch form of each configured CLI.

Open:

- The terms `fingerprint`, `generation`, `reread request`, `unconfirmed`, `confirmation`, `role message`, `delivery record` and `error display` are listed in the kit term list by a kit commit. The core term check reads them after the kit release and its pin, which the checklist tracks.
