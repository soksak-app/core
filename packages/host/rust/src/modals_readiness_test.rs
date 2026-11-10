//! Checks the readiness rules of the open modal record: a ready request shows a modal once, the visible flag is set before
//! the request is answered, and a ready request for a modal that is not open is stale and changes nothing. Checks the
//! wait of the input for a modal: it opens at the show and ends when the modal took the keyboard, closed or failed.

use super::{
    Modal, Overlay, ReadyStep, close_holding, is_modal_of, mark_visible, ready_step, show_holding,
    take_keyboard,
};

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

/// Records each step of a modal keyboard test by its name, and answers the step named in `fail` with an error.
struct Steps {
    taken: std::cell::RefCell<Vec<&'static str>>,
    fail: &'static str,
}

impl Steps {
    fn new(fail: &'static str) -> Self {
        Self {
            taken: Default::default(),
            fail,
        }
    }

    fn step(&self, name: &'static str) -> Result<(), String> {
        self.taken.borrow_mut().push(name);
        if name == self.fail {
            Err(format!("{name} failed"))
        } else {
            Ok(())
        }
    }

    fn taken(&self) -> Vec<&'static str> {
        self.taken.borrow().clone()
    }
}

// contract: modal.keyboard-hold
#[test]
fn the_input_waits_from_the_show_of_a_modal_until_it_takes_the_keyboard() {
    let steps = Steps::new("");
    show_holding(
        || steps.step("hold"),
        || steps.step("show"),
        || steps.step("discard"),
        || steps.step("end"),
    )
    .unwrap();
    assert_eq!(
        steps.taken(),
        vec!["hold", "show"],
        "the input waits from the show until the modal takes the keyboard"
    );
    take_keyboard(|| steps.step("focus"), || steps.step("end")).unwrap();
    assert_eq!(
        steps.taken(),
        vec!["hold", "show", "focus", "end"],
        "the input that waited reaches the modal after it took the keyboard"
    );
}

// contract: modal.keyboard-hold
#[test]
fn a_modal_that_closes_or_fails_before_it_took_the_keyboard_ends_the_wait() {
    let closed = Steps::new("discard");
    let error = close_holding(|| closed.step("discard"), || closed.step("end")).unwrap_err();
    assert_eq!(
        closed.taken(),
        vec!["discard", "end"],
        "a modal that closed ends the wait also when its removal failed"
    );
    assert_eq!(error, "discard failed");

    let failed = Steps::new("show");
    let error = show_holding(
        || failed.step("hold"),
        || failed.step("show"),
        || failed.step("discard"),
        || failed.step("end"),
    )
    .unwrap_err();
    assert_eq!(
        failed.taken(),
        vec!["hold", "show", "discard", "end"],
        "no input waits for a modal that does not exist"
    );
    assert_eq!(error, "show failed");

    let unfocused = Steps::new("focus");
    take_keyboard(|| unfocused.step("focus"), || unfocused.step("end")).unwrap_err();
    assert_eq!(
        unfocused.taken(),
        vec!["focus"],
        "a modal that did not take the keyboard keeps the wait for the next ready request"
    );
}

// contract: modal.keyboard-hold
#[test]
fn the_end_of_a_modal_document_process_is_told_from_the_end_of_the_main_page() {
    assert!(is_modal_of("modal-main-3", "main"));
    assert!(!is_modal_of("main", "main"));
    assert!(!is_modal_of("modal-other-3", "main"));
    assert!(!is_modal_of("modal-main-", "main"));
    assert!(!is_modal_of("modal-main-3x", "main"));
}
