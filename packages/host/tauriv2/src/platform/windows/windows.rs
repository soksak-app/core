//! The Windows implementation of the Tauri functions of the framework adapter. Each function that needs a native handle
//! returns a "not implemented on windows" error.

use std::ffi::c_void;

use soksak_host::framework::{self as port, PlatformWebview};

pub(crate) fn prepare_window<'a>(
    _builder: tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>,
) -> Result<tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>, String> {
    Err("window preparation is not implemented on windows".to_string())
}

pub(crate) fn platform_webview(_webview: &tauri::webview::PlatformWebview) -> PlatformWebview {
    PlatformWebview {
        webview: std::ptr::null_mut(),
        controller: std::ptr::null_mut(),
        window: std::ptr::null_mut(),
    }
}

pub(crate) fn ns_window(_window: &tauri::Window) -> port::Result<*mut c_void> {
    Err(port::Error::from(
        "native window handle is not implemented on windows",
    ))
}

pub(crate) fn launch_activation(
    builder: tauri::Builder<tauri::Wry>,
    _ignore_other_apps: bool,
) -> Result<tauri::Builder<tauri::Wry>, String> {
    drop(builder);
    Err("launch activation is not implemented on windows".to_string())
}
