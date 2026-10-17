//! Checks the order and the failure report of closing the logical surfaces of a closing window and their document
//! regions and image regions, and the use of the native address of a closing window.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use soksak_host_tauriv2::documents::{Documents, Streams};
use soksak_host_tauriv2::exposure::native_failure;
use soksak_host_tauriv2::images::Images;
use soksak_host_tauriv2::surfaces::{
    WindowNative, close_named_surface, close_window_surfaces, create_named_surface,
    create_registered_surface, take_removed_surfaces,
};
use soksak_host_tauriv2::windows::{MainStep, NativeFailure, use_owner};

fn key(surface: &str, name: &str) -> (String, String) {
    (surface.to_string(), name.to_string())
}

// contract: window-close.surfaces.closes-regions-then-surface
#[test]
fn closing_a_window_closes_each_surface_after_its_regions() {
    let documents = Documents::default();
    let streams = Streams::default();
    let images = Images::default();
    for (k, handle) in [(key("tab-1", "page"), 11), (key("tab-2", "page"), 21)] {
        documents.reserve(&k).unwrap();
        assert!(documents.set(&k, handle));
    }
    // A document region that is being created has no handle to close.
    documents.reserve(&key("tab-2", "pending")).unwrap();
    images
        .reserve(&key("tab-1", "view"), "owner", "sidecar")
        .unwrap();
    assert!(images.set(&key("tab-1", "view"), 12));
    let surfaces = HashMap::from([("tab-2".to_string(), 200), ("tab-1".to_string(), 100)]);
    let mut closed = Vec::new();
    close_window_surfaces(surfaces, &documents, &streams, &images, &mut |native| {
        closed.push(native);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        closed,
        vec![
            WindowNative::Document(11),
            WindowNative::Image(12),
            WindowNative::Surface(100),
            WindowNative::Document(21),
            WindowNative::Surface(200),
        ]
    );
    assert!(
        documents.names().is_empty(),
        "the closed surfaces keep document names"
    );
    assert!(
        documents.reserve(&key("tab-2", "pending")).is_ok(),
        "the closed surface keeps its pending document name"
    );
    assert!(
        images.remove_surface("tab-1").is_empty(),
        "the closed surface keeps its images"
    );
}

// contract: window-close.surfaces.reports-every-failure
#[test]
fn closing_a_window_reports_every_failure_and_closes_the_rest() {
    let documents = Documents::default();
    let streams = Streams::default();
    let images = Images::default();
    documents.reserve(&key("tab-1", "page")).unwrap();
    assert!(documents.set(&key("tab-1", "page"), 11));
    let surfaces = HashMap::from([("tab-1".to_string(), 100), ("tab-2".to_string(), 200)]);
    let mut closed = Vec::new();
    let result = close_window_surfaces(surfaces, &documents, &streams, &images, &mut |native| {
        closed.push(native);
        match native {
            WindowNative::Document(_) => Err("document failed".into()),
            WindowNative::Surface(200) => Err("surface failed".into()),
            _ => Ok(()),
        }
    });
    assert_eq!(
        closed,
        vec![
            WindowNative::Document(11),
            WindowNative::Surface(100),
            WindowNative::Surface(200),
        ]
    );
    let error = result.unwrap_err();
    assert!(
        error.contains("document failed") && error.contains("surface failed"),
        "{error}"
    );
}

/// The main thread of the test. Work that another thread sent is run in order before the main thread runs the next
/// step.
#[derive(Default)]
struct FakeMain {
    pending: Mutex<Vec<MainStep>>,
}

impl FakeMain {
    fn run(&self, step: MainStep) -> Result<(), String> {
        let pending = std::mem::take(&mut *self.pending.lock().unwrap());
        for task in pending {
            task();
        }
        step();
        Ok(())
    }
}

/// A window of the test. A close closes the window on the main thread like the runtime.
struct FakeWindow {
    closed: AtomicBool,
    /// When the address is read, it sends the close of this window to the main thread.
    close_on_read: AtomicBool,
}

const FAKE_HANDLE: usize = 0x5157;

fn fake_use(main: &Arc<FakeMain>, window: &Arc<FakeWindow>) -> Result<String, NativeFailure> {
    let queue = main.clone();
    let native = window.clone();
    use_owner(
        window.clone(),
        |step| main.run(step),
        move |window: &Arc<FakeWindow>| {
            if window.closed.load(Ordering::SeqCst) {
                return Ok(None);
            }
            if window.close_on_read.swap(false, Ordering::SeqCst) {
                let closed = window.clone();
                queue.pending.lock().unwrap().push(Box::new(move || {
                    closed.closed.store(true, Ordering::SeqCst)
                }));
            }
            Ok(Some(FAKE_HANDLE))
        },
        move |handle| {
            // The native code sends a message to the window it received. If it receives the address of a closed window,
            // it sends a message to that window.
            if native.closed.load(Ordering::SeqCst) {
                return Err(format!(
                    "native code messaged the closed window {handle:#x}"
                ));
            }
            Ok(format!("facts of {handle:#x}"))
        },
    )
}

// The native address of a window is read in the main-thread step that uses the address. A close that the main thread
// handled after reading comes after that step, and a window that closed before the step is not passed to the native
// code and is answered as Closed.
// contract: window-close.native-window.used-in-reading-step
#[test]
fn a_close_after_the_handle_read_does_not_reach_native_code() {
    let main = Arc::new(FakeMain::default());
    let window = Arc::new(FakeWindow {
        closed: AtomicBool::new(false),
        close_on_read: AtomicBool::new(true),
    });
    assert_eq!(fake_use(&main, &window), Ok("facts of 0x5157".to_string()));
    assert_eq!(fake_use(&main, &window), Err(NativeFailure::Closed));
    assert!(window.closed.load(Ordering::SeqCst));
    // The request of a closed window ends with error 1003 for a window that does not exist.
    let failure = native_failure("w2", -32603)(NativeFailure::Closed);
    assert_eq!(
        (failure.code, failure.message.as_str()),
        (1003, r#"window "w2" does not exist"#)
    );
}

// contract: window-close.surfaces.closed-once
#[test]
fn a_surface_that_the_sync_removes_is_not_closed_again_by_the_window_close() {
    let hosts = Mutex::new(HashMap::from([
        ("tab-1".to_string(), 100),
        ("tab-2".to_string(), 200),
    ]));
    let alive = HashSet::from(["tab-1".to_string()]);
    let removed = take_removed_surfaces(&hosts, &alive).unwrap();
    assert_eq!(removed, vec![("tab-2".to_string(), 200)]);
    // The window close that runs before the sync closes the removed handle takes the remaining surfaces.
    let remaining = std::mem::take(&mut *hosts.lock().unwrap());
    assert_eq!(
        remaining,
        HashMap::from([("tab-1".to_string(), 100)]),
        "the window close received a surface whose handle the sync closes"
    );
}

// contract: surfaces.sync.name-outlives-native-surface
#[test]
fn a_removed_surface_keeps_its_name_until_its_native_surface_is_closed() {
    let named = Mutex::new(HashMap::from([(7usize, "tab-1".to_string())]));
    let mut named_at_close = None;
    close_named_surface(&named, 7, |handle| {
        // A reading of the native surfaces of the window that sees the surface still finds its name.
        named_at_close = Some(named.lock().unwrap().get(&handle).cloned());
        Ok(())
    })
    .unwrap();
    assert_eq!(named_at_close, Some(Some("tab-1".to_string())));
    assert!(
        named.lock().unwrap().is_empty(),
        "the name outlived the native surface"
    );
    // A failed close still forgets the name of the surface, and the failure is returned.
    let named = Mutex::new(HashMap::from([(8usize, "tab-2".to_string())]));
    let failed = close_named_surface(&named, 8, |_| Err("close failed".to_string()));
    assert_eq!(failed, Err("close failed".to_string()));
    assert!(named.lock().unwrap().is_empty());
}

// contract: surfaces.sync.name-outlives-native-surface
#[test]
fn a_created_surface_has_its_name_when_its_native_surface_exists() {
    let named = Mutex::new(HashMap::new());
    let handle = create_named_surface(&named, "tab-3", || Ok(9)).unwrap();
    assert_eq!(handle, 9);
    assert_eq!(named.lock().unwrap().get(&9), Some(&"tab-3".to_string()));
    // A failed creation names nothing and states the surface.
    let failed = create_named_surface(&named, "tab-4", || Err("no window".to_string()));
    assert_eq!(failed, Err("surface tab-4: create: no window".to_string()));
    let nil = create_named_surface(&named, "tab-5", || Ok(0));
    assert_eq!(
        nil,
        Err("surface tab-5: create returned a nil handle".to_string())
    );
    assert_eq!(named.lock().unwrap().len(), 1);
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
