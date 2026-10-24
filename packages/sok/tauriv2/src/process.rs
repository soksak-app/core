//! Commands that wait for operating-system process events without connecting to an application endpoint.

use std::io::Write;
use std::time::Duration;

use serde_json::json;

const WAIT_TIMEOUT_MAX_MS: u64 = 600_000;

/// Runs the process commands that do not connect to an application endpoint.
pub(crate) fn run(args: &[String], stdout: &mut dyn Write) -> Result<(), crate::Error> {
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
    run_wait(&args[1..], stdout)
}

fn run_wait(args: &[String], stdout: &mut dyn Write) -> Result<(), crate::Error> {
    let mut positionals = Vec::new();
    let mut timeout_ms = None;
    let mut help = false;
    let mut config_dir = None;
    let mut i = 0;
    while i < args.len() {
        let argument = &args[i];
        let Some(option) = argument.strip_prefix("--") else {
            positionals.push(argument.as_str());
            i += 1;
            continue;
        };
        let (name, inline) = match option.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (option, None),
        };
        match name {
            "help" => {
                if inline.is_some() || help {
                    return Err(crate::Error::Usage(
                        "--help takes no value and may be given once".into(),
                    ));
                }
                help = true;
                i += 1;
            }
            "timeout-ms" | "config-dir" => {
                let value = match inline {
                    Some(value) => value,
                    None => {
                        i += 1;
                        args.get(i)
                            .ok_or_else(|| crate::Error::Usage(format!("--{name} needs a value")))?
                    }
                };
                let slot = if name == "timeout-ms" {
                    &mut timeout_ms
                } else {
                    &mut config_dir
                };
                if slot.replace(value).is_some() {
                    return Err(crate::Error::Usage(format!("--{name} is given twice")));
                }
                i += 1;
            }
            _ => return Err(crate::Error::Usage(format!("unknown option --{name}"))),
        }
    }
    if help {
        writeln!(stdout, "{}", crate::USAGE).map_err(|error| error.to_string())?;
        return Ok(());
    }
    // The logged command wrapper reads this option before dispatch to select the sok event-file directory.
    let _config_dir = config_dir;
    if positionals.is_empty() {
        return Err(crate::Error::Usage("process wait requires a pid".into()));
    }
    if positionals.len() > 1 {
        return Err(crate::Error::Usage(format!(
            "unexpected argument {}",
            positionals[1]
        )));
    }
    let pid_text = positionals[0];
    if !decimal_digits(pid_text) {
        return Err(crate::Error::Usage(
            "pid must be an integer from 1 to 2147483647".into(),
        ));
    }
    let pid = pid_text
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
        .ok_or_else(|| crate::Error::Usage("pid must be an integer from 1 to 2147483647".into()))?;
    let timeout_text =
        timeout_ms.ok_or_else(|| crate::Error::Usage("--timeout-ms is required".into()))?;
    if !decimal_digits(timeout_text) {
        return Err(crate::Error::Usage(
            "timeout must be an integer from 1 to 600000 milliseconds".into(),
        ));
    }
    let timeout = timeout_text
        .parse::<u64>()
        .ok()
        .filter(|timeout| (1..=WAIT_TIMEOUT_MAX_MS).contains(timeout))
        .ok_or_else(|| {
            crate::Error::Usage("timeout must be an integer from 1 to 600000 milliseconds".into())
        })?;

    let platform = crate::platform::current().map_err(crate::Error::Failed)?;
    let ended = platform
        .wait_process_end(pid as i32, Duration::from_millis(timeout))
        .map_err(|error| crate::Error::Failed(format!("process wait: {error}")))?;
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
