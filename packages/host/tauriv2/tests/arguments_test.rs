//! Checks the decoding of host call arguments (docs/spec/native-host.md#host-calls). Both hosts reject the same
//! arguments with the same text.

use serde::Deserialize;
use serde_json::{Value, json};
use soksak_host_tauriv2::arguments::decode;
use soksak_host_tauriv2::surfaces::SyncRequest;
use soksak_host_tauriv2::{documents, exposure, images, workspace};

fn refusal<T: serde::de::DeserializeOwned>(name: &str, value: Value) -> String {
    match decode::<T>(name, &value) {
        Ok(_) => panic!("argument {name} {value} was accepted"),
        Err(error) => error,
    }
}

/// An argument that holds a fixed-length array.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct Shape {
    fill: [f64; 4],
}

// contract: host-calls.decode.messages
#[test]
fn arguments_are_refused_with_the_shared_messages() {
    let surface = json!({"id": "tab-1", "x": 0, "y": 0, "w": 1, "h": null, "visible": true, "dim": false, "plugin": "page",
        "composition": {"kind": "web"}});
    assert_eq!(
        refusal::<SyncRequest>("request", json!({"settled": true})),
        "argument request.surfaces is missing"
    );
    assert_eq!(
        refusal::<SyncRequest>("request", json!({"settled": true, "surfaces": []})),
        "argument request.titlebar is missing"
    );
    assert_eq!(
        refusal::<SyncRequest>("request", json!({"settled": true, "surfaces": [surface]})),
        "argument request.surfaces[0].h is missing"
    );
    assert_eq!(
        refusal::<SyncRequest>(
            "request",
            json!({"settled": true, "surfaces": [], "overlays": [{"x": "1", "y": 0, "w": 1, "h": 1}]})
        ),
        "argument request.overlays[0].x must be a number, not a string"
    );
    assert_eq!(
        refusal::<documents::Request>("request", Value::Null),
        "argument request must be an object, not null"
    );
    for offset in [json!(1.5), json!(2147483648_i64)] {
        assert_eq!(
            refusal::<documents::Request>(
                "request",
                json!({"surface": "s", "document": "d", "action": "entry", "offset": offset})
            ),
            "argument request.offset must be an integer from -2147483648 to 2147483647"
        );
    }
    assert_eq!(
        refusal::<images::Request>("request", json!({"surface": 5, "name": "view"})),
        "argument request.surface must be a string, not a number"
    );
    assert_eq!(
        refusal::<workspace::Request>("request", json!({"kind": "add", "project": 5})),
        "argument request.project must be an object, not a number"
    );
    assert_eq!(
        refusal::<String>("id", json!(5)),
        "argument id must be a string, not a number"
    );
    assert_eq!(
        refusal::<Shape>("request", json!({"fill": [0, 0, 0]})),
        "argument request.fill must be an array of 4 items"
    );
    // An optional field can be missing or null.
    decode::<documents::Request>(
        "request",
        &json!({"surface": "s", "document": "d", "url": null}),
    )
    .expect("optional fields may be missing or null");
    // A state change without a value is a change whose value is null. The Tauri runtime adapter sends the value as JSON
    // text, and when the value is undefined it does not send the field.
    decode::<exposure::Changed>("request", &json!({"name": "core.grid"}))
        .expect("a status change may lack its value");
}

// contract: view.call.reply-null-result
#[test]
fn a_view_reply_keeps_a_null_result_as_the_result_of_a_command_without_a_value() {
    let reply: documents::ViewReply = soksak_host_tauriv2::arguments::decode(
        "request",
        &json!({"surface": "probe", "id": 1, "result": null}),
    )
    .expect("a reply with a null result is accepted");
    assert_eq!(
        documents::view_reply_message(&reply),
        Ok(json!({"sok": 1, "id": 1, "result": null})),
        "a null result is a value and is posted as result null"
    );
}

// contract: view.event.push
#[test]
fn a_view_event_keeps_a_null_data_as_its_value() {
    let event: documents::ViewEventRequest = soksak_host_tauriv2::arguments::decode(
        "request",
        &json!({"surface": "probe", "event": "probe.changed", "data": null}),
    )
    .expect("an event with a null data is accepted");
    assert_eq!(
        documents::view_event_message(&event),
        Ok(json!({"sok": 1, "event": "probe.changed", "data": null})),
        "a null data is a value and is posted as data null"
    );
}
