//! The pull of the native ring (docs/spec/logging.md#writers): the writer of the host takes the records of the native
//! library at its batch interval, stores them in the layer `native` with the time the library gave, and counts the records
//! it refuses and the events the ring refused.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use soksak_host_tauriv2::event_log::{Channel, EventLog, Options};

/// A record of the class call as the native library drains it; the names of the tests that use it are not in the catalog.
fn native_record(ts: u64, level: u8, name: &str, fields: &str) -> Vec<u8> {
    native_record_with(ts, ts % 1_000_000 + 9_000, level, "", name, fields)
}

fn native_record_with(
    ts: u64,
    mono: u64,
    level: u8,
    cids: &str,
    name: &str,
    fields: &str,
) -> Vec<u8> {
    native_record_of_class(ts, mono, level, 2, cids, name, fields)
}

/// A record as the native library drains it: a 4-byte length, then the wall clock (8 bytes), the monotonic clock (8), the
/// level (1 byte), the class (1 byte), the length of the name (1 byte), the length of the cids (2), the name, the cids as a list
/// separated by commas and the fields, in the byte order of the host.
fn native_record_of_class(
    ts: u64,
    mono: u64,
    level: u8,
    class: u8,
    cids: &str,
    name: &str,
    fields: &str,
) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&ts.to_ne_bytes());
    body.extend_from_slice(&mono.to_ne_bytes());
    body.push(level);
    body.push(class);
    body.push(name.len() as u8);
    body.extend_from_slice(&(cids.len() as u16).to_ne_bytes());
    body.extend_from_slice(name.as_bytes());
    body.extend_from_slice(cids.as_bytes());
    body.extend_from_slice(fields.as_bytes());
    let mut record = (body.len() as u32).to_ne_bytes().to_vec();
    record.extend_from_slice(&body);
    record
}

/// The ring of a test: its bytes are handed out once, as the drain of the native ring does, and its loss is reported once.
#[derive(Default)]
struct FakeRing {
    bytes: Vec<u8>,
    loss_events: u64,
    loss_bytes: u64,
    debug_events: u64,
    debug_bytes: u64,
}

fn read(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn start(directory: &Path, ring: &Arc<Mutex<FakeRing>>, interval: Duration) -> EventLog {
    let pull_ring = Arc::clone(ring);
    let loss_ring = Arc::clone(ring);
    records::start_every_level(Options {
        directory: directory.to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: interval,
        rotate_bytes: 1 << 30,
        pull: Some(Box::new(move |buffer: &mut [u8]| {
            let mut ring = pull_ring.lock().unwrap();
            let n = ring.bytes.len().min(buffer.len());
            buffer[..n].copy_from_slice(&ring.bytes[..n]);
            ring.bytes.drain(..n);
            Ok(n)
        })),
        pull_loss: Some(Box::new(move |channel| {
            let mut ring = loss_ring.lock().unwrap();
            match channel {
                Channel::Debug => (
                    std::mem::take(&mut ring.debug_events),
                    std::mem::take(&mut ring.debug_bytes),
                ),
                Channel::Other => (
                    std::mem::take(&mut ring.loss_events),
                    std::mem::take(&mut ring.loss_bytes),
                ),
            }
        })),
        policy_path: None,
        retention_bytes: 1 << 40,
    })
    .unwrap()
}

// contract: log.native.stores-pulled-records-in-the-layer-native
#[test]
fn the_writer_stores_pulled_native_records_in_the_layer_native() {
    let ring = Arc::new(Mutex::new(FakeRing {
        bytes: [
            native_record(
                1_791_000_000_000_001,
                1,
                "native.test.first",
                r#"{"index":1}"#,
            ),
            native_record(1_791_000_000_000_002, 0, "native.test.second", "{}"),
        ]
        .concat(),
        ..FakeRing::default()
    }));
    let directory = folder::Folder::new();
    let log = start(directory.path(), &ring, Duration::from_millis(20));
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[2]["event"], "native.test.first");
    assert_eq!(events[3]["event"], "native.test.second");
    assert_eq!(events[2]["layer"], "native");
    assert_eq!(events[2]["ts_us"], 1_791_000_000_000_001u64);
    assert_eq!(events[2]["mono_ns"], 9_001u64);
    assert!(events[2].get("cids").is_none());
    assert_eq!(events[2]["level"], "warn");
    assert_eq!(events[2]["seq"], 3);
    assert_eq!(events[2]["fields"]["index"], 1);
    assert_eq!(events[3]["level"], "error");
}

// contract: log.native.counts-refused-records-and-ring-loss
#[test]
fn a_refused_native_record_and_the_loss_of_the_ring_are_counted_as_dropped() {
    let mut truncated = native_record(1_791_000_000_000_005, 2, "native.test.cut", r#"{"a":1}"#);
    truncated[..4].copy_from_slice(&500u32.to_ne_bytes());
    let ring = Arc::new(Mutex::new(FakeRing {
        bytes: [
            native_record(1_791_000_000_000_001, 2, "native.test.ok", "{}"),
            native_record(1_791_000_000_000_002, 2, "host.test.forged", "{}"),
            native_record(1_791_000_000_000_003, 2, "native.test.fields", "{broken"),
            native_record(1_791_000_000_000_004, 9, "native.test.level", "{}"),
            native_record_with(
                1_791_000_000_000_006,
                5,
                2,
                "b1.\"1",
                "native.test.cid",
                "{}",
            ),
            native_record_with(
                1_791_000_000_000_007,
                5,
                2,
                "b1.1,,b1.2",
                "native.test.cid",
                "{}",
            ),
            native_record_with(1_791_000_000_000_008, 0, 2, "", "native.test.clock", "{}"),
            native_record_of_class(
                1_791_000_000_000_009,
                5_000_000_009,
                2,
                9,
                "",
                "native.test.class",
                "{}",
            ),
            // A declared event whose record gives another class than the catalog is a defect of the producer and is refused.
            native_record_of_class(
                1_791_000_000_000_010,
                5_000_000_010,
                2,
                0,
                "",
                "native.input.source_changed",
                "{}",
            ),
            truncated,
        ]
        .concat(),
        loss_events: 3,
        loss_bytes: 120,
        debug_events: 2,
        debug_bytes: 40,
    }));
    let directory = folder::Folder::new();
    let log = start(directory.path(), &ring, Duration::from_millis(20));
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    let stored = events
        .iter()
        .filter(|event| event["event"] == "native.test.ok")
        .count();
    let dropped = |reason: &str, channel: &str| -> u64 {
        events
            .iter()
            .filter(|event| {
                event["event"] == "log.dropped"
                    && event["fields"]["reason"] == reason
                    && event["fields"]["channel"] == channel
            })
            .map(|event| event["fields"]["count"].as_u64().unwrap())
            .sum()
    };
    assert_eq!(stored, 1, "{events:?}");
    // The loss of the ring names the channel of the refused events; a record that cannot be decoded has no level and is counted in
    // the channel other.
    assert_eq!(
        dropped("the native ring was full", "other"),
        3,
        "{events:?}"
    );
    assert_eq!(
        dropped("the native ring was full", "debug"),
        2,
        "{events:?}"
    );
    assert_eq!(
        dropped("a native record was refused", "other"),
        9,
        "{events:?}"
    );
}

// contract: log.native.stores-the-class-of-a-pulled-record
#[test]
fn a_pulled_native_record_of_a_declared_event_stores_the_catalog_class_and_an_undeclared_one_stores_none()
 {
    let ring = Arc::new(Mutex::new(FakeRing {
        bytes: [
            native_record_of_class(
                1_791_000_000_000_001,
                5_000_000_001,
                2,
                1,
                "",
                "native.input.source_changed",
                "{}",
            ),
            native_record_of_class(
                1_791_000_000_000_002,
                5_000_000_002,
                2,
                1,
                "",
                "native.test.surprise",
                "{}",
            ),
        ]
        .concat(),
        ..FakeRing::default()
    }));
    let directory = folder::Folder::new();
    let log = start(directory.path(), &ring, Duration::from_millis(20));
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[2]["class"], "input");
    assert!(events[2].get("undeclared").is_none());
    assert_eq!(events[3]["undeclared"], true);
    assert!(events[3].get("class").is_none());
}

// contract: log.native.stores-clock-and-cids-of-pulled-records
#[test]
fn a_pulled_native_record_keeps_its_clock_and_cids() {
    let ring = Arc::new(Mutex::new(FakeRing {
        bytes: [
            native_record_with(
                1_791_000_000_000_001,
                77_000_000_001,
                2,
                "b1.4,b1.5",
                "native.test.input",
                r#"{"k":1}"#,
            ),
            native_record_with(
                1_791_000_000_000_002,
                77_000_000_002,
                2,
                "",
                "native.test.plain",
                "{}",
            ),
        ]
        .concat(),
        ..FakeRing::default()
    }));
    let directory = folder::Folder::new();
    let log = start(directory.path(), &ring, Duration::from_millis(20));
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[2]["mono_ns"], 77_000_000_001u64);
    assert_eq!(events[2]["cids"], serde_json::json!(["b1.4", "b1.5"]));
    assert_eq!(events[2]["fields"]["k"], 1);
    assert_eq!(events[3]["mono_ns"], 77_000_000_002u64);
    assert!(events[3].get("cids").is_none());
}

// contract: log.native.pulls-at-the-batch-interval
#[test]
fn the_writer_pulls_native_records_at_the_batch_interval() {
    let ring = Arc::new(Mutex::new(FakeRing::default()));
    let directory = folder::Folder::new();
    let log = start(directory.path(), &ring, Duration::from_millis(10));
    let path = log.path().to_path_buf();
    // The ring is empty at the start; a record that arrives later is stored without a flush request.
    std::thread::sleep(Duration::from_millis(30));
    ring.lock().unwrap().bytes = native_record(1_791_000_000_000_001, 2, "native.test.late", "{}");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if read(&path)
            .iter()
            .any(|event| event["event"] == "native.test.late")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the record was not stored within 5 seconds"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    log.flush(Duration::from_secs(5)).unwrap();
}
