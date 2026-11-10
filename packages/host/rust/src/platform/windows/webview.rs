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

/// The subclass of a window whose web view takes its input; the show rule of show_windows.rs is subclass 1.
const VIEW_END_SUBCLASS: usize = 2;

/// The WebView2 of a window that takes the input of the window.
pub(super) struct View {
    pub(super) window: HWND,
    pub(super) controller: ICoreWebView2Controller,
    pub(super) presses: RefCell<PressState>,
    pub(super) queue: InputQueue,
    core: ICoreWebView2,
    /// The subscription to the process failures of the web view.
    failed_token: i64,
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

/// Subscribes to the process failures of the web view, which WebView2 raises on the UI thread. The end of the page process ends the
/// DevTools connection of the page, so it answers the open inputs of queue.
fn watch_process_failures(core: &ICoreWebView2, queue: InputQueue) -> Result<i64, String> {
    let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        if let Some(args) = args {
            unsafe { args.ProcessFailedKind(&mut kind) }?;
        }
        if process_failure(kind.0) == ProcessFailure::PageEnded {
            queue.connection_ended("the process of the page ended");
        }
        Ok(())
    }));
    let mut token = 0i64;
    unsafe { core.add_ProcessFailed(&handler, &mut token) }
        .map_err(|e| error("add_ProcessFailed", e))?;
    Ok(token)
}

/// Ends the input of the web view of a window when the window is destroyed: its open inputs answer that end, and the window forgets
/// the view.
unsafe extern "system" fn end_view_with_window(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass: usize,
    _data: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        let view = VIEWS.with(|views| views.borrow_mut().remove(&(window.0 as Handle)));
        if let Some(view) = view {
            view.queue.end("the window ended");
            if let Err(failure) = unsafe { view.core.remove_ProcessFailed(view.failed_token) } {
                crate::application_log::log_error("web view process", failure);
            }
        }
        if !unsafe { RemoveWindowSubclass(window, Some(end_view_with_window), VIEW_END_SUBCLASS) }
            .as_bool()
        {
            crate::application_log::log_error("web view input", "the window kept its end subclass");
        }
    }
    unsafe { DefSubclassProc(window, message, wparam, lparam) }
}

/// Makes a web view take the input and the capture of its parent window. The first web view of a window is its main web view, which the
/// host registers before any other. Call it on the UI thread, while the controller of the view is valid.
pub fn register(view: &PlatformWebview) -> Result<bool, String> {
    super::ui_thread::start_task_window()?;
    let controller = unsafe { ICoreWebView2Controller::from_raw_borrowed(&view.controller) }
        .ok_or("the web view has no controller")?
        .clone();
    let core = unsafe { controller.CoreWebView2() }.map_err(|e| error("web view", e))?;
    let mut window = HWND::default();
    unsafe { controller.ParentWindow(&mut window) }.map_err(|e| error("web view window", e))?;
    let handle = window.0 as Handle;
    if VIEWS.with(|views| views.borrow().contains_key(&handle)) {
        return Ok(true);
    }
    let queue = InputQueue::new(Box::new(ProtocolTransport(core.clone())));
    let failed_token = watch_process_failures(&core, queue.clone())?;
    // The destruction of the window removes its entry, so the system cannot give the handle of a closed window to a new one while
    // the entry stays.
    if !unsafe { SetWindowSubclass(window, Some(end_view_with_window), VIEW_END_SUBCLASS, 0) }
        .as_bool()
    {
        if let Err(failure) = unsafe { core.remove_ProcessFailed(failed_token) } {
            crate::application_log::log_error("web view process", failure);
        }
        return Err(format!(
            "web view input: the window {handle:#x} did not take its end subclass"
        ));
    }
    VIEWS.with(|views| {
        let previous = views.borrow_mut().insert(
            handle,
            Rc::new(View {
                window,
                queue,
                controller,
                presses: RefCell::default(),
                core,
                failed_token,
            }),
        );
        debug_assert!(previous.is_none(), "a window registers its web view once");
    });
    Ok(true)
}

pub(super) fn view_of(window: Handle) -> Result<Rc<View>, String> {
    VIEWS
        .with(|views| views.borrow().get(&window).cloned())
        .ok_or_else(|| format!("the window {window:#x} has no web view"))
}
