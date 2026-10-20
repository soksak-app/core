//! The failures and the records of the view surfaces of a window (docs/plans/plugin-processes.md, rule 5).
//!
//! The host closes a view whose process ends or whose message queue overflows, and creates it again from its record. A surface whose
//! failures reach the restart limit creates no view until its surface is removed. The failures carry the instant at which they occur,
//! so the caller reads the clock and a test passes its own instants.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::platform::Handle;

/// The restart limit of a view surface: the fourth failure within VIEW_RESTART_WINDOW stops its restarts (docs/plans/plugin-processes.md,
/// rule 5, pass value (vi)).
pub const VIEW_RESTART_LIMIT: usize = 4;

/// The sliding window of the failures of a view surface. A failure older than the window is not counted.
pub const VIEW_RESTART_WINDOW: Duration = Duration::from_secs(300);

/// The record of a view surface that the host needs to create its view again.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewSpec {
    pub surface_handle: Handle,
    pub plugin: String,
    pub page: String,
    pub visible: bool,
}

#[derive(Default)]
struct LifecycleState {
    specs: HashMap<String, ViewSpec>,
    failures: HashMap<String, Vec<Instant>>,
    stopped: HashSet<String>,
}

/// The failures and the records of the view surfaces of a window. Each failure is passed with the instant at which it occurred, so the
/// caller reads the clock and a test passes its own instants.
#[derive(Default)]
pub struct ViewLifecycle(Mutex<LifecycleState>);

impl ViewLifecycle {
    fn lock(&self) -> MutexGuard<'_, LifecycleState> {
        self.0
            .lock()
            // default: the state is changed by one insert or remove at a time, so it is consistent after a thread stopped while it
            // held the lock.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records the view of surface and returns its record. A view of a surface is recorded when its surface is synced.
    pub fn track(
        &self,
        surface: &str,
        surface_handle: Handle,
        plugin: &str,
        page: &str,
        visible: bool,
    ) -> ViewSpec {
        let spec = ViewSpec {
            surface_handle,
            plugin: plugin.to_string(),
            page: page.to_string(),
            visible,
        };
        self.lock().specs.insert(surface.to_string(), spec.clone());
        spec
    }

    /// Returns the record of surface, or None when it has none.
    pub fn spec(&self, surface: &str) -> Option<ViewSpec> {
        self.lock().specs.get(surface).cloned()
    }

    /// Records a failure of the view of surface at the instant at and reports whether the view may be created again. A failure older
    /// than VIEW_RESTART_WINDOW is not counted, and the failure that makes VIEW_RESTART_LIMIT within the window stops the restarts.
    /// A stopped surface records no failure.
    pub fn fail(&self, surface: &str, at: Instant) -> bool {
        let mut state = self.lock();
        if state.stopped.contains(surface) {
            return false;
        }
        let count = {
            let failures = state.failures.entry(surface.to_string()).or_default();
            failures.retain(|&earlier| at.saturating_duration_since(earlier) < VIEW_RESTART_WINDOW);
            failures.push(at);
            failures.len()
        };
        if count >= VIEW_RESTART_LIMIT {
            state.stopped.insert(surface.to_string());
            return false;
        }
        true
    }

    /// Reports whether the restarts of the view of surface are stopped.
    pub fn is_stopped(&self, surface: &str) -> bool {
        self.lock().stopped.contains(surface)
    }

    /// Removes the record of surface, which clears its failures and its stop. It runs when the surface is removed, so the next surface
    /// of the same name is a new view.
    pub fn forget(&self, surface: &str) {
        let mut state = self.lock();
        state.specs.remove(surface);
        state.failures.remove(surface);
        state.stopped.remove(surface);
    }
}

/// The reason of a view that stopped its restarts. The log line and the view-stopped event carry it.
pub fn view_stop_reason() -> String {
    format!(
        "the view failed {VIEW_RESTART_LIMIT} times within {} seconds and is created again when its tab is reopened",
        VIEW_RESTART_WINDOW.as_secs()
    )
}

/// The payload of the view-stopped event of the view of surface, which has the plugin id and the reason. The main page answers it by
/// showing the reason on the card of the surface (docs/spec/native-surfaces.md#view-surfaces).
pub fn view_stopped_event(surface: &str, plugin: &str) -> serde_json::Value {
    serde_json::json!({"surface": surface, "plugin": plugin, "reason": view_stop_reason()})
}

/// The prefix of the reason of a view.error message whose message queue is full (docs/spec/native-surfaces.md#view-surfaces).
const QUEUE_FULL_PREFIX: &str = "queue full for ";

/// Reports whether a view.error reason says that the message queue of the view is full, so the view is closed and created again.
pub fn is_queue_full(reason: &str) -> bool {
    reason.starts_with(QUEUE_FULL_PREFIX)
}

#[cfg(test)]
#[path = "view_lifecycle_test.rs"]
mod tests;
