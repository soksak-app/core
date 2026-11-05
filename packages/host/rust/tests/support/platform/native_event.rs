//! The record of the native ring that an integration test makes: the implementation of the operating system.

#[cfg(target_os = "macos")]
#[path = "darwin/native_event.rs"]
mod implementation;

#[cfg(windows)]
#[path = "windows/native_event.rs"]
mod implementation;

pub use implementation::*;
