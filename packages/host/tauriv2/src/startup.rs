//! The failure of a setup step of the host (docs/spec/hosts.md#process-lifecycle). A failure that setup returns to tao reaches
//! the launch callback of the event loop, which cannot unwind: it panics there and aborts the process, so the system shows its
//! crash dialog and the message of the failure is lost. A failure ends the process with its message and the status 1, as the
//! failures before the first window do.

type Failure = Box<dyn std::error::Error>;

/// Passes a successful result on. For a failure it writes the message through `write` and ends the process through `exit` with
/// the status 1; the exit function of a test returns, so the failure is returned then.
pub fn exit_on_failure_with(
    result: Result<(), Failure>,
    mut write: impl FnMut(&str),
    exit: impl FnOnce(i32),
) -> Result<(), Failure> {
    if let Err(error) = &result {
        write(&error.to_string());
        exit(1);
    }
    result
}

/// The setup result of the host: a failure writes its message to the standard error and to the application log, then ends the
/// process with the status 1.
pub fn exit_on_failure(result: Result<(), Failure>) -> Result<(), Failure> {
    exit_on_failure_with(
        result,
        |text| {
            eprintln!("{text}");
            crate::application_log::log_error("startup", text);
        },
        |status| {
            // The record of the failure is stored before the process ends.
            if let Err(error) =
                crate::event_record::flush_records(std::time::Duration::from_secs(2))
            {
                eprintln!(
                    "event writer: the record of the startup failure was not stored: {error}"
                );
            }
            std::process::exit(status)
        },
    )
}
