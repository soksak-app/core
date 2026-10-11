//! The `log` call of the page (docs/spec/logging.md#writers): the page relays a batch of events. The host validates the
//! whole batch before it writes any event, then stores every event in the layer `page` with the time the page gave it.

use serde_json::value::to_raw_value;
use serde_json::Value;

use crate::bounds::Fields;
use crate::event_log::{monotonic_ns, valid_cid, EventLog, Level, RelayedEvent};

/// One validated event of a page batch.
struct Relayed {
    ts_us: u64,
    mono_ns: u64,
    cids: Vec<String>,
    level: Level,
    event: String,
    fields: Box<serde_json::value::RawValue>,
    /// `page` or `plugin`, the prefix of the name of the event.
    layer: &'static str,
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
    let mono_ns = object
        .get("mono_ns")
        .and_then(Value::as_u64)
        .filter(|mono| *mono > 0)
        .ok_or_else(|| "mono_ns must be a positive integer".to_string())?;
    let cids = match object.get("cids") {
        None => Vec::new(),
        Some(value) => value
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().filter(|cid| valid_cid(cid)).map(str::to_string))
                    .collect::<Option<Vec<String>>>()
            })
            .ok_or_else(|| {
                "cids must be an array of non-empty strings without a quote, a backslash or a control character"
                    .to_string()
            })?,
    };
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
    let layer = if event.starts_with("page.") {
        "page"
    } else if event.starts_with("plugin.") {
        "plugin"
    } else {
        return Err(format!(
            "the event {event:?} does not start with page. or plugin."
        ));
    };
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
        mono_ns,
        cids,
        level,
        event: event.to_string(),
        fields: to_raw_value(fields)
            .map_err(|error| format!("fields cannot be serialized: {error}"))?,
        layer,
        record,
    })
}

/// The clocks of the host at one moment: the wall clock in microseconds and the monotonic clock in nanoseconds. The page
/// takes them to place its own clock on those of the host.
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct ClockReading {
    pub ts_us: u64,
    pub mono_ns: u64,
}

/// What the `log` call answers: the transcript lines of the page records of a batch, or the clocks of a clock request.
#[derive(Debug)]
pub struct LogReply {
    pub lines: Vec<String>,
    pub clock: Option<ClockReading>,
}

/// Validates a request of the page. A `batch` queues its events into the writer of the host and answers the lines
/// `<level> page <where>: <text>` of the records of the page in it, which the host shows in the transcript of the window.
/// A `clock` answers the clocks of the host and stores no event.
pub fn log_command(log: &EventLog, request: Value) -> Result<LogReply, String> {
    match request.get("action").and_then(Value::as_str) {
        None => return Err("action must be batch, clock or policy".into()),
        Some("batch") => {}
        Some("policy") => {
            crate::log_policy::set_log_policy(log, &request)?;
            return Ok(LogReply {
                lines: Vec::new(),
                clock: None,
            });
        }
        Some("clock") => {
            // Both clocks are read together, so the page can take them as one moment.
            let ts_us = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| format!("the clock is before the Unix epoch: {error}"))?
                .as_micros() as u64;
            return Ok(LogReply {
                lines: Vec::new(),
                clock: Some(ClockReading {
                    ts_us,
                    mono_ns: monotonic_ns(),
                }),
            });
        }
        Some(other) => {
            return Err(format!(
                "action must be batch, clock or policy, not {other:?}"
            ))
        }
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
        log.emit_relayed(RelayedEvent {
            ts_us: event.ts_us,
            mono_ns: event.mono_ns,
            layer: event.layer.to_string(),
            level: event.level,
            event: event.event,
            cids: event.cids,
            fields: Fields::whole(event.fields),
        })
        .map_err(|error| format!("events[{index}]: {error}"))?;
        if let Some(record) = event.record {
            lines.push(record.line());
        }
    }
    Ok(LogReply { lines, clock: None })
}
