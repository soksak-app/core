//! A Tauri window as the Frontend port of the language host library.

use std::ffi::c_void;

use soksak_host::framework::{
    self as port, CloseRequestApi, LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize,
    PlatformWebview, Position, Size, WebviewBuilder, WebviewUrl, WindowEvent,
};
use tauri::Manager;

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
}

/// The library event of a Tauri window event, or None for an event that the library does not handle. A close request
/// carries an answer that is not yet given; the window listener passes it to the Tauri answer.
pub fn window_event(event: &tauri::WindowEvent) -> Option<WindowEvent> {
    Some(match event {
        tauri::WindowEvent::Resized(size) => {
            WindowEvent::Resized(PhysicalSize::new(size.width, size.height))
        }
        tauri::WindowEvent::Moved(position) => {
            WindowEvent::Moved(PhysicalPosition::new(position.x, position.y))
        }
        tauri::WindowEvent::ScaleFactorChanged { .. } => WindowEvent::ScaleFactorChanged,
        tauri::WindowEvent::Focused(focused) => WindowEvent::Focused(*focused),
        tauri::WindowEvent::CloseRequested { .. } => WindowEvent::CloseRequested {
            api: CloseRequestApi::default(),
        },
        tauri::WindowEvent::Destroyed => WindowEvent::Destroyed,
        _ => return None,
    })
}

fn tauri_size(size: Size) -> tauri::Size {
    match size {
        Size::Logical(LogicalSize { width, height }) => {
            tauri::LogicalSize::new(width, height).into()
        }
        Size::Physical(PhysicalSize { width, height }) => {
            tauri::PhysicalSize::new(width, height).into()
        }
    }
}

fn tauri_position(position: Position) -> tauri::Position {
    match position {
        Position::Logical(LogicalPosition { x, y }) => tauri::LogicalPosition::new(x, y).into(),
        Position::Physical(PhysicalPosition { x, y }) => tauri::PhysicalPosition::new(x, y).into(),
    }
}

impl port::Frontend for Frontend {
    fn label(&self) -> &str {
        self.window.label()
    }

    fn title(&self) -> port::Result<String> {
        self.window.title().map_err(error)
    }

    fn set_title(&self, title: &str) -> port::Result<()> {
        self.window.set_title(title).map_err(error)
    }

    fn show(&self) -> port::Result<()> {
        self.window.show().map_err(error)
    }

    fn set_focus(&self) -> port::Result<()> {
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

    fn inner_size(&self) -> port::Result<PhysicalSize> {
        self.window
            .inner_size()
            .map(|size| PhysicalSize::new(size.width, size.height))
            .map_err(error)
    }

    fn outer_position(&self) -> port::Result<PhysicalPosition> {
        self.window
            .outer_position()
            .map(|position| PhysicalPosition::new(position.x, position.y))
            .map_err(error)
    }

    fn set_size(&self, size: Size) -> port::Result<()> {
        self.window.set_size(tauri_size(size)).map_err(error)
    }

    fn set_position(&self, position: Position) -> port::Result<()> {
        self.window
            .set_position(tauri_position(position))
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

    fn ns_window(&self) -> port::Result<*mut c_void> {
        crate::platform::ns_window(&self.window)
    }

    fn webviews(&self) -> Vec<String> {
        self.window
            .webviews()
            .iter()
            .map(|webview| webview.label().to_string())
            .collect()
    }

    fn on_window_event(&self, listener: Box<dyn Fn(&WindowEvent) + Send + Sync>) {
        self.window.on_window_event(move |event| {
            let Some(host_event) = window_event(event) else {
                return;
            };
            listener(&host_event);
            if let (
                tauri::WindowEvent::CloseRequested { api, .. },
                WindowEvent::CloseRequested { api: host_api },
            ) = (event, &host_event)
                && host_api.prevented()
            {
                api.prevent_close();
            }
        });
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

    fn set_webview_position(&self, webview: &str, position: Position) -> port::Result<()> {
        self.webview(webview)?
            .set_position(tauri_position(position))
            .map_err(error)
    }

    fn set_webview_size(&self, webview: &str, size: Size) -> port::Result<()> {
        self.webview(webview)?
            .set_size(tauri_size(size))
            .map_err(error)
    }

    fn set_webview_auto_resize(&self, webview: &str, auto_resize: bool) -> port::Result<()> {
        self.webview(webview)?
            .set_auto_resize(auto_resize)
            .map_err(error)
    }
}
