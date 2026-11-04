//! Checks that a poisoned lock of the policy watch hook is recovered and the declared hook is still called.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use super::{HOOK, observe, set_log_policy_watch_hook};

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
fn a_poisoned_hook_lock_still_declares_and_calls_the_policy_watch_hook() {
    poison(&HOOK);
    let called = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let calls = Arc::clone(&called);
    set_log_policy_watch_hook(Some(Box::new(move |watched: &[PathBuf]| {
        calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend(watched.iter().cloned())
    })));
    observe(&[PathBuf::from("/lock-test")]);
    set_log_policy_watch_hook(None);
    assert_eq!(
        *called.lock().unwrap_or_else(PoisonError::into_inner),
        [Path::new("/lock-test")],
        "the hook was not called while its lock was poisoned"
    );
}
