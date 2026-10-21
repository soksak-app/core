//! Checks the sliding window of the view failures (docs/spec/plugin-processes.md, rule 5, pass value (vi)).

use std::time::{Duration, Instant};

use super::ViewLifecycle;

use crate::surfaces::ViewStart;

/// Returns the instant that is the given number of seconds after start, so each failure of a test has a fixed time.
fn seconds_after(start: Instant, seconds: u64) -> Instant {
    start + Duration::from_secs(seconds)
}

// contract: host.view.killed.is-written-on-every-end
#[test]
fn a_view_end_stores_host_view_killed_with_its_plugin_and_surface() {
    use serde_json::json;
    let lifecycle = ViewLifecycle::default();
    // A view that ends by a kill (its process ended) and a view that ends with its surface (a close).
    lifecycle.track(
        "end-kill",
        7,
        "probe",
        "ui/page.html",
        true,
        ViewStart::default(),
    );
    lifecycle.record_end("end-kill");
    lifecycle.track(
        "end-close",
        8,
        "probe",
        "ui/page.html",
        true,
        ViewStart::default(),
    );
    lifecycle.record_end("end-close");
    lifecycle.forget("end-close");
    // A surface without a view stores nothing, and a view that already ended stores nothing again.
    lifecycle.record_end("end-untracked");
    lifecycle.record_end("end-close");
    lifecycle.record_end("end-kill");
    let stored: Vec<serde_json::Value> = crate::event_record::buffered_fields("host.view.killed")
        .into_iter()
        .filter(|fields| {
            fields["surface"] == "end-kill"
                || fields["surface"] == "end-close"
                || fields["surface"] == "end-untracked"
        })
        .collect();
    assert_eq!(
        stored,
        vec![
            json!({"plugin": "probe", "surface": "end-kill", "unsent": true}),
            json!({"plugin": "probe", "surface": "end-close", "unsent": true}),
        ]
    );
}

// contract: view.restart.limit
#[test]
fn view_restart_window_slides_past_old_failures() {
    // The failure at 0 seconds is out of the window at 350 seconds, so the failures at 100, 200, 350 and 360 seconds are the four
    // within the window at 360 seconds.
    let lifecycle = ViewLifecycle::default();
    let start = Instant::now();
    lifecycle.track(
        "probe-surface",
        7,
        "probe",
        "ui/page.html",
        true,
        ViewStart::default(),
    );
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

// contract: view.start-values.first-script
#[test]
fn view_restart_keeps_the_start_values_of_its_record() {
    use serde_json::json;
    let lifecycle = ViewLifecycle::default();
    let start = ViewStart {
        params: Some(json!({"path": "a.md"})),
        ..Default::default()
    };
    lifecycle.track(
        "probe-surface",
        7,
        "probe",
        "ui/page.html",
        true,
        start.clone(),
    );
    assert_eq!(
        lifecycle
            .spec("probe-surface")
            .expect("the record is kept")
            .start,
        start,
        "the record keeps the start values, which the host injects again when it creates the view again"
    );
}
