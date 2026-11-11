//! The framework port: the two traits through which the language host library reaches the application framework
//! (docs/spec/hosts.md#mygo-host). A framework adapter implements both and holds `run`.
//!
//! The library reaches a window and its web views through the handles of this module: [`AppHandle`], [`Window`] and
//! [`Webview`]. Each handle passes its calls to the [`Framework`] or the [`Frontend`] that the adapter gave it, and the
//! application keeps its state values in the state map of [`AppHandle`].

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::ffi::c_void;
use std::marker::PhantomData;
use std::path::PathBuf;
use std::sync::{Arc, PoisonError, RwLock};

use serde::Serialize;
use serde_json::Value;

/// The error of a call of the framework.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<String> for Error {
    fn from(text: String) -> Self {
        Self(text)
    }
}

impl From<&str> for Error {
    fn from(text: &str) -> Self {
        Self(text.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

/// The result of a call of the framework.
pub type Result<T> = std::result::Result<T, Error>;

/// The application of a framework: everything that the library asks of the framework without naming a window.
pub trait Framework: Send + Sync {
    /// wailsv3, mygo or tauriv2: the application of endpoint.json, the name of the endpoint socket, the host of the release
    /// key of the application update and the host of the state file of the debug view.
    fn application_name(&self) -> &'static str;
    /// The end of a window title, as "Tauri v2".
    fn display_name(&self) -> &'static str;
    /// Runs task as a step of the main thread and returns without waiting for it from another thread. On the main thread
    /// a framework may run it before it returns.
    fn post(&self, task: Box<dyn FnOnce() + Send>) -> Result<()>;
    /// Runs task on the blocking threads of the asynchronous runtime of the framework. The future ends with the value of
    /// the task when the task ended; dropping it leaves the task running and drops its value.
    fn spawn_blocking(&self, task: BlockingBody) -> BlockingTask;
    /// Ends the application through the quit of the framework.
    fn quit(&self);
    /// The user configuration directory of the operating system.
    fn config_dir(&self) -> Result<PathBuf>;
    /// The home directory of the user.
    fn home_dir(&self) -> Result<PathBuf>;
    /// Shows the folder panel attached to window and returns the chosen path, or None when the person cancelled.
    fn choose_folder(&self, window: &Window, title: &str) -> Result<Option<PathBuf>>;
    /// Shows the save panel attached to window, in directory when it is given, and returns the chosen path, or None when
    /// the person cancelled.
    fn save_file(
        &self,
        window: &Window,
        name: &str,
        directory: Option<&std::path::Path>,
    ) -> Result<Option<PathBuf>>;
    /// Installs the application menu.
    fn set_menu(&self, menus: Vec<crate::menu::Menu>) -> Result<()>;
    /// Installs the Dock menu, whose new window item runs new_window. Call it on the main thread.
    fn install_dock(&self, new_window: Box<dyn Fn()>) -> Result<()>;
    /// Creates a window with its title bar.
    fn new_window(&self, options: WindowOptions) -> Result<Arc<dyn Frontend>>;
    /// The windows that are open.
    fn windows(&self) -> Vec<Arc<dyn Frontend>>;
    /// The window of the web view with label, when the web view is open.
    fn get_webview(&self, label: &str) -> Option<(Arc<dyn Frontend>, String)>;
}

/// One window of a framework, its main web view (the workbench) and its child web views. A method that names a web view
/// takes its label. Sizes and positions are logical pixels.
pub trait Frontend: Send + Sync {
    /// The window identifier of the endpoint, which is the label of the main web view.
    fn name(&self) -> &str;
    fn title(&self) -> Result<String>;
    fn set_title(&self, title: &str) -> Result<()>;
    fn show(&self) -> Result<()>;
    fn focus(&self) -> Result<()>;
    fn is_focused(&self) -> Result<bool>;
    fn close(&self) -> Result<()>;
    /// The physical pixels of a logical pixel of the window.
    fn scale_factor(&self) -> Result<f64>;
    /// The size of the content of the window.
    fn size(&self) -> Result<LogicalSize>;
    fn position(&self) -> Result<LogicalPosition>;
    fn set_size(&self, size: LogicalSize) -> Result<()>;
    fn set_position(&self, position: LogicalPosition) -> Result<()>;
    fn maximize(&self) -> Result<()>;
    fn unmaximize(&self) -> Result<()>;
    fn is_maximized(&self) -> Result<bool>;
    fn is_fullscreen(&self) -> Result<bool>;
    fn is_minimized(&self) -> Result<bool>;
    /// The native window handle.
    fn native_window(&self) -> Result<*mut c_void>;
    /// The labels of the web views of the window.
    fn webviews(&self) -> Vec<String>;
    /// Delivers an event to the workbench of the window.
    fn emit(&self, name: &str, payload: Value) -> Result<()>;
    /// Delivers an event to each web view of the window.
    fn emit_webviews(&self, name: &str, payload: Value) -> Result<()>;
    /// Runs listener for each event of the window.
    fn on_window_event(&self, listener: Box<dyn Fn(&WindowEvent) + Send + Sync>);
    /// Runs hook when the window is asked to close. A hook that returns true keeps the window open.
    fn on_closing(&self, hook: Box<dyn Fn() -> bool + Send + Sync>);
    /// The presentation notice: done runs on the main thread after the workbench presented the state of this step, or with
    /// the failure of the wait. Call it on the main thread.
    fn after_presentation(&self, done: PresentationDone) -> Result<()>;
    /// The settled presentation: makes the block that brings the content of the window to the screen in its current state,
    /// which the caller passes to the settled wait of the platform. Call it on the main thread.
    fn settled_presentation(&self) -> Result<*mut c_void>;
    /// The workbench start: starts the workbench of the window again.
    fn start_workbench(&self) -> Result<()>;
    /// The workbench call channel: runs script in the workbench.
    fn call_workbench(&self, script: &str) -> Result<()>;
    /// Adds a child web view at position with size and returns its label.
    fn add_child(
        &self,
        builder: WebviewBuilder,
        position: LogicalPosition,
        size: LogicalSize,
    ) -> Result<String>;
    /// Runs work on the main thread with the native views of the web view.
    fn with_webview(
        &self,
        webview: &str,
        work: Box<dyn FnOnce(PlatformWebview) + Send>,
    ) -> Result<()>;
    /// Loads the page of the web view again.
    fn reload(&self, webview: &str) -> Result<()>;
    /// Runs script in the web view.
    fn eval(&self, webview: &str, script: &str) -> Result<()>;
    fn navigate(&self, webview: &str, url: url::Url) -> Result<()>;
    fn url(&self, webview: &str) -> Result<url::Url>;
    fn close_webview(&self, webview: &str) -> Result<()>;
    fn show_webview(&self, webview: &str) -> Result<()>;
    fn hide_webview(&self, webview: &str) -> Result<()>;
    fn set_webview_focus(&self, webview: &str) -> Result<()>;
    fn set_webview_auto_resize(&self, webview: &str, auto_resize: bool) -> Result<()>;
}

/// The end of the wait of [`Frontend::after_presentation`].
pub type PresentationDone = Box<dyn Fn(std::result::Result<(), String>) + Send + Sync>;

/// A task that [`Framework::spawn_blocking`] runs, which returns its value.
pub type BlockingBody = Box<dyn FnOnce() -> Box<dyn Any + Send> + Send>;

/// The end of a task that [`Framework::spawn_blocking`] runs, with the value of the task.
pub type BlockingTask =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Box<dyn Any + Send>>> + Send>>;

/// The values of a window that the library creates.
#[derive(Clone, Debug)]
pub struct WindowOptions {
    pub label: String,
    pub url: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub background: Color,
}

/// A change of a window that a Frontend reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowEvent {
    Resized,
    Moved,
    ScaleFactorChanged,
    Focused(bool),
    Destroyed,
}

/// A color with red, green, blue and alpha.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Color(pub u8, pub u8, pub u8, pub u8);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogicalSize {
    pub width: f64,
    pub height: f64,
}

impl LogicalSize {
    pub fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogicalPosition {
    pub x: f64,
    pub y: f64,
}

impl LogicalPosition {
    pub fn new(x: impl Into<f64>, y: impl Into<f64>) -> Self {
        Self {
            x: x.into(),
            y: y.into(),
        }
    }
}

/// The address of the page of a web view.
#[derive(Clone, Debug)]
pub enum WebviewUrl {
    External(url::Url),
}

/// The values of a child web view.
#[derive(Clone, Debug)]
pub struct WebviewBuilder {
    pub label: String,
    pub url: WebviewUrl,
    pub background_color: Option<Color>,
    pub focused: bool,
}

impl WebviewBuilder {
    pub fn new(label: impl Into<String>, url: WebviewUrl) -> Self {
        Self {
            label: label.into(),
            url,
            background_color: None,
            focused: true,
        }
    }

    pub fn background_color(mut self, color: Color) -> Self {
        self.background_color = Some(color);
        self
    }

    pub fn focused(mut self, focused: bool) -> Self {
        self.focused = focused;
        self
    }
}

/// The native views of a web view, valid during the work that [`Frontend::with_webview`] runs.
#[derive(Clone, Copy, Debug)]
pub struct PlatformWebview {
    pub webview: *mut c_void,
    pub controller: *mut c_void,
    pub window: *mut c_void,
}

impl PlatformWebview {
    /// The native web view (WKWebView on macOS).
    pub fn inner(&self) -> *mut c_void {
        self.webview
    }

    /// The native controller of the web view (WKUserContentController on macOS).
    pub fn controller(&self) -> *mut c_void {
        self.controller
    }

    /// The native window of the web view (NSWindow on macOS).
    pub fn ns_window(&self) -> *mut c_void {
        self.window
    }
}

/// The body of a host call that the page sent, as the framework holds it.
#[derive(Clone, Copy, Debug)]
pub enum InvokeBody<'a> {
    Json(&'a Value),
    Raw(&'a [u8]),
}

/// The body that a channel sends to the page.
#[derive(Clone, Debug)]
pub enum InvokeResponseBody {
    Json(String),
    Raw(Vec<u8>),
}

/// A channel to the page, which a host call passed.
pub struct Channel<T> {
    send: Arc<dyn Fn(InvokeResponseBody) -> Result<()> + Send + Sync>,
    data: PhantomData<fn(T)>,
}

impl<T> Clone for Channel<T> {
    fn clone(&self) -> Self {
        Self {
            send: Arc::clone(&self.send),
            data: PhantomData,
        }
    }
}

impl<T: Serialize> Channel<T> {
    pub fn new(send: impl Fn(InvokeResponseBody) -> Result<()> + Send + Sync + 'static) -> Self {
        Self {
            send: Arc::new(send),
            data: PhantomData,
        }
    }

    /// Sends data to the page as JSON.
    pub fn send(&self, data: T) -> Result<()> {
        (self.send)(InvokeResponseBody::Json(serde_json::to_string(&data)?))
    }
}

/// A state value of the application.
pub struct State<T: Send + Sync + 'static>(Arc<T>);

impl<T: Send + Sync + 'static> State<T> {
    pub fn inner(&self) -> &T {
        &self.0
    }
}

impl<T: Send + Sync + 'static> std::ops::Deref for State<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

/// The framework that the first [`AppHandle`] received.
static FRAMEWORK: std::sync::OnceLock<Arc<dyn Framework>> = std::sync::OnceLock::new();

/// The application name of the framework (see [`Framework::application_name`]).
pub fn application_name() -> &'static str {
    FRAMEWORK
        .get()
        .expect("the framework adapter creates the application before the host names it")
        .application_name()
}

/// The display name of the framework (see [`Framework::display_name`]).
pub fn display_name() -> &'static str {
    FRAMEWORK
        .get()
        .expect("the framework adapter creates the application before the host names it")
        .display_name()
}

type StateMap = RwLock<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>;

/// The application: the framework and the state values of the application.
#[derive(Clone)]
pub struct AppHandle {
    framework: Arc<dyn Framework>,
    states: Arc<StateMap>,
}

impl AppHandle {
    /// The application of framework, which a framework adapter creates once.
    pub fn new(framework: Arc<dyn Framework>) -> Self {
        // A second application of the process keeps the framework of the first, which names the host.
        FRAMEWORK.get_or_init(|| Arc::clone(&framework));
        Self {
            framework,
            states: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn framework(&self) -> &dyn Framework {
        &*self.framework
    }

    /// The window handle of frontend.
    pub fn window_of(&self, frontend: Arc<dyn Frontend>) -> Window {
        Window {
            frontend,
            app: self.clone(),
        }
    }

    /// The web view handle of the web view with label of frontend.
    pub fn webview_of(&self, frontend: Arc<dyn Frontend>, label: impl Into<String>) -> Webview {
        Webview {
            window: self.window_of(frontend),
            label: label.into(),
        }
    }

    /// Runs task on the blocking threads of the asynchronous runtime and returns its value. An Objective-C exception that
    /// leaves task ends the process with its record (`platform::end_on_exception`).
    pub async fn spawn_blocking<T: Send + 'static>(
        &self,
        task: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T> {
        let value = self
            .framework
            .spawn_blocking(Box::new(move || {
                Box::new(crate::platform::end_on_exception(task)) as Box<dyn Any + Send>
            }))
            .await?;
        value
            .downcast::<T>()
            .map(|value| *value)
            .map_err(|_| Error::from("the blocking task returned a value of another type"))
    }

    /// Runs task on the blocking threads of the asynchronous runtime without waiting for it, as `spawn_blocking` runs it.
    pub fn spawn_detached(&self, task: impl FnOnce() + Send + 'static) {
        drop(self.framework.spawn_blocking(Box::new(move || {
            crate::platform::end_on_exception(task);
            Box::new(()) as Box<dyn Any + Send>
        })));
    }

    pub fn quit(&self) {
        self.framework.quit()
    }

    pub fn path(&self) -> PathResolver<'_> {
        PathResolver(self)
    }

    pub fn set_menu(&self, menus: Vec<crate::menu::Menu>) -> Result<()> {
        self.framework.set_menu(menus)
    }

    /// Installs the Dock menu, whose new window item runs new_window. Call it on the main thread.
    pub fn install_dock(&self, new_window: impl Fn() + 'static) -> Result<()> {
        self.framework.install_dock(Box::new(new_window))
    }
}

/// The directories of the operating system.
pub struct PathResolver<'a>(&'a AppHandle);

impl PathResolver<'_> {
    pub fn config_dir(&self) -> Result<PathBuf> {
        self.0.framework.config_dir()
    }

    pub fn home_dir(&self) -> Result<PathBuf> {
        self.0.framework.home_dir()
    }
}

/// The application state and the windows, which the application, a window and a web view reach.
pub trait Manager {
    fn app_handle(&self) -> &AppHandle;

    /// Adds value to the state of the application. It returns false and keeps the earlier value when the state holds a
    /// value of its type.
    fn manage<T: Send + Sync + 'static>(&self, value: T) -> bool {
        let mut states = self
            .app_handle()
            .states
            .write()
            // default: a lock that a panicking thread poisoned still holds the state values; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        if states.contains_key(&TypeId::of::<T>()) {
            return false;
        }
        states.insert(TypeId::of::<T>(), Arc::new(value));
        true
    }

    /// The state value of type T, when the state holds one.
    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<T>> {
        let states = self
            .app_handle()
            .states
            .read()
            // default: a lock that a panicking thread poisoned still holds the state values; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let value = Arc::clone(states.get(&TypeId::of::<T>())?);
        // silent: the states are keyed by the TypeId of their type, so the value found under the key of T is always a T.
        Some(State(value.downcast::<T>().ok()?))
    }

    /// The state value of type T. The application adds each value before a call reads it, so a missing value is a defect.
    fn state<T: Send + Sync + 'static>(&self) -> State<T> {
        let Some(state) = self.try_state::<T>() else {
            panic!(
                "state() called before manage() for {}",
                std::any::type_name::<T>()
            )
        };
        state
    }

    /// Runs task as a step of the main thread. An Objective-C exception that leaves task ends the process with its record
    /// (`platform::end_on_exception`).
    fn post(&self, task: impl FnOnce() + Send + 'static) -> Result<()> {
        self.app_handle()
            .framework
            .post(Box::new(move || crate::platform::end_on_exception(task)))
    }

    /// The windows that are open, by label.
    fn windows(&self) -> HashMap<String, Window> {
        let app = self.app_handle();
        app.framework
            .windows()
            .into_iter()
            .map(|frontend| {
                let window = app.window_of(frontend);
                (window.label().to_string(), window)
            })
            .collect()
    }

    fn get_window(&self, label: &str) -> Option<Window> {
        let app = self.app_handle();
        app.framework
            .windows()
            .into_iter()
            .find(|frontend| frontend.name() == label)
            .map(|frontend| app.window_of(frontend))
    }

    fn get_webview(&self, label: &str) -> Option<Webview> {
        let app = self.app_handle();
        app.framework
            .get_webview(label)
            .map(|(frontend, label)| app.webview_of(frontend, label))
    }
}

impl Manager for AppHandle {
    fn app_handle(&self) -> &AppHandle {
        self
    }
}

/// A window of the application.
#[derive(Clone)]
pub struct Window {
    frontend: Arc<dyn Frontend>,
    app: AppHandle,
}

impl Manager for Window {
    fn app_handle(&self) -> &AppHandle {
        &self.app
    }
}

impl Window {
    pub fn frontend(&self) -> &Arc<dyn Frontend> {
        &self.frontend
    }

    /// The name of the window, which is the label of its main web view.
    pub fn label(&self) -> &str {
        self.frontend.name()
    }

    pub fn title(&self) -> Result<String> {
        self.frontend.title()
    }

    pub fn set_title(&self, title: &str) -> Result<()> {
        self.frontend.set_title(title)
    }

    pub fn show(&self) -> Result<()> {
        self.frontend.show()
    }

    pub fn focus(&self) -> Result<()> {
        self.frontend.focus()
    }

    pub fn is_focused(&self) -> Result<bool> {
        self.frontend.is_focused()
    }

    pub fn close(&self) -> Result<()> {
        self.frontend.close()
    }

    pub fn scale_factor(&self) -> Result<f64> {
        self.frontend.scale_factor()
    }

    pub fn size(&self) -> Result<LogicalSize> {
        self.frontend.size()
    }

    pub fn position(&self) -> Result<LogicalPosition> {
        self.frontend.position()
    }

    pub fn set_size(&self, size: LogicalSize) -> Result<()> {
        self.frontend.set_size(size)
    }

    pub fn set_position(&self, position: LogicalPosition) -> Result<()> {
        self.frontend.set_position(position)
    }

    pub fn maximize(&self) -> Result<()> {
        self.frontend.maximize()
    }

    pub fn unmaximize(&self) -> Result<()> {
        self.frontend.unmaximize()
    }

    pub fn is_maximized(&self) -> Result<bool> {
        self.frontend.is_maximized()
    }

    pub fn is_fullscreen(&self) -> Result<bool> {
        self.frontend.is_fullscreen()
    }

    pub fn is_minimized(&self) -> Result<bool> {
        self.frontend.is_minimized()
    }

    pub fn native_window(&self) -> Result<*mut c_void> {
        self.frontend.native_window()
    }

    pub fn webviews(&self) -> Vec<Webview> {
        self.frontend
            .webviews()
            .into_iter()
            .map(|label| Webview {
                window: self.clone(),
                label,
            })
            .collect()
    }

    /// Delivers an event to the workbench of the window.
    pub fn emit<S: Serialize>(&self, name: &str, payload: S) -> Result<()> {
        self.frontend.emit(name, serde_json::to_value(payload)?)
    }

    /// Delivers an event to each web view of the window.
    pub fn emit_webviews<S: Serialize>(&self, name: &str, payload: S) -> Result<()> {
        self.frontend
            .emit_webviews(name, serde_json::to_value(payload)?)
    }

    pub fn on_window_event(&self, listener: impl Fn(&WindowEvent) + Send + Sync + 'static) {
        self.frontend.on_window_event(Box::new(listener))
    }

    /// Runs hook when the window is asked to close. A hook that returns true keeps the window open.
    pub fn on_closing(&self, hook: impl Fn() -> bool + Send + Sync + 'static) {
        self.frontend.on_closing(Box::new(hook))
    }

    /// The presentation notice (see [`Frontend::after_presentation`]).
    pub fn after_presentation(
        &self,
        done: impl Fn(std::result::Result<(), String>) + Send + Sync + 'static,
    ) -> Result<()> {
        self.frontend.after_presentation(Box::new(done))
    }

    /// The workbench start (see [`Frontend::start_workbench`]).
    pub fn start_workbench(&self) -> Result<()> {
        self.frontend.start_workbench()
    }

    /// The workbench call channel (see [`Frontend::call_workbench`]).
    pub fn call_workbench(&self, script: impl AsRef<str>) -> Result<()> {
        self.frontend.call_workbench(script.as_ref())
    }

    pub fn add_child(
        &self,
        builder: WebviewBuilder,
        position: LogicalPosition,
        size: LogicalSize,
    ) -> Result<Webview> {
        let label = self.frontend.add_child(builder, position, size)?;
        Ok(Webview {
            window: self.clone(),
            label,
        })
    }
}

/// A web view of a window.
#[derive(Clone)]
pub struct Webview {
    window: Window,
    label: String,
}

impl Manager for Webview {
    fn app_handle(&self) -> &AppHandle {
        &self.window.app
    }
}

impl Webview {
    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn window(&self) -> Window {
        self.window.clone()
    }

    pub fn with_webview(&self, work: impl FnOnce(PlatformWebview) + Send + 'static) -> Result<()> {
        self.window
            .frontend
            .with_webview(&self.label, Box::new(work))
    }

    pub fn reload(&self) -> Result<()> {
        self.window.frontend.reload(&self.label)
    }

    pub fn eval(&self, script: impl AsRef<str>) -> Result<()> {
        self.window.frontend.eval(&self.label, script.as_ref())
    }

    pub fn navigate(&self, url: url::Url) -> Result<()> {
        self.window.frontend.navigate(&self.label, url)
    }

    pub fn url(&self) -> Result<url::Url> {
        self.window.frontend.url(&self.label)
    }

    pub fn close(&self) -> Result<()> {
        self.window.frontend.close_webview(&self.label)
    }

    pub fn show(&self) -> Result<()> {
        self.window.frontend.show_webview(&self.label)
    }

    pub fn hide(&self) -> Result<()> {
        self.window.frontend.hide_webview(&self.label)
    }

    pub fn set_focus(&self) -> Result<()> {
        self.window.frontend.set_webview_focus(&self.label)
    }

    pub fn set_auto_resize(&self, auto_resize: bool) -> Result<()> {
        self.window
            .frontend
            .set_webview_auto_resize(&self.label, auto_resize)
    }
}
