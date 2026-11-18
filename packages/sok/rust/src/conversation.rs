//! `sok conversation read`: the messages of the conversation of an agent, read from its session file (docs/spec/agent-conversation.md).

use std::io::Write;
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
        Some(home) if !home.is_empty() => PathBuf::from(home),
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
    let mut chosen: Option<(SystemTime, PathBuf, Vec<Value>)> = None;
    for path in candidates {
        let records = read_records(&path)?;
        if session_cwd(agent, &records).and_then(Value::as_str) != Some(cwd) {
            continue;
        }
        let modified = std::fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .map_err(|error| Error::Failed(file_error(path.display(), &error)))?;
        if chosen.as_ref().is_none_or(|(time, _, _)| modified > *time) {
            chosen = Some((modified, path, records));
        }
    }
    let Some((_, file, records)) = chosen else {
        return Err(Error::Failed(format!(
            "no {} session file has the working directory {cwd}",
            agent.name()
        )));
    };
    let (messages, skipped) = match agent {
        Agent::ClaudeCode => claude_messages(&records),
        Agent::Codex => codex_messages(&records),
    };
    Ok(Conversation {
        file,
        messages,
        skipped,
    })
}

/// The folder name of a Claude Code session: each character that is not an ASCII letter or digit is written as `-`.
fn claude_folder_name(cwd: &str) -> String {
    cwd.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
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
        paths.push(entry.path());
    }
    Ok(paths)
}

/// Adds the rollout files of a Codex sessions folder at any depth to `out`.
fn collect_rollouts(folder: &Path, out: &mut Vec<PathBuf>) -> Result<(), Error> {
    for path in list_folder(folder)? {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        // A symbolic link to a folder is not followed, so a link that leads back up the tree cannot repeat a folder.
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

/// Whether the path is a regular file after symbolic links are followed.
fn is_regular_file(path: &Path) -> Result<bool, Error> {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .map_err(|error| Error::Failed(file_error(path.display(), &error)))
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension().is_some_and(|found| found == extension)
}

/// The records of a session file. Every line that is not blank must be a JSON object; a blank line is not a record.
fn read_records(path: &Path) -> Result<Vec<Value>, Error> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| Error::Failed(file_error(path.display(), &error)))?;
    let mut records = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(record) if record.is_object() => records.push(record),
            _ => {
                return Err(Error::Failed(format!(
                    "{}: line {} is not a JSON object",
                    path.display(),
                    index + 1
                )));
            }
        }
    }
    Ok(records)
}

/// The working directory of a session: for Claude Code the `cwd` of the first record that has one, for Codex the `payload.cwd`
/// of its `session_meta` record.
fn session_cwd(agent: Agent, records: &[Value]) -> Option<&Value> {
    match agent {
        Agent::ClaudeCode => records.iter().find_map(|record| record.get("cwd")),
        Agent::Codex => records
            .iter()
            .find(|record| record.get("type").and_then(Value::as_str) == Some("session_meta"))
            .and_then(|record| record.get("payload"))
            .and_then(|payload| payload.get("cwd")),
    }
}

/// The messages of Claude Code records and the number of records that are not messages with text.
fn claude_messages(records: &[Value]) -> (Vec<Value>, u64) {
    let mut messages = Vec::new();
    let mut skipped = 0;
    for record in records {
        let role = match record.get("type").and_then(Value::as_str) {
            Some(role @ ("user" | "assistant")) => role,
            _ => {
                skipped += 1;
                continue;
            }
        };
        let content = record.get("message").and_then(|message| message.get("content"));
        let text = match content {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(blocks)) => joined_text(blocks, &["text"]),
            _ => String::new(),
        };
        if text.is_empty() {
            skipped += 1;
        } else {
            messages.push(json!({"role": role, "text": text}));
        }
    }
    (messages, skipped)
}

/// The messages of Codex records and the number of records that are not messages with text.
fn codex_messages(records: &[Value]) -> (Vec<Value>, u64) {
    let mut messages = Vec::new();
    let mut skipped = 0;
    for record in records {
        let payload = record.get("payload");
        let is_message = record.get("type").and_then(Value::as_str) == Some("response_item")
            && payload.and_then(|payload| payload.get("type")).and_then(Value::as_str)
                == Some("message");
        let role = payload.and_then(|payload| payload.get("role")).and_then(Value::as_str);
        let role = match (is_message, role) {
            (true, Some(role @ ("user" | "assistant"))) => role,
            _ => {
                skipped += 1;
                continue;
            }
        };
        let content = payload.and_then(|payload| payload.get("content"));
        let text = match content {
            Some(Value::Array(items)) => joined_text(items, &["input_text", "output_text"]),
            _ => String::new(),
        };
        if text.is_empty() {
            skipped += 1;
        } else {
            messages.push(json!({"role": role, "text": text}));
        }
    }
    (messages, skipped)
}

/// The `text` fields of the items whose `type` is one of `kinds`, joined with a newline in their order.
fn joined_text(items: &[Value], kinds: &[&str]) -> String {
    items
        .iter()
        .filter(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kinds.contains(&kind))
        })
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}
