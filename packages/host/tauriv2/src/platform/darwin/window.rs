//! Window settings, window buttons and window numbers.

use std::ffi::{c_char, c_void, CStr};

use block2::{Block, RcBlock};

#[cfg(feature = "diagnostics")]
use objc2::msg_send;
#[cfg(feature = "diagnostics")]
use objc2::runtime::AnyObject;
use serde_json::Value;
use tauri::Window;

use super::super::{Frame, Handle, WindowBuilder};

/// Overlays the title bar of the project window on the page and hides the title. A click on an inactive window is also
/// passed to the webview.
pub fn prepare(builder: WindowBuilder<'_>) -> WindowBuilder<'_> {
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .accept_first_mouse(true)
}

/// Returns the NSWindow address of the window.
pub fn handle(window: &Window) -> Result<Handle, String> {
    window
        .ns_window()
        .map(|h| h as Handle)
        .map_err(|e| e.to_string())
}

pub fn set_main_webview(window: Handle, main: Handle) -> Result<(), String> {
    extern "C" {
        fn sp_window_set_main_webview(window: *mut c_void, main: *mut c_void) -> bool;
    }
    if unsafe { sp_window_set_main_webview(window as *mut c_void, main as *mut c_void) } {
        Ok(())
    } else {
        Err("the main webview is not in the window hierarchy".into())
    }
}

pub fn reveal_after_load(window: Handle) -> Result<(), String> {
    extern "C" {
        fn sp_window_reveal_after_load(window: *mut c_void, error: *mut *mut c_char) -> bool;
        fn free(pointer: *mut c_void);
    }
    let mut error = std::ptr::null_mut();
    if unsafe { sp_window_reveal_after_load(window as *mut c_void, &mut error) } {
        return Ok(());
    }
    let message = unsafe { CStr::from_ptr(error) }
        .to_string_lossy()
        .into_owned();
    unsafe { free(error as *mut c_void) };
    Err(message)
}

/// Reads the current area of the window buttons without changing the placement.
pub fn controls(window: Handle) -> Frame {
    let mut rect = [0.0; 4];
    unsafe {
        extern "C" {
            fn windowControls(window: *mut c_void, out: *mut f64);
        }
        windowControls(window as *mut c_void, rect.as_mut_ptr());
    }
    (rect[0], rect[1], rect[2], rect[3])
}

/// Changes the window to full screen or back, and calls done when the transition ends.
pub fn fullscreen(window: Handle, on: bool, done: Box<dyn Fn()>) -> Result<(), String> {
    extern "C" {
        fn sp_window_fullscreen(window: *mut c_void, on: bool, done: &Block<dyn Fn()>) -> bool;
    }
    let done = RcBlock::new(done);
    if unsafe { sp_window_fullscreen(window as *mut c_void, on, &done) } {
        Ok(())
    } else {
        Err("the window does not support full screen".into())
    }
}

/// Calls changed whenever the occlusion state of the window changes (NSWindowDidChangeOcclusionStateNotification).
pub fn observe_occlusion(window: Handle, changed: Box<dyn Fn()>) -> Result<(), String> {
    extern "C" {
        fn sp_window_observe_occlusion(window: *mut c_void, changed: &Block<dyn Fn()>) -> bool;
    }
    let changed = RcBlock::new(changed);
    if unsafe { sp_window_observe_occlusion(window as *mut c_void, &changed) } {
        Ok(())
    } else {
        Err("the window occlusion cannot be observed without a window".into())
    }
}

/// Returns the title bar height of the window. It returns an error for a window that cannot have a title bar.
pub fn titlebar_height(window: Handle) -> Result<f64, String> {
    extern "C" {
        fn windowTitlebarHeight(window: *mut c_void) -> f64;
    }
    // 0 is the height of a window without a title bar (full screen), and a negative value means a window that cannot
    // get a title bar.
    let row = unsafe { windowTitlebarHeight(window as *mut c_void) };
    if row >= 0.0 {
        Ok(row)
    } else {
        Err("the window has no standard buttons or content view for a title bar".into())
    }
}

/// Creates the title bar of the window with height (pt). If it cannot be created, it returns the failure text of
/// native.
pub fn set_titlebar_height(window: Handle, height: f64) -> Result<(), String> {
    extern "C" {
        fn windowSetTitlebarHeight(
            window: *mut c_void,
            height: f64,
            failure: *mut *mut c_char,
        ) -> bool;
        fn free(pointer: *mut c_void);
    }
    let mut failure: *mut c_char = std::ptr::null_mut();
    if unsafe { windowSetTitlebarHeight(window as *mut c_void, height, &mut failure) } {
        return Ok(());
    }
    let message = unsafe { CStr::from_ptr(failure) }
        .to_string_lossy()
        .into_owned();
    unsafe { free(failure as *mut c_void) };
    Err(message)
}

#[cfg(feature = "diagnostics")]
/// Returns the number that the window server assigned to this window and the windows attached to it.
///
/// The capture tool reads the composition result of the window server (page, surfaces, modals) by window number. It
/// does not bring the window to the front and does not take the focus from another window. A screen region capture
/// records the frontmost window, and bringing a window to the front changes the state under measurement.
pub fn numbers(window: Handle) -> Vec<isize> {
    unsafe {
        let window = window as *mut AnyObject;
        if window.is_null() {
            return Vec::new();
        }
        let mut out = vec![msg_send![window, windowNumber]];
        let children: *mut AnyObject = msg_send![window, childWindows];
        if !children.is_null() {
            let count: usize = msg_send![children, count];
            for i in 0..count {
                let child: *mut AnyObject = msg_send![children, objectAtIndex: i];
                out.push(msg_send![child, windowNumber]);
            }
        }
        out
    }
}

/// Reads and releases the JSON string that native/darwin returned.
pub(super) fn facts_value(text: *mut c_char, what: &str) -> Result<Value, String> {
    extern "C" {
        fn sp_facts_free(text: *mut c_char);
    }
    if text.is_null() {
        return Err(format!("{what}: the window is gone"));
    }
    let parsed = serde_json::from_slice(unsafe { CStr::from_ptr(text) }.to_bytes())
        .map_err(|e| format!("{what}: {e}"));
    unsafe { sp_facts_free(text) };
    parsed
}

/// The frame, the active state, the window buttons and the webviews of the window.
pub fn facts(window: Handle) -> Result<Value, String> {
    extern "C" {
        fn sp_window_facts(window: *mut c_void) -> *mut c_char;
    }
    facts_value(
        unsafe { sp_window_facts(window as *mut c_void) },
        "window state",
    )
}

/// Moves the upper left of the window frame to screen coordinates.
pub fn move_to(window: Handle, x: f64, y: f64) -> Result<(), String> {
    extern "C" {
        fn sp_window_move(window: *mut c_void, x: f64, y: f64) -> bool;
    }
    if unsafe { sp_window_move(window as *mut c_void, x, y) } {
        Ok(())
    } else {
        Err("window placement: the window is gone".into())
    }
}

/// The display list.
pub fn screens() -> Result<Value, String> {
    extern "C" {
        fn sp_screens() -> *mut c_char;
    }
    facts_value(unsafe { sp_screens() }, "display list")
}

/// Makes the window zoom and the animated size change finish within one screen update.
pub fn instant_resize() {
    extern "C" {
        fn windowResizeInstant();
    }
    unsafe { windowResizeInstant() }
}
