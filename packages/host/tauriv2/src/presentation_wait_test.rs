//! The presentation wait of views (docs/plans/plugin-processes.md, rule 6). The same cases run in the Go host.

use serde_json::json;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{PresentationWait, presentation_abandoned_payload};
use crate::event_record::buffered_fields;

const SURFACE: &str = "presentation-probe-surface";
/// The surface of the abandon checks, which write abandoned records while the other checks read theirs.
const ABANDON_SURFACE: &str = "presentation-abandon-surface";

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
        wait.begin(SURFACE, None),
        "the first join of the view joins the wait"
    );
    assert!(
        !wait.begin(SURFACE, None),
        "a second join of the waiting view does not join again"
    );
}

// contract: view.presentation-wait.ends
#[test]
fn each_end_without_presentation_writes_the_abandoned_event() {
    for reason in ["process-ended", "hidden", "unresponsive"] {
        let wait = PresentationWait::default();
        wait.begin(SURFACE, None);
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
    wait.begin("presentation-presented-surface", None);
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

// contract: view.presentation-wait.joins
#[test]
fn each_end_without_presentation_abandons_the_native_join_once() {
    for reason in ["process-ended", "hidden", "unresponsive"] {
        let wait = PresentationWait::default();
        let abandons = Arc::new(AtomicUsize::new(0));
        let counted = abandons.clone();
        wait.begin(
            ABANDON_SURFACE,
            Some(Box::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })),
        );
        assert_eq!(wait.end(ABANDON_SURFACE, reason), Ok(true));
        assert_eq!(
            abandons.load(Ordering::SeqCst),
            1,
            "the end {reason} abandons the native join once"
        );
    }
}

// contract: view.presentation-wait.joins
#[test]
fn a_presentation_does_not_abandon_the_native_join() {
    let wait = PresentationWait::default();
    let abandons = Arc::new(AtomicUsize::new(0));
    let counted = abandons.clone();
    wait.begin(
        "presentation-joined-surface",
        Some(Box::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })),
    );
    assert_eq!(
        wait.end("presentation-joined-surface", "presented"),
        Ok(false)
    );
    assert_eq!(
        abandons.load(Ordering::SeqCst),
        0,
        "the presentation does not abandon the native join"
    );
}

// contract: view.presentation-wait.joins
#[test]
fn the_abandoned_notice_names_the_surface_and_the_reason() {
    assert_eq!(
        presentation_abandoned_payload(SURFACE, "hidden"),
        json!({"surface": SURFACE, "reason": "hidden"}),
        "the notice of an abandoned presentation wait names its surface and reason"
    );
}
