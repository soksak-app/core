# Agent roles

[한국어](agent-roles.ko.md)

This document defines how a tab of an agent CLI receives its role. Implementation and verification are tracked in [features](../features.md). A role change reaches the agent through the injection path of [messaging](messaging.md#injected-message); this document defines the launch identity, the role file, the change message and the rules of the agent's memory.

## Decision

- A tab that starts an agent CLI gives the CLI a stable identity through its launch adapter. The identity names the absolute path of the role file of that tab. The agent reads its role from that file and is never given the role text in a launch or in a message.
- The role file belongs to one surface and lies in the configuration directory of the application, never in a repository of the person.
- A role change rewrites the role file and sends a short change message. The change message names the path of the role file and says that the role changed; it carries no role text.
- A CLI without a launch adapter receives the same identity, with the same path, in its first message.
- A resume never changes the launch instructions of a CLI. A resumed tab sends a re-read message that names the same path, so the agent reads the current role after the resume.
- An agent does not write its role into any persistent memory of its CLI. The role lives only in the session context and in the role file.
- The launch instruction is meant to survive context compaction of the agent, so the path and the rule are kept with it; compaction is not measured ([measured facts](#measured-facts)).

Reason: the measured facts listed in [measured facts](#measured-facts) show that a launch flag applies to a new session only, that `resume` keeps the instructions of the session start, and that an agent that is given a pointer to a role file reads the file at its first answer and again after a change message. A role written as text into a message or a launch can only be replaced by a later message; a file is the one place that holds the current role, so every reader sees the same role.

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

Limits of the measurements: the identity-only launch of Claude Code with the final prefix is not measured (row 9 used a first message that named the role file, not the launch flag). The `blocked` hold for Claude Code is not measured ([messaging](messaging.md#evidence-of-the-hold)). Not measured for either CLI: a context compaction, a change message after a resume, a change message while the agent is busy, a subagent or a second session of the same CLI in the same tab, and whether auto memory or the Codex memories are shared by sessions. The rules that depend on these are stated as rules of this contract and are not claimed as measured behaviour. The rule against persistent memory is an instruction only: no measured launch option of either CLI disables its memory, so the rule is not enforced by the launch, and the acceptance target checks its result (step 5).

Compaction: the identity names the file and asks the agent to read it again when the role changed. Whether the agent also reads it again after a context summary is not measured. Until that measurement is recorded, the contract requires no more than the identity text.

## Launch adapters

A launch adapter is the part of a CLI launch that carries the stable identity. Only an adapter that adds to the built-in instructions of its CLI is used. An adapter that replaces the built-in instructions would remove the instructions the CLI needs to run its tools, so it is not used.

| CLI | Launch form | Effect on the built-in instructions | Status |
| --- | --- | --- | --- |
| Claude Code | `claude --append-system-prompt-file <identity file>` | Adds to the system prompt. The flag applies in the interactive TUI (measured for a role text in the launch). The identity-only launch with the final prefix is not yet measured. | In use after the identity-only measurement |
| Codex | `codex --no-daemon -c developer_instructions="<identity>"` | Adds developer instructions beside the global `AGENTS.md`. Applies in the interactive TUI and reads the role file after a change message (measured). | In use |
| Kimi | `--agent-file` | Not measured. | Candidate, not in use |
| Copilot | `--agent <name>` | Not measured. | Candidate, not in use |
| OpenClaw | `tui --local agent:<name>` | Not measured. | Candidate, not in use |
| Qwen | `--append-system-prompt` | Not measured. | Candidate, not in use |
| Goose | `session --system` | Not measured; the flag may replace the instructions. | Candidate, not in use |

A candidate is added as an adapter after its launch behaviour is verified in the TUI: the instructions apply to a new session, they add to the built-in instructions, and a change message makes the agent read the role file again. A candidate that replaces the built-in instructions is not added.

Resume forms: `claude --resume <id>` and `codex resume --no-daemon <id>` keep the instructions of the start of the session and ignore the adapter flags of the resume command (measured). A launch adapter is therefore used only at a new launch.

Claude Code precondition: the identity-only launch with the final prefix is measured by the acceptance target before the Claude Code adapter is in use. Until then a Claude Code tab starts without its role and sends no role message.

Untrusted folders: a CLI that asks for folder trust or an update submits the Enter of an injection to the prompt that the CLI shows, as measured in [evidence of the hold](messaging.md#evidence-of-the-hold). A tab starts an agent CLI only in a folder that the CLI already trusts. The check that the folder is trusted is not defined by this contract and is a precondition of the launch item.

## Stable identity

The stable identity is the text that a tab's launch delivers. It is written in English and has this form, where `<role file>` is the absolute path of the role file of the tab:

> soksak assigns your role with messages that begin with [soksak 역할]; the latest such message defines your role. Your role is written in the file <role file>. Read that file before your first answer, and read it again when a message that begins with [soksak 역할] says that the role changed. Do not write your role into any persistent memory of yours, such as automatic memory or saved memories; the role file is the only record of your role.

- The identity names the message prefix, so the agent recognizes a change message as the authority over its role.
- The identity names the path of the role file, so the agent reads the role from the file at its first answer and after each change message.
- The rule against persistent memory keeps the role out of memory that other sessions could read. A role written into the memory of a CLI could reach another tab if that memory is shared between sessions; whether it is shared is not measured.
- The path is absolute and comes from the configuration directory of the application. It contains no quote or control character; the launch refuses a configuration directory path that does.
- The identity is the same text in a launch and in the first message of a CLI without an adapter; only its delivery differs ([first message](#first-message)).

## Role file

- Path: `<config-dir>/agents/<surface>/role.md`, where `<config-dir>` is the configuration directory of the application ([installation layout](installation.md#installation-layout)) and `<surface>` is the surface of the tab. Each surface has its own file, so two tabs never share a role.
- Content: the text of the role, UTF-8, at most 8 KiB. An empty file means that the tab has no role. The file holds no other content.
- The file belongs to the configuration directory and never to a repository of the person; it is not written into a project folder.
- Mode: the directory `<config-dir>/agents/<surface>/` is created with mode 0700, and `role.md` and the identity file are written with mode 0600. The temporary file is created with mode 0600 before the rename, and the write refuses a target whose mode differs after the rename.
- Writer: the host writes the file. The host owns the configuration directory and the surfaces, and the terminal page creates no file.
- Write rule: the host writes the file under a temporary name in the same folder and renames it to `role.md`, so the agent reads either the earlier or the new text. A write that fails is an error that names the path and the reason; the role state does not change and no change message is sent. A launch whose role file or identity file cannot be written is refused with the same error, and the tab does not start the CLI.
- Lifecycle: the directory `<config-dir>/agents/<surface>/` lives as long as the tab is in the layout. The host creates it before the launch and removes it when the tab is removed from the layout; a tab that is removed cannot be resumed.
- Launch record: each launch stores in the registration of the session the identity path and a launch identifier. A resume checks that the stored path equals the current path of the role file of the tab and that the file exists. A mismatch, which happens when the configuration directory was moved, or a missing file, fails the resume with an explicit error that names the path and the reason; the agent is not started with a stale identity.

The identity file of the Claude Code adapter is `<config-dir>/agents/<surface>/identity.txt`, written by the host at the launch beside the role file, by the same write rule. The Codex adapter passes the identity text inline, quoted as a TOML string.

## Role definitions

A role definition is the text that a role file holds. soksak holds the definitions in one stored file, `<config-dir>/roles.json`, beside `settings.json` and `projects.json` ([stored data formats](installation.md#stored-data-formats)). The file is numbered: its member `format` is `1`, and a reader accepts only that number and refuses another with `<file>: roles: format must be 1`.

```json
{"format": 1, "roles": {"reviewer": {"text": "You review the changes of the other agents in this project."}}}
```

- A role identifier matches `[a-z][a-z0-9-]*` with at most 64 characters. Another identifier is refused with an error that names it.
- `text` is UTF-8 text of at most 8 KiB. It is written to the role file as it is.
- A role that a tab names and `roles.json` does not define is refused with `unknown agent role <id>`, and the tab keeps its earlier role. No built-in definition is used in its place.

The editor of the file is a separate checklist item.

## Tab role state

Each tab of an agent CLI has one agent role, or none. The role of a tab is stored in the layout of `projects.json` as the role identifier of the tab, `null` when none. Adding this member changes the form of `projects.json`, so the change raises its format number as [stored data formats](installation.md#stored-data-formats) requires; no migration is written, and the reader refuses the earlier form. A role change is the command `core.tab.role {tab, role}`, which runs through the registry like every other command. Setting the role a tab already has changes nothing and sends nothing.

A role change runs in this order, and the next step starts only when the previous one succeeds:

1. the host stores the role identifier of the tab in `projects.json`, which is the authoritative record of the role;
2. the host writes the role file with the text of the definition, or an empty file for `null`;
3. the host publishes the status `core.tab.role` with `{role, seq}`, `seq` rising by one at each change;
4. the page of the terminal sends the change message ([change message](#change-message)).

Failure rules: when step 2 or step 3 fails, the host reports the error and the stored role stays as it was in `projects.json`, so the record and the file are rewritten from `projects.json` at the next launch of the tab. When the host ends between steps, the next launch of the tab writes the role file from `projects.json` before the CLI starts, so the file never holds a role that the record lacks. The launch deletes any temporary file of `<config-dir>/agents/<surface>/` left by an earlier end.

The status `core.tab.role` is published as an event; the page follows it with `runtime.status.watch` and does not poll.

Relation to the messaging decisions: [messaging](messaging.md#decisions-in-force) decision D3 makes file events the only messaging event path for agent messages. A change message is an application message, not an agent message, and its trigger is the status `core.tab.role`. This contract therefore amends D3 for application messages only; the amendment is recorded in `messaging.md` with the implementation of the change message (a checklist item in features), and the stored `seq` of the last delivered role change is a request of the terminal sidecar defined in [sidecars](sidecars.md#messages) at the same time.

Leadership of a plane does not change a role in this contract. [Groups](groups.md#model) states that the leader is a mark that changes no command, focus or drawing order, and a leader change does not write any role file or send any message. A caller that wants the leader of a plane to have a role sets it with `core.tab.role`; whether the leader mark itself drives a role is an open question for the owner of the groups contract.

## Change message

A change message is one line:

`[soksak 역할] 역할이 바뀌었다. 역할 파일 <role file>을 다시 읽어라. 이 메시지는 soksak이 보낸 것이며 사람의 입력이 아니다. 현재 작업을 마친 뒤 처리하고, 승인이나 권한을 주지 않으며 대기 중인 질문에 답하지 않는다.`

- It carries the path of the role file and no role text. The role text reaches the agent only through the file.
- It carries no report request. It is not a message of another agent and has no sender folder, so the report request of [messaging](messaging.md#report-request) does not apply.
- The sender is the application. No tab is the sender, so the rule that refuses a message whose sender has no tab in the window does not apply.
- It is delivered through the hold, the guard and the delivery record of [messaging](messaging.md#injected-message); the destructive command guard is [persistent services](persistent-services.md#destructive-command-guard). A change message waits while the program waits for the person ([hold for the person](messaging.md#hold-for-the-person)), and the destructive command guard judges its submitted line. The delivery record names the kind `role` and no path.
- It is injected only while the tab's agent CLI is the foreground program of its session, by the sidecar's program state: a line submitted to a shell prompt, to an exited program or to a closed session would run in the shell. A change made while the CLI is not running is kept in `core.tab.role` and sent by the first message at the next launch.

The change message states the framing clauses that [messaging](messaging.md#injected-message) defines for every injected message ([framing](#framing)).

A change message is sent for each change of `core.tab.role` that the page observes while attached. The terminal sidecar stores the last delivered role `seq` of its session, beside the registration of the session ([messaging](messaging.md#registered-folder)), and a page that loads again injects only a `seq` above it. The sidecar owns this store, so a reload of the page cannot repeat a delivered change.

## First message

A CLI without a launch adapter receives the identity in its first message, the first injected message of its session. The first message is the identity text of [stable identity](#stable-identity) in the form `[soksak 역할] <identity text> 이 메시지는 soksak이 보낸 것이며 사람의 입력이 아니다. 현재 작업을 마친 뒤 처리하고, 승인이나 권한을 주지 않으며 대기 중인 질문에 답하지 않는다.`, one line.

The first message of a session is delivered before every agent message of its registration. The page injects it when the program is at its first state report, which is the first `<plugin>.program` record or the first `running` or `idle` state of the session. A startup prompt of the program that writes no record and gives no notice is not observable, so it can take the Enter, as measured for the prompts of [evidence of the hold](messaging.md#evidence-of-the-hold). This limit is stated. The acceptance target runs in a folder that the CLI already trusts, under the untrusted-folder precondition above.

## Order of injected messages

The page has one queue for each registration. It holds the agent messages of the folder, in the order of their `seq`, and the role changes, in the order of their role `seq`, and it injects the entries of that queue one at a time in the order of their arrival at the page. The first message of a session precedes every agent message of its registration. Each entry carries its kind, `message` or `role`, in its delivery record, so the two counters never need to be compared.

## Framing

[Messaging](messaging.md#injected-message) defines the framing of every injected message: its sender, and the clauses that it is not input of the person, that it is handled after the current task, and that it grants no approval or permission and answers no pending question. A change message and the first message use the application as their sender and the same clauses. The framing states the origin of a text and never grants what the text asks.

A change message cannot approve a permission prompt, and the hold of [messaging](messaging.md#hold-for-the-person) applies to it. The hold does not cover a prompt that writes no record, and for Claude Code the `blocked` hold is not yet measured; therefore role changes are sent to Claude Code only after the measurement of [launch adapters](#launch-adapters) is recorded.

## Resume

A resume starts the program again with its own command, and the launch adapter does not change the session. A resumed tab sends one re-read message, a change message that names its role file, whatever the `seq` of the status: it is the signal that the role file is the authority after the resume, and it is not a role change. A tab without an adapter sends the identity of its first message again after a resume, because the resumed process has no identity from its first start. A tab whose role is `null` sends the identity in the same way, because the identity names the file that is empty; it sends no change message for a role that did not change.

The delivery of each case of a relaunch of a tab:

| Case | Identity | Change message |
| --- | --- | --- |
| New launch by the tab's launch command, adapter CLI | Given by the launch flag | Sent after the program state is reported |
| New launch by the tab's launch command, CLI without adapter | First message | Not separately sent |
| Resume by the tab's launch command | Kept from the session start (adapter CLI), or first message (no adapter) | Sent |
| A command typed by the person into the tab's shell, outside the launch command | None: soksak gives no identity | None |
| Claude Code before its measurement in the table | Not given | None |

A command typed by the person outside the launch command is not a launch of soksak, so the contract gives it no identity and sends nothing; the agent it starts has no pointer to the role file unless the person names the path.

## Change of a running agent

A change is one role change, one rewrite of the role file, one `seq` of `core.tab.role` and one change message. The agent applies the change when it reads the file, which the change message makes it do (measured for Codex and for Claude Code with the pointer in its first message, while the agent was idle). No restart is needed, and a change never ends the program.

A CLI that the person starts by hand in a tab, as a second agent in the same shell, has no identity from soksak. The change message reaches the foreground program whatever it is, so the contract states this limit: the launch record names the one process that holds the identity, and the page sends a change message only to that tab's registered launch, which the sidecar tracks by the launch identifier. A second agent that the person starts by hand is outside the contract.

The behaviour of a change message that arrives while the agent is busy is not measured for either CLI. The repository states two different expectations for a busy receiver ([messaging](messaging.md#injected-message) and [terminal plan](../plans/terminal-plan.md)); until a measurement settles it, a change message is injected only after the program reports that it is not busy, and the rule that the message is handled after the current task is the framing clause, not a measured guarantee.

## Tests

### Unit tests

- The unit tests of the launch adapters check the argument list and the identity file that the adapter produces for each CLI, compared with the expected values. No agent CLI runs in a unit test.
- The terminal launch path is tested with a recording program that the launch starts as the agent command. The program records the arguments and the first input that it receives and does nothing else. The launch starts it as a real process; the test does not replace the launch function, and the program does not answer for the agent.
- The unit tests of the role file write cover the path per surface, the temporary name and rename, the empty file for `null`, the bound of 8 KiB, and the error of a failed write, which leaves the role state unchanged.
- The unit tests of `roles.json` cover the format number, the identifier rule, the text bound and the unknown role refusal, each with its error text.
- The unit tests of the change message cover its form, the absence of role text in it, the unchanged `seq` on a repeated role change, and the refusal to send while the program is not the agent CLI.

### Acceptance

The acceptance target is `test-app-agent-role`. Core declares no window check that names an agent CLI or a plugin, so the target is declared by the repository of the terminal plugin, which owns the page that sends change messages. It runs the real Claude Code and Codex in an application with that plugin installed, in a disposable configuration directory and a project folder that the CLI already trusts. It runs only locally, needs a display, and runs only when the person runs it. The window-check rules of [AGENTS](../../AGENTS.md#verification) apply, and it is not part of `make test-app`. For each CLI the target:

1. opens a tab with the CLI and the role `reviewer` through `core.layout.open`, and waits for the status `core.tab.role` and the program state, not for a timer;
2. sends a message asking the agent to answer with the code word of its role, and reads the answer from the screen through the declared exposure;
3. changes the role to `leader` with `core.tab.role` and asks again, and requires the code word of the new role and no code word of the earlier role;
4. resumes the session and requires the code word of the current role after the resume;
5. requires that the code word of no role appears in the CLI's persistent memory files, which the target reads from the CLI's memory folder of the disposable home.

A missing `claude` or `codex` command fails the target with the error that names it, and no test is skipped. Each test has its own time limit and prints `running`, `finished`, `passed` or `failed` with its elapsed time ([AGENTS](../../AGENTS.md#verification)).

## Verification boundaries

The adapter table is verified for each CLI when the acceptance target runs for it and at each new version of the CLI that changes its launch options. Until the target exists and its run is recorded in [features](../features.md), the adapter table is unverified for the claims that depend on it.

## Review

The decision was reviewed by adversarial reviewers, each arguing against the draft with evidence and a proposed answer for each objection. The objections of each round and their answers, as applied in this document:

- Round 1, consistency with the existing contracts: the leader of a plane may be a group card that holds no tab, so the role is attached to tabs only; the leader mark changes no command ([groups](groups.md#model)), so it does not drive a role here; the queue of a role change is separate from the folder queue, so the order is defined by arrival ([order](#order-of-injected-messages)); the `roles.json` and the tab role are stored formats ([stored data formats](installation.md#stored-data-formats)); the guard anchor is [persistent services](persistent-services.md#destructive-command-guard).
- Round 1, runtime behaviour: a role change is injected only while the agent CLI is the foreground program; the first message waits for the first program state, and the startup-prompt limit is stated; the Claude Code blocked hold is a precondition; the sidecar keeps the last delivered role `seq`, so a page reload cannot repeat it; the identity file write fails the launch with an explicit error.
- Round 1, scope and tests: the unit tests check the arguments and identity file of each adapter, and the recording program is a real process that records what it receives; the acceptance target lives in the terminal plugin repository, because core declares no window check that names a plugin; the wording of the terms is aligned to one name each, with the kit terms as a precondition.
- Round 2, pointer design and runtime: the role directory lives as long as the tab; a resume checks the stored path and the file and fails with an explicit error otherwise; the write order is stored first and the file is rewritten from the record at the next launch; the role file mode is 0700 and 0600; the relaunch cases are listed; compaction, a busy receiver, a second session and memory sharing are listed as not measured.
- Round 2, records and terms: the measurement date and account description are removed; other work is referred to by description, not by checklist ID, in this document; measured rows are worded as observed.

Open objections, not resolved by this document: the Claude Code identity-only launch and its blocked hold are not measured, so the Claude Code adapter stays out of use; the leader-to-role question belongs to the owner of the groups contract; the amendment of messaging decision D3 for application messages and the change of `projects.json` format need their own changes in the implementing items; the terms `agent role`, `role file`, `change message`, `stable identity`, `launch adapter` and `identity file` need entries in the kit term list before this document is accepted.

