//! The connection activity of the endpoint (docs/spec/endpoint.md#transport). The activity is one state of the process, so the
//! test runs in a test binary of its own, where no other endpoint opens a connection.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/platform/platform.rs"]
mod endpoint_client;

#[path = "support/records.rs"]
mod records;

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use soksak_host::endpoint::{self, Endpoint, Failure, Service, raw};
use soksak_host::event_log::{self, EventLog};
use soksak_host::log_policy::{LogPolicy, start_log_policy};

/// The state of the connection activity that the last `native.connection.activity` record of the event log states: `None`
/// before a record, or the error that names what the log holds.
type ActivityState = Result<Option<bool>, String>;

/// Flushes log and reads the records of the activity from the event log of config.
fn recorded_activity(log: &EventLog, config: &Path) -> ActivityState {
    log.flush()?;
    let path = records::event_log_path(config);
    let text =
        std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut events = Vec::new();
    for line in text.lines() {
        let event: Value = serde_json::from_str(line)
            .map_err(|error| format!("{} holds the line {line:?}: {error}", path.display()))?;
        events.push(event);
    }
    events.sort_by_key(|event| event["seq"].as_u64());
    let mut state = None;
    for event in events
        .iter()
        .filter(|event| event["event"] == "native.connection.activity")
    {
        let held = event["fields"]["held"]
            .as_bool()
            .ok_or_else(|| format!("native.connection.activity without a boolean held: {event}"))?;
        state = Some(held);
    }
    Ok(state)
}

/// The window of the endpoint, which reads, at the delivery of the release of each press, the state of the activity that the
/// event log records.
struct ActivityWindow {
    log: Arc<EventLog>,
    config: PathBuf,
    ups: Mutex<Sender<ActivityState>>,
}

impl Service for ActivityWindow {
    fn unwatched(&self, _window: &str, _name: &str) {}

    fn windows(&self) -> Result<Value, Failure> {
        Ok(json!([{"window": "w1", "title": "one", "project": null, "key": true}]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "w1"
    }

    fn call(
        &self,
        _window: &str,
        method: &str,
        params: Map<String, Value>,
        _reply: Option<soksak_host::endpoint::ReplyScope>,
    ) -> Result<Box<RawValue>, Failure> {
        if method == "input.pointer" && params.get("phase").and_then(Value::as_str) == Some("up") {
            let state = recorded_activity(&self.log, &self.config);
            // default: the receiver is the test, which waits for every state that it reads.
            let _ = self.ups.lock().unwrap().send(state);
        }
        raw(&Value::Null)
    }
}

fn request(
    connection: &mut endpoint_client::Connection,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    endpoint::write_frame(
        connection,
        &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )
    .unwrap();
    endpoint::read_frame(connection)
        .unwrap()
        .expect("the endpoint closed the connection")
}

fn next_up(ups: &Receiver<ActivityState>) -> ActivityState {
    ups.recv()
        .unwrap_or_else(|_| panic!("the window ended before the release of a press reached it"))
}

/// Gives the native gate the default policy again when the test ends, because the gate belongs to the process.
struct DefaultNativePolicy;

impl Drop for DefaultNativePolicy {
    fn drop(&mut self) {
        if let Err(error) = soksak_host::platform::current().and_then(|platform| {
            platform.set_native_event_policy(LogPolicy::default().native_levels())
        }) {
            panic!("restore the default native policy: {error}");
        }
    }
}

// The host holds the connection activity while a connection of its endpoint is open, so the system does not run it in the
// background while a client waits for its answers, and releases it when the last connection closes. The native library records
// each begin and end of the activity, and the end of a connection releases the activity before it releases the presses of the
// connection, so the record that the event log holds at the delivered release of a press is the state that the end left.
// contract: endpoint.connection.holds-activity
#[test]
fn the_endpoint_holds_the_activity_while_a_connection_is_open() {
    let config = folder::Folder::new();
    // The record of the activity is a lifecycle event at info, which the default policy refuses; the policy file of the
    // configuration asks for it, as a person does (docs/spec/logging.md#policy).
    std::fs::write(
        config.path().join("log-policy.json"),
        br#"{"schema":1,"classes":{"lifecycle":"info","input":"error","call":"error","io":"error","frame":"error"}}"#,
    )
    .unwrap();
    let log = Arc::new(event_log::start_host(config.path()).unwrap());
    let _restore = DefaultNativePolicy;
    let _policy = start_log_policy(&log, None).unwrap();
    let (ups, received) = mpsc::channel();
    let window = Arc::new(ActivityWindow {
        log: Arc::clone(&log),
        config: config.path().to_path_buf(),
        ups: Mutex::new(ups),
    });
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-activity",
        window,
    )
    .unwrap();
    endpoint.publish("w1").unwrap();
    assert_eq!(
        recorded_activity(&log, config.path()),
        Ok(None),
        "the log records the activity before a connection"
    );
    let mut first = endpoint_client::connect(endpoint.address());
    let down = json!({"window": "w1", "pointer": "second", "x": 1, "y": 2, "phase": "down", "button": "right"});
    assert_eq!(
        request(&mut first, 1, "input.pointer", down)["result"],
        Value::Null
    );
    let mut second = endpoint_client::connect(endpoint.address());
    let down = json!({"window": "w1", "pointer": "third", "x": 3, "y": 4, "phase": "down", "button": "right"});
    assert_eq!(
        request(&mut second, 1, "input.pointer", down)["result"],
        Value::Null
    );
    assert_eq!(
        recorded_activity(&log, config.path()),
        Ok(Some(true)),
        "with two open connections the log does not record the activity as held"
    );
    drop(first);
    assert_eq!(
        next_up(&received),
        Ok(Some(true)),
        "at the release of the press of one of two connections the log does not record the activity as held"
    );
    drop(second);
    assert_eq!(
        next_up(&received),
        Ok(Some(false)),
        "at the release of the press of the last connection the log does not record the activity as released"
    );
    endpoint.stop();
}
