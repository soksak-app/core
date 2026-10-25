use std::collections::BTreeMap;
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use serde_json::{Value, json};

#[derive(Default)]
pub(crate) struct DeclaredSourceOrigins(Mutex<DeclaredSourceOriginsState>);

pub(crate) const MAX_DECLARED_SOURCE_GENERATION: u64 = 9_007_199_254_740_991;

pub(crate) fn validate_declared_source_generation_limit(
    generation: u64,
    subject: &str,
) -> Result<(), String> {
    if generation > MAX_DECLARED_SOURCE_GENERATION {
        return Err(format!(
            "{subject} source generation exceeds the JavaScript safe integer limit"
        ));
    }
    Ok(())
}

#[derive(Default)]
struct DeclaredSourceOriginsState {
    floor: u64,
    plugin_hosts: BTreeMap<String, u64>,
    views: BTreeMap<String, u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeclaredSourceOriginsSnapshot {
    floor: u64,
    plugin_hosts: BTreeMap<String, u64>,
    views: BTreeMap<String, u64>,
}

pub(crate) fn declared_source_origin_event(
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

impl DeclaredSourceOrigins {
    fn lock(&self) -> std::sync::MutexGuard<'_, DeclaredSourceOriginsState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn issue_plugin_host(&self, plugin: &str) -> Result<u64, String> {
        let mut state = self.lock();
        let generation = state
            .floor
            .checked_add(1)
            .filter(|generation| *generation <= MAX_DECLARED_SOURCE_GENERATION)
            .ok_or_else(|| {
                "declared source generation exceeds the JavaScript safe integer limit".to_string()
            })?;
        state.floor = generation;
        state.plugin_hosts.insert(plugin.to_string(), generation);
        Ok(generation)
    }

    pub(crate) fn end_plugin_host(&self, plugin: &str, generation: u64) -> bool {
        let mut state = self.lock();
        if state.plugin_hosts.get(plugin) != Some(&generation) {
            return false;
        }
        state.plugin_hosts.remove(plugin);
        true
    }

    pub(crate) fn take_all_plugin_hosts(&self) -> Vec<(String, u64)> {
        std::mem::take(&mut self.lock().plugin_hosts)
            .into_iter()
            .collect()
    }

    pub(crate) fn current_plugin_host(&self, plugin: &str) -> Option<u64> {
        self.lock().plugin_hosts.get(plugin).copied()
    }

    pub(crate) fn issue_view(&self, surface: &str) -> Result<u64, String> {
        let mut state = self.lock();
        let generation = state
            .floor
            .checked_add(1)
            .filter(|generation| *generation <= MAX_DECLARED_SOURCE_GENERATION)
            .ok_or_else(|| {
                "declared source generation exceeds the JavaScript safe integer limit".to_string()
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

    pub(crate) fn snapshot(&self) -> DeclaredSourceOriginsSnapshot {
        let state = self.lock();
        DeclaredSourceOriginsSnapshot {
            floor: state.floor,
            plugin_hosts: state.plugin_hosts.clone(),
            views: state.views.clone(),
        }
    }
}

/// Starts the provider operation with a newly issued window-wide source generation.
pub(crate) fn with_plugin_host_generation<T>(
    origins: &DeclaredSourceOrigins,
    plugin: &str,
    start: impl FnOnce(u64) -> Result<T, String>,
) -> Result<T, String> {
    let generation = origins.issue_plugin_host(plugin)?;
    start(generation)
}

#[cfg(test)]
#[path = "source_origins_test.rs"]
mod tests;
