//! Checks that a window status read during the creation and the close of a surface finds the registered surface.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, PoisonError};

use super::{
    Running, close_registered_surface, create_registered_surface, mark_first_commit,
    pressed_surface, removed_surfaces,
};

// contract: exposure.host-window.reads-during-surface-creation
#[test]
fn a_status_read_during_surface_creation_finds_the_registered_surface() {
    // The window status reads the surface ids of the native views from the surface_hosts registry. Creation names the
    // native view and registers it in one step, so a reading never sees a native view without its registration.
    let named = Mutex::new(HashMap::new());
    let surface_hosts: Mutex<HashMap<String, usize>> = Mutex::new(HashMap::new());
    create_registered_surface(&named, &surface_hosts, "tab-4leevm", || Ok(7)).unwrap();
    let status_names: HashMap<usize, String> = surface_hosts
        .lock()
        .unwrap()
        .iter()
        .map(|(id, handle)| (*handle, id.clone()))
        .collect();
    assert_eq!(
        status_names.get(&7),
        Some(&"tab-4leevm".to_string()),
        "the native view of tab-4leevm has no registered surface after creation"
    );
    // A failed creation registers nothing.
    let failed = create_registered_surface(&named, &surface_hosts, "tab-6", || {
        Err("no window".to_string())
    });
    assert!(failed.is_err());
    assert_eq!(surface_hosts.lock().unwrap().len(), 1);
}

// contract: exposure.host-window.reads-during-surface-close
#[test]
fn a_status_read_during_surface_close_finds_the_registered_surface() {
    // The sync takes the removed surfaces in one step and closes each native surface in a later main-thread step. A
    // window status read between the two steps sees the native surface, so the surface stays registered until the
    // close step.
    let named = Mutex::new(HashMap::from([(7usize, "tab-2".to_string())]));
    let surface_hosts = Mutex::new(HashMap::from([("tab-2".to_string(), 7usize)]));
    let alive = HashSet::new();
    let removed = removed_surfaces(&surface_hosts, &alive).unwrap();
    assert_eq!(removed, vec![("tab-2".to_string(), 7)]);
    let status_names: HashMap<usize, String> = surface_hosts
        .lock()
        .unwrap()
        .iter()
        .map(|(id, handle)| (*handle, id.clone()))
        .collect();
    assert_eq!(
        status_names.get(&7),
        Some(&"tab-2".to_string()),
        "the native surface of tab-2 has no registered surface before its close"
    );
    assert!(named.lock().unwrap().contains_key(&7));
}

// contract: view.composition.page-and-regions
#[test]
fn a_view_composition_declares_its_page_with_optional_regions() {
    use super::{SurfaceComposition, validate_composition};
    let composition = |value: serde_json::Value| -> SurfaceComposition {
        serde_json::from_value(value).expect("the composition fixture is valid")
    };
    let region = serde_json::json!({"name": "page", "kind": "document", "input": "native"});
    assert!(
        validate_composition(
            "probe",
            &composition(serde_json::json!({"kind": "view", "page": "ui/page.html"}))
        )
        .is_ok()
    );
    assert!(
        validate_composition("probe", &composition(serde_json::json!({"kind": "view", "page": "ui/page.html", "regions": [region], "overlays": []}))).is_ok()
    );
    for value in [
        serde_json::json!({"kind": "view"}),
        serde_json::json!({"kind": "view", "page": "../page.html"}),
        serde_json::json!({"kind": "view", "page": "ui/page.js"}),
        serde_json::json!({"kind": "view", "page": "ui/.binary/page.html"}),
        serde_json::json!({"kind": "hybrid", "page": "ui/page.html", "regions": [region], "overlays": []}),
    ] {
        assert!(
            validate_composition("probe", &composition(value.clone())).is_err(),
            "composition {value} is accepted"
        );
    }
}

// contract: view.composition.dom-removed
#[test]
fn a_hybrid_composition_is_refused_with_the_plugin_and_the_field() {
    use super::{SurfaceComposition, validate_composition};
    let region = serde_json::json!({"name": "page", "kind": "document", "input": "native"});
    for value in [
        serde_json::json!({"kind": "hybrid", "regions": [region], "overlays": []}),
        serde_json::json!({"kind": "hybrid", "page": "ui/page.html", "regions": [region], "overlays": []}),
    ] {
        let composition: SurfaceComposition =
            serde_json::from_value(value.clone()).expect("the fixture is valid");
        let error =
            validate_composition("probe", &composition).expect_err("the hybrid kind is removed");
        assert_eq!(
            error,
            "plugin probe surface composition: kind hybrid is removed; the composition takes kind view",
            "composition {value}"
        );
    }
}

// contract: view.composition.dom-removed
#[test]
fn a_dom_composition_is_refused_with_the_plugin_and_the_field() {
    use super::{SurfaceComposition, validate_composition};
    let composition: SurfaceComposition =
        serde_json::from_value(serde_json::json!({"kind": "dom"})).expect("the fixture is valid");
    let error = validate_composition("probe", &composition).expect_err("the dom kind is removed");
    assert_eq!(
        error,
        "plugin probe surface composition: kind dom is removed; the composition takes kind view"
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

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_press_of_a_surface_view_is_found_when_the_surface_lock_is_poisoned() {
    let named = Mutex::new(HashMap::from([(7usize, "surf".to_string())]));
    poison(&named);
    let found = pressed_surface(&named, &[7], |_| None);
    assert_eq!(
        found.as_deref(),
        Some("surf"),
        "a press of a surface view returned no surface while the surface lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn the_first_commit_of_a_page_is_marked_when_the_running_lock_is_poisoned() {
    let running = Running::default();
    poison(&running.first);
    assert!(
        mark_first_commit(&running),
        "the first commit of a page was not marked while the running lock was poisoned"
    );
    assert!(
        !mark_first_commit(&running),
        "a second commit of a page was marked as the first"
    );
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_surface_lock_still_creates_and_closes_a_surface() {
    let named = Mutex::new(HashMap::new());
    let surface_hosts: Mutex<HashMap<String, usize>> = Mutex::new(HashMap::new());
    poison(&named);
    poison(&surface_hosts);
    let created = create_registered_surface(&named, &surface_hosts, "tab-poison", || Ok(9));
    assert_eq!(
        created.ok(),
        Some(9),
        "a creation failed while the surface locks were poisoned"
    );
    let removed = removed_surfaces(&surface_hosts, &HashSet::new())
        .ok()
        .unwrap();
    assert_eq!(
        removed,
        vec![("tab-poison".to_string(), 9)],
        "a removal found no surface while the surface lock was poisoned"
    );
    let closed = close_registered_surface(&named, &surface_hosts, "tab-poison", 9, |_| Ok(()));
    assert_eq!(
        closed.ok(),
        Some(true),
        "a close found no registration while the surface locks were poisoned"
    );
    assert!(
        named
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
            && surface_hosts
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_empty(),
        "a close of a poisoned lock kept the surface registration or its name"
    );
}
