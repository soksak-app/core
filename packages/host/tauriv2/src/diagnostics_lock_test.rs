//! Checks that a poisoned lock of the held modal content replies is recovered and a reply is still held and released.

use std::sync::{Arc, mpsc};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use super::{
    MODAL_HOLDS, hold_modal_content, lifecycle_lock, modal_hold, modal_hold_of,
    pending_document_frame_identity_start, pending_frame_identity_lock,
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

// contract: diagnostics.capture.poisoned-lifecycle-lock-is-reported
#[test]
fn a_poisoned_lifecycle_lock_is_reported_before_the_operation_runs() {
    let lock = Mutex::new(());
    poison(&lock);
    assert_eq!(
        lifecycle_lock(&lock).err().as_deref(),
        Some("document frame identity lifecycle was interrupted by a panic")
    );
}

// contract: diagnostics.capture.poisoned-pending-lock-is-reported
#[test]
fn a_poisoned_pending_lock_is_reported_without_consuming_the_receiver() {
    let (_sender, receiver) = std::sync::mpsc::channel();
    let lock = Mutex::new(Some(receiver));
    poison(&lock);
    assert_eq!(
        pending_frame_identity_lock(&lock).err().as_deref(),
        Some("pending document frame identity start was interrupted by a panic")
    );
}

// contract: diagnostics.capture.pending-start-releases-lock-before-receive
#[test]
fn a_pending_start_releases_its_lock_before_receiving() {
    let (sender, receiver) = mpsc::channel();
    sender.send(Ok("started".to_string())).unwrap();
    let lock = Arc::new(Mutex::new(Some(receiver)));
    let work = Arc::clone(&lock);
    let (finished, result) = mpsc::channel();
    std::thread::spawn(move || {
        finished
            .send(pending_document_frame_identity_start(&work))
            .unwrap();
    });
    assert_eq!(
        result.recv_timeout(Duration::from_millis(100)).unwrap(),
        Ok(Some("started".into()))
    );
}
