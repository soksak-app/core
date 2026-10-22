//! Whether the application is quitting. The quit begins when the host asks the ready windows to close and ends when the
//! page of a window keeps a modified tab (docs/spec/plugins.md#tab-reports); each change is idempotent.

use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub struct Quit {
    active: AtomicBool,
}

impl Quit {
    /// Marks the application as quitting.
    pub fn begin(&self) {
        self.active.store(true, Ordering::Relaxed);
    }

    /// Marks the application as not quitting.
    pub fn cancel(&self) {
        self.active.store(false, Ordering::Relaxed);
    }

    /// Whether the application is quitting.
    pub fn active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    /// Runs quit, which asks the application to end, for a quit request. Every quit request begins the quit state, with or without a
    /// ready window (docs/spec/hosts.md#process-lifecycle).
    pub fn request(&self, quit: impl FnOnce()) {
        self.begin();
        quit();
    }

    /// Begins the quit state for an operating system quit request and reports whether the application quits at once, which it does
    /// when no ready window exists. ready is the number of ready windows that the request asks to close. Every quit request begins
    /// the state, with or without a ready window (docs/spec/hosts.md#process-lifecycle).
    pub fn begin_quit_request(&self, ready: usize) -> bool {
        self.begin();
        ready == 0
    }
}
