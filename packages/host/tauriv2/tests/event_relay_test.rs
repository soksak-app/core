//! The `log` call of the page (docs/spec/logging.md#writers): the page relays a batch of events, the host validates the
//! whole batch before it writes any event, and every event of the batch is stored in the layer `page`.

use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
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
    EventLog::start(Options {
        directory: directory.to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1 << 30,
        generations: 5,
        pull: None,
        pull_loss: None,
    })
    .unwrap()
}

fn event(name: &str, index: u64) -> Value {
    json!({"ts_us": 1_791_000_000_000_000u64 + index, "level": "info", "event": name, "fields": {"index": index}})
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
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(events[1]["event"], "page.test.first");
    assert_eq!(events[2]["event"], "page.test.second");
    assert_eq!(events[1]["layer"], "page");
    assert_eq!(events[2]["ts_us"], 1_791_000_000_000_002u64);
}

// contract: log.batch.rejects-an-invalid-batch-without-writing
#[test]
fn an_invalid_relayed_batch_writes_nothing_and_names_the_event() {
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path());
    let bad = |field: &str, value: Value| {
        let mut item =
            json!({"ts_us": 1, "level": "info", "event": "page.test.event", "fields": {}});
        item[field] = value;
        json!({"action": "batch", "events": [item]})
    };
    let cases: Vec<(&str, Value, &str)> = vec![
        ("no action", json!({"events": []}), "action must be batch"),
        (
            "another action",
            json!({"action": "line", "events": []}),
            "action must be batch, not \"line\"",
        ),
        (
            "no events",
            json!({"action": "batch"}),
            "events must be an array",
        ),
        (
            "a layer other than page",
            json!({"action": "batch", "events": [event("page.test.ok", 1), event("host.test.forged", 2)]}),
            "events[1]: the event \"host.test.forged\" does not start with its layer \"page\"",
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
    assert_eq!(read(&path).len(), 1, "an invalid batch wrote events");
}

// contract: log.batch.returns-the-transcript-lines-of-page-records
#[test]
fn a_relayed_batch_returns_the_transcript_lines_of_its_page_records() {
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path());
    let record = |level: &str, place: &str, text: &str, index: u64| {
        json!({"ts_us": 1_791_000_000_000_000u64 + index, "level": level, "event": format!("page.record.{level}"),
               "fields": {"where": place, "text": text}})
    };
    let request = json!({"action": "batch", "events": [
        record("error", "surface probe", "mount failed\nsecond line", 1),
        event("page.trace.action", 2),
        record("info", "page", "ready", 3),
    ]});
    let lines = log_command(&log, request).unwrap();
    assert_eq!(
        lines,
        [
            "error page surface probe: mount failed\\nsecond line",
            "info page page: ready"
        ]
    );
    let bad = json!({"action": "batch", "events": [
        {"ts_us": 1, "level": "info", "event": "page.record.info", "fields": {"where": 7}}
    ]});
    let error = log_command(&log, bad).unwrap_err();
    assert!(
        error.contains("events[0]: fields where and text must be strings"),
        "{error}"
    );
}
