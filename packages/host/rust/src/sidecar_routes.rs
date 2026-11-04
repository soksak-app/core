// The sidecar routes of a window (docs/spec/native-surfaces.md#view-surfaces). The main page registers the receivers of the
// messages of each pair of a sidecar and a session id: whether the main page listens, and the views of surfaces at their view
// source generations. The host delivers a message only to those receivers, so a message to a view does not pass through the
// main page.

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

/// The receivers of one pair.
#[derive(Default)]
struct Route {
    page: bool,
    views: Vec<(String, u64)>,
}

/// The receivers of a message: whether the main page listens, and each view as its surface and view source generation.
#[derive(Debug, PartialEq)]
pub(crate) struct Targets {
    pub page: bool,
    pub views: Vec<(String, u64)>,
}

/// The routes of one window, by sidecar and session id.
#[derive(Default)]
pub struct SidecarRoutes {
    routes: Mutex<HashMap<(String, String), Route>>,
}

impl SidecarRoutes {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), Route>> {
        // default: a lock that a panicking thread poisoned still holds the routes, which every change leaves whole; the
        // panic hook records the panic.
        self.routes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn change(&self, sidecar: &str, id: &str, apply: impl FnOnce(&mut Route)) {
        let mut routes = self.lock();
        let key = (sidecar.to_string(), id.to_string());
        let route = routes.entry(key.clone()).or_default();
        apply(route);
        if !route.page && route.views.is_empty() {
            routes.remove(&key);
        }
    }

    /// Sets whether the main page receives the messages of the pair. A repeated value changes nothing.
    pub fn listen(&self, sidecar: &str, id: &str, on: bool) {
        self.change(sidecar, id, |route| route.page = on);
    }

    /// Adds or removes the view of surface at generation as a receiver of the pair. A repeated call changes nothing.
    pub fn route_view(&self, surface: &str, generation: u64, sidecar: &str, id: &str, on: bool) {
        self.change(sidecar, id, |route| {
            let present = route
                .views
                .iter()
                .position(|(s, g)| s == surface && *g == generation);
            match (on, present) {
                (true, None) => route.views.push((surface.to_string(), generation)),
                (false, Some(index)) => {
                    route.views.remove(index);
                }
                _ => {}
            }
        });
    }

    /// Removes the route of a view whose generation is no longer current.
    pub(crate) fn remove_view(&self, sidecar: &str, id: &str, surface: &str, generation: u64) {
        self.route_view(surface, generation, sidecar, id, false);
    }

    /// Returns the receivers of a message of the pair.
    pub(crate) fn targets(&self, sidecar: &str, id: &str) -> Targets {
        let routes = self.lock();
        match routes.get(&(sidecar.to_string(), id.to_string())) {
            Some(route) => Targets {
                page: route.page,
                views: route.views.clone(),
            },
            None => Targets {
                page: false,
                views: Vec::new(),
            },
        }
    }

    /// Removes every route; a load of the main document does this, because the new document registers its own receivers.
    pub(crate) fn clear(&self) {
        self.lock().clear();
    }
}

/// The message that the host posts to a view for a sidecar message: {"sok":1,"event":"sidecar.message","data":{"id","body"}},
/// composed around the raw body that the sidecar sent, which is not parsed again.
pub(crate) fn view_message(id: &str, body: &RawValue) -> String {
    let id = Value::String(id.to_string()).to_string();
    format!(
        r#"{{"sok":1,"event":"sidecar.message","data":{{"id":{id},"body":{}}}}}"#,
        body.get()
    )
}

fn non_empty(text: &str, call: &str, field: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err(format!("{call} requires a non-empty {field}"));
    }
    Ok(())
}

/// The call sidecarListen {sidecar, id, on} of the main page; the argument decoder checks its form.
#[derive(Deserialize)]
pub struct SidecarListenRequest {
    pub sidecar: String,
    pub id: String,
    pub on: bool,
}

impl SidecarListenRequest {
    /// Refuses an empty sidecar or id.
    pub fn check(self) -> Result<Self, String> {
        const CALL: &str = "sidecarListen";
        non_empty(&self.sidecar, CALL, "sidecar")?;
        non_empty(&self.id, CALL, "id")?;
        Ok(self)
    }
}

/// The call viewSidecarRoute {surface, generation, sidecar, id, on} of the main page; the argument decoder checks its form.
#[derive(Deserialize)]
pub struct ViewSidecarRouteRequest {
    pub surface: String,
    pub generation: u64,
    pub sidecar: String,
    pub id: String,
    pub on: bool,
}

impl ViewSidecarRouteRequest {
    /// Refuses an empty surface, sidecar or id and a generation outside the source generations.
    pub fn check(self) -> Result<Self, String> {
        const CALL: &str = "viewSidecarRoute";
        non_empty(&self.surface, CALL, "surface")?;
        if self.generation == 0 {
            return Err(format!("{CALL} has no source generation"));
        }
        crate::source_origins::validate_view_source_generation_limit(self.generation, CALL)?;
        non_empty(&self.sidecar, CALL, "sidecar")?;
        non_empty(&self.id, CALL, "id")?;
        Ok(self)
    }
}

#[cfg(test)]
#[path = "sidecar_routes_test.rs"]
mod tests;
