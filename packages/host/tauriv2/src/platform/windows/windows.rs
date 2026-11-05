//! The Windows implementation of the Tauri functions of the framework adapter. Each function that needs a native handle
//! returns a "not implemented on windows" error.

use std::ffi::c_void;

use soksak_host::framework::{self as port, PlatformWebview};
use windows::Win32::Foundation::HWND;
use windows::core::Interface;

pub(crate) fn prepare_window<'a>(
    builder: tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>,
) -> Result<tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>, String> {
    // A window that is not focused at creation is shown with SW_SHOWNOACTIVATE, so opening it does not take the front.
    Ok(builder.focused(false))
}

pub(crate) fn platform_webview(webview: &tauri::webview::PlatformWebview) -> PlatformWebview {
    // The pointers stay valid after these copies drop: the web view holds its controller and core until it closes.
    let controller = webview.controller();
    let mut parent = HWND::default();
    // SAFETY: the controller is valid and parent is valid for one write. A failure leaves the null pointer, which no window has.
    let window = match unsafe { controller.ParentWindow(&mut parent) } {
        Ok(()) => parent.0,
        Err(_) => std::ptr::null_mut(),
    };
    // SAFETY: the controller is valid. A controller that closed has no core, and it answers the null pointer.
    let core = unsafe { controller.CoreWebView2() };
    PlatformWebview {
        webview: core.map_or(std::ptr::null_mut(), |core| core.as_raw()),
        controller: controller.as_raw(),
        window,
    }
}

pub(crate) fn ns_window(window: &tauri::Window) -> port::Result<*mut c_void> {
    Ok(window
        .hwnd()
        .map_err(|e| port::Error::from(e.to_string()))?
        .0)
}

pub(crate) fn show_window(window: &tauri::Window) -> port::Result<()> {
    window.show().map_err(crate::framework::error)
}

pub(crate) fn launch_activation(
    builder: tauri::Builder<tauri::Wry>,
    _ignore_other_apps: bool,
) -> Result<tauri::Builder<tauri::Wry>, String> {
    drop(builder);
    Err("launch activation is not implemented on windows".to_string())
}
