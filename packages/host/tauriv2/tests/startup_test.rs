//! A failure of a setup step ends the process with its message and the status 1 instead of aborting it
//! (docs/spec/hosts.md#process-lifecycle). A failure that setup returns to the launch callback of the event loop makes that
//! callback panic, which aborts the process and shows the crash dialog of the system instead of the message.

use soksak_host_tauriv2::startup::exit_on_failure_with;

// contract: startup.failure.exits-with-its-message
#[test]
fn a_failed_setup_step_writes_its_message_and_exits_with_status_one() {
    let mut written = vec![];
    let mut statuses = vec![];
    let result = exit_on_failure_with(
        Err("installed plugins: plugins/installed.json browser: unknown field package".into()),
        |text| written.push(text.to_string()),
        |status| statuses.push(status),
    );
    assert_eq!(
        written,
        ["installed plugins: plugins/installed.json browser: unknown field package"]
    );
    assert_eq!(statuses, [1]);
    // The exit function of a test returns, so the failure is still the result.
    assert!(result.is_err());
}

// contract: startup.failure.exits-with-its-message
#[test]
fn a_setup_step_that_succeeds_writes_nothing_and_does_not_exit() {
    let mut written = vec![];
    let mut statuses = vec![];
    let result = exit_on_failure_with(
        Ok(()),
        |text| written.push(text.to_string()),
        |status| statuses.push(status),
    );
    assert!(written.is_empty() && statuses.is_empty());
    assert!(result.is_ok());
}
