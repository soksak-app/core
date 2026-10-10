//! Commands of the diagnostic build (docs/spec/cli.md). The sok of a regular build has no diagnostic methods.

use serde_json::Value;

use crate::{compact, Request};

/// A capture request. It writes the screen of the window to an image file without bringing the window to the front.
pub(crate) fn capture(window: String) -> Request {
    Request {
        method: "diagnostics.capture.still",
        params: Some(compact(vec![("window", Some(Value::String(window)))])),
        watch: false,
        field: None,
    }
}
