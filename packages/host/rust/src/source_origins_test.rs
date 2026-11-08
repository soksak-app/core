use super::{ViewSourceOrigins, post_if_generation_current};

// contract: source-origin.atomic-snapshot-keeps-floor-and-only-current-sources
#[test]
fn the_atomic_origin_snapshot_keeps_the_floor_and_only_current_views() {
    let origins = ViewSourceOrigins::default();
    let old = origins
        .issue_view("surface")
        .expect("first origin is issued");
    let current = origins
        .issue_view("surface")
        .expect("replacement origin is issued");
    assert_eq!((old, current), (1, 2));
    assert!(
        !origins.end_view("surface", old),
        "a delayed end cannot remove the replacement"
    );

    let seeded = origins.snapshot();
    assert_eq!(seeded.floor, 2);
    assert_eq!(seeded.views.get("surface"), Some(&2));

    assert!(origins.end_view("surface", current));
    let ended = origins.snapshot();
    assert_eq!(
        ended.floor, 2,
        "ending a source does not lower the generation floor"
    );
    assert!(ended.views.is_empty());
}

// contract: source-origin.generation.javascript-safe-integer-limit
#[test]
fn issuing_a_generation_past_the_javascript_safe_integer_limit_changes_no_state() {
    let origins = ViewSourceOrigins::default();
    origins.lock().floor = 9_007_199_254_740_991;

    let result = origins.issue_view("surface");

    assert_eq!(
        result,
        Err("view source generation exceeds the JavaScript safe integer limit".into())
    );
    let snapshot = origins.snapshot();
    assert_eq!(snapshot.floor, 9_007_199_254_740_991);
    assert!(snapshot.views.is_empty());
}

// contract: view.source-generation
#[test]
fn an_old_generation_does_not_post_to_a_replacement_source() {
    let posts = std::cell::Cell::new(0);
    let stale = post_if_generation_current(
        1,
        Some(2),
        || true,
        || {
            posts.set(posts.get() + 1);
            Ok(true)
        },
    );
    assert_eq!(stale, Ok(false));
    assert_eq!(
        posts.get(),
        0,
        "stale generation reached the replacement source"
    );

    let current = post_if_generation_current(
        2,
        Some(2),
        || true,
        || {
            posts.set(posts.get() + 1);
            Ok(true)
        },
    );
    assert_eq!(current, Ok(true));
    assert_eq!(
        posts.get(),
        1,
        "current generation was not posted exactly once"
    );
}

// contract: sidecars.window-send.absence-ticket-ends-with-its-request
#[test]
fn canceled_background_ticket_unregisters_without_invalidating_other_calls() {
    let origins = super::ViewSourceOrigins::default();
    let keep = origins.background_ticket("keep").unwrap();
    let canceled = origins.background_ticket("cancel").unwrap();
    assert_eq!(origins.pending_background_calls(), 2);
    drop(canceled);
    assert_eq!(origins.pending_background_calls(), 1);
    assert!(keep.lease().is_ok());
    drop(keep);
    assert_eq!(origins.pending_background_calls(), 0);
}
