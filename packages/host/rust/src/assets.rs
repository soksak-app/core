//! A request for a page file that the host cannot serve is reported once for its path (docs/spec/diagnostics.md).

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::{Mutex, PoisonError};

/// The page files of the application, by the path of a file (`/index.html`). A framework adapter serves them.
pub trait Assets: Send + Sync {
    /// The bytes of the file at key, when the files hold it.
    fn get(&self, key: &str) -> Option<Cow<'_, [u8]>>;
}

/// Wraps the page files of the application. `report` receives the path of each file that the wrapped files do not
/// hold, once for each path; a path without a file extension is a document route and is not reported.
pub struct ReportingAssets {
    inner: Box<dyn Assets>,
    report: Box<dyn Fn(&str) + Send + Sync>,
    reported: Mutex<HashSet<String>>,
}

impl ReportingAssets {
    pub fn new(inner: Box<dyn Assets>, report: Box<dyn Fn(&str) + Send + Sync>) -> Self {
        Self {
            inner,
            report,
            reported: Mutex::new(HashSet::new()),
        }
    }
}

impl ReportingAssets {
    /// The bytes of the file at key, which reports nothing. A framework adapter uses it for a lookup that is not a request
    /// of the page.
    pub fn held(&self, key: &str) -> Option<Cow<'_, [u8]>> {
        self.inner.get(key)
    }
}

impl Assets for ReportingAssets {
    fn get(&self, key: &str) -> Option<Cow<'_, [u8]>> {
        let found = self.inner.get(key);
        if found.is_none() && std::path::Path::new(key).extension().is_some() {
            let first = self
                .reported
                .lock()
                // default: a lock that a panicking thread poisoned still holds the reported paths, which the report
                // amends; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .insert(key.to_string());
            if first {
                (self.report)(key);
            }
        }
        found
    }
}

#[cfg(test)]
#[path = "assets_lock_test.rs"]
mod lock_test;
