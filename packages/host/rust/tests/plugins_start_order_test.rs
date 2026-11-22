//! The update at start begins after the setup added the plugins state (docs/spec/installation.md#update-at-start). A start of
//! the update in an application without that state is refused on the calling thread, and no thread panics.

// The test framework of the library names the framework and the menu of the host through these paths.
mod framework {
    pub use soksak_host::framework::*;
}
mod menu {
    pub use soksak_host::menu::*;
}
#[path = "support/framework.rs"]
#[allow(dead_code)]
mod test_framework;

// contract: plugins.start-update.refused-without-plugins-state
#[test]
fn a_start_of_the_update_without_the_plugins_state_is_refused_without_a_thread() {
    let app = test_framework::application();
    soksak_host::manage_start_state(&app);
    match soksak_host::start_plugin_updates(&app) {
        Ok(thread) => panic!(
            "the update started a thread without the plugins state; the thread ended with {}",
            if thread.join().is_err() {
                "a panic"
            } else {
                "no panic"
            }
        ),
        Err(error) => assert_eq!(
            error,
            "the update at start requires the plugins state, which the setup adds"
        ),
    }
}
