//! A framework of the tests: it names the application, runs a task at once and has no window.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::framework::{
    AppHandle, BlockingBody, BlockingTask, Error, Framework, Frontend, Result, Window,
    WindowOptions,
};

/// The display name of the test framework, the end of a window title.
pub const DISPLAY_NAME: &str = "Fixture";

/// The framework of the tests.
pub struct Fixture;

impl Framework for Fixture {
    fn application_name(&self) -> &'static str {
        "fixture"
    }

    fn display_name(&self) -> &'static str {
        DISPLAY_NAME
    }

    fn post(&self, task: Box<dyn FnOnce() + Send>) -> Result<()> {
        task();
        Ok(())
    }

    fn spawn_blocking(&self, task: BlockingBody) -> BlockingTask {
        let value = task();
        Box::pin(async { Ok(value) })
    }

    fn quit(&self) {}

    fn config_dir(&self) -> Result<PathBuf> {
        Err(Error::from(
            "the test framework has no configuration directory",
        ))
    }

    fn home_dir(&self) -> Result<PathBuf> {
        Err(Error::from("the test framework has no home directory"))
    }

    fn choose_folder(&self, _window: &Window, _title: &str) -> Result<Option<PathBuf>> {
        Ok(None)
    }

    fn save_file(
        &self,
        _window: &Window,
        _name: &str,
        _directory: Option<&Path>,
    ) -> Result<Option<PathBuf>> {
        Ok(None)
    }

    fn set_menu(&self, _menus: Vec<crate::menu::Menu>) -> Result<()> {
        Ok(())
    }

    fn install_dock(&self, _new_window: Box<dyn Fn()>) -> Result<()> {
        Ok(())
    }

    fn new_window(&self, _options: WindowOptions) -> Result<Arc<dyn Frontend>> {
        Err(Error::from("the test framework has no window"))
    }

    fn windows(&self) -> Vec<Arc<dyn Frontend>> {
        Vec::new()
    }

    fn get_webview(&self, _label: &str) -> Option<(Arc<dyn Frontend>, String)> {
        None
    }
}

/// The application of the test framework. The first application of the test process names the host.
pub fn application() -> AppHandle {
    AppHandle::new(Arc::new(Fixture))
}
