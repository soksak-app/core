//! The macOS implementation of the Tauri functions of the framework adapter.

use std::ffi::c_void;

use soksak_host::framework::{self as port, PlatformWebview};

/// Overlays the title bar of the project window on the page and hides the title. A click on an inactive window is also
/// passed to the webview.
pub(crate) fn prepare_window<'a>(
    builder: tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>,
) -> Result<tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>, String> {
    Ok(builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .accept_first_mouse(true))
}

/// The native handles of a Tauri web view.
pub(crate) fn platform_webview(webview: &tauri::webview::PlatformWebview) -> PlatformWebview {
    PlatformWebview {
        webview: webview.inner(),
        controller: webview.controller(),
        window: webview.ns_window(),
    }
}

/// The NSWindow of a Tauri window.
pub(crate) fn ns_window(window: &tauri::Window) -> port::Result<*mut c_void> {
    window.ns_window().map_err(crate::framework::error)
}

/// Activates the application at launch, ignoring other applications when ignore_other_apps is true.
pub(crate) fn launch_activation(
    builder: tauri::Builder<tauri::Wry>,
    ignore_other_apps: bool,
) -> Result<tauri::Builder<tauri::Wry>, String> {
    Ok(builder.activate_ignoring_other_apps(ignore_other_apps))
}
