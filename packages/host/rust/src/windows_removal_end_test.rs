//! Checks that a removal request ends by the end of the page that was asked (docs/spec/projects.md).

use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::framework::{AppHandle, Manager, Webview};
use crate::test_framework::FixtureFrontend;

use super::{WindowData, Windows, register_records};

/// An application with one ready window whose page receives the events of the window and can end.
fn asked_window() -> (AppHandle, Webview) {
    let (app, framework) = crate::test_framework::application_with_queue();
    let frontend = Arc::new(FixtureFrontend::with_page());
    framework.add_window(frontend.clone());
    let webview = app.webview_of(frontend, "fixture");
    let records = Arc::new(WindowData::default());
    records.ready.store(true, Ordering::Relaxed);
    let windows = Windows::default();
    register_records(&windows, "fixture", records);
    app.manage(windows);
    // The host manages the exposure records of every window, which the end of a page reaches.
    app.manage(crate::exposure::Exposure::default());
    (app, webview)
}

// A removal request ends by the answer of the asked window or by the end of its page.
// contract: project-removal.ask.ends-with-the-owner-page
#[test]
fn a_removal_request_ends_with_the_end_of_the_owner_page() {
    let (app, webview) = asked_window();
    let asked = app
        .state::<Windows>()
        .removals
        .begin("prj-one", "fixture")
        .unwrap();
    crate::web_content_process_terminated(&webview);
    assert_eq!(
        asked.try_recv(),
        Ok(true),
        "the page of the asked window ended, and the removal request still waits for its answer"
    );
}
