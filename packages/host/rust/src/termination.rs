//! Termination requests of the operating system.

use std::sync::Arc;

use crate::platform;
use crate::quit::Quit;

/// Makes the first termination request of the operating system call quit once, after it begins the quit state. The termination
/// requests after it end the process with the default action of the operating system.
pub fn on_termination(state: Arc<Quit>, quit: Box<dyn Fn() + Send>) -> Result<(), String> {
    platform::current()?.on_termination(Box::new(move |signal, sender_pid| {
        crate::event_record::quit_from_signal(&state, signal, sender_pid, &quit);
    }))
}
