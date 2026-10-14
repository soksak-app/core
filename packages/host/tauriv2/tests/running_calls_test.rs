//! The host calls that still run when a reload of a page times out (docs/spec/native-host.md#page-reload). The same cases run
//! in the Go host.

use std::time::{Duration, Instant};

use soksak_host_tauriv2::running_calls::{RunningCalls, reload_timeout_text};

// contract: reload.timeout.names-running-calls
#[test]
fn a_reload_that_times_out_names_the_host_calls_of_its_window_that_still_run() {
    let calls = RunningCalls::default();
    let at = Instant::now();
    let save = calls.begin("main", "debug_save_all", at);
    calls.begin("main", "log", at + Duration::from_secs(94));
    let other = calls.begin("project-window-1", "workspace", at);
    let now = at + Duration::from_millis(94_700);
    assert_eq!(
        reload_timeout_text(Duration::from_secs(10), &calls.of("main", now)),
        "the reloaded page did not report ready within 10s; running host calls: debug_save_all 94.7s, log 0.7s"
    );
    calls.end(save);
    calls.end(other);
    assert_eq!(
        reload_timeout_text(Duration::from_secs(10), &calls.of("main", now)),
        "the reloaded page did not report ready within 10s; running host calls: log 0.7s"
    );
    assert_eq!(
        reload_timeout_text(Duration::from_secs(10), &calls.of("project-window-1", now)),
        "the reloaded page did not report ready within 10s; running host calls: none"
    );
}
