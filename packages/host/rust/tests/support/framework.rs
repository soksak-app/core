//! A framework of the tests: it names the application and runs a task at once. Its window has only the presentation notice
//! and the settled presentation.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, PoisonError};

use crate::framework::{
    AppHandle, BlockingBody, BlockingTask, Error, Framework, Frontend, LogicalPosition,
    LogicalSize, PlatformWebview, PresentationDone, Result, WebviewBuilder, Window, WindowEvent,
    WindowOptions,
};

/// The display name of the test framework, the end of a window title.
pub const DISPLAY_NAME: &str = "Fixture";

/// The framework of the tests. A task that a test queued runs before the next post, as the main thread runs a task that
/// was queued ahead of the posted one.
#[derive(Default)]
pub struct Fixture {
    queued: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    callback_guard: Mutex<Option<Arc<Mutex<()>>>>,
    windows: Mutex<Vec<Arc<dyn Frontend>>>,
}

impl Fixture {
    pub fn hold_callback(&self, guard: Arc<Mutex<()>>) {
        *self.callback_guard.lock().unwrap() = Some(guard);
    }
    /// Lists frontend among the windows of the framework.
    pub fn add_window(&self, frontend: Arc<dyn Frontend>) {
        self.windows
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(frontend);
    }
    /// Runs task before the next post.
    pub fn queue(&self, task: impl FnOnce() + Send + 'static) {
        *self.queued.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(task));
    }
}

impl Framework for Fixture {
    fn application_name(&self) -> &'static str {
        "fixture"
    }

    fn display_name(&self) -> &'static str {
        DISPLAY_NAME
    }

    fn post(&self, task: Box<dyn FnOnce() + Send>) -> Result<()> {
        let callback = self.callback_guard.lock().unwrap().clone();
        let _held = callback.as_ref().map(|guard| guard.lock().unwrap());
        let queued = self
            .queued
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(queued) = queued {
            queued();
        }
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
        self.windows
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn get_webview(&self, _label: &str) -> Option<(Arc<dyn Frontend>, String)> {
        None
    }
}

/// The native window handle of [`FixtureFrontend`].
pub const WINDOW: usize = 0x10;

/// A window of the tests. The test takes each presentation notice that the library asks for, and calls it back when it wants
/// the state to present. The value of its settled presentation stands for the block; a window without one fails with the
/// text it holds.
pub struct FixtureFrontend {
    notices: Sender<PresentationDone>,
    asked: Mutex<Receiver<PresentationDone>>,
    presentation: std::result::Result<usize, String>,
    native: std::result::Result<usize, String>,
    /// Whether a page receives the events of the window; a window without one refuses each event.
    page: bool,
}

/// The error of a call that the window of the tests does not hold.
fn absent() -> Error {
    Error::from("the test window has no such state")
}

impl FixtureFrontend {
    /// A window whose settled presentation has the value presentation.
    pub fn new(presentation: std::result::Result<usize, String>) -> Self {
        let (notices, asked) = mpsc::channel();
        Self {
            notices,
            asked: Mutex::new(asked),
            presentation,
            native: Ok(WINDOW),
            page: false,
        }
    }

    /// A window whose page receives its events and that has no native window, so no step reaches the platform.
    pub fn with_page() -> Self {
        Self {
            page: true,
            ..Self::without_native_window("the test window has no native window")
        }
    }

    /// A window whose native window fails with error, so a read of native window state ends before it reaches the platform.
    pub fn without_native_window(error: &str) -> Self {
        Self {
            native: Err(error.to_string()),
            ..Self::new(Ok(1))
        }
    }

    /// Waits for the next presentation notice that the library asks for.
    pub fn notice(&self) -> PresentationDone {
        self.asked
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .recv()
            .expect("the library asks for the presentation notice of the Frontend")
    }
}

impl Frontend for FixtureFrontend {
    fn name(&self) -> &str {
        "fixture"
    }

    fn title(&self) -> Result<String> {
        Err(absent())
    }

    fn set_title(&self, _title: &str) -> Result<()> {
        Err(absent())
    }

    fn show(&self) -> Result<()> {
        Err(absent())
    }

    fn focus(&self) -> Result<()> {
        Err(absent())
    }

    fn is_focused(&self) -> Result<bool> {
        Err(absent())
    }

    fn close(&self) -> Result<()> {
        Err(absent())
    }

    fn scale_factor(&self) -> Result<f64> {
        Err(absent())
    }

    fn size(&self) -> Result<LogicalSize> {
        Err(absent())
    }

    fn position(&self) -> Result<LogicalPosition> {
        Err(absent())
    }

    fn set_size(&self, _size: LogicalSize) -> Result<()> {
        Err(absent())
    }

    fn set_position(&self, _position: LogicalPosition) -> Result<()> {
        Err(absent())
    }

    fn maximize(&self) -> Result<()> {
        Err(absent())
    }

    fn unmaximize(&self) -> Result<()> {
        Err(absent())
    }

    fn is_maximized(&self) -> Result<bool> {
        Err(absent())
    }

    fn is_fullscreen(&self) -> Result<bool> {
        Err(absent())
    }

    fn is_minimized(&self) -> Result<bool> {
        Err(absent())
    }

    fn native_window(&self) -> Result<*mut c_void> {
        self.native
            .clone()
            .map(|window| window as *mut c_void)
            .map_err(Error::from)
    }

    fn webviews(&self) -> Vec<String> {
        Vec::new()
    }

    fn emit(&self, _name: &str, _payload: serde_json::Value) -> Result<()> {
        if self.page { Ok(()) } else { Err(absent()) }
    }

    fn emit_webviews(&self, name: &str, payload: serde_json::Value) -> Result<()> {
        self.emit(name, payload)
    }

    fn on_window_event(&self, _listener: Box<dyn Fn(&WindowEvent) + Send + Sync>) {}

    fn on_closing(&self, _hook: Box<dyn Fn() -> bool + Send + Sync>) {}

    fn after_presentation(&self, done: PresentationDone) -> Result<()> {
        self.notices
            .send(done)
            .map_err(|error| Error::from(error.to_string()))
    }

    fn settled_presentation(&self) -> Result<*mut c_void> {
        self.presentation
            .clone()
            .map(|block| block as *mut c_void)
            .map_err(Error::from)
    }

    fn start_workbench(&self) -> Result<()> {
        Err(absent())
    }

    fn call_workbench(&self, _script: &str) -> Result<()> {
        Err(absent())
    }

    fn add_child(
        &self,
        _builder: WebviewBuilder,
        _position: LogicalPosition,
        _size: LogicalSize,
    ) -> Result<String> {
        Err(absent())
    }

    fn with_webview(
        &self,
        _webview: &str,
        _work: Box<dyn FnOnce(PlatformWebview) + Send>,
    ) -> Result<()> {
        Err(absent())
    }

    fn reload(&self, _webview: &str) -> Result<()> {
        Err(absent())
    }

    fn eval(&self, _webview: &str, _script: &str) -> Result<()> {
        Err(absent())
    }

    fn navigate(&self, _webview: &str, _url: url::Url) -> Result<()> {
        Err(absent())
    }

    fn url(&self, _webview: &str) -> Result<url::Url> {
        Err(absent())
    }

    fn close_webview(&self, _webview: &str) -> Result<()> {
        Err(absent())
    }

    fn show_webview(&self, _webview: &str) -> Result<()> {
        Err(absent())
    }

    fn hide_webview(&self, _webview: &str) -> Result<()> {
        Err(absent())
    }

    fn set_webview_focus(&self, _webview: &str) -> Result<()> {
        Err(absent())
    }

    fn set_webview_auto_resize(&self, _webview: &str, _auto_resize: bool) -> Result<()> {
        Err(absent())
    }
}

/// The application of the test framework. The first application of the test process names the host.
pub fn application() -> AppHandle {
    AppHandle::new(Arc::new(Fixture::default()))
}

/// The application of a framework that the test holds to queue main-thread tasks.
pub fn application_with_queue() -> (AppHandle, Arc<Fixture>) {
    let framework = Arc::new(Fixture::default());
    (AppHandle::new(framework.clone()), framework)
}
