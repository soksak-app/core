//! The selection of the Tauri functions of the current operating system that the framework adapter uses.
//!
//! Operating-system-specific code is placed only in `<os>/` under this directory. The other files of the adapter call
//! these functions through this module.

#[cfg(target_os = "macos")]
#[path = "darwin/darwin.rs"]
mod darwin;

#[cfg(windows)]
#[path = "windows/windows.rs"]
mod windows;

#[cfg(target_os = "macos")]
pub(crate) use darwin::{launch_activation, ns_window, platform_webview, prepare_window};

#[cfg(windows)]
pub(crate) use windows::{launch_activation, ns_window, platform_webview, prepare_window};
