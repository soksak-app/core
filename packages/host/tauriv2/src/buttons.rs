//! The value of host.buttons.
//!
//! Stores the mask of the pressed mouse buttons that the button source (Platform::watch_buttons) reported, and
//! announces the new value when the mask changes. input.pointer rejects a press and a release with 1007 while this mask
//! is not 0, so the open press of a rejected release can be ended after this value becomes 0
//! (docs/spec/exposure.md#host-entries).

use std::sync::Mutex;

use serde_json::{json, Value};

use crate::application_log::log_error;

pub struct Buttons {
    mask: Mutex<u64>,
    changed: Box<dyn Fn(Value) + Send + Sync>,
}

impl Buttons {
    /// Creates host.buttons with mask 0. changed is called once for each changed value, in the order of the reports.
    pub fn new(changed: impl Fn(Value) + Send + Sync + 'static) -> Self {
        Buttons {
            mask: Mutex::new(0),
            changed: Box::new(changed),
        }
    }

    /// Records the mask that the source read. A value that differs from the recorded value is announced as the new
    /// value. The announcement is made inside the lock so that the order of the announcements equals the order of the
    /// reports. changed must not block.
    pub fn report(&self, mask: u64) {
        let Ok(mut current) = self.mask.lock() else {
            log_error("host.buttons", "the button state is poisoned");
            return;
        };
        if *current == mask {
            return;
        }
        *current = mask;
        (self.changed)(value(mask));
    }

    /// The current value {mask} of host.buttons.
    pub fn value(&self) -> Value {
        match self.mask.lock() {
            Ok(mask) => value(*mask),
            Err(poisoned) => value(*poisoned.into_inner()),
        }
    }
}

fn value(mask: u64) -> Value {
    json!({ "mask": mask })
}
