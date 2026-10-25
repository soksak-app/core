//! Checks that a poisoned state lock of the sidecar transport is recovered and the transport still answers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::value::RawValue;

use super::{
    Event, Failure, Message, Outgoing, Owner, ReplyWaiters, Revival, Sidecars,
    await_replaced_service, close_answer, close_persistent_owner, fail, fail_requests,
    notify_connection, record_reply, revive_attempt,
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
        revive_attempt(&sidecars.core, "missing", &Revival::default()),
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
    let connected = std::sync::atomic::AtomicBool::new(true);
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
        &connected,
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
        &connected,
        &owner_closed,
        "test",
        Instant::now() + Duration::from_secs(10),
    );
    assert!(
        matches!(again, Ok(false)),
        "a closed owner was closed again"
    );
}

// contract: sidecars.close.answer-ends-closing
#[test]
fn fast_close_answer_preserves_both_closing_transitions() {
    let folder = crate::test_folder::Folder::new();
    let sidecars = Arc::new(Sidecars::<TestOwner>::new(&[], folder.path().to_path_buf()).unwrap());
    let owner = TestOwner("probe-window".into());
    let (outbox, _receiver) = sync_channel(2);
    {
        let mut state = sidecars.core.state.lock().unwrap();
        state.running.insert(
            "fixture-standard".into(),
            super::Process {
                child: None,
                outbox,
                writing: Arc::new(AtomicUsize::new(0)),
                persistent: None,
                surfaces: ["tab-standard".into()].into(),
                closed_surfaces: Default::default(),
            },
        );
        state.owners.insert("tab-standard".into(), owner.clone());
        state
            .roots
            .insert("tab-standard".into(), "/fixture/root".into());
    }
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let collected = snapshots.clone();
    sidecars.on_status_changed(move |value| {
        collected.lock().unwrap().push(value.closing);
    });
    sidecars
        .close_owned_observed(&owner, &|_| true, false, || {
            assert_eq!(
                close_answer(
                    &sidecars.core.state,
                    "fixture-standard",
                    br#"{"surface":"tab-standard","closed":true}"#
                ),
                Ok(true)
            );
        })
        .unwrap();
    assert_eq!(
        *snapshots.lock().unwrap(),
        vec![
            vec![super::ClosingSurface {
                sidecar: "fixture-standard".into(),
                surface: "tab-standard".into(),
            }],
            vec![]
        ]
    );
}

// contract: sidecars.close.answer-ends-closing
#[test]
fn status_only_consumer_receives_stop_closing_removal() {
    let folder = crate::test_folder::Folder::new();
    let sidecars = Sidecars::<TestOwner>::new(&[], folder.path().to_path_buf()).unwrap();
    let (outbox, _receiver) = sync_channel(2);
    {
        let mut state = sidecars.core.state.lock().unwrap();
        state.running.insert(
            "fixture-standard".into(),
            super::Process {
                child: None,
                outbox,
                writing: Arc::new(AtomicUsize::new(0)),
                persistent: None,
                surfaces: ["tab-standard".into()].into(),
                closed_surfaces: Default::default(),
            },
        );
        state.closing.insert(
            "fixture-standard".into(),
            [("tab-standard".into(), 1)].into(),
        );
    }
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let collected = snapshots.clone();
    sidecars.on_status_changed(move |value| collected.lock().unwrap().push(value.closing));
    sidecars.stop();
    assert_eq!(
        *snapshots.lock().unwrap(),
        vec![Vec::<super::ClosingSurface>::new()]
    );
}

// contract: sidecars.close.answer-ends-closing
#[test]
fn detach_notification_contains_the_complete_final_status() {
    let folder = crate::test_folder::Folder::new();
    let sidecars = Sidecars::<TestOwner>::new(&[], folder.path().to_path_buf()).unwrap();
    let (outbox, _receiver) = sync_channel(2);
    let (persistent_outbox, _persistent_receiver) = sync_channel(2);
    sidecars
        .core
        .declarations
        .write()
        .unwrap()
        .versions
        .insert("fixture-service".into(), "new".into());
    {
        let mut state = sidecars.core.state.lock().unwrap();
        state.running.insert(
            "fixture-standard".into(),
            super::Process {
                child: None,
                outbox,
                writing: Arc::new(AtomicUsize::new(0)),
                persistent: None,
                surfaces: ["tab-standard".into()].into(),
                closed_surfaces: Default::default(),
            },
        );
        state.running.insert(
            "fixture-service".into(),
            super::Process {
                child: None,
                outbox: persistent_outbox,
                writing: Arc::new(AtomicUsize::new(0)),
                persistent: Some(super::PersistentConnection {
                    version: Some("old".into()),
                    close_waiters: Default::default(),
                    retain_waiters: Default::default(),
                    shutdown_waiters: Default::default(),
                    owner_closed: Default::default(),
                    connected: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                    service_pid: 0,
                }),
                surfaces: Default::default(),
                closed_surfaces: Default::default(),
            },
        );
        state.closing.insert(
            "fixture-standard".into(),
            [("tab-standard".into(), 1)].into(),
        );
    }
    assert_eq!(sidecars.status().outdated.len(), 1);
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let collected = snapshots.clone();
    sidecars.on_status_changed(move |value| collected.lock().unwrap().push(value));
    sidecars.detach();
    assert_eq!(
        *snapshots.lock().unwrap(),
        vec![super::SidecarStatus {
            closing: vec![],
            outdated: vec![]
        }]
    );
}

/// Holds a connected persistent session without starting a process.
fn outdated_fixture(
    running: &str,
    installed: &str,
) -> (
    Sidecars<TestOwner>,
    super::SidecarDeclaration,
    Arc<std::sync::atomic::AtomicBool>,
    crate::test_folder::Folder,
) {
    let folder = crate::test_folder::Folder::new();
    let declaration = super::SidecarDeclaration { name: "fixture-service".into(), folder: folder.path().to_path_buf(),
  data: br#"{"executable":"service","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}"#.to_vec(), version: installed.into(), dependents: vec![] };
    let sidecars = Sidecars::new(&[declaration.clone()], folder.path().to_path_buf()).unwrap();
    let connected = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let (outbox, _receiver) = sync_channel(2);
    {
        let mut state = sidecars.core.state.lock().unwrap();
        state.running.insert(
            declaration.name.clone(),
            super::Process {
                child: None,
                outbox,
                writing: Arc::new(AtomicUsize::new(0)),
                persistent: Some(super::PersistentConnection {
                    version: Some(running.into()),
                    close_waiters: Default::default(),
                    retain_waiters: Default::default(),
                    shutdown_waiters: Default::default(),
                    owner_closed: Default::default(),
                    connected: connected.clone(),
                    service_pid: 0,
                }),
                surfaces: ["tab-fixture".into()].into(),
                closed_surfaces: Default::default(),
            },
        );
        state
            .owners
            .insert("tab-fixture".into(), TestOwner("probe-window".into()));
        state
            .roots
            .insert("tab-fixture".into(), "/fixture/root".into());
    }
    (sidecars, declaration, connected, folder)
}

// contract: sidecars-transport.hello.reports-a-service-of-another-version
#[test]
fn declaration_notifies_each_outdated_version_change() {
    for (running, installed, next, expected) in [
        ("0.0.7", "0.0.7", "0.0.8", 1),
        ("0.0.6", "0.0.7", "0.0.8", 1),
        ("0.0.6", "0.0.7", "0.0.6", 1),
        ("0.0.6", "0.0.7", "0.0.7", 0),
    ] {
        let (sidecars, mut declaration, _, _folder) = outdated_fixture(running, installed);
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        let collected = snapshots.clone();
        sidecars.on_status_changed(move |value| collected.lock().unwrap().push(value));
        declaration.version = next.into();
        sidecars.declare(&[declaration]).unwrap();
        let snapshots = snapshots.lock().unwrap();
        assert_eq!(
            snapshots.len(),
            expected,
            "version-change notifications {running}/{installed}/{next}: {snapshots:?}"
        );
        if expected > 0 {
            assert_eq!(snapshots[0], sidecars.status());
        }
    }
    let (sidecars, mut declaration, _, _folder) = outdated_fixture("0.0.6", "0.0.7");
    let before = sidecars.status();
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    sidecars.on_status_changed(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
    });
    declaration.data = b"{".to_vec();
    assert!(sidecars.declare(&[declaration]).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(sidecars.status(), before);
}

// contract: sidecars-transport.hello.reports-a-service-of-another-version
#[test]
fn disconnect_notifies_outdated_removal_without_pending_closes() {
    let (sidecars, _, connected, _folder) = outdated_fixture("0.0.6", "0.0.7");
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let collected = snapshots.clone();
    sidecars.on_status_changed(move |value| collected.lock().unwrap().push(value));
    let stale_connection = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let (stale, _, _) = super::persistent_connection_ended(
        &sidecars.core,
        &mut sidecars.core.state.lock().unwrap(),
        "fixture-service",
        &stale_connection,
        false,
    );
    assert!(!stale);
    assert!(snapshots.lock().unwrap().is_empty());
    let (current, _, _) = super::persistent_connection_ended(
        &sidecars.core,
        &mut sidecars.core.state.lock().unwrap(),
        "fixture-service",
        &connected,
        false,
    );
    assert!(current);
    assert_eq!(
        *snapshots.lock().unwrap(),
        vec![super::SidecarStatus {
            closing: vec![],
            outdated: vec![]
        }]
    );
}

// contract: sidecars-transport.hello.reports-a-service-of-another-version
#[test]
fn detach_notifies_outdated_removal_without_pending_closes() {
    let (sidecars, _, _, _folder) = outdated_fixture("0.0.6", "0.0.7");
    let (outbox, _receiver) = sync_channel(2);
    sidecars
        .core
        .state
        .lock()
        .unwrap()
        .running
        .get_mut("fixture-service")
        .unwrap()
        .outbox = outbox;
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let collected = snapshots.clone();
    sidecars.on_status_changed(move |value| collected.lock().unwrap().push(value));
    sidecars.detach();
    assert_eq!(
        *snapshots.lock().unwrap(),
        vec![super::SidecarStatus {
            closing: vec![],
            outdated: vec![]
        }]
    );
    sidecars.detach();
    assert_eq!(
        snapshots.lock().unwrap().len(),
        1,
        "repeated detach announced unchanged status"
    );
}

// contract: sidecars.retain.closes-sessions-absent-from-layout
#[test]
fn retain_notifies_outdated_session_counts() {
    let (sidecars, _, _, _folder) = outdated_fixture("0.0.6", "0.0.7");
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let collected = snapshots.clone();
    sidecars.on_status_changed(move |value| collected.lock().unwrap().push(value));
    assert!(
        super::retain_layout_owners(
            &sidecars.core,
            &mut sidecars.core.state.lock().unwrap(),
            &["tab-fixture"].into(),
        )
        .is_none(),
        "a status-only fixture has no UI invalidation consumer"
    );
    assert!(snapshots.lock().unwrap().is_empty());
    assert!(
        super::retain_layout_owners(
            &sidecars.core,
            &mut sidecars.core.state.lock().unwrap(),
            &Default::default(),
        )
        .is_none(),
        "a status-only fixture has no UI invalidation consumer"
    );
    {
        let snapshots = snapshots.lock().unwrap();
        assert_eq!(
            snapshots.len(),
            1,
            "missing retained session-count notification"
        );
        assert_eq!(snapshots[0].outdated.len(), 1);
        assert_eq!(snapshots[0].outdated[0].sessions, 0);
    }
    assert!(
        super::retain_layout_owners(
            &sidecars.core,
            &mut sidecars.core.state.lock().unwrap(),
            &Default::default(),
        )
        .is_none(),
        "a status-only fixture has no UI invalidation consumer"
    );
    assert_eq!(
        snapshots.lock().unwrap().len(),
        1,
        "repeated retention announced unchanged status"
    );
}

// contract: sidecars.retain.closes-sessions-absent-from-layout
#[test]
fn reused_retained_surface_notifies_outdated_session_count() {
    let (sidecars, _, _, _folder) = outdated_fixture("0.0.6", "0.0.7");
    let (outbox, _receiver) = sync_channel(2);
    sidecars
        .core
        .state
        .lock()
        .unwrap()
        .running
        .get_mut("fixture-service")
        .unwrap()
        .outbox = outbox;
    assert!(
        super::retain_layout_owners(
            &sidecars.core,
            &mut sidecars.core.state.lock().unwrap(),
            &Default::default(),
        )
        .is_none(),
        "a status-only fixture has no UI invalidation consumer"
    );
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let collected = snapshots.clone();
    sidecars.on_status_changed(move |value| collected.lock().unwrap().push(value));
    sidecars
        .send(
            &TestOwner("probe-window".into()),
            "fixture-service",
            "tab-fixture",
            &RawValue::from_string(r#"{"operation":"open"}"#.into()).unwrap(),
        )
        .unwrap();
    let snapshots = snapshots.lock().unwrap();
    assert_eq!(
        snapshots.len(),
        1,
        "missing reused session-count notification"
    );
    assert_eq!(snapshots[0].outdated.len(), 1);
    assert_eq!(snapshots[0].outdated[0].sessions, 1);
}
