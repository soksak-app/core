use std::cell::Cell;

use std::cell::RefCell;
use std::sync::mpsc;
use std::time::Duration;

use super::{last_placement_presented, settled_frame};
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

/// A window whose workbench holds a placement behind a running one presents that placement only after the workbench placed
/// it: the wait asks the workbench for its last placement and settles the window only after the workbench answered.
// contract: exposure.window-presented.waits-for-the-last-placement
#[test]
fn the_presented_window_waits_for_the_placement_that_its_workbench_holds() {
    let (asked_tx, asked) = mpsc::channel();
    let (commit, committed) = mpsc::channel::<()>();
    let (answer_tx, answer) = mpsc::channel();
    let waiting = std::thread::spawn(move || {
        let order = RefCell::new(Vec::new());
        let displayed = last_placement_presented(
            |_| {
                asked_tx.send(()).unwrap();
                committed.recv().unwrap();
                order.borrow_mut().push("placed");
                Ok(())
            },
            || {
                order.borrow_mut().push("settled");
                let (tx, rx) = mpsc::channel();
                tx.send(()).unwrap();
                Ok(rx)
            },
            || {
                order.borrow_mut().push("presented");
                Ok(12.5)
            },
            Duration::from_secs(1),
        );
        answer_tx.send((displayed, order.into_inner())).unwrap();
    });
    asked.recv().unwrap();
    // The window answers after the ask returns, and the order of its steps shows that it settled after the placement.
    assert!(
        answer.try_recv().is_err(),
        "the window answered while its workbench held a placement"
    );
    commit.send(()).unwrap();
    let (displayed, order) = answer.recv().unwrap();
    waiting.join().unwrap();
    assert_eq!(displayed.expect("the presented window"), 12.5);
    assert_eq!(order, ["placed", "settled", "presented"]);
}

/// A placement that fails, or a workbench that does not answer within the limit, ends the wait with that failure before
/// the window settles.
// contract: exposure.window-presented.waits-for-the-last-placement
#[test]
fn the_presented_window_fails_with_its_last_placement() {
    let failure = last_placement_presented(
        |_| Err(super::internal("surface presentation failed")),
        || panic!("the wait went on after its last placement failed"),
        || panic!("the window presented after its last placement failed"),
        Duration::from_secs(1),
    )
    .unwrap_err();
    assert!(
        failure.message.contains("surface presentation failed"),
        "{}",
        failure.message
    );

    let limit = Duration::from_millis(20);
    let relay = super::Relay::default();
    let asked = Cell::new(Duration::ZERO);
    let failure = last_placement_presented(
        |within| {
            asked.set(within);
            // The workbench takes the request and answers nothing.
            relay
                .request("window", Some(within), |_| Ok(()))
                .map(|_| ())
        },
        || panic!("the wait went on without the answer of the workbench"),
        || panic!("the window presented without the answer of the workbench"),
        limit,
    )
    .unwrap_err();
    assert_eq!(asked.get(), limit);
    assert_eq!(failure.code, crate::endpoint::TIMED_OUT);
    assert!(
        failure.message.contains("the last placement of the window"),
        "{}",
        failure.message
    );
}
