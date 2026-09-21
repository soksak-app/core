pub mod platform;
pub mod darwin;
pub mod pty;

pub use platform::get_daemon_finder;
pub use platform::ImageState;
pub use platform::metrics;
pub use darwin::DarwinDaemonFinder;

// Frame and metrics are platform-specific and exported conditionally by platform.rs
// Protocol module uses ImageState which handles platform differences
