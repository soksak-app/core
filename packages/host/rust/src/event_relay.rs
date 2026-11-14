//! The `log` call of a document (docs/spec/logging.md#writers): the workbench, and a view page through `runtime.log`, relays a
//! batch of events. The host validates the whole batch before it writes any event, then stores every event in the layer of its
//! writer or `plugin`, the one that its name starts with, with the member that names the writing document and the time the
//! document gave it.

use serde_json::Value;
use serde_json::value::to_raw_value;

use crate::bounds::{Fields, bounded_serialize, cut_text};
use crate::event_log::{EventLog, Level, RelayedEvent, monotonic_ns, valid_cid};

/// The writer of a batch: the layer of its own events and the member that names it on each event, with the error that a
/// missing member is refused with.
struct Writer {
    layer: &'static str,
    member: &'static str,
    missing: &'static str,
}

/// The writer of the events of the workbench, named by the start of the workbench (docs/spec/logging.md#event).
const WORKBENCH: Writer = Writer {
    layer: "workbench",
    member: "start",
    missing: "start must name the start of the workbench that wrote the event",
};

/// The writer of the events of a view page, named by its page identity (docs/spec/logging.md#event).
const VIEW_PAGE: Writer = Writer {
    layer: "page",
    member: "page",
    missing: "page must name the document that wrote the event",
};

/// The writer that each member names.
fn writer_named_by(member: &str) -> &'static str {
    if member == "start" {
        "the workbench"
    } else {
        "a view page"
    }
}

/// One validated event of a document batch.
struct Relayed {
    ts_us: u64,
    mono_ns: u64,
    cids: Vec<String>,
    level: Level,
    event: String,
    fields: Box<serde_json::value::RawValue>,
    /// The layer of the writer or `plugin`, the prefix of the name of the event.
    layer: &'static str,
    /// The record of the writer that the event carries, when it is a `<layer>.record.<level>` event.
    record: Option<crate::application_log::Entry>,
    /// The page identity of the view page that wrote the event; `None` for an event of the workbench.
    page: Option<String>,
    /// The start of the workbench that wrote the event; `None` for an event of a view page (docs/spec/logging.md#event).
    start: Option<String>,
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

fn relayed_of(item: &Value, writer: &Writer) -> Result<Relayed, String> {
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
    let own = format!("{}.", writer.layer);
    let layer = if event.starts_with(&own) {
        writer.layer
    } else if event.starts_with("plugin.") {
        "plugin"
    } else {
        return Err(format!(
            "the event {event:?} does not start with {own} or plugin."
        ));
    };
    if let Some(member) = ["page", "start"]
        .into_iter()
        .find(|member| *member != writer.member && object.contains_key(*member))
    {
        return Err(format!(
            "{member} is not a member of an event of {}",
            writer_named_by(writer.member)
        ));
    }
    let named = object
        .get(writer.member)
        .and_then(Value::as_str)
        .filter(|named| !named.is_empty())
        .ok_or_else(|| writer.missing.to_string())?
        .to_string();
    let (page, start) = if writer.member == "start" {
        (None, Some(named))
    } else {
        (Some(named), None)
    };
    let record = if event.starts_with(&format!("{own}record.")) {
        let text_of = |name: &str| fields.get(name).and_then(Value::as_str);
        let (Some(place), Some(text)) = (text_of("where"), text_of("text")) else {
            return Err("fields where and text must be strings".into());
        };
        Some(crate::application_log::Entry::new(
            level_name,
            writer.layer,
            place,
            text,
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
        page,
        start,
    })
}

/// The clocks of the host at one moment: the wall clock in microseconds and the monotonic clock in nanoseconds. The page
/// takes them to place its own clock on those of the host.
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct ClockReading {
    pub ts_us: u64,
    pub mono_ns: u64,
}

/// What the `log` call answers: the transcript lines of the records of the workbench in a batch or the transcript line of a `transcript`
/// request, the clocks of a clock request, or the classes of the policy in force of a `policy-read` request.
#[derive(Debug)]
pub struct LogReply {
    pub lines: Vec<String>,
    pub clock: Option<ClockReading>,
    pub classes: Option<serde_json::Map<String, Value>>,
}

/// Validates a request of the workbench. A `batch` queues its events into the writer of the host and answers the lines
/// `<level> workbench <where>: <text>` of the records of the workbench in it, which the host shows in the transcript of the
/// window.
/// A `clock` answers the clocks of the host and stores no event.
pub fn log_command(log: &EventLog, request: Value) -> Result<LogReply, String> {
    match request.get("action").and_then(Value::as_str) {
        None => {
            return Err("action must be batch, clock, policy, policy-read or transcript".into());
        }
        Some("batch") => {}
        Some("transcript") => return transcript_line(log, &request),
        Some("policy") => {
            crate::log_policy::set_log_policy(log, &request)?;
            return Ok(LogReply {
                lines: Vec::new(),
                clock: None,
                classes: None,
            });
        }
        Some("policy-read") => {
            return Ok(LogReply {
                lines: Vec::new(),
                clock: None,
                classes: Some(log.policy().classes()),
            });
        }
        Some("clock") => {
            return Ok(LogReply {
                lines: Vec::new(),
                clock: Some(clock_reading()?),
                classes: None,
            });
        }
        Some(other) => {
            return Err(format!(
                "action must be batch, clock, policy, policy-read or transcript, not {other:?}"
            ));
        }
    }
    log_batch(log, &request, &WORKBENCH)
}

/// The clocks of the host now; both are read together, so the document can take them as one moment.
fn clock_reading() -> Result<ClockReading, String> {
    let ts_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("the clock is before the Unix epoch: {error}"))?
        .as_micros() as u64;
    Ok(ClockReading {
        ts_us,
        mono_ns: monotonic_ns(),
    })
}

/// Validates the events of a batch of the writer as a whole, queues them into the writer of the host, and answers the lines
/// of the records of the writer in it.
fn log_batch(log: &EventLog, request: &Value, writer: &Writer) -> Result<LogReply, String> {
    let items = request
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "events must be an array".to_string())?;
    let events = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            relayed_of(item, writer).map_err(|error| format!("events[{index}]: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut lines = Vec::new();
    for (index, event) in events.into_iter().enumerate() {
        // The batch was validated as a whole, so a refusal here is a defect of the validation; nothing is written after
        // it.
        log.emit_relayed(RelayedEvent {
            ts_us: event.ts_us,
            mono_ns: event.mono_ns,
            layer: event.layer.to_string(),
            page: event.page,
            start: event.start,
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
    Ok(LogReply {
        lines,
        clock: None,
        classes: None,
    })
}

/// Stores the transcript line of a host call of the workbench as the record `workbench.record.info` with the place `workbench`,
/// cut to `RECORD_TEXT_BYTES` like every record, and answers the whole line, which the host sends to the connections that enabled
/// the diagnostic transcript of the window. A batch record carries only the text that the workbench cut to the bound, so the
/// whole line of a long call travels in this request (docs/spec/logging.md#bounds).
fn transcript_line(log: &EventLog, request: &Value) -> Result<LogReply, String> {
    let start = request
        .get("start")
        .and_then(Value::as_str)
        .filter(|start| !start.is_empty())
        .ok_or_else(|| {
            "start must name the start of the workbench that wrote the line".to_string()
        })?;
    let line = request
        .get("line")
        .and_then(Value::as_str)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| "line must be a non-empty string".to_string())?;
    let (text, cut) = cut_text(line, crate::bounds::RECORD_TEXT_BYTES);
    let mut record = serde_json::json!({"where": "workbench", "text": text});
    if cut {
        record["truncated"] = serde_json::json!(true);
    }
    let fields = Fields::of(&record)?;
    let ts_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("the clock is before the Unix epoch: {error}"))?
        .as_micros() as u64;
    log.emit_relayed(RelayedEvent {
        ts_us,
        mono_ns: monotonic_ns(),
        layer: "workbench".to_string(),
        page: None,
        start: Some(start.to_string()),
        level: Level::Info,
        event: "workbench.record.info".to_string(),
        cids: Vec::new(),
        fields,
    })
    .map_err(|error| error.to_string())?;
    Ok(LogReply {
        lines: vec![
            crate::application_log::Entry::new("info", "workbench", "workbench", line).line(),
        ],
        clock: None,
        classes: None,
    })
}

/// Handles the page writer requests from one plugin view without accepting policy changes or another source identity.
pub fn view_log_command(
    log: &EventLog,
    request: Value,
    plugin: &str,
    surface: &str,
    page: &str,
    time_origin: f64,
) -> Result<Value, String> {
    match request.get("action").and_then(Value::as_str) {
        Some("clock") => {
            if request.as_object().is_none_or(|object| object.len() != 1) {
                return Err("runtime.log clock request accepts only action".into());
            }
            serde_json::to_value(clock_reading()?).map_err(|error| error.to_string())
        }
        Some("batch") => {
            if request.as_object().is_none_or(|object| object.len() != 2) {
                return Err("runtime.log batch request accepts only action and events".into());
            }
            let mut request = request;
            let events = request
                .get("events")
                .and_then(Value::as_array)
                .ok_or_else(|| "events must be an array".to_string())?;
            let plugin_prefix = format!("plugin.{plugin}.");
            if page.is_empty() || !time_origin.is_finite() || time_origin <= 0.0 {
                return Err(
                    "the registered view document has no page identity and positive finite time origin"
                        .to_string(),
                );
            }
            for (index, item) in events.iter().enumerate() {
                let object = item
                    .as_object()
                    .ok_or_else(|| format!("events[{index}]: the event must be an object"))?;
                let named_page = object.get("page").and_then(Value::as_str).ok_or_else(|| {
                    format!("events[{index}]: page must name the document that wrote the event")
                })?;
                if named_page != page {
                    return Err(format!(
                        "events[{index}]: page {named_page:?} does not match the ready view page {page:?}"
                    ));
                }
                let event = object
                    .get("event")
                    .and_then(Value::as_str)
                    .filter(|event| !event.is_empty())
                    .ok_or_else(|| format!("events[{index}]: event must be a name"))?;
                let fields = object
                    .get("fields")
                    .and_then(Value::as_object)
                    .ok_or_else(|| format!("events[{index}]: fields must be an object"))?;
                if event.starts_with(&plugin_prefix) {
                    if fields.contains_key("surface") {
                        return Err(format!(
                            "events[{index}]: plugin event {event:?} cannot set its owning surface"
                        ));
                    }
                } else if matches!(event, "page.start" | "page.log.clock" | "page.log.dropped") {
                    if event == "page.start" {
                        let started = fields
                            .get("time_origin")
                            .and_then(Value::as_f64)
                            .ok_or_else(|| {
                                format!("events[{index}]: page.start time_origin must be a number")
                            })?;
                        if started != time_origin {
                            return Err(format!(
                                "events[{index}]: page.start time_origin {started} does not match the time origin {time_origin} of the ready view document {page:?}"
                            ));
                        }
                        if fields
                            .get("url")
                            .and_then(Value::as_str)
                            .filter(|url| !url.is_empty())
                            .is_none()
                        {
                            return Err(format!(
                                "events[{index}]: page.start url must be non-empty text"
                            ));
                        }
                    }
                } else {
                    return Err(format!(
                        "events[{index}]: event {event:?} is not a record of plugin {plugin:?} or an allowed page record"
                    ));
                }
            }
            for item in request["events"]
                .as_array_mut()
                .expect("validated events array")
            {
                let event = item["event"].as_str().expect("validated event name");
                if event.starts_with(&plugin_prefix) {
                    item["fields"]["surface"] = Value::String(surface.to_string());
                    let (fields, produced) =
                        bounded_serialize(&item["fields"], 65_536).map_err(|error| {
                            format!("plugin event fields cannot be bounded: {error}")
                        })?;
                    if produced.is_some() {
                        let (head, _) = cut_text(&fields, 4_096);
                        item["fields"] = serde_json::json!({
                            "head": head,
                            "truncated": true,
                            "surface": surface
                        });
                    }
                }
            }
            log_batch(log, &request, &VIEW_PAGE)?;
            Ok(Value::Null)
        }
        Some(other) => Err(format!("action must be batch or clock, not {other:?}")),
        None => Err("action must be batch or clock".into()),
    }
}
