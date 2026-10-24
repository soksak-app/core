#![cfg(windows)]

#[path = "../../support/process_wait.rs"]
mod support;

use support::run;

// contract: cli.process-wait.unsupported-on-windows
#[test]
fn process_wait_reports_unsupported_platform() {
    let pid = std::process::id().to_string();
    let (code, stdout, stderr) = run(&["process", "wait", &pid, "--timeout-ms", "1"]);
    assert_eq!(code, 1, "stdout={stdout:?} stderr={stderr:?}");
    assert!(stdout.is_empty(), "stdout={stdout:?}");
    assert!(
        stderr.contains("waiting for a process end is not implemented on windows"),
        "{stderr}"
    );
}
