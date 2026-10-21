//! Checks that a poisoned lock of the log notices is recovered and the notices are still published.

use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use soksak_sok::log_index::IndexUpdate;

use super::{CURRENT, LogNotices, announce_index_update, use_log_notices};

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
fn a_poisoned_notice_lock_still_publishes_the_notice_and_stops() {
    let (sent, received) = channel();
    let notices = Arc::new(LogNotices::start(Duration::ZERO, move |notice| {
        sent.send(notice).expect("the test receives every notice");
    }));
    poison(&notices.shared.0);
    poison(&notices.worker);
    poison(&CURRENT);
    use_log_notices(Some(Arc::clone(&notices)));
    announce_index_update(&IndexUpdate {
        file: "logs/a.jsonl".to_string(),
        announcing: 1,
        size: 3,
        ..IndexUpdate::default()
    });
    let notice = received
        .recv_timeout(Duration::from_secs(10))
        .expect("no notice was published while the notice lock was poisoned");
    assert_eq!(
        (notice.path.as_str(), notice.size),
        ("logs/a.jsonl", 3),
        "the published notice lost the announced file"
    );
    assert_eq!(
        notices.value().path,
        "logs/a.jsonl",
        "the latest notice was not read while the notice lock was poisoned"
    );
    use_log_notices(None);
    notices.stop();
    assert!(
        notices
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none(),
        "the stop did not end the thread while the worker lock was poisoned"
    );
}
