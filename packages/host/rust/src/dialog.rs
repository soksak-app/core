//! The dialogs of the windows whose host.dialog an endpoint client watches (docs/spec/exposure.md#dialogs).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The kinds of a dialog request.
pub const SAVE: &str = "save";
pub const FOLDER: &str = "folder";
pub const OPEN: &str = "open";
pub const DOWNLOAD: &str = "download";

/// A dialog that a window asks for while a client watches its host.dialog.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub id: String,
    pub kind: String,
    #[serde(rename = "suggestedName")]
    pub suggested_name: Option<String>,
    pub directory: Option<String>,
    pub multiple: bool,
    pub directories: bool,
    pub url: Option<String>,
}

/// The answer of input.dialog.answer.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Answer {
    pub id: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub cancel: bool,
    #[serde(default)]
    pub replace: bool,
}

/// The dialog requests of the windows whose host.dialog a client watches.
pub struct Dialogs {
    #[allow(dead_code)]
    changed: Box<dyn Fn(&str, Value) + Send + Sync>,
}

impl Dialogs {
    /// Creates the dialogs of the host. changed receives each new value of host.dialog of a window.
    pub fn new(changed: impl Fn(&str, Value) + Send + Sync + 'static) -> Self {
        Dialogs {
            changed: Box::new(changed),
        }
    }

    /// Records the start (on) or the end of the watch of host.dialog of window.
    pub fn watched(&self, _window: &str, _on: bool) {}

    /// The value of host.dialog of window.
    pub fn value(&self, _window: &str) -> Value {
        json!({ "pending": [] })
    }

    /// Answers a request of window.
    pub fn answer(&self, window: &str, answer: Answer) -> Result<(), String> {
        Err(format!(
            "dialog: no request {} waits in {window}",
            answer.id
        ))
    }

    /// Asks for request in window: panel shows the person's panel.
    pub fn ask(
        &self,
        _window: &str,
        _request: Request,
        panel: impl FnOnce() -> Result<Option<Vec<String>>, String>,
    ) -> Result<Option<Vec<String>>, String> {
        panel()
    }
}

/// The choice that answer gives request.
pub fn choice(_request: &Request, answer: &Answer) -> Result<Vec<String>, String> {
    Ok(answer.paths.clone())
}

#[cfg(test)]
#[path = "dialog_test.rs"]
mod dialog_test;
