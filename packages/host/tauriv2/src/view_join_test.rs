//! The view join of the presentation wait (docs/spec/plugin-processes.md, rule 6).

use super::{PresentationWait, ViewPlacement};
use std::sync::Arc;

const SURFACE: &str = "probe-surface";
const GENERATION: u64 = 4;

fn placement(x: f64) -> ViewPlacement {
    ViewPlacement {
        frame: [x, 20.0, 300.0, 200.0],
        visible: true,
    }
}

// contract: view.presentation-wait.joins
#[test]
fn changed_unsettled_placement_joins_and_old_callback_cannot_end_new_wait() {
    let presentation = Arc::new(PresentationWait::default());
    let mut callbacks: Vec<(u64, Box<dyn FnOnce()>)> = Vec::new();

    // The first placement is joined while its layout ticket is still open.
    let first_ticket = 20;
    let first = placement(10.0);
    assert!(presentation.needs_join(SURFACE, GENERATION, first));
    assert!(presentation.begin(SURFACE, GENERATION, first_ticket));
    let first_wait = Arc::clone(&presentation);
    callbacks.push((
        first_ticket,
        Box::new(move || {
            first_wait
                .end(SURFACE, GENERATION, first_ticket, "presented")
                .unwrap();
        }),
    ));
    presentation.commit([(SURFACE.to_string(), GENERATION, first)]);

    // A changed placement in a newer, unsettled ticket must join without waiting for ticket 20's callback.
    let second_ticket = 21;
    let changed = placement(40.0);
    assert!(presentation.needs_join(SURFACE, GENERATION, changed));
    assert!(presentation.begin(SURFACE, GENERATION, second_ticket));
    let second_wait = Arc::clone(&presentation);
    callbacks.push((
        second_ticket,
        Box::new(move || {
            second_wait
                .end(SURFACE, GENERATION, second_ticket, "presented")
                .unwrap();
        }),
    ));
    presentation.commit([(SURFACE.to_string(), GENERATION, changed)]);

    let (_, old_callback) = callbacks.remove(0);
    old_callback();
    assert!(presentation.waits(SURFACE, GENERATION, second_ticket));

    let (_, current_callback) = callbacks.remove(0);
    current_callback();
    assert!(!presentation.waits(SURFACE, GENERATION, second_ticket));
    assert!(!presentation.needs_join(SURFACE, GENERATION, changed));
}

// contract: view.presentation-wait.joins
#[test]
fn a_cancelled_ticket_removes_its_wait_before_a_later_layout() {
    let presentation = PresentationWait::default();
    let first_ticket = 31;
    let second_ticket = 32;
    assert!(presentation.begin(SURFACE, GENERATION, first_ticket));
    assert_eq!(presentation.abandon_ticket(first_ticket), Ok(()));
    assert!(!presentation.waits(SURFACE, GENERATION, first_ticket));
    let changed = placement(50.0);
    assert!(presentation.needs_join(SURFACE, GENERATION, changed));
    assert!(presentation.begin(SURFACE, GENERATION, second_ticket));
    assert!(presentation.waits(SURFACE, GENERATION, second_ticket));
}
