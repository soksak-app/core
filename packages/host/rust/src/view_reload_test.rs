//! The reload of the view of a tab (core.tab.reload, docs/spec/native-surfaces.md#view-surfaces): the reload keeps the view
//! record and counts no failure, a reset clears the restart stop, and a tab without a view record is refused with its id.

use std::time::{Duration, Instant};

use crate::view_lifecycle::{VIEW_RESTART_LIMIT, ViewLifecycle};

/// Returns the instant that is the given number of seconds after start, so each failure of a test has a fixed time.
fn seconds_after(start: Instant, seconds: u64) -> Instant {
    start + Duration::from_secs(seconds)
}

// contract: view.reload.restarts-once
// A reload of a ready view keeps its record and counts no failure: only the failures after it count toward the stop.
#[test]
fn reloading_a_ready_view_keeps_its_record_and_counts_no_failure() {
    let lifecycle = ViewLifecycle::default();
    lifecycle.track(
        "ready-reload",
        7,
        "probe",
        "ui/page.html",
        true,
        Default::default(),
    );
    lifecycle.reset("ready-reload");
    assert!(
        crate::documents::reload_record(&lifecycle, "ready-reload").is_ok(),
        "the reload of a ready view found no record to create the view from"
    );
    let start = Instant::now();
    for step in 0..VIEW_RESTART_LIMIT - 1 {
        lifecycle.fail("ready-reload", seconds_after(start, step as u64));
    }
    assert!(
        !lifecycle.is_stopped("ready-reload"),
        "the reload counted as a failure of the view"
    );
    lifecycle.fail(
        "ready-reload",
        seconds_after(start, (VIEW_RESTART_LIMIT - 1) as u64),
    );
    assert!(
        lifecycle.is_stopped("ready-reload"),
        "the view failures after the reload did not stop the view"
    );
}

// contract: view.reload.clears-stop
#[test]
fn a_reset_clears_the_restart_stop_and_keeps_the_view_record() {
    let lifecycle = ViewLifecycle::default();
    lifecycle.track(
        "reload-probe",
        7,
        "probe",
        "ui/page.html",
        true,
        Default::default(),
    );
    let start = Instant::now();
    for step in 0..VIEW_RESTART_LIMIT {
        lifecycle.fail("reload-probe", seconds_after(start, step as u64));
    }
    assert!(
        lifecycle.is_stopped("reload-probe"),
        "the failures did not stop the restarts"
    );
    lifecycle.reset("reload-probe");
    assert!(
        !lifecycle.is_stopped("reload-probe"),
        "the reset kept the restart stop"
    );
    assert!(
        lifecycle.spec("reload-probe").is_some(),
        "the reset removed the view record that the view is created from"
    );
    assert!(
        lifecycle.fail("reload-probe", seconds_after(start, 10)),
        "a reset view was not allowed to be created again"
    );
}

// contract: view.reload.refuses-unknown-tab
#[test]
fn reloading_a_tab_without_a_view_record_is_refused_with_its_id() {
    let lifecycle = ViewLifecycle::default();
    let error = crate::documents::reload_record(&lifecycle, "missing-tab")
        .err()
        .expect("a tab without a view record was reloaded");
    assert_eq!(error, "tab missing-tab: no view to reload");
}
