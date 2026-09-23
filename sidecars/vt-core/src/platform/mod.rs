pub mod darwin;
pub mod platform;
pub mod pty;

pub use platform::{default_font, metrics, metrics_for, resolve_font_list, FontSelection, TerminalFont};
pub use platform::service;
pub use platform::ImageState;

// Frame and metrics are platform-specific and exported conditionally by platform.rs
// Protocol module uses ImageState which handles platform differences
