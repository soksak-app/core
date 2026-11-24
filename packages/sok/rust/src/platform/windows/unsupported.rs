use std::path::PathBuf;

use super::super::{Connection, Platform};
use super::Windows;

impl Platform for Windows {
    fn process_running(&self, _pid: i32) -> Result<(), String> {
        Err("process check is not implemented on windows".into())
    }

    fn connect(&self, _address: &str) -> Result<Box<dyn Connection>, String> {
        Err("endpoint connection is not implemented on windows".into())
    }

    fn on_interrupt(
        &self,
        _interrupted: Box<dyn FnOnce(&'static str) + Send>,
    ) -> Result<(), String> {
        Err("interrupt signals is not implemented on windows".into())
    }

    fn config_dir(&self) -> Result<PathBuf, String> {
        Err("configuration directory is not implemented on windows".into())
    }

    fn executable(&self, _metadata: &std::fs::Metadata) -> bool {
        false
    }

    fn set_executable(&self, _path: &std::path::Path, _executable: bool) -> Result<(), String> {
        Err("file modes is not implemented on windows".into())
    }

    fn close_file(&self, _file: std::fs::File, _path: &std::path::Path) -> Result<(), String> {
        Err("file close is not implemented on windows".into())
    }

    fn open_index(&self, _path: &std::path::Path) -> Result<std::fs::File, String> {
        Err("index files are not implemented on windows".into())
    }

    fn lock_file(&self, _file: &std::fs::File) -> Result<(), String> {
        Err("file locks are not implemented on windows".into())
    }

    fn same_file(&self, _file: &std::fs::File, _path: &std::path::Path) -> Result<bool, String> {
        Err("file identity is not implemented on windows".into())
    }

    fn prepare_log_directory(&self, path: &std::path::Path) -> Result<(), String> {
        Err(format!(
            "event log directory {} is not implemented on windows",
            path.display()
        ))
    }

    fn create_log_file(&self, path: &std::path::Path) -> Result<std::fs::File, String> {
        Err(format!(
            "event log file {} is not implemented on windows",
            path.display()
        ))
    }

    fn append_log_file(&self, path: &std::path::Path) -> Result<std::fs::File, String> {
        Err(format!(
            "event log file {} is not implemented on windows",
            path.display()
        ))
    }

    fn open_process_lock_file(&self, path: &std::path::Path) -> Result<std::fs::File, String> {
        Err(format!(
            "process lock file {} is not implemented on windows",
            path.display()
        ))
    }

    fn user_path(&self) -> Result<(), String> {
        Err("the user PATH registration is not implemented on windows".into())
    }

    fn user_path_state(
        &self,
        _environment: &crate::setup::Environment,
    ) -> Result<crate::setup::Part, String> {
        Err("user PATH registration is not implemented on windows".into())
    }

    fn configure_user_path(
        &self,
        _environment: &crate::setup::Environment,
        _shell: &str,
        _executable: &std::path::Path,
        _enabled: Option<bool>,
    ) -> Result<bool, String> {
        Err("user PATH registration is not implemented on windows".into())
    }

    fn extract_bundle(
        &self,
        _zip: &std::path::Path,
        _folder: &std::path::Path,
    ) -> Result<(), String> {
        Err("application bundles are not implemented on windows".into())
    }

    fn service_process_exists(
        &self,
        _pid: u32,
        _published: std::time::SystemTime,
    ) -> Result<bool, String> {
        Err("service process inspection is not implemented on windows".into())
    }

    fn wait_process_end(&self, _pid: i32) -> Result<(), String> {
        Err("waiting for a process end is not implemented on windows".into())
    }

    fn copy_bundle(
        &self,
        _source: &std::path::Path,
        _destination: &std::path::Path,
    ) -> Result<(), String> {
        Err("application bundles are not implemented on windows".into())
    }

    fn open_application(
        &self,
        _bundle: &std::path::Path,
        _arguments: &[String],
        _activate: bool,
    ) -> Result<(), String> {
        Err("application bundles are not implemented on windows".into())
    }

    fn bundle_version(&self, _bundle: &std::path::Path) -> Result<String, String> {
        Err("application bundles are not implemented on windows".into())
    }

    fn monotonic_nanos(&self) -> Result<u64, String> {
        Err("the monotonic clock is not implemented on windows".into())
    }

    fn key(&self) -> Result<String, String> {
        Err("platform key is not implemented on windows".into())
    }

    fn read_only_volume(&self, path: &std::path::Path) -> Result<bool, String> {
        Err(format!(
            "the read-only flag of the volume of {} is not implemented on windows",
            path.display()
        ))
    }

    fn registrable_sok(&self, _sok: &std::path::Path) -> Result<bool, String> {
        Err("application bundles are not implemented on windows".into())
    }

    fn exec(&self, _program: &std::path::Path, _arguments: &[String]) -> String {
        "process replacement is not implemented on windows".into()
    }
}
