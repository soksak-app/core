//! Commands that wait for operating-system process events without connecting to an application endpoint.

use std::io::Write;
use std::time::Duration;

use serde_json::json;

const WAIT_TIMEOUT_MAX_MS: u64 = 600_000;

pub(crate) enum WaitError {
    Platform(String),
    Operation(String),
}

/// Runs the process commands that do not connect to an application endpoint.
pub(crate) fn run(
    args: &[String],
    stdout: &mut dyn Write,
    wait_process_end: &mut dyn FnMut(i32, Duration) -> Result<bool, WaitError>,
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
    wait_process_end: &mut dyn FnMut(i32, Duration) -> Result<bool, WaitError>,
) -> Result<(), crate::Error> {
    let parsed = crate::parse_scoped_arguments(args, &["help"], &["config-dir", "timeout-ms"])?;
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
    let timeout_text = parsed
        .values
        .get("timeout-ms")
        .ok_or_else(|| crate::Error::Usage("--timeout-ms is required".into()))?;
    if !decimal_digits(timeout_text) {
        return Err(crate::Error::Usage(
            "timeout must be an integer from 1 to 600000 milliseconds".into(),
        ));
    }
    let timeout = timeout_text.parse::<u64>().map_err(|_| {
        crate::Error::Usage("timeout must be an integer from 1 to 600000 milliseconds".into())
    })?;
    if !(1..=WAIT_TIMEOUT_MAX_MS).contains(&timeout) {
        return Err(crate::Error::Usage(
            "timeout must be an integer from 1 to 600000 milliseconds".into(),
        ));
    }

    let ended = wait_process_end(pid as i32, Duration::from_millis(timeout)).map_err(|error| {
        crate::Error::Failed(match error {
            WaitError::Platform(message) => message,
            WaitError::Operation(message) => format!("process wait: {message}"),
        })
    })?;
    if !ended {
        return Err(crate::Error::Failed(format!(
            "process {pid} did not end within {timeout}ms"
        )));
    }
    let output = serde_json::to_string_pretty(&json!({"pid": pid, "ended": true}))
        .map_err(|error| crate::Error::Failed(format!("process wait result: {error}")))?;
    writeln!(stdout, "{output}").map_err(|error| error.to_string())?;
    Ok(())
}

fn decimal_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}
