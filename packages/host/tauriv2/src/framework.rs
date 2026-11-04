//! The Tauri application as the Framework port of the language host library.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use soksak_host::framework::{self as port, BlockingTask, WindowOptions};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::frontend::Frontend;

/// The Tauri application, which the endpoint plugin binds when the framework first gives it.
static APPLICATION: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Binds the Tauri application that the Framework reaches.
pub(crate) fn bind(app: &tauri::AppHandle) {
    // A second binding of the process keeps the application of the first, which is the only application.
    APPLICATION.get_or_init(|| app.clone());
}

fn application() -> &'static tauri::AppHandle {
    APPLICATION
        .get()
        .expect("the endpoint plugin binds the application before the host calls the framework")
}

/// The port error of a framework error.
pub(crate) fn error(error: impl std::fmt::Display) -> port::Error {
    port::Error::from(error.to_string())
}

/// The Tauri window of window.
fn tauri_window(window: &port::Window) -> port::Result<tauri::Window> {
    application()
        .get_window(window.label())
        .ok_or_else(|| port::Error::from(format!("window {} is not open", window.label())))
}

fn frontend(window: tauri::Window) -> Arc<dyn port::Frontend> {
    Arc::new(Frontend::new(window))
}

/// The Tauri application as the Framework port.
pub struct Framework;

impl port::Framework for Framework {
    fn application_name(&self) -> &'static str {
        "tauriv2"
    }

    fn display_name(&self) -> &'static str {
        "Tauri v2"
    }

    /// On the main thread Tauri runs the task before it returns.
    fn post(&self, task: Box<dyn FnOnce() + Send>) -> port::Result<()> {
        application().run_on_main_thread(task).map_err(error)
    }

    fn spawn_blocking(&self, task: port::BlockingBody) -> BlockingTask {
        let running = tauri::async_runtime::spawn_blocking(task);
        Box::pin(async move { running.await.map_err(error) })
    }

    fn quit(&self) {
        application().exit(0)
    }

    fn config_dir(&self) -> port::Result<PathBuf> {
        application().path().config_dir().map_err(error)
    }

    fn home_dir(&self) -> port::Result<PathBuf> {
        application().path().home_dir().map_err(error)
    }

    fn choose_folder(&self, window: &port::Window, title: &str) -> port::Result<Option<PathBuf>> {
        let parent = tauri_window(window)?;
        application()
            .dialog()
            .file()
            .set_parent(&parent)
            .set_title(title)
            .blocking_pick_folder()
            .map(|path| path.into_path())
            .transpose()
            .map_err(error)
    }

    fn save_file(
        &self,
        window: &port::Window,
        name: &str,
        directory: Option<&Path>,
    ) -> port::Result<Option<PathBuf>> {
        let parent = tauri_window(window)?;
        let mut dialog = application().dialog().file().set_parent(&parent);
        if let Some(directory) = directory {
            dialog = dialog.set_directory(directory);
        }
        dialog
            .set_file_name(name)
            .blocking_save_file()
            .map(|path| path.into_path())
            .transpose()
            .map_err(error)
    }

    fn set_menu(&self, menus: Vec<soksak_host::menu::Menu>) -> port::Result<()> {
        let app = application();
        let menu = crate::menu::application_menu(app, menus)?;
        app.set_menu(menu).map(drop).map_err(error)
    }

    fn install_dock(&self, new_window: Box<dyn Fn()>) -> port::Result<()> {
        soksak_host::platform::current()?
            .install_dock_menu(new_window)
            .map_err(port::Error::from)
    }

    fn new_window(&self, options: WindowOptions) -> port::Result<Arc<dyn port::Frontend>> {
        soksak_host::platform::current()?;
        let port::Color(red, green, blue, alpha) = options.background;
        let created = tauri::WebviewWindowBuilder::new(
            application(),
            options.label,
            tauri::WebviewUrl::App(options.url.into()),
        )
        .title(options.title)
        .inner_size(options.width, options.height)
        // A dropped file is received by the file drop view of the window (docs/spec/native-surfaces.md).
        .disable_drag_drop_handler()
        .background_color(tauri::webview::Color(red, green, blue, alpha))
        // The window is shown after register has prepared the presentation of the first screen.
        .visible(false);
        let window = crate::platform::prepare_window(created)?
            .build()
            .map_err(error)?
            .as_ref()
            .window();
        Ok(frontend(window))
    }

    fn windows(&self) -> Vec<Arc<dyn port::Frontend>> {
        application()
            .windows()
            .into_values()
            .map(frontend)
            .collect()
    }

    fn get_webview(&self, label: &str) -> Option<(Arc<dyn port::Frontend>, String)> {
        application()
            .get_webview(label)
            .map(|webview| (frontend(webview.window()), webview.label().to_string()))
    }
}
