use super::{
    ViewChannels, ViewIngress, accept_view_message, register_view_source,
    retire_view_before_replacement,
};
use crate::event_record::buffered_fields;
use crate::windows::{DeclaredSourceEvent, WindowData};
use std::sync::{Arc, Mutex, PoisonError};
use tauri::ipc::{Channel, InvokeResponseBody};

// contract: view.origin.retired-callback-is-cancelled
#[test]
fn a_retired_view_callback_is_cancelled_before_dispatch() {
    let channels = ViewChannels::default();
    let retired = channels.register_origin("surface", "probe", 1);
    let _current = channels.register_origin("surface", "probe", 2);

    let mut dispatches = 0;
    if accept_view_message(
        &channels,
        "probe",
        "surface",
        &retired,
        r#"{"message":{"sok":1,"id":7,"command":"probe.run","params":{}}}"#,
    ) {
        dispatches += 1;
    }
    assert_eq!(dispatches, 0, "the retired call does not reach dispatch");
    assert_eq!(
        channels.ingress(
            "surface",
            &retired,
            r#"{"message":{"sok":1,"id":7,"command":"probe.run","params":{}}}"#
        ),
        ViewIngress::Cancelled
    );
    assert!(
        buffered_fields("host.trace.view.callback-cancelled")
            .iter()
            .any(|fields| fields["surface"] == "surface" && fields["reason"] == "retired-origin"),
        "the canceled callback has a trace record"
    );
}

mod view_decode {
    use super::super::{ViewChannels, ViewDispatch};
    use serde_json::json;

    #[test]
    fn a_current_view_envelope_is_decoded_once_for_every_dispatch_kind() {
        for message in [
            json!({"reply": 1, "result": {"items": [1, 2, 3]}}),
            json!({"id": 2, "command": "probe.run", "params": {"items": [1, 2, 3]}}),
            json!({"event": "declared-ui.snapshot", "plugin": "probe", "status": "state", "seq": 1, "skipped": 0, "value": {"items": [1, 2, 3]}}),
            json!({"event": "view.ready", "plugin": "probe", "document": "doc-1"}),
        ] {
            let channels = ViewChannels::default();
            channels.register("surface", "probe", 1);
            let value = json!({"message": message}).to_string();
            let mut decodes = 0;
            let result = channels.dispatch_with_decoder("surface", &value, |text| {
                decodes += 1;
                if decodes > 1 {
                    return Err("a second envelope decode is forbidden".to_string());
                }
                serde_json::from_str(text).map_err(|error| error.to_string())
            });
            assert!(result.is_ok(), "{message}: {result:?}");
            assert_eq!(decodes, 1, "{message}");
            match result.unwrap() {
                ViewDispatch::Reply(payload) => assert_eq!(payload["result"], message["result"]),
                ViewDispatch::Call(payload) => assert_eq!(payload["params"], message["params"]),
                ViewDispatch::Snapshot(payload) => assert_eq!(payload["value"], message["value"]),
                ViewDispatch::Ready(ready) => assert_eq!(ready, Ok(true)),
            }
        }
    }

    #[test]
    fn view_dispatch_preserves_precedence_and_invalid_field_errors() {
        let channels = ViewChannels::default();
        channels.register("surface", "probe", 1);
        let forwarded = channels
            .dispatch(
                "surface",
                r#"{"message":{"reply":1,"result":{"kept":true},"command":"probe.run","id":2}}"#,
            )
            .unwrap();
        assert!(matches!(forwarded, ViewDispatch::Reply(_)));
        let canceled = channels
            .dispatch(
                "surface",
                r#"{"message":{"id":2,"command":null,"cancel":true}}"#,
            )
            .unwrap();
        assert!(matches!(canceled, ViewDispatch::Call(value) if value["cancel"] == true));
        let ready = channels.dispatch("surface", r#"{"message":{"command":null,"cancel":null,"event":"view.ready","plugin":"probe","document":"doc-1"}}"#);
        assert_eq!(ready, Ok(ViewDispatch::Ready(Ok(true))));
        let invalid = channels
            .dispatch(
                "surface",
                r#"{"message":{"reply":null,"command":"probe.run","id":2}}"#,
            )
            .unwrap_err();
        assert!(
            invalid.contains("view reply has no integer id"),
            "{invalid}"
        );
        let invalid = channels.dispatch("surface", "not JSON").unwrap_err();
        assert!(invalid.contains("view message is not JSON"), "{invalid}");
        let overflow = channels.dispatch(
            "surface",
            r#"{"message":{"event":"view.error","plugin":"probe","reason":"queue full for probe"}}"#,
        );
        assert_eq!(
            overflow,
            Ok(ViewDispatch::Ready(Err("queue full for probe".to_string())))
        );
    }

    #[test]
    fn a_view_call_transfers_the_owned_params_tree_without_copying_it() {
        let channels = ViewChannels::default();
        channels.register("surface", "probe", 1);
        let params = json!({"items": [{"text": "kept parameter allocation"}]});
        let pointer = params["items"][0]["text"].as_str().unwrap().as_ptr() as usize;
        let mut message = json!({"id": 7, "command": "probe.run", "cids": ["cause-1"]});
        message["params"] = params;
        let payload = channels
            .call_received(
                "surface",
                super::super::ViewReceived {
                    message: Some(message),
                    error: None,
                },
            )
            .expect("valid call")
            .expect("forwarded call");
        assert_eq!(
            payload["params"]["items"][0]["text"],
            "kept parameter allocation"
        );
        assert_eq!(
            payload["params"]["items"][0]["text"]
                .as_str()
                .unwrap()
                .as_ptr() as usize,
            pointer,
            "forwarding must transfer the decoded params tree without copying it"
        );
        assert_eq!(payload["cids"], json!(["cause-1"]));
        assert_eq!(
            channels.end_calls("surface"),
            vec![("probe".to_string(), "probe.run".to_string())]
        );
        for message in [
            json!({"id": 8, "command": "probe.run"}),
            json!({"id": 9, "command": "probe.run", "params": null}),
        ] {
            let payload = channels
                .call_received(
                    "surface",
                    super::super::ViewReceived {
                        message: Some(message),
                        error: None,
                    },
                )
                .expect("valid default params")
                .expect("forwarded default params");
            assert_eq!(payload["params"], serde_json::Value::Null);
            assert!(payload.get("cids").is_none());
        }
    }
}

// contract: view.origin.current-callback-is-dispatched
#[test]
fn a_current_view_callback_enters_dispatch() {
    let channels = ViewChannels::default();
    let current = channels.register_origin("surface", "probe", 1);

    assert!(accept_view_message(
        &channels,
        "probe",
        "surface",
        &current,
        r#"{"message":{"sok":1,"id":7,"command":"probe.run","params":{}}}"#,
    ));
}

// contract: view.origin.retired-producer-error-is-preserved
#[test]
fn a_retired_view_error_keeps_its_producer_reason() {
    let channels = ViewChannels::default();
    let retired = channels.register_origin("surface", "probe", 1);
    let _current = channels.register_origin("surface", "probe", 2);

    let before = buffered_fields("host.record.error").len();
    assert!(
        !accept_view_message(
            &channels,
            "probe",
            "surface",
            &retired,
            r#"{"message":{"event":"view.error","plugin":"probe","reason":"uncaught error: origin-test"}}"#,
        ),
        "a retired error does not enter the current channel"
    );
    assert!(
        buffered_fields("host.record.error")[before..]
            .iter()
            .any(|fields| {
                fields["where"] == "view probe surface"
                    && fields["text"] == "uncaught error: origin-test"
            }),
        "the retired producer error keeps its captured plugin and surface"
    );
}

// contract: view.channel.overflow-closes
#[test]
fn a_retired_queue_overflow_does_not_fail_the_current_view() {
    let channels = ViewChannels::default();
    let retired = channels.register_origin("surface", "probe", 1);
    let current = channels.register_origin("surface", "probe", 2);

    assert!(!accept_view_message(
        &channels,
        "probe",
        "surface",
        &retired,
        r#"{"message":{"event":"view.error","reason":"queue full for probe"}}"#,
    ));
    assert!(
        channels.is_current("surface", &current),
        "a queue overflow from the retired origin leaves its replacement current"
    );
}

// contract: view.call.reply-generation-scoped-cleanup
#[test]
fn a_late_view_reply_cannot_remove_a_replacement_calls_record() {
    let channels = ViewChannels::default();
    channels.register("surface", "probe", 1);
    channels
        .call(
            "surface",
            r#"{"message":{"sok":1,"id":7,"command":"runtime.native.call","params":{}}}"#,
        )
        .expect("the old view call is accepted");
    channels.register("surface", "probe", 2);
    channels
        .call(
            "surface",
            r#"{"message":{"sok":1,"id":7,"command":"runtime.native.call","params":{}}}"#,
        )
        .expect("the replacement view call is accepted");
    assert_eq!(
        channels
            .lock()
            .get("surface")
            .expect("the replacement view remains registered")
            .calls
            .get(&7)
            .map(String::as_str),
        Some("runtime.native.call")
    );

    channels.answer_call("surface", 1, 7);

    assert_eq!(
        channels.end_calls("surface"),
        [("probe".to_string(), "runtime.native.call".to_string())],
        "a reply from the old view removed the replacement call"
    );
}

// contract: view.origin.retired-channel-errors-are-reported
#[test]
fn a_retired_malformed_message_keeps_its_channel_error() {
    let channels = ViewChannels::default();
    let retired = channels.register_origin("surface", "probe", 1);
    let _current = channels.register_origin("surface", "probe", 2);
    let before = buffered_fields("host.record.error").len();

    assert!(!accept_view_message(
        &channels,
        "probe",
        "surface",
        &retired,
        "{malformed",
    ));

    assert!(
        buffered_fields("host.record.error")[before..]
            .iter()
            .any(|fields| {
                fields["where"] == "view channel"
                    && fields["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("surface: view message is not JSON"))
            })
    );
}

// contract: view.origin.retired-channel-errors-are-reported
#[test]
fn a_retired_transport_error_keeps_its_channel_error() {
    let channels = ViewChannels::default();
    let retired = channels.register_origin("surface", "probe", 1);
    let _current = channels.register_origin("surface", "probe", 2);
    let before = buffered_fields("host.record.error").len();

    assert!(!accept_view_message(
        &channels,
        "probe",
        "surface",
        &retired,
        r#"{"error":"native producer failed"}"#,
    ));

    assert!(
        buffered_fields("host.record.error")[before..]
            .iter()
            .any(|fields| fields["where"] == "view channel"
                && fields["text"] == "native producer failed")
    );
}

// contract: view.origin.retired-malformed-envelope-is-reported
#[test]
fn a_retired_malformed_envelope_keeps_its_channel_error() {
    for (value, expected) in [
        (
            r#"{"unexpected":true}"#,
            "surface: view message has neither message nor error",
        ),
        (
            r#"{"message":"not-an-object"}"#,
            "surface: view event is not an object",
        ),
    ] {
        let channels = ViewChannels::default();
        let retired = channels.register_origin("surface", "probe", 1);
        let _current = channels.register_origin("surface", "probe", 2);
        let before = buffered_fields("host.record.error").len();

        assert!(!accept_view_message(
            &channels, "probe", "surface", &retired, value,
        ));

        assert!(
            buffered_fields("host.record.error")[before..]
                .iter()
                .any(|fields| {
                    fields["where"] == "view channel"
                        && fields["text"]
                            .as_str()
                            .is_some_and(|text| text.contains(expected))
                })
        );
    }
}

// contract: view.process-end-precedes-replacement-registration
#[test]
fn a_view_process_end_retires_its_origin_before_replacement_registration() {
    let data = WindowData::default();
    let received = Arc::new(Mutex::new(Vec::<DeclaredSourceEvent>::new()));
    let destination = received.clone();
    data.declared_source_events
        .install(Channel::new(move |body| {
            let InvokeResponseBody::Json(value) = body else {
                panic!("declared source event uses a raw channel payload");
            };
            let event = serde_json::from_str(&value)
                .expect("the channel payload is a declared source event");
            destination
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(event);
            Ok(())
        }));

    let old_generation = data
        .declared_source_origins
        .issue_view("probe-surface")
        .unwrap();
    let old_origin =
        data.documents
            .views()
            .register_origin("probe-surface", "probe", old_generation);
    let mut replacement_generation = None;
    retire_view_before_replacement(
        &data,
        "probe-surface",
        "probe",
        &old_origin,
        || {
            let events = received
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            assert_eq!(
                events,
                vec![DeclaredSourceEvent {
                    name: "declared-ui-source-ended".into(),
                    value: serde_json::json!({
                        "plugin": "probe",
                        "surface": "probe-surface",
                        "generation": old_generation
                    }),
                }]
            );
        },
        || {
            assert_eq!(
                data.declared_source_origins.current_view("probe-surface"),
                None
            );
            assert_eq!(data.documents.views().generation("probe-surface"), None);
            let replacement = register_view_source(
                &data.declared_source_origins,
                data.documents.views(),
                &data.declared_source_events,
                "probe-surface",
                "probe",
            )
            .expect("the replacement source is registered");
            replacement_generation = Some(replacement.generation);
        },
    );

    let replacement_generation = replacement_generation.expect("replacement registration ran");
    let events = received
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    assert_eq!(
        events,
        vec![
            DeclaredSourceEvent {
                name: "declared-ui-source-ended".into(),
                value: serde_json::json!({
                    "plugin": "probe",
                    "surface": "probe-surface",
                    "generation": old_generation
                }),
            },
            DeclaredSourceEvent {
                name: "view-process-ended".into(),
                value: serde_json::json!({
                    "surface": "probe-surface",
                    "generation": old_generation
                }),
            },
            DeclaredSourceEvent {
                name: "declared-ui-source-registered".into(),
                value: serde_json::json!({
                    "plugin": "probe",
                    "surface": "probe-surface",
                    "generation": replacement_generation
                }),
            },
        ]
    );
    assert!(replacement_generation > old_generation);
    assert_eq!(
        data.declared_source_origins.current_view("probe-surface"),
        Some(replacement_generation)
    );
    assert_eq!(
        data.documents.views().generation("probe-surface"),
        Some(replacement_generation)
    );
}
