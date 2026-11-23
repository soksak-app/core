//! Tests of the calls of the page that the GPUI adapter answers: the dispatch of a registered method and the reply of a call.

use std::sync::Arc;

use serde_json::{Value, json};
use soksak_host::framework::{AppHandle, InvokeBody};

use super::{Reply, dispatch};
use crate::frontend::{Frontend, Record};

/// Runs dispatch for method with the arguments args in a window of a record that no AppKit window holds. A method whose
/// arguments do not decode answers the decoding error before the call reaches the application or the window.
fn call(method: &str, args: Value) -> Result<Value, String> {
    let app = AppHandle::new(Arc::new(crate::Framework));
    let frontend: Arc<dyn soksak_host::framework::Frontend> =
        Arc::new(Frontend::new(Arc::new(Record::new("main".to_string()))));
    assert_eq!(frontend.name(), "main");
    let window = app.window_of(Arc::clone(&frontend));
    let webview = app.webview_of(frontend, "main");
    dispatch(&app, &window, &webview, method, &InvokeBody::Json(&args))
}

// contract: plugins.starter.rejects-invalid-request
#[test]
fn plugins_starter_rejects_an_invalid_request_through_the_dispatch() {
    assert_eq!(
        call("plugins_starter", json!({"request": {"state": 3}})).unwrap_err(),
        "argument request.state must be a string, not a number"
    );
}

// contract: projects.shown-command-is-registered
#[test]
fn the_dispatch_answers_the_project_shown_method() {
    // A registered method decodes its request; an unknown method names itself.
    let error = call("project_shown", json!({"request": 3})).unwrap_err();
    assert!(error.starts_with("argument request "), "{error}");
    assert_eq!(
        call("project_unknown", json!({})).unwrap_err(),
        "the page called no known method \"project_unknown\""
    );
}

// contract: binding.reply.absent-value-is-null
#[test]
fn a_reply_without_a_value_carries_null() {
    let reply = Reply {
        epoch: "e".to_string(),
        id: 7,
    };
    let message = reply.message(&Ok(Value::Null));
    assert_eq!(message, json!({"epoch": "e", "id": 7, "result": null}));
    assert!(message.as_object().unwrap().contains_key("result"));
}
