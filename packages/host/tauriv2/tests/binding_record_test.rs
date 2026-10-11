//! The record of the host calls of a page (docs/spec/logging.md#entrances): every command is the event
//! `host.binding.call` with the performance trace off. The same cases run in the Go host.

#[path = "support/records.rs"]
mod records;

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use soksak_host_tauriv2::binding_record::BindingCall;
use soksak_host_tauriv2::bounds::CALL_TEXT_BYTES;
use soksak_host_tauriv2::event_record::use_host_event_log;
use tauri::ipc::InvokeBody;

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

/// Runs `body` with a writer attached and returns the events `host.binding.call` that the writer stored.
fn calls_of(body: impl FnOnce()) -> Vec<Value> {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    assert!(
        !soksak_host_tauriv2::performance::enabled(),
        "the performance trace is on"
    );
    let config = tempfile::tempdir().unwrap();
    let log = records::start_writer(config.path());
    body();
    log.flush(Duration::from_secs(5)).unwrap();
    let calls = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| event["event"] == "host.binding.call")
        .collect();
    use_host_event_log(None);
    calls
}

fn payload(value: Value) -> InvokeBody {
    InvokeBody::Json(value)
}

// contract: binding.record.call-is-an-event
#[test]
fn a_binding_call_is_an_event_while_the_trace_is_off() {
    let calls = calls_of(|| {
        BindingCall::begin("echo", &payload(json!({"value": {"a": 1}})))
            .finish(&["value"], &Ok::<(), String>(()));
        BindingCall::begin("clipboard_persist_png", &payload(json!({"request": "x"})))
            .finish(&["request"], &Ok::<(), String>(()));
        BindingCall::begin("stop", &payload(json!({}))).finish(&[], &Ok::<(), String>(()));
        // The arguments are in the order of the call, not of the keys.
        BindingCall::begin("pair", &payload(json!({"a": 1, "b": 2})))
            .finish(&["b", "a"], &Ok::<(), String>(()));
    });
    let want = [
        ("echo", r#"[{"a":1}]"#),
        ("clipboard_persist_png", r#"["x"]"#),
        ("stop", "[]"),
        ("pair", "[2,1]"),
    ];
    assert_eq!(calls.len(), want.len(), "events {calls:?}");
    for (call, (name, args)) in calls.iter().zip(want) {
        let fields = &call["fields"];
        assert_eq!(call["layer"], "host", "event {call}");
        assert_eq!(call["level"], "debug", "event {call}");
        assert_eq!(fields["name"], name, "event {call}");
        assert_eq!(fields["args"], args, "event {call}");
        assert_eq!(fields["ok"], true, "event {call}");
        assert_eq!(fields["truncated"], false, "event {call}");
        assert!(fields["micros"].as_u64().is_some(), "event {call}");
        assert!(fields.get("error").is_none(), "event {call}");
    }
}

// contract: binding.record.failure-names-the-error
#[test]
fn a_failed_binding_call_is_a_warning_with_its_error_text() {
    let calls = calls_of(|| {
        BindingCall::begin("fail", &payload(json!({"value": null}))).finish(
            &["value"],
            &Err::<(), String>("the request is refused".into()),
        );
    });
    assert_eq!(calls.len(), 1, "events {calls:?}");
    let fields = &calls[0]["fields"];
    assert_eq!(calls[0]["level"], "warn", "event {}", calls[0]);
    assert_eq!(fields["name"], "fail");
    assert_eq!(fields["ok"], false);
    assert_eq!(fields["error"], "the request is refused");
}

// contract: binding.record.arguments-are-cut-before-copying
#[test]
fn the_arguments_of_a_binding_event_are_cut_at_the_bound() {
    // Multi-byte characters put the bound inside a character.
    let big = "é".repeat(3000);
    let calls = calls_of(|| {
        BindingCall::begin("pair", &payload(json!({"a": big, "b": big})))
            .finish(&["a", "b"], &Ok::<(), String>(()));
    });
    assert_eq!(calls.len(), 1, "events {calls:?}");
    let fields = &calls[0]["fields"];
    let args = fields["args"].as_str().unwrap();
    assert!(
        args.len() <= CALL_TEXT_BYTES && args.len() >= CALL_TEXT_BYTES - 3,
        "args of {} bytes",
        args.len()
    );
    assert_eq!(fields["truncated"], true);
}

// contract: binding.record.unfinished-call-names-the-error
#[test]
fn a_binding_call_that_does_not_finish_is_a_warning() {
    let calls = calls_of(|| {
        // The framework rejected an argument, or the command panicked: the call is dropped without a result.
        drop(BindingCall::begin("explode", &payload(json!({"value": 1}))));
    });
    assert_eq!(calls.len(), 1, "events {calls:?}");
    let fields = &calls[0]["fields"];
    assert_eq!(calls[0]["level"], "warn", "event {}", calls[0]);
    assert_eq!(fields["name"], "explode");
    assert_eq!(fields["ok"], false);
    assert_eq!(fields["error"], "the call ended without a result");
}
