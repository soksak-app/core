//! The host calls that still run when a reload of a page ends before its page reported ready (docs/spec/native-host.md#page-reload).
//! The same cases run in the Go host.

use std::time::{Duration, Instant};

use soksak_host::running_calls::{RunningCalls, reload_end_text};

// contract: reload.ends-by-ready-close-or-process-end
#[test]
fn a_reload_that_ends_before_ready_names_its_end_and_the_host_calls_of_its_window_that_still_run() {
    let calls = RunningCalls::default();
    let at = Instant::now();
    let save = calls.begin("main", "debug_save_all", at);
    calls.begin("main", "log", at + Duration::from_secs(94));
    let other = calls.begin("project-window-1", "workspace", at);
    let now = at + Duration::from_millis(94_700);
    assert_eq!(
        reload_end_text("the window closed", &calls.of("main", now)),
        "the window closed before the reloaded page reported ready; running host calls: debug_save_all 94.7s, log 0.7s"
    );
    calls.end(save);
    calls.end(other);
    assert_eq!(
        reload_end_text("the page process ended", &calls.of("main", now)),
        "the page process ended before the reloaded page reported ready; running host calls: log 0.7s"
    );
    assert_eq!(
        reload_end_text("the window closed", &calls.of("project-window-1", now)),
        "the window closed before the reloaded page reported ready; running host calls: none"
    );
}
