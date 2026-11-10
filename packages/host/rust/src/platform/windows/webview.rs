//! The WebView2 of a window that takes its input and capture, and the way its DevTools protocol is called.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::UI::WindowsAndMessaging::IsWindow;
use ::windows::core::{HSTRING, Interface, PCWSTR};
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Controller};

use super::ui_thread::{after_on_ui_thread, error};
use crate::framework::PlatformWebview;
use crate::platform::Handle;
use crate::platform::devtools_input::{After, Call, Complete, InputQueue, PressState, Transport};

/// The WebView2 of a window that takes the input of the window.
pub(super) struct View {
    pub(super) window: HWND,
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
    VIEWS.with(|views| {
        let mut views = views.borrow_mut();
        // A window that closed left its entry, and the system may give its handle to a new window.
        views.retain(|_, known| unsafe { IsWindow(Some(known.window)) }.as_bool());
        views.entry(handle).or_insert_with(|| {
            Rc::new(View {
                window,
                queue: InputQueue::new(Box::new(ProtocolTransport(core)), after()),
                controller,
                presses: RefCell::default(),
            })
        });
    });
    Ok(true)
}

pub(super) fn view_of(window: Handle) -> Result<Rc<View>, String> {
    VIEWS
        .with(|views| views.borrow().get(&window).cloned())
        .ok_or_else(|| format!("the window {window:#x} has no web view"))
}
