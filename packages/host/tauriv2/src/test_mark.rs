//! The marks of a test run (docs/spec/logging.md#test-marks): a window check stores the start and the end of each test in the
//! event log of the application, so a test is a range of positions `(boot, seq)` of the log. They exist only in diagnostic
//! builds.

use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::endpoint::Failure;
use crate::event_log::Level;
use crate::event_record::emit_host_placed;

/// The content of a `diagnostics.test.mark` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestMark {
    pub kind: String,
    pub name: String,
    pub run: String,
    /// `pass`, `fail` or `skip` for an end mark; empty for a start mark.
    pub result: String,
}

/// Reads the parameters of `diagnostics.test.mark`. Anything outside the contract is an invalid-params error.
pub fn parse_test_mark(params: &Map<String, Value>) -> Result<TestMark, Failure> {
    let text = |key: &str, message: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| Failure::params(message))
    };
    let kind = params.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "start" && kind != "end" {
        return Err(Failure::params("kind must be start or end"));
    }
    let name = text("name", "name must be a non-empty string")?;
    let run = text("run", "run must be a non-empty string")?;
    let result = if kind == "start" {
        if params.contains_key("result") {
            return Err(Failure::params("result is only for an end mark"));
        }
        String::new()
    } else {
        match params.get("result").and_then(Value::as_str) {
            Some(result @ ("pass" | "fail" | "skip")) => result.to_string(),
            _ => return Err(Failure::params("result must be pass, fail or skip")),
        }
    };
    Ok(TestMark {
        kind: kind.to_string(),
        name,
        run,
        result,
    })
}

/// Stores the mark as the event `host.test.start` or `host.test.end`, waits until it is in the log, and returns the boot
/// identifier of the log and the `seq` of the line.
pub fn emit_test_mark(mark: &TestMark, deadline: Duration) -> Result<(String, u64), String> {
    let (event, fields) = if mark.kind == "end" {
        (
            "host.test.end",
            json!({"name": mark.name, "run": mark.run, "result": mark.result}),
        )
    } else {
        (
            "host.test.start",
            json!({"name": mark.name, "run": mark.run}),
        )
    };
    emit_host_placed(Level::Info, event, fields, deadline)
}
