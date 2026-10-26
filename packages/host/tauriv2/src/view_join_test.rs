//! The view join of the presentation wait (docs/spec/plugin-processes.md, rule 6).

use super::{PresentationWait, ViewPlacement, trace_presentation_join};
use crate::event_record::buffered_fields;
use std::sync::Arc;

const SURFACE: &str = "probe-surface";
const GENERATION: u64 = 4;
const JOIN_TICKET: u64 = 11;

fn placement(x: f64) -> ViewPlacement {
    ViewPlacement {
        frame: [x, 20.0, 300.0, 200.0],
        visible: true,
    }
}

struct PerformanceTraceGuard;

impl Drop for PerformanceTraceGuard {
    fn drop(&mut self) {
        if let Err(error) = crate::performance::command(serde_json::json!({"action": "off"})) {
            eprintln!("turning off the performance trace after the test failed: {error}");
        }
    }
}

// contract: view.presentation-wait.join-trace
#[test]
fn presentation_join_trace_records_exact_wait_identity_and_nonpresentation_end() {
    const TRACE: &str = "host.trace.view.presentation-join";
    crate::performance::command(serde_json::json!({"action": "on"})).unwrap();
    let _trace_guard = PerformanceTraceGuard;
    let wait = PresentationWait::default();
    let before = buffered_fields(TRACE).len();
    assert!(wait.begin(SURFACE, GENERATION, JOIN_TICKET));
    assert_eq!(
        buffered_fields(TRACE)[before..],
        [serde_json::json!({
            "phase": "requested",
            "surface": SURFACE,
            "generation": GENERATION,
            "ticket": JOIN_TICKET
        })]
    );

    assert_eq!(
        wait.end(SURFACE, GENERATION, JOIN_TICKET, "hidden"),
        Ok(true)
    );
    assert_eq!(
        buffered_fields(TRACE)[before + 1..],
        [serde_json::json!({
            "phase": "abandoned",
            "surface": SURFACE,
            "generation": GENERATION,
            "ticket": JOIN_TICKET,
            "reason": "hidden"
        })]
    );
}

// contract: view.presentation-wait.join-trace
#[test]
fn held_and_late_native_callbacks_keep_their_exact_join_identity() {
    const TRACE: &str = "host.trace.view.presentation-join";
    crate::performance::command(serde_json::json!({"action": "on"})).unwrap();
    let _trace_guard = PerformanceTraceGuard;
    let wait = Arc::new(PresentationWait::default());
    let before = buffered_fields(TRACE).len();
    let mut callbacks: Vec<Box<dyn FnOnce()>> = Vec::new();

    assert!(wait.begin(SURFACE, GENERATION, JOIN_TICKET));
    trace_presentation_join("result", SURFACE, GENERATION, JOIN_TICKET, Some(true), None);
    let callback_wait = Arc::clone(&wait);
    callbacks.push(Box::new(move || {
        trace_presentation_join("presented", SURFACE, GENERATION, JOIN_TICKET, None, None);
        assert_eq!(
            callback_wait.end(SURFACE, GENERATION, JOIN_TICKET, "presented"),
            Ok(false)
        );
    }));
    assert_eq!(
        buffered_fields(TRACE).len(),
        before + 2,
        "a held callback must not be recorded early"
    );
    callbacks.remove(0)();

    let late_ticket = JOIN_TICKET + 1;
    assert!(wait.begin(SURFACE, GENERATION, late_ticket));
    trace_presentation_join("result", SURFACE, GENERATION, late_ticket, Some(true), None);
    assert_eq!(
        wait.end(SURFACE, GENERATION, late_ticket, "hidden"),
        Ok(true)
    );
    let late_wait = Arc::clone(&wait);
    callbacks.push(Box::new(move || {
        trace_presentation_join("presented", SURFACE, GENERATION, late_ticket, None, None);
        assert_eq!(
            late_wait.end(SURFACE, GENERATION, late_ticket, "presented"),
            Ok(false)
        );
    }));
    callbacks.remove(0)();

    let records = buffered_fields(TRACE);
    let got = &records[before..];
    let phases: Vec<_> = got
        .iter()
        .map(|fields| fields["phase"].as_str().unwrap())
        .collect();
    assert_eq!(
        phases,
        [
            "requested",
            "result",
            "presented",
            "requested",
            "result",
            "abandoned",
            "presented"
        ]
    );
    for fields in got {
        assert_eq!(fields["surface"], SURFACE);
        assert_eq!(fields["generation"], GENERATION);
    }
    assert_eq!(got[0]["ticket"], JOIN_TICKET);
    assert_eq!(got[1]["joined"], true);
    assert_eq!(got[2]["ticket"], JOIN_TICKET);
    assert_eq!(got[3]["ticket"], late_ticket);
    assert_eq!(got[4]["joined"], true);
    assert_eq!(got[5]["ticket"], late_ticket);
    assert_eq!(got[5]["reason"], "hidden");
    assert_eq!(got[6]["ticket"], late_ticket);
}

// contract: view.presentation-wait.join-trace
#[test]
fn synchronous_native_callback_precedes_the_join_result() {
    const TRACE: &str = "host.trace.view.presentation-join";
    crate::performance::command(serde_json::json!({"action": "on"})).unwrap();
    let _trace_guard = PerformanceTraceGuard;
    let wait = PresentationWait::default();
    let before = buffered_fields(TRACE).len();
    assert!(wait.begin(SURFACE, GENERATION, JOIN_TICKET));
    trace_presentation_join("presented", SURFACE, GENERATION, JOIN_TICKET, None, None);
    assert_eq!(
        wait.end(SURFACE, GENERATION, JOIN_TICKET, "presented"),
        Ok(false)
    );
    trace_presentation_join("result", SURFACE, GENERATION, JOIN_TICKET, Some(true), None);

    let records = buffered_fields(TRACE);
    let phases: Vec<_> = records[before..]
        .iter()
        .map(|fields| fields["phase"].as_str().unwrap())
        .collect();
    assert_eq!(phases, ["requested", "presented", "result"]);
    for fields in &records[before..] {
        assert_eq!(fields["surface"], SURFACE);
        assert_eq!(fields["generation"], GENERATION);
        assert_eq!(fields["ticket"], JOIN_TICKET);
    }
    assert_eq!(records[before + 2]["joined"], true);
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
