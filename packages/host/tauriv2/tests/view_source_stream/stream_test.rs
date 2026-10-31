use super::{ViewSourceEvent, ViewSourceEventStream};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};

fn test_channel(target: Arc<Mutex<Vec<ViewSourceEvent>>>) -> Channel<ViewSourceEvent> {
    Channel::new(move |body| {
        let InvokeResponseBody::Json(value) = body else {
            panic!("view source event uses a raw channel payload");
        };
        let event =
            serde_json::from_str(&value).expect("the channel payload is a view source event");
        target
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(event);
        Ok(())
    })
}

// contract: view-source-stream.follows-channel-call-order
#[test]
fn source_events_are_sent_to_the_current_channel_in_call_order() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let stream = ViewSourceEventStream::default();
    stream.install(test_channel(events.clone()));

    stream
        .send(
            "view-source-registered",
            json!({"plugin":"probe","generation":4}),
        )
        .expect("source registration is sent");
    stream
        .send(
            "view-reply",
            json!({"plugin":"probe","generation":4,"id":6}),
        )
        .expect("host reply is sent");
    stream
        .send("view-call", json!({"plugin":"probe","generation":4,"id":7}))
        .expect("host call is sent");

    assert_eq!(
        *events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        vec![
            ViewSourceEvent {
                name: "view-source-registered".into(),
                value: json!({"plugin":"probe","generation":4}),
            },
            ViewSourceEvent {
                name: "view-reply".into(),
                value: json!({"plugin":"probe","generation":4,"id":6}),
            },
            ViewSourceEvent {
                name: "view-call".into(),
                value: json!({"plugin":"probe","generation":4,"id":7}),
            },
        ]
    );
}

// contract: view-source-stream.channel-registers-and-retires
#[test]
fn a_new_main_page_channel_retires_the_previous_channel() {
    let old_events = Arc::new(Mutex::new(Vec::new()));
    let current_events = Arc::new(Mutex::new(Vec::new()));
    let stream = ViewSourceEventStream::default();
    stream.install(test_channel(old_events.clone()));
    stream.install(test_channel(current_events.clone()));

    stream
        .send(
            "view-source-ended",
            json!({"plugin":"probe","generation":4}),
        )
        .expect("the current channel receives source end");

    assert!(
        old_events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty()
    );
    assert_eq!(
        current_events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_slice(),
        &[ViewSourceEvent {
            name: "view-source-ended".into(),
            value: json!({"plugin":"probe","generation":4}),
        }]
    );
}

// contract: view-source-stream.channel-registers-and-retires
// contract: view-source-stream.requires-current-channel
#[test]
fn a_page_reload_retires_the_channel_until_the_replacement_is_installed() {
    let old_events = Arc::new(Mutex::new(Vec::new()));
    let current_events = Arc::new(Mutex::new(Vec::new()));
    let stream = ViewSourceEventStream::default();
    stream.install(test_channel(old_events.clone()));
    stream.retire();

    assert_eq!(
        stream.send("view-source-registered", json!({"generation":5})),
        Err("view source event channel is not registered".into())
    );
    stream.install(test_channel(current_events.clone()));
    stream
        .send("view-source-registered", json!({"generation":6}))
        .expect("the replacement page receives its source registration");

    assert!(
        old_events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty()
    );
    assert_eq!(
        current_events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len(),
        1
    );
}

// contract: view-source-stream.requires-current-channel
#[test]
fn source_events_before_channel_registration_fail_explicitly() {
    let stream = ViewSourceEventStream::default();

    assert_eq!(
        stream.send("view-source-registered", json!({"generation":1})),
        Err("view source event channel is not registered".into())
    );
}

// contract: view-source-stream.send-failure-is-returned
#[test]
fn channel_send_failures_are_returned_to_the_source_handler() {
    let stream = ViewSourceEventStream::default();
    let failing =
        Channel::new(|_| Err(tauri::Error::AssetNotFound("injected send failure".into())));
    stream.install(failing);

    assert_eq!(
        stream.send("view-call", Value::Null),
        Err("view source event view-call: asset not found: injected send failure".into())
    );
}

// contract: view-source-stream.rejects-unlisted-events
#[test]
fn events_outside_the_source_allowlist_are_rejected() {
    let stream = ViewSourceEventStream::default();

    assert_eq!(
        stream.send("workspace-changed", Value::Null),
        Err("workspace-changed is not a view source event".into())
    );
}

// contract: view.responsiveness.relay
#[test]
fn view_responsiveness_uses_the_ordered_source_channel() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let stream = ViewSourceEventStream::default();
    stream.install(test_channel(events.clone()));

    stream
        .send(
            "view-responsiveness",
            json!({"surface":"probe-surface","plugin":"probe","generation":8,"responsive":false}),
        )
        .expect("view responsiveness is sent through the ordered source channel");

    assert_eq!(
        events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_slice(),
        &[ViewSourceEvent {
            name: "view-responsiveness".into(),
            value: json!({"surface":"probe-surface","plugin":"probe","generation":8,"responsive":false}),
        }]
    );
}
