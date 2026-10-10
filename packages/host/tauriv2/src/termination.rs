//! Termination requests of the operating system.

use crate::platform;

/// Makes the first termination request of the operating system call quit once. The termination requests after it end
/// the process with the default action of the operating system.
pub fn on_termination(quit: Box<dyn Fn() + Send>) -> Result<(), String> {
    platform::current()?.on_termination(quit)
}
