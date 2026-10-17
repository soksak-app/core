//! The records of the host (docs/spec/logging.md#writers): an error or an observation of the host, and a record that the
//! page reports, are events `<layer>.record.<level>` with the fields `where` and `text`. A bounded start buffer holds the
//! records written before the writer exists and counts the records it refuses.

#[path = "support/records.rs"]
mod records;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use soksak_host_tauriv2::application_log::{log_error, log_info};
use soksak_host_tauriv2::event_log::{self, EventLog, Options};
use soksak_host_tauriv2::event_record::{
    START_BUFFER_RECORDS, flush_records, record_input_relay, use_host_event_log,
};
use soksak_host_tauriv2::performance;
use soksak_host_tauriv2::platform;

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

/// The events of a process: the lines of the main file at `path` and, when it exists, of the debug file beside it, in the order of
/// `seq` (the writer assigns `seq` across both files).
fn read(path: &Path) -> Vec<Value> {
    let parse = |path: &Path| -> Vec<Value> {
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    };
    let mut events = parse(path);
    let main = path.to_string_lossy();
    let debug = std::path::PathBuf::from(format!(
        "{}.debug.jsonl",
        main.strip_suffix(".jsonl").unwrap_or(&main)
    ));
    if debug.exists() {
        events.extend(parse(&debug));
        events.sort_by_key(|event| event["seq"].as_u64().unwrap());
    }
    events
}

fn start(directory: &Path, queue_events: usize) -> Arc<EventLog> {
    Arc::new(
        records::start_every_level(Options {
            directory: directory.to_path_buf(),
            role: "host".into(),
            boot: "b1".into(),
            queue_events,
            queue_bytes: 64 << 20,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    )
}

fn micros() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64
}

// contract: log.record.error-and-info-are-events
#[test]
fn an_error_and_an_observation_are_events_with_where_and_text() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    use_host_event_log(None);
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path(), 64);
    use_host_event_log(Some(Arc::clone(&log)));
    log_error("surface input", "the window has no content view");
    log_info("webkit children", "pid 7: gone");
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    use_host_event_log(None);
    let events = read(&path);
    let want = [
        (
            "error",
            "host",
            "host.record.error",
            "surface input",
            "the window has no content view",
        ),
        (
            "info",
            "host",
            "host.record.info",
            "webkit children",
            "pid 7: gone",
        ),
    ];
    assert_eq!(events.len(), 2 + want.len(), "{events:?}");
    for (index, (level, layer, event, place, text)) in want.iter().enumerate() {
        let got = &events[2 + index];
        assert_eq!(got["level"], *level, "{got}");
        assert_eq!(got["layer"], *layer, "{got}");
        assert_eq!(got["event"], *event, "{got}");
        assert_eq!(got["fields"]["where"], *place, "{got}");
        assert_eq!(got["fields"]["text"], *text, "{got}");
    }
}

// contract: log.record.start-buffer-holds-records-until-the-writer-exists
#[test]
fn records_written_before_the_writer_exists_are_stored_in_order_with_their_own_time() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    use_host_event_log(None);
    let before = micros();
    let mono_before = platform::current().unwrap().monotonic_ns().unwrap();
    log_error("early", "first");
    log_info("early", "second");
    let after = micros();
    let mono_after = platform::current().unwrap().monotonic_ns().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path(), 64);
    use_host_event_log(Some(Arc::clone(&log)));
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    use_host_event_log(None);
    let events = read(&path);
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[2]["fields"]["text"], "first");
    assert_eq!(events[3]["fields"]["text"], "second");
    for event in &events[2..] {
        let ts = event["ts_us"].as_u64().unwrap();
        assert!(
            (before..=after).contains(&ts),
            "ts_us {ts} is outside [{before}, {after}]: the record took the time of the attach"
        );
        let mono = event["mono_ns"].as_u64().unwrap();
        assert!(
            (mono_before..=mono_after).contains(&mono),
            "mono_ns {mono} is outside [{mono_before}, {mono_after}]: the record took the clock of the attach"
        );
    }
}

// contract: log.record.start-buffer-counts-its-loss
#[test]
fn the_start_buffer_refuses_records_beyond_its_bound_and_the_writer_counts_them() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    use_host_event_log(None);
    let extra = 6;
    for _ in 0..START_BUFFER_RECORDS + extra {
        log_info("flood", "record");
    }
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path(), 4 * START_BUFFER_RECORDS);
    use_host_event_log(Some(Arc::clone(&log)));
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(10)).unwrap();
    use_host_event_log(None);
    let events = read(&path);
    let stored = events
        .iter()
        .filter(|event| event["event"] == "host.record.info")
        .count();
    let dropped: u64 = events
        .iter()
        .filter(|event| event["event"] == "log.dropped")
        .map(|event| event["fields"]["count"].as_u64().unwrap())
        .sum();
    let others: Vec<&Value> = events
        .iter()
        .filter(|event| {
            !["host.record.info", "log.dropped", "log.open"]
                .contains(&event["event"].as_str().unwrap_or(""))
        })
        .collect();
    assert_eq!(
        stored, START_BUFFER_RECORDS,
        "the other events of the buffer: {others:?}"
    );
    assert_eq!(dropped, extra as u64);
}

// contract: log.record.flush-stores-the-records-written-so-far
#[test]
fn flush_records_stores_the_records_written_so_far_without_waiting_for_the_batch_interval() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    use_host_event_log(None);
    assert_eq!(flush_records(Duration::from_secs(1)), Ok(()));
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        records::start_every_level(Options {
            directory: directory.path().to_path_buf(),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 64,
            queue_bytes: 64 << 20,
            batch_interval: Duration::from_secs(30),
            rotate_bytes: 1 << 30,
            pull: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    );
    use_host_event_log(Some(Arc::clone(&log)));
    log_info("flush", "stored before the interval");
    flush_records(Duration::from_secs(5)).unwrap();
    let events = read(log.path());
    use_host_event_log(None);
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(events[2]["fields"]["text"], "stored before the interval");
}

// contract: performance.trace.host-observation-is-an-event
#[test]
fn a_host_observation_of_the_trace_is_an_event() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    use_host_event_log(None);
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path(), 64);
    use_host_event_log(Some(Arc::clone(&log)));
    performance::command(json!({"action": "on"})).unwrap();
    performance::observe(
        "host",
        || json!({"event": "region", "surface": "tab-1", "body": {"key": "Enter"}}),
    );
    performance::observe("sampler", || json!({"event": "memory", "rss_host_kb": 42}));
    performance::observe("host", || json!({"surface": "tab-1"}));
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    performance::command(json!({"action": "off"})).unwrap();
    use_host_event_log(None);
    let events = read(&path);
    // The sampler that `on` starts stores its own events into the same writer, so the events are found by name.
    let named = |name: &str, accept: &dyn Fn(&Value) -> bool| -> Value {
        events
            .iter()
            .find(|event| event["event"] == name && accept(event))
            .unwrap_or_else(|| panic!("no {name} in {events:?}"))
            .clone()
    };
    let region = named("host.trace.region", &|_| true);
    let memory = named("host.sampler.memory", &|event| {
        event["fields"]["rss_host_kb"] == 42
    });
    let refused = named("host.record.error", &|event| {
        event["fields"]["where"] == "performance trace"
    });
    assert_eq!(region["event"], "host.trace.region", "{region}");
    assert_eq!(region["layer"], "host");
    assert_eq!(region["level"], "debug");
    assert_eq!(region["fields"]["surface"], "tab-1");
    assert_eq!(region["fields"]["body"]["key"], "Enter");
    assert!(region["fields"].get("event").is_none(), "{region}");
    assert_eq!(memory["event"], "host.sampler.memory");
    assert_eq!(memory["fields"]["rss_host_kb"], 42);
    assert_eq!(
        refused["event"], "host.record.error",
        "an observation without a name was not reported: {refused}"
    );
}

// contract: log.input.region-event-with-cids-is-recorded
#[test]
fn a_region_event_with_cids_is_recorded_as_the_relay_of_an_input() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    use_host_event_log(None);
    let directory = tempfile::tempdir().unwrap();
    let log = start(directory.path(), 64);
    use_host_event_log(Some(Arc::clone(&log)));
    record_input_relay(
        "tab-1",
        "view",
        r#"{"type":"key","key":"Enter","cids":["b1.4","b1.5"]}"#,
    );
    record_input_relay("tab-1", "view", r#"{"type":"focus","focused":true}"#);
    record_input_relay("tab-1", "view", r#"{"type":"key","cids":"b1.6"}"#);
    record_input_relay("tab-1", "view", r#"{"cids":["b1.7"]}"#);
    record_input_relay("tab-1", "view", r#"{"type":"key","cids":["b1.\"8"]}"#);
    record_input_relay("tab-1", "view", "{broken");
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    use_host_event_log(None);
    let events = read(&path);
    let relays: Vec<&Value> = events
        .iter()
        .filter(|event| event["event"] == "host.input.relay")
        .collect();
    assert_eq!(relays.len(), 1, "{events:?}");
    assert_eq!(relays[0]["level"], "info");
    assert_eq!(relays[0]["layer"], "host");
    assert_eq!(relays[0]["cids"], json!(["b1.4", "b1.5"]));
    assert_eq!(
        relays[0]["fields"],
        json!({"surface": "tab-1", "name": "view", "type": "key"})
    );
    // An event with identifiers that cannot be recorded is reported, and nothing is recorded in its place.
    let errors = events
        .iter()
        .filter(|event| event["event"] == "host.record.error")
        .count();
    assert_eq!(errors, 4, "{events:?}");
}
