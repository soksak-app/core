//! The start document of the main page (docs/spec/native-host.md#page-start). The page fetches this document as a
//! module graph so that it draws its first screen before its first await, and the host starts the page before it
//! answers this request.

use serde_json::Value;
use tauri::http::Response;
use tauri::{AppHandle, Manager};

use crate::application_log::log_error;

/// The scheme of application documents inside webviews (docs/spec/native-host.md#application-addresses). A custom
/// scheme handler, which knows the requesting webview, answers the start document at soksak://core/start.json.
pub const SCHEME: &str = "soksak";

/// The owner of core documents in sok addresses.
pub const CORE: &str = "core";

/// The path through which the main page fetches the start document.
pub const START_DOCUMENT_PATH: &str = "/start.json";

/// The origin of the main page. The page fetches documents of other schemes with CORS.
pub const PAGE_ORIGIN: &str = "tauri://localhost";

/// The error when the requesting webview is not the main webview of any window.
pub const NO_WINDOW: &str = "the start document request names no window";

/// The start document that holds the workspace snapshot, or the error of the snapshot in its place, and the window button
/// reply.
pub fn start_document(
    workspace: &Result<Value, String>,
    controls: &Value,
    pending_surfaces: &[String],
) -> Result<Vec<u8>, String> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Document<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace: Option<&'a Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
        controls: &'a Value,
        pending_surfaces: &'a [String],
    }
    let (workspace, error) = match workspace {
        Ok(workspace) => (Some(workspace), None),
        Err(error) => (None, Some(error.as_str())),
    };
    serde_json::to_vec(&Document {
        workspace,
        error,
        controls,
        pending_surfaces,
    })
    .map_err(|error| error.to_string())
}

/// The workspace part and the window button reply of a start document. The title bar is set to the first-row height of the
/// common settings of the snapshot before the controls are read (docs/spec/native-surfaces.md#title-bar-height). When the
/// snapshot fails, the title bar takes the height for absent settings and the snapshot error takes the place of the
/// workspace, so the page reserves the window button area before it shows the error (docs/spec/native-host.md#page-start).
pub(crate) fn start_parts(
    snapshot: Result<Value, String>,
    titlebar: impl FnOnce(&Value) -> Result<(), String>,
    controls: impl FnOnce() -> Result<Value, String>,
) -> Result<(Result<Value, String>, Value), String> {
    let workspace = snapshot.and_then(|snapshot| {
        if snapshot.get("common").is_some_and(Value::is_object) {
            Ok(snapshot)
        } else {
            Err("the workspace snapshot has no common settings".to_string())
        }
    });
    let absent = Value::Object(serde_json::Map::new());
    titlebar(
        workspace
            .as_ref()
            .map_or(&absent, |snapshot| &snapshot["common"]),
    )?;
    let controls = controls()?;
    Ok((workspace, controls))
}

/// Runs the page start, which sends the image detaches without waiting for them, then builds the parts of the document,
/// and reads the pending surfaces last, so a detach that ends later is told by its image-detach-ended event.
pub(crate) fn after_page_started(
    page_started: impl FnOnce() -> Result<(), String>,
    parts: impl FnOnce() -> Result<(Result<Value, String>, Value), String>,
    pending_surfaces: impl FnOnce() -> Result<Vec<String>, String>,
) -> Result<Vec<u8>, String> {
    page_started()?;
    let (workspace, controls) = parts()?;
    let pending = pending_surfaces()?;
    start_document(&workspace, &controls, &pending)
}

/// Passes a start document request to start with the label of the requesting webview. Another owner or path is not
/// found. When no window is found, it starts no page and answers 400; another failure answers 500.
pub fn serve(
    owner: &str,
    path: &str,
    webview: &str,
    start: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
) -> Response<Vec<u8>> {
    let failure = |status: u16, text: String| {
        Response::builder()
            .status(status)
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("Access-Control-Allow-Origin", PAGE_ORIGIN)
            .body(format!("{text}\n").into_bytes())
            // default: a response built from a fixed state and fixed headers does not fail, and when it fails, an empty
            // 500 response is used.
            .unwrap_or_else(|_| Response::new(vec![]))
    };
    if owner != CORE || path != START_DOCUMENT_PATH {
        return failure(404, format!("{SCHEME}://{owner}{path} not found"));
    }
    match start(webview) {
        Ok(data) => Response::builder()
            .status(200)
            .header("Content-Type", "application/json")
            .header("Cache-Control", "no-store")
            .header("Access-Control-Allow-Origin", PAGE_ORIGIN)
            .body(data)
            // default: a start document whose response could not be built records that error and answers with 500.
            .unwrap_or_else(|error| {
                log_error(START_DOCUMENT_PATH, &error);
                failure(500, error.to_string())
            }),
        Err(error) => {
            log_error(START_DOCUMENT_PATH, &error);
            failure(if error == NO_WINDOW { 400 } else { 500 }, error)
        }
    }
}

/// Starts the main page of the window whose main webview is webview and builds the start document of that window.
/// Before it answers, it leaves the window not ready, ends the requests sent to the previous page, and cleans up the
/// surface documents, image regions and modals of the previous page.
pub(crate) fn start_page(app: &AppHandle, webview: &str) -> Result<Vec<u8>, String> {
    let window = app
        .get_window(webview)
        .filter(|window| window.label() == webview)
        .ok_or_else(|| NO_WINDOW.to_string())?;
    after_page_started(
        || crate::windows::page_started(&window),
        || {
            let snapshot = serde_json::from_value(serde_json::json!({ "kind": "snapshot" }))
                .map_err(|error| error.to_string())
                .and_then(|request| crate::workspace::handle(app, request));
            // The first draw of the page does not wait for readiness, so the title bar is first set to the height of that first
            // row, and then the controls are read (docs/spec/native-surfaces.md#title-bar-height).
            start_parts(
                snapshot,
                |common| crate::windows::start_titlebar(&window, common),
                || {
                    serde_json::to_value(crate::windows::window_chrome(&window)?)
                        .map_err(|error| error.to_string())
                },
            )
        },
        || {
            Ok(crate::windows::window_data(&window)?
                .images
                .pending_detach_surfaces())
        },
    )
}

#[cfg(test)]
#[path = "start_test.rs"]
mod start_tests;
