//! Checks that a poisoned lock of the removal requests is recovered, so that a request is still registered and answered.

use std::sync::Mutex;

use super::Removals;

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

// A panic while the requests are held poisons the lock; the next request is still registered and answered.
#[test]
fn a_poisoned_request_lock_still_registers_and_answers_a_request() {
    let removals = Removals::default();
    poison(&removals.pending);
    let asked = removals.begin("prj-one", "project-one");
    assert!(
        asked.is_ok(),
        "a poisoned lock refused the request: {asked:?}"
    );
    let answered = removals.answer("prj-one", true);
    assert!(
        answered.is_ok(),
        "a poisoned lock refused the answer: {answered:?}"
    );
    assert_eq!(asked.unwrap().try_recv(), Ok(true));
}

// The end of a window answers its asked request when the lock of the requests is poisoned.
#[test]
fn a_poisoned_request_lock_is_recovered_when_the_asked_window_ends() {
    let removals = Removals::default();
    let asked = removals.begin("prj-two", "project-two").unwrap();
    poison(&removals.pending);
    removals.abandon("project-two");
    assert_eq!(
        asked.try_recv(),
        Ok(true),
        "the end of the asked window did not allow the removal"
    );
}
