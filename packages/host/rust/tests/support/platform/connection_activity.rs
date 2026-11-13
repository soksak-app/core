//! The connection activity of the host that an integration test reads: the implementation of the operating system.

#[cfg(target_os = "macos")]
#[path = "darwin/connection_activity.rs"]
mod implementation;

#[cfg(windows)]
#[path = "windows/connection_activity.rs"]
mod implementation;

pub use implementation::*;
