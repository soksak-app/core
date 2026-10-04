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

    fn on_interrupt(&self, _interrupted: Box<dyn FnOnce() + Send>) -> Result<(), String> {
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

    fn paths_dir(&self) -> Result<PathBuf, String> {
        Err("path entries are not implemented on windows".into())
    }

    fn key(&self) -> Result<String, String> {
        Err("platform key is not implemented on windows".into())
    }
}
