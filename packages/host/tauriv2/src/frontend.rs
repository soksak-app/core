//! A Tauri window as the Frontend port of the language host library.

use std::ffi::c_void;
use std::sync::mpsc;

use soksak_host::application_log::log_info;
use soksak_host::framework::{
    self as port, LogicalPosition, LogicalSize, PlatformWebview, PresentationDone, WebviewBuilder,
    WebviewUrl, WindowEvent,
};
use tauri::{Emitter, Manager};

use crate::framework::error;

/// A Tauri window, its main web view and its child web views.
pub struct Frontend {
    window: tauri::Window,
}

impl Frontend {
    pub fn new(window: tauri::Window) -> Self {
        Self { window }
    }

    /// The web view with label.
    fn webview(&self, label: &str) -> port::Result<tauri::Webview> {
        self.window
            .app_handle()
            .get_webview(label)
            .ok_or_else(|| port::Error::from(format!("webview {label} is not open")))
    }

    /// Runs work with the native views of the main web view and returns its value. Tauri runs it at once on the main thread,
    /// where a caller of a presentation method is; on another thread the result is an error.
    fn with_main_webview<T: Send + 'static>(
        &self,
        work: impl FnOnce(&PlatformWebview) -> Result<T, String> + Send + 'static,
    ) -> port::Result<T> {
        let main = self
            .window
            .app_handle()
            .get_webview(self.window.label())
            .ok_or_else(|| port::Error::from("the main webview is gone"))?;
        let (tx, rx) = mpsc::channel();
        main.with_webview(move |view| {
            let view = crate::platform::platform_webview(&view);
            if tx.send(work(&view)).is_err() {
                log_info(
                    "frontend",
                    "the main web view ran a presentation request outside the main thread",
                );
            }
        })
        .map_err(error)?;
        rx.try_recv()
            .map_err(|_| port::Error::from("a presentation request ran outside the main thread"))?
            .map_err(port::Error::from)
    }
}

/// The library event of a Tauri window event, or None for an event that the library does not handle.
pub fn window_event(event: &tauri::WindowEvent) -> Option<WindowEvent> {
    Some(match event {
        tauri::WindowEvent::Resized(_) => WindowEvent::Resized,
        tauri::WindowEvent::Moved(_) => WindowEvent::Moved,
        tauri::WindowEvent::ScaleFactorChanged { .. } => WindowEvent::ScaleFactorChanged,
        tauri::WindowEvent::Focused(focused) => WindowEvent::Focused(*focused),
        tauri::WindowEvent::Destroyed => WindowEvent::Destroyed,
        _ => return None,
    })
}

impl port::Frontend for Frontend {
    fn name(&self) -> &str {
        self.window.label()
    }

    fn title(&self) -> port::Result<String> {
        self.window.title().map_err(error)
    }

    fn set_title(&self, title: &str) -> port::Result<()> {
        self.window.set_title(title).map_err(error)
    }

    fn show(&self) -> port::Result<()> {
        crate::platform::show_window(&self.window)
    }

    fn focus(&self) -> port::Result<()> {
        self.window.set_focus().map_err(error)
    }

    fn is_focused(&self) -> port::Result<bool> {
        self.window.is_focused().map_err(error)
    }

    fn close(&self) -> port::Result<()> {
        self.window.close().map_err(error)
    }

    fn scale_factor(&self) -> port::Result<f64> {
        self.window.scale_factor().map_err(error)
    }

    /// Tauri gives the size of the content in physical pixels.
    fn size(&self) -> port::Result<LogicalSize> {
        let scale = self.window.scale_factor().map_err(error)?;
        let size = self
            .window
            .inner_size()
            .map_err(error)?
            .to_logical::<f64>(scale);
        Ok(LogicalSize::new(size.width, size.height))
    }

    /// Tauri gives the position in physical pixels.
    fn position(&self) -> port::Result<LogicalPosition> {
        let scale = self.window.scale_factor().map_err(error)?;
        let position = self
            .window
            .outer_position()
            .map_err(error)?
            .to_logical::<f64>(scale);
        Ok(LogicalPosition::new(position.x, position.y))
    }

    fn set_size(&self, size: LogicalSize) -> port::Result<()> {
        self.window
            .set_size(tauri::LogicalSize::new(size.width, size.height))
            .map_err(error)
    }

    fn set_position(&self, position: LogicalPosition) -> port::Result<()> {
        self.window
            .set_position(tauri::LogicalPosition::new(position.x, position.y))
            .map_err(error)
    }

    fn maximize(&self) -> port::Result<()> {
        self.window.maximize().map_err(error)
    }

    fn unmaximize(&self) -> port::Result<()> {
        self.window.unmaximize().map_err(error)
    }

    fn is_maximized(&self) -> port::Result<bool> {
        self.window.is_maximized().map_err(error)
    }

    fn is_fullscreen(&self) -> port::Result<bool> {
        self.window.is_fullscreen().map_err(error)
    }

    fn is_minimized(&self) -> port::Result<bool> {
        self.window.is_minimized().map_err(error)
    }

    fn native_window(&self) -> port::Result<*mut c_void> {
        crate::platform::ns_window(&self.window)
    }

    fn webviews(&self) -> Vec<String> {
        self.window
            .webviews()
            .iter()
            .map(|webview| webview.label().to_string())
            .collect()
    }

    /// Each page listens with the target of its own web view.
    fn emit(&self, name: &str, payload: serde_json::Value) -> port::Result<()> {
        let target = tauri::EventTarget::webview(self.window.label());
        self.window.emit_to(target, name, payload).map_err(error)
    }

    fn emit_webviews(&self, name: &str, payload: serde_json::Value) -> port::Result<()> {
        let labels = self.webviews();
        self.window
            .emit_filter(name, payload, |target| {
                matches!(target, tauri::EventTarget::Webview { label } if labels.contains(label))
            })
            .map_err(error)
    }

    fn on_window_event(&self, listener: Box<dyn Fn(&WindowEvent) + Send + Sync>) {
        self.window.on_window_event(move |event| {
            if let Some(event) = window_event(event) {
                listener(&event);
            }
        });
    }

    fn on_closing(&self, hook: Box<dyn Fn() -> bool + Send + Sync>) {
        self.window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && hook()
            {
                api.prevent_close();
            }
        });
    }

    /// The presentation notice of the main page.
    fn after_presentation(&self, done: PresentationDone) -> port::Result<()> {
        self.with_main_webview(move |view| {
            soksak_host::platform::current()?
                .after_presentation(view, Box::new(move || done(Ok(()))))
        })
    }

    /// The settled presentation of the main page: the block of its main web view.
    fn settled_presentation(&self) -> port::Result<*mut c_void> {
        self.with_main_webview(|view| soksak_host::platform::current()?.main_presentation(view))
            .map(|block| block as *mut c_void)
    }

    /// Reloads the main page.
    fn start_workbench(&self) -> port::Result<()> {
        self.reload(self.window.label())
    }

    /// Runs script in the main page.
    fn call_workbench(&self, script: &str) -> port::Result<()> {
        self.eval(self.window.label(), script)
    }

    fn add_child(
        &self,
        builder: WebviewBuilder,
        position: LogicalPosition,
        size: LogicalSize,
    ) -> port::Result<String> {
        let url = match builder.url {
            WebviewUrl::External(url) => tauri::WebviewUrl::External(url),
        };
        let mut child = tauri::webview::WebviewBuilder::new(builder.label, url);
        if let Some(port::Color(red, green, blue, alpha)) = builder.background_color {
            child = child.background_color(tauri::webview::Color(red, green, blue, alpha));
        }
        self.window
            .add_child(
                child.focused(builder.focused),
                tauri::LogicalPosition::new(position.x, position.y),
                tauri::LogicalSize::new(size.width, size.height),
            )
            .map(|webview| webview.label().to_string())
            .map_err(error)
    }

    fn with_webview(
        &self,
        webview: &str,
        work: Box<dyn FnOnce(PlatformWebview) + Send>,
    ) -> port::Result<()> {
        self.webview(webview)?
            .with_webview(move |view| work(crate::platform::platform_webview(&view)))
            .map_err(error)
    }

    fn reload(&self, webview: &str) -> port::Result<()> {
        self.webview(webview)?.reload().map_err(error)
    }

    fn eval(&self, webview: &str, script: &str) -> port::Result<()> {
        self.webview(webview)?.eval(script).map_err(error)
    }

    fn navigate(&self, webview: &str, url: url::Url) -> port::Result<()> {
        self.webview(webview)?.navigate(url).map_err(error)
    }

    fn url(&self, webview: &str) -> port::Result<url::Url> {
        self.webview(webview)?.url().map_err(error)
    }

    fn close_webview(&self, webview: &str) -> port::Result<()> {
        self.webview(webview)?.close().map_err(error)
    }

    fn show_webview(&self, webview: &str) -> port::Result<()> {
        self.webview(webview)?.show().map_err(error)
    }

    fn hide_webview(&self, webview: &str) -> port::Result<()> {
        self.webview(webview)?.hide().map_err(error)
    }

    fn set_webview_focus(&self, webview: &str) -> port::Result<()> {
        self.webview(webview)?.set_focus().map_err(error)
    }

    fn set_webview_auto_resize(&self, webview: &str, auto_resize: bool) -> port::Result<()> {
        self.webview(webview)?
            .set_auto_resize(auto_resize)
            .map_err(error)
    }
}
