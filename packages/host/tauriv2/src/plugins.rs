//! Plugin operations in the application (docs/spec/installation.md#plugin-operations-in-the-application). It turns the
//! plugin installation of the configuration folder into the installer library of the command line. Only one operation
//! runs at a time, and it announces the change after it.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, TryLockError};

use serde_json::Value;
use soksak_sok::plugins::{self, PluginActionResult, PluginsState, StarterJob, StarterJobRequest};

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
        plugins::read_plugins_state(&self.config_dir)
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
