//! Checks that a poisoned state lock of the deep link queue is recovered and the queue still holds and runs the links.

use std::cell::RefCell;
use std::sync::Mutex;

use super::DeepLinkQueue;

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
fn a_poisoned_queue_lock_still_holds_and_runs_the_links_in_order() {
    let queue = DeepLinkQueue::new();
    poison(&queue.state);
    let ran = RefCell::new(Vec::new());
    let run = |value: &str| ran.borrow_mut().push(value.to_string());
    queue.keep("soksak://first".to_string(), &run);
    assert!(
        ran.borrow().is_empty(),
        "a link ran before the queue was ready"
    );
    queue.ready(&run);
    queue.keep("soksak://second".to_string(), &run);
    assert_eq!(
        *ran.borrow(),
        ["soksak://first", "soksak://second"],
        "the links did not run in arrival order while the queue lock was poisoned"
    );
}
