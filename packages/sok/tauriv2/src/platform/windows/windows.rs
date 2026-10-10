//! Command line behavior on Windows. A behavior that is not implemented yet returns the error "<operation> is not implemented on windows".

#[path = "unsupported.rs"]
mod unsupported;

/// The Windows implementation.
pub struct Windows;
