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
struct ViewSourceOriginsState {
    floor: u64,
    views: BTreeMap<String, u64>,
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
