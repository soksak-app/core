use super::{DeclaredSourceEvent, DeclaredSourceEventStream};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};

fn test_channel(target: Arc<Mutex<Vec<DeclaredSourceEvent>>>) -> Channel<DeclaredSourceEvent> {
    Channel::new(move |body| {
        let InvokeResponseBody::Json(value) = body else {
            panic!("declared source event uses a raw channel payload");
        };
        let event =
            serde_json::from_str(&value).expect("the channel payload is a declared source event");
        target
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(event);
        Ok(())
    })
}

#[test]
fn source_events_are_sent_to_the_current_channel_in_call_order() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let stream = DeclaredSourceEventStream::default();
    stream.install(test_channel(events.clone()));

    stream
        .send(
            "declared-ui-source-registered",
            json!({"plugin":"probe","generation":4}),
        )
        .expect("source registration is sent");
    stream
        .send(
            "declared-ui-snapshot",
            json!({"plugin":"probe","generation":4,"seq":1}),
        )
        .expect("snapshot is sent");
    stream
        .send(
            "plugin-host-call",
            json!({"plugin":"probe","generation":4,"id":7}),
        )
        .expect("host call is sent");

    assert_eq!(
        *events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        vec![
            DeclaredSourceEvent {
                name: "declared-ui-source-registered".into(),
                value: json!({"plugin":"probe","generation":4}),
            },
            DeclaredSourceEvent {
                name: "declared-ui-snapshot".into(),
                value: json!({"plugin":"probe","generation":4,"seq":1}),
            },
            DeclaredSourceEvent {
                name: "plugin-host-call".into(),
                value: json!({"plugin":"probe","generation":4,"id":7}),
            },
        ]
    );
}

#[test]
fn a_new_main_page_channel_retires_the_previous_channel() {
    let old_events = Arc::new(Mutex::new(Vec::new()));
    let current_events = Arc::new(Mutex::new(Vec::new()));
    let stream = DeclaredSourceEventStream::default();
    stream.install(test_channel(old_events.clone()));
    stream.install(test_channel(current_events.clone()));

    stream
        .send(
            "declared-ui-source-ended",
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
        &[DeclaredSourceEvent {
            name: "declared-ui-source-ended".into(),
            value: json!({"plugin":"probe","generation":4}),
        }]
    );
}

#[test]
fn a_page_reload_retires_the_channel_until_the_replacement_is_installed() {
    let old_events = Arc::new(Mutex::new(Vec::new()));
    let current_events = Arc::new(Mutex::new(Vec::new()));
    let stream = DeclaredSourceEventStream::default();
    stream.install(test_channel(old_events.clone()));
    stream.retire();

    assert_eq!(
        stream.send("declared-ui-source-registered", json!({"generation":5})),
        Err("declared source event channel is not registered".into())
    );
    stream.install(test_channel(current_events.clone()));
    stream
        .send("declared-ui-source-registered", json!({"generation":6}))
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

#[test]
fn source_events_before_channel_registration_fail_explicitly() {
    let stream = DeclaredSourceEventStream::default();

    assert_eq!(
        stream.send("declared-ui-source-registered", json!({"generation":1})),
        Err("declared source event channel is not registered".into())
    );
}

#[test]
fn channel_send_failures_are_returned_to_the_source_handler() {
    let stream = DeclaredSourceEventStream::default();
    let failing =
        Channel::new(|_| Err(tauri::Error::AssetNotFound("injected send failure".into())));
    stream.install(failing);

    assert_eq!(
        stream.send("plugin-host-call", Value::Null),
        Err(
            "declared source event plugin-host-call: asset not found: injected send failure".into()
        )
    );
}

#[test]
fn events_outside_the_source_allowlist_are_rejected() {
    let stream = DeclaredSourceEventStream::default();

    assert_eq!(
        stream.send("workspace-changed", Value::Null),
        Err("workspace-changed is not a declared source event".into())
    );
}

#[test]
fn view_responsiveness_uses_the_ordered_source_channel() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let stream = DeclaredSourceEventStream::default();
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
        &[DeclaredSourceEvent {
            name: "view-responsiveness".into(),
            value: json!({"surface":"probe-surface","plugin":"probe","generation":8,"responsive":false}),
        }]
    );
}
