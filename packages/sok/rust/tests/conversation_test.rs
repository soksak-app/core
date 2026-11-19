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
    let other = home
        .path()
        .join(".claude/projects/-work-other/session.jsonl");
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
        &home
            .path()
            .join(".claude/projects/-work-other/session.jsonl"),
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
        (1, "", "sok: cwd is not an absolute path: relative/core\n")
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

// contract: conversation.refuses-a-session-working-directory-that-is-not-a-string
#[test]
fn claude_cwd_that_is_not_a_string_is_refused() {
    let home = Folder::new("conversation-cwd-type");
    let file = home
        .path()
        .join(".claude/projects/-work-core/session.jsonl");
    write_records(
        &file,
        &[json!({"type": "user", "cwd": 5, "message": {"role": "user", "content": "question"}})],
    );

    let (code, stdout, stderr) =
        run_conversation(&home, &["--agent", "claude-code", "--cwd", "/work/core"]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            format!(
                "sok: {}: the session working directory is missing or not a string\n",
                file.display()
            )
            .as_str()
        )
    );
}

// contract: conversation.refuses-a-session-working-directory-that-is-not-a-string
#[test]
fn codex_file_that_does_not_start_with_session_meta_is_refused() {
    let home = Folder::new("conversation-codex-first");
    let cwd = "/work/core";
    let file = home
        .path()
        .join(".codex/sessions/2026/11/18/rollout-2026-11-18T10-00-00-first.jsonl");
    write_records(
        &file,
        &[
            json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": "first"}
            ]}}),
            json!({"type": "session_meta", "payload": {"id": "session", "cwd": cwd}}),
        ],
    );

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "codex", "--cwd", cwd]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            format!(
                "sok: {}: the session working directory is missing or not a string\n",
                file.display()
            )
            .as_str()
        )
    );
}

// contract: conversation.reads-an-unchosen-file-only-to-its-session-record
#[test]
fn malformed_line_after_the_session_record_of_an_unchosen_file_is_not_read() {
    let home = Folder::new("conversation-unchosen");
    let cwd = "/work/project.one/core";
    let folder = home.path().join(".claude/projects/-work-project-one-core");
    let unchosen = folder.join("a-older.jsonl");
    let chosen = folder.join("z-newer.jsonl");
    let older_record = claude_records(cwd, "older", "older")[1].to_string();
    std::fs::create_dir_all(&folder).expect("session folder");
    std::fs::write(&unchosen, format!("{older_record}\nnot a record\n")).expect("session file");
    write_records(&chosen, &claude_records(cwd, "newer", "newer"));
    let base = SystemTime::now();
    std::fs::File::options()
        .write(true)
        .open(&unchosen)
        .expect("older file")
        .set_modified(base - Duration::from_secs(3600))
        .expect("older time");
    std::fs::File::options()
        .write(true)
        .open(&chosen)
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
        json!(chosen.display().to_string()),
        "the chosen file"
    );
}

// contract: conversation.does-not-follow-symbolic-links
#[test]
fn symbolic_link_to_a_session_file_is_not_a_candidate() {
    let home = Folder::new("conversation-link");
    let cwd = "/work/core";
    let target = home
        .path()
        .join("elsewhere/rollout-2026-11-18T10-00-00-linked.jsonl");
    write_records(&target, &codex_records(cwd, "question", "answer"));
    let folder = home.path().join(".codex/sessions/2026/11/18");
    std::fs::create_dir_all(&folder).expect("session folder");
    std::os::unix::fs::symlink(
        &target,
        folder.join("rollout-2026-11-18T10-00-00-link.jsonl"),
    )
    .expect("symbolic link");

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "codex", "--cwd", cwd]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            "sok: no codex session file has the working directory /work/core\n"
        )
    );
}

// contract: conversation.refuses-a-text-that-is-not-a-string
#[test]
fn claude_text_that_is_not_a_string_is_refused() {
    let home = Folder::new("conversation-text-type");
    let cwd = "/work/core";
    let file = home
        .path()
        .join(".claude/projects/-work-core/session.jsonl");
    write_records(
        &file,
        &[
            json!({"type": "user", "cwd": cwd, "message": {"role": "user", "content": "question"}}),
            json!({"type": "assistant", "cwd": cwd, "message": {"role": "assistant", "content": [
                {"type": "text", "text": 5}
            ]}}),
        ],
    );

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "claude-code", "--cwd", cwd]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            format!(
                "sok: {}: line 2 has a text that is not a string\n",
                file.display()
            )
            .as_str()
        )
    );
}

// contract: conversation.refuses-a-content-item-that-is-not-an-object
#[test]
fn claude_content_item_that_is_not_an_object_is_refused() {
    let home = Folder::new("conversation-content-item-claude");
    let cwd = "/work/core";
    let file = home
        .path()
        .join(".claude/projects/-work-core/session.jsonl");
    write_records(
        &file,
        &[
            json!({"type": "user", "cwd": cwd, "message": {"role": "user", "content": "question"}}),
            json!({"type": "assistant", "cwd": cwd, "message": {"role": "assistant", "content": ["plain string item"]}}),
        ],
    );

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "claude-code", "--cwd", cwd]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            format!(
                "sok: {}: line 2 has a content item that is not an object with a string type\n",
                file.display()
            )
            .as_str()
        )
    );
}

// contract: conversation.refuses-a-content-item-that-is-not-an-object
#[test]
fn codex_content_item_without_a_string_type_is_refused() {
    let home = Folder::new("conversation-content-item-codex");
    let cwd = "/work/core";
    let file = home
        .path()
        .join(".codex/sessions/2026/11/18/rollout-2026-11-18T10-00-00-item.jsonl");
    write_records(
        &file,
        &[
            json!({"type": "session_meta", "payload": {"id": "session", "cwd": cwd}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"text": "question"}]}}),
        ],
    );

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "codex", "--cwd", cwd]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            format!(
                "sok: {}: line 2 has a content item that is not an object with a string type\n",
                file.display()
            )
            .as_str()
        )
    );
}

// contract: conversation.refuses-a-message-content-of-the-wrong-type
#[test]
fn claude_message_content_that_is_neither_string_nor_list_is_refused() {
    let home = Folder::new("conversation-content-type");
    let cwd = "/work/core";
    let file = home
        .path()
        .join(".claude/projects/-work-core/session.jsonl");
    write_records(
        &file,
        &[json!({"type": "user", "cwd": cwd, "message": {"role": "user", "content": null}})],
    );

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "claude-code", "--cwd", cwd]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            format!(
                "sok: {}: line 1 has a message content that is neither a string nor a list\n",
                file.display()
            )
            .as_str()
        )
    );
}

// contract: conversation.refuses-a-message-content-of-the-wrong-type
#[test]
fn codex_message_content_that_is_not_a_list_is_refused() {
    let home = Folder::new("conversation-codex-content");
    let cwd = "/work/core";
    let file = home
        .path()
        .join(".codex/sessions/2026/11/18/rollout-2026-11-18T10-00-00-content.jsonl");
    write_records(
        &file,
        &[
            json!({"type": "session_meta", "payload": {"id": "session", "cwd": cwd}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": "question"}}),
        ],
    );

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "codex", "--cwd", cwd]);

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            format!(
                "sok: {}: line 2 has a message content that is not a list\n",
                file.display()
            )
            .as_str()
        )
    );
}

/// Checks that the read selects the session file of the folder that the fixture case `label` names for its working directory.
fn check_folder_case(label: &str) {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/conversation-folder-names.json"
    );
    let text = std::fs::read_to_string(path).expect("folder name cases");
    let cases: Value = serde_json::from_str(&text).expect("folder name cases JSON");
    let case = cases
        .as_array()
        .expect("a list of cases")
        .iter()
        .find(|case| case["case"] == label)
        .unwrap_or_else(|| panic!("no folder name case {label}"));
    let folder = case["folder"].as_str().expect("folder");
    let cwd = case["cwd"].as_str().expect("cwd");
    let home = Folder::new("conversation-folder-case");
    let file = home
        .path()
        .join(".claude/projects")
        .join(folder)
        .join("session.jsonl");
    write_records(&file, &claude_records(cwd, "question", "answer"));

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "claude-code", "--cwd", cwd]);

    assert_eq!(
        (code, stderr.as_str()),
        (0, ""),
        "case {label}: exit status and standard error"
    );
    let output: Value = serde_json::from_str(&stdout).expect("JSON output");
    assert_eq!(
        output["file"],
        json!(file.display().to_string()),
        "case {label}: the file of the folder {folder}"
    );
}

// contract: conversation.claude-code.names-the-folder-by-the-recorded-pairs
#[test]
fn folder_case_slash() {
    check_folder_case("slash");
}

// contract: conversation.claude-code.names-the-folder-by-the-recorded-pairs
#[test]
fn folder_case_dot() {
    check_folder_case("dot");
}

// contract: conversation.claude-code.names-the-folder-by-the-recorded-pairs
#[test]
fn folder_case_underscore() {
    check_folder_case("underscore");
}

// contract: conversation.claude-code.names-the-folder-by-the-recorded-pairs
#[test]
fn folder_case_space() {
    check_folder_case("space");
}

// contract: conversation.claude-code.names-the-folder-by-the-recorded-pairs
#[test]
fn folder_case_non_ascii() {
    check_folder_case("non-ascii");
}

// contract: conversation.claude-code.names-the-folder-by-the-recorded-pairs
#[test]
fn folder_case_long() {
    check_folder_case("long");
}

// contract: conversation.codex.keeps-an-image-only-message
#[test]
fn codex_image_only_message_is_emitted_with_its_kind() {
    // The item has the observed key structure of docs/spec/cases/conversation-codex-image-item.json; the image reference is set here.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/conversation-codex-image-item.json"
    );
    let text = std::fs::read_to_string(path).expect("Codex image item case");
    let mut item: Value = serde_json::from_str(&text).expect("Codex image item case JSON");
    item["type"] = json!("input_image");
    item["image_url"] = json!("PICTURE-DATA-NOT-WRITTEN");

    let home = Folder::new("conversation-image");
    let cwd = "/work/core";
    let file = home
        .path()
        .join(".codex/sessions/2026/11/18/rollout-2026-11-18T10-00-00-image.jsonl");
    write_records(
        &file,
        &[
            json!({"type": "session_meta", "payload": {"id": "session", "cwd": cwd}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [item]}}),
        ],
    );

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "codex", "--cwd", cwd]);

    assert_eq!(
        (code, stderr.as_str()),
        (0, ""),
        "exit status and standard error"
    );
    assert!(
        !stdout.contains("PICTURE-DATA"),
        "the picture data is not written: {stdout}"
    );
    let output: Value = serde_json::from_str(&stdout).expect("JSON output");
    assert_eq!(
        output,
        expected_output(
            &file,
            json!([{"role": "user", "text": "", "items": [{"type": "image"}]}]),
            1
        )
    );
}

// contract: conversation.claude-code.keeps-an-image-only-message
#[test]
fn claude_image_only_message_is_emitted_with_its_kind() {
    // The block has the observed key structure of docs/spec/cases/conversation-image-block.json; the data value is set here.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/conversation-image-block.json"
    );
    let text = std::fs::read_to_string(path).expect("image block case");
    let mut block: Value = serde_json::from_str(&text).expect("image block case JSON");
    block["source"]["data"] = json!("PICTURE-DATA-NOT-WRITTEN");

    let home = Folder::new("conversation-claude-image");
    let cwd = "/work/core";
    let file = home
        .path()
        .join(".claude/projects/-work-core/session.jsonl");
    write_records(
        &file,
        &[
            json!({"type": "attachment", "cwd": cwd, "sessionId": "session"}),
            json!({"type": "user", "cwd": cwd, "message": {"role": "user", "content": [block]}}),
        ],
    );

    let (code, stdout, stderr) = run_conversation(&home, &["--agent", "claude-code", "--cwd", cwd]);

    assert_eq!(
        (code, stderr.as_str()),
        (0, ""),
        "exit status and standard error"
    );
    assert!(
        !stdout.contains("PICTURE-DATA"),
        "the picture data is not written: {stdout}"
    );
    let output: Value = serde_json::from_str(&stdout).expect("JSON output");
    assert_eq!(
        output,
        expected_output(
            &file,
            json!([{"role": "user", "text": "", "items": [{"type": "image"}]}]),
            1
        )
    );
}

// contract: conversation.refuses-a-home-that-is-not-utf-8
// The event log of the built sok also reads HOME for the configuration folder and reports the same refusal before the command.
#[test]
fn home_that_is_not_utf8_is_refused_with_its_bytes_escaped() {
    use std::os::unix::ffi::OsStrExt;
    let home = std::ffi::OsStr::from_bytes(b"/nonexistent/h\xffme");

    let (code, stdout, stderr) = run_conversation(
        Path::new(home),
        &["--agent", "claude-code", "--cwd", "/work/project"],
    );

    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            "sok: event log: the default configuration directory is unknown: HOME is not UTF-8: /nonexistent/h\\xffme\nsok: HOME is not UTF-8: /nonexistent/h\\xffme\n"
        )
    );
}
