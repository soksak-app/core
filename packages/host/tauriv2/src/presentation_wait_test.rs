//! The presentation wait of views (docs/plans/plugin-processes.md, rule 6). The same cases run in the Go host.

use serde_json::json;

use super::PresentationWait;
use crate::event_record::buffered_fields;

const SURFACE: &str = "presentation-probe-surface";

/// The fields of each buffered abandoned-presentation record of the surface.
fn abandoned_of_surface() -> Vec<serde_json::Value> {
    buffered_fields("host.trace.view.presentation-abandoned")
        .into_iter()
        .filter(|fields| fields["surface"] == SURFACE)
        .collect()
}

// contract: view.presentation-wait.ends
#[test]
fn a_view_joins_the_presentation_wait_once_per_change() {
    let wait = PresentationWait::default();
    assert!(
        wait.begin(SURFACE),
        "the first join of the view joins the wait"
    );
    assert!(
        !wait.begin(SURFACE),
        "a second join of the waiting view does not join again"
    );
}

// contract: view.presentation-wait.ends
#[test]
fn each_end_without_presentation_writes_the_abandoned_event() {
    for reason in ["process-ended", "hidden", "unresponsive"] {
        let wait = PresentationWait::default();
        wait.begin(SURFACE);
        let before = abandoned_of_surface().len();
        assert_eq!(
            wait.end(SURFACE, reason),
            Ok(true),
            "the end {reason} ends the wait without presentation"
        );
        let written = abandoned_of_surface();
        assert_eq!(
            written.len(),
            before + 1,
            "the end {reason} writes one abandoned event"
        );
        assert_eq!(
            written.last(),
            Some(&json!({"surface": SURFACE, "reason": reason}))
        );
        assert_eq!(
            wait.end(SURFACE, reason),
            Ok(false),
            "a second end {reason} ends nothing"
        );
    }
}

// contract: view.presentation-wait.ends
#[test]
fn a_presentation_ends_the_wait_without_an_abandoned_event() {
    let wait = PresentationWait::default();
    wait.begin("presentation-presented-surface");
    let before = buffered_fields("host.trace.view.presentation-abandoned").len();
    assert_eq!(
        wait.end("presentation-presented-surface", "presented"),
        Ok(false)
    );
    assert_eq!(
        buffered_fields("host.trace.view.presentation-abandoned").len(),
        before,
        "a presentation writes no abandoned event"
    );
    assert!(
        wait.end(SURFACE, "timeout").is_err(),
        "a reason that is not an end is refused"
    );
}
