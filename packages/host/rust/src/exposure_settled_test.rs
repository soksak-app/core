use std::cell::Cell;

use super::settled_frame;
use crate::test_framework::{FixtureFrontend, WINDOW};

/// The settled wait brings the content to the screen through the settled presentation of the Frontend.
// contract: exposure.settled-wait.presents-through-the-frontend
#[test]
fn the_settled_wait_brings_the_content_through_the_frontend() {
    let frontend = FixtureFrontend::new(Ok(0x20));
    let (tx, rx) = std::sync::mpsc::channel();
    let asked = Cell::new(None);
    settled_frame(
        &frontend,
        |window, present, done| {
            asked.set(Some((window, present)));
            done(Ok(12.5));
            Ok(())
        },
        Box::new(move |displayed| tx.send(displayed).unwrap()),
    )
    .expect("the settled wait starts");
    assert_eq!(
        asked.get(),
        Some((WINDOW, 0x20)),
        "the platform waits on the window with the block of the Frontend"
    );
    assert_eq!(
        rx.recv(),
        Ok(Ok(12.5)),
        "the wait reports the time of the screen"
    );
}

/// A settled presentation that the Frontend cannot make ends the wait with its error, before the settled wait of the platform.
// contract: exposure.settled-wait.presents-through-the-frontend
#[test]
fn the_settled_wait_ends_with_the_failure_of_the_frontend() {
    let frontend = FixtureFrontend::new(Err("the main webview is gone".into()));
    let failure = settled_frame(
        &frontend,
        |_, _, _| panic!("the platform waited without a presentation"),
        Box::new(|_| panic!("a wait that did not start reported its end")),
    );
    assert_eq!(failure, Err("the main webview is gone".to_string()));
}

/// The failure of the block ends the settled wait.
// contract: exposure.settled-wait.presents-through-the-frontend
#[test]
fn the_settled_wait_ends_with_the_failure_of_the_presentation() {
    let frontend = FixtureFrontend::new(Ok(0x20));
    let (tx, rx) = std::sync::mpsc::channel();
    settled_frame(
        &frontend,
        |_, _, done| {
            done(Err("the document did not finish".into()));
            Ok(())
        },
        Box::new(move |displayed| tx.send(displayed).unwrap()),
    )
    .expect("the settled wait starts");
    assert_eq!(
        rx.recv(),
        Ok(Err("the document did not finish".to_string()))
    );
}
