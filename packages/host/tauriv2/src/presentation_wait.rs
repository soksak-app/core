//! The presentation wait of views (docs/plans/plugin-processes.md, rule 6). A view joins the wait once per card layout change, and the
//! wait ends at the first of the presentation of the view, the end of its process, a change of which the view is not shown, and an
//! unresponsive notice. The host runs on the main thread only, so the wait holds no timer.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use crate::platform::ViewAbandon;

/// The reasons that end a wait. `presented` is the presentation of the view; the others end the wait without it.
const ENDS: [&str; 4] = ["presented", "process-ended", "hidden", "unresponsive"];

/// The views that wait for their presentation, by surface. Each waiting view holds the function that ends its native join
/// without presentation. It is None when the view waits without a native join.
#[derive(Default)]
pub struct PresentationWait(Mutex<BTreeMap<String, Option<ViewAbandon>>>);

impl PresentationWait {
    fn lock(&self) -> MutexGuard<'_, BTreeMap<String, Option<ViewAbandon>>> {
        self.0
            .lock()
            // default: a thread that stopped while holding the lock changed the set only by one insert or remove, so the set is
            // consistent, and that stop was already reported as a panic report.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Joins the view of surface to the wait, with abandon as the function that ends its native join. It returns false when the view
    /// already waits, so a view joins once per change.
    pub fn begin(&self, surface: &str, abandon: Option<ViewAbandon>) -> bool {
        let mut waiting = self.lock();
        if waiting.contains_key(surface) {
            return false;
        }
        waiting.insert(surface.to_string(), abandon);
        true
    }

    /// Reports whether the view of surface waits for its presentation.
    pub fn waits(&self, surface: &str) -> bool {
        self.lock().contains_key(surface)
    }

    /// Ends the wait of the view of surface with reason. It returns true when the wait ended without presentation, and then writes
    /// host.trace.view.presentation-abandoned. A view that does not wait has nothing to end. A reason that is not an end is an error.
    pub fn end(&self, surface: &str, reason: &str) -> Result<bool, String> {
        if !ENDS.contains(&reason) {
            return Err(format!(
                "presentation wait ends with {reason:?}, which is not an end"
            ));
        }
        let abandon = match self.lock().remove(surface) {
            None => return Ok(false),
            Some(abandon) => abandon,
        };
        if reason == "presented" {
            return Ok(false);
        }
        crate::event_record::emit_host(
            crate::event_log::Level::Debug,
            "host.trace.view.presentation-abandoned",
            serde_json::json!({"surface": surface, "reason": reason}),
        );
        if let Some(abandon) = abandon {
            abandon()
                .map_err(|error| format!("ending the native join of view {surface}: {error}"))?;
        }
        Ok(true)
    }
}

/// Returns the payload of the view-presentation-abandoned notice of the view of surface.
pub fn presentation_abandoned_payload(surface: &str, reason: &str) -> serde_json::Value {
    serde_json::json!({"surface": surface, "reason": reason})
}

/// Returns the view surfaces among the shown surfaces that wait for no presentation yet, in their order.
pub fn views_to_join<'a>(
    shown: impl IntoIterator<Item = &'a str>,
    is_view: impl Fn(&str) -> bool,
    waiting: impl Fn(&str) -> bool,
) -> Vec<&'a str> {
    shown
        .into_iter()
        .filter(|surface| is_view(surface) && !waiting(surface))
        .collect()
}

#[cfg(test)]
#[path = "presentation_wait_test.rs"]
mod tests;

#[cfg(test)]
#[path = "view_join_test.rs"]
mod view_join_test;
