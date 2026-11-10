//! The WebView2 of a window that takes its input and capture, and the way its DevTools protocol is called.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use ::windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use ::windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use ::windows::Win32::UI::WindowsAndMessaging::WM_NCDESTROY;
use ::windows::core::{HSTRING, Interface, PCWSTR};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, ICoreWebView2, ICoreWebView2Controller,
};
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, ProcessFailedEventHandler};

use super::ui_thread::{after_on_ui_thread, error};
use crate::framework::PlatformWebview;
use crate::platform::Handle;
use crate::platform::devtools_input::{After, Call, Complete, InputQueue, PressState, Transport};
use crate::platform::process_failure::{ProcessFailure, process_failure};

/// The WebView2 of a window that takes the input of the window.
pub(super) struct View {
    pub(super) window: HWND,
    core: ICoreWebView2,
    /// The subscription of ProcessFailed, which ends the calls of a page that ended.
    failed: i64,
    pub(super) controller: ICoreWebView2Controller,
    pub(super) presses: RefCell<PressState>,
    pub(super) queue: InputQueue,
}

thread_local! {
    /// The web views of the UI thread, by window. COM objects of a web view belong to that thread.
    static VIEWS: RefCell<HashMap<Handle, Rc<View>>> = RefCell::default();
}

/// Sends the calls of a queue through ICoreWebView2::CallDevToolsProtocolMethod.
struct ProtocolTransport(ICoreWebView2);

impl Transport for ProtocolTransport {
    fn send(&self, call: &Call, complete: Complete) -> Result<(), String> {
        let method = call.method;
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _value| {
                complete(result.map_err(|e| e.to_string()));
                Ok(())
            }));
        let name = HSTRING::from(method);
        let params = HSTRING::from(call.params.as_str());
        unsafe {
            self.0.CallDevToolsProtocolMethod(
                PCWSTR(name.as_ptr()),
                PCWSTR(params.as_ptr()),
                &handler,
            )
        }
        .map_err(|e| error(method, e))
    }
}

pub(super) fn after() -> After {
    Rc::new(after_on_ui_thread)
}

/// The id of the subclass that hears the end of a window with a web view.
const WINDOW_END: usize = 2;

/// Hears the end of a window: its web view ends, and so do its input calls, which no completion ends after it.
unsafe extern "system" fn window_end(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass: usize,
    _data: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        end(window.0 as Handle);
        if !unsafe { RemoveWindowSubclass(window, Some(window_end), WINDOW_END) }.as_bool() {
            crate::application_log::log_error(
                "web view",
                format!(
                    "the window {:#x} kept the watch of its end",
                    window.0 as Handle
                ),
            );
        }
    }
    unsafe { DefSubclassProc(window, message, wparam, lparam) }
}

/// Ends the web view of a window and its input calls.
fn end(window: Handle) {
    let Some(view) = VIEWS.with(|views| views.borrow_mut().remove(&window)) else {
        return;
    };
    if let Err(e) = unsafe { view.core.remove_ProcessFailed(view.failed) } {
        crate::application_log::log_error("web view process", error("remove_ProcessFailed", e));
    }
    view.queue.end();
}

/// Subscribes the queue to the process failures of its web view, which WebView2 raises on the UI thread: the end of the page ends its
/// calls, which that page no longer receives.
fn watch_process_failures(core: &ICoreWebView2, queue: InputQueue) -> Result<i64, String> {
    let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        if let Err(e) = unsafe { args.ProcessFailedKind(&mut kind) } {
            crate::application_log::log_error("web view process", error("ProcessFailedKind", e));
            return Ok(());
        }
        if process_failure(kind.0) == ProcessFailure::PageEnded {
            queue.page_ended();
        }
        Ok(())
    }));
    let mut token = 0i64;
    unsafe { core.add_ProcessFailed(&handler, &mut token) }
        .map_err(|e| error("add_ProcessFailed", e))?;
    Ok(token)
}

/// Makes a web view take the input and the capture of its parent window. The first web view of a window is its main web view, which the
/// host registers before any other. The end of its page and the end of its window end its input calls. Call it on the UI thread, while
/// the controller of the view is valid.
pub fn register(view: &PlatformWebview) -> Result<bool, String> {
    super::ui_thread::start_task_window()?;
    let controller = unsafe { ICoreWebView2Controller::from_raw_borrowed(&view.controller) }
        .ok_or("the web view has no controller")?
        .clone();
    let core = unsafe { controller.CoreWebView2() }.map_err(|e| error("web view", e))?;
    let mut window = HWND::default();
    unsafe { controller.ParentWindow(&mut window) }.map_err(|e| error("web view window", e))?;
    let handle = window.0 as Handle;
    // The first web view of a window keeps the window. The end of a window removed its entry, so a new window with its handle registers.
    if VIEWS.with(|views| views.borrow().contains_key(&handle)) {
        return Ok(true);
    }
    let queue = InputQueue::new(Box::new(ProtocolTransport(core.clone())));
    let failed = watch_process_failures(&core, queue.clone())?;
    VIEWS.with(|views| {
        views.borrow_mut().insert(
            handle,
            Rc::new(View {
                window,
                core,
                failed,
                queue,
                controller,
                presses: RefCell::default(),
            }),
        )
    });
    if !unsafe { SetWindowSubclass(window, Some(window_end), WINDOW_END, 0) }.as_bool() {
        end(handle);
        return Err(format!(
            "web view: the window {handle:#x} did not take the watch of its end"
        ));
    }
    Ok(true)
}

pub(super) fn view_of(window: Handle) -> Result<Rc<View>, String> {
    VIEWS
        .with(|views| views.borrow().get(&window).cloned())
        .ok_or_else(|| format!("the window {window:#x} has no web view"))
}
