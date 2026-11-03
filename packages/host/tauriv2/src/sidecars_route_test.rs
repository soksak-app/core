//! The route of a sidecar message: a message that arrives after its window closed has no document to reach.

use std::sync::Arc;

use serde_json::value::RawValue;

use super::{Message, route_message};
use crate::windows::WindowData;

fn message() -> Message {
    Message {
        sidecar: "sidecar".to_string(),
        surface: "tab-a".to_string(),
        body: RawValue::from_string("{}".to_string()).unwrap(),
    }
}

#[test]
fn a_message_after_its_window_closed_posts_nothing_and_reports_no_failure() {
    let closed: Result<Arc<WindowData>, String> = Err("project window is closed".to_string());
    let mut posted = false;
    let routed = route_message(&closed, &message(), |_| {
        posted = true;
        Ok(())
    });
    assert_eq!(routed, Ok(()), "a closed window has no document to reach");
    assert!(!posted);
}

#[test]
fn a_message_of_an_open_window_reports_the_failure_of_its_post() {
    let open: Result<Arc<WindowData>, String> = Ok(Arc::new(WindowData::default()));
    let routed = route_message(&open, &message(), |_| Err("post failed".to_string()));
    assert_eq!(routed, Err("post failed".to_string()));
}
