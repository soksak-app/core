//! The notice of a write of the event log (docs/spec/debug.md#following): the debug view follows the event file of the host
//! with the host event `debug-log-changed`, which the host announces after the writer wrote.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

struct Latest {
    notice: Option<(PathBuf, u64)>,
    stopped: bool,
}

/// The observer of the writes that the writer calls, and the function that stops the thread behind it.
pub type LogNotices = (
    Box<dyn Fn(&Path, u64) + Send + Sync>,
    Box<dyn FnOnce() + Send>,
);

/// Wraps `emit` for the observer of the writes of the event log. The observer returns at once, so the writer never waits for a
/// window; the notices that arrive while `emit` runs become one notice with the latest path and size. The returned function
/// stops the thread that calls `emit` and waits until it returned.
pub fn coalesce_log_notices(emit: impl Fn(&Path, u64) + Send + 'static) -> LogNotices {
    let shared = Arc::new((
        Mutex::new(Latest {
            notice: None,
            stopped: false,
        }),
        Condvar::new(),
    ));
    let worker_shared = Arc::clone(&shared);
    let worker = std::thread::Builder::new()
        .name("debug-log-notices".into())
        .spawn(move || loop {
            let notice = {
                let (lock, wake) = &*worker_shared;
                let mut latest = lock.lock().expect("the latest notice");
                while latest.notice.is_none() && !latest.stopped {
                    latest = wake.wait(latest).expect("the latest notice");
                }
                if latest.stopped {
                    return;
                }
                latest.notice.take()
            };
            if let Some((path, size)) = notice {
                emit(&path, size);
            }
        })
        .expect("the thread of the log notices");
    let observer_shared = Arc::clone(&shared);
    let observe = Box::new(move |path: &Path, size: u64| {
        let (lock, wake) = &*observer_shared;
        lock.lock().expect("the latest notice").notice = Some((path.to_path_buf(), size));
        wake.notify_one();
    });
    let stop = Box::new(move || {
        let (lock, wake) = &*shared;
        lock.lock().expect("the latest notice").stopped = true;
        wake.notify_one();
        if worker.join().is_err() {
            eprintln!("debug log notices: the thread ended with a panic");
        }
    });
    (observe, stop)
}
