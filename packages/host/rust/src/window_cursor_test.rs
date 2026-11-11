//! The cursor of `host.window`: the name that the native facts report passes through, a missing or null cursor gives null, and
//! a value of another type is refused. The same cases run in the Go host.
use super::*;

// contract: window.facts.cursor
#[test]
fn host_window_reports_the_cursor_of_the_virtual_key_window() {
    assert_eq!(
        window_cursor(&json!({"cursor": "pointingHand"})).unwrap(),
        json!("pointingHand")
    );
    assert_eq!(
        window_cursor(&json!({"cursor": null})).unwrap(),
        Value::Null
    );
    assert_eq!(window_cursor(&json!({})).unwrap(), Value::Null);
    assert!(window_cursor(&json!({"cursor": 3})).is_err());
}
