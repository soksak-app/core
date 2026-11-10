//! Tests of the page request relay and the host entries. A function that receives requests replaces the page.

#[path = "support/folder.rs"]
mod folder;
#[path = "support/records.rs"]
mod records;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::value::RawValue;
use serde_json::{Value, json};
use soksak_host::event_log::EventLog;
use soksak_host::event_record::use_host_event_log;
use soksak_host::exposure::{self, Relay};
use soksak_host::windows::{ListStep, list_entries, window_entry};

const WAIT: Duration = Duration::from_secs(5);

/// The response text that a document sends.
fn text(value: Value) -> Box<RawValue> {
    serde_json::value::to_raw_value(&value).unwrap()
}

/// The response text as received.
fn text_of(body: &str) -> Box<RawValue> {
    RawValue::from_string(body.to_string()).unwrap()
}

/// Reads the relayed result text as a value.
fn value(text: &RawValue) -> Value {
    serde_json::from_str(text.get()).unwrap()
}

// contract: exposure.relay.reply-resolves-request
#[test]
fn reply_from_target_document_resolves_request() {
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let result = relay.request("main", move |id| {
        std::thread::spawn(move || {
            replying
                .reply("main", &text(json!({"id": id, "result": {"ok": true}})))
                .unwrap();
        });
        Ok(())
    });
    assert_eq!(value(&result.unwrap()), json!({"ok": true}));
}

// contract: exposure.relay.keeps-value-text
#[test]
fn reply_keeps_the_text_and_key_order_of_the_page_value() {
    // The page sends the response as JSON text. The relay does not change the key order of that value.
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let result = relay.request("main", move |id| {
        let body = format!(r#"{{"id":{id},"result":{{"zeta":1,"alpha":{{"b":2,"a":1}}}}}}"#);
        let payload = RawValue::from_string(body).unwrap();
        replying.reply("main", &payload).unwrap();
        Ok(())
    });
    assert_eq!(result.unwrap().get(), r#"{"zeta":1,"alpha":{"b":2,"a":1}}"#);
}

// contract: exposure.relay.missing-result-is-null
#[test]
fn missing_result_is_null() {
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let result = relay.request("main", move |id| {
        replying.reply("main", &text(json!({"id": id}))).unwrap();
        Ok(())
    });
    assert_eq!(value(&result.unwrap()), Value::Null);
}

// contract: exposure.relay.error-reply-keeps-code-and-message
#[test]
fn error_reply_keeps_code_and_message() {
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let failure = relay
        .request("main", move |id| {
            replying
                .reply(
                    "main",
                    &text(json!({"id": id, "error": {"code": 1002, "message": "not registered"}})),
                )
                .unwrap();
            Ok(())
        })
        .unwrap_err();
    assert_eq!(
        (failure.code, failure.message.as_str()),
        (1002, "not registered")
    );
}

/// The outcome of a relayed request.
type Outcome = Result<Box<RawValue>, soksak_host::endpoint::Failure>;

/// Starts a request to target on another thread and returns the receiver of its outcome and the receiver of its id, which the
/// relay hands over when it sends the request. The send is the event at which the request waits for its reply.
fn relay_request(
    relay: &Arc<Relay>,
    target: &'static str,
) -> (mpsc::Receiver<Outcome>, mpsc::Receiver<u64>) {
    let (outcome, outcomes) = mpsc::channel();
    let (sent, ids) = mpsc::channel();
    let relay = relay.clone();
    std::thread::spawn(move || {
        let result = relay.request(target, move |id| {
            sent.send(id).map_err(|error| error.to_string())
        });
        outcome.send(result).expect("the test holds the receiver");
    });
    (outcomes, ids)
}

/// A reply from another document is refused and changes nothing: the request keeps waiting, and the reply of its document
/// then ends it with that reply, not with the foreign one.
// contract: exposure.relay.foreign-document-reply-ignored
#[test]
fn reply_from_another_document_is_ignored_and_the_request_keeps_waiting() {
    let relay = Arc::new(Relay::default());
    let (outcome, ids) = relay_request(&relay, "main");
    let id = ids.recv().unwrap();
    assert!(
        relay
            .reply("surface-main-a", &text(json!({"id": id, "result": 1})))
            .is_err(),
        "a reply from another document was accepted"
    );
    assert!(
        outcome.try_recv().is_err(),
        "the request ended after a reply from another document"
    );
    relay
        .reply("main", &text(json!({"id": id, "result": 2})))
        .expect("the reply of the document of the request");
    assert_eq!(value(&outcome.recv().unwrap().unwrap()), json!(2));
}

// contract: exposure.relay.ended-reply-is-observed
#[test]
fn a_reply_to_a_request_that_its_document_closed_is_an_observation() {
    let relay = Arc::new(Relay::default());
    let closing = relay.clone();
    let failure = relay
        .request("surface-main-a", move |_| {
            closing.abandon("surface-main-a");
            Ok(())
        })
        .unwrap_err();
    assert_eq!(failure.code, 1003);
    // The reply to the ended request is accepted, because the document that sent it has ended.
    assert_eq!(
        relay.reply("surface-main-a", &text(json!({"id": 1, "result": 1}))),
        Ok(())
    );
    // A reply to a request that the relay never sent is still refused.
    assert_eq!(
        relay
            .reply("surface-main-a", &text(json!({"id": 101, "result": 1})))
            .unwrap_err(),
        "exposure reply 101 has no matching request"
    );
}

// contract: exposure.relay.send-failure-1003
#[test]
fn send_failure_is_reported_without_waiting() {
    let relay = Relay::default();
    let failure = relay
        .request("main", |_| Err("webview is gone".into()))
        .unwrap_err();
    assert_eq!(failure.code, 1003);
}

// contract: exposure.relay.closed-document-fails-pending-1003
#[test]
fn closed_document_fails_its_pending_requests() {
    let relay = Arc::new(Relay::default());
    let closing = relay.clone();
    let failure = relay
        .request("main", move |_| {
            closing.abandon("main");
            Ok(())
        })
        .unwrap_err();
    assert_eq!(failure.code, 1003);
}

/// A request has no time limit: it waits until its document closes, then fails with 1003, and writes no call event on the
/// way. A reply that comes after the close is an observation, and a reply to an id that the relay never sent fails.
// contract: exposure.relay.waits-until-reply-or-close
#[test]
fn a_request_waits_until_its_document_closes() {
    let _serial = RECORDS.lock().unwrap_or_else(|poison| poison.into_inner());
    let _trace = records::trace_on();
    let config = folder::Folder::new();
    let log = records::start_writer(config.path());
    let relay = Arc::new(Relay::default());
    let (outcome, ids) = relay_request(&relay, "surface-main-a");
    let id = ids.recv().unwrap();
    assert!(
        outcome.try_recv().is_err(),
        "the request ended before its document closed"
    );
    relay.abandon("surface-main-a");
    assert_eq!(outcome.recv().unwrap().unwrap_err().code, 1003);
    assert_eq!(
        relay.reply("surface-main-a", &text(json!({"id": id, "result": 1}))),
        Ok(()),
        "the reply after the close is an observation"
    );
    let never = id + 100;
    assert_eq!(
        relay
            .reply("surface-main-a", &text(json!({"id": never, "result": 1})))
            .unwrap_err(),
        format!("exposure reply {never} has no matching request")
    );
    for event in ["host.call.timeout", "host.trace.call.late-reply"] {
        assert_eq!(
            call_events(&log, config.path(), event),
            Vec::<Value>::new(),
            "{event}"
        );
    }
    use_host_event_log(None);
}

/// The end of the endpoint connection that sent a request ends it on the host. The reply of the document then comes to a
/// request that ended: the host accepts it, writes the observation and answers nothing, with no delay and no call event.
// contract: exposure.relay.connection-end-ends-its-requests
#[test]
fn the_end_of_its_connection_ends_a_relay_request_and_its_reply_is_an_observation() {
    let _serial = RECORDS.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = records::start_writer(config.path());
    let relay = Arc::new(Relay::default());
    let (outcome, ids) = relay_request(&relay, "surface-main-a");
    let id = ids.recv().unwrap();
    assert!(
        outcome.try_recv().is_err(),
        "the request ended before its connection ended"
    );
    relay.end(id);
    assert!(
        outcome.recv().unwrap().is_err(),
        "the request whose connection ended answered a result"
    );
    assert_eq!(
        relay.reply("surface-main-a", &text(json!({"id": id, "result": 1}))),
        Ok(()),
        "the reply after the end of the connection is an observation"
    );
    log.flush(WAIT).unwrap();
    let text = records::text_of(&records::read_events(&records::event_log_path(
        config.path(),
    )));
    let want = format!(" info host exposure: exposure reply {id} arrived after its request ended");
    assert!(text.contains(&want), "no {want:?} in {text}");
    for removed in [" ms after it was sent", "timed out"] {
        assert!(
            !text.contains(removed),
            "the log states {removed:?}: {text}"
        );
    }
    use_host_event_log(None);
}

/// The end of a connection recorded in the turn of the send ends the request the same way.
// contract: exposure.relay.connection-end-ends-its-requests
#[test]
fn a_connection_end_in_the_turn_of_the_send_ends_the_relay_request() {
    let relay = Relay::default();
    let mut requested = 0;
    let outcome = relay.request("main", |id| {
        requested = id;
        relay.end(id);
        Ok(())
    });
    assert!(
        outcome.is_err(),
        "the request whose connection ended answered a result"
    );
    assert_eq!(
        relay.reply("main", &text(json!({"id": requested, "result": 1}))),
        Ok(()),
        "the reply after the end of the connection is an observation"
    );
}

/// Starts a forward of origin to target on another thread, the way `exposureForward` relays a request that the main page
/// forwards while it handles the request origin, and returns the receiver of its outcome and the receiver of its id.
fn relay_forward(
    relay: &Arc<Relay>,
    origin: u64,
    target: &'static str,
) -> (mpsc::Receiver<Outcome>, mpsc::Receiver<u64>) {
    let (outcome, outcomes) = mpsc::channel();
    let (sent, ids) = mpsc::channel();
    let relay = relay.clone();
    std::thread::spawn(move || {
        let result = relay.request_of(origin, target, move |id| {
            sent.send(id).map_err(|error| error.to_string())
        });
        outcome.send(result).expect("the test holds the receiver");
    });
    (outcomes, ids)
}

/// `exposureForward` carries `origin`, the id of the `exposure-request` that the main page handles, as an id.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
#[test]
fn a_forward_carries_its_origin_as_an_id() {
    let request = json!({"id": 1, "surface": "tab", "method": "probe.run", "params": {}});
    let mut with_origin = request.clone();
    with_origin["origin"] = json!(7);
    assert!(serde_json::from_value::<exposure::Forward>(with_origin).is_ok());
    assert!(serde_json::from_value::<exposure::Forward>(request.clone()).is_ok());
    let mut named = request;
    named["origin"] = json!("seven");
    assert!(
        serde_json::from_value::<exposure::Forward>(named).is_err(),
        "a forward whose origin is not an id was read"
    );
}

/// Receives the end of the forward and fails when it carries a result.
fn expect_ended_without_result(outcome: &mpsc::Receiver<Outcome>, what: &str) {
    assert!(outcome.recv().unwrap().is_err(), "{what} answered a result");
}

/// Sends the reply of the surface document to the ended forward id and checks that the host writes it as the observation of an
/// ended request.
fn expect_late_reply_observed(relay: &Relay, log: &EventLog, config: &Path, id: u64) {
    assert_eq!(
        relay.reply("surface-main-a", &text(json!({"id": id, "result": 5}))),
        Ok(()),
        "the reply after the end of the origin is an observation"
    );
    log.flush(WAIT).unwrap();
    let text = records::text_of(&records::read_events(&records::event_log_path(config)));
    let want = format!(" info host exposure: exposure reply {id} arrived after its request ended");
    assert!(text.contains(&want), "no {want:?} in {text}");
}

/// The end of the connection of the request origin ends the request and with it each forward of that origin on the host,
/// which answers nothing; the reply of the surface document after it is the observation of an ended request. The ends are
/// received in any order.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
#[test]
fn the_end_of_the_connection_of_its_origin_ends_a_forward() {
    let _serial = RECORDS.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = records::start_writer(config.path());
    let relay = Arc::new(Relay::default());
    let (origin_outcome, origin_ids) = relay_request(&relay, "main");
    let origin = origin_ids.recv().unwrap();
    let (outcome, ids) = relay_forward(&relay, origin, "surface-main-a");
    let id = ids.recv().unwrap();
    assert!(
        outcome.try_recv().is_err(),
        "the forward ended before the connection of its origin ended"
    );
    relay.end(origin);
    expect_ended_without_result(&origin_outcome, "the request whose connection ended");
    expect_ended_without_result(&outcome, "the forward whose origin connection ended");
    expect_late_reply_observed(&relay, &log, config.path(), id);
    use_host_event_log(None);
}

/// The answer of the main page ends the origin request, and a forward of that origin that still waits ends then with no
/// result.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
#[test]
fn the_answer_of_its_origin_ends_a_waiting_forward() {
    let _serial = RECORDS.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = records::start_writer(config.path());
    let relay = Arc::new(Relay::default());
    let (origin_outcome, origin_ids) = relay_request(&relay, "main");
    let origin = origin_ids.recv().unwrap();
    let (outcome, ids) = relay_forward(&relay, origin, "surface-main-a");
    let id = ids.recv().unwrap();
    relay
        .reply("main", &text(json!({"id": origin, "result": 7})))
        .expect("the answer of the main page");
    assert_eq!(value(&origin_outcome.recv().unwrap().unwrap()), json!(7));
    expect_ended_without_result(&outcome, "the forward whose origin the main page answered");
    expect_late_reply_observed(&relay, &log, config.path(), id);
    use_host_event_log(None);
}

/// The end of the origin request with 1003, here by the close of the main page that runs it, ends its forward with no
/// result.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
#[test]
fn the_end_of_its_origin_with_1003_ends_a_waiting_forward() {
    let _serial = RECORDS.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = records::start_writer(config.path());
    let relay = Arc::new(Relay::default());
    let (origin_outcome, origin_ids) = relay_request(&relay, "main");
    let origin = origin_ids.recv().unwrap();
    let (outcome, ids) = relay_forward(&relay, origin, "surface-main-a");
    let id = ids.recv().unwrap();
    relay.abandon("main");
    assert_eq!(origin_outcome.recv().unwrap().unwrap_err().code, 1003);
    expect_ended_without_result(&outcome, "the forward whose origin ended with 1003");
    expect_late_reply_observed(&relay, &log, config.path(), id);
    use_host_event_log(None);
}

/// A forward without origin belongs to no connection: the end of a connection leaves it waiting, checked once the request of
/// that connection ended, and the reply of the surface ends it with that reply.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
#[test]
fn a_forward_without_origin_is_not_ended_by_a_connection_end() {
    let relay = Arc::new(Relay::default());
    let (ended_outcome, ended_ids) = relay_request(&relay, "main");
    let ended = ended_ids.recv().unwrap();
    let (outcome, ids) = relay_request(&relay, "surface-main-a");
    let id = ids.recv().unwrap();
    relay.end(ended);
    assert!(ended_outcome.recv().unwrap().is_err());
    assert!(
        outcome.try_recv().is_err(),
        "the forward without origin ended by the end of a connection"
    );
    relay
        .reply("surface-main-a", &text(json!({"id": id, "result": 5})))
        .expect("the reply of the surface");
    assert_eq!(value(&outcome.recv().unwrap().unwrap()), json!(5));
}

/// The end of one origin request ends only its own forwards: a forward of the request of another connection keeps waiting,
/// checked once the request of the ended connection ended.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
#[test]
fn the_end_of_a_connection_leaves_the_forwards_of_another_origin() {
    let relay = Arc::new(Relay::default());
    let (ended_outcome, ended_ids) = relay_request(&relay, "main");
    let ended = ended_ids.recv().unwrap();
    let (kept_outcome, kept_ids) = relay_request(&relay, "main");
    let kept = kept_ids.recv().unwrap();
    let (outcome, ids) = relay_forward(&relay, kept, "surface-main-a");
    let id = ids.recv().unwrap();
    relay.end(ended);
    assert!(ended_outcome.recv().unwrap().is_err());
    assert!(
        outcome.try_recv().is_err(),
        "the forward of the request of another connection ended"
    );
    assert!(
        kept_outcome.try_recv().is_err(),
        "the request of another connection ended"
    );
    relay
        .reply("surface-main-a", &text(json!({"id": id, "result": 5})))
        .expect("the reply of the surface");
    assert_eq!(value(&outcome.recv().unwrap().unwrap()), json!(5));
}

/// A forward whose origin names no open request, one that ended by the end of its connection or an id that the relay never
/// sent, is not sent to the surface and is refused at once with 1003, so the result does not depend on the order of the end
/// of the origin and the forward.
// contract: exposure.relay.forward-lives-while-its-origin-is-open
#[test]
fn a_forward_whose_origin_is_not_open_is_refused_without_being_sent() {
    let relay = Arc::new(Relay::default());
    let (origin_outcome, origin_ids) = relay_request(&relay, "main");
    let ended = origin_ids.recv().unwrap();
    relay.end(ended);
    assert!(origin_outcome.recv().unwrap().is_err());
    for origin in [ended, ended + 100] {
        let mut sent = false;
        let failure = relay
            .request_of(origin, "surface-main-a", |_| {
                sent = true;
                Ok(())
            })
            .unwrap_err();
        assert_eq!(
            (failure.code, failure.message),
            (1003, format!("the origin request {origin} has ended"))
        );
        assert!(
            !sent,
            "the forward of origin {origin} was sent to the surface"
        );
    }
}

// contract: exposure.list.host-owner-without-page
#[test]
fn the_exposure_list_of_the_host_owner_does_not_ask_the_page() {
    let not_ready = || -> Result<Box<RawValue>, soksak_host::endpoint::Failure> {
        panic!("the exposure list of the host owner asked the page")
    };
    let params = json!({"window": "main", "owner": "host"});
    let listed = value(&exposure::exposure_list(params.as_object().unwrap(), not_ready).unwrap());
    let entries: Vec<&Value> = listed["status"]
        .as_array()
        .unwrap()
        .iter()
        .chain(listed["commands"].as_array().unwrap())
        .collect();
    for entry in &entries {
        assert!(
            entry["name"].as_str().unwrap().starts_with("host.") && entry["registered"] == true,
            "entry {entry} in the host list"
        );
    }
    assert!(entries.iter().any(|entry| entry["name"] == "host.quit"));
    // The host declares no element entry, so the host list holds an empty element.
    let members: Vec<&String> = listed.as_object().unwrap().keys().collect();
    assert_eq!(members, ["commands", "element", "status"], "{listed}");
    assert_eq!(listed["element"], json!([]));
    let other = json!({"window": "main", "owner": "core"});
    let failure = exposure::exposure_list(other.as_object().unwrap(), not_ready).unwrap_err();
    assert_eq!(failure.message, "exposure.list owner must be host");
}

// contract: exposure.list.appends-host-entries-registered, exposure.list.host-entries-exact-sorted-set, exposure.list.host-entries-described, exposure.list.host-quit-result-null, exposure.list.non-object-list-rejected
#[test]
fn host_entries_are_appended_as_registered() {
    let listed = value(
        &exposure::with_host_entries(&text(json!({
            "status": [{"name": "core.layout", "description": "Layout.", "schema": {}, "registered": true}],
            "commands": [],
            "element": [],
        })))
        .unwrap(),
    );
    // The list keeps the members of the page's list: status, commands and element.
    let members: Vec<&String> = listed.as_object().unwrap().keys().collect();
    assert_eq!(members, ["commands", "element", "status"], "{listed}");
    assert_eq!(listed["element"], json!([]));
    let status: Vec<&str> = listed["status"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        status,
        [
            "core.layout",
            "host.buttons",
            "host.dock",
            "host.log",
            "host.menu",
            "host.screens",
            "host.sidecars",
            "host.window",
            "host.windows"
        ]
    );
    let commands: Vec<&str> = listed["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        commands,
        [
            "host.dock.select",
            "host.hit",
            "host.menu.select",
            "host.quit",
            "host.window.close",
            "host.window.fullscreen",
            "host.window.maximize",
            "host.window.move",
            "host.window.presented",
            "host.window.reload",
            "host.window.resize",
        ]
    );
    for entry in listed["status"]
        .as_array()
        .unwrap()
        .iter()
        .chain(listed["commands"].as_array().unwrap())
    {
        assert_eq!(entry["registered"], true);
        assert!(entry["description"].as_str().is_some_and(|d| !d.is_empty()));
    }
    let quit = listed["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "host.quit")
        .unwrap();
    assert_eq!(quit["result"], json!({"type": "null"}));
    assert!(exposure::with_host_entries(&text(json!([]))).is_err());
    // The page entries remain as the received text.
    let kept = exposure::with_host_entries(&text_of(r#"{"element":[],"commands":[],"status":[{"name":"core.layout","schema":{},"description":"Layout."}]}"#)).unwrap();
    assert!(
        kept.get()
            .contains(r#"{"name":"core.layout","schema":{},"description":"Layout."}"#),
        "{}",
        kept.get()
    );
}

// contract: exposure.list.host-hit-kinds
#[test]
fn host_hit_declares_the_workbench_document_and_native_kinds() {
    let not_ready = || -> Result<Box<RawValue>, soksak_host::endpoint::Failure> {
        panic!("the exposure list of the host owner asked the page")
    };
    let params = json!({"window": "main", "owner": "host"});
    let listed = value(&exposure::exposure_list(params.as_object().unwrap(), not_ready).unwrap());
    let hit = listed["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "host.hit")
        .expect("host.hit is listed");
    assert_eq!(
        hit["result"]["properties"]["kind"]["enum"],
        json!(["workbench", "document", "native"])
    );
}

// contract: endpoint.input.pointer-invalid-phase, endpoint.input.pointer-missing-coordinate, endpoint.input.pointer-numeric-button-rejected, endpoint.input.pointer-middle-button-rejected, endpoint.input.pointer-clicks-range, endpoint.input.pointer-clicks-only-on-press-and-release, endpoint.input.pointer-clicks-default, endpoint.input.pointer-unknown-field-rejected, endpoint.input.pointer-activate-only-on-move, endpoint.input.pointer-activate-must-be-bool, endpoint.input.pointer-defaults, endpoint.input.pointer-right-button-accepted, endpoint.input.pointer-phase-and-scroll-decoding, endpoint.input.pointer-name, endpoint.input.key-unknown-modifier-rejected, endpoint.input.key-shift-command-mask, endpoint.input.key-control-option-and-text, endpoint.input.key-invalid-phase-or-modifier-type
#[test]
fn pointer_and_key_params_are_validated() {
    let pointer = exposure::pointer(
        &json!({"x": 1.5, "y": 2, "phase": "drag"})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(
        (pointer.x, pointer.y, pointer.phase, pointer.button),
        (1.5, 2.0, 2, 0)
    );
    let scroll = exposure::pointer(
        &json!({"x": 0, "y": 0, "phase": "scroll", "deltaY": -3, "button": "right"})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!((scroll.phase, scroll.button, scroll.delta_y), (4, 1, -3.0));
    assert_eq!(
        exposure::pointer(
            &json!({"x": 0, "y": 0, "phase": "press"})
                .as_object()
                .unwrap()
                .clone()
        )
        .unwrap_err()
        .code,
        -32602
    );
    assert_eq!(
        exposure::pointer(
            &json!({"y": 0, "phase": "move"})
                .as_object()
                .unwrap()
                .clone()
        )
        .unwrap_err()
        .code,
        -32602
    );
    let moved = exposure::pointer(
        &json!({"x": 0, "y": 0, "phase": "move", "activate": true})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert!(moved.activate);
    assert!(!pointer.activate);
    assert_eq!((pointer.clicks, moved.clicks), (1, 1));
    assert_eq!(pointer.pointer, "main");
    for name in ["second-1".to_string(), "p".repeat(32)] {
        let named = exposure::pointer(
            &json!({"x": 7, "y": 8, "phase": "down", "pointer": name})
                .as_object()
                .unwrap()
                .clone(),
        )
        .unwrap();
        assert_eq!(named.pointer, name);
    }
    for (phase, clicks) in [("down", 2), ("up", 3)] {
        let press = exposure::pointer(
            &json!({"window": "main", "x": 0, "y": 0, "phase": phase, "clicks": clicks})
                .as_object()
                .unwrap()
                .clone(),
        )
        .unwrap();
        assert_eq!(press.clicks, clicks);
    }
    for params in [
        json!({"x": 0, "y": 0, "phase": "down", "activate": true}),
        json!({"x": 0, "y": 0, "phase": "move", "activate": "yes"}),
        json!({"x": 0, "y": 0, "phase": "down", "button": "middle"}),
        json!({"x": 0, "y": 0, "phase": "down", "button": 1}),
        json!({"x": 0, "y": 0, "phase": "down", "clicks": 0}),
        json!({"x": 0, "y": 0, "phase": "down", "clicks": -1}),
        json!({"x": 0, "y": 0, "phase": "down", "clicks": 4}),
        json!({"x": 0, "y": 0, "phase": "down", "clicks": 1.5}),
        json!({"x": 0, "y": 0, "phase": "down", "clicks": "2"}),
        json!({"x": 0, "y": 0, "phase": "move", "clicks": 2}),
        json!({"x": 0, "y": 0, "phase": "drag", "clicks": 2}),
        json!({"x": 0, "y": 0, "phase": "scroll", "clicks": 2}),
        json!({"x": 0, "y": 0, "phase": "down", "clickCount": 2}),
        json!({"x": 0, "y": 0, "phase": "down", "Clicks": 2}),
        json!({"x": 0, "y": 0, "phase": "down", "pointer": ""}),
        json!({"x": 0, "y": 0, "phase": "down", "pointer": "Second"}),
        json!({"x": 0, "y": 0, "phase": "down", "pointer": "a b"}),
        json!({"x": 0, "y": 0, "phase": "down", "pointer": "p".repeat(33)}),
        json!({"x": 0, "y": 0, "phase": "down", "pointer": 2}),
    ] {
        assert_eq!(
            exposure::pointer(params.as_object().unwrap())
                .unwrap_err()
                .code,
            -32602,
            "{params}"
        );
    }

    let key = exposure::key(
        &json!({"key": "Enter", "phase": "down", "modifiers": ["shift", "command"]})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(
        (key.key.as_str(), key.text, key.modifiers, key.down),
        ("Enter", None, 9, true)
    );
    let key = exposure::key(
        &json!({"key": "a", "text": "A", "phase": "up", "modifiers": ["control", "option"]})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(
        (key.text.as_deref(), key.modifiers, key.down),
        (Some("A"), 6, false)
    );
    assert_eq!(
        exposure::key(
            &json!({"key": "a", "phase": "down", "modifiers": 2})
                .as_object()
                .unwrap()
                .clone()
        )
        .unwrap_err()
        .code,
        -32602
    );
    assert_eq!(
        exposure::key(
            &json!({"key": "a", "phase": "hold"})
                .as_object()
                .unwrap()
                .clone()
        )
        .unwrap_err()
        .code,
        -32602
    );
    assert_eq!(
        exposure::key(
            &json!({"key": "a", "phase": "down", "modifiers": ["hyper"]})
                .as_object()
                .unwrap()
                .clone()
        )
        .unwrap_err()
        .code,
        -32602
    );
}

// contract: endpoint.input.key-empty-text-types-the-key
#[test]
fn a_key_with_empty_text_types_its_key_name() {
    let key = exposure::key(
        &json!({"key": "Enter", "text": "", "phase": "down"})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(
        (key.key.as_str(), key.text),
        ("Enter", None),
        "an empty text is no text: the key name gives the characters of the event"
    );
}

// contract: endpoint.input.pointer-button-held-message
#[test]
fn button_held_message_reports_mask_and_frontmost_application() {
    let cases = [
        (
            exposure::ButtonHeld {
                mask: 0x1,
                frontmost: Some(exposure::FrontmostApplication {
                    bundle_identifier: Some("com.example.editor".to_string()),
                    pid: 412,
                }),
            },
            "AppKit reports NSEvent.pressedMouseButtons mask 0x1 while com.example.editor (pid 412) is frontmost; the synthetic press or release was not delivered",
        ),
        (
            exposure::ButtonHeld {
                mask: 0x3,
                frontmost: Some(exposure::FrontmostApplication {
                    bundle_identifier: None,
                    pid: 77,
                }),
            },
            "AppKit reports NSEvent.pressedMouseButtons mask 0x3 while an application without a bundle identifier (pid 77) is frontmost; the synthetic press or release was not delivered",
        ),
        (
            exposure::ButtonHeld {
                mask: 0x1a,
                frontmost: None,
            },
            "AppKit reports NSEvent.pressedMouseButtons mask 0x1a while no application is frontmost; the synthetic press or release was not delivered",
        ),
    ];
    for (held, want) in cases {
        assert_eq!(exposure::button_held_message(&held), want, "{held:?}");
    }
}

// contract: endpoint.input.pointer-held-message
#[test]
fn pointer_held_message_names_the_holding_pointer_and_its_reason() {
    let held = exposure::PointerHeld {
        pointer: "second".to_string(),
        reason: "the page at the point holds its press".to_string(),
    };
    assert_eq!(
        exposure::pointer_held_message(&held),
        "pointer second holds a press that this input would share: the page at the point holds its press"
    );
}

// contract: endpoint.names.unknown-host-name-1001
#[test]
fn undeclared_host_names_are_unknown() {
    for (method, name) in [
        ("command.run", "host.nope"),
        ("status.get", "host.nope"),
        ("command.run", "host.window"),
        // The host declares no element entry, so an element request for a host name is an unknown name.
        ("element.rect", "host.buttons"),
        ("element.act", "host.window"),
    ] {
        let failure = exposure::check_host_name(method, name).unwrap_err();
        assert_eq!(failure.code, 1001, "{method} {name}: {}", failure.message);
    }
    for (method, name) in [
        ("status.get", "host.window"),
        ("status.watch", "host.windows"),
        ("command.run", "host.quit"),
    ] {
        assert!(
            exposure::check_host_name(method, name).is_ok(),
            "{method} {name}"
        );
    }
}

// contract: exposure.window.dropped-view-work-reports-no-view
#[test]
fn view_work_dropped_by_a_closing_webview_reports_no_result() {
    let (tx, rx) = std::sync::mpsc::channel::<Result<u64, String>>();
    drop(tx);
    assert_eq!(exposure::received(&rx), Ok(None));
    let (tx, rx) = std::sync::mpsc::channel::<Result<u64, String>>();
    tx.send(Ok(7)).unwrap();
    assert_eq!(exposure::received(&rx), Ok(Some(7)));
    let (tx, rx) = std::sync::mpsc::channel::<Result<u64, String>>();
    tx.send(Err("view failed".into())).unwrap();
    assert_eq!(exposure::received(&rx), Err("view failed".into()));
}

// The host.windows list entries leave out a window whose close was accepted, and report the lookup failure of another
// window as an error.
// contract: exposure.windows.closing-window-omitted
#[test]
fn a_closing_window_is_left_out_without_querying_it() {
    let entry = window_entry(
        "w2",
        true,
        true,
        String::new(),
        || panic!("the title of a closing window was queried"),
        || panic!("the focus of a closing window was queried"),
    );
    assert_eq!(entry, Ok(None));
}

// contract: exposure.windows.open-window-query-failure-reported
#[test]
fn a_failed_query_of_an_open_window_is_reported() {
    let entry = window_entry(
        "main",
        false,
        true,
        String::new(),
        || Err("runtime error: failed to receive message from webview".into()),
        || Ok(true),
    );
    assert_eq!(
        entry,
        Err("runtime error: failed to receive message from webview".into())
    );
}

// contract: exposure.windows.entry-fields
#[test]
fn an_open_window_lists_its_title_project_and_key_state() {
    let entry = window_entry(
        "main",
        false,
        true,
        "/tmp/project".into(),
        || Ok("project".into()),
        || Ok(false),
    );
    assert_eq!(
        entry,
        Ok(Some(json!({
            "ready": true, "window": "main", "title": "project",
            "project": "/tmp/project", "key": false,
        })))
    );
}

/// The main thread of the test. Work that another thread sent is run in order before the main thread handles the next
/// work.
#[derive(Default)]
struct FakeMain {
    pending: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
    running: AtomicBool,
}

impl FakeMain {
    fn run_pending(&self) {
        let tasks = std::mem::take(&mut *self.pending.lock().unwrap());
        for task in tasks {
            task();
        }
    }

    /// Like send_user_message of tauri-runtime-wry, it answers at once on the main thread, and on another thread it
    /// answers after the work sent earlier was handled.
    fn query<T>(&self, answer: impl FnOnce() -> T) -> T {
        if !self.running.load(Ordering::SeqCst) {
            self.run_pending();
        }
        answer()
    }

    fn run(&self, step: ListStep) -> Result<Vec<Value>, String> {
        self.run_pending();
        self.running.store(true, Ordering::SeqCst);
        let result = step();
        self.running.store(false, Ordering::SeqCst);
        self.run_pending();
        result
    }
}

/// A window of the test. A close sets closing like the runtime and then removes the window from the runtime.
struct FakeWindow {
    label: &'static str,
    closing: AtomicBool,
    present: AtomicBool,
    /// When closing is read, it sends the close of this window to the main thread.
    close_on_read: AtomicBool,
}

impl FakeWindow {
    fn open(label: &'static str, close_on_read: bool) -> Arc<Self> {
        Arc::new(Self {
            label,
            closing: AtomicBool::new(false),
            present: AtomicBool::new(true),
            close_on_read: AtomicBool::new(close_on_read),
        })
    }
}

fn fake_list(main: &Arc<FakeMain>, windows: &[Arc<FakeWindow>]) -> Result<Value, String> {
    let queries = main.clone();
    list_entries(
        windows.to_vec(),
        |step| main.run(step),
        move |window: &Arc<FakeWindow>| {
            let closing = window.closing.load(Ordering::SeqCst);
            if window.close_on_read.swap(false, Ordering::SeqCst) {
                let closed = window.clone();
                queries.pending.lock().unwrap().push(Box::new(move || {
                    closed.closing.store(true, Ordering::SeqCst);
                    closed.present.store(false, Ordering::SeqCst);
                }));
            }
            let present = || {
                if window.present.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err("runtime error: failed to receive message from webview".to_string())
                }
            };
            window_entry(
                window.label,
                closing,
                true,
                String::new(),
                || queries.query(|| present().map(|()| window.label.to_string())),
                || queries.query(|| present().map(|()| false)),
            )
        },
    )
}

// host.windows reads the closing, the title and the focus of a window in one main-thread step. A close that the main
// thread handled during the list only removes that window from the list or puts it in, and does not make the list fail.
// contract: exposure.windows.listed-in-one-main-thread-step
#[test]
fn a_close_during_the_list_does_not_fail_the_list() {
    let main = Arc::new(FakeMain::default());
    let windows = [
        FakeWindow::open("main", false),
        FakeWindow::open("w2", true),
    ];
    let entry = |label: &str| json!({"ready": true, "window": label, "title": label, "project": null, "key": false});
    assert_eq!(
        fake_list(&main, &windows),
        Ok(json!([entry("main"), entry("w2")]))
    );
    assert!(windows[1].closing.load(Ordering::SeqCst));
    assert_eq!(fake_list(&main, &windows), Ok(json!([entry("main")])));
}

// contract: exposure.status-change.refuses-host-name
#[test]
fn a_page_status_change_of_a_host_status_is_refused() {
    assert_eq!(
        soksak_host::exposure::check_page_status_change("host.window"),
        Err("the page cannot change host status host.window".to_string())
    );
    assert_eq!(
        soksak_host::exposure::check_page_status_change("core.grid"),
        Ok(())
    );
}

// contract: exposure.host-window.unregistered-surface-named
#[test]
fn an_unregistered_native_surface_view_fails_with_its_address() {
    let named = HashMap::from([(7usize, "tab-2".to_string())]);
    assert_eq!(exposure::registered_surface(&named, 7).unwrap(), "tab-2");
    let error = exposure::registered_surface(&named, 9).unwrap_err();
    assert_eq!(error, "unregistered native surface 9");
}

/// The records of the host are process-wide, so the tests that attach a writer of events run one at a time.
static RECORDS: Mutex<()> = Mutex::new(());

/// The fields of the events named event that the writer stored.
fn call_events(log: &EventLog, config: &Path, event: &str) -> Vec<Value> {
    log.flush(WAIT).unwrap();
    records::read_events(&records::event_log_path(config))
        .into_iter()
        .filter(|record| record["event"] == event)
        .map(|record| record["fields"].clone())
        .collect()
}

// contract: view.exposure.register
// The caller of a registration is either the page view of the surface itself or the main page of the window registering
// for a surface with a view (docs/spec/exposure.md#relay).
#[test]
fn a_registration_caller_is_the_surface_page_or_the_main_page_of_a_view() {
    // The page view of the surface itself.
    assert_eq!(
        exposure::check_registration_caller("surface-main-a", "surface-main-a", "a", false, false),
        Ok(())
    );
    // The page view of another surface is refused.
    assert_eq!(
        exposure::check_registration_caller("surface-main-b", "surface-main-a", "a", false, true),
        Err("surface-main-b cannot register for surface a".to_string())
    );
    // The main page of the window registers for a surface with a view.
    assert_eq!(
        exposure::check_registration_caller("main", "surface-main-a", "a", true, true),
        Ok(())
    );
    // It is refused for a surface without a view, and so is an unknown caller.
    assert_eq!(
        exposure::check_registration_caller("main", "surface-main-a", "a", true, false),
        Err("main cannot register for surface a".to_string())
    );
    assert_eq!(
        exposure::check_registration_caller("unknown", "surface-main-a", "a", false, true),
        Err("unknown cannot register for surface a".to_string())
    );
}

// contract: view.exposure.register
// A relayed registration takes the kind status, command or element; the removed kind dom and any other kind are refused.
#[test]
fn a_registration_kind_is_status_command_or_element() {
    for kind in ["status", "command", "element"] {
        assert_eq!(exposure::check_registration_kind(kind), Ok(()), "{kind}");
    }
    for kind in ["dom", "entry"] {
        assert_eq!(
            exposure::check_registration_kind(kind),
            Err(format!("unknown exposure kind {kind}"))
        );
    }
}
