//! The first responder that the page of a window receives as the window event window-responder (docs/spec/exposure.md#keyboard-focus).

use std::sync::{Mutex, PoisonError};

/// Reads the first responder and emits it when it differs from the last emitted one. force is the ready of a page, which has
/// received none: it emits the current responder. Without force, a page that is not ready receives nothing, because its ready
/// sends the current responder. The lock of sent orders the reads and emits.
pub fn send_changed_responder(
    sent: &Mutex<Option<serde_json::Value>>,
    force: bool,
    page_ready: impl FnOnce() -> bool,
    read: impl FnOnce() -> Result<serde_json::Value, String>,
    emit: impl FnOnce(serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    let mut sent = sent
        .lock()
        // default: a lock that a panicking thread poisoned still holds the last sent responder, which this send replaces;
        // the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    if force {
        *sent = None;
    } else if !page_ready() {
        return Ok(());
    }
    let responder = read()?;
    if sent.as_ref() == Some(&responder) {
        return Ok(());
    }
    *sent = Some(responder.clone());
    emit(responder)
}

#[cfg(test)]
#[path = "responder_test.rs"]
mod responder_test;
