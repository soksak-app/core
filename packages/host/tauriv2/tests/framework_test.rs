//! Checks the framework port of the Tauri framework adapter (docs/spec/hosts.md#mygo-host).

use std::borrow::Cow;
use std::sync::{Arc, Mutex};

use soksak_host::assets::{Assets, ReportingAssets};
use soksak_host::framework::WindowEvent;
use soksak_host_tauriv2::{Framework, Frontend, PageLookups};

fn implements_framework<T: soksak_host::Framework>() {}
fn implements_frontend<T: soksak_host::Frontend>() {}

// The build of the tests fails when the adapter does not implement the framework port.
const _: fn() = || {
    implements_framework::<Framework>();
    implements_frontend::<Frontend>();
};

// contract: application.framework.names-the-application
#[test]
fn the_tauri_framework_names_the_application_of_the_endpoint() {
    assert_eq!(
        soksak_host::Framework::application_name(&Framework),
        "tauriv2"
    );
    assert_eq!(soksak_host::Framework::display_name(&Framework), "Tauri v2");
}

// contract: application.framework.window-events-are-port-events
#[test]
fn each_window_event_of_tauri_is_an_event_of_the_frontend() {
    let size = tauri::PhysicalSize::new(1, 2);
    let position = tauri::PhysicalPosition::new(3, 4);
    assert_eq!(
        soksak_host_tauriv2::window_event(&tauri::WindowEvent::Resized(size)),
        Some(WindowEvent::Resized)
    );
    assert_eq!(
        soksak_host_tauriv2::window_event(&tauri::WindowEvent::Moved(position)),
        Some(WindowEvent::Moved)
    );
    assert!(matches!(
        soksak_host_tauriv2::window_event(&tauri::WindowEvent::Focused(true)),
        Some(WindowEvent::Focused(true))
    ));
    assert!(matches!(
        soksak_host_tauriv2::window_event(&tauri::WindowEvent::Focused(false)),
        Some(WindowEvent::Focused(false))
    ));
    assert!(matches!(
        soksak_host_tauriv2::window_event(&tauri::WindowEvent::Destroyed),
        Some(WindowEvent::Destroyed)
    ));
}

/// The page of the Tauri start document comes from the page origin of the adapter (docs/spec/native-host.md#page-start).
// contract: page.start.requires-window
#[test]
fn the_start_document_answers_the_page_origin_of_tauri() {
    let response = soksak_host::start::serve(
        soksak_host_tauriv2::PAGE_ORIGIN,
        soksak_host::start::CORE,
        soksak_host::start::START_DOCUMENT_PATH,
        "main",
        &mut |_| Ok(vec![]),
    );
    assert_eq!(
        response.headers()["Access-Control-Allow-Origin"],
        "tauri://localhost"
    );
}

/// The page files of the lookup tests: `present.js` and the start document.
struct PageFiles;

impl Assets for PageFiles {
    fn get(&self, key: &str) -> Option<Cow<'_, [u8]>> {
        match key {
            "/present.js" => Some(Cow::Borrowed(&b"ok"[..])),
            "/index.html" => Some(Cow::Borrowed(&b"<html>"[..])),
            _ => None,
        }
    }
}

// The asset resolver looks up `<path>.html` and `<path>/index.html` after a path that it does not find, and those two
// lookups are not requests of the page.
// contract: assets.missing.writes-one-error-line-for-each-path
#[test]
fn the_lookups_after_a_missing_path_are_not_requests_of_the_page() {
    let reported = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = reported.clone();
    let lookups = PageLookups::new(ReportingAssets::new(
        Box::new(PageFiles),
        Box::new(move |path| sink.lock().unwrap().push(path.to_string())),
    ));
    for path in [
        "/present.js",
        "/missing.js",
        "/missing.js.html",
        "/missing.js/index.html",
        "/missing.js",
        "/other.css",
        "/other.css.html",
        "/other.css/index.html",
        "/page.html",
        "/page.html.html",
        "/page.html/index.html",
        "/",
        "/no-extension",
    ] {
        let _ = lookups.get(path);
    }
    assert_eq!(
        *reported.lock().unwrap(),
        ["/missing.js", "/other.css", "/page.html"]
    );
}

// contract: assets.missing.does-not-answer-with-the-start-document
#[test]
fn a_missing_file_is_not_answered_with_the_start_document() {
    let lookups = PageLookups::new(ReportingAssets::new(Box::new(PageFiles), Box::new(|_| {})));
    let get = |path: &str| lookups.get(path).is_some();
    // The asset resolver looks up `<path>`, `<path>.html`, `<path>/index.html` and then the start document.
    assert!(!get("/missing.js"));
    assert!(!get("/missing.js.html"));
    assert!(!get("/missing.js/index.html"));
    assert!(
        !get("/index.html"),
        "the start document answered a missing file"
    );
    // The start document and a document route are served.
    assert!(get("/index.html"), "the start document is not served");
    assert!(!get("/route"));
    assert!(!get("/route.html"));
    assert!(!get("/route/index.html"));
    assert!(
        get("/index.html"),
        "the start document is not served as the fallback of a route"
    );
    assert!(get("/present.js"));
}

// contract: binding.reply.absent-value-is-null
#[test]
fn a_binding_call_without_a_value_replies_null() {
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    // A command result is serialized by IpcResponse, so no value and a null value reply the JSON value null.
    let replies = [
        ().body().unwrap(),
        serde_json::Value::Null.body().unwrap(),
        None::<String>.body().unwrap(),
    ];
    for reply in replies {
        match reply {
            InvokeResponseBody::Json(text) => assert_eq!(text, "null"),
            InvokeResponseBody::Raw(bytes) => panic!("raw reply of {} bytes", bytes.len()),
        }
    }
}

// contract: installed.shared.serve-extension-point-modules
#[test]
fn the_web_view_protocol_serves_a_shared_module_as_javascript() {
    // The protocol of the webview takes the MIME type from the path, so the path of a shared module ends in .js.
    assert_eq!(
        tauri::utils::mime_type::MimeType::parse(
            b"export const state = 1;",
            "/shared/alpha.language/@codemirror/state.js"
        ),
        "text/javascript"
    );
}
