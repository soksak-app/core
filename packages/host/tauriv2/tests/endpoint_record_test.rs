//! The record of the endpoint methods (docs/spec/logging.md#entrances): every request of a client is the event
//! `host.endpoint.call` with the performance trace off. The same cases run in the Go host.

#[path = "support/records.rs"]
mod records;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use soksak_host_tauriv2::endpoint::{self, Connection, Endpoint, Failure, Service, raw};
use soksak_host_tauriv2::event_log::EventLog;
use soksak_host_tauriv2::event_record::use_host_event_log;

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

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

/// Runs `body` with a writer attached, an endpoint with a connection, and the performance trace off; it returns the events
/// `host.endpoint.call` that the writer stored.
fn calls_of(body: impl FnOnce(&mut Box<dyn Connection>)) -> Vec<Value> {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    assert!(
        !soksak_host_tauriv2::performance::enabled(),
        "the performance trace is on"
    );
    let config = tempfile::tempdir().unwrap();
    let log: Arc<EventLog> = records::start_writer(config.path());
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-record",
        Arc::new(Fake),
    )
    .unwrap();
    endpoint.publish("main").unwrap();
    let mut connection = endpoint::connect(endpoint.address()).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    body(&mut connection);
    endpoint.stop();
    log.flush(Duration::from_secs(5)).unwrap();
    let calls = events_of(config.path());
    use_host_event_log(None);
    calls
}

fn events_of(config: &Path) -> Vec<Value> {
    records::read_events(&records::event_log_path(config))
        .into_iter()
        .filter(|event| event["event"] == "host.endpoint.call")
        .collect()
}

fn request(connection: &mut Box<dyn Connection>, id: u64, method: &str, params: Value) -> Value {
    endpoint::write_frame(
        connection,
        &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )
    .unwrap();
    endpoint::read_frame(connection)
        .unwrap()
        .expect("the endpoint closed the connection")
}

// contract: endpoint.record.call-is-an-event
#[test]
fn an_endpoint_request_is_an_event_while_the_trace_is_off() {
    let calls = calls_of(|connection| {
        request(connection, 1, "windows.list", Value::Null);
        request(
            connection,
            2,
            "status.get",
            json!({"window": "main", "name": "core.layout"}),
        );
        request(
            connection,
            3,
            "status.watch",
            json!({"window": "main", "name": "core.layout"}),
        );
    });
    assert_eq!(calls.len(), 3, "{calls:?}");
    let want = [
        ("windows.list", "null"),
        ("status.get", r#"{"name":"core.layout","window":"main"}"#),
        ("status.watch", r#"{"name":"core.layout","window":"main"}"#),
    ];
    for (call, (name, args)) in calls.iter().zip(want) {
        let fields = &call["fields"];
        assert_eq!(call["layer"], "host", "{call}");
        assert_eq!(call["level"], "debug", "{call}");
        assert_eq!(fields["name"], name, "{call}");
        assert_eq!(fields["args"], args, "{call}");
        assert_eq!(fields["ok"], true, "{call}");
        assert_eq!(fields["truncated"], false, "{call}");
        assert!(fields["micros"].as_u64().is_some(), "{call}");
        assert!(fields.get("error").is_none(), "{call}");
    }
}

// contract: endpoint.record.failure-names-the-error
#[test]
fn a_failed_endpoint_request_is_a_warning_with_its_error_text() {
    let mut reply = Value::Null;
    let calls = calls_of(|connection| {
        reply = request(
            connection,
            1,
            "status.get",
            json!({"window": "absent", "name": "core.layout"}),
        );
    });
    let error = &reply["error"];
    assert!(error.is_object(), "{reply}");
    assert_eq!(calls.len(), 1, "{calls:?}");
    let text = format!(
        "{}: {}",
        error["code"].as_i64().unwrap(),
        error["message"].as_str().unwrap()
    );
    assert_eq!(calls[0]["level"], "warn", "{}", calls[0]);
    assert_eq!(calls[0]["fields"]["name"], "status.get");
    assert_eq!(calls[0]["fields"]["ok"], false);
    assert_eq!(calls[0]["fields"]["error"], text);
}

// contract: endpoint.record.arguments-are-cut-before-copying
#[test]
fn the_arguments_of_an_endpoint_event_are_cut_at_the_bound() {
    let calls = calls_of(|connection| {
        // Multi-byte characters put the bound inside a character.
        let name = format!("core.{}", "é".repeat(3000));
        request(
            connection,
            1,
            "status.get",
            json!({"window": "main", "name": name}),
        );
    });
    assert_eq!(calls.len(), 1, "{calls:?}");
    let args = calls[0]["fields"]["args"].as_str().unwrap();
    assert!(
        args.len() <= 1024 && args.len() >= 1021,
        "args of {} bytes",
        args.len()
    );
    assert_eq!(calls[0]["fields"]["truncated"], true);
}
