//! Commands that wait for operating-system process events without connecting to an application endpoint.

use std::io::Write;
use std::sync::mpsc;

use serde_json::json;

pub(crate) enum WaitError {
    Platform(String),
    Operation(String),
}

/// The wait for the end of a process: it receives the PID and returns when the operating system reports that the process
/// ended. It takes no time limit; a signal that sok receives ends the command instead (docs/spec/cli.md).
pub(crate) type Wait = dyn FnOnce(i32) -> Result<(), WaitError> + Send;

/// The first of the events that end a process wait.
enum WaitEnd {
    Ended(Result<(), WaitError>),
    Interrupted(&'static str),
}

/// Runs the process commands that do not connect to an application endpoint.
pub(crate) fn run(
    args: &[String],
    stdout: &mut dyn Write,
    wait_process_end: Box<Wait>,
) -> Result<(), crate::Error> {
    if args.len() == 1 && args[0] == "--help" {
        writeln!(stdout, "{}", crate::USAGE).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if args.is_empty() {
        return Err(crate::Error::Usage("process requires an action".into()));
    }
    if args.first().map(String::as_str) != Some("wait") {
        return Err(crate::Error::Usage(format!(
            "unknown command: process {}",
            args.join(" ")
        )));
    }
    run_wait(&args[1..], stdout, wait_process_end)
}

fn run_wait(
    args: &[String],
    stdout: &mut dyn Write,
    wait_process_end: Box<Wait>,
) -> Result<(), crate::Error> {
    let parsed = crate::parse_scoped_arguments(args, &["help"], &["config-dir"])?;
    if parsed.flag("help") {
        writeln!(stdout, "{}", crate::USAGE).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if parsed.positionals.is_empty() {
        return Err(crate::Error::Usage("process wait requires a pid".into()));
    }
    if parsed.positionals.len() > 1 {
        return Err(crate::Error::Usage(format!(
            "unexpected argument {}",
            parsed.positionals[1]
        )));
    }
    let pid_text = &parsed.positionals[0];
    if !decimal_digits(pid_text) {
        return Err(crate::Error::Usage(
            "pid must be an integer from 1 to 2147483647".into(),
        ));
    }
    let pid = pid_text
        .parse::<u32>()
        .map_err(|_| crate::Error::Usage("pid must be an integer from 1 to 2147483647".into()))?;
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(crate::Error::Usage(
            "pid must be an integer from 1 to 2147483647".into(),
        ));
    }
    // The signals are watched before the wait starts, so a signal while the process runs always ends the wait. The wait runs
    // on its own thread, and the first of its end and a signal ends the command; a wait that a signal ended is left to the
    // end of the process of sok.
    let (end_tx, end_rx) = mpsc::channel::<WaitEnd>();
    let interrupted = end_tx.clone();
    crate::platform::current()
        .map_err(crate::Error::Failed)?
        .on_interrupt(Box::new(move |signal| {
            match interrupted.send(WaitEnd::Interrupted(signal)) {
                // A command that already ended dropped the receiver, and the signal then ends nothing.
                Ok(()) | Err(mpsc::SendError(_)) => {}
            }
        }))
        .map_err(|error| crate::Error::Failed(format!("process wait: {error}")))?;
    crate::routine::spawn_named("process-wait", move || {
        match end_tx.send(WaitEnd::Ended(wait_process_end(pid as i32))) {
            // A command that a signal ended dropped the receiver, and the end of the process then reports nothing.
            Ok(()) | Err(mpsc::SendError(_)) => {}
        }
    });
    let end = end_rx.recv().map_err(|_| {
        crate::Error::Failed("process wait: the wait ended without a result".into())
    })?;
    match end {
        WaitEnd::Interrupted(signal) => {
            return Err(crate::Error::Failed(format!(
                "process {pid} wait was interrupted by {signal}"
            )));
        }
        WaitEnd::Ended(Err(error)) => {
            return Err(crate::Error::Failed(match error {
                WaitError::Platform(message) => message,
                WaitError::Operation(message) => format!("process wait: {message}"),
            }));
        }
        WaitEnd::Ended(Ok(())) => {}
    }
    let output = serde_json::to_string_pretty(&json!({"pid": pid, "ended": true}))
        .map_err(|error| crate::Error::Failed(format!("process wait result: {error}")))?;
    writeln!(stdout, "{output}").map_err(|error| error.to_string())?;
    Ok(())
}

fn decimal_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}
