//! The stall dumps (docs/spec/logging.md#test-marks): when a host does not answer, the window check samples the threads of its
//! processes into a file of the logs folder, and the host stores the path as an event so the dump is found from the log. They
//! exist only in diagnostic builds.

use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::endpoint::Failure;
use crate::event_log::Level;
use crate::event_record::emit_host_placed;

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

/// Stores the event `host.stall.dump`, waits until it is in the log, and returns the boot identifier of the log and the `seq` of
/// the line.
pub fn emit_stall_dump(path: &str, deadline: Duration) -> Result<(String, u64), String> {
    emit_host_placed(
        Level::Warn,
        "host.stall.dump",
        json!({"path": path}),
        deadline,
    )
}
