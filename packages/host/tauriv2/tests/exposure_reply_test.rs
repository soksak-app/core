use std::sync::Arc;
use std::time::Duration;

use serde_json::value::RawValue;
use serde_json::{Value, json};
use soksak_host_tauriv2::exposure::{Relay, reply_target};

const WAIT: Duration = Duration::from_secs(5);

/// The response text that a document sends.
fn raw(value: &Value) -> Box<RawValue> {
    serde_json::value::to_raw_value(value).unwrap()
}

// contract: exposure-reply.target.main-and-surface-distinct
#[test]
fn main_and_surface_replies_use_distinct_targets() {
    assert_eq!(
        reply_target("main", &json!({"id":1,"result":null})).unwrap(),
        "main"
    );
    assert_eq!(
        reply_target("main", &json!({"id":2,"surface":"tab-1","result":null})).unwrap(),
        "surface-main-tab-1"
    );
    assert_eq!(
        reply_target("second", &json!({"id":3,"surface":"tab-1"})).unwrap(),
        "surface-second-tab-1"
    );
}

// contract: exposure-reply.target.invalid-surface-rejected
#[test]
fn invalid_scope_cannot_be_converted_to_a_main_reply() {
    for scope in [json!(null), json!(""), json!(1), json!({})] {
        assert!(reply_target("main", &json!({"id":1,"surface":scope})).is_err());
    }
}

// contract: exposure-reply.payload.main-reply-unscoped, exposure-reply.payload.scoped-reply-keeps-surface
#[test]
fn main_and_scoped_reply_payloads_reach_their_requests() {
    // Reads the response string that a document sent as a Value, like the argument of the exposure_reply command.
    let decode = |payload: Value| -> Value {
        serde_json::from_str(&serde_json::to_string(&payload).unwrap()).unwrap()
    };
    let relay = Arc::new(Relay::default());

    let replying = relay.clone();
    let main = relay.request("main", Some(WAIT), move |id| {
        let payload = decode(json!({"id": id, "result": null}));
        assert_eq!(payload.get("surface"), None);
        let target = reply_target("main", &payload).unwrap();
        replying
            .reply(&target, &raw(&payload))
            .unwrap_or_else(|error| panic!("main reply went to {target}: {error}"));
        Ok(())
    });
    assert_eq!(main.unwrap().get(), "null");

    let replying = relay.clone();
    let scoped = relay.request("surface-main-tab-1", Some(WAIT), move |id| {
        let payload = decode(json!({"id": id, "surface": "tab-1", "result": {"ok": true}}));
        assert_eq!(payload["surface"], "tab-1");
        let target = reply_target("main", &payload).unwrap();
        replying
            .reply(&target, &raw(&payload))
            .unwrap_or_else(|error| panic!("scoped reply went to {target}: {error}"));
        Ok(())
    });
    assert_eq!(scoped.unwrap().get(), r#"{"ok":true}"#);
}

// contract: exposure-reply.removed-surface-discarded
#[test]
fn reply_of_a_removed_surface_is_an_observation() {
    // When a surface is removed, the requests of that surface have already ended with 1003, so a late reply is an
    // observation and not an error.
    assert_eq!(
        soksak_host_tauriv2::exposure::removed_surface_reply(7228, "tab-4sswjb"),
        r#"exposure reply 7228 of removed surface "tab-4sswjb" arrived after its request ended"#
    );
}
