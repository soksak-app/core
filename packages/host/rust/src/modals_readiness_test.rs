//! Checks the readiness rules of the open modal record: a ready request shows a modal once, the visible flag is set before
//! the request is answered, and a ready request for a modal that is not open is stale and changes nothing. Checks the
//! wait of the input for a modal: it opens at the show and ends when the modal took the keyboard, closed or failed. Checks the
//! close of a modal web view: its input registration ends before the web view is closed.

use super::{
    Modal, Overlay, ReadyStep, close_holding, close_view, is_modal_of, mark_visible, ready_step,
    show_holding, take_keyboard,
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

// contract: modal.close.ends-the-input-registration
#[test]
fn a_modal_close_ends_the_input_registration_before_it_closes_the_webview() {
    let steps = Steps::new("");
    close_view(|| steps.step("end input"), || steps.step("close")).unwrap();
    assert_eq!(
        steps.taken(),
        vec!["end input", "close"],
        "the input registration of the modal web view ends in the close, not when the framework releases the web view"
    );

    let unended = Steps::new("end input");
    let error = close_view(|| unended.step("end input"), || unended.step("close")).unwrap_err();
    assert_eq!(
        unended.taken(),
        vec!["end input", "close"],
        "a modal whose input registration did not end is still closed"
    );
    assert_eq!(
        error,
        "ending the input registration of the modal web view failed: end input failed"
    );

    let unclosed = Steps::new("close");
    let error = close_view(|| unclosed.step("end input"), || unclosed.step("close")).unwrap_err();
    assert_eq!(unclosed.taken(), vec!["end input", "close"]);
    assert_eq!(error, "close failed");
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

/// Runs the first-frame wait of host.window.presented on its own thread and returns the channel of its end. `ended` is the
/// end of the request that the wait checks at each wake: the close of the window, the end of the main page process, the
/// end of the WebContent process of the modal or the end of the endpoint connection of the request.
fn paint_wait(
    overlay: &std::sync::Arc<Overlay>,
    ended: std::sync::Arc<std::sync::Mutex<Option<String>>>,
) -> std::sync::mpsc::Receiver<Result<(), String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let overlay = overlay.clone();
    std::thread::spawn(move || {
        let end = overlay.wait_for_paint(&|| ended.lock().unwrap().clone());
        tx.send(end).expect("the test holds the receiver");
    });
    rx
}

// The first-frame wait of the shown modal takes no time limit: the first frame of the modal ends it, and so does the close
// of the modal. Each end is recorded in the state that the wait reads, so an end before the wait reads it ends the wait
// the same way.
// contract: exposure.window-presented.ends-by-events
#[test]
fn the_first_frame_or_the_close_of_the_modal_ends_its_paint_wait() {
    let none = || std::sync::Arc::new(std::sync::Mutex::new(None));
    let overlay = std::sync::Arc::new(Overlay::default());
    assert_eq!(
        overlay.wait_for_paint(&|| None),
        Ok(()),
        "no open modal holds no paint wait"
    );

    open(&overlay, "picker", 3);
    let ended = paint_wait(&overlay, none());
    overlay.mark_painted("picker", 3);
    assert_eq!(
        ended.recv().unwrap(),
        Ok(()),
        "the first frame ends the wait"
    );

    open(&overlay, "picker", 4);
    let ended = paint_wait(&overlay, none());
    overlay.discard().unwrap();
    assert_eq!(
        ended.recv().unwrap(),
        Ok(()),
        "the close of the modal ends the wait"
    );
}

// The end of the request ends the wait with its reason: the test records the end and wakes the waits, as the close of the
// window, the end of a page process and the end of the endpoint connection do.
// contract: exposure.window-presented.ends-by-events
#[test]
fn the_end_of_the_request_ends_the_paint_wait_of_the_modal() {
    let overlay = std::sync::Arc::new(Overlay::default());
    open(&overlay, "picker", 5);
    let reason = std::sync::Arc::new(std::sync::Mutex::new(None));
    let ended = paint_wait(&overlay, reason.clone());
    *reason.lock().unwrap() = Some("the window closed".to_string());
    overlay.wake_paint_waits();
    assert_eq!(
        ended.recv().unwrap(),
        Err("the window closed".to_string()),
        "the end of the request ends the wait with its reason"
    );
    assert!(
        overlay.open_state().is_some(),
        "the end of the request leaves the modal open"
    );
}
