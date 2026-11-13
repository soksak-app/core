//! The outcome of a child check: a test that runs its own binary for one scenario in a fresh process.
//!
//! A child that calls `start_standard_error` writes its standard error, and so the message of a panic, to the standard error file
//! of its configuration folder, and its event log lies in the same folder. That folder is removed when the test ends, so a child
//! that failed would leave no cause; the report of a failed child names the files of its `logs` folder with their text.

#![allow(dead_code)]

use std::path::Path;
use std::process::{Command, Output, Stdio};

/// The output of `command` while this process holds the standard input of the child open, so a child that waits for the end of
/// its input (`wait_for_end`) waits until it ends itself; a child that never ends leaves the check to the limit of its runner.
pub fn output_with_open_input(command: &mut Command) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = child.stdin.take();
    let output = child.wait_with_output().unwrap();
    drop(input);
    output
}

/// Waits for the end of the standard input, which the parent holds open while it waits for the child
/// (`output_with_open_input`). The read blocks in a system call until an end that the child expects, such as a panic hook that
/// ends the process, ends it; reaching the end of the input is the failure, with status 4.
pub fn wait_for_end() -> ! {
    let _ = std::io::Read::read_to_end(&mut std::io::stdin(), &mut Vec::new());
    std::process::exit(4);
}

/// Fails with the cause of the child when it did not succeed: its exit status, its output and error output, and every standard
/// error file and event log in the `logs` folder of `config`, its configuration folder.
pub fn require_success(output: &Output, config: &Path) {
    if output.status.success() {
        return;
    }
    panic!("{}", report(output, config));
}

/// The text that states the outcome of the child and the files of the `logs` folder of `config`.
pub fn report(output: &Output, config: &Path) -> String {
    let mut text = format!(
        "child ended with {:?}\noutput: {}\nerror output: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    text.push_str(&logs(config));
    text
}

/// The standard error files and the event logs of the `logs` folder of `config`, each with its name, in name order.
pub fn logs(config: &Path) -> String {
    let folder = config.join("logs");
    let mut paths: Vec<_> = match std::fs::read_dir(&folder) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect(),
        Err(error) => return format!("\n{}: {error}", folder.display()),
    };
    paths.retain(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".stderr") || name.ends_with(".jsonl"))
    });
    paths.sort();
    let mut text = String::new();
    for path in paths {
        let content =
            std::fs::read_to_string(&path).unwrap_or_else(|error| format!("cannot read: {error}"));
        text.push_str(&format!("\n--- {}\n{content}", path.display()));
    }
    if text.is_empty() {
        text = format!(
            "\n{} holds no standard error file and no event log",
            folder.display()
        );
    }
    text
}
