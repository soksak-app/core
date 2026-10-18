//! The `log` call of the page (docs/spec/logging.md#writers): the page relays a batch of events, the host validates the
//! whole batch before it writes any event, and every event of the batch is stored in the layer `page`.

#[path = "support/records.rs"]
mod records;
use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use soksak_host_tauriv2::event_log::{EventLog, Options};
use soksak_host_tauriv2::event_relay::log_command;

fn read(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn start(directory: &Path) -> EventLog {
    records::start_every_level(Options {
        directory: directory.to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1 << 30,
        pull: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: 1 << 40,
    })
    .unwrap()
}

fn event(name: &str, index: u64) -> Value {
    json!({"ts_us": 1_791_000_000_000_000u64 + index, "mono_ns": 5_000_000_000u64 + index, "level": "info", "event": name, "page": "1791948729050", "fields": {"index": index}})
}

// contract: log.batch.stores-page-events-in-order
#[test]
fn a_relayed_batch_is_stored_in_order_in_the_layer_page() {
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path());
    let request = json!({"action": "batch", "events": [event("page.test.first", 1), event("page.test.second", 2)]});
    log_command(&log, request).unwrap();
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[2]["event"], "page.test.first");
    assert_eq!(events[3]["event"], "page.test.second");
    assert_eq!(events[2]["layer"], "page");
    assert_eq!(events[3]["ts_us"], 1_791_000_000_000_002u64);
}

// contract: log.batch.rejects-an-invalid-batch-without-writing, log.batch.requires-the-page
#[test]
fn an_invalid_relayed_batch_writes_nothing_and_names_the_event() {
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path());
    let bad = |field: &str, value: Value| {
        let mut item = json!({"ts_us": 1, "mono_ns": 1, "level": "info", "event": "page.test.event", "page": "1791948729050", "fields": {}});
        item[field] = value;
        json!({"action": "batch", "events": [item]})
    };
    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "no action",
            json!({"events": []}),
            "action must be batch, clock, policy or policy-read",
        ),
        (
            "another action",
            json!({"action": "line", "events": []}),
            "action must be batch, clock, policy or policy-read, not \"line\"",
        ),
        (
            "an event that names no page",
            bad("page", Value::Null),
            "events[0]: page must name the document that wrote the event",
        ),
        (
            "no clock",
            bad("mono_ns", json!(0)),
            "events[0]: mono_ns must be a positive integer",
        ),
        (
            "a clock that is text",
            bad("mono_ns", json!("now")),
            "events[0]: mono_ns must be a positive integer",
        ),
        (
            "cids that are not a list",
            bad("cids", json!("b1.1")),
            "events[0]: cids must be an array of non-empty strings without a quote, a backslash or a control character",
        ),
        (
            "an identifier with a quote",
            bad("cids", json!(["b1.\"1"])),
            "events[0]: cids must be an array of non-empty strings without a quote, a backslash or a control character",
        ),
        (
            "an empty identifier",
            bad("cids", json!([""])),
            "events[0]: cids must be an array of non-empty strings without a quote, a backslash or a control character",
        ),
        (
            "an identifier that is a number",
            bad("cids", json!([7])),
            "events[0]: cids must be an array of non-empty strings without a quote, a backslash or a control character",
        ),
        (
            "no events",
            json!({"action": "batch"}),
            "events must be an array",
        ),
        (
            "a layer other than page",
            json!({"action": "batch", "events": [event("page.test.ok", 1), event("host.test.forged", 2)]}),
            "events[1]: the event \"host.test.forged\" does not start with page. or plugin.",
        ),
        (
            "a level outside the contract",
            bad("level", json!("loud")),
            "events[0]: level must be one of error, warn, info, debug, trace",
        ),
        (
            "a time that is not a number",
            bad("ts_us", json!("now")),
            "events[0]: ts_us must be a positive integer",
        ),
        (
            "fields that are not an object",
            bad("fields", json!("text")),
            "events[0]: fields must be an object",
        ),
    ];
    for (name, request, message) in cases {
        let error = log_command(&log, request).unwrap_err();
        assert!(
            error.contains(message),
            "{name}: {error:?}, want {message:?}"
        );
    }
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    assert_eq!(read(&path).len(), 2, "an invalid batch wrote events");
}

// contract: log.batch.returns-the-transcript-lines-of-page-records
#[test]
fn a_relayed_batch_returns_the_transcript_lines_of_its_page_records() {
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path());
    let record = |level: &str, place: &str, text: &str, index: u64| {
        json!({"ts_us": 1_791_000_000_000_000u64 + index, "mono_ns": 5_000_000_000u64 + index, "level": level, "event": format!("page.record.{level}"), "page": "1791948729050",
               "fields": {"where": place, "text": text}})
    };
    let request = json!({"action": "batch", "events": [
        record("error", "surface probe", "mount failed\nsecond line", 1),
        event("page.trace.action", 2),
        record("info", "page", "ready", 3),
    ]});
    let lines = log_command(&log, request).unwrap().lines;
    assert_eq!(
        lines,
        [
            "error page surface probe: mount failed\\nsecond line",
            "info page page: ready"
        ]
    );
    let bad = json!({"action": "batch", "events": [
        {"ts_us": 1, "mono_ns": 1, "level": "info", "event": "page.record.info", "page": "1791948729050", "fields": {"where": 7}}
    ]});
    let error = log_command(&log, bad).unwrap_err();
    assert!(
        error.contains("events[0]: fields where and text must be strings"),
        "{error}"
    );
}

// contract: log.batch.stores-clock-and-cids-of-page-events
#[test]
fn a_relayed_batch_stores_the_clock_and_the_cids_that_the_page_gave() {
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path());
    let mut with = event("page.test.input", 1);
    with["cids"] = json!(["b1.4", "b1.5"]);
    let request = json!({"action": "batch", "events": [with, event("page.test.plain", 2)]});
    log_command(&log, request).unwrap();
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[2]["mono_ns"], 5_000_000_001u64);
    assert_eq!(events[2]["cids"], json!(["b1.4", "b1.5"]));
    assert_eq!(events[3]["mono_ns"], 5_000_000_002u64);
    assert!(events[3].get("cids").is_none(), "{}", events[3]);
}

// contract: log.batch.answers-the-clock-request
#[test]
fn the_clock_request_answers_both_clocks_of_the_host_and_stores_no_event() {
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path());
    let first = log_command(&log, json!({"action": "clock"}))
        .unwrap()
        .clock
        .unwrap();
    let second = log_command(&log, json!({"action": "clock"}))
        .unwrap()
        .clock
        .unwrap();
    assert!(first.ts_us > 1_700_000_000_000_000 && first.mono_ns > 0);
    assert!(second.ts_us >= first.ts_us && second.mono_ns >= first.mono_ns);
    assert!(
        log_command(&log, json!({"action": "clock"}))
            .unwrap()
            .lines
            .is_empty()
    );
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    assert_eq!(read(&path).len(), 2, "a clock request stored an event");
}

// contract: log.batch.stores-plugin-events-in-the-layer-plugin
#[test]
fn a_relayed_batch_stores_a_plugin_event_in_the_layer_plugin() {
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path());
    let request = json!({"action": "batch", "events": [event("plugin.fixture.input", 1), event("page.console.error", 2)]});
    log_command(&log, request).unwrap();
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[2]["layer"], "plugin");
    assert_eq!(events[2]["event"], "plugin.fixture.input");
    assert_eq!(events[3]["layer"], "page");
}
