//! The presentation wait of views (docs/spec/plugin-processes.md, rule 6). A changed visible root placement joins its layout
//! ticket, and the wait ends at presentation, process end, hide, unresponsive notice, the presentation limit, or cancellation of that
//! ticket.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use crate::platform::ViewAbandon;

/// Writes one phase of the root-view join trace only while the performance trace is enabled.
pub(crate) fn trace_presentation_join(
    phase: &'static str,
    surface: &str,
    generation: u64,
    ticket: u64,
    joined: Option<bool>,
    reason: Option<&str>,
) {
    if !crate::performance::enabled()
        || !crate::log_policy::gate_event(
            crate::log_policy::Class::Call,
            crate::event_log::Level::Debug,
        )
    {
        return;
    }
    let mut fields = serde_json::json!({
        "phase": phase,
        "surface": surface,
        "generation": generation,
        "ticket": ticket
    });
    if let Some(joined) = joined {
        fields["joined"] = serde_json::json!(joined);
    }
    if let Some(reason) = reason {
        fields["reason"] = serde_json::json!(reason);
    }
    crate::event_record::emit_host(
        crate::event_log::Level::Debug,
        "host.trace.view.presentation-join",
        fields,
    );
}

/// The reasons that end a wait. `presented` is the presentation of the view; the others end the wait without it.
const ENDS: [&str; 5] = [
    "presented",
    "process-ended",
    "hidden",
    "unresponsive",
    "timeout",
];

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

/// One join that waits for presentation. `abandon` ends the native join without presentation and is None while the native join
/// call is in progress. `presented` is set when the native presentation completed, before the UI thread ends the wait.
struct Wait {
    abandon: Option<ViewAbandon>,
    presented: bool,
}

#[derive(Default)]
struct State {
    waits: BTreeMap<WaitKey, Wait>,
    committed: BTreeMap<String, CommittedPlacement>,
    /// The view generation of each surface whose wait ended at the presentation limit. That generation joins no later wait, so a
    /// view that does not present holds no later transaction for the limit again.
    timed_out: BTreeMap<String, u64>,
}

/// A root placement of a presentation request: the surface, the generation of its view when the surface has one, and the placement.
pub type RequestedPlacement<'a> = (&'a str, Option<u64>, ViewPlacement);

/// The views that wait for presentation, by surface, view generation and layout ticket.
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
        let mut state = self.lock();
        state.committed.remove(surface);
        state.timed_out.remove(surface);
    }

    /// Selects the placements that join the open layout transaction, in request order: a visible placement of a view with a
    /// generation whose placement differs from the committed one. An invisible placement is not selected and ends no wait at
    /// presentation; its wait ends at the sync that applies the invisibility (documents.rs sync_view).
    /// A generation whose wait ended at the presentation limit is not selected.
    pub fn joinable<'a>(&self, placements: &[RequestedPlacement<'a>]) -> Vec<(&'a str, u64)> {
        placements
            .iter()
            .filter_map(|(surface, generation, placement)| {
                let generation = (*generation)?;
                let timed_out = self.lock().timed_out.get(*surface) == Some(&generation);
                (!timed_out && self.needs_join(surface, generation, *placement))
                    .then_some((*surface, generation))
            })
            .collect()
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
        state.waits.insert(
            key,
            Wait {
                abandon: None,
                presented: false,
            },
        );
        drop(state);
        trace_presentation_join("requested", surface, generation, ticket, None, None);
        true
    }

    /// Records that the native presentation of the join completed. The presentation callback calls it on the thread that
    /// presents the view, so a hide that runs before the queued end of the wait ends it as presented. A join that is no longer
    /// waiting has nothing to record.
    pub fn mark_presented(&self, surface: &str, generation: u64, ticket: u64) {
        if let Some(wait) = self.lock().waits.get_mut(&WaitKey {
            surface: surface.to_string(),
            generation,
            ticket,
        }) {
            wait.presented = true;
        }
    }

    /// Stores the native join's abandon operation of a wait that is still open.
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
        let Some(wait) = state.waits.get_mut(&key) else {
            return false;
        };
        assert!(
            wait.abandon.is_none(),
            "native join abandon operation was attached twice"
        );
        wait.abandon = Some(abandon);
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
        let wait = match self.lock().waits.remove(&WaitKey {
            surface: surface.to_string(),
            generation,
            ticket,
        }) {
            None => return Ok(false),
            Some(wait) => wait,
        };
        // A presentation that completed before this end ended the wait as presented: it writes no abandoned record and abandons
        // no native join.
        if reason == "presented" || wait.presented {
            return Ok(false);
        }
        if reason == "timeout" {
            self.lock()
                .timed_out
                .insert(surface.to_string(), generation);
        }
        trace_presentation_join("abandoned", surface, generation, ticket, None, Some(reason));
        crate::event_record::emit_host(
            crate::event_log::Level::Debug,
            "host.trace.view.presentation-abandoned",
            serde_json::json!({"surface": surface, "reason": reason}),
        );
        if let Some(abandon) = wait.abandon {
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
                .map(|(key, wait)| (key.ticket, key.surface, wait.abandon))
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
                    .map(|wait| (key.ticket, key.surface, wait.abandon))
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
