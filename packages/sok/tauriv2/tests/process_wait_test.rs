//! Checks the standalone process wait command through the declared sok CLI.

use std::path::Path;
use std::process::Command;

use serde_json::Value;

fn run(args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(Path::new("/tmp")),
        core_version: "0.0.21",
    };
    let code = soksak_sok::run(&args, &mut stdout, &mut stderr, &options);
    (
        code,
        String::from_utf8(stdout).expect("stdout is UTF-8"),
        String::from_utf8(stderr).expect("stderr is UTF-8"),
    )
}

#[test]
fn process_wait_child() {
    if std::env::var_os("SOKSAK_PROCESS_WAIT_CHILD").is_some() {
        std::process::exit(0);
    }
}

// contract: cli.process-wait.rejects-invalid-pid-and-timeout
#[test]
fn process_wait_rejects_invalid_inputs_before_waiting() {
    let cases = [
        (
            "missing pid",
            vec!["process", "wait", "--timeout-ms", "1"],
            "process wait requires a pid",
        ),
        (
            "missing timeout",
            vec!["process", "wait", "1234"],
            "--timeout-ms is required",
        ),
        (
            "zero pid",
            vec!["process", "wait", "0", "--timeout-ms", "1"],
            "pid must be an integer from 1 to 2147483647",
        ),
        (
            "negative pid",
            vec!["process", "wait", "-1", "--timeout-ms", "1"],
            "pid must be an integer from 1 to 2147483647",
        ),
        (
            "signed pid",
            vec!["process", "wait", "+1", "--timeout-ms", "1"],
            "pid must be an integer from 1 to 2147483647",
        ),
        (
            "overflow pid",
            vec!["process", "wait", "2147483648", "--timeout-ms", "1"],
            "pid must be an integer from 1 to 2147483647",
        ),
        (
            "nondecimal pid",
            vec!["process", "wait", "1x", "--timeout-ms", "1"],
            "pid must be an integer from 1 to 2147483647",
        ),
        (
            "zero timeout",
            vec!["process", "wait", "1", "--timeout-ms", "0"],
            "timeout must be an integer from 1 to 600000 milliseconds",
        ),
        (
            "negative timeout",
            vec!["process", "wait", "1", "--timeout-ms", "-1"],
            "timeout must be an integer from 1 to 600000 milliseconds",
        ),
        (
            "overflow timeout",
            vec!["process", "wait", "1", "--timeout-ms", "600001"],
            "timeout must be an integer from 1 to 600000 milliseconds",
        ),
        (
            "nondecimal timeout",
            vec!["process", "wait", "1", "--timeout-ms", "1x"],
            "timeout must be an integer from 1 to 600000 milliseconds",
        ),
        (
            "duplicate timeout",
            vec![
                "process",
                "wait",
                "1",
                "--timeout-ms",
                "1",
                "--timeout-ms",
                "2",
            ],
            "--timeout-ms is given twice",
        ),
        (
            "unknown process option",
            vec![
                "process",
                "wait",
                "1",
                "--timeout-ms",
                "1",
                "--window",
                "main",
            ],
            "unknown option --window",
        ),
        (
            "unexpected argument",
            vec!["process", "wait", "1", "extra", "--timeout-ms", "1"],
            "unexpected argument extra",
        ),
    ];
    for (name, args, expected) in cases {
        let (code, stdout, stderr) = run(&args);
        assert_eq!(code, 2, "{name}: stdout={stdout:?} stderr={stderr:?}");
        assert!(stdout.is_empty(), "{name}: stdout={stdout:?}");
        assert!(stderr.contains(expected), "{name}: {stderr}");
    }
}

// contract: cli.process-wait.option-is-command-scoped
#[test]
fn process_wait_timeout_option_does_not_change_other_commands() {
    let (code, stdout, stderr) = run(&["windows", "--timeout-ms", "1"]);
    assert_eq!(code, 2, "stdout={stdout:?} stderr={stderr:?}");
    assert!(stdout.is_empty(), "stdout={stdout:?}");
    assert!(stderr.contains("unknown option --timeout-ms"), "{stderr}");
}

// contract: cli.process-wait.repeated-help-is-idempotent
#[test]
fn process_wait_repeated_help_is_idempotent() {
    let (code, stdout, stderr) = run(&["process", "wait", "--help", "--help"]);
    assert_eq!(code, 0, "stdout={stdout:?} stderr={stderr:?}");
    assert!(stdout.contains("process wait PID"), "stdout={stdout:?}");
    assert!(stderr.is_empty(), "stderr={stderr:?}");
}

// contract: cli.process-wait.requires-an-action
#[test]
fn process_command_requires_an_action() {
    let (code, stdout, stderr) = run(&["process"]);
    assert_eq!(code, 2, "stdout={stdout:?} stderr={stderr:?}");
    assert!(stdout.is_empty(), "stdout={stdout:?}");
    assert!(stderr.contains("process requires an action"), "{stderr}");
}

// contract: cli.process-wait.timeout-is-an-error
#[test]
fn process_wait_reports_timeout_or_platform_refusal() {
    let pid = std::process::id().to_string();
    let (code, stdout, stderr) = run(&["process", "wait", &pid, "--timeout-ms", "1"]);
    assert_eq!(code, 1, "stdout={stdout:?} stderr={stderr:?}");
    assert!(stdout.is_empty(), "stdout={stdout:?}");
    if cfg!(target_os = "macos") {
        assert!(
            stderr.contains(&format!("process {pid} did not end within 1ms")),
            "{stderr}"
        );
    } else {
        assert!(stderr.contains("not implemented"), "{stderr}");
    }
}

#[cfg(target_os = "macos")]
// contract: cli.process-wait.reports-pid-absent
#[test]
fn process_wait_reports_an_already_ended_pid() {
    let executable = std::env::current_exe().expect("test executable");
    let mut child = Command::new(executable)
        .arg("--exact")
        .arg("process_wait_child")
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
