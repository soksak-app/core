//! Checks that a poisoned write lock of the workspace is recovered and the workspace still answers.

use std::sync::{Mutex, PoisonError};

use serde_json::Value;

use super::{Request, Workspace};

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

fn request(kind: &str) -> Request {
    serde_json::from_str(&format!(r#"{{"kind": "{kind}"}}"#)).unwrap()
}

#[test]
fn the_workspace_answers_when_the_write_lock_is_poisoned() {
    let folder = crate::test_folder::Folder::new();
    let workspace = Workspace::new(folder.path().to_path_buf());
    poison(&workspace.writing);
    let answer = workspace.apply(request("tabState"));
    assert_eq!(
        answer.ok(),
        Some(Value::Null),
        "the workspace did not read the tab state while the write lock was poisoned"
    );
}
