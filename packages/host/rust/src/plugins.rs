//! Plugin operations in the application (docs/spec/installation.md#plugin-operations-in-the-application). It turns the
//! plugin installation of the configuration folder into the installer library of the command line. Only one operation
//! runs at a time, and it announces the change after it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, TryLockError};

use serde_json::Value;
use soksak_sok::plugins::{
    self, HeldOperation, HeldService, PluginActionResult, PluginsState, StartFailure, StarterJob,
    StarterJobRequest,
};
use soksak_sok::service_hold::{Held, Running, Services};

/// The arguments of the pluginsRun call. plugin and end are received without a fixed type so that a value that is not a
/// string, or an end other than true, is rejected.
#[derive(Debug, serde::Deserialize)]
pub struct RunRequest {
    pub action: String,
    pub plugin: Value,
    #[serde(default)]
    pub end: Option<Value>,
}

/// What a plugin operation reads and ends of the persistent services of the host (docs/spec/persistent-services.md#updates).
/// The sidecars implement it.
pub trait PluginServices: Send + Sync {
    /// Holds every start of a persistent service until end_plugin_operation.
    fn begin_plugin_operation(&self);
    /// Lets the held starts run.
    fn end_plugin_operation(&self);
    /// The version that the live service of each declared persistent sidecar runs; it starts no service.
    fn running_services(&self) -> Result<Services, String>;
    /// The running version and the sessions count of each service of held, and whether one still holds it.
    fn held_services(&self, held: &Held) -> (Vec<HeldService>, bool);
    /// Ends the services that hold held and waits for the exit of their processes.
    fn end_services(&self, held: &Held) -> Result<(), String>;
}

/// Returns the persistent services of the host, None while the host has no sidecars.
pub type ServicesSource = Box<dyn Fn() -> Option<Arc<dyn PluginServices>> + Send + Sync>;

/// The arguments of the pluginsUseRegistry call. index is received without a fixed type so that a value that is not a
/// string is rejected.
#[derive(Debug, serde::Deserialize)]
pub struct RegistryRequest {
    pub index: Value,
}

/// The arguments of the pluginsStarter call.
#[derive(Debug, serde::Deserialize)]
pub struct StarterRequest {
    pub state: String,
    pub pack: String,
    pub registry: String,
    pub plugins: Vec<String>,
}

/// The value of the plugins-changed event.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Changed {
    pub action: String,
    pub plugin: String,
}

/// Changes the plugin installation of the configuration folder.
pub struct Plugins {
    config_dir: PathBuf,
    core: String,
    platform: String,
    running: Mutex<()>,
    /// Set when the shutdown of the host begins; the update at start checks it before each step that changes the installation.
    stopped: AtomicBool,
    /// The failures of the update at start, which the state reports (docs/spec/installation.md#update-at-start).
    start_failures: Mutex<Vec<StartFailure>>,
    /// The latest held operation of each plugin, with its action.
    held: Mutex<BTreeMap<String, (String, Held)>>,
    services: ServicesSource,
    /// Applies an operation to the sidecars (docs/spec/installation.md#applying-a-change).
    apply: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
    changed: Box<dyn Fn(Changed) + Send + Sync>,
}

impl Plugins {
    /// Works with the core version and the platform of this application.
    /// services returns the persistent services of the host, or None while it has none.
    pub fn new(
        config_dir: PathBuf,
        services: ServicesSource,
        apply: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
        changed: Box<dyn Fn(Changed) + Send + Sync>,
    ) -> Result<Plugins, String> {
        Ok(Plugins {
            config_dir,
            core: soksak_sok::version::CORE_VERSION.to_string(),
            platform: soksak_sok::current_platform()?,
            running: Mutex::new(()),
            stopped: AtomicBool::new(false),
            start_failures: Mutex::new(vec![]),
            held: Mutex::new(BTreeMap::new()),
            services,
            apply,
            changed,
        })
    }

    /// The configuration folder in which plugins are installed.
    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    /// Returns the registry address, the checked index, the installation state, the failures of the update at start and the
    /// held operations. A held operation whose services no longer hold it is dropped
    /// (docs/spec/persistent-services.md#updates).
    pub fn state(&self) -> Result<PluginsState, String> {
        let mut state = plugins::read_plugins_state(&self.config_dir, &self.core)?;
        state.start_update = self
            .start_failures
            .lock()
            .map_err(|error| format!("plugin operation state: {error}"))?
            .clone();
        let services = (self.services)();
        let mut held = self
            .held
            .lock()
            .map_err(|error| format!("plugin operation state: {error}"))?;
        held.retain(|plugin, (action, entry)| {
            let Some(services) = &services else {
                return false;
            };
            let (sidecars, holds) = services.held_services(entry);
            if holds {
                state.held.push(HeldOperation {
                    plugin: plugin.clone(),
                    action: action.clone(),
                    version: entry.version.clone(),
                    error: entry.error.clone(),
                    sidecars,
                });
            }
            holds
        });
        Ok(state)
    }

    /// Runs the installer for action on plugin with what it needs of the running services: the services are held from the
    /// comparison to the end of the apply step, a held operation is kept for the state, and with end the services that hold
    /// it end before installed.json is written (docs/spec/persistent-services.md#updates). stop runs the update at start. The
    /// caller holds the operation lock.
    fn operate(
        &self,
        action: &str,
        plugin: &str,
        end: bool,
        stop: Option<&dyn Fn() -> bool>,
    ) -> Operation {
        let services =
            (self.services)().filter(|_| matches!(action, "install" | "update" | "enable"));
        let held_now = std::cell::Cell::new(false);
        let keep = |held: &Held| {
            held_now.set(true);
            self.held
                .lock()
                // default: the held list stays writable after poison; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .insert(plugin.to_string(), (action.to_string(), held.clone()));
        };
        let ending = |held: &Held| match &services {
            Some(services) => services.end_services(held),
            // default: without services no operation is held, so no end is asked for.
            None => Ok(()),
        };
        let mut running = Running::default();
        if let Some(services) = &services {
            services.begin_plugin_operation();
            match services.running_services() {
                Ok(live) => running.services = live,
                Err(error) => {
                    services.end_plugin_operation();
                    return Operation::failed(error);
                }
            }
            running.held = Some(&keep);
            if end {
                running.end = Some(&ending);
            }
        }
        let outcome = (|| {
            let result = match stop {
                Some(stop) => plugins::update_plugin_unless(
                    &self.config_dir,
                    plugin,
                    &self.core,
                    &self.platform,
                    &running,
                    stop,
                )
                .map(PluginActionResult::Installed),
                None => plugins::run_plugin_action(
                    &self.config_dir,
                    action,
                    plugin,
                    &self.core,
                    &self.platform,
                    &running,
                ),
            };
            let result = match result {
                Ok(result) => result,
                Err(error) => {
                    return Operation {
                        held: held_now.get(),
                        ..Operation::failed(error)
                    };
                }
            };
            self.held
                .lock()
                // default: the held list stays writable after poison; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .remove(plugin);
            // The apply step changes the sidecars of the installation, so it does not run after the shutdown began.
            if stop.is_some_and(|stop| stop()) {
                return Operation::failed(STOPPING.to_string());
            }
            Operation {
                result: Ok((result, (self.apply)())),
                held: false,
            }
        })();
        if let Some(services) = &services {
            services.end_plugin_operation();
        }
        outcome
    }

    /// Sets the registry index like sok registry use <index> and returns its output.
    pub fn use_registry(&self, request: RegistryRequest) -> Result<Value, String> {
        let index = match request.index.as_str() {
            Some(index) if !index.is_empty() => index.to_string(),
            _ => return Err("index must be a non-empty string".to_string()),
        };
        let _running = match self.running.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => {
                return Err("another plugin operation is running".to_string());
            }
            Err(TryLockError::Poisoned(error)) => {
                return Err(format!("plugin operation state: {error}"));
            }
        };
        let url = plugins::use_registry(
            &self.config_dir,
            &index,
            &soksak_sok::fetch::Fetcher::default(),
        )?;
        Ok(serde_json::json!({ "index": url }))
    }

    /// Records or completes the durable starter job under the plugin-operation lock.
    pub fn set_starter(&self, request: StarterRequest) -> Result<StarterJob, String> {
        let _running = match self.running.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => {
                return Err("another plugin operation is running".to_string());
            }
            Err(TryLockError::Poisoned(error)) => {
                return Err(format!("plugin operation state: {error}"));
            }
        };
        plugins::write_starter_job(
            &self.config_dir,
            StarterJobRequest {
                state: request.state,
                pack: request.pack,
                registry: request.registry,
                plugins: request.plugins,
            },
        )
    }

    /// Runs the same operation as sok plugin <action> <plugin> and returns its output.
    pub fn run(&self, request: RunRequest) -> Result<PluginActionResult, String> {
        match request.action.as_str() {
            "install" | "update" | "remove" | "enable" | "disable" => {}
            action => return Err(format!("unknown plugin action {action:?}")),
        }
        let plugin = match request.plugin.as_str() {
            Some(plugin) if !plugin.is_empty() => plugin.to_string(),
            _ => return Err("plugin must be a non-empty string".to_string()),
        };
        let end = match &request.end {
            None => false,
            Some(Value::Bool(true)) => {
                if !matches!(request.action.as_str(), "install" | "update" | "enable") {
                    return Err(format!("end does not apply to {}", request.action));
                }
                true
            }
            Some(_) => return Err("end must be true".to_string()),
        };
        let (result, applied) = {
            let _running = match self.running.try_lock() {
                Ok(guard) => guard,
                Err(TryLockError::WouldBlock) => {
                    return Err("another plugin operation is running".to_string());
                }
                Err(TryLockError::Poisoned(error)) => {
                    return Err(format!("plugin operation state: {error}"));
                }
            };
            self.operate(&request.action, &plugin, end, None).result?
        };
        // installed.json changed, so the windows are notified also when the apply step fails; that failure is the
        // error of the operation.
        let action = request.action;
        (self.changed)(Changed {
            action: action.clone(),
            plugin: plugin.clone(),
        });
        applied.map_err(|error| format!("apply {action} {plugin}: {error}"))?;
        Ok(result)
    }
}

/// The outcome of one step of the update at start (docs/spec/installation.md#update-at-start). `plugin` is the id of the plugin
/// that the step concerns; it is empty for a step about the registry. `error` is the failure of the step, None when the plugin was
/// updated from `from` to `to`. A value with an empty `plugin` and no `error` reports that no registry is configured.
/// `held` reports that a running service holds the update, which stays as it is (docs/spec/persistent-services.md#updates).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StartUpdate {
    pub plugin: String,
    pub from: String,
    pub to: String,
    pub error: Option<String>,
    pub held: bool,
}

/// The outcome of operate: the result of the installer with the result of the apply step, which runs after a change of
/// installed.json, or the error of the installer; and whether a running service held the operation.
struct Operation {
    result: Result<(PluginActionResult, Result<(), String>), String>,
    held: bool,
}

impl Operation {
    fn failed(error: String) -> Operation {
        Operation {
            result: Err(error),
            held: false,
        }
    }
}

impl Plugins {
    /// Begins the shutdown of the host: the update at start starts no further plugin and changes no installation step after
    /// this call (docs/spec/installation.md#update-at-start).
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    /// Updates the installed plugins that the running core refuses or that are older than the newest accepted version
    /// (docs/spec/installation.md#update-at-start). Each update runs the same installer call, apply step and notification as the
    /// plugin operation of the page, and it waits for another plugin operation to end.
    pub fn update_at_start(&self) -> Vec<StartUpdate> {
        let index = match soksak_sok::plugins::read_registry_if_set(&self.config_dir) {
            Ok(Some(index)) => index,
            Ok(None) => return vec![StartUpdate::default()],
            Err(error) => return vec![failed_start("", error)],
        };
        let (state, manifests) =
            match soksak_sok::plugins::read_installed_manifests(&self.config_dir) {
                Ok(read) => read,
                Err(error) => return vec![failed_start("", error)],
            };
        let outdated =
            match soksak_sok::plugins::outdated_plugins(&index, &state, &manifests, &self.core) {
                Ok(outdated) => outdated,
                Err(error) => return vec![failed_start("", error)],
            };
        let results: Vec<StartUpdate> = outdated
            .into_iter()
            .map(|item| {
                if item.candidate.is_empty() {
                    StartUpdate {
                        plugin: item.id,
                        from: item.installed,
                        to: String::new(),
                        error: Some(item.refused),
                        held: false,
                    }
                } else if self.stopped.load(Ordering::SeqCst) {
                    StartUpdate {
                        plugin: item.id,
                        from: item.installed,
                        to: String::new(),
                        error: Some(STOPPING.to_string()),
                        held: false,
                    }
                } else {
                    self.update_one_at_start(&item)
                }
            })
            .collect();
        self.keep_start_failures(&results);
        results
    }

    /// Keeps the failures among the results of this update at start for the state. A failure of the registry has the place
    /// plugins update, and a failure of a plugin has the place plugin update <id>.
    fn keep_start_failures(&self, results: &[StartUpdate]) {
        let failures: Vec<StartFailure> = results
            .iter()
            .filter(|result| !result.held)
            .filter_map(|result| {
                let error = result.error.clone()?;
                let r#where = if result.plugin.is_empty() {
                    "plugins update".to_string()
                } else {
                    format!("plugin update {}", result.plugin)
                };
                Some(StartFailure {
                    r#where,
                    text: error,
                })
            })
            .collect();
        let mut kept = self
            .start_failures
            .lock()
            // default: the failure list stays writable after poison; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        *kept = failures;
    }

    /// Runs the update of one outdated plugin as the plugin operation of the page does: the installer, the apply step, then
    /// the notification.
    fn update_one_at_start(&self, item: &soksak_sok::plugins::Outdated) -> StartUpdate {
        let mut result = StartUpdate {
            plugin: item.id.clone(),
            from: item.installed.clone(),
            ..StartUpdate::default()
        };
        let applied = {
            // default: the operation lock still serializes after poison; the panic hook records the panic.
            let _running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
            let outcome = self.operate(
                "update",
                &item.id,
                false,
                Some(&|| self.stopped.load(Ordering::SeqCst)),
            );
            match outcome.result {
                Ok((_, applied)) => applied,
                Err(error) => {
                    result.error = Some(error);
                    result.held = outcome.held;
                    return result;
                }
            }
        };
        (self.changed)(Changed {
            action: "update".to_string(),
            plugin: item.id.clone(),
        });
        if let Err(error) = applied {
            result.error = Some(format!("apply update {}: {error}", item.id));
            return result;
        }
        match plugins::read_installed(&self.config_dir) {
            Ok(state) => match state.plugins.get(&item.id) {
                Some(plugin) => result.to = plugin.version.clone(),
                None => {
                    result.error = Some(format!(
                        "installed state has no plugin {} after its update",
                        item.id
                    ))
                }
            },
            Err(error) => result.error = Some(error),
        }
        result
    }
}

/// The failure of an update at start that the shutdown of the host ended before it began.
const STOPPING: &str = "the host is shutting down";

/// A failed step of the update at start that concerns the registry or the installation state, not one plugin.
fn failed_start(plugin: &str, error: String) -> StartUpdate {
    StartUpdate {
        plugin: plugin.to_string(),
        error: Some(error),
        ..StartUpdate::default()
    }
}

#[cfg(test)]
#[path = "plugins_request_test.rs"]
mod plugins_request_test;
