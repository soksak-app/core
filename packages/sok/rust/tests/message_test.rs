//! Checks `sok message send <folder> <text>` (docs/spec/cli.md#commands, docs/spec/messaging.md#message) with the built sok and folders
//! that each test creates. The surface of the sender is set through SOKSAK_SURFACE in the environment of the child process only.

use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

#[path = "support/folder.rs"]
mod folder;

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
