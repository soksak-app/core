//! The presentation wait of views (docs/spec/plugin-processes.md, rule 6). The same cases run in the Go host.

use serde_json::json;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{PresentationWait, ViewPlacement, presentation_abandoned_payload};
use crate::event_record::buffered_fields;

const SURFACE: &str = "presentation-probe-surface";
const GENERATION: u64 = 7;
const TICKET: u64 = 11;
/// The surface of the abandon checks, which write abandoned records while the other checks read theirs.
const ABANDON_SURFACE: &str = "presentation-abandon-surface";

fn placement(frame: [f64; 4], visible: bool) -> ViewPlacement {
    ViewPlacement { frame, visible }
}

/// The fields of each buffered abandoned-presentation record of the surface.
fn abandoned_of_surface() -> Vec<serde_json::Value> {
    buffered_fields("host.trace.view.presentation-abandoned")
        .into_iter()
        .filter(|fields| fields["surface"] == SURFACE)
        .collect()
}

// contract: view.presentation-wait.ends
#[test]
fn a_view_joins_once_for_a_changed_visible_placement_or_generation() {
    let wait = PresentationWait::default();
    let first = placement([10.0, 20.0, 300.0, 200.0], true);
    assert!(wait.needs_join(SURFACE, GENERATION, first));
    wait.commit([(SURFACE.to_string(), GENERATION, first)]);
    assert!(!wait.needs_join(SURFACE, GENERATION, first));
    assert!(!wait.needs_join(SURFACE, GENERATION, placement(first.frame, false)));
    assert!(wait.needs_join(
        SURFACE,
        GENERATION,
        placement([11.0, 20.0, 300.0, 200.0], true)
    ));
    assert!(wait.needs_join(SURFACE, GENERATION + 1, first));
    wait.commit([(
        SURFACE.to_string(),
        GENERATION,
        placement(first.frame, false),
    )]);
    assert!(wait.needs_join(SURFACE, GENERATION, first));
}

// contract: view.presentation-wait.joins
#[test]
fn waits_are_keyed_by_surface_generation_and_ticket() {
    let wait = PresentationWait::default();
    assert!(wait.begin(SURFACE, GENERATION, TICKET));
    assert!(!wait.begin(SURFACE, GENERATION, TICKET));
    assert!(wait.begin(SURFACE, GENERATION, TICKET + 1));
    assert!(wait.begin(SURFACE, GENERATION + 1, TICKET));
    assert!(wait.waits(SURFACE, GENERATION, TICKET));
    assert_eq!(
        wait.end(SURFACE, GENERATION, TICKET, "presented"),
        Ok(false)
    );
    assert!(wait.waits(SURFACE, GENERATION, TICKET + 1));
    assert!(wait.waits(SURFACE, GENERATION + 1, TICKET));
}

// contract: view.presentation-wait.ends
#[test]
fn each_end_without_presentation_writes_the_abandoned_event() {
    for reason in ["process-ended", "hidden", "unresponsive"] {
        let wait = PresentationWait::default();
        wait.begin(SURFACE, GENERATION, TICKET);
        let before = abandoned_of_surface().len();
        assert_eq!(wait.end(SURFACE, GENERATION, TICKET, reason), Ok(true));
        let written = abandoned_of_surface();
        assert_eq!(written.len(), before + 1);
        assert_eq!(
            written.last(),
            Some(&json!({"surface": SURFACE, "reason": reason}))
        );
        assert_eq!(wait.end(SURFACE, GENERATION, TICKET, reason), Ok(false));
    }
}

// contract: view.presentation-wait.ends
#[test]
fn a_presentation_ends_the_exact_wait_without_an_abandoned_event() {
    let wait = PresentationWait::default();
    wait.begin(SURFACE, GENERATION, TICKET);
    let before = buffered_fields("host.trace.view.presentation-abandoned").len();
    assert_eq!(
        wait.end(SURFACE, GENERATION, TICKET, "presented"),
        Ok(false)
    );
    assert_eq!(
        buffered_fields("host.trace.view.presentation-abandoned").len(),
        before
    );
    assert!(wait.end(SURFACE, GENERATION, TICKET, "timeout").is_err());
}

// contract: view.presentation-wait.joins
#[test]
fn lifecycle_ends_abandon_only_the_matching_native_joins() {
    for reason in ["process-ended", "hidden", "unresponsive"] {
        let wait = PresentationWait::default();
        let abandons = Arc::new(AtomicUsize::new(0));
        let counted = abandons.clone();
        wait.begin(ABANDON_SURFACE, GENERATION, TICKET);
        assert!(wait.attach_abandon(
            ABANDON_SURFACE,
            GENERATION,
            TICKET,
            Box::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        ));
        assert_eq!(
            wait.end(ABANDON_SURFACE, GENERATION, TICKET, reason),
            Ok(true)
        );
        assert_eq!(
            abandons.load(Ordering::SeqCst),
            1,
            "the end {reason} abandons once"
        );
    }
}

// contract: view.presentation-wait.joins
#[test]
fn a_presentation_does_not_abandon_the_native_join() {
    let wait = PresentationWait::default();
    let abandons = Arc::new(AtomicUsize::new(0));
    let counted = abandons.clone();
    wait.begin(SURFACE, GENERATION, TICKET);
    wait.attach_abandon(
        SURFACE,
        GENERATION,
        TICKET,
        Box::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    );
    assert_eq!(
        wait.end(SURFACE, GENERATION, TICKET, "presented"),
        Ok(false)
    );
    assert_eq!(abandons.load(Ordering::SeqCst), 0);
}

// contract: view.presentation-wait.ends
#[test]
fn cancellation_removes_only_its_ticket_before_abandoning_the_native_join() {
    let wait = Arc::new(PresentationWait::default());
    let abandons = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&abandons);
    let wait_for_abandon = Arc::clone(&wait);
    wait.begin(SURFACE, GENERATION, TICKET);
    wait.begin(SURFACE, GENERATION, TICKET + 1);
    assert!(wait.attach_abandon(
        SURFACE,
        GENERATION,
        TICKET,
        Box::new(move || {
            assert!(!wait_for_abandon.waits(SURFACE, GENERATION, TICKET));
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    ));
    let before = abandoned_of_surface().len();
    assert_eq!(wait.abandon_ticket(TICKET), Ok(()));
    assert!(!wait.waits(SURFACE, GENERATION, TICKET));
    assert!(wait.waits(SURFACE, GENERATION, TICKET + 1));
    assert_eq!(abandons.load(Ordering::SeqCst), 1);
    assert_eq!(abandoned_of_surface().len(), before);
}

// contract: view.presentation-wait.joins
#[test]
fn window_reload_removes_all_waits_before_abandoning_each_native_join() {
    let wait = Arc::new(PresentationWait::default());
    let abandons = Arc::new(AtomicUsize::new(0));
    for (surface, ticket) in [("reload-first-surface", 51), ("reload-second-surface", 52)] {
        assert!(wait.begin(surface, GENERATION, ticket));
        let wait_for_abandon = Arc::clone(&wait);
        let counted = Arc::clone(&abandons);
        assert!(wait.attach_abandon(
            surface,
            GENERATION,
            ticket,
            Box::new(move || {
                assert!(!wait_for_abandon.waits("reload-first-surface", GENERATION, 51));
                assert!(!wait_for_abandon.waits("reload-second-surface", GENERATION, 52));
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        ));
    }
    assert_eq!(wait.abandon_all(), Ok(()));
    assert_eq!(abandons.load(Ordering::SeqCst), 2);
    assert!(wait.needs_join(
        "reload-first-surface",
        GENERATION,
        ViewPlacement {
            frame: [0.0; 4],
            visible: true
        },
    ));
}

// contract: view.presentation-wait.ends
#[test]
fn the_abandoned_notice_names_the_surface_and_the_reason() {
    assert_eq!(
        presentation_abandoned_payload(SURFACE, "hidden"),
        json!({"surface": SURFACE, "reason": "hidden"})
    );
}
