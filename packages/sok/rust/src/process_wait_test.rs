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

fn run_wait(wait: Box<process::Wait>) -> (i32, String, String) {
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

// A SIGINT or SIGTERM that sok receives ends the wait. The wait sends a notice when it began, which is the point at which
// the wait has not ended; the test then raises the signal in its own process and receives the answer, and only after the
// answer lets the wait return. The command watches the signals before it starts the wait, so the signal cannot come
// before the watch.
// contract: cli.process-wait.signal-ends-the-wait
#[cfg(unix)]
#[test]
fn process_wait_ends_by_a_signal() {
    for (name, signal) in [
        ("SIGINT", signal_hook::consts::SIGINT),
        ("SIGTERM", signal_hook::consts::SIGTERM),
    ] {
        let (began_tx, began_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (answer_tx, answer_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let answer = run_wait(Box::new(move |_pid: i32| {
                began_tx.send(()).expect("notice that the wait began");
                // The test drops the sender after the answer, which lets the wait return.
                assert!(
                    release_rx.recv().is_err(),
                    "the test releases the wait by dropping the sender"
                );
                Ok(())
            }));
            answer_tx.send(answer).expect("send the answer");
        });
        began_rx.recv().expect("the wait began");
        assert!(
            answer_rx.try_recv().is_err(),
            "{name}: the wait answered before the process ended"
        );
        signal_hook::low_level::raise(signal).expect("raise the signal");
        let (status, stdout, stderr) = answer_rx.recv().expect("the answer of the wait");
        drop(release_tx);
        assert_eq!(status, 1, "{name}: stdout={stdout:?} stderr={stderr:?}");
        assert!(stdout.is_empty(), "{name}: stdout={stdout:?}");
        assert_eq!(
            stderr,
            format!("sok: process 1234 wait was interrupted by {name}\n")
        );
    }
}

// contract: cli.process-wait.platform-error-is-reported
#[test]
fn process_wait_reports_platform_errors() {
    let (status, stdout, stderr) = run_wait(Box::new(|pid: i32| {
        assert_eq!(pid, 1234);
        Err(process::WaitError::Operation("kernel wait failed".into()))
    }));

    assert_eq!(status, 1);
    assert!(stdout.is_empty());
    assert_eq!(stderr, "sok: process wait: kernel wait failed\n");
}
