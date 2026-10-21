//! Checks that a poisoned lock of the held modal content replies is recovered and a reply is still held and released.

use std::sync::{Mutex, PoisonError};

use super::{MODAL_HOLDS, hold_modal_content, modal_hold, modal_hold_of};

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
fn a_poisoned_hold_lock_still_holds_and_releases_the_modal_reply() {
    poison(&MODAL_HOLDS);
    modal_hold("lock-test", true);
    let hold = modal_hold_of("lock-test")
        .expect("the hold was not registered while the hold lock was poisoned");
    poison(&hold.state);
    let held = std::thread::spawn(|| hold_modal_content("lock-test"));
    {
        let mut state = hold.state.lock().unwrap_or_else(PoisonError::into_inner);
        while state.1 == 0 {
            state = hold
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
    modal_hold("lock-test", false);
    held.join()
        .expect("the held reply panicked while the hold lock was poisoned");
    assert!(
        modal_hold_of("lock-test").is_none(),
        "the release kept the hold while the hold lock was poisoned"
    );
}
