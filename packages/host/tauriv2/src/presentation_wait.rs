//! The presentation wait of views (docs/spec/plugin-processes.md, rule 6). A changed visible root placement joins its layout
//! ticket, and the wait ends at presentation, process end, hide, unresponsive notice, or cancellation of that ticket.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use crate::platform::ViewAbandon;

/// The reasons that end a wait. `presented` is the presentation of the view; the others end the wait without it.
const ENDS: [&str; 4] = ["presented", "process-ended", "hidden", "unresponsive"];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewPlacement {
    pub frame: [f64; 4],
    pub visible: bool,
}

#[derive(Clone, Copy)]
struct CommittedPlacement {
    generation: u64,
    placement: ViewPlacement,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct WaitKey {
    surface: String,
    generation: u64,
    ticket: u64,
}

#[derive(Default)]
struct State {
    waits: BTreeMap<WaitKey, Option<ViewAbandon>>,
    committed: BTreeMap<String, CommittedPlacement>,
}

/// The views that wait for presentation, by surface, view generation and layout ticket. Each wait holds the function that
/// ends its native join without presentation. It is None while the native join call is in progress.
#[derive(Default)]
pub struct PresentationWait(Mutex<State>);

impl PresentationWait {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.0
            .lock()
            // default: a thread that stopped while holding the lock changed the set only by one insert or remove, so the set is
            // consistent, and that stop was already reported as a panic report.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reports whether this visible root placement differs from the last committed placement or view generation.
    pub fn needs_join(&self, surface: &str, generation: u64, placement: ViewPlacement) -> bool {
        if !placement.visible {
            return false;
        }
        self.lock().committed.get(surface).is_none_or(|previous| {
            previous.generation != generation
                || !previous.placement.visible
                || previous.placement.frame != placement.frame
        })
    }

    /// Records view placements only after the native transaction commits.
    pub fn commit(&self, placements: impl IntoIterator<Item = (String, u64, ViewPlacement)>) {
        let mut state = self.lock();
        for (surface, generation, placement) in placements {
            state.committed.insert(
                surface,
                CommittedPlacement {
                    generation,
                    placement,
                },
            );
        }
    }

    /// Removes the committed placement of a closed surface.
    pub fn forget_surface(&self, surface: &str) {
        self.lock().committed.remove(surface);
    }

    /// Starts one native join. The ticket and view generation form its identity.
    pub fn begin(&self, surface: &str, generation: u64, ticket: u64) -> bool {
        let mut state = self.lock();
        let key = WaitKey {
            surface: surface.to_string(),
            generation,
            ticket,
        };
        if state.waits.contains_key(&key) {
            return false;
        }
        state.waits.insert(key, None);
        true
    }

    /// Stores the native join's abandon operation unless its presentation already completed.
    pub fn attach_abandon(
        &self,
        surface: &str,
        generation: u64,
        ticket: u64,
        abandon: ViewAbandon,
    ) -> bool {
        let mut state = self.lock();
        let key = WaitKey {
            surface: surface.to_string(),
            generation,
            ticket,
        };
        let Some(entry) = state.waits.get_mut(&key) else {
            return false;
        };
        assert!(
            entry.is_none(),
            "native join abandon operation was attached twice"
        );
        *entry = Some(abandon);
        true
    }

    /// Removes a wait whose native join was not created.
    pub fn remove_unjoined(&self, surface: &str, generation: u64, ticket: u64) {
        self.lock().waits.remove(&WaitKey {
            surface: surface.to_string(),
            generation,
            ticket,
        });
    }

    /// Reports whether the exact surface generation and layout ticket wait for presentation.
    pub fn waits(&self, surface: &str, generation: u64, ticket: u64) -> bool {
        self.lock().waits.contains_key(&WaitKey {
            surface: surface.to_string(),
            generation,
            ticket,
        })
    }

    /// Ends one wait. An end without presentation writes an abandoned event and abandons its native join.
    pub fn end(
        &self,
        surface: &str,
        generation: u64,
        ticket: u64,
        reason: &str,
    ) -> Result<bool, String> {
        if !ENDS.contains(&reason) {
            return Err(format!(
                "presentation wait ends with {reason:?}, which is not an end"
            ));
        }
        let abandon = match self.lock().waits.remove(&WaitKey {
            surface: surface.to_string(),
            generation,
            ticket,
        }) {
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

    /// Ends all waits of one view generation. The returned tickets had a pending wait.
    pub fn end_generation(
        &self,
        surface: &str,
        generation: u64,
        reason: &str,
    ) -> Result<Vec<u64>, String> {
        let tickets = self
            .lock()
            .waits
            .keys()
            .filter(|key| key.surface == surface && key.generation == generation)
            .map(|key| key.ticket)
            .collect::<Vec<_>>();
        for ticket in &tickets {
            self.end(surface, generation, *ticket, reason)?;
        }
        Ok(tickets)
    }

    /// Ends all generations of a surface, for a surface that became hidden or closed.
    pub fn end_surface(&self, surface: &str, reason: &str) -> Result<Vec<(u64, u64)>, String> {
        let keys = self
            .lock()
            .waits
            .keys()
            .filter(|key| key.surface == surface)
            .map(|key| (key.generation, key.ticket))
            .collect::<Vec<_>>();
        for (generation, ticket) in &keys {
            self.end(surface, *generation, *ticket, reason)?;
        }
        Ok(keys)
    }

    /// Removes a canceled ticket before abandoning its native joins, so callbacks cannot clear a later wait.
    pub fn abandon_ticket(&self, ticket: u64) -> Result<(), String> {
        abandon_native_joins(ticket, self.take_waits(|key| key.ticket == ticket))
    }

    /// Removes every wait and committed placement before a window-wide native layout cancellation.
    pub fn abandon_all(&self) -> Result<(), String> {
        let waits = {
            let mut state = self.lock();
            state.committed.clear();
            std::mem::take(&mut state.waits)
                .into_iter()
                .map(|(key, abandon)| (key.ticket, key.surface, abandon))
                .collect::<Vec<_>>()
        };
        let mut failures = Vec::new();
        for (ticket, surface, abandon) in waits {
            if let Some(abandon) = abandon
                && let Err(error) = abandon()
            {
                failures.push(format!("layout {ticket}, view {surface}: {error}"));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "abandoning presentation joins: {}",
                failures.join("; ")
            ))
        }
    }

    fn take_waits(
        &self,
        matches: impl Fn(&WaitKey) -> bool,
    ) -> Vec<(u64, String, Option<ViewAbandon>)> {
        let mut state = self.lock();
        let keys = state
            .waits
            .keys()
            .filter(|key| matches(key))
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| {
                state
                    .waits
                    .remove(&key)
                    .map(|abandon| (key.ticket, key.surface, abandon))
            })
            .collect()
    }
}

fn abandon_native_joins(
    ticket: u64,
    waits: Vec<(u64, String, Option<ViewAbandon>)>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for (_, surface, abandon) in waits {
        if let Some(abandon) = abandon
            && let Err(error) = abandon()
        {
            failures.push(format!("view {surface}: {error}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "abandoning presentation joins for layout {ticket}: {}",
            failures.join("; ")
        ))
    }
}

/// Returns the payload of the view-presentation-abandoned notice of the view of surface.
pub fn presentation_abandoned_payload(surface: &str, reason: &str) -> serde_json::Value {
    serde_json::json!({"surface": surface, "reason": reason})
}

#[cfg(test)]
#[path = "presentation_wait_test.rs"]
mod tests;

#[cfg(test)]
#[path = "view_join_test.rs"]
mod view_join_test;
