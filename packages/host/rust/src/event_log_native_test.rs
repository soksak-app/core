//! The records of the native ring as bytes (docs/spec/logging.md#writers): the decoder of the host takes the records that the drain of
//! the ring gives, refuses and counts the records it cannot decode, and the writer stores the decoded events in the layer `native`
//! with the clocks that the library gave. The scheduling of the pull and the loss of a full ring run against the real ring in
//! tests/event_native_test.rs.

use std::time::Duration;

use serde_json::Value;
use soksak_sok::event_log::PullSink;

use super::{Channel, EventLog, Options, RelayedEvent, native_event_of, native_records_of, start};
use crate::log_policy::LogPolicy;

/// A record of the class call as the native library drains it; the names of the tests that use it are not in the catalog.
fn native_record(ts: u64, mono: u64, level: u8, cids: &str, name: &str, fields: &str) -> Vec<u8> {
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

/// A record that the decoder refuses, with a part of its error. `located` is false for a record whose length is wrong: the decoder
/// reports the length 0 for it, so the caller abandons the rest of the buffer.
struct Refused {
    name: &'static str,
    record: Vec<u8>,
    located: bool,
    error: &'static str,
}

/// The records of the refused forms of docs/spec/logging.md#writers, the record of a bad length last.
fn refused_cases() -> Vec<Refused> {
    let mut truncated = native_record(
        1_791_000_000_000_005,
        5_000_000_005,
        2,
        "",
        "native.test.cut",
        r#"{"a":1}"#,
    );
    truncated[..4].copy_from_slice(&500u32.to_ne_bytes());
    let case = |name, record, located, error| Refused {
        name,
        record,
        located,
        error,
    };
    vec![
        case(
            "a name that does not start with the layer",
            native_record(
                1_791_000_000_000_002,
                5_000_000_002,
                2,
                "",
                "host.test.forged",
                "{}",
            ),
            true,
            r#"does not start with its layer "native""#,
        ),
        case(
            "fields that are not JSON",
            native_record(
                1_791_000_000_000_003,
                5_000_000_003,
                2,
                "",
                "native.test.fields",
                "{broken",
            ),
            true,
            "are not a JSON object",
        ),
        case(
            "a level outside the enumeration",
            native_record(
                1_791_000_000_000_004,
                5_000_000_004,
                9,
                "",
                "native.test.level",
                "{}",
            ),
            true,
            "the level 9 is not defined",
        ),
        case(
            "a cid with a quote",
            native_record(
                1_791_000_000_000_006,
                5_000_000_006,
                2,
                "b1.1,a\"b",
                "native.test.cid",
                "{}",
            ),
            true,
            "of native.test.cid is empty or holds",
        ),
        case(
            "an empty cid",
            native_record(
                1_791_000_000_000_007,
                5_000_000_007,
                2,
                "b1.1,,b1.2",
                "native.test.empty",
                "{}",
            ),
            true,
            "of native.test.empty is empty or holds",
        ),
        case(
            "a monotonic clock of 0",
            native_record(1_791_000_000_000_008, 0, 2, "", "native.test.clock", "{}"),
            true,
            "the mono_ns of native.test.clock is 0",
        ),
        case(
            "a class outside the enumeration",
            native_record_of_class(
                1_791_000_000_000_009,
                5_000_000_009,
                2,
                9,
                "",
                "native.test.class",
                "{}",
            ),
            true,
            "the class 9 is not defined",
        ),
        // A declared event whose record gives another class than the catalog is a defect of the producer and is refused.
        case(
            "a class that the catalog does not declare for the event",
            native_record_of_class(
                1_791_000_000_000_010,
                5_000_000_010,
                2,
                0,
                "",
                "native.input.source_changed",
                "{}",
            ),
            true,
            "the catalog declares input",
        ),
        case(
            "a length that the buffer does not hold",
            truncated,
            false,
            "does not fit",
        ),
    ]
}

/// A refused record reports its own length so the decoder moves to the next record, except a record whose length is wrong, which has
/// no length to move by.
// contract: log.native.counts-refused-records-and-ring-loss
#[test]
fn the_decoder_refuses_a_record_it_cannot_decode_with_the_reason_and_its_length() {
    for case in refused_cases() {
        let (length, error) = match native_event_of(&case.record) {
            Err(refusal) => refusal,
            Ok(_) => panic!("{}: the record was decoded", case.name),
        };
        assert!(
            error.contains(case.error),
            "{}: refused with {error:?}, want an error that holds {:?}",
            case.name,
            case.error
        );
        let want = if case.located { case.record.len() } else { 0 };
        assert_eq!(
            length, want,
            "{}: the length of the refused record",
            case.name
        );
    }
}

/// What a pull hands to the writer, collected: the names of the events, and each loss with its reason and channel.
#[derive(Default)]
struct Collected {
    accepted: Vec<String>,
    lost: Vec<(u64, u64, String, Channel)>,
}

impl PullSink for Collected {
    fn accept(&mut self, event: RelayedEvent) {
        self.accepted.push(event.event);
    }

    fn lost(&mut self, events: u64, bytes: u64, reason: &str, channel: Channel) {
        self.lost.push((events, bytes, reason.to_string(), channel));
    }
}

// contract: log.native.counts-refused-records-and-ring-loss
#[test]
fn the_refused_records_of_a_buffer_are_counted_in_the_channel_other_and_the_good_record_is_stored()
{
    let good = native_record(
        1_791_000_000_000_001,
        5_000_000_001,
        2,
        "",
        "native.test.ok",
        "{}",
    );
    let cases = refused_cases();
    // The truncated record is last: nothing after a record whose length is wrong can be located.
    let mut buffer = good.clone();
    for case in &cases {
        buffer.extend_from_slice(&case.record);
    }
    let mut collected = Collected::default();
    native_records_of(&buffer, &mut collected);
    assert_eq!(collected.accepted, ["native.test.ok"]);
    // A record that cannot be decoded has no level and is counted in other, in one loss with one reason.
    assert_eq!(collected.lost.len(), 1, "{:?}", collected.lost);
    let (events, bytes, reason, channel) = &collected.lost[0];
    assert_eq!(*events, cases.len() as u64);
    assert_eq!(reason, "a native record was refused");
    assert!(matches!(channel, Channel::Other));
    // Each refusal counts the bytes from the start of the refused record to the end of the buffer.
    let mut want = 0u64;
    let mut offset = good.len();
    for case in &cases {
        want += (buffer.len() - offset) as u64;
        offset += case.record.len();
    }
    assert_eq!(*bytes, want);
}

/// Hands each decoded event to the writer as its pull does; a loss fails the test.
struct Store<'a>(&'a EventLog);

impl PullSink for Store<'_> {
    fn accept(&mut self, event: RelayedEvent) {
        let name = event.event.clone();
        assert!(self.0.emit_relayed(event).unwrap(), "{name} was not stored");
    }

    fn lost(&mut self, events: u64, _bytes: u64, reason: &str, _channel: Channel) {
        panic!("the records of the test lost {events} events: {reason}");
    }
}

/// Starts a writer that stores every level, with bounds that the tests do not reach, gives it the records of `buffer` as its pull
/// does, and returns the events of its file after the flush.
fn stored_events(buffer: &[u8]) -> Vec<Value> {
    let directory = tempfile::tempdir().unwrap();
    let log = start(Options {
        directory: directory.path().to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1 << 30,
        pull: None,
        pull_loss: None,
        wake: None,
        policy_path: None,
        retention_bytes: 1 << 40,
    })
    .unwrap();
    let policy = LogPolicy::parse(
        "native test policy",
        br#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}"#,
    )
    .unwrap();
    log.set_policy(policy, "file");
    log.flush().unwrap();
    native_records_of(buffer, &mut Store(&log));
    log.flush().unwrap();
    let events = std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    log.close();
    events
}

// contract: log.native.stores-pulled-records-in-the-layer-native
#[test]
fn the_writer_stores_decoded_native_records_in_the_layer_native() {
    let events = stored_events(
        &[
            native_record(
                1_791_000_000_000_001,
                9_001,
                1,
                "",
                "native.test.first",
                r#"{"index":1}"#,
            ),
            native_record(
                1_791_000_000_000_002,
                9_002,
                0,
                "",
                "native.test.second",
                "{}",
            ),
        ]
        .concat(),
    );
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

// contract: log.native.stores-the-class-of-a-pulled-record
#[test]
fn a_decoded_native_record_of_a_declared_event_stores_the_catalog_class_and_an_undeclared_one_stores_none()
 {
    let events = stored_events(
        &[
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
    );
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[2]["class"], "input");
    assert!(events[2].get("undeclared").is_none());
    assert_eq!(events[3]["undeclared"], true);
    assert!(events[3].get("class").is_none());
}

// contract: log.native.stores-clock-and-cids-of-pulled-records
#[test]
fn a_decoded_native_record_keeps_its_clock_and_cids() {
    let events = stored_events(
        &[
            native_record(
                1_791_000_000_000_001,
                77_000_000_001,
                2,
                "b1.4,b1.5",
                "native.test.input",
                r#"{"k":1}"#,
            ),
            native_record(
                1_791_000_000_000_002,
                77_000_000_002,
                2,
                "",
                "native.test.plain",
                "{}",
            ),
        ]
        .concat(),
    );
    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[2]["mono_ns"], 77_000_000_001u64);
    assert_eq!(events[2]["cids"], serde_json::json!(["b1.4", "b1.5"]));
    assert_eq!(events[2]["fields"]["k"], 1);
    assert_eq!(events[3]["mono_ns"], 77_000_000_002u64);
    assert!(events[3].get("cids").is_none());
}
