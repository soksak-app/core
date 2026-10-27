//! The `log` call of the page (docs/spec/logging.md#writers): the page relays a batch of events, the host validates the
//! whole batch before it writes any event, and every event of the batch is stored in the layer `page`.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;
use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use soksak_host_tauriv2::event_log::{EventLog, Options};
use soksak_host_tauriv2::event_relay::{log_command, view_log_command};

fn read(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn start(directory: &Path) -> EventLog {
    start_with_queue_bytes(directory, 64 * 1024)
}

fn start_with_queue_bytes(directory: &Path, queue_bytes: usize) -> EventLog {
    records::start_every_level(Options {
        directory: directory.to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 64,
        queue_bytes,
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
    let directory = folder::Folder::new();
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
    let directory = folder::Folder::new();
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
    let directory = folder::Folder::new();
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
    let directory = folder::Folder::new();
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
    let directory = folder::Folder::new();
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
    let directory = folder::Folder::new();
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

// contract: log.view-batch.binds-ready-page-and-native-surface
#[test]
fn a_view_batch_is_bound_to_its_ready_page_plugin_and_surface() {
    let directory = folder::Folder::new();
    let log = start(directory.path());
    let request = json!({"action": "batch", "events": [
        {"ts_us": 1_791_000_000_000_001u64, "mono_ns": 5_000_000_001u64, "level": "info", "event": "page.start", "page": "1791948729050.5", "fields": {"time_origin": 1791948729050.5, "url": "soksak://probe/"}},
        {"ts_us": 1_791_000_000_000_002u64, "mono_ns": 5_000_000_002u64, "level": "info", "event": "plugin.probe.saved", "page": "1791948729050.5", "fields": {"value": 7}}
    ]});

    assert_eq!(
        view_log_command(&log, request, "probe", "surface-1", "1791948729050.5").unwrap(),
        Value::Null
    );
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[2]["page"], "1791948729050.5");
    assert_eq!(events[2]["event"], "page.start");
    assert_eq!(events[3]["layer"], "plugin");
    assert_eq!(events[3]["event"], "plugin.probe.saved");
    assert_eq!(events[3]["page"], "1791948729050.5");
    assert_eq!(events[3]["fields"]["surface"], "surface-1");
}

// contract: log.view-batch.rejects-foreign-source-without-partial-write
#[test]
fn a_view_batch_rejects_a_foreign_source_without_writing_earlier_events() {
    let directory = folder::Folder::new();
    let log = start(directory.path());
    let request = json!({"action": "batch", "events": [
        {"ts_us": 1, "mono_ns": 1, "level": "info", "event": "plugin.probe.saved", "page": "1791948729050.5", "fields": {}},
        {"ts_us": 2, "mono_ns": 2, "level": "info", "event": "plugin.probe.other", "page": "1791948729051.5", "fields": {}}
    ]});
    let error =
        view_log_command(&log, request, "probe", "surface-1", "1791948729050.5").unwrap_err();
    assert!(
        error.contains("events[1]: page \"1791948729051.5\" does not match the ready view page"),
        "{error}"
    );
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    assert_eq!(read(&path).len(), 2, "a rejected view batch wrote records");
}

// contract: log.view-batch-requires-page-start-to-match-ready-origin
#[test]
fn a_view_batch_rejects_a_page_start_for_another_time_origin_without_partial_write() {
    let directory = folder::Folder::new();
    let log = start(directory.path());
    let request = json!({"action": "batch", "events": [
        {"ts_us": 1, "mono_ns": 1, "level": "info", "event": "plugin.probe.saved", "page": "1791948729050.5", "fields": {}},
        {"ts_us": 2, "mono_ns": 2, "level": "info", "event": "page.start", "page": "1791948729050.5", "fields": {"time_origin": 1791948729051.5, "url": "soksak://probe/"}}
    ]});
    let error =
        view_log_command(&log, request, "probe", "surface-1", "1791948729050.5").unwrap_err();
    assert!(
        error.contains("page.start time_origin 1791948729051.5 does not match ready page"),
        "{error}"
    );
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    assert_eq!(read(&path).len(), 2, "a rejected view batch wrote records");
}

// contract: log.view-batch-requires-a-nonempty-page-start-url
#[test]
fn a_view_batch_rejects_an_empty_page_start_url_without_partial_write() {
    let directory = folder::Folder::new();
    let log = start(directory.path());
    let request = json!({"action": "batch", "events": [
        {"ts_us": 1, "mono_ns": 1, "level": "info", "event": "plugin.probe.saved", "page": "1791948729050.5", "fields": {}},
        {"ts_us": 2, "mono_ns": 2, "level": "info", "event": "page.start", "page": "1791948729050.5", "fields": {"time_origin": 1791948729050.5, "url": ""}}
    ]});
    let error =
        view_log_command(&log, request, "probe", "surface-1", "1791948729050.5").unwrap_err();
    assert!(
        error.contains("events[1]: page.start url must be non-empty text"),
        "{error}"
    );
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    assert_eq!(read(&path).len(), 2, "a rejected view batch wrote records");
}

// contract: log.view-batch-refuses-a-caller-supplied-surface
#[test]
fn a_view_batch_refuses_a_plugin_surface_field_instead_of_trusting_it() {
    let directory = folder::Folder::new();
    let log = start(directory.path());
    let request = json!({"action": "batch", "events": [
        {"ts_us": 1, "mono_ns": 1, "level": "info", "event": "plugin.probe.saved", "page": "1791948729050.5", "fields": {"surface": "surface-1"}}
    ]});
    let error =
        view_log_command(&log, request, "probe", "surface-1", "1791948729050.5").unwrap_err();
    assert!(error.contains("cannot set its owning surface"), "{error}");
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    assert_eq!(read(&path).len(), 2, "a refused view batch wrote records");
}

// contract: log.view-batch-rejects-a-foreign-plugin-prefix
#[test]
fn a_view_batch_rejects_an_event_with_another_plugin_prefix() {
    let directory = folder::Folder::new();
    let log = start(directory.path());
    let request = json!({"action": "batch", "events": [
        {"ts_us": 1, "mono_ns": 1, "level": "info", "event": "plugin.other.saved", "page": "1791948729050.5", "fields": {}}
    ]});
    let error =
        view_log_command(&log, request, "probe", "surface-1", "1791948729050.5").unwrap_err();
    assert!(
        error.contains("event \"plugin.other.saved\" is not allowed for plugin \"probe\""),
        "{error}"
    );
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    assert_eq!(read(&path).len(), 2, "a rejected view batch wrote records");
}

// contract: log.view-batch-bounds-fields-after-surface-injection
#[test]
fn a_view_batch_keeps_injected_plugin_fields_within_the_page_bound() {
    let directory = folder::Folder::new();
    let log = start_with_queue_bytes(directory.path(), 256 * 1024);
    let fields = json!({"payload": "x".repeat(65_520)});
    let raw_size = serde_json::to_vec(&fields).unwrap().len();
    let mut injected = fields.clone();
    injected["surface"] = json!("surface-1");
    let injected_size = serde_json::to_vec(&injected).unwrap().len();
    assert!(
        raw_size < 65_536,
        "fixture fields already exceed the page bound: {raw_size}"
    );
    assert!(
        injected_size > 65_536,
        "fixture injection did not cross the page bound: {injected_size}"
    );
    let request = json!({"action": "batch", "events": [
        {"ts_us": 1, "mono_ns": 1, "level": "info", "event": "plugin.probe.large", "page": "1791948729050.5", "fields": fields}
    ]});

    view_log_command(&log, request, "probe", "surface-1", "1791948729050.5").unwrap();
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    let stored_fields = &events[2]["fields"];
    let stored_size = serde_json::to_vec(stored_fields).unwrap().len();
    assert!(
        stored_size <= 65_536,
        "host surface injection exceeded the page's 65,536-byte fields bound: raw {raw_size}, injected {injected_size}, stored {stored_size}"
    );
    assert_eq!(
        stored_fields["truncated"],
        true,
        "stored fields lack the page truncation marker: raw {raw_size}, injected {injected_size}, stored {stored_size}, event truncated {:?}, fields keys {:?}",
        events[2]["truncated"],
        stored_fields
            .as_object()
            .map(|fields| fields.keys().collect::<Vec<_>>())
    );
    assert_eq!(stored_fields["surface"], "surface-1");
    let head = stored_fields["head"].as_str().unwrap();
    assert!(head.len() <= 4_096);
    assert!(head.starts_with("{\"payload\":\""));
    assert!(!head.contains("surface-1"));
}

// contract: log.view-request-accepts-only-declared-clock-and-batch-fields
#[test]
fn a_view_log_rejects_unknown_clock_and_batch_request_fields() {
    let requests = [
        (
            json!({"action": "clock", "unexpected": true}),
            "runtime.log clock request accepts only action",
        ),
        (
            json!({"action": "batch", "events": [
                {"ts_us": 1, "mono_ns": 1, "level": "info", "event": "plugin.probe.saved", "page": "1791948729050.5", "fields": {}}
            ], "unexpected": true}),
            "runtime.log batch request accepts only action and events",
        ),
    ];
    let mut outcomes = Vec::new();
    for (request, _) in &requests {
        let directory = folder::Folder::new();
        let log = start(directory.path());
        let result = view_log_command(
            &log,
            request.clone(),
            "probe",
            "surface-1",
            "1791948729050.5",
        );
        let path = log.path().to_path_buf();
        log.flush(Duration::from_secs(5)).unwrap();
        outcomes.push((result.err(), read(&path).len()));
    }
    let expected: Vec<_> = requests
        .iter()
        .map(|(_, error)| (Some((*error).to_string()), 2))
        .collect();
    assert_eq!(outcomes, expected);
}

// contract: log.view-clock-answers-without-policy-or-event-write
#[test]
fn a_view_clock_answers_without_accepting_policy_or_writing_records() {
    let directory = folder::Folder::new();
    let log = start(directory.path());
    let clock = view_log_command(
        &log,
        json!({"action": "clock"}),
        "probe",
        "surface-1",
        "1791948729050.5",
    )
    .unwrap();
    assert!(clock["ts_us"].as_u64().unwrap() > 1_700_000_000_000_000);
    assert!(clock["mono_ns"].as_u64().unwrap() > 0);
    assert!(
        view_log_command(
            &log,
            json!({"action": "policy-read"}),
            "probe",
            "surface-1",
            "1791948729050.5",
        )
        .unwrap_err()
        .contains("action must be batch or clock")
    );
    assert!(
        view_log_command(
            &log,
            json!({"level": "info", "event": "plugin.probe.saved", "fields": {}}),
            "probe",
            "surface-1",
            "1791948729050.5",
        )
        .unwrap_err()
        .contains("action must be batch or clock")
    );
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    assert_eq!(read(&path).len(), 2, "a view clock request wrote a record");
}
