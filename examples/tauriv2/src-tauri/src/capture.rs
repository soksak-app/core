//! What the capture written in Objective-C offers, and a stub where it is not.
//!
//! Only macOS is written. Windows has Windows.Graphics.Capture and Linux the
//! PipeWire portal in this place.

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_int, CString};

    extern "C" {
        fn sp_capture_open(window_number: isize);
        fn sp_capture_start(directory: *const c_char);
        fn sp_capture_stop() -> c_int;
    }

    pub fn open(window_number: isize) {
        unsafe { sp_capture_open(window_number) }
    }

    pub fn start(directory: &str) {
        let Ok(where_to) = CString::new(directory) else { return };
        unsafe { sp_capture_start(where_to.as_ptr()) }
    }

    pub fn stop() -> i32 {
        unsafe { sp_capture_stop() }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn open(_window_number: isize) {}
    pub fn start(_directory: &str) {}
    pub fn stop() -> i32 {
        0
    }
}

pub use platform::{open, start, stop};
