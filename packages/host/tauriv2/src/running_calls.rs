//! The host calls of each window that have not returned. A reload of a page waits until every call that the page sent has its
//! reply (docs/spec/native-host.md#page-reload), so a reload that times out names the calls of its window that still run.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// One call that has not returned: its window, its name and its start.
struct Running {
    window: String,
    name: String,
    started: Instant,
}

/// The identifier of the last call and the running calls by their identifier.
#[derive(Default)]
struct Calls {
    last: u64,
    running: HashMap<u64, Running>,
}

/// The running calls of every window.
#[derive(Default)]
pub struct RunningCalls {
    calls: Mutex<Calls>,
}

impl RunningCalls {
    fn lock(&self) -> MutexGuard<'_, Calls> {
        self.calls
            .lock()
            // default: a panic while the lock was held leaves the calls it held, which are still the state to read.
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Records that the call `name` of `window` started at `at`, and returns the identifier that [`RunningCalls::end`] takes.
    pub fn begin(&self, window: &str, name: &str, at: Instant) -> u64 {
        let mut calls = self.lock();
        calls.last += 1;
        let id = calls.last;
        calls.running.insert(
            id,
            Running {
                window: window.to_string(),
                name: name.to_string(),
                started: at,
            },
        );
        id
    }

    /// Records that the call returned.
    pub fn end(&self, id: u64) {
        self.lock().running.remove(&id);
    }

    /// Names the running calls of `window` in the order of their start, each with the seconds it has run at `now`, or `none`.
    pub fn of(&self, window: &str, now: Instant) -> String {
        let mut running: Vec<(String, Instant)> = self
            .lock()
            .running
            .values()
            .filter(|call| call.window == window)
            .map(|call| (call.name.clone(), call.started))
            .collect();
        if running.is_empty() {
            return "none".into();
        }
        running.sort_by_key(|(_, started)| *started);
        running
            .iter()
            .map(|(name, started)| {
                format!("{name} {:.1}s", now.duration_since(*started).as_secs_f64())
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// The error of a reload whose page did not report ready within `timeout`, with the running calls of its window.
pub fn reload_timeout_text(timeout: Duration, running: &str) -> String {
    format!(
        "the reloaded page did not report ready within {timeout:?}; running host calls: {running}"
    )
}

/// The host calls of every window of the process.
pub static RUNNING_CALLS: std::sync::LazyLock<RunningCalls> =
    std::sync::LazyLock::new(RunningCalls::default);
