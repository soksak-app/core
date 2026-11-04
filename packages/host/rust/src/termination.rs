//! Termination requests of the operating system.

use std::sync::Arc;

use crate::platform;
use crate::quit::Quit;

/// Makes the first termination request of the operating system call quit once, after it begins the quit state. The termination
/// requests after it end the process with the default action of the operating system.
pub fn on_termination(state: Arc<Quit>, quit: Box<dyn Fn() + Send>) -> Result<(), String> {
    platform::current()?.on_termination(Box::new(move || {
        // The quit that the signal requests is the quit of host.quit, so the quit state begins before quit runs; the end of a page
        // process during that quit is not an error (docs/spec/hosts.md#process-lifecycle).
        state.request(&quit);
    }))
}
