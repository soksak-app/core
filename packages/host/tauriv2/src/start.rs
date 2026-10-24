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

/// The start document that holds the workspace snapshot and the window button reply.
pub fn start_document(workspace: &Value, controls: &Value) -> Result<Vec<u8>, String> {
    #[derive(serde::Serialize)]
    struct Document<'a> {
        workspace: &'a Value,
        controls: &'a Value,
    }
    serde_json::to_vec(&Document {
        workspace,
        controls,
    })
    .map_err(|error| error.to_string())
}

/// Runs the page cleanup and its detach barriers before constructing a successful start document.
pub(crate) fn after_page_started<P, D>(
    page_started: impl FnOnce() -> Result<P, String>,
    document: impl FnOnce() -> Result<D, String>,
) -> Result<(P, D), String> {
    let state = page_started()?;
    let document = document()?;
    Ok((state, document))
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
    let (detachments, document) = after_page_started(
        || crate::windows::page_started(&window),
        || {
            let snapshot = crate::workspace::handle(
                app,
                serde_json::from_value(serde_json::json!({ "kind": "snapshot" }))
                    .map_err(|error| error.to_string())?,
            )?;
            // The first draw of the page does not wait for readiness, so the title bar is first set to the height of that first
            // row, and then the controls are read.
            // (docs/spec/native-surfaces.md#title-bar-height).
            let common = snapshot
                .get("common")
                .filter(|common| common.is_object())
                .ok_or("the workspace snapshot has no common settings")?;
            crate::windows::start_titlebar(&window, common)?;
            let controls = serde_json::to_value(crate::windows::window_chrome(&window)?)
                .map_err(|error| error.to_string())?;
            start_document(&snapshot, &controls)
        },
    )?;
    crate::windows::window_data(&window)?
        .images
        .complete_detachments(&detachments);
    Ok(document)
}

#[cfg(test)]
#[path = "start_test.rs"]
mod start_tests;
