use super::{Options, process, run_with_process_wait};
use std::path::Path;

fn options() -> Options<'static> {
    Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(Path::new("/tmp")),
        core_version: super::version::CORE_VERSION,
    }
}

fn process_wait_args() -> [String; 3] {
    [
        "process".to_string(),
        "wait".to_string(),
        "1234".to_string(),
    ]
}

// A raised signal reaches every wait that watches the signals in the test process, so each test of the wait holds one lock
// for the whole of the test, the signal tests of the platforms included, and no wait of another test receives the signal of
// a signal test.
static SIGNALS: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn hold_the_signals() -> std::sync::MutexGuard<'static, ()> {
    SIGNALS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn run_wait(wait: Box<process::Wait>) -> (i32, String, String) {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let status = run_with_process_wait(
        &process_wait_args(),
        &mut stdout,
        &mut stderr,
        &options(),
        wait,
    );
    (
        status,
        String::from_utf8(stdout).expect("stdout is UTF-8"),
        String::from_utf8(stderr).expect("stderr is UTF-8"),
    )
}

// The wait receives only the PID: it has no time limit and ends by the exit event of the process.
// contract: cli.process-wait.takes-no-time-limit
#[test]
fn process_wait_gives_the_wait_only_the_pid() {
    let _signals = hold_the_signals();
    let (called_tx, called_rx) = std::sync::mpsc::channel();
    let (status, stdout, stderr) = run_wait(Box::new(move |pid: i32| {
        called_tx.send(pid).expect("record the pid");
        Ok(())
    }));

    assert_eq!(status, 0, "stderr={stderr:?}");
    assert_eq!(called_rx.recv().expect("the wait was called"), 1234);
    let result: serde_json::Value = serde_json::from_str(&stdout).expect("process wait JSON");
    assert_eq!(result["pid"], 1234);
    assert_eq!(result["ended"], true);
}

// contract: cli.process-wait.platform-error-is-reported
#[test]
fn process_wait_reports_platform_errors() {
    let _signals = hold_the_signals();
    let (status, stdout, stderr) = run_wait(Box::new(|pid: i32| {
        assert_eq!(pid, 1234);
        Err(process::WaitError::Operation("kernel wait failed".into()))
    }));

    assert_eq!(status, 1);
    assert!(stdout.is_empty());
    assert_eq!(stderr, "sok: process wait: kernel wait failed\n");
}
