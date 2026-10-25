use super::{ViewChannels, ViewDispatch};
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
