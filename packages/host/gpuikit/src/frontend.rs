//! A GPUI window as the Frontend port of the language host library: its native window and its wry web views.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};

use soksak_host::framework::{
    self as port, AppHandle, LogicalPosition, LogicalSize, PlatformWebview, PresentationDone,
    WebviewBuilder, WebviewUrl, WindowEvent,
};
use wry::WebView;

use crate::service;

/// A wry web view of a window. The record reaches the view only on the main thread; the pointer lives until
/// `close_webview` drops the view.
struct Webview(*mut WebView);

unsafe impl Send for Webview {}
unsafe impl Sync for Webview {}

/// The closing hook of a window.
type Closing = Box<dyn Fn() -> bool + Send + Sync>;

/// Locks a mutex of a window record. A poisoned lock means that a thread panicked while it held the lock; the panic
/// was reported where it happened. The poison is logged here with the name of the lock, and the guard of the value is
/// returned, because the sections that hold these locks only store or read a value, so the value stays valid.
pub(crate) fn locked<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    // default: a poisoned lock keeps the value that its sections stored, which the window records keep valid; the poison is logged here.
    mutex.lock().unwrap_or_else(|error| {
        soksak_host::application_log::log_error(
            "frontend",
            format!("lock {name} is poisoned; continuing with its value"),
        );
        error.into_inner()
    })
}

/// Read-locks a table of the GPUI host, with the poison rule of `locked`.
pub(crate) fn read_locked<'a, T>(table: &'a RwLock<T>, name: &str) -> RwLockReadGuard<'a, T> {
    // default: a poisoned lock keeps the value that its sections stored, which the window records keep valid; the poison is logged here.
    table.read().unwrap_or_else(|error| {
        soksak_host::application_log::log_error(
            "frontend",
            format!("lock {name} is poisoned; continuing with its value"),
        );
        error.into_inner()
    })
}

/// Write-locks a table of the GPUI host, with the poison rule of `locked`.
pub(crate) fn write_locked<'a, T>(table: &'a RwLock<T>, name: &str) -> RwLockWriteGuard<'a, T> {
    // default: a poisoned lock keeps the value that its sections stored, which the window records keep valid; the poison is logged here.
    table.write().unwrap_or_else(|error| {
        soksak_host::application_log::log_error(
            "frontend",
            format!("lock {name} is poisoned; continuing with its value"),
        );
        error.into_inner()
    })
}

/// One window of the GPUI host: its GPUI handle, its native window and its web views by label, the main web view
/// under the label of the window. The record changes its fields only on the main thread.
pub(crate) struct Record {
    label: String,
    /// The NSWindow of the GPUI window, which open_window fills when the window exists.
    window: Mutex<*mut c_void>,
    webviews: Mutex<HashMap<String, Webview>>,
    closing: Mutex<Option<Closing>>,
}

unsafe impl Send for Record {}
unsafe impl Sync for Record {}

impl Record {
    pub(crate) fn new(label: String) -> Self {
        Self {
            label,
            window: Mutex::new(std::ptr::null_mut()),
            webviews: Mutex::new(HashMap::new()),
            closing: Mutex::new(None),
        }
    }

    /// The native window of the record, which open_window filled.
    pub(crate) fn window_handle(&self) -> *mut c_void {
        *locked(&self.window, "window")
    }

    /// Fills the native window of the record.
    pub(crate) fn set_window(&self, window: *mut c_void) {
        *locked(&self.window, "window") = window;
    }

    /// Stores the closing hook of the window.
    pub(crate) fn set_closing(&self, hook: Closing) {
        *locked(&self.closing, "closing") = Some(hook);
    }

    /// Runs the closing hook of the window; no hook keeps the window open to close it.
    pub(crate) fn closing_kept(&self) -> bool {
        locked(&self.closing, "closing")
            .as_ref()
            .map(|hook| hook())
            // default: with no closing hook no close is prevented, as packages/host/tauriv2/src/frontend.rs:195-203 does, so the window closes.
            .unwrap_or(false)
    }

    /// The labels of the web views of the window.
    pub(crate) fn webview_labels(&self) -> Vec<String> {
        locked(&self.webviews, "webviews").keys().cloned().collect()
    }

    /// The native web view with label, or an error when no such web view is open.
    pub(crate) fn webview(&self, label: &str) -> port::Result<*mut WebView> {
        locked(&self.webviews, "webviews")
            .get(label)
            .map(|view| view.0)
            .ok_or_else(|| port::Error::from(format!("webview {label} is not open")))
    }

    /// The raw main web view of the window, for the platform layer.
    pub(crate) fn raw_webview(&self, label: &str) -> Option<*mut WebView> {
        locked(&self.webviews, "webviews")
            .get(label)
            .map(|view| view.0)
    }

    /// Adds the web view with label to the record.
    pub(crate) fn add_webview(&self, label: String, view: *mut WebView) {
        locked(&self.webviews, "webviews").insert(label, Webview(view));
    }

    /// Removes the web view with label from the record.
    pub(crate) fn remove_webview(&self, label: &str) {
        locked(&self.webviews, "webviews").remove(label);
    }
}

/// The windows of the GPUI host by label.
pub(crate) fn windows() -> &'static RwLock<HashMap<String, Arc<Record>>> {
    static WINDOWS: OnceLock<RwLock<HashMap<String, Arc<Record>>>> = OnceLock::new();
    WINDOWS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Registers the record of the window with label.
pub(crate) fn register(_label: String, record: Arc<Record>) {
    write_locked(windows(), "windows").insert(_label, record);
}

/// The labels of the open windows.
pub(crate) fn labels() -> Vec<String> {
    read_locked(windows(), "windows").keys().cloned().collect()
}

/// The record of the window with label.
pub(crate) fn record(label: &str) -> Option<Arc<Record>> {
    read_locked(windows(), "windows").get(label).cloned()
}

/// The record of the window that holds the web view with label, and the window label.
pub(crate) fn record_of_webview(label: &str) -> Option<(Arc<Record>, String)> {
    let all = read_locked(windows(), "windows");
    for (window, record) in all.iter() {
        if locked(&record.webviews, "webviews").contains_key(label) {
            return Some((Arc::clone(record), window.clone()));
        }
    }
    None
}

/// The window and web view handles of the port for the web view with label.
pub(crate) fn context(app: &AppHandle, label: &str) -> Option<(port::Window, port::Webview)> {
    let (record, _window) = record_of_webview(label)?;
    let frontend: Arc<dyn port::Frontend> = Arc::new(Frontend::new(Arc::clone(&record)));
    let window = app.window_of(Arc::clone(&frontend));
    let webview = app.webview_of(frontend, label.to_string());
    Some((window, webview))
}

/// Runs script in the web view with label. A page that defined no entry drops the delivery.
pub(crate) fn deliver(label: &str, script: String) {
    let Some((record, _)) = record_of_webview(label) else {
        return;
    };
    let Some(view) = record.raw_webview(label) else {
        return;
    };
    let view = view as usize;
    if let Err(error) =
        service::on_main(move || crate::platform::evaluate_webview(view as *mut WebView, &script))
    {
        soksak_host::application_log::log_error("page delivery", error);
    }
}

/// Runs the work with the native web view with label and returns its value on the main thread.
fn with_webview_value<T: Send + 'static>(
    record: &Record,
    label: &str,
    work: impl FnOnce(*mut WebView) -> T + Send + 'static,
) -> port::Result<T> {
    let view = record.webview(label)? as usize;
    service::on_main(move || work(view as *mut WebView)).map_err(port::Error::from)
}

/// The script that delivers an event with name and payload to the entry of the page runtime.
fn event_script(name: &str, payload: &serde_json::Value) -> port::Result<String> {
    Ok(format!(
        "window.__soksak && window.__soksak.event({}, {})",
        serde_json::to_string(name).map_err(|error| port::Error::from(error.to_string()))?,
        payload
    ))
}

/// A GPUI window of the framework.
pub struct Frontend {
    record: Arc<Record>,
}

impl Frontend {
    pub(crate) fn new(record: Arc<Record>) -> Self {
        Self { record }
    }
}

impl port::Frontend for Frontend {
    fn name(&self) -> &str {
        &self.record.label
    }

    fn title(&self) -> port::Result<String> {
        self.with_window(crate::platform::title)
    }

    fn set_title(&self, title: &str) -> port::Result<()> {
        let title = title.to_string();
        self.with_window(move |window| crate::platform::set_title(window, &title))
    }

    fn show(&self) -> port::Result<()> {
        let window = self.record.window_handle() as usize;
        service::on_main(move || {
            // The show of the library applies the rule of the front application (docs/spec/hosts.md#launch-activation).
            if let Err(error) =
                soksak_host::platform::current().and_then(|system| system.show_window(window))
            {
                soksak_host::application_log::log_error("window show", error);
            }
        })
        .map_err(port::Error::from)
    }

    fn focus(&self) -> port::Result<()> {
        let window = self.record.window_handle() as usize;
        service::on_main(move || crate::platform::focus_window(window as *mut c_void))
            .map_err(port::Error::from)
    }

    fn is_focused(&self) -> port::Result<bool> {
        self.with_window(crate::platform::is_focused)
    }

    fn close(&self) -> port::Result<()> {
        let window = self.record.window_handle() as usize;
        service::on_main(move || crate::platform::close_window(window as *mut c_void))
            .map_err(port::Error::from)
    }

    fn scale_factor(&self) -> port::Result<f64> {
        self.with_window(crate::platform::scale_factor)
    }

    /// AppKit gives the size of the content in points, which are the logical pixels of the port.
    fn size(&self) -> port::Result<LogicalSize> {
        self.with_window(crate::platform::size)
    }

    /// The position is the top left of the window in screen coordinates whose origin is the top left of the main
    /// display, as the port states it.
    fn position(&self) -> port::Result<LogicalPosition> {
        self.with_window(crate::platform::position)
    }

    fn set_size(&self, size: LogicalSize) -> port::Result<()> {
        self.with_window(move |window| crate::platform::set_size(window, size))
    }

    fn set_position(&self, position: LogicalPosition) -> port::Result<()> {
        self.with_window(move |window| crate::platform::set_position(window, position))
    }

    fn maximize(&self) -> port::Result<()> {
        self.with_window(crate::platform::maximize)
    }

    fn unmaximize(&self) -> port::Result<()> {
        self.with_window(crate::platform::unmaximize)
    }

    fn is_maximized(&self) -> port::Result<bool> {
        self.with_window(crate::platform::is_maximized)
    }

    fn is_fullscreen(&self) -> port::Result<bool> {
        self.with_window(crate::platform::is_fullscreen)
    }

    fn is_minimized(&self) -> port::Result<bool> {
        self.with_window(crate::platform::is_minimized)
    }

    fn native_window(&self) -> port::Result<*mut c_void> {
        Ok(self.record.window_handle())
    }

    fn webviews(&self) -> Vec<String> {
        self.record.webview_labels()
    }

    /// Each page listens with the entry of its own web view.
    fn emit(&self, name: &str, payload: serde_json::Value) -> port::Result<()> {
        let label = self.record.label.clone();
        let script = event_script(name, &payload)?;
        with_webview_value(&self.record, &label, move |view| {
            crate::platform::evaluate_webview(view, &script)
        })
    }

    fn emit_webviews(&self, name: &str, payload: serde_json::Value) -> port::Result<()> {
        let script = event_script(name, &payload)?;
        for label in self.record.webview_labels() {
            with_webview_value(&self.record, &label, {
                let script = script.clone();
                move |view| crate::platform::evaluate_webview(view, &script)
            })?;
        }
        Ok(())
    }

    fn on_window_event(&self, listener: Box<dyn Fn(&WindowEvent) + Send + Sync>) {
        let window = self.record.window_handle() as usize;
        if let Err(error) = service::on_main(move || {
            crate::platform::observe_window(window as *mut c_void, listener)
        }) {
            soksak_host::application_log::log_error("frontend", format!("window events: {error}"));
        }
    }

    /// The closing hook runs when the window is asked to close; the should-close registration of open_window
    /// reads it on the main thread.
    fn on_closing(&self, hook: Box<dyn Fn() -> bool + Send + Sync>) {
        self.record.set_closing(hook);
    }

    /// The presentation notice of the main page.
    fn after_presentation(&self, done: PresentationDone) -> port::Result<()> {
        let view = self.record.webview(&self.record.label)? as usize;
        let answered = service::on_main(move || {
            let platform = soksak_host::platform::current()?;
            let view = crate::platform::platform_webview(view as *mut WebView);
            platform.after_presentation(&view, Box::new(move || done(Ok(()))))
        })
        .map_err(port::Error::from)?;
        answered.map_err(port::Error::from)
    }

    /// The settled presentation of the main page: the block of its main web view.
    fn settled_presentation(&self) -> port::Result<*mut c_void> {
        let view = self.record.webview(&self.record.label)? as usize;
        let answered = service::on_main(move || {
            let platform = soksak_host::platform::current()?;
            let view = crate::platform::platform_webview(view as *mut WebView);
            platform.main_presentation(&view)
        })
        .map_err(port::Error::from)?;
        answered
            .map(|block| block as *mut c_void)
            .map_err(port::Error::from)
    }

    /// Reloads the main page.
    fn start_workbench(&self) -> port::Result<()> {
        self.reload(&self.record.label)
    }

    /// Runs script in the main page.
    fn call_workbench(&self, script: &str) -> port::Result<()> {
        self.eval(&self.record.label, script)
    }

    fn add_child(
        &self,
        builder: WebviewBuilder,
        position: LogicalPosition,
        size: LogicalSize,
    ) -> port::Result<String> {
        let main = self.record.webview(&self.record.label)? as usize;
        let WebviewUrl::External(url) = builder.url;
        let label = builder.label;
        let background = builder.background_color;
        let focused = builder.focused;
        let record = Arc::clone(&self.record);
        let added = label.clone();
        let added_view = service::on_main(move || {
            let view = crate::platform::add_child(
                main as *mut WebView,
                label.clone(),
                url,
                background,
                focused,
                position,
                size,
            );
            (view.map(|view| view as usize), label)
        })
        .map_err(port::Error::from)?;
        let (view, label) = added_view;
        let view = view.map_err(|error| {
            soksak_host::application_log::log_error("add child webview", error.clone());
            port::Error::from("the child web view could not be created")
        })? as *mut WebView;
        record.add_webview(added, view);
        Ok(label)
    }

    fn with_webview(
        &self,
        webview: &str,
        work: Box<dyn FnOnce(PlatformWebview) + Send>,
    ) -> port::Result<()> {
        let view = self.record.webview(webview)? as usize;
        service::on_main(move || work(crate::platform::platform_webview(view as *mut WebView)))
            .map_err(port::Error::from)
    }

    fn reload(&self, webview: &str) -> port::Result<()> {
        with_webview_value(&self.record, webview, crate::platform::reload)
    }

    fn eval(&self, webview: &str, script: &str) -> port::Result<()> {
        let script = script.to_string();
        with_webview_value(&self.record, webview, move |view| {
            crate::platform::evaluate_webview(view, &script)
        })
    }

    fn navigate(&self, webview: &str, url: url::Url) -> port::Result<()> {
        let url = url.to_string();
        with_webview_value(&self.record, webview, move |view| {
            crate::platform::navigate(view, &url)
        })
    }

    fn url(&self, webview: &str) -> port::Result<url::Url> {
        with_webview_value(&self.record, webview, crate::platform::webview_url)?
    }

    fn close_webview(&self, webview: &str) -> port::Result<()> {
        let view = self.record.webview(webview)? as usize;
        let removed = webview.to_string();
        service::on_main(move || {
            self_record_remove(&removed);
            crate::platform::close_webview(view as *mut WebView);
        })
        .map_err(port::Error::from)
    }

    fn show_webview(&self, webview: &str) -> port::Result<()> {
        let view = self.record.webview(webview)? as usize;
        service::on_main(move || crate::platform::set_webview_visible(view as *mut WebView, true))
            .map_err(port::Error::from)
    }

    fn hide_webview(&self, webview: &str) -> port::Result<()> {
        let view = self.record.webview(webview)? as usize;
        service::on_main(move || crate::platform::set_webview_visible(view as *mut WebView, false))
            .map_err(port::Error::from)
    }

    fn set_webview_focus(&self, webview: &str) -> port::Result<()> {
        let view = self.record.webview(webview)? as usize;
        service::on_main(move || crate::platform::focus_webview(view as *mut WebView))
            .map_err(port::Error::from)
    }

    fn set_webview_auto_resize(&self, webview: &str, auto_resize: bool) -> port::Result<()> {
        let view = self.record.webview(webview)? as usize;
        service::on_main(move || {
            crate::platform::set_webview_auto_resize(view as *mut WebView, auto_resize)
        })
        .map_err(port::Error::from)
    }
}

impl Frontend {
    /// Runs work with the NSWindow of the window on the main thread and returns its value.
    fn with_window<T: Send + 'static>(
        &self,
        work: impl Fn(*mut c_void) -> T + Send + 'static,
    ) -> port::Result<T> {
        let window = self.record.window_handle() as usize;
        service::on_main(move || work(window as *mut c_void)).map_err(port::Error::from)
    }
}

/// Removes the web view from the record that holds it.
fn self_record_remove(label: &str) {
    if let Some((record, _)) = record_of_webview(label) {
        record.remove_webview(label);
    }
}
