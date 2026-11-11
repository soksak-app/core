//! The drive of a window by a check is implemented by sp_input_check_begin and sp_input_check_end in native/darwin.

use super::super::Handle;
use std::ffi::c_void;

unsafe extern "C" {
    fn sp_input_check_begin(window: *mut c_void) -> bool;
    fn sp_input_check_end(window: *mut c_void) -> u64;
}

/// Starts the drive of the window by a check: until `end` the window takes only the pointer input of the check
/// (diagnostics.drag, docs/spec/endpoint.md#diagnostic-builds). Call it on the main thread.
pub fn begin(window: Handle) -> Result<(), String> {
    if unsafe { sp_input_check_begin(window as *mut c_void) } {
        Ok(())
    } else {
        Err("a check already drives the window".into())
    }
}

/// Ends the drive of the window and returns the number of pointer events of a person that the window did not take. Call it on
/// the main thread.
pub fn end(window: Handle) -> u64 {
    unsafe { sp_input_check_end(window as *mut c_void) }
}
