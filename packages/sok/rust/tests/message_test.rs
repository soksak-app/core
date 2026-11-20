//! Checks `sok message send <folder> <text>` (docs/spec/cli.md#commands, docs/spec/messaging.md#message) with the built sok and folders
//! that each test creates. The surface of the sender is the answer of `agent.surface` of a case that the test plays.

use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

#[path = "support/folder.rs"]
mod folder;

#[path = "support/case_player.rs"]
mod case_player;

use case_player::{play_case, play_case_with_text};

use folder::Folder;

/// The largest text that the command accepts, in bytes (docs/spec/cli.md#commands).
const LIMIT: usize = 64 * 1024;

/// Runs `sok message send` with the configuration directory `config` and `args`, with HOME set to `home` and CODEX_THREAD_ID set to
/// `thread` when it is Some, and returns the status and both outputs.
fn run_send(
    home: &Path,
    config: &str,
    thread: Option<&str>,
    args: &[&str],
) -> (i32, String, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_sok"));
    command
        .arg("message")
        .arg("send")
        .arg("--config-dir")
        .arg(config)
        .args(args)
        .env_clear()
        .env("HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(thread) = thread {
        command.env("CODEX_THREAD_ID", thread);
    }
    let output = command.output().expect("sok runs");
    (
        output.status.code().expect("exit status"),
        String::from_utf8(output.stdout).expect("stdout"),
        String::from_utf8(output.stderr).expect("stderr"),
    )
}

/// The names of the entries of `folder`, sorted.
fn entries(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .expect("folder lists")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

#[test]
fn send_refuses_a_text_one_byte_over_the_limit_with_no_file() {
    let player = play_case("sok-message-send-sender");
    let home = Folder::new("message-home");
    let folder = Folder::new("message-over-limit");
    let text = "a".repeat(LIMIT + 1);
    let (status, stdout, stderr) = run_send(
        &home,
        &player.dir(),
        None,
        &["--reply", folder.text(), &text],
    );
    assert_ne!(status, 0, "an oversized text must fail; stdout: {stdout}");
    assert!(
        stderr.contains("65536"),
        "the refusal must name the limit in bytes; stderr: {stderr}"
    );
    assert!(
        entries(folder.path()).is_empty(),
        "a refused text must write no file; entries: {:?}",
        entries(folder.path())
    );
}

#[test]
fn send_accepts_a_text_of_exactly_the_limit() {
    let player = play_case("sok-message-send-sender");
    let home = Folder::new("message-home");
    let folder = Folder::new("message-at-limit");
    let text = "b".repeat(LIMIT);
    let (status, stdout, stderr) = run_send(
        &home,
        &player.dir(),
        None,
        &["--reply", folder.text(), &text],
    );
    assert_eq!(status, 0, "stdout: {stdout} stderr: {stderr}");
    let name = message_name(&stdout);
    let written = std::fs::read_to_string(folder.path().join(&name)).expect("message file");
    assert_eq!(written.len(), LIMIT);
}

#[test]
fn send_writes_the_whole_text_under_the_sender_name_and_leaves_no_temporary_file() {
    let player = play_case("sok-message-send-terminal");
    let home = Folder::new("message-home");
    let root = Folder::new("message-whole");
    terminal_folders(root.path(), &["app-2"]);
    let folder = root.path().join(".soksak").join("messages").join("app-2");
    let text = "hello 안녕 terminal";
    let (status, stdout, stderr) = run_send(
        &home,
        &player.dir(),
        None,
        &[folder.to_str().expect("folder"), text],
    );
    assert_eq!(status, 0, "stdout: {stdout} stderr: {stderr}");
    let name = message_name(&stdout);
    assert!(
        name.starts_with("app-1.") && name.ends_with(".txt"),
        "the name must be <from>.<token>.txt with the sender that agent.surface answers; name: {name}"
    );
    let token = &name["app-1.".len()..name.len() - ".txt".len()];
    assert!(
        !token.is_empty() && !token.contains('.'),
        "the token must be non-empty and hold no dot; token: {token}"
    );
    assert_eq!(
        entries(&folder),
        vec![name.clone()],
        "the folder must hold only the message file after the send"
    );
    let written = std::fs::read_to_string(folder.join(&name)).expect("message file");
    // The send adds the request for a report to the folder of the sender (docs/spec/messaging.md#report-request).
    let sender = root.path().join(".soksak").join("messages").join("app-1");
    assert_eq!(
        written,
        format!(
            "{text} (끝나면 결과를 sok message send --reply {} \"<보고>\"로 보고하라)",
            sender.display()
        )
    );
}

#[test]
fn send_reply_writes_the_text_alone_as_a_report() {
    let player = play_case("sok-message-send-terminal");
    let home = Folder::new("message-home");
    let root = Folder::new("message-report");
    terminal_folders(root.path(), &["app-2"]);
    let folder = root.path().join(".soksak").join("messages").join("app-2");
    let (status, stdout, stderr) = run_send(
        &home,
        &player.dir(),
        None,
        &["--reply", folder.to_str().expect("folder"), "done 안녕"],
    );
    assert_eq!(status, 0, "stdout: {stdout} stderr: {stderr}");
    let name = message_name(&stdout);
    let token = &name["app-1.".len()..name.len() - ".txt".len()];
    assert!(
        token.starts_with("report-") && !token.contains('.'),
        "a report has the name <from>.report-<token>.txt; name: {name}"
    );
    let written = std::fs::read_to_string(folder.join(&name)).expect("message file");
    assert_eq!(written, "done 안녕", "a report holds the text alone");
}

#[test]
fn send_refuses_a_folder_of_no_terminal_without_reply_with_no_file() {
    let player = play_case("sok-message-send-sender");
    let home = Folder::new("message-home");
    let folder = Folder::new("message-no-terminal");
    let (status, stdout, stderr) = run_send(&home, &player.dir(), None, &[folder.text(), "text"]);
    assert_ne!(status, 0, "stdout: {stdout}");
    assert!(
        stderr.contains("is not the folder of a terminal"),
        "the refusal must name the folder rule; stderr: {stderr}"
    );
    assert!(entries(folder.path()).is_empty());
}

// contract: cli.message.send-requires-the-surface-of-its-process
#[test]
fn send_refuses_without_a_surface_with_no_file() {
    let home = Folder::new("message-home");
    let folder = Folder::new("message-no-surface");
    let config = Folder::new("message-no-application");
    let (status, stdout, stderr) = run_send(
        &home,
        config.text(),
        None,
        &["--reply", folder.text(), "text"],
    );
    assert_eq!(
        (status, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            "sok: message send requires a running application, which answers the surface of this process\n"
        ),
        "without an application"
    );
    let refusal = "process 1 is not a process of a surface";
    let player = play_case_with_text("sok-message-send-refused", "refusal", refusal);
    let hint = "; start codex with --no-daemon, so that the commands of its agent run in processes of the surface";
    for (thread, want) in [
        (None, format!("sok: message send: {refusal}\n")),
        (
            Some("thread-1"),
            format!("sok: message send: {refusal}{hint}\n"),
        ),
    ] {
        let (status, stdout, stderr) = run_send(
            &home,
            &player.dir(),
            thread,
            &["--reply", folder.text(), "text"],
        );
        assert_eq!(
            (status, stdout.as_str(), stderr),
            (1, "", want),
            "a refusal with CODEX_THREAD_ID {thread:?}"
        );
    }
    assert!(entries(folder.path()).is_empty());
}

/// The `path` member of the reply of `sok message send`, which is the name of the message file.
fn message_name(stdout: &str) -> String {
    let reply: Value = serde_json::from_str(stdout.trim()).expect("reply is JSON");
    reply["path"].as_str().expect("path member").to_string()
}

/// Creates `<root>/.soksak/messages/<surface>` for each surface in `root`.
fn terminal_folders(root: &Path, surfaces: &[&str]) {
    for surface in surfaces {
        std::fs::create_dir_all(root.join(".soksak").join("messages").join(surface))
            .expect("terminal folder");
    }
}

/// The receiver member of the reply of sok message send.
fn receiver(stdout: &str) -> Value {
    let reply: Value = serde_json::from_str(stdout.trim()).expect("reply is JSON");
    reply
        .get("receiver")
        .cloned()
        .unwrap_or_else(|| panic!("reply has no receiver: {stdout}"))
}

/// The path member of the reply of sok message send.
fn reply_path(stdout: &str) -> String {
    let reply: Value = serde_json::from_str(stdout.trim()).expect("reply is JSON");
    reply["path"].as_str().expect("path").to_string()
}

// contract: cli.message.send-reports-the-hold-of-the-receiver
#[test]
fn send_reports_the_hold_of_the_receiver() {
    let player = play_case("sok-message-send-receiver");
    let dir = player.dir();
    let home = Folder::new("message-home");
    let root = Folder::new("message-root");
    terminal_folders(root.path(), &["t2", "t3", "t4", "t5", "gone"]);
    let folder = |surface: &str| root.path().join(".soksak").join("messages").join(surface);
    let wants = [
        (
            "t2",
            serde_json::json!({"surface": "t2", "plugin": "terminal", "held": {"reason": "blocked", "kind": "permission", "pending": 1}}),
        ),
        (
            "t3",
            serde_json::json!({"surface": "t3", "plugin": "terminal", "held": null}),
        ),
        ("t4", Value::Null),
    ];
    for (surface, want) in wants {
        let path = folder(surface);
        let (status, stdout, stderr) =
            run_send(&home, &dir, None, &[path.to_str().expect("path"), "hello"]);
        assert_eq!(
            status, 0,
            "send to {surface}: stdout {stdout} stderr {stderr}"
        );
        assert_eq!(receiver(&stdout), want, "send to {surface}");
        assert_eq!(
            entries(&path),
            vec![reply_path(&stdout)],
            "send to {surface}"
        );
    }
    let path = folder("t5");
    let (status, stdout, stderr) =
        run_send(&home, &dir, None, &[path.to_str().expect("path"), "hello"]);
    let names = entries(&path);
    assert!(
        status == 1
            && stdout.is_empty()
            && names.len() == 1
            && stderr.contains(&format!("message {} was written", names[0]))
            && stderr.contains(
                "status terminal.messages of surface t5 is not {folder, registration, held, last}"
            ),
        "a status without held: status {status} stdout {stdout:?} stderr {stderr:?} entries {names:?}"
    );
    let path = folder("gone");
    let (status, stdout, stderr) =
        run_send(&home, &dir, None, &[path.to_str().expect("path"), "hello"]);
    assert!(
        status == 0 && receiver(&stdout).is_null(),
        "a surface in no window: status {status} stdout {stdout:?} stderr {stderr:?}"
    );
}

// contract: cli.message.send-into-another-folder-has-no-receiver
#[test]
fn send_to_another_folder_has_no_receiver() {
    let player = play_case_with_text("sok-message-send-sender", "sender", "t1");
    let home = Folder::new("message-home");
    let other = Folder::new("message-other");
    let (status, stdout, stderr) = run_send(
        &home,
        &player.dir(),
        None,
        &["--reply", other.text(), "hello"],
    );
    assert!(
        status == 0 && receiver(&stdout).is_null() && reply_path(&stdout).starts_with("t1.report-"),
        "send to {}: status {status} stdout {stdout:?} stderr {stderr:?}",
        other.text()
    );
}
