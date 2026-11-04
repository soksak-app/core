//! The endpoint client of the integration tests: the implementation of the operating system.

#[cfg(target_os = "macos")]
#[path = "darwin/endpoint_client.rs"]
mod implementation;

#[cfg(windows)]
#[path = "windows/unsupported.rs"]
mod implementation;

pub use implementation::*;
