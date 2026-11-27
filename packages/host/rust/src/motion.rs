//! The reduced motion override of a window, which a diagnostic build sets in place of the platform value
//! (docs/spec/endpoint.md#diagnostic-builds).

use std::sync::{Mutex, PoisonError};

use crate::framework::Window;
use serde_json::{Value, json};

#[cfg(feature = "diagnostics")]
use crate::windows::emit_window;
use crate::windows::window_data;

/// The reduced motion override of a window: None for the platform value, Some(reduce) for the override.
#[derive(Default)]
pub(crate) struct CurrentMotion(Mutex<Option<bool>>);

/// Returns the reduced motion override of the window, or None when the platform value applies. The pages read it with
/// the motion command.
pub fn get(window: &Window) -> Result<Option<bool>, String> {
    let context = window_data(window)?;
    let reduce = *context
        .motion
        .0
        .lock()
        // default: a lock that a panicking thread poisoned still holds the override of the window, which is only read; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    Ok(reduce)
}

/// Records the reduced motion override of the window and publishes it to the open pages with the motion event. Only the diagnostic
/// build sets the override.
#[cfg(feature = "diagnostics")]
pub(crate) fn set(window: &Window, reduce: Option<bool>) -> Result<(), String> {
    let context = window_data(window)?;
    *context
        .motion
        .0
        .lock()
        // default: a lock that a panicking thread poisoned still holds the override of the window, which this call
        // replaces; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner) = reduce;
    emit_window(window, "motion", payload(reduce)).map_err(|e| e.to_string())
}

/// Returns the value of the motion event and of the motion command: {reduce}, with null for the platform value.
pub fn payload(reduce: Option<bool>) -> Value {
    json!({ "reduce": reduce })
}

/// Reads the reduce parameter of diagnostics.motion. Only a boolean or null is accepted; an absent parameter is refused too.
#[cfg(feature = "diagnostics")]
pub(crate) fn parse_reduce(value: Option<&Value>) -> Result<Option<bool>, &'static str> {
    match value {
        Some(Value::Bool(reduce)) => Ok(Some(*reduce)),
        Some(Value::Null) => Ok(None),
        _ => Err("reduce must be a boolean or null"),
    }
}

#[cfg(test)]
#[path = "motion_test.rs"]
mod motion_test;
