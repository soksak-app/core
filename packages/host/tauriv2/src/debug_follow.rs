//! The notice of a change of the event log (docs/spec/debug.md#following): the debug view follows the event files with the host event
//! `debug-log-changed`, and an endpoint client watches the host status `host.log`. The host publishes the notice after the index of a file
//! covers the lines that announce a change.

use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use soksak_sok::log_index::IndexUpdate;

/// The least time between two published notices. The writer announces a change at any rate, so the publication has a bound; no event
/// source can space the notices, hence the wait (docs/spec/debug.md#following).
pub const LOG_NOTICE_INTERVAL: Duration = Duration::from_millis(250);

/// The value of the host status `host.log` and the body of the host event `debug-log-changed`: the file and the size of the latest
/// announcement, the number of notices published since the start, and the number of announcements that were folded into a later notice
/// instead of a notice of their own.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LogNotice {
    pub path: String,
    pub size: i64,
    pub notices: i64,
    pub coalesced: i64,
}

struct State {
    path: String,
    size: i64,
    announced: i64,
    pending: bool,
    value: LogNotice,
    stopped: bool,
}

/// Publishes the announcements of changes of the event log with a bound on their rate. `observe` returns at once, so the writer, the
/// indexer and a query never wait for a window; the announcements that arrive while a notice is published or while the interval runs
/// out become one notice with the latest path and size.
pub struct LogNotices {
    shared: Arc<(Mutex<State>, Condvar)>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl LogNotices {
    /// Starts the thread that publishes the notices: it calls `emit` with each notice and then waits for `interval` before the next one.
    pub fn start(interval: Duration, emit: impl Fn(LogNotice) + Send + 'static) -> LogNotices {
        let shared = Arc::new((
            Mutex::new(State {
                path: String::new(),
                size: 0,
                announced: 0,
                pending: false,
                value: LogNotice::default(),
                stopped: false,
            }),
            Condvar::new(),
        ));
        let worker_shared = Arc::clone(&shared);
        let worker = std::thread::Builder::new()
            .name("debug-log-notices".into())
            .spawn(move || {
                loop {
                    let notice = {
                        let (lock, wake) = &*worker_shared;
                        // default: a lock that a panicking thread poisoned still holds the latest notice, which the
                        // thread reads and amends; the panic hook records the panic.
                        let mut state = lock.lock().unwrap_or_else(PoisonError::into_inner);
                        while !state.pending && !state.stopped {
                            // default: a wait that a poisoned lock ends still returns the guard of the latest notice,
                            // which the thread reads; the panic hook records the panic.
                            state = wake.wait(state).unwrap_or_else(PoisonError::into_inner);
                        }
                        if state.stopped {
                            return;
                        }
                        state.pending = false;
                        let notices = state.value.notices + 1;
                        state.value = LogNotice {
                            path: state.path.clone(),
                            size: state.size,
                            notices,
                            coalesced: state.announced - notices,
                        };
                        state.value.clone()
                    };
                    emit(notice);
                    let (lock, wake) = &*worker_shared;
                    let deadline = Instant::now() + interval;
                    // default: a lock that a panicking thread poisoned still holds the latest notice, which the thread
                    // reads; the panic hook records the panic.
                    let mut state = lock.lock().unwrap_or_else(PoisonError::into_inner);
                    while !state.stopped {
                        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                            break;
                        };
                        state = wake
                            .wait_timeout(state, left)
                            // default: a wait that a poisoned lock ends still returns the guard of the latest notice,
                            // which the thread reads; the panic hook records the panic.
                            .unwrap_or_else(PoisonError::into_inner)
                            .0;
                    }
                    if state.stopped {
                        return;
                    }
                }
            })
            .expect("the thread of the log notices");
        LogNotices {
            shared,
            worker: Mutex::new(Some(worker)),
        }
    }

    /// Announces a change of the file at `path` (`logs/<name>`) that has `size` bytes.
    pub fn observe(&self, path: &str, size: i64) {
        let (lock, wake) = &*self.shared;
        // default: a lock that a panicking thread poisoned still holds the latest notice, which the announcement
        // amends; the panic hook records the panic.
        let mut state = lock.lock().unwrap_or_else(PoisonError::into_inner);
        state.path = path.to_string();
        state.size = size;
        state.pending = true;
        state.announced += 1;
        wake.notify_all();
    }

    /// Announces the change that an update of an index found, when one of its lines announces a change.
    pub fn observe_update(&self, update: &IndexUpdate) {
        if update.announcing > 0 {
            self.observe(&update.file, update.size);
        }
    }

    /// The latest published notice, or the zero notice before the first one.
    pub fn value(&self) -> LogNotice {
        self.shared
            .0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the latest notice, which is only read; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .value
            .clone()
    }

    /// Ends the thread and waits until it returned.
    pub fn stop(&self) {
        let (lock, wake) = &*self.shared;
        // default: a lock that a panicking thread poisoned still holds the latest notice, which the stop amends; the
        // panic hook records the panic.
        lock.lock().unwrap_or_else(PoisonError::into_inner).stopped = true;
        wake.notify_all();
        if let Some(worker) = self
            .worker
            .lock()
            // default: a lock that a panicking thread poisoned still holds the thread of the notices, which the stop
            // takes; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .take()
            && worker.join().is_err()
        {
            eprintln!("debug log notices: the thread ended with a panic");
        }
    }
}

/// Receives the announcements of every update of an index, also the updates that a query makes.
static CURRENT: Mutex<Option<Arc<LogNotices>>> = Mutex::new(None);

/// Sets the publisher that receives the announcements of the updates of the indexes; `None` removes it. An update that a query makes
/// announces its lines too: the lines of a file that no writer of this host wrote (a file of a sidecar) and the lines that a query indexed
/// before the indexer did would otherwise never be announced.
pub fn use_log_notices(notices: Option<Arc<LogNotices>>) {
    // default: a lock that a panicking thread poisoned still holds the publisher of the notices, which the call
    // replaces; the panic hook records the panic.
    *CURRENT.lock().unwrap_or_else(PoisonError::into_inner) = notices;
}

/// Passes the update of an index to the publisher of the notices.
pub fn announce_index_update(update: &IndexUpdate) {
    let current = CURRENT
        .lock()
        // default: a lock that a panicking thread poisoned still holds the publisher of the notices, which is only
        // read; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    if let Some(notices) = current {
        notices.observe_update(update);
    }
}

#[cfg(test)]
#[path = "debug_follow_lock_test.rs"]
mod lock_test;
