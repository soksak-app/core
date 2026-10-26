//! Checks that a window status read during the creation and the close of a surface finds the registered surface.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread;
use std::time::Duration;

use super::{
    Running, SurfaceComposition, cancel_layout_after_setup_error, clear_page_compositions,
    close_registered_surface, commit_layout_after_root_joins, committed_view_updates,
    complete_layout_presentation, create_registered_surface, mark_first_commit,
    prepare_surface_visibility, pressed_surface, removed_surfaces,
};

// contract: surface-layout.setup-failure-cancels-open-transaction
#[test]
fn webview_presentation_registration_failure_cancels_open_layout() {
    let mut cancelled = false;
    let error = cancel_layout_after_setup_error("webview callback setup failed".into(), || {
        cancelled = true;
        Ok(())
    });
    assert!(
        cancelled,
        "layout transaction remained open after callback setup failed"
    );
    assert_eq!(error, "webview callback setup failed");

    let error = cancel_layout_after_setup_error("webview callback setup failed".into(), || {
        Err("layout cancellation enqueue failed".into())
    });
    assert_eq!(
        error,
        "webview callback setup failed; cancelling layout: layout cancellation enqueue failed"
    );
}

// contract: surface-layout.prepare-visible-surfaces
#[test]
fn prepare_preserves_requested_visible_state_and_hides_requested_invisible_surfaces() {
    for initially_hidden in [false, true] {
        let mut hidden = initially_hidden;
        let mut calls = Vec::new();
        prepare_surface_visibility(true, |value| {
            calls.push(value);
            hidden = value;
            Ok(())
        })
        .expect("visible prepare succeeds");
        assert_eq!(
            hidden, initially_hidden,
            "visible prepare changed the prior hidden state"
        );
        assert!(
            calls.is_empty(),
            "visible prepare called the native visibility setter"
        );
    }

    let mut hidden = false;
    let mut calls = Vec::new();
    prepare_surface_visibility(false, |value| {
        calls.push(value);
        hidden = value;
        Ok(())
    })
    .expect("invisible prepare succeeds");
    assert!(hidden, "an invisible prepare left the surface shown");
    assert_eq!(
        calls,
        vec![true],
        "an invisible prepare did not hide immediately"
    );
}

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
#[test]
fn root_view_join_is_registered_before_dom_presentation_wait() {
    let (phase_tx, phase_rx) = mpsc::channel();
    let (dom_release, dom_wait) = mpsc::channel();
    let presented = Arc::new(AtomicBool::new(false));
    let pending_join = Arc::new(Mutex::new(None::<Box<dyn FnOnce() + Send>>));
    let view_presented = Arc::clone(&presented);
    let registered_join = Arc::clone(&pending_join);
    let joined_slot = Arc::clone(&pending_join);
    let worker = thread::spawn(move || {
        let ready = complete_layout_presentation(
            || {
                assert!(
                    registered_join.lock().unwrap().is_some(),
                    "DOM presentation was registered before the fake platform join"
                );
                assert!(
                    !view_presented.load(Ordering::SeqCst),
                    "the fake platform presented the root view before the DOM wait"
                );
                phase_tx.send("register-dom").unwrap();
                Ok(())
            },
            || {
                phase_tx.send("dom").unwrap();
                dom_wait.recv().unwrap();
                Ok(())
            },
            || {
                phase_tx.send("raster").unwrap();
                Ok(())
            },
            || {
                phase_tx.send("root-join").unwrap();
                let view_presented = Arc::clone(&view_presented);
                *joined_slot.lock().unwrap() = Some(Box::new(move || {
                    view_presented.store(true, Ordering::SeqCst);
                }));
                Ok(())
            },
        );
        if ready.is_ok() {
            phase_tx.send("commit").unwrap();
        }
    });
    let first = phase_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("layout did not register its first presentation stage");
    dom_release.send(()).unwrap();
    let mut phases = vec![first];
    while phases.last() != Some(&"commit") {
        phases.push(
            phase_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("layout did not finish its presentation stages"),
        );
    }
    worker.join().unwrap();
    assert!(
        !presented.load(Ordering::SeqCst),
        "the fake platform join was released before the root view presented"
    );
    pending_join
        .lock()
        .unwrap()
        .take()
        .expect("the root-view presentation callback was not retained")();
    assert!(presented.load(Ordering::SeqCst));
    assert_eq!(
        phases,
        ["root-join", "register-dom", "dom", "raster", "commit"],
        "layout did not register changed root-view joins before the DOM wait, then wait for DOM and rasters before commit"
    );
}

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
#[test]
fn a_replacement_generation_is_not_committed_without_its_own_join() {
    let joined_generation = 12;
    let current_generation = 13;
    let placed = [super::Placement {
        id: "tab-recreated".into(),
        x: 30.0,
        y: 20.0,
        w: 300.0,
        h: 200.0,
        visible: true,
    }];
    let stages = Arc::new(Mutex::new(Vec::new()));
    let join_stages = Arc::clone(&stages);
    let commit_stages = Arc::clone(&stages);

    let result = commit_layout_after_root_joins(
        &placed,
        vec![("tab-recreated".into(), joined_generation)],
        41,
        |_| Some(current_generation),
        |_, _, _| true,
        |missing| {
            assert_eq!(missing.len(), 1);
            assert_eq!(missing[0].id, "tab-recreated");
            join_stages.lock().unwrap().push("join-generation-13");
            Ok(super::documents::ViewJoinOutcome {
                required: vec![("tab-recreated".into(), current_generation)],
                joined: vec![("tab-recreated".into(), current_generation)],
            })
        },
        || {
            commit_stages.lock().unwrap().push("native-commit");
            Ok(true)
        },
    )
    .expect("replacement view generation joins before commit");

    assert!(
        result
            .1
            .contains(&("tab-recreated".into(), current_generation)),
        "the replacement generation was not retained as joined"
    );
    assert_eq!(
        *stages.lock().unwrap(),
        ["join-generation-13", "native-commit"],
        "the native commit ran before the replacement generation joined"
    );
}

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
#[test]
fn presentation_state_does_not_commit_an_unjoined_visible_generation() {
    let visible = [super::Placement {
        id: "tab-recreated".into(),
        x: 30.0,
        y: 20.0,
        w: 300.0,
        h: 200.0,
        visible: true,
    }];
    let prior_join = [("tab-recreated".to_string(), 12)];

    let updates = committed_view_updates(&visible, &prior_join, |_| Some(13));
    assert!(
        updates.is_empty(),
        "an unjoined replacement generation was marked committed"
    );

    let hidden = [super::Placement {
        visible: false,
        ..visible[0].clone()
    }];
    let hidden_updates = committed_view_updates(&hidden, &prior_join, |_| Some(13));
    assert_eq!(
        hidden_updates.len(),
        1,
        "hiding a view lost its committed hidden placement"
    );
    assert_eq!(hidden_updates[0].1, 13);
    assert!(!hidden_updates[0].2.visible);
}

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
#[test]
fn a_required_replacement_join_failure_stops_before_native_commit() {
    let placed = [super::Placement {
        id: "tab-recreated".into(),
        x: 30.0,
        y: 20.0,
        w: 300.0,
        h: 200.0,
        visible: true,
    }];
    let mut commit_called = false;

    let error = commit_layout_after_root_joins(
        &placed,
        vec![("tab-recreated".into(), 12)],
        41,
        |_| Some(13),
        |_, _, _| true,
        |_| {
            Ok(super::documents::ViewJoinOutcome {
                required: vec![("tab-recreated".into(), 13)],
                joined: Vec::new(),
            })
        },
        || {
            commit_called = true;
            Ok(true)
        },
    )
    .expect_err("an unjoined replacement generation cannot be committed");

    assert_eq!(
        error,
        "view tab-recreated generation 13 could not join layout ticket 41"
    );
    assert!(
        !commit_called,
        "native commit ran after a required root-view join failed"
    );
}

// contract: surface-layout.joins-root-views-before-awaiting-app-dom
#[test]
fn an_unchanged_committed_root_does_not_join_again() {
    let placed = [super::Placement {
        id: "tab-stable".into(),
        x: 30.0,
        y: 20.0,
        w: 300.0,
        h: 200.0,
        visible: true,
    }];
    let mut join_called = false;
    let (committed, joined) = commit_layout_after_root_joins(
        &placed,
        Vec::new(),
        42,
        |_| Some(13),
        |_, _, placement| placement.frame != [30.0, 20.0, 300.0, 200.0],
        |_| {
            join_called = true;
            Ok(super::documents::ViewJoinOutcome::default())
        },
        || Ok(true),
    )
    .expect("an unchanged committed root remains settled");

    assert!(committed);
    assert!(joined.is_empty());
    assert!(
        !join_called,
        "an unchanged committed root was probed for another join"
    );
}

// contract: surface-layout.presentation-failure-stops-before-commit
#[test]
fn dom_failure_skips_raster_and_dom_and_raster_errors_are_preserved() {
    let mut raster_called = false;
    let mut roots_prepared = false;
    let ready = complete_layout_presentation(
        || Ok(()),
        || Err("application DOM failed".to_string()),
        || {
            raster_called = true;
            Ok(())
        },
        || {
            roots_prepared = true;
            Ok(())
        },
    );
    assert_eq!(ready, Err("application DOM failed".to_string()));
    assert!(
        roots_prepared,
        "root views were not prepared before DOM presentation"
    );
    assert!(!raster_called, "raster ran after DOM presentation failed");

    roots_prepared = false;
    let ready = complete_layout_presentation(
        || Ok(()),
        || Ok(()),
        || Err("image raster failed".to_string()),
        || {
            roots_prepared = true;
            Ok(())
        },
    );
    assert_eq!(ready, Err("image raster failed".to_string()));
    assert!(
        roots_prepared,
        "root views were not prepared before raster wait"
    );
}

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

// contract: view.placement.retires-declarations-on-page-reload
#[test]
fn clearing_page_compositions_retires_the_previous_generation() {
    let composition = SurfaceComposition {
        kind: "view".into(),
        page: "ui/page.html".into(),
        regions: Vec::new(),
        overlays: Some(Vec::new()),
    };
    let compositions = Mutex::new(HashMap::from([("tab-old".into(), composition)]));
    let plugins = Mutex::new(HashMap::from([("tab-old".into(), "probe".into())]));

    clear_page_compositions(&compositions, &plugins);

    assert!(compositions.lock().unwrap().is_empty());
    assert!(plugins.lock().unwrap().is_empty());
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

mod placement_snapshot {
    use super::super::{Placement, read_surface_placements};

    #[test]
    fn prepared_frames_share_one_main_thread_turn() {
        let mut turns = 0;
        let placements = read_surface_placements(
            vec![(1, "first".into(), true), (2, "second".into(), false)],
            |targets| {
                turns += 1;
                Ok(targets
                    .into_iter()
                    .map(|(_, id, visible)| Placement {
                        id,
                        x: turns as f64,
                        y: 0.0,
                        w: 10.0,
                        h: 10.0,
                        visible,
                    })
                    .collect())
            },
        )
        .expect("read prepared frames");
        assert_eq!(
            turns, 1,
            "one placement reply must use one main-thread turn"
        );
        assert_eq!(
            placements[0].x, placements[1].x,
            "frames must share the same native turn"
        );
        assert_eq!(placements[0].id, "first");
        assert_eq!(placements[1].id, "second");
        assert!(placements[0].visible);
        assert!(!placements[1].visible);
    }

    #[test]
    fn frame_read_failure_rejects_the_placement_reply() {
        let result = read_surface_placements(vec![(1, "first".into(), true)], |_| {
            Err("frame read failed".into())
        });
        assert_eq!(result.err().as_deref(), Some("frame read failed"));
    }

    #[test]
    fn no_surfaces_require_no_main_thread_turn() {
        let placements = read_surface_placements(vec![], |_| panic!("empty placement dispatched"))
            .expect("empty placement succeeds");
        assert!(placements.is_empty());
    }
}
