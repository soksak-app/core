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

/// Returns the waiting requests of a relay, whether or not its lock is poisoned.
fn waiting(relay: &Relay) -> usize {
    relay
        .pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .len()
}

// contract: host.locks.poisoned-state-is-recovered
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

// contract: host.locks.poisoned-state-is-recovered
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

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_pending_lock_still_answers_a_request() {
    let relay = Arc::new(Relay::default());
    poison(&relay.pending);
    let (started, started_rx) = mpsc::channel::<u64>();
    let answering = Arc::clone(&relay);
    let handle = std::thread::spawn(move || {
        let id = started_rx.recv().unwrap();
        let payload = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": 7
        }))
        .unwrap();
        answering
            .reply("main", &RawValue::from_string(payload).unwrap())
            .expect("the reply failed while the pending lock was poisoned");
    });
    let answer = relay.request_call("main", None, None, move |id| {
        started.send(id).unwrap();
        Ok(())
    });
    handle.join().unwrap();
    assert!(
        answer.is_ok(),
        "the request failed while the pending lock was poisoned"
    );
}
// contract: host.locks.poisoned-state-is-recovered
#[cfg(feature = "diagnostics")]
#[test]
fn the_pending_count_is_read_when_the_pending_lock_is_poisoned() {
    let relay = Relay::default();
    let (tx, _rx) = mpsc::channel();
    relay
        .pending
        .lock()
        .unwrap()
        .insert(1, ("main".to_string(), tx));
    poison(&relay.pending);
    assert_eq!(
        relay.pending_count("main"),
        1,
        "the waiting requests of a poisoned lock were not counted"
    );
}
