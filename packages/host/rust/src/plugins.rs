//! Plugin operations in the application (docs/spec/installation.md#plugin-operations-in-the-application). It turns the
//! plugin installation of the configuration folder into the installer library of the command line. Only one operation
//! runs at a time, and it announces the change after it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError, TryLockError};

use serde_json::Value;
use soksak_sok::plugins::{
    self, PluginActionResult, PluginsState, StartFailure, StarterJob, StarterJobRequest,
};

/// The arguments of the pluginsRun call. plugin is received without a fixed type so that a value that is not a string
/// is rejected.
#[derive(Debug, serde::Deserialize)]
pub struct RunRequest {
    pub action: String,
    pub plugin: Value,
}

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
    /// Applies an operation to the sidecars (docs/spec/installation.md#applying-a-change).
    apply: Box<dyn Fn() -> Result<(), String> + Send + Sync>,
    changed: Box<dyn Fn(Changed) + Send + Sync>,
}

impl Plugins {
    /// Works with the core version and the platform of this application.
    pub fn new(
        config_dir: PathBuf,
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
            apply,
            changed,
        })
    }

    /// The configuration folder in which plugins are installed.
    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    /// Returns the registry address, the checked index and the installation state.
    pub fn state(&self) -> Result<PluginsState, String> {
        let mut state = plugins::read_plugins_state(&self.config_dir, &self.core)?;
        state.start_update = self
            .start_failures
            .lock()
            .map_err(|error| format!("plugin operation state: {error}"))?
            .clone();
        Ok(state)
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
            let result = plugins::run_plugin_action(
                &self.config_dir,
                &request.action,
                &plugin,
                &self.core,
                &self.platform,
            )?;
            (result, (self.apply)())
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
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StartUpdate {
    pub plugin: String,
    pub from: String,
    pub to: String,
    pub error: Option<String>,
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
                    }
                } else if self.stopped.load(Ordering::SeqCst) {
                    StartUpdate {
                        plugin: item.id,
                        from: item.installed,
                        to: String::new(),
                        error: Some(STOPPING.to_string()),
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
            to: String::new(),
            error: None,
        };
        let applied = {
            // default: the operation lock still serializes after poison; the panic hook records the panic.
            let _running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
            if let Err(error) = plugins::update_plugin_unless(
                &self.config_dir,
                &item.id,
                &self.core,
                &self.platform,
                &|| self.stopped.load(Ordering::SeqCst),
            ) {
                result.error = Some(error);
                return result;
            }
            // The apply step changes the sidecars of the installation, so it does not run after the shutdown began.
            if self.stopped.load(Ordering::SeqCst) {
                result.error = Some(STOPPING.to_string());
                return result;
            }
            (self.apply)()
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
