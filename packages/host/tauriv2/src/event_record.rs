//! The records of the host (docs/spec/logging.md#writers): an error or an observation of the host, and a record that the
//! page reports, are events `<layer>.record.<level>` with the fields `where` and `text`. A bounded start buffer holds the
//! records written before the writer of the host exists.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use serde_json::value::{to_raw_value, RawValue};

use crate::event_log::{EventLog, Level};

/// The number of records that the start buffer holds; a record beyond it is refused and counted.
pub const START_BUFFER_RECORDS: usize = 1024;

struct Buffered {
    ts_us: u64,
    layer: String,
    level: Level,
    event: String,
    fields: Box<RawValue>,
}

#[derive(Default)]
struct Records {
    log: Option<Arc<EventLog>>,
    buffer: Vec<Buffered>,
    lost_events: u64,
    lost_bytes: u64,
}

/// The writer of the records and the start buffer under one lock, so a record written while the writer is attached keeps its
/// place in the order.
static RECORDS: Mutex<Records> = Mutex::new(Records {
    log: None,
    buffer: Vec::new(),
    lost_events: 0,
    lost_bytes: 0,
});

/// Locks the records.
fn records() -> std::sync::MutexGuard<'static, Records> {
    // default: a lock that a panicking thread poisoned still holds consistent records, and the record of that panic must
    // reach the writer, so the poison is not an error here.
    RECORDS.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is before the Unix epoch")
        .as_micros() as u64
}

/// Makes `log` the writer of the records of the host and hands it the records of the start buffer in their order and with
/// the time they were written; the records that the buffer refused are counted in the writer. `None` detaches the writer and
/// clears the buffer.
pub fn use_host_event_log(log: Option<Arc<EventLog>>) {
    let mut records = records();
    let buffered = std::mem::take(&mut records.buffer);
    let (lost_events, lost_bytes) = (
        std::mem::take(&mut records.lost_events),
        std::mem::take(&mut records.lost_bytes),
    );
    if let Some(log) = log.as_ref() {
        for record in buffered {
            if let Err(error) = log.emit_relayed(
                record.ts_us,
                &record.layer,
                record.level,
                &record.event,
                record.fields,
            ) {
                eprintln!("event writer: a buffered record cannot be stored: {error}");
            }
        }
        log.count_loss(lost_events, lost_bytes);
    }
    records.log = log;
}

/// Stores a record as the event `<layer>.record.<level>`.
pub fn emit_record(level: &str, layer: &str, place: &str, text: String) {
    let parsed = match level {
        "error" => Level::Error,
        "info" => Level::Info,
        other => {
            eprintln!("event writer: the record {place:?} of {layer} has the level {other:?}, which is not error or info");
            return;
        }
    };
    let name = format!("{layer}.record.{level}");
    let fields = match to_raw_value(&json!({"where": place, "text": text})) {
        Ok(fields) => fields,
        Err(error) => {
            eprintln!(
                "event writer: the record {place:?} of {layer} cannot be serialized: {error}"
            );
            return;
        }
    };
    // events: host.record.<level>, sidecar.record.<level>
    store_event(parsed, layer, &name, place, fields);
}

/// Hands an event to the writer of the host, or to the start buffer while no writer exists. `place` names the record in the
/// reports of a refusal.
fn store_event(level: Level, layer: &str, name: &str, place: &str, fields: Box<RawValue>) {
    let now = now_us();
    let mut records = records();
    if let Some(log) = records.log.clone() {
        if let Err(error) = log.emit_relayed(now, layer, level, name, fields) {
            eprintln!("event writer: the record {place:?} of {layer} cannot be stored: {error}");
        }
        return;
    }
    if records.buffer.len() >= START_BUFFER_RECORDS {
        records.lost_events += 1;
        records.lost_bytes += (fields.get().len() + name.len()) as u64;
        return;
    }
    records.buffer.push(Buffered {
        ts_us: now,
        layer: layer.to_string(),
        level,
        event: name.to_string(),
        fields,
    });
}

/// Stores an observation of the trace of the host as the event `host.<kind>.<event>`, where kind is `trace` for the layer
/// `host` and `sampler` for the layer `sampler`. The fields hold the name of the event in `event`, which the name of the
/// stored event replaces.
pub fn emit_trace(layer: &str, fields: serde_json::Value) -> Result<(), String> {
    let kind = match layer {
        "host" => "trace",
        "sampler" => "sampler",
        other => {
            return Err(format!(
                "the layer {other:?} of an observation is not host or sampler"
            ))
        }
    };
    let serde_json::Value::Object(mut fields) = fields else {
        return Err("the fields of an observation must be an object".into());
    };
    let event = match fields.remove("event") {
        Some(serde_json::Value::String(event)) if !event.is_empty() => event,
        _ => return Err("event must be a string".into()),
    };
    let text = to_raw_value(&fields)
        .map_err(|error| format!("the fields of {event} cannot be serialized: {error}"))?;
    // events: host.trace.<event>, host.sampler.<event>
    store_event(
        Level::Debug,
        "host",
        &format!("host.{kind}.{event}"),
        &event,
        text,
    );
    Ok(())
}

/// Stores an event of the layer `host` with the level, the name `host.<subsystem>.<event>` and the fields. It is the entrance of
/// the sources of the host that are not records (docs/spec/logging.md#automatic-entrances). A name outside `host.` and fields
/// that cannot be serialized are reported on the standard error and nothing is stored.
pub fn emit_host(level: Level, event: &str, fields: serde_json::Value) {
    if !event.starts_with("host.") {
        eprintln!("event writer: the event {event:?} does not start with host.");
        return;
    }
    match to_raw_value(&fields) {
        // events: forwarded
        Ok(text) => store_event(level, "host", event, event, text),
        Err(error) => {
            eprintln!("event writer: the fields of {event} cannot be serialized: {error}")
        }
    }
}

/// Waits until the records written so far are in the event log, at most `deadline`. The paths that end the process (a panic
/// hook, a fatal handler) call it, so the record of the failure is stored before the process ends. Without an attached
/// writer there is nothing to wait for: the records wait in the start buffer, and the standard error holds the failure.
pub fn flush_records(deadline: std::time::Duration) -> Result<(), String> {
    let log = records().log.clone();
    match log {
        Some(log) => log.flush(deadline),
        None => Ok(()),
    }
}
