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
- `messages` holds every message of that file, in the order of its records. `role` is `user` or `assistant`. `text` is the text of the message: a string, or the text blocks of the message joined with a newline in their order. A message whose text is empty is not a message, unless it has image items ([Codex](#codex) and [Claude Code](#claude-code)).
- `skipped` is the number of records of the file that are not messages with text. A blank line is not a record and is not counted.

The command has the [output and exit status](cli.md#output-and-exit-status) of every `sok` command: a refusal is written to standard error as `sok: <message>` with exit status 1, and a usage error (a missing or unknown option) has exit status 2.

## Session file locations

`<home>` is the value of `HOME`. A command that needs it fails with `HOME is not set` when it is not set or empty ([agents](cli.md#agents)).

### Claude Code

Claude Code writes `<home>/.claude/projects/<encoded cwd>/<sessionId>.jsonl`. The encoded cwd is the working directory in which each UTF-16 code unit that is not an ASCII letter or digit is replaced by `-`; a character outside the Basic Multilingual Plane is two code units and becomes `--`. When that result is longer than 200 characters, the encoded cwd is its first 200 characters, then `-`, then the base-36 text of the absolute value of a hash of the working directory. The hash starts at 0 and, for each UTF-16 code unit `unit`, becomes `(hash << 5) - hash + unit` wrapped to a signed 32-bit integer.

The basis of the rule is the folder names that Claude Code wrote, recorded as pairs of folder name and working directory in [the folder-name cases](cases/conversation-folder-names.json); the tests of both `sok` implementations check each pair. The user-name component of each path is written as `user` in both fields, because the rule does not depend on it. The pairs cover `/`, `.`, space, digit and `-`. Observed on 2026-11-18 with `/bin/ls "$HOME/.claude/projects"`: all 72 folder names match `-[A-Za-z0-9-]*`, and the longest has 168 characters, so the truncation is not observed. A working directory whose path contains a `/` component, a `.` component (a dot-prefixed folder), or a space has each of those characters written as `-` in its folder name; for example the folder of a session whose working directory is a dot-prefixed folder under the home folder ends in `--<name>`. No folder name contains `_` or a non-ASCII character, so the replacement of those characters, and the replacement of a character outside the Basic Multilingual Plane by two `-`, are unverified. The length rule is unverified as well: the longest folder name has 168 characters, no observed name is truncated, and no test covers the truncated form. Claude Code may write a folder name by another rule under conditions the read does not observe; that effect is unverified.

Records of a session file are JSON objects. A record's `type` is the kind of the record: `user` and `assistant` are the messages of the conversation; other kinds (`attachment`, `system`, `api-request`, `last-prompt` and others) are not messages. A message's `message.content` is a string or a list of blocks; the blocks of type `text` carry the text, and a `tool_use`, `tool_result` or `thinking` block carries no text in the read. A record that has a top-level `cwd` field carries the working directory of the record; the session's working directory is the `cwd` of its first record that has one. Observed on 2026-11-18 in the 113 session files that are directly in the folders: each has a record with `cwd`, and every `cwd`, `message.content` and text block `text` is a string.

### Codex

Codex writes `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Each file starts with a record of type `session_meta` whose `payload.cwd` is the working directory of the session. Observed on 2026-11-18 in the 84 most recent rollout files: the first record of each is `session_meta`. A file may hold a second `session_meta` record (67 of the 84 files); in the 26 of the 30 most recent files that hold one, both records carry the same `payload.cwd`. A `turn_context` record also carries `payload.cwd`, which the read does not use.

A message is a record of type `response_item` whose `payload.type` is `message` and whose `payload.role` is `user` or `assistant`. Its `payload.content` is a list; its text is the `text` field of each item of type `input_text` or `output_text`, joined with a newline in their order. A message of role `developer` is not a message of this read and counts in `skipped`.

A message of role `user` or `assistant` that has image items (`input_image`) is not skipped, even when it has no text. It carries an `items` list with one `{"type": "image"}` for each image item, and the picture data is not written. A message with text and image items has both its `text` and its `items`. The reason: an image is a message content that the read reports by its kind, so a skipped message would lose that the agent sent it. The same rule applies to `claude-code` records: a `user` or `assistant` record whose `message.content` list has `image` blocks is not skipped, even without text. Its `items` has one `{"type": "image"}` per `image` block, and the picture data is not written. The record shape is unverified: no `image` block was observed in the sampled records of 2026-11-18, so the read assumes the block shape `{"type": "image", "source": {...}}` and reads only the `type` of each block. The Codex image shape is unverified in the same way; the read uses only the `type` of each `input_image` item.

## Selection

1. Candidates for `claude-code` are the regular `*.jsonl` files of `<home>/.claude/projects/<encoded cwd>/`, with the encoding of the requested cwd. Candidates for `codex` are the regular `rollout-*.jsonl` files below `<home>/.codex/sessions/`, at any depth. A symbolic link is neither a candidate nor followed, at any level, for either agent: both agents write regular files in regular folders, and no symbolic link was found below `<home>/.codex/sessions/` or in the first two levels of `<home>/.claude/projects/` on 2026-11-18.
2. A candidate matches when its session working directory equals the requested `cwd` exactly. The session working directory of a `claude-code` file is the `cwd` of its first record that has one. The session working directory of a `codex` file is the `payload.cwd` of its first record, which must be a `session_meta` record; a later `session_meta` record is not read for selection.
3. Among the matching files, the command chooses the most recently modified one. Two files with the same modification time are ordered by path, and the first in ascending path order is chosen.
4. When no file matches, the command refuses with `no <agent> session file has the working directory <cwd>`.

The read of a candidate parses its lines only up to the record that gives its session working directory. The chosen file is parsed in full, so a line of an unchosen candidate that follows that record is not parsed and cannot fail the command. A candidate that cannot be read, whose lines up to that record cannot be parsed, or whose session working directory is missing or not a string, fails the command with the refusal of [refusals](#refusals); the command does not skip it.

## Refusals

Each refusal is an explicit error with exit status 1. Nothing is dropped silently.

| Condition | Message |
| --- | --- |
| `--agent` is not `claude-code` or `codex` | `unknown agent <agent>` |
| `--cwd` is not an absolute path | `cwd is not an absolute path: <cwd>` |
| `HOME` is not set or empty | `HOME is not set` |
| No candidate matches the working directory | `no <agent> session file has the working directory <cwd>` |
| A candidate or the chosen file cannot be read | `<path>: <reason>`, the operating system reason in lower case |
| A line of a candidate or of the chosen file is not a JSON object | `<path>: line <n> is not a JSON object` |
| The session working directory of a candidate is missing or is not a string: for `claude-code`, no record has a `cwd` or the first one does not hold a string; for `codex`, the first record is not `session_meta` or its `payload.cwd` is not a string | `<path>: the session working directory is missing or not a string` |
| A `user` or `assistant` record of `claude-code` has a `message.content` that is neither a string nor a list | `<path>: line <n> has a message content that is neither a string nor a list` |
| A `codex` message record has a `payload.content` that is not a list | `<path>: line <n> has a message content that is not a list` |
| A `text` of a `claude-code` text block, or of a `codex` item of type `input_text` or `output_text`, is not a string | `<path>: line <n> has a text that is not a string` |

`<n>` counts the physical lines of the file, blank lines included.

## Owning package

The command is implemented in `packages/sok/rust` (`src/conversation.rs`, tests in `tests/conversation_test.rs`). The Go `sok` of `packages/sok/go` implements the same command with the same contract when its implementation is registered in [features](../features.md).
