//! Pointer and key input of a WebView2, through its DevTools protocol. It uses no real input and needs no system focus,
//! so a window behind others takes it. SendInput is not used.

use ::windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;

use super::ui_thread::error;
use super::webview::view_of;
use crate::platform::devtools_input::{Answer, key_call, pointer_delivery};
use crate::platform::{Delivery, Handle, Key, Pointer};

/// Delivers a pointer input. done runs when its call completes, or when the page or the web view ends first. Call it on the UI thread.
pub fn pointer(
    window: Handle,
    pointer: Pointer,
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
            Ok(()) => {
                held.presses
                    .borrow_mut()
                    .delivered(&pointer.pointer, pointer.phase, pointer.button)
            }
            Err(failure) => {
                crate::application_log::log_error("input.pointer", format!("{failure:?}"))
            }
        }
        done(pointer_delivery(&result));
    });
    view.queue.push(call, Some(answer))
}

/// Queues a key input. The next input reports a call that failed, because this call answers on the UI thread before the call ends. Call it
/// on the UI thread.
pub fn key(window: Handle, key: &Key) -> Result<Delivery, String> {
    let view = view_of(window)?;
    let call = match key_call(key) {
        Ok(call) => call,
        Err(delivery) => return Ok(delivery),
    };
    view.queue.push(call, None)?;
    Ok(Delivery::Delivered)
}

/// Asks the system for the foreground and gives the web view the focus. Input does not need it: a run that a person checks asks for it.
/// SetForegroundWindow answers in its call: it returns false when the system refuses a process that is not in front, and that refusal is
/// the answer unless the window already has the foreground. Call it on the UI thread.
pub fn activate(
    window: Handle,
    done: Box<dyn FnOnce(Result<(), String>) + Send>,
) -> Result<(), String> {
    let view = view_of(window)?;
    if !unsafe { SetForegroundWindow(view.window) }.as_bool() {
        let foreground = unsafe { GetForegroundWindow() };
        if foreground != view.window {
            done(Err(format!(
                "the system did not give the window the foreground; the foreground window is {:#x}",
                foreground.0 as usize
            )));
            return Ok(());
        }
    }
    done(
        unsafe {
            view.controller
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
        }
        .map_err(|e| error("web view focus", e)),
    );
    Ok(())
}
