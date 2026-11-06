//! Checks that a poisoned switch lock of the performance trace is recovered and the switch still answers, and that the
//! poisoned locks of the sampler and its registries are recovered.

use std::sync::{Arc, Mutex, PoisonError};

use serde_json::json;

use super::{
    PROCESSES, SAMPLER, WINDOWS, WindowProcesses, command, end_sampler, process_add,
    process_remove, sample, sampler_running, start_sampler, window_add, window_remove,
};

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

/// The switch belongs to the process, so a test that switches the trace without holding `test_switch` changes what another test
/// stores. Such a test fails on its first call, on every run.
// contract: verification.trace-switch.requires-the-test-switch
#[test]
fn a_test_that_switches_the_trace_without_holding_the_switch_fails_at_once() {
    let unheld = std::thread::spawn(|| command(json!({"action": "off"}))).join();
    assert!(
        unheld.is_err(),
        "a thread that does not hold the test switch switched the trace"
    );
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn the_trace_switch_answers_when_the_switch_lock_is_poisoned() {
    let _switch = crate::performance::test_switch();
    poison(&super::SWITCHING);
    let answer = command(json!({"action": "off"}));
    assert!(
        answer.is_ok(),
        "the switch refused the request while the switch lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn the_sampler_and_its_registries_answer_when_their_locks_are_poisoned() {
    let _switch = crate::performance::test_switch();
    poison(&PROCESSES);
    poison(&WINDOWS);
    poison(&SAMPLER);
    let pid = 4_000_001;
    process_add("sidecar", "lock-test", pid);
    assert!(
        PROCESSES
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(&pid),
        "the process was not named while the process registry lock was poisoned"
    );
    process_remove(pid);
    assert!(
        !PROCESSES
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(&pid),
        "the process was not removed while the process registry lock was poisoned"
    );
    window_add(
        "lock-test",
        Arc::new(|| {
            Ok(WindowProcesses {
                page: 0,
                documents: Vec::new(),
            })
        }),
    );
    sample();
    window_remove("lock-test");
    assert!(
        !WINDOWS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key("lock-test"),
        "the window was not removed while the window registry lock was poisoned"
    );
    start_sampler();
    assert!(
        sampler_running(),
        "the sampler did not start while the sampler lock was poisoned"
    );
    end_sampler();
    assert!(
        !sampler_running(),
        "the sampler did not end while the sampler lock was poisoned"
    );
}
