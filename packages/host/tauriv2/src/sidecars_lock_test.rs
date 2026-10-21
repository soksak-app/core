//! Checks that a poisoned state lock of the sidecar transport is recovered and the transport still answers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::value::RawValue;

use super::{
    Event, Failure, Message, Outgoing, Owner, ReplyWaiters, Sidecars, await_replaced_service,
    close_answer, close_persistent_owner, fail, fail_requests, notify_connection, record_reply,
    revive_attempt,
};

#[derive(Clone)]
struct TestOwner(String);

impl Owner for TestOwner {
    fn key(&self) -> String {
        self.0.clone()
    }
    fn root(&self) -> Result<String, String> {
        Ok("/".to_string())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, _failure: Failure) {}
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

/// Poisons the read and write lock by panicking while its write guard is held.
fn poison_declarations<T>(lock: &RwLock<T>) {
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = lock.write().unwrap();
            panic!("the test poisons the lock");
        }))
        .is_err(),
        "the closure must panic"
    );
    assert!(lock.is_poisoned(), "the lock was not poisoned");
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_state_lock_still_answers_the_transport() {
    let folder = crate::test_folder::Folder::new();
    let sidecars = Sidecars::<TestOwner>::new(&[], folder.path().to_path_buf()).unwrap();
    poison(&sidecars.core.state);
    assert_eq!(
        sidecars.running_persistent().ok(),
        Some(Vec::new()),
        "the running persistent list was not read while the state lock was poisoned"
    );
    let error = sidecars
        .send_with_cids(
            &TestOwner("main".to_string()),
            "missing",
            "surf",
            &RawValue::from_string("{}".to_string()).unwrap(),
            &[],
        )
        .expect_err("the send of an undeclared sidecar succeeded");
    assert_eq!(
        error, "sidecar missing is not declared by any plugin",
        "the send failed with the poisoned state instead of the declaration"
    );
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_state_lock_still_answers_the_sidecar_queries() {
    let folder = crate::test_folder::Folder::new();
    let sidecars = Sidecars::<TestOwner>::new(&[], folder.path().to_path_buf()).unwrap();
    poison(&sidecars.core.state);
    let sidecars = sidecars.with_clock(Instant::now);
    assert!(
        sidecars.outdated().is_empty(),
        "the outdated list was not read while the state lock was poisoned"
    );
    assert!(
        sidecars.closing().is_empty(),
        "the closing list was not read while the state lock was poisoned"
    );
    assert_eq!(
        sidecars.writing("missing"),
        Err("sidecar missing is not running".to_string()),
        "the writer size was not read while the state lock was poisoned"
    );
    assert_eq!(
        sidecars.replace("missing"),
        Err(
            "sidecar missing: no running service of another version than the installed one"
                .to_string()
        ),
        "the replacement was not refused by its rule while the state lock was poisoned"
    );
    let changes = Arc::new(AtomicUsize::new(0));
    let counted = changes.clone();
    sidecars.on_closing_changed(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    });
    sidecars.surface_opened("plugin", "surf");
    assert_eq!(
        sidecars.declare(&[]),
        Ok(()),
        "the declaration failed while the state lock was poisoned"
    );
    assert_eq!(
        close_answer(
            &sidecars.core.state,
            "missing",
            br#"{"surface":"surf","closed":true}"#
        ),
        Err("unexpected close answer for surf".to_string()),
        "the close answer was not judged while the state lock was poisoned"
    );
    fail_requests(
        &sidecars.core.state,
        "missing",
        "the test fails the requests",
    );
    record_reply(
        &sidecars.core.state,
        "missing",
        &Event {
            surface: "surf".to_string(),
            body: RawValue::from_string("{}".to_string()).unwrap(),
            cids: vec!["cid-1".to_string()],
        },
    );
    fail(&sidecars.core.state, "missing", 1, None);
    notify_connection(&sidecars.core, "missing", Ok(()));
    await_replaced_service(&sidecars.core, "missing");
    #[cfg(feature = "diagnostics")]
    {
        let owner = TestOwner("main".to_string());
        assert!(
            sidecars.sessions(&owner).is_empty(),
            "the sessions were not read while the state lock was poisoned"
        );
        assert_eq!(
            sidecars.pending_count(&owner),
            0,
            "the pending count was not read while the state lock was poisoned"
        );
    }
    sidecars.stop();
    assert_eq!(
        revive_attempt(&sidecars.core, "missing"),
        Ok(false),
        "the restart of a stopped transport was not refused while the state lock was poisoned"
    );
    assert_eq!(
        changes.load(Ordering::SeqCst),
        0,
        "a closing change was announced without a closing surface"
    );
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_declaration_lock_still_answers_the_sidecar_queries() {
    let folder = crate::test_folder::Folder::new();
    let sidecars = Sidecars::<TestOwner>::new(&[], folder.path().to_path_buf()).unwrap();
    poison_declarations(&sidecars.core.declarations);
    assert_eq!(
        sidecars.core.version("missing"),
        "",
        "the version was not read while the declaration lock was poisoned"
    );
    assert!(
        !sidecars.declared("missing"),
        "the declaration was not read while the declaration lock was poisoned"
    );
    sidecars.surface_opened("plugin", "surf");
    assert_eq!(
        sidecars.retain_sessions(&[]),
        Ok(0),
        "the sessions were not retained while the declaration lock was poisoned"
    );
    assert_eq!(
        sidecars.declare(&[]),
        Ok(()),
        "the declaration failed while the declaration lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn poisoned_reply_waiter_locks_still_close_the_owner_of_a_service() {
    let close_waiters: ReplyWaiters = Arc::new(Mutex::new(HashMap::new()));
    let shutdown_waiters: ReplyWaiters = Arc::new(Mutex::new(HashMap::new()));
    let owner_closed = Mutex::new(false);
    poison(&close_waiters);
    poison(&shutdown_waiters);
    poison(&owner_closed);
    let (outbox, lines) = sync_channel(2);
    let answered = (close_waiters.clone(), shutdown_waiters.clone());
    let service = std::thread::spawn(move || {
        for (waiters, request) in [(&answered.0, "test-close"), (&answered.1, "test-shutdown")] {
            let Ok(Outgoing::Line(_)) = lines.recv() else {
                panic!("the service received no line for {request}");
            };
            let sender = waiters
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(request)
                .unwrap_or_else(|| panic!("no waiter was registered for {request}"));
            sender.send(Ok(())).unwrap();
        }
    });
    let closed = close_persistent_owner(
        &outbox,
        &close_waiters,
        &shutdown_waiters,
        &owner_closed,
        "test",
        Instant::now() + Duration::from_secs(10),
    );
    service.join().unwrap();
    assert!(
        matches!(closed, Ok(true)),
        "the owner was not closed while the waiter locks were poisoned"
    );
    let again = close_persistent_owner(
        &outbox,
        &close_waiters,
        &shutdown_waiters,
        &owner_closed,
        "test",
        Instant::now() + Duration::from_secs(10),
    );
    assert!(
        matches!(again, Ok(false)),
        "a closed owner was closed again"
    );
}
