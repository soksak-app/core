//! Checks that a poisoned lock of the write observer is recovered, so the observer is still set and called.

use std::path::Path;
use std::sync::Mutex;
use std::sync::mpsc::channel;
use std::time::Duration;

use serde_json::json;

use super::{EventLog, Level, Options};

#[path = "../tests/support/folder.rs"]
mod folder;

use folder::Folder;

/// Poisons the lock by panicking while its guard is held.
fn poison<T>(lock: &Mutex<T>) {
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = lock.lock().unwrap();
            panic!("the test poisons the lock");
        }))
        .is_err(),
        "the closure must panic"
    );
    assert!(lock.is_poisoned(), "the lock was not poisoned");
}

fn options(directory: &Path) -> Options {
    Options {
        directory: directory.to_path_buf(),
        role: "probe".into(),
        boot: "lock".into(),
        layer: "sok",
        clock: || 42,
        spawn: |body| {
            std::thread::Builder::new()
                .name("probe-writer".into())
                .spawn(body)
                .map_err(|error| error.to_string())
        },
        queue_events: 64,
        queue_bytes: 1 << 20,
        batch_interval: Duration::from_millis(10),
        rotate_bytes: 0,
        pull: None,
        policy_path: None,
        prune: None,
    }
}

// contract: cli.log.writer.poisoned-observer-lock-is-recovered
#[test]
fn a_poisoned_observer_lock_still_sets_and_calls_the_write_observer() {
    let directory = Folder::new("event-log-lock");
    let log = EventLog::start(options(directory.path())).unwrap();
    poison(&log.on_write);
    let (sent, written) = channel();
    log.set_on_write(Box::new(move |path, size| {
        sent.send((path.to_path_buf(), size))
            .expect("the test receives every write");
    }));
    assert!(
        log.emit(Level::Info, "sok.probe.event", &json!({"n": 1})),
        "the event was refused"
    );
    log.flush(Duration::from_secs(5)).unwrap();
    let (path, size) = written
        .recv_timeout(Duration::from_secs(10))
        .expect("the observer was not called while its lock was poisoned");
    assert_eq!(path, log.path(), "the observer received another file");
    assert!(size > 0, "the observer received an empty file");
}
