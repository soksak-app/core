//! The presentation wait of views (docs/plans/plugin-processes.md, rule 6). A view joins the wait once per card layout change, and the
//! wait ends at the first of the presentation of the view, the end of its process, a change of which the view is not shown, and an
//! unresponsive notice. The host runs on the main thread only, so the wait holds no timer.

use std::collections::BTreeSet;
use std::sync::{Mutex, MutexGuard};

/// The reasons that end a wait. `presented` is the presentation of the view; the others end the wait without it.
const ENDS: [&str; 4] = ["presented", "process-ended", "hidden", "unresponsive"];

/// The views that wait for their presentation, by surface.
#[derive(Default)]
pub struct PresentationWait(Mutex<BTreeSet<String>>);

impl PresentationWait {
    fn lock(&self) -> MutexGuard<'_, BTreeSet<String>> {
        self.0
            .lock()
            // default: the set is changed by one insert or remove at a time, so it is consistent after a thread stopped while it held the lock.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Joins the view of surface to the wait. It returns false when the view already waits, so a view joins once per change.
    pub fn begin(&self, surface: &str) -> bool {
        self.lock().insert(surface.to_string())
    }

    /// Ends the wait of the view of surface with reason. It returns true when the wait ended without presentation, and then writes
    /// host.trace.view.presentation-abandoned. A view that does not wait has nothing to end. A reason that is not an end is an error.
    pub fn end(&self, surface: &str, reason: &str) -> Result<bool, String> {
        if !ENDS.contains(&reason) {
            return Err(format!(
                "presentation wait ends with {reason:?}, which is not an end"
            ));
        }
        if !self.lock().remove(surface) {
            return Ok(false);
        }
        if reason == "presented" {
            return Ok(false);
        }
        crate::event_record::emit_host(
            crate::event_log::Level::Debug,
            "host.trace.view.presentation-abandoned",
            serde_json::json!({"surface": surface, "reason": reason}),
        );
        Ok(true)
    }
}

#[cfg(test)]
#[path = "presentation_wait_test.rs"]
mod tests;
