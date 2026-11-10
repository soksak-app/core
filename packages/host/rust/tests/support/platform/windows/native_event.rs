//! The record of the native ring on Windows, which has no native ring.

use std::ffi::CStr;

/// Fails the test: the native ring is not supported on Windows.
pub fn record(_name: &CStr) -> bool {
    panic!("the native ring is not supported on Windows")
}

/// Fails the test: the native ring is not supported on Windows.
pub fn wake_is_ready() -> bool {
    panic!("the native ring is not supported on Windows")
}
