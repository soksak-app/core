//! Tests of the launch activation of the GPUI adapter (docs/spec/hosts.md#launch-activation).
//!
//! GPUI activates no application when it finishes launching (gpui-pre-macos did_finish_launching sets only the
//! activation policy), so the adapter decides the activation by the calls that its own sources make.

/// The body of the function that starts at the text start in source, up to the closing brace at its own indentation.
fn body<'a>(source: &'a str, start: &str) -> &'a str {
    let at = source
        .find(start)
        .unwrap_or_else(|| panic!("{start} is missing"));
    let indent = &start[..start.len() - start.trim_start().len()];
    let end = source[at..]
        .find(&format!("\n{indent}}}\n"))
        .expect("the block ends");
    &source[at..at + end]
}

// contract: application.launch.system-decides-activation
#[test]
fn the_application_leaves_the_launch_activation_to_the_system() {
    // The start of the adapter and the window creation call no activation of the application; only the focus of a window
    // that a person requests activates it.
    for source in [
        include_str!("../src/host.rs"),
        include_str!("../src/framework.rs"),
    ] {
        assert!(
            !source.contains("activate("),
            "a launch source activates the application"
        );
    }
    let platform = include_str!("../src/platform/darwin/darwin.rs");
    let activations: Vec<_> = platform.match_indices("activate()").collect();
    assert_eq!(
        activations.len(),
        1,
        "the platform activates the application outside the focus of a window"
    );
    assert!(body(platform, "pub(crate) fn focus_window").contains("app.activate()"));
}

// contract: application.window.opens-without-taking-the-front
#[test]
fn a_window_opens_hidden_and_shows_through_the_show_of_the_host() {
    // GPUI orders a window front when it opens with show; the adapter opens it hidden and the show of the host library
    // applies the rule of the front application.
    let framework = include_str!("../src/framework.rs");
    // Every window of the adapter, the main window and each window that a page opens, opens through open_window.
    assert!(body(framework, "fn open_window(").contains("show: false,"));
    let frontend = include_str!("../src/frontend.rs");
    let show = body(frontend, "    fn show(&self)");
    assert!(
        show.contains("system.show_window(window)"),
        "show does not call the show of the host: {show}"
    );
    assert!(
        !show.contains("orderFront"),
        "show orders the window front: {show}"
    );
}
