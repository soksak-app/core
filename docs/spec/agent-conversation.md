# Agent conversation

[한국어](agent-conversation.ko.md)

`sok conversation read` returns the messages of the conversation of an agent that works in a working directory. It reads the session file that the agent writes on disk, so it needs no running application and no [endpoint](endpoint.md). Each agent is read by its own rules below; the command reads no other file and changes no file.

This contract defines the approved agent conversation read. Implementation and verification are tracked in [features](../features.md); approval of this contract does not establish implementation.

## Command

`sok conversation read --agent <agent> --cwd <path>` takes the input `{agent, cwd}`:

| Field | Value |
| --- | --- |
| `agent` | `claude-code` or `codex`; any other value is refused |
| `cwd` | An absolute path, compared with the working directory of the session as written, without resolving symbolic links; a relative path is refused |

The command writes one JSON object on standard output:

```json
{"file": "<absolute path of the session file read>", "messages": [{"role": "user", "text": "..."}], "skipped": 0}
```

- `file` is the session file that the selection chose ([selection](#selection)).
- `messages` holds every message of that file, in the order of its records. `role` is `user` or `assistant`. `text` is the text of the message: a string, or the text blocks of the message joined with a newline in their order. A message whose text is empty is not a message.
- `skipped` is the number of records of the file that are not messages with text. A blank line is not a record and is not counted.

The command has the [output and exit status](cli.md#output-and-exit-status) of every `sok` command: a refusal is written to standard error as `sok: <message>` with exit status 1, and a usage error (a missing or unknown option) has exit status 2.

## Session file locations

`<home>` is the value of `HOME`. A command that needs it fails with `HOME is not set` when it is not set or empty ([agents](cli.md#agents)).

### Claude Code

Claude Code writes `<home>/.claude/projects/<encoded cwd>/<sessionId>.jsonl`. The encoded cwd is the working directory in which every character that is not an ASCII letter or digit is replaced by `-`.

Observed on 2026-11-18 with `/bin/ls "$HOME/.claude/projects"`: all 72 folder names match `-[A-Za-z0-9-]*`. A working directory whose path contains a `/` component, a `.` component (a dot-prefixed folder), or a space has each of those characters written as `-` in its folder name; for example the folder of a session whose working directory is a dot-prefixed folder under the home folder ends in `--<name>`. No folder name contains `_` or a non-ASCII character; the replacement of those characters is not observed and the rule for them is unverified.

Records of a session file are JSON objects. A record's `type` is the kind of the record: `user` and `assistant` are the messages of the conversation; other kinds (`attachment`, `system`, `api-request`, `last-prompt` and others) are not messages. A message's `message.content` is a string or a list of blocks; the blocks of type `text` carry the text, and a `tool_use`, `tool_result` or `thinking` block carries no text in the read. A record that has a top-level `cwd` field carries the working directory of the record; the session's working directory is the `cwd` of its first record that has one.

### Codex

Codex writes `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Each file starts with a record of type `session_meta` whose `payload.cwd` is the working directory of the session. Observed on 2026-11-18 in one sampled file: the first record is `session_meta` and carries `payload.cwd`; a `turn_context` record also carries `payload.cwd`, which the read does not use.

A message is a record of type `response_item` whose `payload.type` is `message` and whose `payload.role` is `user` or `assistant`. Its text is the `text` field of each `payload.content` item of type `input_text` or `output_text`, joined with a newline in their order. A message of role `developer` is not a message of this read and counts in `skipped`.

## Selection

1. Candidates for `claude-code` are the `*.jsonl` files of `<home>/.claude/projects/<encoded cwd>/`, with the encoding of the requested cwd. Candidates for `codex` are the `rollout-*.jsonl` files below `<home>/.codex/sessions/`, at any depth.
2. A candidate matches when the session working directory of the file equals the requested `cwd` exactly: for `claude-code` the `cwd` of its first record that has one, for `codex` the `payload.cwd` of its `session_meta` record.
3. Among the matching files, the command chooses the most recently modified one. Two files with the same modification time are ordered by path, and the first in ascending path order is chosen.
4. When no file matches, the command refuses with `no <agent> session file has the working directory <cwd>`.

A candidate that cannot be read, or whose required record cannot be parsed, fails the command with the refusal of [refusals](#refusals); the command does not skip it.

## Refusals

Each refusal is an explicit error with exit status 1. Nothing is dropped silently.

| Condition | Message |
| --- | --- |
| `--agent` is not `claude-code` or `codex` | `unknown agent <agent>` |
| `--cwd` is not an absolute path | `cwd is not an absolute path: <cwd>` |
| `HOME` is not set or empty | `HOME is not set` |
| No candidate matches the working directory | `no <agent> session file has the working directory <cwd>` |
| A candidate or the chosen file cannot be read | `<path>: <reason>`, the operating system reason in lower case |
| A line of a candidate is not a JSON object | `<path>: line <n> is not a JSON object` |

## Owning package

The command is implemented in `packages/sok/rust` (`src/conversation.rs`, tests in `tests/conversation_test.rs`). The Go `sok` of `packages/sok/go` implements the same command with the same contract when its implementation is registered in [features](../features.md).
