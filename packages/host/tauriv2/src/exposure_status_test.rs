use super::*;

/// A watch that starts after the watch of the window ended receives the value of the window that changed while no
/// connection watched it. The value sent before the watch ended is not sent again to the new watch.
// contract: status.window.rewatch-notifies
#[test]
fn a_new_watch_receives_the_next_window_value_after_a_stale_record() {
    let mut reported = HashMap::new();
    let open = json!({"modal": "open"});
    let closed = json!({"modal": "closed"});
    assert_eq!(
        decide_window_notify(&mut reported, "main", true, &open),
        WindowNotify::Sent(open.clone()),
        "the first value of a watched window is sent"
    );
    // The last watch of the window ends.
    forget_window_notify(&mut reported, "main");
    assert_eq!(
        decide_window_notify(&mut reported, "main", false, &closed),
        WindowNotify::Unwatched,
        "a value of a window that no connection watches is not sent"
    );
    assert_eq!(
        decide_window_notify(&mut reported, "main", true, &open),
        WindowNotify::Sent(open.clone()),
        "a new watch receives the value of the window after the earlier watch ended"
    );
}

/// Poisons the lock by panicking while its guard is held.
fn poison<T>(lock: &Mutex<T>) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = lock.lock().unwrap();
        panic!("the test poisons the lock");
    }));
    assert!(lock.is_poisoned(), "the lock was not poisoned");
}

/// Returns the waiting requests of a relay, whether or not its lock is poisoned.
fn waiting(relay: &Relay) -> usize {
    relay
        .pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .len()
}

#[test]
fn abandon_answers_the_waiting_request_of_a_poisoned_lock() {
    let relay = Relay::default();
    let (tx, rx) = mpsc::channel();
    relay
        .pending
        .lock()
        .unwrap()
        .insert(1, ("main".to_string(), tx));
    poison(&relay.pending);
    relay.abandon("main");
    let answered = matches!(
        rx.try_recv(),
        Ok(Err(failure)) if failure.code == MISSING_DOCUMENT
    );
    assert!(
        answered,
        "abandon did not answer the request of a poisoned lock"
    );
    assert_eq!(
        waiting(&relay),
        0,
        "abandon kept the request of a poisoned lock"
    );
}

#[test]
fn forget_removes_the_request_of_a_poisoned_lock() {
    let relay = Relay::default();
    let (tx, _rx) = mpsc::channel();
    relay
        .pending
        .lock()
        .unwrap()
        .insert(1, ("main".to_string(), tx));
    poison(&relay.pending);
    relay.forget(1);
    assert_eq!(waiting(&relay), 0, "forget kept the request that ended");
}
