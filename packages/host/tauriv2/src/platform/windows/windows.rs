//! The Windows implementation of the Tauri functions of the framework adapter. Each function that needs a native handle
//! returns a "not implemented on windows" error.

use std::ffi::c_void;
use std::sync::Arc;

use soksak_host::application_log::log_error;
use soksak_host::framework::{self as port, PlatformWebview};
use soksak_host::platform::process_failure::{ProcessFailure, process_failure};
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND;
use webview2_com::ProcessFailedEventHandler;
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

/// Shows the window through tao, which holds its visibility, with the rule that keeps the front on the position change of that show. A
/// window that did not take the rule stays hidden, because a show without it would take the front, and the failure is recorded.
pub(crate) fn show_window(window: &tauri::Window) -> port::Result<()> {
    let handle = ns_window(window)? as usize;
    let held = window.clone();
    window
        .run_on_main_thread(move || {
            let shown = soksak_host::platform::keep_front_on_show(handle)
                .and_then(|()| held.show().map_err(|e| e.to_string()));
            if let Err(error) = shown {
                soksak_host::application_log::log_error("window show", error);
            }
        })
        .map_err(crate::framework::error)
}

/// Calls ended when the process of the page of a web view ended.
pub(crate) fn watch_page_process_end(
    builder: tauri::Builder<tauri::Wry>,
    ended: impl Fn(&tauri::Webview) + Send + Sync + 'static,
) -> tauri::Builder<tauri::Wry> {
    builder.plugin(process_failure_plugin(ended))
}

/// The plugin that reads the process failures of every web view, which Tauri does not offer on Windows. ended receives a web view that lost
/// its page.
fn process_failure_plugin(
    ended: impl Fn(&tauri::Webview) + Send + Sync + 'static,
) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let ended = Arc::new(ended);
    tauri::plugin::Builder::<tauri::Wry>::new("web-view-process")
        .on_webview_ready(move |webview| {
            let ended = ended.clone();
            let label = webview.label().to_string();
            let watched = webview.clone();
            let handled = webview.with_webview(move |view| {
                if let Err(error) = watch_process_failures(&view, watched, ended) {
                    log_error("web view process", format!("{label}: {error}"));
                }
            });
            if let Err(error) = handled {
                log_error("web view process", error);
            }
        })
        .build()
}

fn watch_process_failures(
    view: &tauri::webview::PlatformWebview,
    webview: tauri::Webview,
    ended: Arc<impl Fn(&tauri::Webview) + Send + Sync + 'static>,
) -> windows::core::Result<()> {
    let handler = ProcessFailedEventHandler::create(Box::new(move |_, failure| {
        let Some(failure) = failure else {
            log_error(
                "web view process",
                "a process failure came without its arguments",
            );
            return Ok(());
        };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        // SAFETY: the system passes valid arguments, and kind is valid for one write.
        unsafe { failure.ProcessFailedKind(&mut kind) }?;
        match process_failure(kind.0) {
            ProcessFailure::PageEnded => ended(&webview),
            ProcessFailure::PageStays => soksak_host::application_log::log_info(
                "web view process",
                format!("{}: process failure {}", webview.label(), kind.0),
            ),
        }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: the controller is valid, and token is valid for one write. The subscription ends with the web view.
    unsafe {
        view.controller()
            .CoreWebView2()?
            .add_ProcessFailed(&handler, &mut token)
    }
}

pub(crate) fn launch_activation(
    builder: tauri::Builder<tauri::Wry>,
    _ignore_other_apps: bool,
) -> Result<tauri::Builder<tauri::Wry>, String> {
    drop(builder);
    Err("launch activation is not implemented on windows".to_string())
}
