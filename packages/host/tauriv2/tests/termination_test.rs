//! Termination signal tests. A signal affects the whole process, so it is checked in a child process.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

use std::io::Read;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use signal_hook::consts::SIGTERM;
use signal_hook::low_level::raise;
use soksak_host_tauriv2::event_log;
use soksak_host_tauriv2::event_record::use_host_event_log;
use soksak_host_tauriv2::page_process::page_process_ended;
use soksak_host_tauriv2::quit::Quit;
use soksak_host_tauriv2::termination;

/// The environment variable that says it is a child process.
const CHILD: &str = "SOKSAK_TERMINATION_CHILD";

/// The environment variable that names the configuration folder of the child that records its end.
const DIRECTORY: &str = "SOKSAK_TERMINATION_DIRECTORY";

const CLOSED_NAME: &str = "a_termination_signal_records_log_closed_before_quit";

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
    termination::on_termination(
        Arc::new(Quit::default()),
        Box::new(move || {
            let _ = quit.send(());
        }),
    )
    .unwrap();
    raise(SIGTERM).unwrap();
    quitted.recv().unwrap();
    println!("quit requested");
    raise(SIGTERM).unwrap();
    let _ = std::io::stdin().read(&mut [0u8]);
    println!("the second signal did not end the process");
    std::process::exit(3);
}

// contract: log.closed.signal-before-quit
#[test]
fn a_termination_signal_records_log_closed_before_quit() {
    if std::env::var_os(CHILD).is_some() {
        return record_closed_on_signal();
    }
    let directory = folder::Folder::new();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", CLOSED_NAME, "--nocapture", "--test-threads=1"])
        .env(CHILD, "1")
        .env(DIRECTORY, directory.path())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    let status = child.wait().unwrap();
    assert!(status.success(), "status {status}, output {output:?}");
    assert!(
        output.contains("log.closed: {\"cause\":\"signal\",\"signal\":15}"),
        "output {output:?}"
    );
}

/// Receives the termination signal of the child, which stores its event log with the default policy. The record of the
/// signal is stored before quit is requested, so it is in the log when quit has been requested.
fn record_closed_on_signal() {
    let directory = PathBuf::from(std::env::var_os(DIRECTORY).unwrap());
    let log = Arc::new(event_log::start_host(&directory).unwrap());
    use_host_event_log(Some(Arc::clone(&log)));
    let (quit, quitted) = mpsc::channel();
    termination::on_termination(
        Arc::new(Quit::default()),
        Box::new(move || {
            let _ = quit.send(());
        }),
    )
    .unwrap();
    raise(SIGTERM).unwrap();
    quitted.recv().unwrap();
    log.flush(Duration::from_secs(5)).unwrap();
    use_host_event_log(None);
    let events = records::read_events(&records::event_log_path(&directory));
    match events.iter().find(|event| event["event"] == "log.closed") {
        Some(event) => println!("log.closed: {}", event["fields"]),
        None => println!("log.closed: none"),
    }
}

const QUIT_CHILD: &str = "SOKSAK_TERMINATION_QUIT_CHILD";
const QUIT_NAME: &str = "a_termination_signal_begins_the_quit_state_before_quit";

// contract: termination.signal.begins-the-quit-state
// The first termination signal begins the quit state before it requests the quit, so the end of a page process during that quit
// writes no error line (docs/spec/hosts.md#process-lifecycle).
#[test]
fn a_termination_signal_begins_the_quit_state_before_quit() {
    if std::env::var_os(QUIT_CHILD).is_some() {
        return quit_during_signal();
    }
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", QUIT_NAME, "--nocapture", "--test-threads=1"])
        .env(QUIT_CHILD, "1")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    let status = child.wait().unwrap();
    assert!(status.success(), "status {status}, output {output:?}");
    assert!(output.contains("quit requested"), "output {output:?}");
}

/// Delivers the termination signal and then reports whether the end of a page process during that quit is written.
fn quit_during_signal() {
    let state = Arc::new(Quit::default());
    let observed = Arc::clone(&state);
    let (quit, quitted) = mpsc::channel();
    termination::on_termination(
        state,
        Box::new(move || {
            let _ = quit.send(());
        }),
    )
    .unwrap();
    raise(SIGTERM).unwrap();
    quitted.recv().unwrap();
    match page_process_ended("main", observed.active()) {
        Some((place, text)) => {
            println!("the end of a page process during the quit is written: {place}: {text}");
            std::process::exit(3);
        }
        None => println!("quit requested"),
    }
}
