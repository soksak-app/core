//! Checks the readiness rules of the open modal record: a ready request shows a modal once, the visible flag is set before
//! the request is answered, and a ready request for a modal that is not open is stale and changes nothing.

use super::{Modal, Overlay, ReadyStep, mark_visible, ready_step};

fn open(overlay: &Overlay, id: &str, instance: u64) {
    *overlay.open.lock().unwrap() = Some(Modal {
        id: id.into(),
        instance,
        ..Modal::default()
    });
}

// contract: modal.ready-visible
#[test]
fn ready_after_a_reopen_leaves_the_second_modal_visible() {
    let overlay = Overlay::default();
    open(&overlay, "debug", 1);
    assert!(matches!(
        ready_step(&overlay, "debug", 1).unwrap(),
        ReadyStep::Show { .. }
    ));
    mark_visible(&overlay, "debug", 1).unwrap();
    assert_eq!(overlay.open_state().map(|s| s.2), Some(true));
    *overlay.open.lock().unwrap() = None;
    open(&overlay, "debug", 2);
    assert!(matches!(
        ready_step(&overlay, "debug", 2).unwrap(),
        ReadyStep::Show { .. }
    ));
    mark_visible(&overlay, "debug", 2).unwrap();
    assert_eq!(
        overlay.open_state().map(|s| s.2),
        Some(true),
        "the second modal is not visible after its ready request"
    );
}

// contract: modal.ready-visible
#[test]
fn ready_for_a_modal_that_is_not_open_is_stale_and_changes_nothing() {
    let overlay = Overlay::default();
    assert_eq!(
        ready_step(&overlay, "debug", 1).unwrap(),
        ReadyStep::Stale,
        "no modal is open"
    );
    open(&overlay, "debug", 2);
    assert_eq!(
        ready_step(&overlay, "debug", 1).unwrap(),
        ReadyStep::Stale,
        "a replaced instance was not stale"
    );
    assert_eq!(
        ready_step(&overlay, "settings", 2).unwrap(),
        ReadyStep::Stale,
        "another id was not stale"
    );
    assert_eq!(overlay.open_state().map(|s| s.2), Some(false));
    mark_visible(&overlay, "debug", 2).unwrap();
    assert_eq!(
        ready_step(&overlay, "debug", 1).unwrap(),
        ReadyStep::Stale,
        "a stale request of a replaced instance was not stale"
    );
    assert_eq!(
        overlay.open_state().map(|s| s.2),
        Some(true),
        "a stale request changed the visible flag of the open modal"
    );
}

// contract: modal.ready-visible
#[test]
fn a_failed_show_leaves_the_modal_pending_for_the_next_ready() {
    let overlay = Overlay::default();
    open(&overlay, "debug", 3);
    assert!(matches!(
        ready_step(&overlay, "debug", 3).unwrap(),
        ReadyStep::Show { .. }
    ));
    assert_eq!(overlay.open_state().map(|s| s.2), Some(false));
    assert!(
        matches!(
            ready_step(&overlay, "debug", 3).unwrap(),
            ReadyStep::Show { .. }
        ),
        "a modal that is not visible is shown again"
    );
    mark_visible(&overlay, "debug", 3).unwrap();
    assert_eq!(
        ready_step(&overlay, "debug", 3).unwrap(),
        ReadyStep::Visible,
        "a visible modal is shown again"
    );
}
