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
