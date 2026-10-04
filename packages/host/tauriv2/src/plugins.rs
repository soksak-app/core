//! 애플리케이션 안의 plugin 작업(docs/spec/installation.md#plugin-operations-in-the-application). 설정 폴더의 plugin
//! 설치를 command line 의 installer library 로 바꾼다. 작업은 한 번에 하나만 실행하고, 바꾼 뒤 알린다.

use std::path::PathBuf;
use std::sync::{Mutex, TryLockError};

use serde_json::Value;
use soksak_sok::plugins::{self, PluginActionResult, PluginsState};

/// pluginsRun 호출의 인자. plugin 은 문자열이 아닌 값을 거부하기 위해 형을 정하지 않고 받는다.
#[derive(Debug, serde::Deserialize)]
pub struct RunRequest {
    pub action: String,
    pub plugin: Value,
}

/// pluginsUseRegistry 호출의 인자. index 는 문자열이 아닌 값을 거부하기 위해 형을 정하지 않고 받는다.
#[derive(Debug, serde::Deserialize)]
pub struct RegistryRequest {
    pub index: Value,
}

/// plugins-changed event 의 값.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Changed {
    pub action: String,
    pub plugin: String,
}

/// 설정 폴더의 plugin 설치를 바꾼다.
pub struct Plugins {
    config_dir: PathBuf,
    core: String,
    platform: String,
    running: Mutex<()>,
    changed: Box<dyn Fn(Changed) + Send + Sync>,
}

impl Plugins {
    /// 이 애플리케이션의 core version 과 platform 으로 작업한다.
    pub fn new(
        config_dir: PathBuf,
        changed: Box<dyn Fn(Changed) + Send + Sync>,
    ) -> Result<Plugins, String> {
        Ok(Plugins {
            config_dir,
            core: soksak_sok::version::CORE_VERSION.to_string(),
            platform: soksak_sok::current_platform()?,
            running: Mutex::new(()),
            changed,
        })
    }

    /// registry 주소, 검사한 index, 설치 상태를 돌려준다.
    pub fn state(&self) -> Result<PluginsState, String> {
        plugins::read_plugins_state(&self.config_dir, &mut std::io::stderr())
    }

    /// sok registry use <index> 와 같이 registry index 를 정하고 그 출력을 돌려준다.
    pub fn use_registry(&self, request: RegistryRequest) -> Result<Value, String> {
        let index = match request.index.as_str() {
            Some(index) if !index.is_empty() => index.to_string(),
            _ => return Err("index must be a non-empty string".to_string()),
        };
        let _running = match self.running.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => {
                return Err("another plugin operation is running".to_string())
            }
            Err(TryLockError::Poisoned(error)) => {
                return Err(format!("plugin operation state: {error}"))
            }
        };
        let url = plugins::use_registry(
            &self.config_dir,
            &index,
            &soksak_sok::fetch::Fetcher::default(),
        )?;
        Ok(serde_json::json!({ "index": url }))
    }

    /// sok plugin <action> <plugin> 과 같은 작업을 실행하고 그 출력을 돌려준다.
    pub fn run(&self, request: RunRequest) -> Result<PluginActionResult, String> {
        match request.action.as_str() {
            "install" | "update" | "remove" | "enable" | "disable" => {}
            action => return Err(format!("unknown plugin action {action:?}")),
        }
        let plugin = match request.plugin.as_str() {
            Some(plugin) if !plugin.is_empty() => plugin.to_string(),
            _ => return Err("plugin must be a non-empty string".to_string()),
        };
        let result = {
            let _running = match self.running.try_lock() {
                Ok(guard) => guard,
                Err(TryLockError::WouldBlock) => {
                    return Err("another plugin operation is running".to_string())
                }
                Err(TryLockError::Poisoned(error)) => {
                    return Err(format!("plugin operation state: {error}"))
                }
            };
            plugins::run_plugin_action(
                &self.config_dir,
                &request.action,
                &plugin,
                &self.core,
                &self.platform,
                &mut std::io::stderr(),
            )?
        };
        (self.changed)(Changed {
            action: request.action,
            plugin,
        });
        Ok(result)
    }
}
