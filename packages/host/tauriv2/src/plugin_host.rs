//! The plugin host web views of a window (docs/spec/plugin-host.md). The host creates the plugin host webview of a
//! plugin when the main page of the window loads a plugin whose manifest declares host, and disposes it when the
//! plugin is removed or disabled, when the application applies a plugin change that reloads the window, and when the
//! window closes. The channel of the host page is in plugin_host_channel.rs; the restart limit and the saved state of
//! the host pages are here (docs/spec/plugin-host.md#restarts, docs/spec/plugin-host.md#state).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use serde_json::{Value, json};

use crate::platform::Handle;
use crate::sidecars::RestartRecord;

/// One enabled installed plugin whose manifest declares host, with its id, its page and its declared state, which is
/// None when the declaration names no state.
#[derive(Debug, Clone, PartialEq)]
pub struct HostPlugin {
    pub id: String,
    pub page: String,
    pub state: Option<HostState>,
}

/// The state field of a host declaration: the format number of the saved value and its size limit in bytes
/// (docs/spec/plugin-host.md#declaration).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostState {
    pub format: u64,
    pub max_bytes: u64,
}

/// Returns the enabled installed plugins whose manifest declares host, in id order. A host declaration that is not an
/// object, whose page is not a non-empty string, or whose state is not {format, maxBytes} with positive integers, is
/// an error (docs/spec/plugin-host.md#declaration). The texts of the errors are the same in both hosts
/// (docs/spec/host-contract.md).
pub fn host_plugins(config_dir: &Path) -> Result<Vec<HostPlugin>, String> {
    let (state, manifests) = soksak_sok::plugins::read_installed_manifests(config_dir)?;
    let mut hosts = vec![];
    // The plugins are a BTreeMap, so the ids are in order.
    for (id, plugin) in &state.plugins {
        if !plugin.enabled {
            continue;
        }
        let manifest = manifests
            .get(id)
            .ok_or_else(|| format!("plugin {id} has no installed manifest"))?;
        if let Some((page, state)) = host_declaration(id, &manifest.value)? {
            hosts.push(HostPlugin {
                id: id.clone(),
                page,
                state,
            });
        }
    }
    Ok(hosts)
}

/// Returns the page and the state of the host declaration of the manifest of plugin, or None when the manifest declares
/// no host. The state is None when the declaration names none.
pub fn host_declaration(
    plugin: &str,
    manifest: &Value,
) -> Result<Option<(String, Option<HostState>)>, String> {
    let host = match manifest.get("host") {
        None | Some(Value::Null) => return Ok(None),
        Some(host) => host,
    };
    let fields = host
        .as_object()
        .ok_or_else(|| format!("plugin {plugin} declares host that is not an object"))?;
    let page = fields
        .get("page")
        .and_then(Value::as_str)
        .filter(|page| !page.is_empty())
        .ok_or_else(|| format!("plugin {plugin} declares host without a page"))?;
    let state = match fields.get("state") {
        None => None,
        Some(state) => host_state_declaration(plugin, state)?,
    };
    Ok(Some((page.to_string(), state)))
}

/// Returns the state field of the host declaration of plugin. It is an object of exactly format and maxBytes, each a
/// positive integer, in the form of surface.unload (docs/spec/plugin-host.md#declaration).
fn host_state_declaration(plugin: &str, state: &Value) -> Result<Option<HostState>, String> {
    let invalid = || {
        format!(
            "plugin {plugin} declares host state that is not {{format, maxBytes}} with positive integers"
        )
    };
    let fields = state
        .as_object()
        .filter(|fields| fields.len() == 2)
        .ok_or_else(invalid)?;
    let positive = |name: &str| {
        fields
            .get(name)
            .and_then(Value::as_u64)
            .filter(|value| *value >= 1)
            .ok_or_else(invalid)
    };
    Ok(Some(HostState {
        format: positive("format")?,
        max_bytes: positive("maxBytes")?,
    }))
}

/// The saved values of the plugin hosts of the application, one per plugin with the declared format it was written
/// with, which the host page of every window reads and writes (docs/spec/plugin-host.md#state). The host process holds
/// them until it ends or the plugin is removed or disabled, so a value survives a restart of the host page and not the
/// end of the application.
/// The code with which the host refuses a state call: EXPOSURE_ERRORS.failed of plugin-api, as for a call that the
/// channel does not serve.
const STATE_REFUSAL_CODE: i64 = -32000;

#[derive(Default)]
pub struct PluginHostStates(Mutex<HashMap<String, (u64, Value)>>);

/// Returns true when command is a state call, which the host answers itself (docs/spec/plugin-host.md#state).
pub fn state_call(command: &str) -> bool {
    matches!(command, "state.write" | "state.read")
}

impl PluginHostStates {
    /// Runs the state call command with params for the host of plugin, whose declared state is declared, and returns
    /// the host message of its reply: {"sok", "id", "result"} or {"sok", "id", "error": {code, message}}.
    pub fn answer(
        &self,
        plugin: &str,
        declared: Option<HostState>,
        id: u64,
        command: &str,
        params: &Value,
    ) -> Value {
        match self.run(plugin, declared, command, params) {
            Ok(result) => json!({"sok": 1, "id": id, "result": result}),
            Err(message) => {
                json!({"sok": 1, "id": id, "error": {"code": STATE_REFUSAL_CODE, "message": message}})
            }
        }
    }

    /// Runs the state call command and returns its result. state.read returns {"value"}, the last saved value or null;
    /// state.write saves the value of {"value"} with the declared format and returns null. A host without a declared
    /// state, a write without a value or over maxBytes in compact JSON, and a read of a value of another format are
    /// refused.
    fn run(
        &self,
        plugin: &str,
        declared: Option<HostState>,
        command: &str,
        params: &Value,
    ) -> Result<Value, String> {
        let declared = declared.ok_or_else(|| format!("plugin {plugin} declares no host state"))?;
        // default: a lock that a panicking thread poisoned still holds the saved values; the panic hook records the panic.
        let mut saved = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if command == "state.read" {
            return match saved.get(plugin) {
                None => Ok(json!({"value": null})),
                Some((format, _)) if *format != declared.format => Err(format!(
                    "plugin {plugin} state format {format} is not {}",
                    declared.format
                )),
                Some((_, value)) => Ok(json!({"value": value})),
            };
        }
        let value = params
            .as_object()
            .and_then(|fields| fields.get("value"))
            .ok_or_else(|| format!("plugin {plugin} state.write has no value"))?;
        let bytes = value.to_string().len() as u64;
        if bytes > declared.max_bytes {
            return Err(format!(
                "plugin {plugin} state of {bytes} bytes exceeds {}",
                declared.max_bytes
            ));
        }
        saved.insert(plugin.to_string(), (declared.format, value.clone()));
        Ok(Value::Null)
    }

    /// Applies the plugin change action of plugin to the saved values: a removal or a disable removes the saved value
    /// of the plugin, and every other change keeps it (docs/spec/plugin-host.md#state).
    pub fn plugin_changed(&self, action: &str, plugin: &str) {
        if action == "remove" || action == "disable" {
            self.0
                .lock()
                // default: a lock that a panicking thread poisoned still holds the saved values; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .remove(plugin);
        }
    }
}

/// The plugin host webviews of one window, by plugin id. The values are used only on the main thread; the record is
/// shared with the window state.
#[derive(Default)]
pub struct PluginHosts(Mutex<HashMap<String, Handle>>);

impl PluginHosts {
    /// Returns the plugins of plugins that the window has no host webview of and whose restarts restarts has not
    /// stopped, in the order of plugins (docs/spec/plugin-host.md#restarts).
    pub fn missing(
        &self,
        plugins: &[HostPlugin],
        restarts: &PluginHostRestarts,
    ) -> Vec<HostPlugin> {
        // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
        let hosts = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        plugins
            .iter()
            .filter(|plugin| !hosts.contains_key(&plugin.id) && !restarts.stopped(&plugin.id))
            .cloned()
            .collect()
    }

    /// Records the host webview handle of plugin.
    pub fn insert(&self, plugin: &str, handle: Handle) {
        self.0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .insert(plugin.to_string(), handle);
    }

    /// Removes the record of the host webview of plugin and returns its handle once.
    pub fn take(&self, plugin: &str) -> Option<Handle> {
        self.0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .remove(plugin)
    }

    /// Removes every record and returns the handles.
    pub fn take_all(&self) -> Vec<Handle> {
        self.0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .drain()
            .map(|(_, handle)| handle)
            .collect()
    }

    /// Returns the handle of the host webview of plugin, or None when the window has none.
    pub fn get(&self, plugin: &str) -> Option<Handle> {
        self.0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .get(plugin)
            .copied()
    }

    /// Returns true while a host webview of plugin is being created.
    pub fn contains(&self, plugin: &str) -> bool {
        self.0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(plugin)
    }
}

/// The declaration and the folders of one plugin host webview.
pub struct HostView<'a> {
    /// The absolute path at which the persistent data store keeps the site data.
    pub directory: &'a str,
    /// The installed folder of the plugin.
    pub folder: &'a str,
    /// The id and the page of the plugin whose host the webview runs.
    pub plugin: &'a str,
    pub page: &'a str,
}

/// Creates the plugin host webview of view.plugin with the view configuration
/// (docs/spec/native-surfaces.md#view-surfaces) and loads sok://<plugin>/<page> into it. A failed step closes the
/// webview and reports the reason.
pub fn create_host(
    channel: &str,
    view: HostView<'_>,
    create: impl FnOnce(&str, &HostView<'_>) -> Result<Handle, String>,
    load: impl FnOnce(Handle, &str) -> Result<bool, String>,
    close: impl FnOnce(Handle) -> Result<(), String>,
) -> Result<Handle, String> {
    let handle = create(channel, &view)?;
    let address = format!("sok://{}/{}", view.plugin, view.page);
    let reason = match load(handle, &address) {
        Ok(true) => return Ok(handle),
        Ok(false) => format!("plugin host of {} cannot load {address}", view.plugin),
        Err(error) => error,
    };
    close(handle).map_err(|closing| format!("{reason}; closing the plugin host: {closing}"))?;
    Err(reason)
}

/// The restart-limit record of the plugin host of one plugin over every window: the counted failures of the sidecar
/// failure contract (docs/spec/sidecars.md#failure) and the restarts since the last reset.
#[derive(Default)]
struct HostRestart {
    record: RestartRecord,
    attempts: u64,
}

/// What follows a failure of a plugin host (docs/spec/plugin-host.md#restarts).
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    /// The host is created again; the attempt counts the restarts since the last reset.
    Restart(u64),
    /// The failure is the fourth within 300 seconds: the restarts stop and the host ends in every window.
    Stop,
    /// The restarts were already stopped, so the failure is not counted and nothing follows.
    Stopped,
}

/// The restart-limit records of the plugin hosts of the application, by plugin (docs/spec/plugin-host.md#restarts).
pub struct PluginHostRestarts {
    records: Mutex<HashMap<String, HostRestart>>,
    /// The clock of the limit. A check injects it; the default is the monotonic clock.
    clock: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl Default for PluginHostRestarts {
    fn default() -> Self {
        Self {
            records: Mutex::default(),
            clock: Arc::new(Instant::now),
        }
    }
}

impl PluginHostRestarts {
    /// Changes the clock of the limit. A check injects a clock that it moves.
    pub fn with_clock(mut self, clock: impl Fn() -> Instant + Send + Sync + 'static) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    /// Counts a failure of the plugin host of plugin at the time of the clock and returns what follows.
    pub fn failed(&self, plugin: &str) -> Failure {
        let now = (self.clock)();
        let mut records = self.lock();
        let entry = records.entry(plugin.to_string()).or_default();
        if entry.record.stopped() {
            return Failure::Stopped;
        }
        if entry.record.count(now) {
            return Failure::Stop;
        }
        entry.attempts += 1;
        Failure::Restart(entry.attempts)
    }

    /// Returns true when the limit stopped the restarts of the plugin host of plugin.
    pub fn stopped(&self, plugin: &str) -> bool {
        self.lock()
            .get(plugin)
            .is_some_and(|entry| entry.record.stopped())
    }

    /// Clears the record of the plugin host of plugin when the limit stopped its restarts, and returns true when it did.
    pub fn reset(&self, plugin: &str) -> bool {
        let mut records = self.lock();
        if !records
            .get(plugin)
            .is_some_and(|entry| entry.record.stopped())
        {
            return false;
        }
        records.remove(plugin);
        true
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, HostRestart>> {
        // default: a lock that a panicking thread poisoned still holds the restart records; the panic hook records the panic.
        self.records.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
