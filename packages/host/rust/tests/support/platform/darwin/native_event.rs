//! The record of the native ring through the native library.

use std::ffi::{CStr, c_char};

unsafe extern "C" {
    fn sp_event(class: u8, level: u8, name: *const c_char, fields_json: *const c_char) -> bool;
    fn sp_event_wake_fd() -> std::ffi::c_int;
}

/// Records the event name with no fields, and tells whether the ring took it.
pub fn record(name: &CStr) -> bool {
    unsafe { sp_event(0, 0, name.as_ptr(), c"{}".as_ptr()) }
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
