//! The notices of the event log reach only the windows whose view follows the event files (docs/spec/debug.md#files). The same
//! cases run in the Go host.

use std::sync::Arc;

use crate::framework::{AppHandle, Manager, Window};
use crate::test_framework::{Fixture, FixtureFrontend};

use super::{
    FollowRequest, WindowData, Windows, debug_follow, following_windows, ready_window,
    register_records,
};

/// An application of the two windows "window-a" and "window-b", each with its records.
fn two_windows() -> (AppHandle, [Window; 2]) {
    let framework = Arc::new(Fixture::default());
    let app = AppHandle::new(framework.clone());
    let windows = Windows::default();
    let frontends = ["window-a", "window-b"].map(|name| {
        let frontend = Arc::new(FixtureFrontend::named(name));
        framework.add_window(frontend.clone());
        register_records(&windows, name, Arc::new(WindowData::default()));
        frontend
    });
    app.manage(windows);
    let handles = frontends.map(|frontend| app.window_of(frontend));
    (app, handles)
}

/// The labels of the windows that follow, in order.
fn following(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = following_windows(app)
        .iter()
        .map(|window| window.label().to_string())
        .collect();
    labels.sort();
    labels
}

// contract: debug.follow.notices-only-following-windows
//
// The delivery of a notice is a step of the main thread of a window, so a window whose view does not follow the event files
// receives none: a window follows from the call debugFollow {following: true} until the call with false.
#[test]
fn a_notice_reaches_only_the_windows_that_follow() {
    let (app, windows) = two_windows();
    assert!(
        following(&app).is_empty(),
        "a window follows before it asked"
    );
    debug_follow(&windows[0], FollowRequest { following: true }).unwrap();
    assert_eq!(following(&app), ["window-a"]);
    debug_follow(&windows[0], FollowRequest { following: false }).unwrap();
    assert!(
        following(&app).is_empty(),
        "a window that stopped still follows"
    );
}

// contract: debug.follow.notices-only-following-windows
//
// A page that reports ready is a new document, which has not asked to follow the event files, so the ready of its window
// (ready_window, the start of window_ready) ends the following of that window and of no other.
#[test]
fn a_ready_page_starts_not_following() {
    let (app, windows) = two_windows();
    for window in &windows {
        debug_follow(window, FollowRequest { following: true }).unwrap();
    }
    let data = ready_window(&windows[0]).unwrap();
    assert!(
        data.ready.load(std::sync::atomic::Ordering::Relaxed),
        "the ready did not mark the page ready"
    );
    assert_eq!(
        following(&app),
        ["window-b"],
        "the windows that follow after the ready of window-a"
    );
}

// contract: debug.follow.refuses-a-request-without-a-boolean
#[test]
fn debug_follow_refuses_a_request_without_a_boolean() {
    for (request, want) in [
        (
            serde_json::json!({}),
            "argument request.following is missing",
        ),
        (
            serde_json::json!({"following": null}),
            "argument request.following is missing",
        ),
        (
            serde_json::json!({"following": "yes"}),
            "argument request.following must be a boolean, not a string",
        ),
    ] {
        let arguments = serde_json::json!({ "request": request });
        let body = crate::framework::InvokeBody::Json(&arguments);
        let refused = crate::arguments::Argument::<FollowRequest>::from_body(
            "debug_follow",
            "request",
            &body,
        )
        .err()
        .unwrap_or_else(|| panic!("debugFollow {request} was accepted"));
        assert_eq!(refused, want, "debugFollow {request}");
    }
}
