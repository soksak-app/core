use super::image_event_payload;

#[test]
fn the_image_event_relay_preserves_the_compose_marked_range() {
    let event = serde_json::json!({
        "type": "compose",
        "text": "한",
        "markedRange": { "location": 0, "length": 1 },
        "selectedRange": { "location": 1, "length": 0 },
        "replacementRange": null,
        "attributed": false
    });
    let payload = image_event_payload("probe-surface", "probe-region", event.clone());

    assert_eq!(payload["surface"], "probe-surface");
    assert_eq!(payload["name"], "probe-region");
    assert_eq!(payload["event"], event);
}
