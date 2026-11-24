//! Tests of the page files and the start document that the app and soksak schemes of the GPUI framework adapter serve.

use std::sync::{Arc, OnceLock, mpsc};

use soksak_host::assets::Assets as _;

/// A folder with the staged index document of a page.
fn staged_folder() -> tempfile::TempDir {
    let folder = tempfile::tempdir().expect("a temporary folder is created");
    std::fs::write(folder.path().join("index.html"), b"<!doctype html>")
        .expect("the index document is written");
    folder
}

// contract: gpuikit.page-files.reads-the-staged-frontend
#[test]
fn the_staged_frontend_reads_a_file_by_its_page_path() {
    let folder = staged_folder();
    let frontend = super::StagedFrontend::new(folder.path().to_path_buf());
    assert_eq!(
        frontend.get("/index.html").as_deref(),
        Some(&b"<!doctype html>"[..]),
        "the page path /index.html names index.html of the staged folder"
    );
}

/// The library reads the core files of the bundled frontend by their name without the leading separator
/// (`modules/@soksak/plugin-api/view-start.js`, `core-root.json`), as the asset key of Tauri accepts it.
// contract: gpuikit.page-files.reads-the-staged-frontend
#[test]
fn the_staged_frontend_reads_a_file_named_without_the_leading_separator() {
    let folder = staged_folder();
    let frontend = super::StagedFrontend::new(folder.path().to_path_buf());
    assert_eq!(
        frontend.get("index.html").as_deref(),
        Some(&b"<!doctype html>"[..]),
        "the name index.html names index.html of the staged folder"
    );
}

// contract: gpuikit.page-files.reads-the-staged-frontend
#[test]
fn the_root_address_serves_the_index_document() {
    let folder = staged_folder();
    let frontend = super::StagedFrontend::new(folder.path().to_path_buf());
    let response = super::page_file(&frontend, "/");
    assert_eq!(
        response.status(),
        http::StatusCode::OK,
        "body: {}",
        String::from_utf8_lossy(response.body())
    );
    assert_eq!(response.body(), b"<!doctype html>");
}

// contract: gpuikit.page-files.reads-the-staged-frontend
#[test]
fn the_installed_plugin_list_is_served_at_its_page_path() {
    let folder = staged_folder();
    let configuration = tempfile::tempdir().expect("a temporary configuration folder is created");
    let installed_directory = Arc::new(OnceLock::new());
    installed_directory.get_or_init(|| configuration.path().to_path_buf());
    let assets = soksak_host::page_assets(
        Arc::new(super::StagedFrontend::new(folder.path().to_path_buf())),
        installed_directory,
    );
    let response = super::page_file(&assets, "/installed-plugins.json");
    assert_eq!(
        response.status(),
        http::StatusCode::OK,
        "body: {}",
        String::from_utf8_lossy(response.body())
    );
}

// contract: gpuikit.start.answers-the-document-of-its-web-view
#[test]
fn a_start_document_request_is_answered_with_the_document_of_its_web_view() {
    let (sender, receiver) = mpsc::channel();
    let address: http::Uri = "soksak://core/start.json"
        .parse()
        .expect("the start address parses");
    super::answer_start(
        &address,
        "main".to_string(),
        |webview| Ok(format!("{{\"window\":\"{webview}\"}}").into_bytes()),
        move |response| {
            sender
                .send(response)
                .expect("the test receives the response")
        },
    );
    let response = receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the start document is answered");
    assert_eq!(
        response.status(),
        200,
        "body: {}",
        String::from_utf8_lossy(response.body())
    );
    assert_eq!(response.body(), b"{\"window\":\"main\"}");
}
