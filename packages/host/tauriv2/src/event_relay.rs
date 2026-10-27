//! The `log` call of the page (docs/spec/logging.md#writers): the page relays a batch of events. The host validates the
//! whole batch before it writes any event, then stores every event in the layer `page` with the time the page gave it.

use serde_json::Value;
use serde_json::value::to_raw_value;

use crate::bounds::{Fields, bounded_serialize, cut_text};
use crate::event_log::{EventLog, Level, RelayedEvent, monotonic_ns, valid_cid};

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
    /// The time origin of the document that wrote the event (docs/spec/logging.md#event).
    page: String,
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
    let page = object
        .get("page")
        .and_then(Value::as_str)
        .filter(|page| !page.is_empty())
        .ok_or_else(|| "page must name the document that wrote the event".to_string())?;
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
        page: page.to_string(),
    })
}

/// The clocks of the host at one moment: the wall clock in microseconds and the monotonic clock in nanoseconds. The page
/// takes them to place its own clock on those of the host.
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct ClockReading {
    pub ts_us: u64,
    pub mono_ns: u64,
}

/// What the `log` call answers: the transcript lines of the page records of a batch, the clocks of a clock request, or the classes
/// of the policy in force of a `policy-read` request.
#[derive(Debug)]
pub struct LogReply {
    pub lines: Vec<String>,
    pub clock: Option<ClockReading>,
    pub classes: Option<serde_json::Map<String, Value>>,
}

/// Validates a request of the page. A `batch` queues its events into the writer of the host and answers the lines
/// `<level> page <where>: <text>` of the records of the page in it, which the host shows in the transcript of the window.
/// A `clock` answers the clocks of the host and stores no event.
pub fn log_command(log: &EventLog, request: Value) -> Result<LogReply, String> {
    match request.get("action").and_then(Value::as_str) {
        None => return Err("action must be batch, clock, policy or policy-read".into()),
        Some("batch") => {}
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
                classes: None,
            });
        }
        Some(other) => {
            return Err(format!(
                "action must be batch, clock, policy or policy-read, not {other:?}"
            ));
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
            page: Some(event.page),
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

/// Handles the page writer requests from one plugin view without accepting policy changes or another source identity.
pub fn view_log_command(
    log: &EventLog,
    request: Value,
    plugin: &str,
    surface: &str,
    page: &str,
) -> Result<Value, String> {
    match request.get("action").and_then(Value::as_str) {
        Some("clock") => {
            if request.as_object().is_none_or(|object| object.len() != 1) {
                return Err("runtime.log clock request accepts only action".into());
            }
            let reply = log_command(log, request)?;
            serde_json::to_value(reply.clock).map_err(|error| error.to_string())
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
            let page_time_origin = page
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite() && *value > 0.0)
                .ok_or_else(|| {
                    "the registered page is not a positive numeric time origin".to_string()
                })?;
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
                        let time_origin = fields
                            .get("time_origin")
                            .and_then(Value::as_f64)
                            .ok_or_else(|| {
                                format!("events[{index}]: page.start time_origin must be a number")
                            })?;
                        if time_origin != page_time_origin {
                            return Err(format!(
                                "events[{index}]: page.start time_origin {time_origin} does not match ready page {page:?}"
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
                        "events[{index}]: event {event:?} is not allowed for plugin {plugin:?}"
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
            log_command(log, request)?;
            Ok(Value::Null)
        }
        Some(other) => Err(format!("action must be batch or clock, not {other:?}")),
        None => Err("action must be batch or clock".into()),
    }
}
