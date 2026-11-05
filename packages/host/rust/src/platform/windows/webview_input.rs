//! Pointer and key input of a WebView2, through its DevTools protocol. It uses no real input and needs no system focus, so a window behind
//! others takes it. SendInput is not used.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;
use std::time::{Duration, Instant};

use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, IsWindow, KillTimer, SetForegroundWindow, SetTimer,
};
use ::windows::core::{HSTRING, Interface, PCWSTR};
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC, ICoreWebView2, ICoreWebView2Controller,
};

use crate::framework::PlatformWebview;
use crate::platform::devtools::{
    After, Answer, Call, Cancel, InputQueue, PressState, Transport, key_call, pointer_delivery,
};
use crate::platform::{Delivery, Handle, Key, Pointer};

/// How long a key may stay uncompleted before the next input reports it.
const KEY_WAIT: Duration = Duration::from_secs(10);
/// How often an activation reads the foreground window.
const ACTIVATE_STEP: Duration = Duration::from_millis(20);

/// The WebView2 of a window that takes the input of the window.
pub(super) struct View {
    pub(super) window: HWND,
    pub(super) controller: ICoreWebView2Controller,
    presses: RefCell<PressState>,
    queue: InputQueue,
}

thread_local! {
    /// The web views of the UI thread, by window. COM objects of a web view belong to that thread.
    static VIEWS: RefCell<HashMap<Handle, Rc<View>>> = RefCell::default();
    /// The waits of the UI thread, by timer.
    static TIMERS: RefCell<HashMap<usize, Box<dyn FnOnce()>>> = RefCell::default();
}

pub(super) fn error(stage: &str, failure: impl fmt::Display) -> String {
    format!("{stage}: {failure}")
}

/// A timer that does not stop fires again and finds no task, so its failure is only recorded.
fn stop_timer(timer: usize) {
    if let Err(failure) = unsafe { KillTimer(None, timer) } {
        crate::application_log::log_error("input wait", failure);
    }
}

unsafe extern "system" fn timer_proc(_: HWND, _: u32, timer: usize, _: u32) {
    stop_timer(timer);
    let task = TIMERS.with(|timers| timers.borrow_mut().remove(&timer));
    if let Some(task) = task {
        task();
    }
}

/// Runs task on the UI thread after a wait, unless the returned function cancels it. Call it on the UI thread.
pub(super) fn after_on_ui_thread(wait: Duration, task: Box<dyn FnOnce()>) -> Cancel {
    let millis = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX);
    let timer = unsafe { SetTimer(None, 0, millis, Some(timer_proc)) };
    if timer == 0 {
        // A process runs out of timers only when it is failing, and a wait must still end.
        crate::application_log::log_error("input wait", ::windows::core::Error::from_thread());
        task();
        return Box::new(|| {});
    }
    TIMERS.with(|timers| timers.borrow_mut().insert(timer, task));
    Box::new(move || {
        stop_timer(timer);
        TIMERS.with(|timers| timers.borrow_mut().remove(&timer));
    })
}

/// Sends the calls of a queue through ICoreWebView2::CallDevToolsProtocolMethod.
struct ProtocolTransport(ICoreWebView2);

impl Transport for ProtocolTransport {
    fn send(
        &self,
        call: &Call,
        complete: Box<dyn FnOnce(Result<(), String>)>,
    ) -> Result<(), String> {
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
    #[cfg(feature = "diagnostics")]
    super::webview_capture::start_task_window()?;
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

/// Delivers a pointer input. Call it on the UI thread.
pub fn pointer(
    window: Handle,
    pointer: Pointer,
    receive: Duration,
    done: Box<dyn FnOnce(Delivery) + Send>,
) -> Result<(), String> {
    let view = view_of(window)?;
    let call = match view.presses.borrow().call(&pointer) {
        Ok(call) => call,
        Err(delivery) => {
            done(delivery);
            return Ok(());
        }
    };
    let held = view.clone();
    let answer: Answer = Box::new(move |result| {
        match &result {
            Ok(()) => held
                .presses
                .borrow_mut()
                .delivered(pointer.phase, pointer.button),
            Err(failure) => {
                crate::application_log::log_error("input.pointer", format!("{failure:?}"))
            }
        }
        done(pointer_delivery(&result));
    });
    view.queue.push(call, receive, Some(answer))
}

/// Queues a key input. The next input reports a call that failed, because this call answers on the UI thread before the call ends. Call it
/// on the UI thread.
pub fn key(window: Handle, key: &Key) -> Result<Delivery, String> {
    let view = view_of(window)?;
    let call = match key_call(key) {
        Ok(call) => call,
        Err(delivery) => return Ok(delivery),
    };
    view.queue.push(call, KEY_WAIT, None)?;
    Ok(Delivery::Delivered)
}

/// Asks the system for the foreground and gives the web view the focus. Input does not need it: a run that a person checks asks for it. The
/// system refuses a process that is not in front, and that refusal is the answer after timeout. Call it on the UI thread.
pub fn activate(
    window: Handle,
    timeout: Duration,
    done: Box<dyn FnOnce(Result<(), String>) + Send>,
) -> Result<(), String> {
    let view = view_of(window)?;
    if !unsafe { SetForegroundWindow(view.window) }.as_bool() {
        crate::application_log::log_info("activation", "the system refused the foreground");
    }
    check_activation(view, Instant::now() + timeout, timeout, done);
    Ok(())
}

fn check_activation(
    view: Rc<View>,
    deadline: Instant,
    timeout: Duration,
    done: Box<dyn FnOnce(Result<(), String>) + Send>,
) {
    if unsafe { GetForegroundWindow() } == view.window {
        done(
            unsafe {
                view.controller
                    .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
            }
            .map_err(|e| error("web view focus", e)),
        );
    } else if Instant::now() > deadline {
        done(Err(format!(
            "the system did not give the window the foreground within {timeout:?}"
        )));
    } else {
        // The timer keeps no cancel: this check ends by itself.
        drop(after_on_ui_thread(
            ACTIVATE_STEP,
            Box::new(move || check_activation(view, deadline, timeout, done)),
        ));
    }
}
