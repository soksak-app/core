//! The record of the native ring through the native library.

use std::ffi::{CStr, c_char};

unsafe extern "C" {
    fn sp_event(class: u8, level: u8, name: *const c_char, fields_json: *const c_char) -> bool;
}

/// Records the event name with no fields, and tells whether the ring took it.
pub fn record(name: &CStr) -> bool {
    unsafe { sp_event(0, 0, name.as_ptr(), c"{}".as_ptr()) }
}
