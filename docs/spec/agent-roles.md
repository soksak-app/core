# Agent roles

[한국어](agent-roles.ko.md)

This document defines how a tab of a terminal agent receives its role, and how soksak confirms that the agent has the role. Implementation and verification are tracked in [features](../features.md). Messages reach the agent through the injection path of [messaging](messaging.md#injected-message).

## Decision

- A tab that starts an agent CLI gives the CLI its stable identity as the first message of the session. The identity names the absolute path of the role file of the tab. The agent reads the role from that file; the role text is not pasted into the terminal.
- A surface is the surface of one tab, so the role file of a surface belongs to one tab. The role file lies in the configuration directory of the application, never in a repository of the person. Keep a role definition short, because the agent reads the whole file at each change; soksak accepts a definition of any length. Its last line is the fingerprint of the role.
- The fingerprint is deterministic: the same role name and definition always give the same fingerprint. The agent reads it from the last line of the file; it never computes it.
- The agent confirms by one of two ways: the command `sok role confirm <fingerprint>`, or a line `soksak role <fingerprint>` in its answer. A role is `ready` only when soksak has received the current fingerprint. The line form serves every CLI; a CLI that puts a letter or digit before the line confirms with `sok role confirm` ([confirmation](#confirmation)).
- An agent that does not confirm gets a reread request at each not-busy report until it confirms, with no limit; each request is written to the record `plugin.<plugin>.messages.delivered` with kind `role-reread`. No timer decides any step.
- A role assignment or change rewrites the role file atomically and sends a change message that names the path of the file. Operations of one surface are serialized in arrival order.
- An agent does not write its role into any persistent memory of its CLI.

Reason: the measured facts listed in [measured facts](#measured-facts) show that an agent given a pointer to a role file reads the file, and reads it again after a change message (rows 8 to 10). A role held as text in a message or a launch can only be replaced by a later message; a file is the one place that holds the current role.

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
| 12 | Claude Code 2.1.329, a new start in a folder whose `.claude/settings.json` has a `SessionStart` command hook; no login (probe-local configuration home) | The hook ran with `source` `startup` before the login check. |
| 13 | Claude Code 2.1.329, `claude -p --resume ID` of the session of row 12 | The hook ran with `source` `resume`. |
| 14 | Codex 0.171.0, a new `codex exec` in a folder trusted with `codex exec --trust` (probe-local configuration home); `.codex/hooks.json` with a `SessionStart` command hook | The hook ran with `source` `startup`; the run then stopped at the first model call with HTTP 401, because no login was present. |
| 15 | Codex 0.171.0, `codex exec resume --last` of the session of row 14 | The hook ran with `source` `resume`. |
| 16 | Claude Code 2.1.329, TUI, new start with the default login; `.claude/settings.json` has a `SessionStart` command hook | The hook ran with `source` `startup`. |
| 17 | Claude Code 2.1.329, TUI, `/clear` in the session of row 16 | The hook ran with `source` `clear`. |
| 18 | Claude Code 2.1.329, TUI, `/compact` in the session of row 17 after one prompt | `PreCompact` ran with `trigger` `manual`, then `SessionStart` ran with `source` `compact`. |
| 19 | Claude Code 2.1.329, TUI, auto-compaction forced by the probe-only environment variable `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1` after one prompt | `PreCompact` ran with `trigger` `auto`, then `SessionStart` ran with `source` `compact`. |
| 20 | Codex 0.171.0, TUI with `--no-daemon --dangerously-bypass-hook-trust`, new start with the default login; `.codex/hooks.json` has a `SessionStart` command hook | The hook ran with `source` `startup` when the first prompt was submitted. |
| 21 | Codex 0.171.0, TUI, `/clear` in the session of row 20 | The hook ran with `source` `clear`. |
| 22 | Codex 0.171.0, TUI, `/compact` in the session of row 21 after one prompt | The hook ran with `source` `compact`. |
| 23 | Codex 0.171.0, auto-compaction | Not measured: the 0.171 binary has no configuration key for the auto-compaction threshold (searched in its strings). The Codex documentation summary says compaction runs `SessionStart` with `source` `compact`; that statement is not verified. |
| 24 | Claude Code 2.1.329, `SessionStart` command hook that prints `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The probe word is ZEBRA-7."}}`; the question "What is the probe word?" after new start, `/clear` and `/compact` | The model answered `ZEBRA-7` after each of the three sources. |
| 25 | Codex 0.171.0, the same hook output in `.codex/hooks.json`; the same question after new start, `/clear` and `/compact` | The model answered `ZEBRA-7` after each of the three sources. |

Rows 3 and 7 show only that the agent follows a change message that names the new role; they do not show that the agent reads a file. Each row is one run. The rule against persistent memory is an instruction only; no measured launch option of either CLI disables memory.

The probe measured the `SessionStart` values of both CLIs in the interactive TUI with the default login (rows 16 to 22). Claude Code also fired `PreCompact` with `trigger` `manual` and `auto`. Codex 0.171.0 accepts the `additionalContext` field of the `SessionStart` hook output, as row 25 shows. Codex auto-compaction is not measured (row 23). Codex 0.171.0 disables project-local configuration in an untrusted folder with a warning, and `codex exec --trust` enables it. With `--dangerously-bypass-hook-trust`, the Codex TUI shows the warning that the flag requires embedded mode unless `--no-daemon` is set.

Claude Code reports a permission prompt as `blocked` through the program status of [terminal state](terminal-state.md) (row 11), so the `blocked` hold of [messaging](messaging.md#hold-for-the-person) holds the change messages and reread requests while the prompt is open.

## Launch

Every agent CLI starts the same way: the program named by `program` with the arguments of `args`, and no argument from core. Its identity reaches it as the first message of the session ([first message](#first-message)). Codex is started with `--no-daemon` in `args`, as [cli](cli.md) states.

The line form of confirmation applies to every CLI, and the command form applies to an agent with a shell ([confirmation](#confirmation)).

An agent CLI starts only in a folder that the CLI already trusts. A CLI that asks for folder trust or an update submits the Enter of an injection to its own prompt, as measured in [evidence of the hold](messaging.md#evidence-of-the-hold).

## Start parameters

A terminal tab that runs an agent CLI takes these parameters of `core.layout.open` for the terminal plugin, in `params`:

- `program`: the name or the path of the agent CLI. Absent means that the tab starts the shell, as before.
- `args`: an array of texts, the arguments of the program. Absent means an empty array.
- `role`: `null` or an agent role identifier. A tab with a role has its role file written before the launch ([role file](#role-file)), and its first message carries the identity.

Core passes `args` to `program` as given and adds no argument. A `role` without a `program` is refused with `role requires program`, and `args` without a `program` is refused with `args require program`; in both cases no program starts.

Sidecar protocol change: the `open` request of a terminal session gains the members `program` (text) and `args` (array of texts) beside `directory`. With `program` present, the sidecar starts `program` with `args` as its argument vector, without a shell. A bare `program` name resolves through the PATH of the session environment; a relative path that contains a separator resolves from the session's `directory`. A `program` that does not resolve fails the start with an `openFailed` reply whose reason is `program not found: <program>`. A program session has no shell integration: it sends no OSC 133 marks and has no shell state. Without `program`, the sidecar starts the shell as before. The sidecar refuses an `open` request, and starts nothing, with these texts: `open program must be a non-empty text` for an empty `program`; `open args must be an array of texts` for an `args` that is not an array of texts; `open args require program` for `args` without `program`; and `open program and shell are both set` for a request that sets `program` and `shell` together. The terminal page sends the composed `program` and `args` and no other argument of the launch. Each terminal sidecar implements this change; its follow-up items are tracked in [features](../features.md).

## Stable identity

The stable identity is the text of the first message of a session. It is written in English and has this form, where `<role file>` is the absolute path of the role file of the tab:

> [soksak role] Your role is defined in the file <role file>. Read the whole file before your first answer. Read the file again when a message starts with [soksak role] and says that the role changed. Do not save your role in any persistent memory. The role file is the only record of your role.

- The identity names the message prefix, so the agent recognizes a change message as the authority over its role.
- The identity names the path of the role file, so the agent reads the role from the file.
- The path is absolute and comes from the configuration directory of the application. A path with a quote or a control character is refused with `configuration directory <path> holds a quote or a control character`, and the launch starts no program.
- The identity is the first message of every CLI, sent at each start of its session.

## Role file

- Path: `<config-dir>/agents/<surface>/role.md`, where `<config-dir>` is the configuration directory of the application ([installation layout](installation.md#installation-layout)) and `<surface>` is the surface of the tab. A surface identifier that contains a path separator, a `..` segment or a control character is refused with `surface "<value>" holds a path part or a control character`, where `<value>` is the surface identifier. Nothing is written when the surface identifier is refused with that text.
- Korean file: `role.ko.md` beside `role.md` in `<config-dir>/agents/<surface>/`. It holds the Korean translation of the first line (`texts_ko` of the [fingerprint reference cases](#fingerprint-reference-cases)), the Korean text of the definition (`ko` of `roles.json`) and the same fingerprint line as the last line. The fingerprint is computed over `role.md` only. Only `role.md` is named to the agent, so the agent reads `role.md` alone.
- Layout, in order:
  1. the first line: ``Read this whole file. Follow the role it defines. Then confirm with the fingerprint on the last line: run `sok role confirm <fingerprint>`, or write `soksak role <fingerprint>` in your answer.``;
  2. the definition text, exactly as stored in `roles.json`;
  3. the last line: the fingerprint.
  Each line ends with one line feed. A definition whose stored text lacks a final line feed gets one in the file; the fingerprint is computed over the stored text unchanged. A tab without a role has no role file and no identity ([tab role state](#tab-role-state)).
- Fingerprint: the first 16 lowercase hexadecimal characters of the SHA-256 digest of the UTF-8 bytes of the role identifier, one line feed (U+000A), and the definition text as stored. The identifier has no line break, so the separator is unambiguous. The fingerprint depends only on the identifier and the text: the same definition always gives the same fingerprint.
- Length: soksak writes the definition as it is, whatever its length. The spec recommends a short definition, because the agent reads the whole file at each change.
- The file belongs to the configuration directory and never to a repository of the person.
- Mode: the directory `<config-dir>/agents/<surface>/` is created with mode 0700, and `role.md` is written with mode 0600. The mode of the temporary file is checked before the rename, so a file with another mode is never visible under the final name; the write then fails with `role file <path>: mode <mode> is not 0600` and removes the temporary file. A failed write step fails with `role file <path>: write failed: <os error>`, where `<path>` is the path that the step used. `role.ko.md` is written with mode 0600 as well.
- Atomic write: the host writes the new content to a temporary file named `.role-<random>.tmp` in the same folder and renames it over `role.md`. A reader sees the whole earlier file or the whole new one. Before its first write, a launch deletes the files of its surface folder whose names match `.role-*.tmp`, which an earlier crash left. Both files follow the same order: the host writes each temporary file and checks its mode, renames `role.md` first and `role.ko.md` second. A failed rename of `role.ko.md` is reported with `role file <path>: rename failed: <os error>`, where `<path>` is its path.
- Writer: the host writes the file; the terminal page creates no file. A failed write is an error with the text `role file <path>: write failed: <os error>`, which names the path and the reason. A failed role file write at a launch is refused with `role file <path>: write failed: <os error>`, and no program starts.
- Lifecycle: the host creates the directory before the launch. When the tab is removed from the layout, the host stops the program of the tab, waits for a write in progress to end, refuses a later role change of that tab with `tab <tab> was removed; its role cannot change`, and removes the directory. A failed rename after the removal removes the temporary file and is logged with `role file <path>: rename failed: <os error>`. The held messages of the removed tab are discarded, each with a delivery record of state `skipped` and reason `tab removed`. A removed tab cannot be resumed.

## Fingerprint reference cases

The algorithm is tested by the shared case file `docs/spec/cases/agent-roles/fingerprint.json`. Each case gives the identifier, the definition text and the expected fingerprint. The same file pins the English texts of the role file first line, the identity, the change message, the reread request and the first message suffix in `texts`, and the Korean first line of `role.ko.md` in `texts_ko`, and the [phrase test](#phrase-test) compares the host output with them after the placeholders are filled. The Go host and the Rust host each run every case and compare the fingerprint they compute. The cases include non-ASCII text and line breaks, so the UTF-8 encoding and the separator are both checked. The values are the same for both hosts.

## Role definitions

A role definition is the text that a role file holds, and its Korean translation is the `ko` member. The format rose from 1 to 2 when `ko` was added: the reader refuses format 1 without any migration, and a tracked file in format 1 is edited into format 2 in the same change. soksak holds the definitions in one stored file, `<config-dir>/roles.json`, beside `settings.json` and `projects.json` ([stored data formats](installation.md#stored-data-formats)). The file is numbered: its member `format` is `2`, and a reader accepts only that number and refuses another with `<file>: roles: format must be 2, found <value>`.

```json
{"format": 2, "roles": {"reviewer": {"text": "You review the changes of the other agents in this project.", "ko": "이 프로젝트의 다른 agent 변경을 검토한다."}}}
```

- A role identifier matches `[a-z][a-z0-9-]*` with at most 64 characters.
- `text` is UTF-8 text, written into the role file as it is.
- `ko` is UTF-8 text, the Korean translation of `text`, written into `role.ko.md` as it is. It is required: a definition without `ko` is refused, so the pair cannot go missing. soksak does not translate it.
- A role that a tab names and `roles.json` does not define is refused with `unknown agent role <id>`, and the tab keeps its earlier role.

`<file>` is the path of `roles.json`. A read or a write refuses the whole file with the text of the matching line below, such as `<file>: roles: format must be 2, found <value>`, which names the file, and writes nothing:

- `<file>: roles: format must be 2, found <value>`: `<value>` is the compact JSON text of the member `format`, or `null` when the member is absent or the document is not an object.
- `<file>: roles: unknown field <name>`: a top-level member other than `format` and `roles`.
- `<file>: roles: roles must be an object`
- `<file>: roles: invalid role identifier <id>`: the first identifier that does not match, in the sorted order of the identifiers.
- `<file>: roles: role <id> must be an object`
- `<file>: roles: role <id> ko must be a string`: the member `ko` is absent or is not a string.
- `<file>: roles: role <id> unknown field <name>`: a member of a definition other than `text` and `ko`.
- `<file>: roles: role <id> text must be a string`

The editor of the file is a separate checklist item.

## Tab role state

Each tab has one agent role, or none. Each tab of the layout in `projects.json` holds the member `role`, which is either `null` (no role) or the whole stored record of the role. The record has exactly these members:

- `id`: the role identifier, which matches the identifier rule of [role definitions](#role-definitions);
- `generation`: an integer of at least 1 that starts at 1 and rises by one at each change of the role or of its definition;
- `fingerprint`: the fingerprint of the current role file, 16 lowercase hexadecimal characters;
- `confirmedFingerprint`: the fingerprint that the agent confirmed, 16 lowercase hexadecimal characters, or `null`.

There is no partial record. A tab whose member `role` is absent, or whose value is neither `null` nor a record of these four members in these forms, is refused with an explicit error that names the file, the tab and the member; the error text is `projects.json: project <root> space <space>: tab <tab> member role is missing` or `... member role is invalid`. A tab created without a role stores `role: null`.

Format 4 of `projects.json` is the first form with the member, so the format number rises from 3 to 4 as [stored data formats](installation.md#stored-data-formats) requires. No migration is written. The reader refuses format 3 as a whole with `<file>: projects: format must be 4, found 3`, where `<value>` is the compact JSON text of the member `format` as the file holds it, or `null` when the member is absent or the document is not an object; `3` is the value of the file of this example. Every write of the refused file fails with that error.

A role change is the command `core.tab.role {tab, role}`, which runs through the registry. Setting the role the tab already has, with the same definition, writes no file, changes no generation and sends no message, and answers the current `{role, generation, state, fingerprint}`.

Setting `role` to `null` with `core.tab.role` clears the role and removes the role file. A tab launched without a role has no role file.

A change runs in this order, and each step starts only when the previous one succeeds:

1. the host writes the new role file under its temporary name, with the new fingerprint, and checks its mode;
2. the host stores the record `{id, generation, fingerprint, confirmedFingerprint: null}` as the member `role` of the tab in `projects.json`;
3. the host renames the temporary file to `role.md`;
4. the host publishes the status `core.tab.role` with `{role, generation, state: "pending", seq, fingerprint, path}`;
5. the page of the terminal sends the change message ([change message](#change-message)).

Failure rules: a failure in step 1, with the text `role file <path>: write failed: <os error>`, removes the temporary file and stores nothing. A failure in step 2 removes the temporary file, leaves the stored role unchanged and is reported with `role file <path>: write failed: <os error>`. A failure in step 3 removes the temporary file and then restores the earlier record in `projects.json`; when the restore also fails, both errors are reported: the write error and `projects.json <path>: restore failed: <os error>`. When the host ends between steps, the next launch writes the role file from the record in `projects.json` and the definition text in `roles.json` before the CLI starts; a fingerprint that differs from the record refuses the write with `role file <path>: fingerprint differs from the record`.

The status `core.tab.role` has the value `{role, generation, state, seq, fingerprint, path}`: `state` is `pending` or `ready`, `null` without a role; `fingerprint` is the fingerprint of the current role file, `null` without a role; `path` is the absolute path of the role file of the tab, `<config-dir>/agents/<surface>/role.md`, `null` without a role; and `seq` rises at each change. The replies of the role commands carry `fingerprint` and `path` too. The page composes the change message and the reread request from the `path` and the `fingerprint` of the status, and no error text carries a fingerprint. The page follows the status with the view call `runtime.status.watch` with `{name: "core.tab.role", surface}`, where `surface` is the terminal's own surface, and does not poll ([view surfaces](native-surfaces.md#view-surfaces)).

## Confirmation

The states are:

- `pending`: the role file holds a fingerprint that the agent has not confirmed. A role assignment, a role change and the launch of a tab with a role set this state.
- `ready`: `confirmedFingerprint` equals the fingerprint of the current role file.
- `null`: the tab has no role.

A change sets the state back to `pending`, because its generation and fingerprint are new.

An agent confirms in one of two declared ways, and either one counts. The command form runs the declared command `core.tab.role.confirm {fingerprint}`, which [cli](cli.md#commands) exposes as `sok role confirm`:

- (a) the command `sok role confirm <fingerprint>`, for an agent with a shell. `sok` sends the request to the application with the surface that `agent.surface` answers for the process ([processes of a surface](sidecars.md#processes-of-a-surface)), so a process outside the tab cannot confirm for it.
- (b) a line `soksak role <fingerprint>` in the answer of the agent. The terminal plugin matches the line against the visible rows of the screen that `<plugin>.screen.read` reads, after each change of the visible rows that it receives, so a visible line of tool output also counts. A row matches when, after the spaces at both ends are removed, it ends with `soksak role <fingerprint>` and the text before it is empty or is a run of characters that are neither letters nor digits followed by at least one space. So `⏺ soksak role <fingerprint>` (the answer marker of Claude Code) and `• soksak role <fingerprint>` (the answer marker of Codex CLI) match, and a row with a letter or digit before the line does not. The rule is pinned by the shared case file `docs/spec/cases/agent-roles/confirmation-line.json`, which the page matcher tests run. The pattern is the exact line form with 16 lowercase hexadecimal characters; the bare fingerprint line of the file does not match. The match confirms through the same per-surface serialization. A confirmation line that the terminal wraps at its width does not match; the state stays `pending` and a reread request asks again. A line whose row scrolls off the screen before the update is read does not match either. The line shows that the agent holds the fingerprint of the current file; it does not show that the agent read the file. The page confirms a matched line with the view call `runtime.command` as `core.tab.role.confirm` with `{fingerprint}` on its own surface ([view surfaces](native-surfaces.md#view-surfaces)); the core command runs on the surface of its caller, as it does for the command that `sok` sends.

The line form applies to every CLI, and the command form applies to an agent with a shell. A way that does not apply to an agent is not offered to it.

soksak judges a confirmation inside the serialization of the surface, against the state at its turn:

- a value that is not 16 lowercase hexadecimal characters is refused as an invalid-argument error with `fingerprint <value> is not 16 lowercase hexadecimal characters` before the serialization. The stale rule below applies only to valid values;
- the fingerprint equals the current one, in state `pending`: `confirmedFingerprint` is stored, the state becomes `ready`, `seq` rises, and the held work messages are released;
- the fingerprint equals the current one, in state `ready`: nothing changes, and the answer is a success;
- the fingerprint differs from the current one, because it belongs to an earlier file: refused as stale with `stale fingerprint: read the role file again at <path>`, without a retry. The error is `stale fingerprint: read the role file again at <path>`, which names the path of the current role file. It names no fingerprint. The state stays `pending`; the next not-busy report sends a reread request with the current path and fingerprint, so a wrong fingerprint repeats the request;
- a tab without a role, or a surface without a tab: refused with `surface "<value>" has no tab`, or, for a tab without a role, with `tab <tab> has no role`.

### Requests

The page watches the program state of the tab ([terminal state](terminal-state.md)). A reread request is a message that names the path of the role file and asks the agent to read the file and confirm with its last line. The change message and the first message are not counted as requests. While the state is `pending`, the page sends one reread request at each report of the program that it is not busy. The requests repeat until the agent confirms, with no limit, and each one is written to the record `plugin.<plugin>.messages.delivered` with kind `role-reread`.

Each request names the path and the current fingerprint from the status. A wrong fingerprint leaves the state `pending`, so the next not-busy report sends a request with the current path and fingerprint. No timer decides these steps.

The not-busy report that the CLI gives is verified for each CLI. An agent whose CLI gives no such report stays `pending` and shows through the error display with the text `pending role: tab <tab> waits for a not-busy report of the agent CLI` instead of passing.

## Held messages

While the state is `pending`, the page holds the work messages of the tab, which are the agent messages of the registration. Held messages keep their order and are injected one at a time when the state becomes `ready`. Each is delivered once: the delivery record keys it by its file name. The first message of a session and the requests are not held by the `role-pending` hold; the `blocked` hold of [messaging](messaging.md#hold-for-the-person) still holds them while a prompt is open. The hold reason `role-pending` is named in the hold list of [messaging](messaging.md#hold-for-the-person). The role play proceeds only after the fingerprint is confirmed, so `ready` is when work starts.

A change while messages wait keeps them queued; they are delivered after the `ready` of the new generation.

## Idempotency

These rules act on the stored role record of the tab, not on the file write: the idempotency of each step, the generation, the per-surface serialization of the [concurrency](#concurrency) and the refusal with `stale fingerprint: read the role file again at <path>` are judged on that record, and the file is written only when the record decides it.

Every step of the role handshake repeats without a change of the result:

- a repeated `core.tab.role` with the same role and definition writes no file, changes no generation and sends no message. A repeat of that call changes nothing;
- a new generation is made only when the role or its definition changes;
- `sok role confirm` or the answer line with the current fingerprint, repeated, answers `ready` and changes nothing, including `seq`;
- a reread request that is sent again names the same path and the same fingerprint, so reading the file again and confirming again gives the same `ready`;
- a work message is delivered exactly once, even when `ready` is reached twice;
- after a restart of the application while the program keeps running, the state is rebuilt from the stored record and the file: `ready` when `confirmedFingerprint` equals the fingerprint of the file; otherwise `pending`. A file whose fingerprint differs from the record is rewritten from `roles.json` first, and a rewrite whose fingerprint still differs from the record is refused with `role file <path>: fingerprint differs from the record`;
- a resume gives `pending` with the same fingerprint, because a resume keeps the session but not the proof that the agent read the file. The host clears `confirmedFingerprint` at the resume, and the resumed tab sends a reread request at each not-busy report until it confirms; a new launch clears `confirmedFingerprint` as a resume does.

A role A changed to B and back to A has the fingerprint of A again, so a confirmation of it is correct: the content is the same.

### Tests of the repetitions

- Repeated assignment of the same role and definition in state `pending` or `ready`: no write of the role file (its inode and content stay the same), no new generation, no change message, and the answer equals the current `{role, generation, state, fingerprint}`.
- Changed definition with the same role: a new generation and one change message.
- Changes A to B to A: the fingerprint of A returns, and a confirmation of it gives `ready`.
- Repeated confirmation with the current fingerprint: `ready` both times, and `seq` unchanged after the second.
- Confirmation of an earlier fingerprint after a change: refused as stale with `stale fingerprint: read the role file again at <path>`; the error names no fingerprint.
- A confirmation value that is not 16 lowercase hexadecimal characters: refused as invalid input with `fingerprint <value> is not 16 lowercase hexadecimal characters`, and the text `stale fingerprint: read the role file again at <path>` is not sent.
- Reread requests without confirmation: one request at each not-busy report, each written to `plugin.<plugin>.messages.delivered` with kind `role-reread`, with no limit; each names the same path and the current fingerprint.
- Work message with `ready` reached twice: injected once, keyed by its file name.
- Restart with a stored confirmation: `ready` without input; without one: `pending` without input.
- Resume: `pending`, the same fingerprint, the confirmation cleared, one reread request.

These are unit tests with real files and the real `sok` command; no agent CLI runs in them. The host tests run in the Go host package and in the Rust host package. The page tests run in the terminal plugin repository, which owns the page.

## Concurrency

Role operations of one surface are serialized by one owner in the host, in arrival order. The operations are the assignment or change of the role, the confirmation (both ways), the request, the reread and the removal of the tab; a confirmation after a removal is refused with `tab <tab> has no role`. Each change raises the generation, and a confirmation is judged under the same serialization, so it is judged against the state at its turn.

- The role file is written atomically, so a reader sees the whole earlier file or the whole new one.
- Consecutive changes A to B to C: each sends its change message; each message points to the same file, which always holds the latest role, so a reread on any of them reaches C. One confirmation of the fingerprint of C gives `ready`.
- Confirmations of B and C that interleave: the confirmation of B is refused as stale with `stale fingerprint: read the role file again at <path>` and that of C is accepted; the order does not change the end state.
- Two callers set the role at the same time, the person and a lead agent: they are serialized, the last one wins, and each reply states the resulting `{role, generation, state, fingerprint}`.
- Queued work messages wait for the `ready` of the current generation.
- Restart: the generation and the confirmed fingerprint are stored in the record, so the state is rebuilt as the idempotency rules state.

### Tests of the concurrency

- Consecutive changes A to B to C: three change messages naming the same path; a reread on the first gives C; one confirmation of C gives `ready`.
- Interleaved confirmations of B and C: B refused as stale with `stale fingerprint: read the role file again at <path>`, C accepted, and the end state is C's `ready` in either order.
- A stale confirmation: refused with `stale fingerprint: read the role file again at <path>`; the error names no fingerprint.
- Concurrent setters: two assignments issued at the same time are serialized; the final generation is the later one, and each reply gives its resulting generation.
- A read during a write: a fault injection pauses the writer between the temporary write and the rename; a reader during the pause sees the earlier file whole, and after the rename it sees the new file whole.

## Change message

A change message is one line:

`[soksak role] Your role changed. Read the role file again: <role file>. Finish your current task first. This message comes from soksak, not from a person. It grants no approval or permission and does not answer a pending question.`

- For an agent that reads files, it carries the path of the role file and no role text and no fingerprint.
- It carries no report request. It is not a message of another agent and has no sender folder.
- It is delivered through the hold, the guard and the delivery record of [messaging](messaging.md#injected-message); the destructive command guard is [persistent services](persistent-services.md#destructive-command-guard).
- Its queue, sender, foreground rule and framing are stated in [role messages](messaging.md#role-messages).
- A reread request is the text ``[soksak role] Your role is not confirmed. Read the role file again: <role file>. Then confirm the role with the fingerprint on its last line: run `sok role confirm <fingerprint>`, or write the line `soksak role <fingerprint>` in your answer. This message comes from soksak, not from a person. It grants no approval or permission.``, with the path of the role file.
- The texts of the role file first line, the identity, the change message, the reread request and the first message suffix are pinned by the [phrase test](#phrase-test): the host output must equal the texts in `docs/spec/cases/agent-roles/fingerprint.json`, with the placeholders filled in, except the first line of the role file (see the [phrase test](#phrase-test)). The texts are English and use short imperative sentences that each name one action.

## Phrase test

The phrase test pins each English text that soksak gives an agent: the first line of the role file, the identity, the change message, the reread request and the first message suffix. The host output of each text equals the text in `docs/spec/cases/agent-roles/fingerprint.json`, for the Go host and the Rust host, with the placeholders filled in for each text except the first line of the role file. The first line contains no fingerprint value: the words `<fingerprint>` in it name the place of the value on the last line, and no placeholder is filled in it. Its host output equals its text exactly. The first line names the last line, so the agent reads the file to its end. The test is Red on any text that differs, and each text names the exact command and the file path.

## First message

Every CLI receives the identity in its first message, which is the first injected message of its session. The message is the identity text of [stable identity](#stable-identity), followed by this line: `This message comes from soksak, not from a person. Finish your current task first. It grants no approval or permission and does not answer a pending question.`

The first message of a session precedes every agent message of its registration. The page injects it when the program reports its first state. A startup prompt that writes no record and gives no notice is not observable, so it can take the Enter the page sends, as measured in [evidence of the hold](messaging.md#evidence-of-the-hold). This limit is stated. A first message can also be lost to context compaction; the reread requests and the change messages restore the role then.

## Session restart hook

A session-start hook gives the stable identity of the tab to the CLI at each start, resume, clear and compaction of its session. The identity is then in the context directly after the context is reset. The hook delivers the identity text of [stable identity](#stable-identity) and never the role definition: the definition stays in the role file, which the agent reads.

- Command: `sok role identity`, with no argument. The process of the command asks `agent.surface` for its surface, as `sok role confirm` does ([processes of a surface](sidecars.md#processes-of-a-surface)). The hook process is a child of the CLI process, so its ancestor chain reaches the surface of the tab.
- With a role: standard output holds one line of JSON, `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<identity text>"}}`. The identity text is the text of [stable identity](#stable-identity) with `<role file>` set to `<configuration directory>/agents/<surface>/role.md`. The exit status is 0. Claude Code and Codex read this form from a SessionStart hook; both were measured to put the injected text in the model context ([measured facts](#measured-facts), rows 24 and 25).
- Hook command: the command is a shell line that runs `sok` only inside a soksak terminal: `[ -n "$SOKSAK_CONFIG_DIR" ] || exit 0` followed by `exec <sok> role identity --soksak-hook`, where `<sok>` is the running `sok` quoted as above. The host sets `SOKSAK_CONFIG_DIR` in every process that a sidecar starts for a surface ([sidecars](sidecars.md#processes-of-a-surface)), so the variable is present exactly in the sessions of a soksak tab. Outside a tab the line exits 0 at once without running `sok`, so a project that does not use soksak sees no start of `sok` and no hook error, even when `sok` is not installed or not on `PATH`. A person who exports `SOKSAK_CONFIG_DIR` in the login shell makes the line run `sok`; `sok` then reports its own error or prints nothing outside a tab.
- Without a role, or outside every surface: nothing on standard output, exit status 0. A hook runs in every session of the agent, including sessions outside a soksak tab. Outside a tab no tab environment exists, so the command finds no surface, prints nothing and exits 0 at once, without contacting the application.
- On an error, such as a refused surface identifier or an application that does not answer: nothing on standard output, `sok: <message>` on standard error, and exit status 1. Codex records only the exit status of such a run, not the text on standard error ([above](#session-restart-hook)). Claude Code does not block the session on this status, so the session starts without the identity. In the Claude Code hooks reference, an exit status 2 from a `SessionStart` hook shows its stderr to the person only and does not block the session, and any other non-zero status is a non-blocking error ([Claude Code hooks](https://code.claude.com/docs/en/hooks)). Codex 0.171.0 runs a command hook through the shell: on Unix it starts `$SHELL -lc '<command>'`, and `/bin/sh` when `SHELL` is unset (`codex-rs/hooks/src/engine/command_runner.rs` lines 448 to 474 and 508, tag `rust-v0.171.0`). For a `SessionStart` hook, exit status 0 with JSON stdout adds its `additionalContext`, exit status 0 with other stdout adds that stdout as context, and any other exit status records the run as failed with the entry `hook exited with code <n>`; the session continues. The handler does not use the stderr of the hook (`codex-rs/hooks/src/events/session_start.rs` lines 245 to 321). A probe with `codex --no-daemon --dangerously-bypass-hook-trust exec --trust` in a temporary folder confirmed both the shell form, through a guard line that exits 0 when its variable is unset, and the failed record of a hook that exits with status 3 while its stderr text was not shown. The bypass flag loads the project hook file in that form; it is not needed by the sessions that the person starts.
- The hook never sends the role definition. The fingerprint loop and the change message are unchanged: a CLI without a session-start hook uses the loop alone.

Reasons for the hook, against a message typed into the terminal: the text arrives right after the context reset; nothing is typed into the TUI, so it does not clash with input of the person, an input method or a permission prompt; it adds no conversation turn; it survives compaction because it is added after the compaction. The definition stays in the file, because a role can change during a session, injected context cannot be withdrawn by a later change (not measured), and the fingerprint needs the file to be read.

The hook is installed at user level, in the agent folders that the skill and MCP setup already use, and never in a project folder. A project folder receives no file from soksak, and Codex runs project hooks only in trusted folders, which a soksak tab does not need: a tab can open in any folder.

Registration is the setup part `hook` ([setup parts](cli.md#setup-parts)). `sok setup install hook` writes the hook of each agent folder that exists:

- Claude Code: the file `settings.json` of each existing Claude folder, `<home>/.claude` and `$CLAUDE_CONFIG_DIR` when that variable is set and not empty, the same folders as the skill part.
- Codex: the file `hooks.json` of the Codex user folder, `$CODEX_HOME` when that variable is set and not empty, else `<home>/.codex`, when that folder exists. Codex reads this file from its user folder: `$CODEX_HOME/hooks.json`, or `~/.codex/hooks.json` when `CODEX_HOME` is unset ([Codex hooks](https://learn.chatgpt.com/docs/hooks); Codex 0.171.0 reads `hooks.json` from each config layer folder, `codex-rs/hooks/src/engine/discovery.rs` line 395).

The hook is one group in the `SessionStart` array of the `hooks` member: `{"matcher": "", "hooks": [{"type": "command", "command": "<sok> role identity --soksak-hook"}]}`, where `<sok>` is the running `sok`, as the MCP registration names it, quoted for the shell when its path holds a space or a shell character. An empty matcher runs the hook for every source. The fixed argument `--soksak-hook` is the mark of an entry that soksak registered: `sok role identity` accepts exactly this argument and refuses any other. The entry carries only the documented fields `type` and `command`, so no extra member is needed to tell the entry apart.

The merge keeps every other value of the file:

- A file that does not parse, or whose `hooks` or `SessionStart` member has another type, fails with `<file>: <reason>` and nothing is written. A missing file is created with the one entry; its mode is 0600.
- An entry belongs to soksak when its command ends with the words `role identity --soksak-hook` after a path to `sok`. Install first removes every soksak entry under every event and matcher, which removes stale, renamed and duplicated soksak entries too, and removes a group only when the removal emptied it. Then it adds the current group to the `SessionStart` array, so the file holds exactly the current soksak set plus the entries of the person, which are untouched.
- Installing twice gives the same bytes: the second install removes the entries of the first and adds them again in the same place.
- Entries of other programs and other members keep their key and value text byte for byte, and their order: a string or a number keeps the escapes and the form that the file wrote. The file is written with two-space indentation and a final line feed, and only whitespace outside strings changes. The Go and the Rust `sok` write the same bytes for the cases of `docs/spec/cases/setup/hook-files.json`.
- The write is atomic: the temporary file is in the same folder and is renamed over the file. An existing file keeps its mode.

`sok setup check` lists the part `hook` for each file that the install would write. Its state is `ok` when the file holds exactly the current soksak set. Its reason is `absent` when no soksak entry exists, and `differs` when a soksak entry is outside the current set, under another event, or names another `sok`. Removal is the setup command `sok setup remove hook`. It applies to the same files as the install and changes only soksak's entries: it removes every soksak entry under every event and matcher, removes a group or an event array only when the removal emptied it, and keeps every other value and its order. A file that does not exist is not created. Removing soksak therefore leaves no hook behind, and the entries of the person are unchanged.

## Resume

A resume starts the program with its own command. The resumed tab sends the first message again, then one reread request, which names its role file and counts as request 1; the state is `pending` with the same fingerprint.

| Case | Identity | Message |
| --- | --- | --- |
| New launch by the tab's launch command | First message | None separately |
| Resume by the tab's launch command | First message again | One reread request |
| A command typed by the person into the tab's shell, outside the launch command | None: soksak gives no identity | None |

## Change of a running agent

A change is one role change, one atomic rewrite of the role file, one new generation and one change message. The agent applies the change when it reads the file, which the change message makes it do (rows 8 and 9). No restart is needed, and a change never ends the program.

A CLI that the person starts by hand in a tab, as a second agent in the same shell, has no identity from soksak; it is outside the contract. The behaviour of a change message while the agent is busy is stated in [role messages](messaging.md#role-messages).

## Tests

### Unit tests

- The launch: the argument list is `args` as given, and the first message carries the identity with the role file path. No agent CLI runs in a unit test.
- The terminal launch path: a recording program that the launch starts as the agent command. It records the arguments and the first input and does nothing else; the launch starts it as a real process.
- The role file write: real files. A fault point in the host writer fails the write at step 1, step 2 and step 3, and each case asserts `role file <path>: write failed: <os error>` and states the stored record and the file afterwards.
- Mode: the temporary file is created with mode 0600 and the directory with 0700; a changed mode before the rename makes the write fail with `role file <path>: mode <mode> is not 0600` without renaming.
- Phrase test: the host output of each pinned text equals the text in `docs/spec/cases/agent-roles/fingerprint.json`, as described in the [phrase test](#phrase-test).
- Layout and fingerprint: the layout has the first line, the definition and the last line; a definition without a final line feed gets one in the layout and its fingerprint is computed over the stored text. The Go host and the Rust host compute the fingerprint of each case in `docs/spec/cases/agent-roles/fingerprint.json`, and the values are equal. The cases include non-ASCII text and line breaks.
- Length: a long definition (5,000 characters) is written whole, and its fingerprint covers all of it.
- Path: a configuration directory path with a quote or a control character is refused with `configuration directory <path> holds a quote or a control character`; a surface identifier with a path separator, a `..` segment or a control character is refused with `surface "<value>" holds a path part or a control character`, and nothing is written.
- Launch failure: a failed role file write at a launch is refused with `role file <path>: write failed: <os error>` and starts no program.
- Leftover files: a launch deletes the `.role-*.tmp` files of its surface folder before it writes.
- Removal: a removed tab stops its program, refuses a later change with `tab <tab> was removed; its role cannot change`, and discards its held messages with one `skipped` record each.
- Resume: the program starts with its own command, the first message is sent again, and reread requests follow each not-busy report until the agent confirms.
- Confirmation: both ways, `sok role confirm` and the answer line, give `ready` for the current fingerprint and the stale error `stale fingerprint: read the role file again at <path>` for an older one; the command way is tested only for an agent with a shell.
- Requests: one request at each not-busy report while `pending`, each written to the record `plugin.<plugin>.messages.delivered` with kind `role-reread`, and no limit: a third and later request name the same path and fingerprint.
- Format: the `projects.json` reader refuses format 3 with `<file>: projects: format must be 4, found 3`; a tab without the member `role`, or with a member that is neither `null` nor a valid record, is refused with the error of [tab role state](#tab-role-state); the writer writes format 4, and a tab created without a role stores `null`.
- Repetition and concurrency: the tests of [idempotency](#tests-of-the-repetitions) and [concurrency](#tests-of-the-concurrency).
- Sidecar open: the four refusals with their texts `open program must be a non-empty text`, `open args must be an array of texts`, `open args require program` and `open program and shell are both set`; the `openFailed` reply with `program not found: <program>`; and the rule that a program session has no shell integration.
- `roles.json`: format number, identifier rule and unknown role refusal, each with its error text: `<file>: roles: format must be 2, found <value>`, `<file>: roles: invalid role identifier <id>` and `unknown agent role <id>`.

### Acceptance

The acceptance target is `test-app-agent-role`. Core declares no window check that names an agent CLI or a plugin, so the target is declared by the repository of the terminal plugin. It runs the real Claude Code and Codex in an application with that plugin installed, in a disposable configuration directory and a project folder that the CLI already trusts. It runs only locally, needs a display, and runs only when the person runs it. The window-check rules of [AGENTS](../../AGENTS.md#verification) apply, and it is not part of `make test-app`.

The target judges the role state only. For each CLI it:

1. writes a role definition holding a random nonce of the run, opens a tab with the CLI and the role through `core.layout.open`, and waits for the status `core.tab.role` and the program state, not for a timer;
2. waits for `ready`, and requires that the confirmed fingerprint in the record equals the fingerprint that the target computes from `roles.json` with the algorithm of this document; the nonce is unknown before the agent reads the file, so this proves that the agent read the last line of the file;
3. changes the role with `core.tab.role` to a new definition with a new nonce, and waits for `ready` for the new generation with the new fingerprint;
4. resumes the session and waits for `ready` with the same fingerprint after the reread request;
5. repeats step 2 with the answer line, and for an agent with a shell, repeats it with `sok role confirm`;
6. requires that no nonce appears in the persistent memory files of the CLI or in `AGENTS.md` and `CLAUDE.md` of the project folder.

An agent that never confirms stays `pending`; the target never reports a pass for a `pending` state.

A missing `claude` or `codex` command fails the target with `command not found: <program>`, and no test is skipped. Each test has its own time limit and prints `running`, `finished`, `passed` or `failed` with its elapsed time ([AGENTS](../../AGENTS.md#verification)).

## Verification boundaries

The launch of each CLI is verified when the acceptance target runs for it, and again for each new version of the CLI that changes its launch options. Until the target exists and its run is recorded in [features](../features.md), the claims that depend on it are unverified.

## Review

Objections were raised against each revision of this decision and are answered below. Objections about wording are answered by the wording of the sections above.

Answered and applied:

- Launch adapters are removed: every CLI starts with its `program` and `args`, and receives its identity as its first message. One path needs no code for each CLI. The measured trade-off is that a first message can be lost to context compaction; the reread requests and the change messages restore the role.
- The reread requests repeat at each not-busy report until the agent confirms, with no limit. The reason is convergence by repetition: the file holds the current role, and each request names that path and the current fingerprint, so a repeated request reaches the same confirmation. A cap would end the loop before the agent confirms.
- Held work messages wait for `ready`, because the role play proceeds only after the fingerprint is confirmed.
- `roles.json` holds the role text, because a role named by its identifier needs one place for its text.
- Both confirmation ways stay. The line form serves every CLI; `sok role confirm` serves a CLI that puts a letter or digit before the line, since the line matcher refuses such a row.
- The mode checks, the leftover cleanup, the failure texts, the restore of `projects.json`, the validation refusals, and the removed-tab and skipped records stay. AGENTS.md requires an explicit error at the boundary, every error reported, and no input dropped silently.
- A running tab cannot lose its role is removed: setting `role` to `null` clears the role, with no special refusal.
- The launch-record identity check is removed, because it is a session-record check, and unknown agents must pass without one.
- The leadership paragraph is removed; it stated a question that the design does not settle.
- The queue order, the sender rule, the foreground rule and the framing move to [role messages](messaging.md#role-messages).

- The change message is not a reread request; the first request after the change message is the first request of the generation.
- An assignment of the same role writes no file and changes no state.
- A line in the answer shows that the agent holds the fingerprint of the current file, not that it read the file.
- The fingerprint reference file pins the texts of the role file, the identity, the change message, the reread request, the first message suffix.
- A restart without a stored confirmation gives `pending`.
- A running tab cannot lose its role.
- The first message suffix is a pinned text.
- The hold reason `role-pending` is named in the hold list of messaging.
- The tool output of the program counts for the line form, and the spec states it.
- A confirmation value that is not 16 lowercase hexadecimal characters is invalid input with `fingerprint <value> is not 16 lowercase hexadecimal characters` and is not compared with the stale rule.
- A stored definition without a final line feed gets one in the file; its fingerprint uses the stored text.
- A surface identifier that contains a path separator, a `..` segment or a control character is refused with `surface "<value>" holds a path part or a control character`, and nothing is written.
- A surface is one tab, so its role file belongs to that tab only.
- A failed identity or role file write at a launch is refused with `role file <path>: write failed: <os error>` and starts no program.
- A removed tab discards its held messages, each with a `skipped` record.
- A launch deletes leftover `.role-*.tmp` files before it writes.
- A restart with the program running keeps the stored record; a resume clears it.
- Tests name their owning packages.
- The English and Korean texts state the same rules.
- The start parameters `program`, `args` and `role` reach the sidecar `open` request, and every program takes its identity in its first message.
- The status `core.tab.role` and the role command replies carry `fingerprint` and `generation`, so the page composes the reread request from them.
- The line form is matched against the visible rows that `<plugin>.screen.read` reads after each change of the visible rows; a wrapped line or a line that scrolls off does not match.
- The memory statement is limited to the measured launch options.

Answered without change:


- A confirmation line that the terminal wraps does not match, and the state stays `pending`; a reread request asks again. The spec already states this, so no rule is added.

Open:

- The terms `fingerprint`, `generation`, `reread request`, `confirmation`, `role message`, `delivery record` and `error display` are listed in the kit term list by a kit commit. The core term check reads them after the kit release and its pin, which the checklist tracks.
