//! Checks that a poisoned lock of the reported paths is recovered and a missing file is still reported once.

use std::borrow::Cow;
use std::sync::{Arc, Mutex, PoisonError};

use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Wry};

use super::ReportingAssets;

/// Serves no file.
struct Empty;

impl Assets<Wry> for Empty {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
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
fn a_poisoned_report_lock_still_reports_a_missing_file_once() {
    let reported = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&reported);
    let assets = ReportingAssets::<Wry>::new(
        Box::new(Empty),
        Box::new(move |path| {
            sink.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(path.to_string())
        }),
    );
    poison(&assets.reported);
    let key = AssetKey::from("/missing.js");
    assert!(assets.get(&key).is_none(), "a missing file was served");
    assert!(assets.get(&key).is_none(), "a missing file was served");
    assert_eq!(
        *reported.lock().unwrap_or_else(PoisonError::into_inner),
        ["/missing.js"],
        "the missing file was not reported once while the report lock was poisoned"
    );
}
