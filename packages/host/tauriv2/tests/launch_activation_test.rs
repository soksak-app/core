//! Checks the launch activation of the application (docs/spec/hosts.md#launch-activation).

use soksak_host_tauriv2::launch_activates_ignoring_other_apps;

// contract: application.launch.system-decides-activation
#[test]
fn the_application_leaves_the_launch_activation_to_the_system() {
    assert!(
        !launch_activates_ignoring_other_apps(),
        "the application activates itself when it finishes launching, so a launch that requested no activation takes the focus"
    );
}

// contract: application.window.opens-without-taking-the-front
#[test]
fn a_window_shows_through_the_show_of_the_host() {
    // A Tauri window needs an event loop on a display, and tao orders every window that it shows front, so the frontend
    // names the call that it makes. window_show_test and window_show_order_test of the native library check that call.
    let frontend = include_str!("../src/frontend.rs");
    let start = frontend.find("fn show(&self)").expect("the frontend has show");
    let body = &frontend[start..start + frontend[start..].find("\n    }").expect("show ends")];
    assert!(
        body.contains("platform::show_window(&self.window)"),
        "show does not call the show of the host: {body}"
    );
    assert!(
        !body.contains("self.window.show()"),
        "show orders the window front: {body}"
    );
}
