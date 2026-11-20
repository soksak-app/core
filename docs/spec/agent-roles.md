# Agent roles

[한국어](agent-roles.ko.md)

This document defines how a tab of a terminal agent receives its role, and how soksak confirms that the agent has the role. Implementation and verification are tracked in [features](../features.md). Messages reach the agent through the injection path of [messaging](messaging.md#injected-message).

## Decision

- A tab that starts an agent CLI gives the CLI a stable identity through its launch adapter. The identity names the absolute path of the role file of the tab. The agent reads the role from that file; the role text is not pasted into the terminal when the agent can read files.
- The role file belongs to one surface and lies in the configuration directory of the application, never in a repository of the person. Keep a role definition short, because the agent reads the whole file at each change; soksak accepts a definition of any length. Its last line is the fingerprint of the role.
- The fingerprint is deterministic: the same role name and definition always give the same fingerprint. The agent reads it from the last line of the file; it never computes it.
- The agent confirms by one of two declared ways: the command `sok role confirm <fingerprint>`, or a line `soksak role <fingerprint>` in its answer. A role is `ready` only when soksak has received the current fingerprint.
- An agent that does not confirm gets two reread requests, each counted by an event, and then the state `unconfirmed` shows through the error display and waits for the person. No timer decides any step.
- A role assignment or change rewrites the role file atomically and sends a change message that names the path of the file. Operations of one surface are serialized in arrival order.
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

Rows 3 and 7 show only that the agent follows a change message that names the new role; they do not show that the agent reads a file. Each row is one run. Not measured for either CLI: a context compaction, a change message after a resume, a change message while the agent is busy, a subagent or a second session in the same tab, the confirmation commands and reread requests of this contract, and whether auto memory or the Codex memories are shared between sessions. The rule against persistent memory is an instruction only; no measured launch option of either CLI disables memory.

Claude Code reports a permission prompt as `blocked` through the program status of [terminal state](terminal-state.md) (row 11), so the `blocked` hold of [messaging](messaging.md#hold-for-the-person) holds the change messages and reread requests while the prompt is open.

## Launch adapters

A launch adapter is the part of a CLI launch that carries the stable identity. Only an adapter that adds to the built-in instructions of its CLI is used.

| CLI | Launch form | Effect on the built-in instructions | Status |
| --- | --- | --- | --- |
| Claude Code | `claude --append-system-prompt-file <identity file>` | Adds to the system prompt. The identity-only launch applies and the agent reads the role file (row 10). | In use |
| Codex | `codex --no-daemon -c developer_instructions="<identity>"` | Adds developer instructions beside the global `AGENTS.md`. The agent reads the role file after a change message (rows 4 and 8). | In use |
| Kimi | `--agent-file` | Not measured. | Candidate, not in use |
| Copilot | `--agent <name>` | Not measured. | Candidate, not in use |
| OpenClaw | `tui --local agent:<name>` | Not measured. | Candidate, not in use |
| Qwen | `--append-system-prompt` | Not measured. | Candidate, not in use |
| Goose | `session --system` | Not measured; the flag may replace the instructions. | Candidate, not in use |

A candidate is added after its launch behaviour is verified in the TUI: the instructions apply to a new session, they add to the built-in instructions, and a change message makes the agent read the role file again. A candidate that replaces the built-in instructions is not added.

Resume: `claude --resume <id>` and `codex resume --no-daemon <id>` keep the instructions of the session start and ignore the adapter flags of the resume command (rows 2 and 6). A launch adapter is used only at a new launch.

Each adapter and each CLI declares which confirmation ways apply to it ([confirmation](#confirmation)). An agent that cannot read files receives the role text in its first message and confirms by a line in its answer.

An agent CLI starts only in a folder that the CLI already trusts. A CLI that asks for folder trust or an update submits the Enter of an injection to its own prompt, as measured in [evidence of the hold](messaging.md#evidence-of-the-hold).

## Stable identity

The stable identity is the text that a tab's launch delivers. It is written in English and has this form, where `<role file>` is the absolute path of the role file of the tab:

> [soksak role] Your role is defined in the file <role file>.
> Read the whole file before your first answer.
> Read the file again when a message starts with [soksak role] and says that the role changed.
> Do not save your role in any persistent memory. The role file is the only record of your role.

- The identity names the message prefix, so the agent recognizes a change message as the authority over its role.
- The identity names the path of the role file, so the agent reads the role from the file.
- The path is absolute and comes from the configuration directory of the application. A path with a quote or a control character makes the launch refuse with an explicit error.
- The identity is the same text in a launch and in the first message of a CLI without an adapter.

## Role file

- Path: `<config-dir>/agents/<surface>/role.md`, where `<config-dir>` is the configuration directory of the application ([installation layout](installation.md#installation-layout)) and `<surface>` is the surface of the tab.
- Layout, in order:
  1. the first line: ``Read this whole file. Follow the role it defines. Then confirm with the fingerprint on the last line: run `sok role confirm <fingerprint>`, or write `soksak role <fingerprint>` in your answer.``;
  2. the definition text, exactly as stored in `roles.json`;
  3. the last line: the fingerprint.
  Each line ends with one line feed. A tab without a role has a file whose only line is the first line, followed by an empty last line; the fingerprint is then the empty string, which soksak treats as `null`.
- Fingerprint: the first 16 lowercase hexadecimal characters of the SHA-256 digest of the UTF-8 bytes of the role identifier, one line feed (U+000A), and the definition text as stored. The identifier has no line break, so the separator is unambiguous. The fingerprint depends only on the identifier and the text: the same definition always gives the same fingerprint.
- Length: soksak writes the definition as it is, whatever its length. The spec recommends a short definition, because the agent reads the whole file at each change.
- The file belongs to the configuration directory and never to a repository of the person.
- Mode: the directory `<config-dir>/agents/<surface>/` is created with mode 0700, and `role.md` and the identity file are written with mode 0600. The mode of the temporary file is checked before the rename, so a file with another mode is never visible under the final name; the write then fails with an explicit error and removes the temporary file.
- Atomic write: the host writes the new content to a temporary file in the same folder and renames it over `role.md`. A reader sees the whole earlier file or the whole new one.
- Writer: the host writes the file; the terminal page creates no file. A failed write is an error that names the path and the reason.
- Lifecycle: the host creates the directory before the launch. When the tab is removed from the layout, the host stops the program of the tab, waits for a write in progress to end, refuses a later role change of that tab with an explicit error, and removes the directory. A removed tab cannot be resumed.
- Launch record: each launch stores the identity path in the session record of the tab. A resume checks that the stored path equals the current path and that the file exists; a mismatch, which happens when the configuration directory was moved, or a missing file fails the resume with an explicit error that names the path.

The identity file of the Claude Code adapter is `<config-dir>/agents/<surface>/identity.txt`, written at the launch beside the role file by the same write rule. The Codex adapter passes the identity text inline, quoted as a TOML string.

## Fingerprint reference cases

The algorithm is tested by the shared case file `docs/spec/cases/agent-roles/fingerprint.json`. Each case gives the identifier, the definition text and the expected fingerprint, and The Go host and the Rust host each run every case and compare the fingerprint they compute. The cases include non-ASCII text and line breaks, so the UTF-8 encoding and the separator are both checked. The values are the same for both hosts.

## Role definitions

A role definition is the text that a role file holds. soksak holds the definitions in one stored file, `<config-dir>/roles.json`, beside `settings.json` and `projects.json` ([stored data formats](installation.md#stored-data-formats)). The file is numbered: its member `format` is `1`, and a reader accepts only that number and refuses another with `<file>: roles: format must be 1, found <value>`.

```json
{"format": 1, "roles": {"reviewer": {"text": "You review the changes of the other agents in this project."}}}
```

- A role identifier matches `[a-z][a-z0-9-]*` with at most 64 characters. Another identifier is refused with an error that names it.
- `text` is UTF-8 text, written into the role file as it is.
- A role that a tab names and `roles.json` does not define is refused with `unknown agent role <id>`, and the tab keeps its earlier role.

The editor of the file is a separate checklist item.

## Tab role state

Each tab of an agent CLI has one agent role, or none. The stored role record of the tab is an entry of the layout of `projects.json`, and it holds:

- `role`: the role identifier, or `null`;
- `generation`: an integer that starts at 1 and rises by one at each change of the role or of its definition;
- `fingerprint`: the fingerprint of the current role file;
- `confirmedFingerprint`: the fingerprint that the agent confirmed, or `null`;
- `requests`: the number of reread requests sent since the last change or confirmation, 0 to 2.

Adding this record changes the form of `projects.json`, so its format number rises from 2 to 3 as [stored data formats](installation.md#stored-data-formats) requires. No migration is written, and the reader refuses format 2.

A role change is the command `core.tab.role {tab, role}`, which runs through the registry. Setting the role the tab already has, with the same definition, writes no file, changes no generation and sends no message; it answers the current `{role, generation, state}`.

A change runs in this order, and each step starts only when the previous one succeeds:

1. the host writes the new role file under its temporary name, with the new fingerprint, and checks its mode;
2. the host stores the new `role`, `generation`, `fingerprint`, `confirmedFingerprint: null` and `requests: 0` in `projects.json`;
3. the host renames the temporary file to `role.md`;
4. the host publishes the status `core.tab.role` with `{role, generation, state: "pending", seq}`;
5. the page of the terminal sends the change message ([change message](#change-message)).

Failure rules: a failure in step 1 removes the temporary file and stores nothing. A failure in step 2 removes the temporary file, leaves the stored role unchanged and is reported. A failure in step 3 after step 2 restores the earlier record in `projects.json` before the error is reported. When the host ends between steps, the next launch writes the role file from `projects.json` before the CLI starts.

The status `core.tab.role` has the value `{role, generation, state, seq}`: `state` is `pending`, `ready` or `unconfirmed`, `null` without a role, and `seq` rises at each change. The status and the replies never carry the fingerprint. The page follows the status with `runtime.status.watch` and does not poll.

Leadership of a plane does not change a role in this contract. [Groups](groups.md#model) states that the leader is a mark that changes no command, focus or drawing order. A caller that wants the leader of a plane to have a role sets it with `core.tab.role`. Whether the leader mark drives a role is a question for the person.

## Confirmation

The states are:

- `pending`: the role file holds a fingerprint that the agent has not confirmed. A role assignment, a role change and the launch of a tab with a role set this state.
- `ready`: `confirmedFingerprint` equals the fingerprint of the current role file.
- `unconfirmed`: two reread requests were sent and the agent has not confirmed ([requests](#requests)).
- `null`: the tab has no role.

A change sets the state back to `pending`, because its generation and fingerprint are new.

An agent confirms in one of two declared ways, and either one counts. The command form runs the declared command `core.tab.role.confirm {fingerprint}`, which [cli](cli.md#commands) exposes as `sok role confirm`:

- (a) the command `sok role confirm <fingerprint>`, for an agent with a shell. `sok` sends the request to the application with the surface that the process chain of the agent gives ([processes of a surface](sidecars.md#processes-of-a-surface)), so a process outside the tab cannot confirm for it.
- (b) a line `soksak role <fingerprint>` in the answer of the agent. The terminal plugin matches that line in the output of the session and confirms through the same per-surface serialization. The fingerprint exists only as the last line of the file, and the file does not show a joined or echoed form that could be pasted, so the line shows that the agent read the fingerprint from the file.

Each adapter and each CLI declares which of the two ways apply ([launch adapters](#launch-adapters)). A way that does not apply to an agent is not offered to it.

soksak judges a confirmation inside the serialization of the surface, against the state at its turn:

- the fingerprint equals the current one, in state `pending` or `unconfirmed`: `confirmedFingerprint` is stored, the state becomes `ready`, `seq` rises, the requests counter is reset, and the held work messages are released;
- the fingerprint equals the current one, in state `ready`: nothing changes, and the answer is a success;
- the fingerprint differs from the current one, because it belongs to an earlier file: refused as stale, without a retry. The error names the path of the current role file and says to read it again. It names no fingerprint. The state stays as it was;
- a tab without a role, or a surface without a tab: refused with an explicit error that names the surface.

### Requests

The page watches the program state of the tab ([terminal state](terminal-state.md)). A reread request is a message that names the path of the role file and asks the agent to read the file and confirm with its last line. It is sent when the state is `pending` and:

- the change message or the first message has been injected and the program has reported that it is not busy: this is the first request, counted by one;
- the program reports that it is not busy again after the first request, with the state still `pending`: this is the second request.

After the second request, a program that reports that it is not busy again with the state still `pending` moves the state to `unconfirmed`. The host reports `unconfirmed` through the error display path, writes it to the application log, and sends no further request. The state waits for the person. The person can assign the role again; that reissues the change message once and resets the requests counter to 0, with no file write and no generation change ([idempotency](#idempotency)).

Each request names the same path and the same fingerprint, so it repeats without a change of result. No timer decides these steps. The counter is part of the stored record, so a restart does not reset it.

The not-busy report that each CLI gives is part of its adapter verification. An agent whose CLI gives no such report stays `pending` and shows through the error display instead of passing.

## Held messages

While the state is not `ready`, the page holds the work messages of the tab, which are the agent messages of the registration. Held messages keep their order and are injected one at a time when the state becomes `ready`. Each is delivered once: the delivery record keys it by its file name. The first message of a session and the requests are not held. The hold reason is `role-pending`, which [messaging](messaging.md#hold-for-the-person) must name in its list of holds; that change belongs to the implementation.

A change while messages wait keeps them queued; they are delivered after the `ready` of the new generation.

## Idempotency

Every step of the role handshake repeats without a change of the result:

- a repeated `core.tab.role` with the same role and definition writes no file, changes no generation and sends no message;
- a new generation is made only when the role or its definition changes;
- `sok role confirm` or the answer line with the current fingerprint, repeated, answers `ready` and changes nothing, including `seq`;
- a reread request that is sent again names the same path and the same fingerprint, so reading the file again and confirming again gives the same `ready`;
- a work message is delivered exactly once, even when `ready` is reached twice;
- after a restart of the application or of the agent, the state is rebuilt from the stored record and the file: `ready` when `confirmedFingerprint` equals the fingerprint of the file, otherwise `pending` with the stored request count. A file whose fingerprint differs from the record is rewritten from the record first;
- a resume gives `pending` with the same fingerprint, because a resume keeps the launch text but not the proof that the agent read the file. The host clears `confirmedFingerprint` and the requests counter at the resume, and the resumed tab sends one reread request.

A role A changed to B and back to A has the fingerprint of A again, so a confirmation of it is correct: the content is the same.

### Tests of the repetitions

- Repeated assignment of the same role and definition: no write of the role file (its inode and content stay the same), no new generation, no change message, and the answer equals the current `{role, generation, state}`.
- Changed definition with the same role: a new generation and one change message.
- Changes A to B to A: the fingerprint of A returns, and a confirmation of it gives `ready`.
- Repeated confirmation with the current fingerprint: `ready` both times, and `seq` unchanged after the second.
- Confirmation of an earlier fingerprint after a change: refused as stale; the error names the file and no fingerprint.
- Two reread requests without confirmation: `unconfirmed`, one error-display record and one log record, and no third request.
- Repeated assignment in state `unconfirmed`: one change message, no file write, no generation change, and the counter reset.
- Work message with `ready` reached twice: injected once, keyed by its file name.
- Restart with a stored confirmation: `ready` without input; with a stored counter of 1: `pending` with one request counted.
- Resume: `pending`, the same fingerprint, the confirmation and the counter cleared, one reread request.

These are unit tests of the host and of the page with real files and the real `sok` command; no agent CLI runs in them.

## Concurrency

Role operations of one surface are serialized by one owner in the host, in arrival order. The operations are the assignment or change of the role, the confirmation (both ways), the request and the re-read. Each change raises the generation, and a confirmation is judged under the same serialization, so it is judged against the state at its turn.

- The role file is written atomically, so a reader sees the whole earlier file or the whole new one.
- Changes A to B to C in a row: each sends its change message; each message points to the same file, which always holds the latest role, so a re-read on any of them reaches C. One confirmation of the fingerprint of C gives `ready`.
- Confirmations of B and C that cross: the confirmation of B is refused as stale and that of C is accepted; the order does not change the end state.
- Two callers set the role at the same time, the person and a lead agent: they are serialized, the last one wins, and each reply states the resulting `{role, generation, state}`.
- Queued work messages wait for the `ready` of the current generation.
- Restart: the generation, the confirmed fingerprint and the counter are stored in the record, so the state is rebuilt as the idempotency rules state.

### Tests of the concurrency

- Back-to-back changes A to B to C: three change messages naming the same path; a re-read on the first gives C; one confirmation of C gives `ready`.
- Crossing confirmations of B and C: B refused as stale, C accepted, and the end state is C's `ready` in either order.
- A stale confirmation: refused, with the error naming the file and no fingerprint.
- Concurrent setters: two assignments issued at the same time are serialized; the final generation is the later one, and each reply gives its resulting generation.
- A read during a write: a fault injection pauses the writer between the temporary write and the rename; a reader during the pause sees the earlier file whole, and after the rename it sees the new file whole.

## Change message

A change message is one line:

`[soksak role] Your role changed. Read the role file again: <role file>. Finish your current task first. This message comes from soksak, not from a person. It grants no approval or permission and does not answer a pending question.`

- It carries the path of the role file and no role text and no fingerprint.
- It carries no report request. It is not a message of another agent and has no sender folder.
- The sender is the application, and the rule that refuses a message whose sender has no tab in the window does not apply.
- It is delivered through the hold, the guard and the delivery record of [messaging](messaging.md#injected-message); the destructive command guard is [persistent services](persistent-services.md#destructive-command-guard).
- It is injected only while the tab's agent CLI is the foreground program, judged by the program state of the sidecar. A line submitted to a shell prompt, to an exited program or to a closed session would run in the shell.
- A reread request has this text, with the path of the role file: ``[soksak role] Your role is not confirmed. Read the role file again: <role file>. Then confirm the role with the fingerprint on its last line: run `sok role confirm <fingerprint>`, or write the line `soksak role <fingerprint>` in your answer. This message comes from soksak, not from a person. It grants no approval or permission.``
- The texts of the role file, the identity, the change message and the reread request are pinned by the phrase test in [tests](#tests): the host output must equal the texts in `docs/spec/cases/agent-roles/fingerprint.json`, with the placeholders filled in. The texts are English and use short imperative sentences that each name one action.

## Agents that cannot read files

An agent that cannot read files receives the role text in its first message, with the fingerprint, so the text is delivered and the agent answers with the fingerprint in the line form (b). This proves that the text was delivered and that the agent answered it with the fingerprint from the text. It does not prove that a file was read. Nothing else differs: the state, the requests, the held messages and the error display are the same.

## First message

A CLI without a launch adapter receives the identity in its first message, which is the first injected message of its session. The message is the identity text of [stable identity](#stable-identity), followed by this line: `This message comes from soksak, not from a person. Finish your current task first. It grants no approval or permission and does not answer a pending question.`

The first message of a session precedes every agent message of its registration. The page injects it when the program reports its first state. A startup prompt that writes no record and gives no notice is not observable, so it can take the Enter the page sends, as measured in [evidence of the hold](messaging.md#evidence-of-the-hold). This limit is stated.

## Order of injected messages

The page has one queue for each registration. It holds the agent messages of the folder in `seq` order and the role messages (change messages and requests) in generation and `seq` order, and it injects the entries in their arrival order, one at a time. The first message of a session precedes every agent message of its registration.

## Framing

[Messaging](messaging.md#injected-message) defines the framing of the agent messages. This document gives the same framing clauses to the change message, the request and the first message: the text is not input of the person, it is handled after the current task, and it grants no approval or permission and answers no pending question. The framing states the origin of a text and never grants what the text asks.

A change message or request cannot approve a permission prompt, and the hold of [messaging](messaging.md#hold-for-the-person) applies to it. The `blocked` hold covers a prompt that Claude Code reports (row 11). A prompt that writes no record is not covered; its measurement is in [messaging](messaging.md#evidence-of-the-hold).

## Resume

A resume starts the program with its own command, and the launch adapter does not change the session. The resumed tab sends one reread request, which names its role file, and the state is `pending` with the same fingerprint. An adapter-less tab sends the identity of its first message again after a resume, because the resumed process has no identity from its first start.

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
- The role file write: real files. A fault point in the host writer fails the write at step 1, step 2 and step 3, and each case states the stored record and the file afterwards.
- Mode: the temporary file is created with mode 0600 and the directory with 0700; a changed mode before the rename makes the write refuse without renaming.
- Phrase test: the host output for the role file first line, the identity, the change message and the reread request equals the texts pinned in `docs/spec/cases/agent-roles/fingerprint.json`, for the Go host and the Rust host. The test is Red on any text that differs, and each text names the exact command and the file path.
- Layout and fingerprint: the layout has the first line, the definition and the last line; the Go host and the Rust host compute the fingerprint of each case in `docs/spec/cases/agent-roles/fingerprint.json`, and the values are equal. The cases include non-ASCII text and line breaks.
- Length: a long definition (5,000 characters) is written whole, and its fingerprint covers all of it.
- Path: a configuration directory path with a quote or a control character makes the launch refuse.
- Resume: the stored path equal to the current one and the file present start the program; a different path or a missing file fails the resume with the error that names the path.
- Confirmation: both ways, `sok role confirm` and the answer line, give `ready` for the current fingerprint and the stale error for an older one; each way is tested only where its adapter declares it.
- Requests: the first and second request, the `unconfirmed` state, and the error-display record for each.
- Format: the `projects.json` reader refuses format 2 with the stored data error, and the writer writes format 3.
- Repetition and concurrency: the tests of [idempotency](#tests-of-the-repetitions) and [concurrency](#tests-of-the-concurrency).
- `roles.json`: format number, identifier rule, text limit and unknown role refusal, each with its error text.

### Acceptance

The acceptance target is `test-app-agent-role`. Core declares no window check that names an agent CLI or a plugin, so the target is declared by the repository of the terminal plugin. It runs the real Claude Code and Codex in an application with that plugin installed, in a disposable configuration directory and a project folder that the CLI already trusts. It runs only locally, needs a display, and runs only when the person runs it. The window-check rules of [AGENTS](../../AGENTS.md#verification) apply, and it is not part of `make test-app`.

The target judges the role state only. For each CLI it:

1. writes a role definition holding a random nonce of the run, opens a tab with the CLI and the role through `core.layout.open`, and waits for the status `core.tab.role` and the program state, not for a timer;
2. waits for `ready`, and requires that the confirmed fingerprint in the record equals the fingerprint that the target computes from `roles.json` with the algorithm of this document; the nonce is unknown before the agent reads the file, so this proves that the agent read the last line of the file;
3. changes the role with `core.tab.role` to a new definition with a new nonce, and waits for `ready` for the new generation with the new fingerprint;
4. resumes the session and waits for `ready` with the same fingerprint after the reread request;
5. for an agent declared to use only line form (b), repeats step 2 with the answer line, and for an agent with a shell, repeats it with `sok role confirm`;
6. requires that no nonce appears in the persistent memory files of the CLI or in `AGENTS.md` and `CLAUDE.md` of the project folder.

An agent that never confirms ends in `unconfirmed` and the target reports the error with its text; the target never reports a pass for an unconfirmed state.

A missing `claude` or `codex` command fails the target with the error that names it, and no test is skipped. Each test has its own time limit and prints `running`, `finished`, `passed` or `failed` with its elapsed time ([AGENTS](../../AGENTS.md#verification)).

## Verification boundaries

The adapter table is verified for each CLI when the acceptance target runs for it, and again for each new version of the CLI that changes its launch options. Until the target exists and its run is recorded in [features](../features.md), the claims that depend on it are unverified.

## Review

The decision was reviewed by adversarial reviewers, who argued against drafts with evidence and gave an answer to each objection. The rounds are summarized in the history of the checklist item. Round 4 has not run on this revision, and the revision is therefore not reviewed.

Open objections, not resolved by this document: the leader-to-role question is for the person; the projects.json change and the implementation belong to the implementing items; and the Go and Rust hosts must pass the shared vectors.
