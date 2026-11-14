//! The service of an endpoint test whose judged behavior needs no page: it lists the windows that the test gives it as data
//! and has no page. A request that the endpoint relays to a page is an input that the test did not expect: the endpoint
//! receives an error for it, the service keeps the request, and the service fails the test when it is dropped.

#![allow(dead_code)]

use std::sync::Mutex;

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use soksak_host::endpoint::{Failure, ReplyScope, Service};

/// The code of the internal error, which the service answers for a request that no page takes.
const INTERNAL_ERROR: i64 = -32603;

/// The windows of the endpoint, each as its identifier and title, and the requests that reached the page.
pub struct TierService {
    windows: Vec<(String, String)>,
    unexpected: Mutex<Vec<String>>,
}

impl TierService {
    /// A service with the windows, each given as (identifier, title). The first window is the key window.
    pub fn new(windows: &[(&str, &str)]) -> TierService {
        TierService {
            windows: windows
                .iter()
                .map(|(window, title)| (window.to_string(), title.to_string()))
                .collect(),
            unexpected: Mutex::new(Vec::new()),
        }
    }
}

impl Service for TierService {
    fn windows(&self) -> Result<Value, Failure> {
        Ok(Value::Array(
            self.windows
                .iter()
                .enumerate()
                .map(|(index, (window, title))| {
                    json!({"window": window, "title": title, "project": null, "key": index == 0})
                })
                .collect(),
        ))
    }

    fn exists(&self, window: &str) -> bool {
        self.windows.iter().any(|(name, _)| name == window)
    }

    fn call(
        &self,
        window: &str,
        method: &str,
        _params: Map<String, Value>,
        _reply: Option<ReplyScope>,
    ) -> Result<Box<RawValue>, Failure> {
        self.unexpected
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .push(format!("{method} for {window}"));
        Err(Failure::new(
            INTERNAL_ERROR,
            format!("{method}: no page is attached to {window}"),
        ))
    }

    /// No test of this service watches a status, so no watch ends here.
    fn unwatched(&self, _window: &str, _name: &str) {}
}

impl Drop for TierService {
    fn drop(&mut self) {
        if std::thread::panicking() {
            return;
        }
        let unexpected = self
            .unexpected
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        assert!(
            unexpected.is_empty(),
            "requests reached a page that the test does not have: {unexpected:?}"
        );
    }
}
