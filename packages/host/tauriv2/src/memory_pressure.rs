//! The relay of the memory pressure reports to the pages (docs/spec/hosts.md#memory-pressure).

use serde_json::{Value, json};

/// The function that each report of the memory pressure source calls with the level and the seq.
pub type Report = Box<dyn Fn(&str, u64)>;

/// Starts the source through on_memory_pressure and sends each of its reports to the pages as the page event
/// `memory-pressure` with `{level, seq}` through emit.
pub fn start(
    on_memory_pressure: impl FnOnce(Report) -> Result<(), String>,
    emit: impl Fn(&str, Value) + 'static,
) -> Result<(), String> {
    on_memory_pressure(Box::new(move |level, seq| {
        emit("memory-pressure", json!({"level": level, "seq": seq}))
    }))
}

/// Reads the level of a memory pressure report: `normal`, `warn` or `critical`.
pub fn parse_level(raw: Option<&Value>) -> Result<String, String> {
    match raw.and_then(Value::as_str) {
        Some(level @ ("normal" | "warn" | "critical")) => Ok(level.to_string()),
        _ => Err("level must be normal, warn or critical".to_string()),
    }
}
