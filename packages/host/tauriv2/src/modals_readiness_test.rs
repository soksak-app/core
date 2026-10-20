//! Checks the readiness rules of the open modal record: a ready request shows a modal once, the visible flag is set before
//! the request is answered, and a ready request for a modal that is not open is an error.

use super::{Modal, Overlay, mark_visible, pending_show};

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
    assert!(pending_show(&overlay, "debug", 1).unwrap().is_some());
    mark_visible(&overlay, "debug", 1).unwrap();
    assert_eq!(overlay.open_state().map(|s| s.2), Some(true));
    *overlay.open.lock().unwrap() = None;
    open(&overlay, "debug", 2);
    assert!(pending_show(&overlay, "debug", 2).unwrap().is_some());
    mark_visible(&overlay, "debug", 2).unwrap();
    assert_eq!(
        overlay.open_state().map(|s| s.2),
        Some(true),
        "the second modal is not visible after its ready request"
    );
}

// contract: modal.ready-visible
#[test]
fn ready_for_a_modal_that_is_not_open_is_an_error() {
    let overlay = Overlay::default();
    assert!(
        pending_show(&overlay, "debug", 1).is_err(),
        "no modal is open"
    );
    open(&overlay, "debug", 2);
    assert!(
        pending_show(&overlay, "debug", 1).is_err(),
        "a replaced instance was answered"
    );
    assert!(
        pending_show(&overlay, "settings", 2).is_err(),
        "another id was answered"
    );
    assert!(mark_visible(&overlay, "debug", 1).is_err());
    assert_eq!(overlay.open_state().map(|s| s.2), Some(false));
}

// contract: modal.ready-visible
#[test]
fn a_failed_show_leaves_the_modal_pending_for_the_next_ready() {
    let overlay = Overlay::default();
    open(&overlay, "debug", 3);
    assert!(pending_show(&overlay, "debug", 3).unwrap().is_some());
    assert_eq!(overlay.open_state().map(|s| s.2), Some(false));
    assert!(
        pending_show(&overlay, "debug", 3).unwrap().is_some(),
        "a modal that is not visible is shown again"
    );
    mark_visible(&overlay, "debug", 3).unwrap();
    assert!(
        pending_show(&overlay, "debug", 3).unwrap().is_none(),
        "a visible modal is not shown again"
    );
}
