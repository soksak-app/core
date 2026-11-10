//! Checks that the end of a page answers what the page owed in the turn of the end: its requests, the close question that it
//! left and the reloads that wait for its next page (docs/spec/hosts.md#process-lifecycle, docs/spec/native-host.md#page-reload).

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc;

use serde_json::value::RawValue;

use super::*;
use crate::endpoint::{Failure, MISSING_DOCUMENT};
use crate::exposure::{Relay, await_reload};
use crate::start::start_waited_page;

/// The window data of a window whose page is ready.
fn ready_page() -> Arc<WindowData> {
    let data = Arc::new(WindowData::default());
    data.ready.store(true, Ordering::Relaxed);
    data
}

/// Sends a command request to the page main that the page never answers, and returns the receiver of its end after the relay
/// sent it to the page.
fn ask_page(relay: &Arc<Relay>) -> mpsc::Receiver<Result<Box<RawValue>, Failure>> {
    let (outcome, received) = mpsc::channel();
    let (sent, wait) = mpsc::channel();
    let asking = relay.clone();
    std::thread::spawn(move || {
        let reply = asking.request("main", None, |_| {
            sent.send(()).map_err(|error| error.to_string())
        });
        outcome.send(reply).expect("the test holds the receiver");
    });
    wait.recv().expect("the request to the page was not sent");
    received
}

/// Checks that the request whose end reply receives ended with the code of a closed document.
fn want_closed_document(reply: mpsc::Receiver<Result<Box<RawValue>, Failure>>, what: &str) {
    let ended = reply.recv().expect("the request answers");
    assert!(
        matches!(&ended, Err(failure) if failure.code == MISSING_DOCUMENT),
        "{what} ended with {:?}, want {MISSING_DOCUMENT}",
        ended
            .map(|value| value.get().to_string())
            .map_err(|failure| failure.message)
    );
}

/// Starts a reload of the window data, which asks for the new page by sending "start" on asked, and returns the receiver of
/// its end after it asked.
fn reload(data: &Arc<WindowData>) -> mpsc::Receiver<Result<Value, Failure>> {
    let (outcome, received) = mpsc::channel();
    let (asked, wait) = mpsc::channel();
    let reloading = data.clone();
    std::thread::spawn(move || {
        let ended = await_reload(
            &reloading,
            || {
                asked.send("start").expect("the test holds the receiver");
                Ok(())
            },
            || Failure::new(crate::endpoint::TIMED_OUT, "the test ends every reload"),
        );
        outcome.send(ended).expect("the test holds the receiver");
    });
    assert_eq!(
        wait.recv(),
        Ok("start"),
        "the reload did not ask for the new page"
    );
    received
}

/// Checks that the reload whose end ended receives ended with the code of a closed document and a message with each part.
fn want_reload_ended(ended: mpsc::Receiver<Result<Value, Failure>>, parts: &[&str], what: &str) {
    match ended.recv().expect("the reload answers") {
        Err(failure) => assert!(
            failure.code == MISSING_DOCUMENT
                && parts.iter().all(|part| failure.message.contains(part)),
            "{what} ended with {} {}",
            failure.code,
            failure.message
        ),
        Ok(value) => panic!("{what} ended with the ready {value}"),
    }
}

// The end of the WebContent process of the page ends the page: a command that the page never answers ends with it, and the window
// is no longer ready, so no later request waits for the page (docs/spec/hosts.md#process-lifecycle).
// contract: application.page-end.answers-the-requests-of-the-page
#[test]
fn the_end_of_the_page_process_ends_the_requests_to_the_page() {
    let relay = Arc::new(Relay::default());
    let data = ready_page();
    let reply = ask_page(&relay);
    end_page_of(&relay, &data, "main", || (), || Ok(()), || Ok(())).expect("the page ends");
    want_closed_document(reply, "the command request to the page");
    assert!(
        !data.ready.load(Ordering::Relaxed),
        "the window of a page that ended is still ready"
    );
}

// A close question that the page did not answer is answered by the end of the page: the window closes, because a page that ended
// keeps no tab (docs/spec/hosts.md#process-lifecycle).
// contract: application.page-end.answers-the-close-question
#[test]
fn the_end_of_the_page_answers_the_close_question_that_it_left() {
    let relay = Arc::new(Relay::default());
    let data = ready_page();
    let mut asked = Vec::new();
    assert!(
        close_requested(&data, true, || asked.push("project-close-request")),
        "the close of a window whose page is ready did not ask the page"
    );
    assert_eq!(asked, ["project-close-request"]);
    let closes = std::cell::Cell::new(0);
    let close = || {
        closes.set(closes.get() + 1);
        Ok(())
    };
    end_page_of(&relay, &data, "main", || (), || Ok(()), close).expect("the page ends");
    assert_eq!(
        closes.get(),
        1,
        "the end of the page closed the window {} times, want once",
        closes.get()
    );
    end_page_of(&relay, &data, "main", || (), || Ok(()), close).expect("the page ends again");
    assert_eq!(
        closes.get(),
        1,
        "a second end closed the window again: {} closes",
        closes.get()
    );
}

// The reload request ends the page: a request to the page ends in the turn of the request, so the calls of the page that wait for
// it answer and the page can reload (docs/spec/native-host.md#page-reload).
// contract: application.page-end.answers-the-requests-of-the-page
#[test]
fn the_reload_request_ends_the_requests_to_the_page() {
    let relay = Arc::new(Relay::default());
    let data = ready_page();
    let reply = ask_page(&relay);
    reload_ready_page(
        &relay,
        &data,
        "main",
        || Ok(()),
        || (),
        || Ok(()),
        || Ok(()),
    )
    .expect("the reload request is sent");
    want_closed_document(reply, "the command request to the reloading page");
    assert!(
        !data.ready.load(Ordering::Relaxed),
        "the window of a page that was asked to reload is still ready"
    );
}

// The close of the window ends the reload of its page: the window can no longer report ready (docs/spec/native-host.md#page-reload).
// contract: application.page-reload.ends-with-close-or-failed-start
#[test]
fn a_reload_ends_with_the_close_of_its_window() {
    let data = Arc::new(WindowData::default());
    let ended = reload(&data);
    assert!(
        !close_requested(&data, false, || panic!(
            "a window whose page is not ready asked its page"
        )),
        "a window whose page is not ready kept its close"
    );
    end_reloads_of_closed_window(&data);
    want_reload_ended(
        ended,
        &["the window closed before the reloaded page reported ready"],
        "the reload of a closed window",
    );
}

// A start of the new page that fails ends the reload with its reason (docs/spec/native-host.md#page-reload).
// contract: application.page-reload.ends-with-close-or-failed-start
#[test]
fn a_reload_ends_with_a_failed_start() {
    let data = Arc::new(WindowData::default());
    let ended = reload(&data);
    let started = start_waited_page(
        || Ok(data.clone()),
        || Err("the layout cannot be cancelled".to_string()),
        || panic!("a page whose start failed built its document"),
        || panic!("a page whose start failed read its surfaces"),
    );
    assert!(started.is_err(), "the start of the page did not fail");
    want_reload_ended(
        ended,
        &[
            "the reloaded page did not start: ",
            "the layout cannot be cancelled",
        ],
        "the reload whose page failed to start",
    );
}
