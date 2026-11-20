//! Checks `sok message send <folder> <text>` (docs/spec/cli.md#commands, docs/spec/messaging.md#message) with the built sok and folders
//! that each test creates. The surface of the sender is set through SOKSAK_SURFACE in the environment of the child process only.

use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

#[path = "support/folder.rs"]
mod folder;

#[path = "support/case_player.rs"]
mod case_player;

use case_player::play_case;

use folder::Folder;

/// The largest text that the command accepts, in bytes (docs/spec/cli.md#commands).
const LIMIT: usize = 64 * 1024;

/// Runs `sok message send` with `args`, with SOKSAK_SURFACE set to `surface` when it is Some and HOME set to `home`, and returns the
/// status and both outputs.
fn run_send(home: &Path, surface: Option<&str>, args: &[&str]) -> (i32, String, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_sok"));
    command
        .arg("message")
        .arg("send")
        .args(args)
        .env_clear()
        .env("HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(surface) = surface {
        command.env("SOKSAK_SURFACE", surface);
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
    let home = Folder::new("message-home");
    let folder = Folder::new("message-over-limit");
    let text = "a".repeat(LIMIT + 1);
    let (status, stdout, stderr) = run_send(&home, Some("app-1"), &[folder.text(), &text]);
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
    let home = Folder::new("message-home");
    let folder = Folder::new("message-at-limit");
    let text = "b".repeat(LIMIT);
    let (status, stdout, stderr) = run_send(&home, Some("app-1"), &[folder.text(), &text]);
    assert_eq!(status, 0, "stdout: {stdout} stderr: {stderr}");
    let name = message_name(&stdout);
    let written = std::fs::read_to_string(folder.path().join(&name)).expect("message file");
    assert_eq!(written.len(), LIMIT);
}

#[test]
fn send_writes_the_whole_text_under_the_sender_name_and_leaves_no_temporary_file() {
    let home = Folder::new("message-home");
    let folder = Folder::new("message-whole");
    let text = "hello 안녕 terminal";
    let (status, stdout, stderr) = run_send(&home, Some("app-1"), &[folder.text(), text]);
    assert_eq!(status, 0, "stdout: {stdout} stderr: {stderr}");
    let name = message_name(&stdout);
    assert!(
        name.starts_with("app-1.") && name.ends_with(".txt"),
        "the name must be <from>.<token>.txt with the sender of SOKSAK_SURFACE; name: {name}"
    );
    let token = &name["app-1.".len()..name.len() - ".txt".len()];
    assert!(
        !token.is_empty() && !token.contains('.'),
        "the token must be non-empty and hold no dot; token: {token}"
    );
    assert_eq!(
        entries(folder.path()),
        vec![name.clone()],
        "the folder must hold only the message file after the send"
    );
    let written = std::fs::read_to_string(folder.path().join(&name)).expect("message file");
    assert_eq!(written, text);
}

#[test]
fn send_refuses_without_a_surface_with_no_file() {
    let home = Folder::new("message-home");
    let folder = Folder::new("message-no-surface");
    let (status, stdout, stderr) = run_send(&home, None, &[folder.text(), "text"]);
    assert_ne!(status, 0, "stdout: {stdout}");
    assert!(
        stderr.contains("message send requires SOKSAK_SURFACE"),
        "the refusal must name the variable of the send; stderr: {stderr}"
    );
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
        let (status, stdout, stderr) = run_send(
            &home,
            Some("t1"),
            &["--config-dir", &dir, path.to_str().expect("path"), "hello"],
        );
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
    let (status, stdout, stderr) = run_send(
        &home,
        Some("t1"),
        &["--config-dir", &dir, path.to_str().expect("path"), "hello"],
    );
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
    let (status, stdout, stderr) = run_send(
        &home,
        Some("t1"),
        &["--config-dir", &dir, path.to_str().expect("path"), "hello"],
    );
    assert!(
        status == 0 && receiver(&stdout).is_null(),
        "a surface in no window: status {status} stdout {stdout:?} stderr {stderr:?}"
    );
}

// contract: cli.message.send-without-application-has-no-receiver
#[test]
fn send_without_an_application_or_to_another_folder_has_no_receiver() {
    let home = Folder::new("message-home");
    let config = Folder::new("message-config");
    let root = Folder::new("message-root");
    terminal_folders(root.path(), &["t2"]);
    let other = Folder::new("message-other");
    for path in [
        root.path().join(".soksak").join("messages").join("t2"),
        other.path().to_path_buf(),
    ] {
        let (status, stdout, stderr) = run_send(
            &home,
            Some("t1"),
            &[
                "--config-dir",
                config.text(),
                path.to_str().expect("path"),
                "hello",
            ],
        );
        assert!(
            status == 0 && receiver(&stdout).is_null(),
            "send to {}: status {status} stdout {stdout:?} stderr {stderr:?}",
            path.display()
        );
    }
}
