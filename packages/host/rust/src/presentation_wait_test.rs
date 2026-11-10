//! The presentation wait of views (docs/spec/plugin-processes.md, rule 6). The same cases run in the Go host.

use serde_json::json;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{PresentationWait, ViewPlacement, presentation_abandoned_payload};
use crate::event_record::buffered_fields_of;

const SURFACE: &str = "presentation-probe-surface";
const GENERATION: u64 = 7;
const TICKET: u64 = 11;
/// The surface of the abandon checks, which write abandoned records while the other checks read theirs.
const ABANDON_SURFACE: &str = "presentation-abandon-surface";
/// A test that reads the abandoned records has a surface of its own, because the buffer holds the records of every test of the
/// binary (`buffered_fields_of`).
const EACH_END_SURFACE: &str = "presentation-each-end-surface";
const PRESENTED_SURFACE: &str = "presentation-presented-surface";
const CANCELLED_SURFACE: &str = "presentation-cancelled-surface";
const HIDDEN_SURFACE: &str = "presentation-hidden-surface";

fn placement(frame: [f64; 4], visible: bool) -> ViewPlacement {
    ViewPlacement { frame, visible }
}

/// The fields of each buffered abandoned-presentation record of the surface.
fn abandoned_of_surface(surface: &str) -> Vec<serde_json::Value> {
    buffered_fields_of("host.trace.view.presentation-abandoned", surface)
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
    let _trace = crate::performance::test_trace();
    for reason in ["process-ended", "hidden", "unresponsive", "input", "closed"] {
        let wait = PresentationWait::default();
        wait.begin(EACH_END_SURFACE, GENERATION, TICKET);
        let before = abandoned_of_surface(EACH_END_SURFACE).len();
        assert_eq!(
            wait.end(EACH_END_SURFACE, GENERATION, TICKET, reason),
            Ok(true)
        );
        let written = abandoned_of_surface(EACH_END_SURFACE);
        assert_eq!(written.len(), before + 1);
        assert_eq!(
            written.last(),
            Some(&json!({"surface": EACH_END_SURFACE, "reason": reason}))
        );
        assert_eq!(
            wait.end(EACH_END_SURFACE, GENERATION, TICKET, reason),
            Ok(false)
        );
    }
}

// contract: view.presentation-wait.ends
#[test]
fn a_presentation_ends_the_exact_wait_without_an_abandoned_event() {
    let _trace = crate::performance::test_trace();
    let wait = PresentationWait::default();
    wait.begin(PRESENTED_SURFACE, GENERATION, TICKET);
    let before = abandoned_of_surface(PRESENTED_SURFACE).len();
    assert_eq!(
        wait.end(PRESENTED_SURFACE, GENERATION, TICKET, "presented"),
        Ok(false)
    );
    assert_eq!(abandoned_of_surface(PRESENTED_SURFACE).len(), before);
    // Cancellation aborts its layout transaction (abandon_ticket), so it is not a reason that ends a wait.
    assert!(
        wait.end(PRESENTED_SURFACE, GENERATION, TICKET, "cancelled")
            .is_err()
    );
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

// contract: view.presentation-wait.ends, view.presentation-wait.cancel-clears-ticket
#[test]
fn cancellation_removes_only_its_ticket_before_abandoning_the_native_join() {
    let _trace = crate::performance::test_trace();
    let wait = Arc::new(PresentationWait::default());
    let abandons = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&abandons);
    let wait_for_abandon = Arc::clone(&wait);
    wait.begin(CANCELLED_SURFACE, GENERATION, TICKET);
    wait.begin(CANCELLED_SURFACE, GENERATION, TICKET + 1);
    assert!(wait.attach_abandon(
        CANCELLED_SURFACE,
        GENERATION,
        TICKET,
        Box::new(move || {
            assert!(!wait_for_abandon.waits(CANCELLED_SURFACE, GENERATION, TICKET));
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    ));
    let before = abandoned_of_surface(CANCELLED_SURFACE).len();
    assert_eq!(wait.abandon_ticket(TICKET), Ok(()));
    assert!(!wait.waits(CANCELLED_SURFACE, GENERATION, TICKET));
    assert!(wait.waits(CANCELLED_SURFACE, GENERATION, TICKET + 1));
    assert_eq!(abandons.load(Ordering::SeqCst), 1);
    assert_eq!(abandoned_of_surface(CANCELLED_SURFACE).len(), before);
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

// contract: view.presentation-wait.presented-before-end
// A presentation that completes on its native callback ends the wait as presented before a later hide: the hide ends no wait, writes
// no abandoned record and calls no native abandon, and the queued end of the presentation finds no wait.
#[test]
fn a_hide_after_a_presented_callback_ends_no_wait() {
    let _trace = crate::performance::test_trace();
    let wait = PresentationWait::default();
    let abandons = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&abandons);
    assert!(wait.begin(HIDDEN_SURFACE, GENERATION, TICKET));
    assert!(wait.attach_abandon(
        HIDDEN_SURFACE,
        GENERATION,
        TICKET,
        Box::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    ));
    wait.mark_presented(HIDDEN_SURFACE, GENERATION, TICKET);
    let abandoned_before =
        buffered_fields_of("host.trace.view.presentation-abandoned", HIDDEN_SURFACE).len();
    assert_eq!(
        wait.end(HIDDEN_SURFACE, GENERATION, TICKET, "hidden"),
        Ok(false)
    );
    assert!(!wait.waits(HIDDEN_SURFACE, GENERATION, TICKET));
    assert_eq!(abandons.load(Ordering::SeqCst), 0);
    assert_eq!(
        wait.end(HIDDEN_SURFACE, GENERATION, TICKET, "presented"),
        Ok(false)
    );
    let abandoned_after =
        buffered_fields_of("host.trace.view.presentation-abandoned", HIDDEN_SURFACE).len();
    assert_eq!(abandoned_after, abandoned_before);
}

// contract: view.presentation-wait.invisible-present-defers-end
// An invisible root placement is not joinable and ends no wait at presentation: the wait of the view stays open until the sync that
// applies the invisibility ends it.
#[test]
fn an_invisible_placement_is_not_joinable_and_leaves_its_wait_open() {
    let wait = PresentationWait::default();
    assert!(wait.begin(ABANDON_SURFACE, GENERATION, TICKET));
    let visible = placement([1.0, 2.0, 3.0, 4.0], true);
    let hidden = placement(visible.frame, false);
    assert!(
        wait.joinable(&[(ABANDON_SURFACE, Some(GENERATION), hidden)])
            .is_empty()
    );
    assert!(wait.waits(ABANDON_SURFACE, GENERATION, TICKET));
    assert_eq!(
        wait.joinable(&[
            (ABANDON_SURFACE, None, visible),
            (ABANDON_SURFACE, Some(GENERATION), visible),
        ]),
        vec![(ABANDON_SURFACE, GENERATION)]
    );
}

// contract: view.presentation-wait.ends-at-input
// A join that has not presented when a press or key event ends the hold ends with the reason input. The native join ended by
// itself, so the host abandons none, and the generation joins the next transaction: no wait ends by time
// (docs/spec/native-surfaces.md#layout-transaction).
#[test]
fn a_join_that_does_not_present_ends_at_input_and_its_generation_joins_again() {
    let wait = PresentationWait::default();
    let abandons = Arc::new(AtomicUsize::new(0));
    let counted = abandons.clone();
    assert!(wait.begin(ABANDON_SURFACE, GENERATION, TICKET));
    wait.attach_abandon(
        ABANDON_SURFACE,
        GENERATION,
        TICKET,
        Box::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    );
    assert_eq!(
        wait.end(ABANDON_SURFACE, GENERATION, TICKET, "input"),
        Ok(true)
    );
    assert_eq!(abandons.load(Ordering::SeqCst), 0);
    let moved = placement([40.0, 20.0, 300.0, 200.0], true);
    assert_eq!(
        wait.joinable(&[(ABANDON_SURFACE, Some(GENERATION), moved)]),
        vec![(ABANDON_SURFACE, GENERATION)]
    );
}

// contract: view.presentation-wait.ends-at-input
// An input end after the presentation changes nothing.
#[test]
fn an_input_end_after_the_presentation_changes_nothing() {
    let wait = PresentationWait::default();
    assert!(wait.begin(SURFACE, GENERATION, TICKET));
    wait.mark_presented(SURFACE, GENERATION, TICKET);
    assert_eq!(wait.end(SURFACE, GENERATION, TICKET, "input"), Ok(false));
}
