//! `sok conversation read`: the messages of the conversation of an agent, read from its session file (docs/spec/agent-conversation.md).

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{Value, json};

use crate::Error;
use crate::files::file_error;

/// The agents whose session files the command reads.
#[derive(Clone, Copy)]
enum Agent {
    ClaudeCode,
    Codex,
}

impl Agent {
    fn name(self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude-code",
            Agent::Codex => "codex",
        }
    }
}

/// The session file that the selection chose, with its records and the messages read from them.
struct Conversation {
    file: PathBuf,
    messages: Vec<Value>,
    skipped: u64,
}

/// Runs the conversation commands; `args` are the arguments after the word `conversation`.
pub(crate) fn run(args: &[String], stdout: &mut dyn Write) -> Result<(), Error> {
    if args.len() == 1 && args[0] == "--help" {
        writeln!(stdout, "{}", crate::USAGE).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if args.is_empty() {
        return Err(Error::Usage("conversation requires an action".into()));
    }
    if args[0] != "read" {
        return Err(Error::Usage(format!(
            "unknown command: conversation {}",
            args.join(" ")
        )));
    }
    let parsed = crate::parse_scoped_arguments(&args[1..], &["help"], &["agent", "cwd"])?;
    if parsed.flag("help") {
        writeln!(stdout, "{}", crate::USAGE).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if let Some(extra) = parsed.positionals.first() {
        return Err(Error::Usage(format!("unexpected argument {extra}")));
    }
    let agent = match parsed.required("agent")?.as_str() {
        "claude-code" => Agent::ClaudeCode,
        "codex" => Agent::Codex,
        other => return Err(Error::Failed(format!("unknown agent {other}"))),
    };
    let cwd = parsed.required("cwd")?;
    if !Path::new(&cwd).is_absolute() {
        return Err(Error::Failed(format!("cwd is not an absolute path: {cwd}")));
    }
    let home = match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() => crate::files::utf8_path(PathBuf::from(home))
            .map_err(|escaped| Error::Failed(format!("HOME is not UTF-8: {escaped}")))?,
        _ => return Err(Error::Failed("HOME is not set".into())),
    };
    let conversation = read_conversation(agent, &home, &cwd)?;
    let output = json!({
        "file": conversation.file.display().to_string(),
        "messages": conversation.messages,
        "skipped": conversation.skipped,
    });
    writeln!(stdout, "{output}").map_err(|error| error.to_string())?;
    Ok(())
}

/// Selects the session file whose working directory is `cwd` and reads its messages.
fn read_conversation(agent: Agent, home: &Path, cwd: &str) -> Result<Conversation, Error> {
    let mut candidates = Vec::new();
    match agent {
        Agent::ClaudeCode => {
            let folder = home
                .join(".claude")
                .join("projects")
                .join(claude_folder_name(cwd));
            for path in list_folder(&folder)? {
                if is_regular_file(&path)? && has_extension(&path, "jsonl") {
                    candidates.push(path);
                }
            }
        }
        Agent::Codex => collect_rollouts(&home.join(".codex").join("sessions"), &mut candidates)?,
    }
    candidates.sort();

    // The chosen file is the matching one with the latest modification time; a tie keeps the file first in path order.
    let mut chosen: Option<(SystemTime, PathBuf)> = None;
    for path in candidates {
        if session_cwd(agent, &path)? != cwd {
            continue;
        }
        let modified = std::fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .map_err(|error| Error::Failed(file_error(path.display(), &error)))?;
        if chosen.as_ref().is_none_or(|(time, _)| modified > *time) {
            chosen = Some((modified, path));
        }
    }
    let Some((_, file)) = chosen else {
        return Err(Error::Failed(format!(
            "no {} session file has the working directory {cwd}",
            agent.name()
        )));
    };
    let records = read_records(&file)?;
    let (messages, skipped) = match agent {
        Agent::ClaudeCode => claude_messages(&file, &records)?,
        Agent::Codex => codex_messages(&file, &records)?,
    };
    Ok(Conversation {
        file,
        messages,
        skipped,
    })
}

/// The folder name of a Claude Code session: each UTF-16 code unit that is not an ASCII letter or digit is written as `-`. A name
/// longer than 200 characters is its first 200 characters, `-` and the base-36 text of the absolute value of the hash of the working
/// directory (docs/spec/agent-conversation.md#claude-code; the length rule is unverified).
fn claude_folder_name(cwd: &str) -> String {
    let name: String = cwd
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() => char::from(byte),
            _ => '-',
        })
        .collect();
    if name.len() <= 200 {
        return name;
    }
    format!(
        "{}-{}",
        &name[..200],
        base36(claude_hash(cwd).unsigned_abs())
    )
}

/// The hash of a working directory of Claude Code: `hash = (hash << 5) - hash + unit` over its UTF-16 code units, each step
/// wrapped to a signed 32-bit integer.
fn claude_hash(cwd: &str) -> i32 {
    cwd.encode_utf16().fold(0i32, |hash, unit| {
        hash.wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit))
    })
}

/// The base-36 text of `value` with lowercase digits.
fn base36(mut value: u32) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut digits = Vec::new();
    loop {
        digits.push(char::from(DIGITS[(value % 36) as usize]));
        value /= 36;
        if value == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

/// The entries of a folder, or none when the folder does not exist: an agent that wrote no session has no folder.
fn list_folder(folder: &Path) -> Result<Vec<PathBuf>, Error> {
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(Error::Failed(file_error(folder.display(), &error))),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| Error::Failed(file_error(folder.display(), &error)))?;
        let path = crate::files::utf8_path(entry.path())
            .map_err(|escaped| Error::Failed(format!("{escaped}: the path is not UTF-8")))?;
        paths.push(path);
    }
    Ok(paths)
}

/// Adds the rollout files of a Codex sessions folder at any depth to `out`.
fn collect_rollouts(folder: &Path, out: &mut Vec<PathBuf>) -> Result<(), Error> {
    for path in list_folder(folder)? {
        let Some(file_name) = path.file_name() else {
            return Err(Error::Failed(format!(
                "{}: the folder entry has no file name",
                path.display()
            )));
        };
        let name = file_name.to_string_lossy().into_owned();
        // A symbolic link is neither followed nor a candidate, so a link that leads back up the tree cannot repeat a folder.
        let link = std::fs::symlink_metadata(&path)
            .map_err(|error| Error::Failed(file_error(path.display(), &error)))?;
        if link.is_dir() {
            collect_rollouts(&path, out)?;
        } else if name.starts_with("rollout-")
            && has_extension(&path, "jsonl")
            && is_regular_file(&path)?
        {
            out.push(path);
        }
    }
    Ok(())
}

/// Whether the path is a regular file. A symbolic link is not a regular file, so it is not a candidate.
fn is_regular_file(path: &Path) -> Result<bool, Error> {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file())
        .map_err(|error| Error::Failed(file_error(path.display(), &error)))
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension().is_some_and(|found| found == extension)
}

/// The records of a session file with their physical line numbers. Every line that is not blank must be a JSON object; a blank line
/// is not a record.
fn read_records(path: &Path) -> Result<Vec<(usize, Value)>, Error> {
    let file = std::fs::File::open(path)
        .map_err(|error| Error::Failed(file_error(path.display(), &error)))?;
    let mut records = Vec::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| Error::Failed(file_error(path.display(), &error)))?;
        if let Some(record) = parse_record(path, index + 1, &line)? {
            records.push((index + 1, record));
        }
    }
    Ok(records)
}

/// The JSON object of a line, or none for a blank line. Any other line is refused with its number.
fn parse_record(path: &Path, line_number: usize, line: &str) -> Result<Option<Value>, Error> {
    if line.trim().is_empty() {
        return Ok(None);
    }
    match serde_json::from_str::<Value>(line) {
        Ok(record) if record.is_object() => Ok(Some(record)),
        _ => Err(Error::Failed(format!(
            "{}: line {line_number} is not a JSON object",
            path.display()
        ))),
    }
}

/// The session working directory of a candidate, read from the lines up to the record that gives it: for Claude Code the `cwd` of
/// the first record that has one, for Codex the `payload.cwd` of the first record, which must be a `session_meta` record. A file
/// without that record, or whose value is not a string, is refused.
fn session_cwd(agent: Agent, path: &Path) -> Result<String, Error> {
    let file = std::fs::File::open(path)
        .map_err(|error| Error::Failed(file_error(path.display(), &error)))?;
    let refused = || {
        Error::Failed(format!(
            "{}: the session working directory is missing or not a string",
            path.display()
        ))
    };
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| Error::Failed(file_error(path.display(), &error)))?;
        let Some(record) = parse_record(path, index + 1, &line)? else {
            continue;
        };
        let value = match agent {
            Agent::ClaudeCode => match record.get("cwd") {
                Some(value) => value,
                None => continue,
            },
            Agent::Codex => {
                let is_meta = record.get("type").and_then(Value::as_str) == Some("session_meta");
                match record.get("payload").and_then(|payload| payload.get("cwd")) {
                    Some(value) if is_meta => value,
                    _ => return Err(refused()),
                }
            }
        };
        return value.as_str().map(str::to_owned).ok_or_else(refused);
    }
    Err(refused())
}

/// The refusal of a line of the file at `path`, with its number and the reason.
fn line_error(path: &Path, line_number: usize, reason: &str) -> Error {
    Error::Failed(format!("{}: line {line_number} {reason}", path.display()))
}

/// The messages of Claude Code records and the number of records that are not messages with text.
fn claude_messages(path: &Path, records: &[(usize, Value)]) -> Result<(Vec<Value>, u64), Error> {
    let mut messages = Vec::new();
    let mut skipped = 0;
    for (line_number, record) in records {
        // silent: a record whose type is not a string is not a user or assistant message, and is counted in skipped.
        let role = match record.get("type").and_then(Value::as_str) {
            Some(role @ ("user" | "assistant")) => role,
            _ => {
                skipped += 1;
                continue;
            }
        };
        // A message that is not an object has no content, so it is refused with the message content refusal below.
        let content = record
            .get("message")
            .and_then(|message| message.get("content"));
        let (text, images) = match content {
            Some(Value::String(text)) => (text.clone(), 0),
            Some(Value::Array(blocks)) => {
                let images = count_items(path, *line_number, blocks, "image")?;
                (joined_text(path, *line_number, blocks, &["text"])?, images)
            }
            _ => {
                return Err(line_error(
                    path,
                    *line_number,
                    "has a message content that is neither a string nor a list",
                ));
            }
        };
        if text.is_empty() && images == 0 {
            skipped += 1;
        } else {
            messages.push(message_value(role, text, images));
        }
    }
    Ok((messages, skipped))
}

/// The messages of Codex records and the number of records that are not messages with text.
fn codex_messages(path: &Path, records: &[(usize, Value)]) -> Result<(Vec<Value>, u64), Error> {
    let mut messages = Vec::new();
    let mut skipped = 0;
    for (line_number, record) in records {
        // silent: a record without a payload object, or whose payload type is not a string, is not a message, and is counted in
        // skipped.
        let payload = record.get("payload");
        let is_message = record.get("type").and_then(Value::as_str) == Some("response_item")
            && payload
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
                == Some("message");
        if !is_message {
            skipped += 1;
            continue;
        }
        let Some(Value::Array(items)) = payload.and_then(|payload| payload.get("content")) else {
            return Err(line_error(
                path,
                *line_number,
                "has a message content that is not a list",
            ));
        };
        let text = joined_text(path, *line_number, items, &["input_text", "output_text"])?;
        let images = count_items(path, *line_number, items, "input_image")?;
        // silent: a message without a string role is neither user nor assistant, and is counted in skipped.
        let role = payload
            .and_then(|payload| payload.get("role"))
            .and_then(Value::as_str);
        match role {
            Some(role @ ("user" | "assistant")) if !text.is_empty() || images > 0 => {
                messages.push(message_value(role, text, images));
            }
            _ => skipped += 1,
        }
    }
    Ok((messages, skipped))
}

/// The object of a content item and its `type`. A content item that is not a JSON object with a string type is refused with its
/// line number.
fn content_item<'a>(
    path: &Path,
    line_number: usize,
    item: &'a Value,
) -> Result<(&'a Value, &'a str), Error> {
    match item.get("type").and_then(Value::as_str) {
        Some(kind) if item.is_object() => Ok((item, kind)),
        _ => Err(line_error(
            path,
            line_number,
            "has a content item that is not an object with a string type",
        )),
    }
}

/// The number of items whose `type` is `kind`. A content item that is not an object with a string type is refused.
fn count_items(
    path: &Path,
    line_number: usize,
    items: &[Value],
    kind: &str,
) -> Result<usize, Error> {
    let mut count = 0;
    for item in items {
        let (_, item_kind) = content_item(path, line_number, item)?;
        if item_kind == kind {
            count += 1;
        }
    }
    Ok(count)
}

/// A message with its role and text, and with `items` holding one `{"type": "image"}` for each of its `images` image items.
fn message_value(role: &str, text: String, images: usize) -> Value {
    let mut message = json!({"role": role, "text": text});
    if images > 0 {
        message["items"] = Value::Array(vec![json!({"type": "image"}); images]);
    }
    message
}

/// The `text` fields of the items whose `type` is one of `kinds`, joined with a newline in their order. A matching item whose
/// `text` is not a string is refused with its line number.
fn joined_text(
    path: &Path,
    line_number: usize,
    items: &[Value],
    kinds: &[&str],
) -> Result<String, Error> {
    let mut texts = Vec::new();
    for item in items {
        let (object, kind) = content_item(path, line_number, item)?;
        if !kinds.contains(&kind) {
            continue;
        }
        match object.get("text").and_then(Value::as_str) {
            Some(text) => texts.push(text),
            None => {
                return Err(line_error(
                    path,
                    line_number,
                    "has a text that is not a string",
                ));
            }
        }
    }
    Ok(texts.join("\n"))
}
