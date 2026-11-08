//! The completion ownership of a document reference observation. It shares the schedule, await and late-log helpers of
//! the document frame identity, under its own owner label.
//!
//! The Go host also tests that a second native completion is refused. The Rust completion is a `FnOnce` that the platform
//! takes back and consumes, so a second completion cannot be written here.
use crate::diagnostics::{
    await_document_observation_schedule_result, late_document_observation_entry,
};
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn document_reference_await_keeps_late_error_ownership_after_scheduling_failure() {
    let (_sender, receiver) = mpsc::channel();
    let result = await_document_observation_schedule_result(
        "document reference",
        Err("reference was not scheduled".into()),
        receiver,
        Duration::from_millis(1),
    );
    assert_eq!(result, Err("reference was not scheduled".to_string()));
    let late = late_document_observation_entry(
        "document reference",
        Err("late reference completion failed".into()),
    );
    assert_eq!(late.level, "error");
    assert!(
        late.text.contains("document reference callback")
            && late.text.contains("late reference completion failed"),
        "late reference entry {:?}",
        late.text
    );
}

#[test]
fn document_reference_await_preserves_synchronous_callback_error_when_scheduling_fails() {
    let (sender, receiver) = mpsc::channel();
    sender
        .send(Err("native callback failed".to_string()))
        .unwrap();
    let result = await_document_observation_schedule_result(
        "document reference",
        Err("reference was not scheduled".into()),
        receiver,
        Duration::from_millis(1),
    );
    let Err(error) = result else {
        panic!("schedule and callback failures were accepted as success: {result:?}");
    };
    assert!(
        error.starts_with("document reference scheduling failed"),
        "{error}"
    );
    assert!(error.contains("reference was not scheduled"), "{error}");
    assert!(error.contains("native callback failed"), "{error}");
}
