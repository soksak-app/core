//! The action of a person of a diagnostic build, implemented by sp_input_person in native/darwin.
use std::ffi::{CStr, CString, c_char, c_void};

use super::super::Handle;

unsafe extern "C" {
    fn sp_input_person(
        window: *mut c_void,
        action: *const c_char,
        x: f64,
        y: f64,
        error: *mut *mut c_char,
    ) -> bool;
    fn free(pointer: *mut c_void);
}

/// Dispatches in window the event that the window server gives the application for a press, a move or a scroll of a person at
/// x, y in the content (docs/spec/endpoint.md). Call it on the main thread.
pub fn dispatch(window: Handle, action: &str, x: f64, y: f64) -> Result<(), String> {
    let action =
        CString::new(action).map_err(|_| "action must be press, move or scroll".to_string())?;
    let mut error: *mut c_char = std::ptr::null_mut();
    let done = unsafe { sp_input_person(window as *mut c_void, action.as_ptr(), x, y, &mut error) };
    if !error.is_null() {
        let message = unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned();
        unsafe { free(error as *mut c_void) };
        return Err(message);
    }
    if !done {
        return Err("the action of a person failed without a native reason".into());
    }
    Ok(())
}
