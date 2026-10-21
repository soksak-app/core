use std::sync::Mutex;

use crate::platform::Handle;
use crate::surfaces::Views;

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

/// The surface count of diagnostics.objects is the number of native views of the surfaces of the window, and it falls
/// back when a view is removed.
// contract: diagnostics.objects.counts-host-objects
#[test]
fn the_surface_count_follows_the_views_of_the_window() {
    let views = Views::default();
    assert_eq!(views.count().unwrap(), 0);
    views
        .0
        .lock()
        .unwrap()
        .insert(1 as Handle, "tab-1".to_string());
    views
        .0
        .lock()
        .unwrap()
        .insert(2 as Handle, "tab-2".to_string());
    assert_eq!(views.count().unwrap(), 2);
    views.0.lock().unwrap().remove(&(1 as Handle));
    assert_eq!(views.count().unwrap(), 1);
}

#[test]
fn the_surface_count_is_read_when_the_views_lock_is_poisoned() {
    let views = Views::default();
    views
        .0
        .lock()
        .unwrap()
        .insert(1 as Handle, "tab-1".to_string());
    poison(&views.0);
    assert_eq!(
        views.count().ok(),
        Some(1),
        "the surface count was not read while the views lock was poisoned"
    );
}
