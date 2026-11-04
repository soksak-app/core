#![cfg(target_os = "macos")]

use std::process::Command;

use serde_json::Value;

#[path = "../../support/process_wait.rs"]
mod support;

use support::run;

// contract: cli.process-wait.timeout-is-an-error
#[test]
fn process_wait_reports_timeout() {
    let pid = std::process::id().to_string();
    let (code, stdout, stderr) = run(&["process", "wait", &pid, "--timeout-ms", "1"]);
    assert_eq!(code, 1, "stdout={stdout:?} stderr={stderr:?}");
    assert!(stdout.is_empty(), "stdout={stdout:?}");
    assert!(
        stderr.contains(&format!("process {pid} did not end within 1ms")),
        "{stderr}"
    );
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
    let (code, stdout, stderr) = run(&[
        "process",
        "wait",
        &pid,
        "--timeout-ms",
        "1000",
        "--config-dir",
        "/tmp/process-wait",
    ]);
    assert_eq!(code, 0, "stdout={stdout:?} stderr={stderr:?}");
    assert!(stderr.is_empty(), "stderr={stderr:?}");
    let result: Value = serde_json::from_str(&stdout).expect("process wait JSON");
    assert_eq!(result["pid"], pid.parse::<u32>().expect("pid number"));
    assert_eq!(result["ended"], true);
}
