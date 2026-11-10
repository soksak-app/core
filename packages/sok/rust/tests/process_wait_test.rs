//! Checks the standalone process wait command through the declared sok CLI.

#[path = "support/process_wait.rs"]
mod support;

use support::run;

// contract: cli.process-wait.rejects-invalid-arguments
#[test]
fn process_wait_rejects_invalid_inputs_before_waiting() {
    let cases = [
        (
            "missing pid",
            vec!["process", "wait"],
            "process wait requires a pid",
        ),
        (
            "zero pid",
            vec!["process", "wait", "0"],
            "pid must be an integer from 1 to 2147483647",
        ),
        (
            "negative pid",
            vec!["process", "wait", "-1"],
            "pid must be an integer from 1 to 2147483647",
        ),
        (
            "signed pid",
            vec!["process", "wait", "+1"],
            "pid must be an integer from 1 to 2147483647",
        ),
        (
            "overflow pid",
            vec!["process", "wait", "2147483648"],
            "pid must be an integer from 1 to 2147483647",
        ),
        (
            "nondecimal pid",
            vec!["process", "wait", "1x"],
            "pid must be an integer from 1 to 2147483647",
        ),
        (
            "time limit",
            vec!["process", "wait", "1", "--timeout-ms", "1"],
            "unknown option --timeout-ms",
        ),
        (
            "duplicate config dir",
            vec![
                "process",
                "wait",
                "1",
                "--config-dir",
                "/tmp/a",
                "--config-dir",
                "/tmp/b",
            ],
            "--config-dir is given twice",
        ),
        (
            "unknown process option",
            vec!["process", "wait", "1", "--window", "main"],
            "unknown option --window",
        ),
        (
            "unexpected argument",
            vec!["process", "wait", "1", "extra"],
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
