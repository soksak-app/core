//! The record of the native ring through the native library.
#![allow(dead_code)]

use std::ffi::{CStr, CString, c_char};

unsafe extern "C" {
    fn sp_event(class: u8, level: u8, name: *const c_char, fields_json: *const c_char) -> bool;
    fn sp_event_wake_fd() -> std::ffi::c_int;
}

/// Records the event name with no fields, and tells whether the ring took it.
pub fn record(name: &CStr) -> bool {
    unsafe { sp_event(0, 0, name.as_ptr(), c"{}".as_ptr()) }
}

/// Records the event name of the class and the level (the numbers of the native library) with the fields (JSON text), and tells
/// whether the ring took it. A full ring or a level that the policy does not store refuses it.
pub fn record_with_fields(class: u8, level: u8, name: &str, fields: &str) -> bool {
    let name = CString::new(name).expect("the name holds a NUL character");
    let fields = CString::new(fields).expect("the fields hold a NUL character");
    unsafe { sp_event(class, level, name.as_ptr(), fields.as_ptr()) }
}

/// Tells, without waiting, whether the pipe of the wake of the native ring is readable now: the wait of the platform ends exactly
/// when it is.
pub fn wake_is_ready() -> bool {
    let mut reader = libc::pollfd {
        fd: unsafe { sp_event_wake_fd() },
        events: libc::POLLIN,
        revents: 0,
    };
    let ready = unsafe { libc::poll(&mut reader, 1, 0) };
    assert!(
        ready >= 0,
        "the poll of the wake failed: {}",
        std::io::Error::last_os_error()
    );
    ready > 0
}
