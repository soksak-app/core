//! The endpoint client of the integration tests: the implementation of the operating system.

#[cfg(target_os = "macos")]
#[path = "darwin/endpoint_client.rs"]
mod implementation;

#[cfg(windows)]
#[path = "windows/unsupported.rs"]
mod implementation;

pub use implementation::*;

/// The operating system key of the sidecar folders of the installation (docs/spec/installation.md).
#[cfg(target_os = "macos")]
pub const SIDECAR_OS: &str = "darwin";
#[cfg(not(target_os = "macos"))]
pub const SIDECAR_OS: &str = "linux";
