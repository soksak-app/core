//! Tests of the poisoned-lock helpers of the frontend and of the logged response and file helpers of the page assets.

use std::sync::{Arc, Mutex, RwLock};

use soksak_host::assets::Assets;

use super::frontend::{locked, read_locked, write_locked};
use super::{StagedFrontend, logged_response};

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_mutex_yields_the_value_it_stored_to_locked() {
    let mutex = Arc::new(Mutex::new(vec![1, 2, 3]));
    let clone = Arc::clone(&mutex);
    let panicked = std::thread::spawn(move || {
        let _guard = clone.lock().unwrap();
        panic!("poison the mutex for the test");
    })
    .join();
    assert!(
        panicked.is_err(),
        "the thread must panic while it holds the lock"
    );
    assert!(
        mutex.is_poisoned(),
        "the mutex must be poisoned before locked runs"
    );
    assert_eq!(*locked(&mutex, "test"), vec![1, 2, 3]);
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_table_yields_its_value_to_read_locked_and_write_locked() {
    let table = Arc::new(RwLock::new(String::from("kept")));
    let clone = Arc::clone(&table);
    let panicked = std::thread::spawn(move || {
        let _guard = clone.write().unwrap();
        panic!("poison the table for the test");
    })
    .join();
    assert!(
        panicked.is_err(),
        "the thread must panic while it holds the write lock"
    );
    assert!(
        table.is_poisoned(),
        "the table must be poisoned before the helpers run"
    );
    assert_eq!(*read_locked(&table, "test"), "kept");
    write_locked(&table, "test").push('!');
    assert_eq!(*read_locked(&table, "test"), "kept!");
}

// contract: gpuikit.page-files.failed-response-is-500
#[test]
fn a_response_builder_error_is_answered_with_500() {
    let built = http::Response::builder()
        .header("bad\nname", "value")
        .body(Vec::new());
    assert!(
        built.is_err(),
        "a header name with a line break must fail the builder"
    );
    let response = logged_response("/index.html", built);
    assert_eq!(response.status(), http::StatusCode::INTERNAL_SERVER_ERROR);
}

// contract: gpuikit.page-files.reads-the-staged-frontend
#[test]
fn a_missing_file_is_a_miss_and_an_unreadable_path_is_a_logged_miss() {
    let folder = std::env::temp_dir().join(format!("gpuikit-locking-test-{}", std::process::id()));
    std::fs::create_dir_all(folder.join("directory")).expect("the test folder can be created");
    let staged = StagedFrontend::new(folder.clone());
    assert!(
        staged.get("missing.js").is_none(),
        "a missing file is a miss"
    );
    assert!(
        staged.get("directory").is_none(),
        "a directory is read as an error, which is logged and answered as a miss"
    );
    std::fs::remove_dir_all(&folder).expect("the test folder can be removed");
}
