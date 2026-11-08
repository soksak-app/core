use std::collections::BTreeMap;
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use serde_json::{Value, json};

#[derive(Default)]
pub struct ViewSourceOrigins(Mutex<ViewSourceOriginsState>);

pub(crate) const MAX_VIEW_SOURCE_GENERATION: u64 = 9_007_199_254_740_991;

pub(crate) fn validate_view_source_generation_limit(
    generation: u64,
    subject: &str,
) -> Result<(), String> {
    if generation > MAX_VIEW_SOURCE_GENERATION {
        return Err(format!(
            "{subject} source generation exceeds the JavaScript safe integer limit"
        ));
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct ViewSourceOriginsState {
    floor: u64,
    views: BTreeMap<String, u64>,
    background_floor: u64,
    background_calls: BTreeMap<u64, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSourceOriginsSnapshot {
    floor: u64,
    views: BTreeMap<String, u64>,
}

pub(crate) fn view_source_origin_event(
    plugin: &str,
    surface: Option<&str>,
    generation: u64,
) -> Value {
    let mut payload = json!({"plugin": plugin, "generation": generation});
    if let Some(surface) = surface {
        payload["surface"] = json!(surface);
    }
    payload
}

/// Posts only while the expected generation is the current one and the channel still matches. The caller runs the check and
/// the post in one main-thread task, so no replacement can start between them.
pub(crate) fn post_if_generation_current(
    expected: u64,
    current: Option<u64>,
    channel_matches: impl FnOnce() -> bool,
    post: impl FnOnce() -> Result<bool, String>,
) -> Result<bool, String> {
    if current != Some(expected) || !channel_matches() {
        return Ok(false);
    }
    post()
}

/// A single pending background call. Only outstanding calls occupy the registry.
pub(crate) struct BackgroundTicket<'a> {
    owner: &'a ViewSourceOrigins,
    id: u64,
    surface: String,
}
impl BackgroundTicket<'_> {
    pub(crate) fn lease(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, ViewSourceOriginsState>, String> {
        let state = self.owner.lock();
        if state.background_calls.get(&self.id) != Some(&self.surface)
            || state.views.contains_key(&self.surface)
        {
            return Err(format!(
                "background source {} changed ownership",
                self.surface
            ));
        }
        Ok(state)
    }
}
impl Drop for BackgroundTicket<'_> {
    fn drop(&mut self) {
        self.owner.lock().background_calls.remove(&self.id);
    }
}

impl ViewSourceOrigins {
    fn lock(&self) -> std::sync::MutexGuard<'_, ViewSourceOriginsState> {
        // default: an interrupted issuance may leave a gap in the monotonic floor; ended generations also have no map
        // entry, so gaps are valid. The panic hook records the panic.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn issue_view(&self, surface: &str) -> Result<u64, String> {
        let mut state = self.lock();
        let generation = state
            .floor
            .checked_add(1)
            .filter(|generation| *generation <= MAX_VIEW_SOURCE_GENERATION)
            .ok_or_else(|| {
                "view source generation exceeds the JavaScript safe integer limit".to_string()
            })?;
        state
            .background_calls
            .retain(|_, pending| pending != surface);
        state.floor = generation;
        state.views.insert(surface.to_string(), generation);
        Ok(generation)
    }

    pub(crate) fn end_view(&self, surface: &str, generation: u64) -> bool {
        let mut state = self.lock();
        if state.views.get(surface) != Some(&generation) {
            return false;
        }
        state.views.remove(surface);
        true
    }

    #[cfg(test)]
    pub(crate) fn pending_background_calls(&self) -> usize {
        self.lock().background_calls.len()
    }

    pub(crate) fn background_ticket(&self, surface: &str) -> Result<BackgroundTicket<'_>, String> {
        let mut state = self.lock();
        if state.views.contains_key(surface) {
            return Err(format!(
                "mounted surface {surface} requires original view source authority"
            ));
        }
        let id = state
            .background_floor
            .checked_add(1)
            .ok_or_else(|| "background call ticket space exhausted".to_string())?;
        state.background_floor = id;
        state.background_calls.insert(id, surface.to_string());
        Ok(BackgroundTicket {
            owner: self,
            id,
            surface: surface.to_string(),
        })
    }

    pub(crate) fn lease_current(
        &self,
        surface: &str,
        generation: u64,
    ) -> Result<std::sync::MutexGuard<'_, ViewSourceOriginsState>, String> {
        let state = self.lock();
        if state.views.get(surface) != Some(&generation) {
            return Err(format!(
                "view source {surface} generation {generation} is retired"
            ));
        }
        Ok(state)
    }

    pub(crate) fn current_view(&self, surface: &str) -> Option<u64> {
        self.lock().views.get(surface).copied()
    }

    pub fn snapshot(&self) -> ViewSourceOriginsSnapshot {
        let state = self.lock();
        ViewSourceOriginsSnapshot {
            floor: state.floor,
            views: state.views.clone(),
        }
    }
}

#[cfg(test)]
#[path = "source_origins_test.rs"]
mod tests;
