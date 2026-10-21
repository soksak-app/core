//! Checks that a destroyed window is removed from the owner and window records when their locks are poisoned, and that the
//! application exits when the last window of a quitting application is removed.

use std::sync::PoisonError;

use super::*;

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
fn a_destroyed_window_is_removed_from_the_records_when_their_locks_are_poisoned() {
    let registry = Windows::default();
    registry
        .owners
        .lock()
        .unwrap()
        .insert("surface-main-a".into(), "main".into());
    registry
        .owners
        .lock()
        .unwrap()
        .insert("surface-second-a".into(), "second".into());
    registry
        .windows
        .lock()
        .unwrap()
        .insert("main".into(), Arc::new(WindowData::default()));
    poison(&registry.owners);
    poison(&registry.windows);
    let exits = remove_window_records(&registry, "main");
    assert!(
        !exits,
        "the application exits while the second window is still open"
    );
    let owners = registry
        .owners
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    assert!(
        !owners.values().any(|owner| owner == "main"),
        "the owner record of a destroyed window was kept while the owner lock was poisoned"
    );
    let windows = registry
        .windows
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    assert!(
        !windows.contains_key("main"),
        "the record of a destroyed window was kept while the window lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn the_last_window_of_a_quitting_application_ends_it_when_the_records_are_poisoned() {
    let registry = Windows::default();
    registry
        .windows
        .lock()
        .unwrap()
        .insert("main".into(), Arc::new(WindowData::default()));
    registry.quit.begin();
    poison(&registry.windows);
    assert!(
        remove_window_records(&registry, "main"),
        "the last window of a quitting application did not end it while the window lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_owner_lock_releases_the_project_of_a_poisoned_lock() {
    let registry = Windows::default();
    registry
        .owners
        .lock()
        .unwrap()
        .insert("library".into(), "main".into());
    poison(&registry.owners);
    let (released, empty) = release_owner(&registry.owners, "library");
    assert_eq!(
        released.as_deref(),
        Some("main"),
        "the owner of the project was lost while the owner lock was poisoned"
    );
    assert!(
        empty,
        "the release left the project window occupied while the owner lock was poisoned"
    );
}
