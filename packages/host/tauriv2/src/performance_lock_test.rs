//! Checks that a poisoned switch lock of the performance trace is recovered and the switch still answers.

use std::sync::{Mutex, PoisonError};

use serde_json::json;

use super::command;

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

#[test]
fn the_trace_switch_answers_when_the_switch_lock_is_poisoned() {
    poison(&super::SWITCHING);
    let answer = command(json!({"action": "off"}));
    assert!(
        answer.is_ok(),
        "the switch refused the request while the switch lock was poisoned"
    );
}
