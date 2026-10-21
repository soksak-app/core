//! Checks the sliding window of the view failures (docs/plans/plugin-processes.md, rule 5, pass value (vi)).

use std::time::{Duration, Instant};

use super::ViewLifecycle;

/// Returns the instant that is the given number of seconds after start, so each failure of a test has a fixed time.
fn seconds_after(start: Instant, seconds: u64) -> Instant {
    start + Duration::from_secs(seconds)
}

// contract: view.restart.limit
#[test]
fn view_restart_window_slides_past_old_failures() {
    // The failure at 0 seconds is out of the window at 350 seconds, so the failures at 100, 200, 350 and 360 seconds are the four
    // within the window at 360 seconds.
    let lifecycle = ViewLifecycle::default();
    let start = Instant::now();
    lifecycle.track("probe-surface", 7, "probe", "ui/page.html", true);
    for seconds in [0, 100, 200] {
        assert!(lifecycle.fail("probe-surface", seconds_after(start, seconds)));
    }
    assert!(
        lifecycle.fail("probe-surface", seconds_after(start, 350)),
        "the failure at 350 seconds restarts, because the failure at 0 seconds is out of the window"
    );
    assert!(
        !lifecycle.fail("probe-surface", seconds_after(start, 360)),
        "the failures at 100, 200, 350 and 360 seconds are four within 300 seconds"
    );
}
