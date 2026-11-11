//! The stall dumps (docs/spec/logging.md#test-marks): when a host does not answer, the window check samples the threads of its
//! processes into a file of the logs folder, and the host stores the path as an event so the dump is found from the log. The event
//! names the host calls of every window that have not returned. They exist only in diagnostic builds. A Rust host has no
//! goroutines: each of its threads, the threads of its async runtime included, is in the thread sample of the window check.

use std::path::Path;
use std::time::Instant;

use serde_json::{Map, Value, json};

use crate::endpoint::Failure;
use crate::event_log::Level;
use crate::event_record::emit_host_placed;
use crate::running_calls::RunningCalls;

/// Reads the parameters of `diagnostics.stall.dump`: the absolute path of an existing file. Anything outside the contract is an
/// invalid-params error.
pub fn parse_stall_dump(params: &Map<String, Value>) -> Result<String, Failure> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Failure::params("path must be a non-empty string"))?;
    if !Path::new(path).is_absolute() {
        return Err(Failure::params("path must be absolute"));
    }
    if !Path::new(path).is_file() {
        return Err(Failure::params(format!(
            "path does not name a file: {path}"
        )));
    }
    Ok(path.to_string())
}

/// Stores the event `host.stall.dump` with `path` and the running host calls of every window in `calls` at `now`, waits until it is
/// in the log, and returns the reply: the boot identifier of the log, the `seq` of the line and the running calls of `window`,
/// `none` without one.
pub fn stall_dump(
    path: &str,
    window: &str,
    calls: &RunningCalls,
    now: Instant,
) -> Result<Value, String> {
    let (boot, seq) = emit_host_placed(
        Level::Warn,
        "host.stall.dump",
        json!({"path": path, "running": calls.all(now)}),
    )?;
    Ok(json!({"boot": boot, "seq": seq, "running": calls.of(window, now)}))
}
