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
}
