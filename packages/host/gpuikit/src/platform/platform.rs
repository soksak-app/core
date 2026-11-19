//! The platform functions of the GPUI framework adapter. The macOS implementation reaches AppKit and the wry web
//! views; another operating system has no implementation yet.

#[cfg(target_os = "macos")]
#[path = "darwin/darwin.rs"]
#[cfg(feature = "test-seam")]
pub mod darwin;
#[path = "darwin/darwin.rs"]
#[cfg(not(feature = "test-seam"))]
mod darwin;

#[cfg(target_os = "macos")]
pub(crate) use darwin::*;
