//! Termination signal tests. A signal affects the whole process, so it is checked in a child process.

use std::io::Read;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;

use signal_hook::consts::SIGTERM;
use signal_hook::low_level::raise;
use soksak_host_tauriv2::termination;

/// The environment variable that says it is a child process.
const CHILD: &str = "SOKSAK_TERMINATION_CHILD";

const NAME: &str = "a_termination_signal_requests_quit_once_and_the_next_ends_the_process";

// contract: termination.signal.first-requests-quit-second-ends-process
#[test]
fn a_termination_signal_requests_quit_once_and_the_next_ends_the_process() {
    if std::env::var_os(CHILD).is_some() {
        return terminate();
    }
    // The child waits while it reads the standard input. The parent keeps the write side open, so the child does not
    // end without a signal.
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
        .env(CHILD, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take();
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    let status = child.wait().unwrap();
    drop(stdin);
    assert_eq!(
        status.signal(),
        Some(SIGTERM),
        "status {status}, output {output:?}"
    );
    assert!(output.contains("quit requested"), "output {output:?}");
    assert!(!output.contains("did not end"), "output {output:?}");
}

/// Receives the termination signal twice. The first signal calls quit and the second signal ends the process.
fn terminate() {
    let (quit, quitted) = mpsc::channel();
    termination::on_termination(Box::new(move || {
        let _ = quit.send(());
    }))
    .unwrap();
    raise(SIGTERM).unwrap();
    quitted.recv().unwrap();
    println!("quit requested");
    raise(SIGTERM).unwrap();
    let _ = std::io::stdin().read(&mut [0u8]);
    println!("the second signal did not end the process");
    std::process::exit(3);
}
