//! The `log` call of the page (docs/spec/logging.md#writers): the page relays a batch of events. The host validates the
//! whole batch before it writes any event, then stores every event in the layer `page` with the time the page gave it.

use serde_json::value::to_raw_value;
use serde_json::Value;

use crate::event_log::{EventLog, Level};

/// One validated event of a page batch.
struct Relayed {
    ts_us: u64,
    level: Level,
    event: String,
    fields: Box<serde_json::value::RawValue>,
    /// The record of the page that the event carries, when it is a `page.record.<level>` event.
    record: Option<crate::application_log::Entry>,
}

fn level_of(name: &str) -> Option<Level> {
    match name {
        "error" => Some(Level::Error),
        "warn" => Some(Level::Warn),
        "info" => Some(Level::Info),
        "debug" => Some(Level::Debug),
        "trace" => Some(Level::Trace),
        _ => None,
    }
}

fn relayed_of(item: &Value) -> Result<Relayed, String> {
    let object = item
        .as_object()
        .ok_or_else(|| "the event must be an object".to_string())?;
    let ts_us = object
        .get("ts_us")
        .and_then(Value::as_u64)
        .filter(|ts| *ts > 0)
        .ok_or_else(|| "ts_us must be a positive integer".to_string())?;
    let level_name = object
        .get("level")
        .and_then(Value::as_str)
        .filter(|name| level_of(name).is_some())
        .ok_or_else(|| "level must be one of error, warn, info, debug, trace".to_string())?;
    let level = level_of(level_name)
        .ok_or_else(|| "level must be one of error, warn, info, debug, trace".to_string())?;
    let event = object
        .get("event")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "event must be a name".to_string())?;
    let fields = object
        .get("fields")
        .filter(|fields| fields.is_object())
        .ok_or_else(|| "fields must be an object".to_string())?;
    if !event.starts_with("page.") {
        return Err(format!(
            "the event {event:?} does not start with its layer \"page\""
        ));
    }
    let record = if event.starts_with("page.record.") {
        let text_of = |name: &str| fields.get(name).and_then(Value::as_str);
        let (Some(place), Some(text)) = (text_of("where"), text_of("text")) else {
            return Err("fields where and text must be strings".into());
        };
        Some(crate::application_log::Entry::new(
            level_name, "page", place, text,
        ))
    } else {
        None
    };
    Ok(Relayed {
        ts_us,
        level,
        event: event.to_string(),
        fields: to_raw_value(fields)
            .map_err(|error| format!("fields cannot be serialized: {error}"))?,
        record,
    })
}

/// Validates a batch request of the page, queues its events into the writer of the host, and returns the lines
/// `<level> page <where>: <text>` of the records of the page in it, which the host shows in the transcript of the window.
pub fn log_command(log: &EventLog, request: Value) -> Result<Vec<String>, String> {
    match request.get("action").and_then(Value::as_str) {
        None => return Err("action must be batch".into()),
        Some("batch") => {}
        Some(other) => return Err(format!("action must be batch, not {other:?}")),
    }
    let items = request
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "events must be an array".to_string())?;
    let events = items
        .iter()
        .enumerate()
        .map(|(index, item)| relayed_of(item).map_err(|error| format!("events[{index}]: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    let mut lines = Vec::new();
    for (index, event) in events.into_iter().enumerate() {
        // The batch was validated as a whole, so a refusal here is a defect of the validation; nothing is written after
        // it.
        log.emit_relayed(event.ts_us, "page", event.level, &event.event, event.fields)
            .map_err(|error| format!("events[{index}]: {error}"))?;
        if let Some(record) = event.record {
            lines.push(record.line());
        }
    }
    Ok(lines)
}
