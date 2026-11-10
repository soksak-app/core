#![cfg(target_os = "macos")]

use std::process::{Command, Stdio};

use serde_json::Value;

#[path = "../../support/process_wait.rs"]
mod support;

use support::run;

// The wait has no time limit: it answers when the process the test controls exits, which the test causes by closing the
// standard input of the process.
// contract: cli.process-wait.takes-no-time-limit
#[test]
fn process_wait_ends_by_the_exit_of_the_process() {
    let mut child = Command::new("/bin/cat")
        .stdin(Stdio::piped())
        .spawn()
        .expect("start controlled process");
    let pid = child.id().to_string();
    let waiting = {
        let pid = pid.clone();
        std::thread::spawn(move || run(&["process", "wait", &pid]))
    };
    drop(child.stdin.take());
    let status = child.wait().expect("reap controlled process");
    assert!(status.success(), "child exit status was {status}");
    let (code, stdout, stderr) = waiting.join().expect("process wait thread");
    assert_eq!(code, 0, "stdout={stdout:?} stderr={stderr:?}");
    assert!(stderr.is_empty(), "stderr={stderr:?}");
    let result: Value = serde_json::from_str(&stdout).expect("process wait JSON");
    assert_eq!(result["pid"], pid.parse::<u32>().expect("pid number"));
    assert_eq!(result["ended"], true);
}

// contract: cli.process-wait.reports-pid-absent
#[test]
fn process_wait_reports_an_already_ended_pid() {
    if std::env::var_os("SOKSAK_PROCESS_WAIT_CHILD").is_some() {
        return;
    }
    let executable = std::env::current_exe().expect("test executable");
    let mut child = Command::new(executable)
        .arg("--exact")
        .arg("process_wait_reports_an_already_ended_pid")
        .arg("--nocapture")
        .env("SOKSAK_PROCESS_WAIT_CHILD", "1")
        .spawn()
        .expect("start controlled process");
    let pid = child.id();
    let status = child.wait().expect("reap controlled process");
    assert!(status.success(), "child exit status was {status}");

    let pid = pid.to_string();
    let (code, stdout, stderr) =
        run(&["process", "wait", &pid, "--config-dir", "/tmp/process-wait"]);
    assert_eq!(code, 0, "stdout={stdout:?} stderr={stderr:?}");
    assert!(stderr.is_empty(), "stderr={stderr:?}");
    let result: Value = serde_json::from_str(&stdout).expect("process wait JSON");
    assert_eq!(result["pid"], pid.parse::<u32>().expect("pid number"));
    assert_eq!(result["ended"], true);
}
