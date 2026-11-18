//! Checks `sok conversation read` (docs/spec/agent-conversation.md) with the built sok and session files that each test writes into
//! its own disposable home folder. No test reads the home folder of the person: HOME is set to the disposable folder of the test.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

/// Runs `sok conversation read` with `args` and only the HOME variable of `home`, and returns the status and both outputs.
fn run_conversation(home: &Path, args: &[&str]) -> (i32, String, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_sok"));
    command
        .arg("conversation")
        .arg("read")
        .args(args)
        .env_clear()
        .env("HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = command.output().expect("sok runs");
    (
        output.status.code().expect("exit status"),
        String::from_utf8(output.stdout).expect("stdout"),
        String::from_utf8(output.stderr).expect("stderr"),
    )
}

/// Writes `lines` as the content of `path`, one JSON record per line, creating the parent folders.
fn write_records(path: &Path, lines: &[Value]) {
    std::fs::create_dir_all(path.parent().expect("parent")).expect("session folder");
    let mut text = String::new();
    for line in lines {
        text.push_str(&line.to_string());
        text.push('\n');
    }
    std::fs::write(path, text).expect("session file");
}

/// The Claude Code records of a session whose working directory is `cwd`: one non-message record, one user message, one assistant
/// message with a tool call and a text block, and one user record that holds only a tool result.
fn claude_records(cwd: &str, user_text: &str, assistant_text: &str) -> Vec<Value> {
    vec![
        json!({"type": "attachment", "cwd": cwd, "sessionId": "session"}),
        json!({"type": "user", "cwd": cwd, "message": {"role": "user", "content": user_text}}),
        json!({"type": "assistant", "cwd": cwd, "message": {"role": "assistant", "content": [
            {"type": "text", "text": assistant_text},
            {"type": "tool_use", "id": "call", "name": "read", "input": {}}
        ]}}),
        json!({"type": "user", "cwd": cwd, "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "call", "content": "ok"}
        ]}}),
    ]
}

/// The Codex records of a session whose working directory is `cwd`: a session_meta record, a developer message, a user message, a
/// reasoning record and an assistant message.
fn codex_records(cwd: &str, user_text: &str, assistant_text: &str) -> Vec<Value> {
    vec![
        json!({"type": "session_meta", "payload": {"id": "session", "cwd": cwd}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [
            {"type": "input_text", "text": "policy"}
        ]}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": user_text}
        ]}}),
        json!({"type": "response_item", "payload": {"type": "reasoning", "summary": []}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [
            {"type": "output_text", "text": assistant_text}
        ]}}),
    ]
}

fn expected_output(file: &Path, messages: Value, skipped: u64) -> Value {
    json!({"file": file.display().to_string(), "messages": messages, "skipped": skipped})
}

// contract: conversation.claude-code.selects-the-file-by-cwd
#[test]
fn claude_code_file_is_selected_by_cwd() {
    let home = Folder::new("conversation-claude");
    let cwd = "/work/project.one/core";
    let file = home
        .path()
        .join(".claude/projects/-work-project-one-core/session.jsonl");
    write_records(&file, &claude_records(cwd, "question", "answer"));
    let other = home.path().join(".claude/projects/-work-other/session.jsonl");
    write_records(&other, &claude_records("/work/other", "other", "other"));

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "claude-code", "--cwd", cwd]);

    assert_eq!(
        (code, stderr.as_str()),
        (0, ""),
        "exit status and standard error"
    );
    let output: Value = serde_json::from_str(&stdout).expect("JSON output");
    assert_eq!(
        output,
        expected_output(
            &file,
            json!([
                {"role": "user", "text": "question"},
                {"role": "assistant", "text": "answer"}
            ]),
            2
        )
    );
}

// contract: conversation.codex.selects-the-file-by-payload-cwd
#[test]
fn codex_file_is_selected_by_payload_cwd() {
    let home = Folder::new("conversation-codex");
    let cwd = "/work/project.one/core";
    let file = home
        .path()
        .join(".codex/sessions/2026/11/18/rollout-2026-11-18T10-00-00-session.jsonl");
    write_records(&file, &codex_records(cwd, "question", "answer"));
    let other = home
        .path()
        .join(".codex/sessions/2026/11/17/rollout-2026-11-17T10-00-00-other.jsonl");
    write_records(&other, &codex_records("/work/other", "other", "other"));

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "codex", "--cwd", cwd]);

    assert_eq!(
        (code, stderr.as_str()),
        (0, ""),
        "exit status and standard error"
    );
    let output: Value = serde_json::from_str(&stdout).expect("JSON output");
    assert_eq!(
        output,
        expected_output(
            &file,
            json!([
                {"role": "user", "text": "question"},
                {"role": "assistant", "text": "answer"}
            ]),
            3
        )
    );
}

// contract: conversation.selects-the-most-recently-modified-file
#[test]
fn two_matching_files_choose_the_most_recently_modified() {
    let home = Folder::new("conversation-recent");
    let cwd = "/work/project.one/core";
    let folder = home.path().join(".claude/projects/-work-project-one-core");
    let older = folder.join("a-older.jsonl");
    let newer = folder.join("z-newer.jsonl");
    write_records(&older, &claude_records(cwd, "older", "older"));
    write_records(&newer, &claude_records(cwd, "newer", "newer"));
    let base = SystemTime::now();
    std::fs::File::options()
        .write(true)
        .open(&older)
        .expect("older file")
        .set_modified(base - Duration::from_secs(3600))
        .expect("older time");
    std::fs::File::options()
        .write(true)
        .open(&newer)
        .expect("newer file")
        .set_modified(base)
        .expect("newer time");

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "claude-code", "--cwd", cwd]);

    assert_eq!(
        (code, stderr.as_str()),
        (0, ""),
        "exit status and standard error"
    );
    let output: Value = serde_json::from_str(&stdout).expect("JSON output");
    assert_eq!(
        output["file"],
        json!(newer.display().to_string()),
        "the chosen file"
    );
    assert_eq!(
        output["messages"],
        json!([
            {"role": "user", "text": "newer"},
            {"role": "assistant", "text": "newer"}
        ])
    );
}

// contract: conversation.refuses-when-no-file-matches
#[test]
fn no_matching_file_is_refused_with_the_cwd() {
    let home = Folder::new("conversation-none");
    write_records(
        &home.path().join(".claude/projects/-work-other/session.jsonl"),
        &claude_records("/work/other", "other", "other"),
    );

    let (code, stdout, stderr) =
        run_conversation(&home, &["--agent", "claude-code", "--cwd", "/work/none"]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            "sok: no claude-code session file has the working directory /work/none\n"
        )
    );
}

// contract: conversation.refuses-a-relative-cwd
#[test]
fn relative_cwd_is_refused() {
    let home = Folder::new("conversation-relative");

    let (code, stdout, stderr) =
        run_conversation(&home, &["--agent", "codex", "--cwd", "relative/core"]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            "sok: cwd is not an absolute path: relative/core\n"
        )
    );
}

// contract: conversation.refuses-an-unknown-agent
#[test]
fn unknown_agent_is_refused() {
    let home = Folder::new("conversation-agent");

    let (code, stdout, stderr) =
        run_conversation(&home, &["--agent", "cursor", "--cwd", "/work/project"]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (1, "", "sok: unknown agent cursor\n")
    );
}

// contract: conversation.refuses-an-unreadable-file-with-its-reason
#[test]
fn unreadable_file_is_refused_with_its_reason() {
    use std::os::unix::fs::PermissionsExt;

    let home = Folder::new("conversation-unreadable");
    let cwd = "/work/project.one/core";
    let file = home
        .path()
        .join(".claude/projects/-work-project-one-core/session.jsonl");
    write_records(&file, &claude_records(cwd, "question", "answer"));
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).expect("mode");

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "claude-code", "--cwd", cwd]);

    // Restores the mode so that the folder can be removed when the test ends.
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).expect("mode");
    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            format!("sok: {}: permission denied\n", file.display()).as_str()
        )
    );
}
