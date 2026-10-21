//! Checks that a poisoned lock of the pending paths is recovered and the indexer still updates and stops.

use std::collections::BTreeSet;
use std::sync::mpsc::channel;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::{Pending, start_log_indexer_on};

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

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_pending_lock_still_updates_the_index_and_stops() {
    let folder = crate::test_folder::Folder::new();
    let path = folder.path().join("host-b1.jsonl");
    std::fs::write(&path, "").unwrap();
    let shared = Arc::new((
        Mutex::new(Pending {
            paths: BTreeSet::new(),
            stopped: false,
        }),
        Condvar::new(),
    ));
    poison(&shared.0);
    let (results, updates) = channel();
    let (observe, stop) = start_log_indexer_on(Arc::clone(&shared), move |path, result| {
        results
            .send((path.to_path_buf(), result.is_ok()))
            .expect("the test receives every update");
    });
    observe(&path, 0);
    let update = updates
        .recv_timeout(Duration::from_secs(10))
        .expect("no update of the index followed the notice while the pending lock was poisoned");
    assert_eq!(
        update,
        (path, true),
        "the update of the noticed file failed"
    );
    stop();
    assert!(
        shared
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stopped,
        "the stop was not recorded while the pending lock was poisoned"
    );
}
