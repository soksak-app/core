//! Checks that a poisoned state lock of the sidecar transport is recovered and the transport still answers.

use std::sync::{Mutex, PoisonError};

use serde_json::value::RawValue;

use super::{Failure, Message, Owner, Sidecars};

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
