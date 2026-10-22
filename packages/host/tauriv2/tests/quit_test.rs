//! The quit state ends when a page keeps a modified tab (docs/spec/hosts.md#process-lifecycle).

use soksak_host_tauriv2::quit::Quit;

// contract: quit.cancel.ends-the-quit-state
#[test]
fn a_cancelled_quit_ends_the_quit_state() {
    let quit = Quit::default();
    assert!(!quit.active(), "a new quit state is active");
    quit.begin();
    quit.begin();
    assert!(quit.active(), "the quit state is not active after it began");
    quit.cancel();
    quit.cancel();
    assert!(
        !quit.active(),
        "the quit state is active after it was cancelled"
    );
}

// contract: quit.request.begins-the-quit-state
// A quit request begins the quit state before it runs the quit, so a page process end during a quit request that has no ready window
// writes no error line (docs/spec/hosts.md#process-lifecycle).
#[test]
fn a_quit_request_without_a_ready_window_begins_the_quit_state() {
    let quit = Quit::default();
    let mut requested = false;
    quit.request(|| requested = true);
    assert!(requested, "the quit request did not run the quit");
    assert!(
        soksak_host_tauriv2::page_process::page_process_ended("main", quit.active()).is_none(),
        "the end of a page process during a quit request is written"
    );
}

// contract: quit.request.begins-the-quit-state
// The operating system quit request begins the quit state when no ready window exists, and it reports that the application quits at once.
#[test]
fn an_operating_system_quit_without_a_ready_window_begins_the_quit_state_and_quits_at_once() {
    let quit = Quit::default();
    assert!(
        quit.begin_quit_request(0),
        "a quit request without a ready window does not quit at once"
    );
    assert!(
        quit.active(),
        "a quit request without a ready window does not begin the quit state"
    );
}
