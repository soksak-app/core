//! The bounds of the values that the host produces (docs/spec/logging.md#bounds): a producer cuts a value while it
//! serializes it, the start buffer and the lists of the endpoint have bounds, and every loss is counted. The same cases run
//! in the Go host.

#[path = "support/records.rs"]
mod records;

use std::collections::HashSet;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::value::RawValue;
use serde_json::{json, Map, Value};
use soksak_host_tauriv2::application_log::{log_error, log_info};
use soksak_host_tauriv2::bounds::{EVENT_FIELDS_LIMIT_BYTES, EVENT_HEAD_BYTES};
use soksak_host_tauriv2::endpoint::{self, raw, Connection, Endpoint, Failure, Service};
use soksak_host_tauriv2::event_log::{self, Level, Options};
use soksak_host_tauriv2::event_record::{
    emit_host, use_host_event_log, START_BUFFER_BYTES, START_BUFFER_RECORDS,
};

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Runs `body` with a writer attached and returns the events that the writer stored.
fn events_of(body: impl FnOnce()) -> Vec<Value> {
    let config = tempfile::tempdir().unwrap();
    let log = records::start_writer(config.path());
    body();
    log.flush(Duration::from_secs(10)).unwrap();
    let events = records::read_events(&records::event_log_path(config.path()));
    use_host_event_log(None);
    events
}

fn named<'a>(events: &'a [Value], name: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|event| event["event"] == name)
        .collect()
}

// contract: bounds.producer.fields-are-cut-while-serialized
#[test]
fn the_fields_of_a_host_event_are_cut_while_they_are_serialized() {
    let _serial = serial();
    // The text of this value is about 20 MB; the producer stops just over the bound.
    let big = json!({"data": vec!["e".repeat(98); 200_000]});
    let events = events_of(|| emit_host(Level::Debug, "host.test.big", big));
    let stored = named(&events, "host.test.big");
    assert_eq!(stored.len(), 1, "events {events:?}");
    let fields = stored[0]["fields"].as_object().unwrap();
    let head = fields["head"].as_str().unwrap();
    assert!(
        fields.len() == 1 && head.len() == EVENT_HEAD_BYTES,
        "fields {fields:?}"
    );
    let cut = stored[0]["truncated"].as_u64().unwrap() as usize;
    assert!(
        cut > EVENT_FIELDS_LIMIT_BYTES && cut <= EVENT_FIELDS_LIMIT_BYTES + 4096,
        "truncated {cut}, want just over {EVENT_FIELDS_LIMIT_BYTES}: the producer stops at the bound"
    );
}

// contract: bounds.producer.fields-are-cut-while-serialized
#[test]
fn the_fields_of_a_host_event_that_fit_are_stored_as_their_json() {
    let _serial = serial();
    let fields = json!({"list": [1, "x\n\"é", null, true, 1.5, ["a"]], "inner": {"c": "d"}, "none": null, "count": 7});
    let events = events_of(|| emit_host(Level::Debug, "host.test.small", fields.clone()));
    let stored = named(&events, "host.test.small");
    assert_eq!(stored.len(), 1, "events {events:?}");
    assert_eq!(stored[0]["fields"], fields);
    assert!(stored[0].get("truncated").is_none());
}

// contract: bounds.producer.record-text-is-cut
#[test]
fn the_text_and_the_place_of_a_record_are_cut_at_their_bounds() {
    let _serial = serial();
    let events = events_of(|| log_error(&"p".repeat(3000), "é".repeat(10000)));
    let stored = named(&events, "host.record.error");
    assert_eq!(stored.len(), 1, "events {events:?}");
    let fields = &stored[0]["fields"];
    let (text, place) = (
        fields["text"].as_str().unwrap().len(),
        fields["where"].as_str().unwrap().len(),
    );
    assert!(
        (8190..=8192).contains(&text) && place <= 1024 && fields["truncated"] == true,
        "text of {text} bytes, place of {place} bytes, fields {fields}"
    );
}

// contract: bounds.start-buffer.holds-at-most-four-mebibytes
#[test]
fn the_start_buffer_holds_at_most_four_mebibytes_and_the_writer_counts_the_rest() {
    let _serial = serial();
    use_host_event_log(None);
    let records_written = 1000;
    assert!(records_written < START_BUFFER_RECORDS);
    let text = "x".repeat(8000);
    for _ in 0..records_written {
        log_info("flood", &text);
    }
    let config = tempfile::tempdir().unwrap();
    let log = Arc::new(
        event_log::start(Options {
            directory: config.path().to_path_buf(),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 4 * START_BUFFER_RECORDS,
            queue_bytes: 64 << 20,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    );
    use_host_event_log(Some(Arc::clone(&log)));
    log.flush(Duration::from_secs(10)).unwrap();
    let path = log.path().to_path_buf();
    use_host_event_log(None);
    let events = records::read_events(&path);
    let stored = named(&events, "host.record.info").len();
    let (mut dropped, mut dropped_bytes) = (0, 0);
    for event in named(&events, "log.dropped") {
        dropped += event["fields"]["count"].as_u64().unwrap() as usize;
        dropped_bytes += event["fields"]["bytes"].as_u64().unwrap() as usize;
    }
    assert!(
        stored * text.len() <= START_BUFFER_BYTES
            && stored >= START_BUFFER_BYTES / text.len() * 9 / 10
            && dropped == records_written - stored
            && dropped_bytes >= text.len(),
        "stored {stored} of {records_written}, dropped {dropped} with {dropped_bytes} bytes; want at most {START_BUFFER_BYTES} bytes stored and the rest counted"
    );
}

/// A page that does not finish the first status.watch until gate opens.
struct GatedPage {
    gate: Mutex<Option<Receiver<()>>>,
    entered: Mutex<Sender<String>>,
}

impl Service for GatedPage {
    fn windows(&self) -> Result<Value, Failure> {
        Ok(json!([]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "w1"
    }

    fn call(
        &self,
        _window: &str,
        method: &str,
        _params: Map<String, Value>,
    ) -> Result<Box<RawValue>, Failure> {
        let _ = self.entered.lock().unwrap().send(method.to_string());
        let gate = self.gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.recv().unwrap();
        }
        raw(&Value::Null)
    }
}

fn send(connection: &mut Box<dyn Connection>, message: Value) {
    endpoint::write_frame(connection, &message).unwrap();
}

fn receive(connection: &mut Box<dyn Connection>) -> Value {
    endpoint::read_frame(connection)
        .unwrap()
        .expect("the endpoint closed the connection")
}

// contract: bounds.endpoint.topic-changes-hold-at-most-256
#[test]
fn the_subscription_changes_of_a_topic_hold_at_most_256_and_the_rest_is_refused_and_counted() {
    let _serial = serial();
    let config = tempfile::tempdir().unwrap();
    let log = records::start_writer(config.path());
    let (open_gate, gate) = mpsc::channel();
    let (entered, calls) = mpsc::channel();
    let page = Arc::new(GatedPage {
        gate: Mutex::new(Some(gate)),
        entered: Mutex::new(entered),
    });
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-topic-bound",
        page,
    )
    .unwrap();
    endpoint.publish("w1").unwrap();
    let mut connection = endpoint::connect(endpoint.address()).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let topic = json!({"window": "w1", "name": "core.layout"});
    let request = |connection: &mut Box<dyn Connection>, id: u64, method: &str| {
        send(
            connection,
            json!({"jsonrpc": "2.0", "id": id, "method": method, "params": topic}),
        );
    };
    request(&mut connection, 1, "status.watch");
    assert_eq!(calls.recv().unwrap(), "status.watch");
    let (pending, refused) = (256u64, 10u64);
    for id in 2..=1 + pending + refused {
        request(
            &mut connection,
            id,
            if id % 2 == 1 {
                "status.watch"
            } else {
                "status.unwatch"
            },
        );
    }
    // The refusals are answered at once; the accepted changes wait for the page.
    let mut refused_ids = HashSet::new();
    for _ in 0..refused {
        let reply = receive(&mut connection);
        assert!(
            reply["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("256")),
            "reply {reply}, want a refusal"
        );
        refused_ids.insert(reply["id"].as_u64().unwrap());
    }
    assert_eq!(
        refused_ids,
        (2 + pending..=1 + pending + refused).collect::<HashSet<u64>>()
    );
    open_gate.send(()).unwrap();
    for index in 0..=pending {
        let reply = receive(&mut connection);
        assert!(reply.get("error").is_none(), "reply {index}: {reply}");
    }
    endpoint.stop();
    log.flush(Duration::from_secs(10)).unwrap();
    let events = records::read_events(&records::event_log_path(config.path()));
    use_host_event_log(None);
    let drops = named(&events, "host.buffer.dropped");
    assert_eq!(drops.len(), refused as usize, "events {drops:?}");
    for drop in drops {
        let fields = &drop["fields"];
        assert!(
            fields["buffer"] == "endpoint topic changes"
                && fields["count"] == 1
                && fields["reason"] == "the buffer holds 256 messages",
            "event {drop}"
        );
    }
}
