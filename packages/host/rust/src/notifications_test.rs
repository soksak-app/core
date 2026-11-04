//! Checks that a poisoned lock of the permission state is recovered, so that the page reads the state.

use std::sync::Mutex;

use super::{NotificationState, STATE};

/// Poisons the lock by a thread that panics while it holds the lock.
fn poison<T: Send>(lock: &Mutex<T>) {
    std::thread::scope(|scope| {
        let panicking = scope.spawn(|| {
            let _held = lock.lock().unwrap();
            panic!("the thread panics while it holds the lock");
        });
        assert!(panicking.join().is_err(), "the thread must panic");
    });
}

// contract: host.locks.poisoned-state-is-recovered
// A panic while the permission state is held poisons the lock; the page still reads the state when it starts.
// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_permission_state_is_read_by_the_page() {
    poison(&STATE);
    let read: Result<NotificationState, String> = super::state();
    assert!(
        read.is_ok(),
        "a poisoned lock refused the state read: {:?}",
        read.as_ref().err()
    );
    let read = read.unwrap();
    assert!(
        read.error.is_none(),
        "the read state has an error: {:?}",
        read.error
    );
}
