//! The gate at the producers of the host (docs/spec/logging.md#classes-and-policy): a call that the policy does not store is not built
//! into an event, and the writer counts it; a failed call is a warning and still passes a policy that stores the class from warn on.
//! The same cases run in the Go host.

#[path = "support/records.rs"]
mod records;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::value::RawValue;
use serde_json::{json, Map, Value};
use soksak_host_tauriv2::binding_record::BindingCall;
use soksak_host_tauriv2::endpoint::{self, raw, Endpoint, Failure, Service};
use soksak_host_tauriv2::event_log::EventLog;
use soksak_host_tauriv2::event_record::use_host_event_log;
use soksak_host_tauriv2::log_policy::LogPolicy;
use tauri::ipc::InvokeBody;

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn narrow_calls(log: &EventLog, level: &str) {
    let text = format!(
        r#"{{"schema":1,"classes":{{"lifecycle":"trace","input":"trace","call":"{level}","io":"trace","frame":"trace"}}}}"#
    );
    log.set_policy(LogPolicy::parse("policy", text.as_bytes()).unwrap(), "file");
}

fn payload(value: Value) -> InvokeBody {
    InvokeBody::Json(value)
}

fn gated_counts(events: &[Value]) -> BTreeMap<String, u64> {
    let mut counts = BTreeMap::new();
    for event in events.iter().filter(|event| event["event"] == "log.gated") {
        let fields = &event["fields"];
        *counts
            .entry(format!(
                "{}/{}",
                fields["class"].as_str().unwrap(),
                fields["level"].as_str().unwrap()
            ))
            .or_default() += fields["count"].as_u64().unwrap();
    }
    counts
}

// contract: log.policy.binding-call-is-gated
#[test]
fn a_binding_call_that_the_policy_does_not_store_is_counted_and_a_failed_one_is_stored() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = tempfile::tempdir().unwrap();
    let log = records::start_writer(config.path());
    narrow_calls(&log, "warn");
    for _ in 0..3 {
        BindingCall::begin("echo", &payload(json!({"value": {"a": 1}})))
            .finish(&["value"], &Ok::<(), String>(()));
    }
    BindingCall::begin("fail", &payload(json!({"value": 1}))).finish(
        &["value"],
        &Err::<(), String>("the request is refused".into()),
    );
    log.flush(Duration::from_secs(5)).unwrap();
    let events = records::read_events(&records::event_log_path(config.path()));
    use_host_event_log(None);
    let calls: Vec<&Value> = events
        .iter()
        .filter(|event| event["event"] == "host.binding.call")
        .collect();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0]["level"], "warn");
    assert_eq!(calls[0]["fields"]["name"], "fail");
    let counts = gated_counts(&events);
    assert_eq!(counts.len(), 1, "{counts:?}");
    assert_eq!(counts["call/debug"], 3);
}

/// A service that has only the window main and replies null.
struct Fake;

impl Service for Fake {
    fn windows(&self) -> Result<Value, Failure> {
        Ok(json!([{"window": "main", "title": "Main", "project": null, "key": true}]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "main"
    }

    fn call(
        &self,
        _window: &str,
        _method: &str,
        _params: Map<String, Value>,
    ) -> Result<Box<RawValue>, Failure> {
        raw(&Value::Null)
    }
}

// contract: log.policy.endpoint-call-is-gated
#[test]
fn an_endpoint_request_that_the_policy_does_not_store_is_counted() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = tempfile::tempdir().unwrap();
    let log = records::start_writer(config.path());
    narrow_calls(&log, "warn");
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-gate",
        Arc::new(Fake),
    )
    .unwrap();
    endpoint.publish("main").unwrap();
    let mut connection = endpoint::connect(endpoint.address()).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    for id in 1..=2u64 {
        endpoint::write_frame(
            &mut connection,
            &json!({"jsonrpc": "2.0", "id": id, "method": "windows.list", "params": null}),
        )
        .unwrap();
        endpoint::read_frame(&mut connection)
            .unwrap()
            .expect("the endpoint closed the connection");
    }
    endpoint.stop();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = records::read_events(&records::event_log_path(config.path()));
    use_host_event_log(None);
    let stored: Vec<&Value> = events
        .iter()
        .filter(|event| event["event"] == "host.endpoint.call")
        .collect();
    assert!(stored.is_empty(), "{stored:?}");
    let counts = gated_counts(&events);
    assert_eq!(counts.len(), 1, "{counts:?}");
    assert_eq!(counts["call/debug"], 2);
}

// contract: log.policy.closed-gate-costs-a-branch
#[test]
fn a_closed_gate_costs_far_less_than_an_open_one_and_stays_under_a_limit() {
    use soksak_host_tauriv2::event_log::{Level as L, Options};
    use soksak_host_tauriv2::log_policy::Class;
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start(Options {
        directory: directory.path().to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 1 << 16,
        queue_bytes: 1 << 26,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1 << 30,
        pull: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: 1 << 40,
    })
    .unwrap();
    const ROUNDS: u32 = 20_000;
    let fields =
        json!({"name": "echo", "args": "[{\"a\":1}]", "micros": 1, "ok": true, "truncated": false});
    let started = std::time::Instant::now();
    for _ in 0..ROUNDS {
        log.emit(L::Debug, "host.binding.call", &fields);
    }
    let open_each = started.elapsed() / ROUNDS;
    narrow_calls(&log, "warn");
    let started = std::time::Instant::now();
    for _ in 0..ROUNDS {
        assert!(!log.gate(Class::Call, L::Debug), "the gate is open");
    }
    let closed_each = started.elapsed() / ROUNDS;
    println!("an enqueue with the gate open: {open_each:?}; the question of a closed gate: {closed_each:?} ({ROUNDS} rounds)");
    // The limits are generous: the closed gate is a branch and an atomic add, so it is at most a few nanoseconds on a quiet machine, and a
    // machine under load runs it up to 100 times slower (the numbers on a quiet machine are recorded under F160.17).
    assert!(
        closed_each <= Duration::from_micros(25),
        "a closed gate costs {closed_each:?} for each question, over the limit of 25 µs"
    );
    assert!(
        closed_each * 4 < open_each,
        "a closed gate costs {closed_each:?} and an open enqueue {open_each:?}: the closed gate is not far cheaper"
    );
}

// contract: log.policy.producer-builds-nothing-for-a-closed-gate
#[test]
fn a_closed_gate_builds_no_fields_at_the_producers_of_the_host() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = tempfile::tempdir().unwrap();
    let log = records::start_writer(config.path());
    narrow_calls(&log, "warn");
    // The observation of the trace builds its fields only for a gate that is open.
    soksak_host_tauriv2::performance::command(json!({"action": "on"})).unwrap();
    let built = std::cell::Cell::new(0);
    soksak_host_tauriv2::performance::observe("host", || {
        built.set(built.get() + 1);
        json!({"event": "probe"})
    });
    soksak_host_tauriv2::performance::command(json!({"action": "off"})).unwrap();
    use_host_event_log(None);
    assert_eq!(
        built.get(),
        0,
        "the fields of an observation were built although the policy does not store the class call at debug"
    );
}
