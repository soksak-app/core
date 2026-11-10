//! The records of the host (docs/spec/logging.md#writers): an error or an observation of the host, and a record that the
//! page reports, are events `<layer>.record.<level>` with the fields `where` and `text`. A bounded start buffer holds the
//! records written before the writer of the host exists.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::bounds::{Fields, RECORD_PLACE_BYTES, RECORD_TEXT_BYTES, cut_text};
use crate::event_log::{
    Channel, EventLog, Level, LossReason, RelayedEvent, monotonic_ns, valid_cid,
};

/// The number of records that the start buffer holds; a record beyond it is refused and counted.
pub const START_BUFFER_RECORDS: usize = 1024;
pub use crate::bounds::START_BUFFER_BYTES;

struct Buffered {
    ts_us: u64,
    mono_ns: u64,
    cids: Vec<String>,
    layer: String,
    level: Level,
    event: String,
    fields: Fields,
}

#[derive(Default)]
struct Records {
    log: Option<Arc<EventLog>>,
    buffer: Vec<Buffered>,
    buffer_bytes: usize,
    /// The records that the full buffer refused, as events and bytes for each channel of the writer.
    lost: [(u64, u64); 2],
}

/// The writer of the records and the start buffer under one lock, so a record written while the writer is attached keeps its
/// place in the order.
static RECORDS: Mutex<Records> = Mutex::new(Records {
    log: None,
    buffer: Vec::new(),
    buffer_bytes: 0,
    lost: [(0, 0); 2],
});

fn channel_index(channel: Channel) -> usize {
    match channel {
        Channel::Other => 0,
        Channel::Debug => 1,
    }
}

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
    crate::log_policy::use_gate(log.as_deref());
    let buffered = std::mem::take(&mut records.buffer);
    records.buffer_bytes = 0;
    let lost = std::mem::take(&mut records.lost);
    if let Some(log) = log.as_ref() {
        for record in buffered {
            if let Err(error) = log.emit_relayed(RelayedEvent {
                ts_us: record.ts_us,
                mono_ns: record.mono_ns,
                layer: record.layer,
                page: None,
                start: None,
                level: record.level,
                event: record.event,
                cids: record.cids,
                fields: record.fields,
            }) {
                eprintln!("event writer: a buffered record cannot be stored: {error}");
            }
        }
        for channel in Channel::ALL {
            let (events, bytes) = lost[channel_index(channel)];
            log.count_loss(channel, LossReason::StartBufferFull, events, bytes);
        }
    }
    let attached = log.is_some();
    records.log = log;
    if attached {
        crate::routine::notify_writer_attached();
    }
}

/// Stores a record as the event `<layer>.record.<level>`. The place and the text are cut to `RECORD_PLACE_BYTES` and
/// `RECORD_TEXT_BYTES` on a character boundary, and the fields say `truncated` when either was cut.
pub fn emit_record(
    level: &str,
    layer: &str,
    place: &str,
    text: String,
    site: Option<&std::panic::Location<'_>>,
) {
    let parsed = match level {
        "error" => Level::Error,
        "warn" => Level::Warn,
        "info" => Level::Info,
        other => {
            eprintln!(
                "event writer: the record {place:?} of {layer} has the level {other:?}, which is not error, warn or info"
            );
            return;
        }
    };
    let name = format!("{layer}.record.{level}");
    let (stored_place, cut_place) = cut_text(place, RECORD_PLACE_BYTES);
    let (stored_text, cut_body) = cut_text(&text, RECORD_TEXT_BYTES);
    let mut record = json!({"where": stored_place, "text": stored_text});
    if cut_place || cut_body {
        record["truncated"] = json!(true);
    }
    if let Some(site) = site {
        record["site"] = json!(record_site(site.file(), site.line()));
    }
    let fields = match Fields::of(&record) {
        Ok(fields) => fields,
        Err(error) => {
            eprintln!(
                "event writer: the record {place:?} of {layer} cannot be serialized: {error}"
            );
            return;
        }
    };
    // events: host.record.<level>, sidecar.record.<level>
    store_event(parsed, layer, &name, place, Vec::new(), fields);
}

/// The site of a record, `<file name>:<line>` of the call that wrote it. The file name is the last component of the path, so the
/// site does not depend on the folder of the build.
fn record_site(file: &str, line: u32) -> String {
    let name = std::path::Path::new(file).file_name().map_or_else(
        || file.to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    format!("{name}:{line}")
}

/// Hands an event to the writer of the host, or to the start buffer while no writer exists. `place` names the record in the
/// reports of a refusal.
fn store_event(
    level: Level,
    layer: &str,
    name: &str,
    place: &str,
    cids: Vec<String>,
    fields: Fields,
) {
    let now = now_us();
    let mono_ns = monotonic_ns();
    let mut records = records();
    if let Some(log) = records.log.clone() {
        if let Err(error) = log.emit_relayed(RelayedEvent {
            ts_us: now,
            mono_ns,
            layer: layer.to_string(),
            page: None,
            start: None,
            level,
            event: name.to_string(),
            cids,
            fields,
        }) {
            eprintln!("event writer: the record {place:?} of {layer} cannot be stored: {error}");
        }
        return;
    }
    let size = fields.text.get().len() + name.len();
    if records.buffer.len() >= START_BUFFER_RECORDS
        || records.buffer_bytes + size > START_BUFFER_BYTES
    {
        let lost = &mut records.lost[channel_index(Channel::of(level))];
        lost.0 += 1;
        lost.1 += size as u64;
        return;
    }
    records.buffer_bytes += size;
    records.buffer.push(Buffered {
        ts_us: now,
        mono_ns,
        cids,
        layer: layer.to_string(),
        level,
        event: name.to_string(),
        fields,
    });
}

/// The fields of each record of event name that the start buffer holds, in the order of the buffer. The tests of the host read them
/// in place of a writer.
#[cfg(test)]
pub(crate) fn buffered_fields(name: &str) -> Vec<serde_json::Value> {
    records()
        .buffer
        .iter()
        .filter(|record| record.event == name)
        .map(|record| {
            serde_json::from_str(record.fields.text.get()).expect("a buffered record is JSON")
        })
        .collect()
}

/// The fields of each record of event name of surface that the start buffer holds, in the order of the buffer. The buffer holds
/// the records of every test of the binary, which run in parallel, so a test reads only the records of a surface of its own.
#[cfg(test)]
pub(crate) fn buffered_fields_of(name: &str, surface: &str) -> Vec<serde_json::Value> {
    buffered_fields(name)
        .into_iter()
        .filter(|fields| fields["surface"] == surface)
        .collect()
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
            ));
        }
    };
    let serde_json::Value::Object(mut fields) = fields else {
        return Err("the fields of an observation must be an object".into());
    };
    let event = match fields.remove("event") {
        Some(serde_json::Value::String(event)) if !event.is_empty() => event,
        _ => return Err("event must be a string".into()),
    };
    let text = Fields::of(&fields)
        .map_err(|error| format!("the fields of {event} cannot be serialized: {error}"))?;
    // events: host.trace.<event>, host.sampler.<event>, host.trace.surface.dispatch
    store_event(
        Level::Debug,
        "host",
        &format!("host.{kind}.{event}"),
        &event,
        Vec::new(),
        text,
    );
    Ok(())
}

/// Stores an event of the layer `host` with the level, the name `host.<subsystem>.<event>` and the fields. It is the entrance of
/// the sources of the host that are not records (docs/spec/logging.md#entrances). A name outside `host.` and fields
/// that cannot be serialized are reported on the standard error and nothing is stored.
pub fn emit_host(level: Level, event: &str, fields: serde_json::Value) {
    if !event.starts_with("host.") {
        eprintln!("event writer: the event {event:?} does not start with host.");
        return;
    }
    // The switch of the performance trace controls every event host.trace.<event> (docs/spec/performance-trace.md#the-switch).
    if event.starts_with("host.trace.") && !crate::performance::enabled() {
        return;
    }
    // A closed gate serializes nothing; an event the catalog does not declare has no class and no gate.
    if let Some(class) = soksak_sok::event_classes::class_of(event)
        && !soksak_sok::event_log::passes_every_gate(event)
        && !crate::log_policy::gate_event(class, level)
    {
        return;
    }
    match Fields::of(&fields) {
        // events: forwarded
        Ok(text) => store_event(level, "host", event, event, Vec::new(), text),
        Err(error) => {
            eprintln!("event writer: the fields of {event} cannot be serialized: {error}")
        }
    }
}

/// Stores the event `log.closed` of the host process that ends (docs/spec/logging.md#policy) with `cause` and the fields
/// beside it: the termination signal of the cause `signal`, the source of the cause `exit-request`.
pub fn emit_closed(cause: &str, fields: serde_json::Map<String, serde_json::Value>) {
    let log = records().log.clone();
    match log {
        Some(log) if log.record_closed(cause, fields) => {}
        Some(_) => {
            eprintln!("event writer: log.closed ({cause}) cannot be stored: the queue has no room")
        }
        None => eprintln!(
            "event writer: log.closed ({cause}) cannot be stored: the writer is not attached"
        ),
    }
}

/// The fields of the record `exit-request` that name where a quit came from (docs/spec/logging.md#policy).
pub type QuitSource = serde_json::Map<String, serde_json::Value>;

/// A quit that the host asked for itself: `request` is `quit-command`, `last-window-closed` or `update`.
pub fn host_quit_source(request: &str) -> QuitSource {
    let mut source = QuitSource::new();
    source.insert("source".into(), json!("host"));
    source.insert("request".into(), json!(request));
    source
}

/// A quit Apple event and the process that sent it, 0 when the event names none, with the bundle identifier or name of that
/// process while it runs, empty otherwise.
pub fn apple_event_quit_source(sender_pid: i32, sender: &str) -> QuitSource {
    let mut source = QuitSource::new();
    source.insert("source".into(), json!("apple-event"));
    if sender_pid > 0 {
        source.insert("sender_pid".into(), json!(sender_pid));
    }
    if !sender.is_empty() {
        source.insert("sender".into(), json!(sender));
    }
    source
}

/// A quit of the menu or a key equivalent, named by the type of its event (NSEventType), -1 without one.
pub fn menu_quit_source(event_type: i32) -> QuitSource {
    let mut source = QuitSource::new();
    source.insert("source".into(), json!("menu"));
    if event_type >= 0 {
        source.insert("event_type".into(), json!(event_type));
    }
    source
}

/// The source of the quit that the next exit request records; none when no part of the host asked for the quit.
static PENDING_QUIT: Mutex<Option<QuitSource>> = Mutex::new(None);

/// Holds `source` for the exit request that the quit of the caller leads to.
pub fn request_quit_source(source: QuitSource) {
    *PENDING_QUIT.lock().unwrap_or_else(PoisonError::into_inner) = Some(source);
}

/// Requests the end of the process for `cause` (docs/spec/logging.md#policy): the event `log.closed` names what
/// requested the end before `quit` runs, because `exit-request` alone does not, and the exit request that `quit` leads to
/// names `source`.
pub fn quit_with_cause(cause: &str, source: QuitSource, quit: impl FnOnce()) {
    emit_closed(cause, QuitSource::new());
    request_quit_source(source);
    quit();
}

/// Stores the termination signal and the process that sent it (0 when unknown), and runs the quit of host.quit for it after
/// it began the quit state; the exit request that `quit` leads to names the signal as its source.
pub fn quit_from_signal(
    state: &crate::quit::Quit,
    signal: i32,
    sender_pid: i32,
    quit: impl FnOnce(),
) {
    let mut fields = QuitSource::new();
    fields.insert("signal".into(), json!(signal));
    // The record of the signal is queued before quit runs, so it precedes the flush that the quit ends with.
    emit_closed("signal", fields.clone());
    fields.insert("source".into(), json!("signal"));
    if sender_pid > 0 {
        fields.insert("sender_pid".into(), json!(sender_pid));
    }
    request_quit_source(fields);
    // The quit that the signal requests is the quit of host.quit, so the quit state begins before quit runs; the end of a page
    // process during that quit is not an error (docs/spec/hosts.md#process-lifecycle).
    state.request(quit);
}

/// Stores the record `exit-request` with the source of the quit that the host asked for. A quit that no part of the host
/// asked for came from the menu or a key equivalent of the framework, and `event_type` reads the type of the current event,
/// -1 without one.
pub fn emit_exit_request(event_type: impl FnOnce() -> i32) {
    let pending = PENDING_QUIT
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    let source = pending.unwrap_or_else(|| menu_quit_source(event_type()));
    emit_closed("exit-request", source);
}

/// Stores an event of the layer `host` with the correlation identifiers of the inputs it belongs to, like `emit_host`. An
/// identifier that is not valid is reported on the standard error and nothing is stored.
pub fn emit_host_cids(level: Level, event: &str, cids: &[String], fields: serde_json::Value) {
    if !event.starts_with("host.") {
        eprintln!("event writer: the event {event:?} does not start with host.");
        return;
    }
    if let Some(bad) = cids.iter().find(|cid| !valid_cid(cid)) {
        eprintln!(
            "event writer: {event} has the correlation identifier {bad:?}, which is empty or holds a quote, a backslash or a control character"
        );
        return;
    }
    // The switch of the performance trace controls every event host.trace.<event> (docs/spec/performance-trace.md#the-switch).
    if event.starts_with("host.trace.") && !crate::performance::enabled() {
        return;
    }
    if let Some(class) = soksak_sok::event_classes::class_of(event)
        && !soksak_sok::event_log::passes_every_gate(event)
        && !crate::log_policy::gate_event(class, level)
    {
        return;
    }
    match Fields::of(&fields) {
        // events: forwarded
        Ok(text) => store_event(level, "host", event, event, cids.to_vec(), text),
        Err(error) => {
            eprintln!("event writer: the fields of {event} cannot be serialized: {error}")
        }
    }
}

/// Records that an image region event carrying correlation identifiers is relayed to the page: the event
/// `host.input.relay` with the `surface` and the `name` of the region and the `type` of the event, and the identifiers of
/// the event. `event_json` is the JSON text of the region event. An event without `cids` is not an input and stores
/// nothing; an event whose `cids` or `type` cannot be used is reported as a record of the host and stores no event.
pub fn record_input_relay(surface: &str, name: &str, event_json: &str) {
    let parsed: serde_json::Value = match serde_json::from_str(event_json) {
        Ok(parsed) => parsed,
        Err(error) => {
            crate::application_log::log_error(
                "input relay",
                format!("{surface}/{name}: the region event is not JSON: {error}"),
            );
            return;
        }
    };
    let Some(cids) = parsed.get("cids") else {
        return;
    };
    let cids: Option<Vec<String>> = cids.as_array().and_then(|items| {
        items
            .iter()
            .map(|item| {
                item.as_str()
                    .filter(|cid| valid_cid(cid))
                    .map(str::to_string)
            })
            .collect()
    });
    let kind = parsed.get("type").and_then(serde_json::Value::as_str);
    let (Some(cids), Some(kind)) = (cids.filter(|cids| !cids.is_empty()), kind) else {
        crate::application_log::log_error(
            "input relay",
            format!(
                "{surface}/{name}: the region event has cids that are not a list of identifiers or no type: {event_json}"
            ),
        );
        return;
    };
    emit_host_cids(
        Level::Info,
        "host.input.relay",
        &cids,
        json!({"surface": surface, "name": name, "type": kind}),
    );
}

/// Stores an event of the layer `host` like `emit_host`, waits until it is in the event log, and returns the boot
/// identifier of the log and the `seq` of the line, which together name the line. Without an attached writer the event has
/// no position, so it is an error.
pub fn emit_host_placed(
    level: Level,
    event: &str,
    fields: serde_json::Value,
) -> Result<(String, u64), String> {
    if !event.starts_with("host.") {
        return Err(format!("the event {event:?} does not start with host."));
    }
    let fields = Fields::of(&fields)
        .map_err(|error| format!("the fields of {event} cannot be serialized: {error}"))?;
    let log = records().log.clone();
    let Some(log) = log else {
        return Err("the event log of the host is not attached".to_string());
    };
    let seq = log.emit_placed_fields(level, event, fields)?;
    Ok((log.boot().to_string(), seq))
}

/// Waits until the records written so far are in the event log; the answer of the writer or its end ends the wait
/// (docs/spec/logging.md#writers). The paths that end the process (a panic
/// hook, a fatal handler) call it, so the record of the failure is stored before the process ends. Without an attached
/// writer there is nothing to wait for: the records wait in the start buffer, and the standard error holds the failure.
pub fn flush_records() -> Result<(), String> {
    let log = records().log.clone();
    match log {
        Some(log) => log.flush(),
        None => Ok(()),
    }
}
