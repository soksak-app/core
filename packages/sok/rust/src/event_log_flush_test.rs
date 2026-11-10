//! Checks that each flush request gets the answer that is true: one that the writer finds while it answers another request is
//! answered, and the end of the writer fails a flush. A flush takes no time limit, so a test receives each answer directly
//! and a flush that is never answered is reported by the limit of the test run.

use std::sync::mpsc::{Receiver, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use super::lock_test::folder::Folder;
use super::{EventLog, Level, Message, Options, wait_for_flush};

type Held = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

// The source runs what the test holds while the writer pulls, so what that puts in the queue is found by the same drain. An
// interval of an hour keeps the end of an interval out of the answer.
fn writer(directory: &Folder) -> (Arc<EventLog>, Held) {
    let held: Held = Arc::new(Mutex::new(None));
    let source = held.clone();
    let log = EventLog::start(Options {
        directory: directory.path().to_path_buf(),
        role: "probe".into(),
        boot: "flush".into(),
        layer: "sok",
        clock: || 42,
        spawn: |body| {
            std::thread::Builder::new()
                .name("probe-writer".into())
                .spawn(body)
                .map_err(|error| error.to_string())
        },
        queue_events: 64,
        queue_bytes: 1 << 20,
        batch_interval: Duration::from_secs(3600),
        rotate_bytes: 0,
        pull: Some(Box::new(move |_| {
            if let Some(run) = source.lock().unwrap().take() {
                run();
            }
        })),
        wake: Some(Box::new(|_| Ok(()))),
        policy_path: None,
        prune: None,
    })
    .unwrap();
    (Arc::new(log), held)
}

// Holds a second flush request, and an event behind it, for the next pull.
fn hold_a_request(log: &Arc<EventLog>, held: &Held) -> Receiver<()> {
    let (done, second) = sync_channel(1);
    let writer = log.clone();
    *held.lock().unwrap() = Some(Box::new(move || {
        assert!(writer.sender.try_send(Message::Flush(done)).is_ok());
        assert!(writer.emit(Level::Info, "sok.probe.behind", &json!({})));
    }));
    second
}

// contract: log.writer.flush-behind-a-flush-or-a-stop-is-answered
#[test]
fn a_flush_that_a_flush_finds_behind_it_is_answered() {
    let directory = Folder::new("event-log-flush");
    let (log, held) = writer(&directory);
    let second = hold_a_request(&log, &held);

    log.flush().unwrap();

    second
        .recv()
        .expect("the flush behind the flush is answered");
    log.close();
}

// contract: log.writer.flush-behind-a-flush-or-a-stop-is-answered
#[test]
fn a_flush_that_a_stop_finds_behind_it_is_answered() {
    let directory = Folder::new("event-log-flush-stop");
    let (log, held) = writer(&directory);
    let second = hold_a_request(&log, &held);

    log.close();

    second
        .recv()
        .expect("the flush behind the stop is answered");
    let stored = std::fs::read_to_string(log.path()).unwrap();
    assert!(
        stored.contains("sok.probe.behind"),
        "the event behind the flush was not stored: {stored}"
    );
}

// contract: log.writer.flush-behind-a-flush-or-a-stop-is-answered
// contract: log.writer.flush-at-exit
#[test]
fn the_end_of_the_writer_fails_a_flush() {
    let (done, wait) = sync_channel(1);
    drop(done);
    assert_eq!(
        wait_for_flush(&wait),
        Err("the event writer ended before it answered the flush".to_string())
    );
}

// contract: log.writer.flush-at-exit
#[test]
fn a_flush_ends_by_the_answer_of_the_writer() {
    let (done, wait) = sync_channel(1);
    done.send(()).unwrap();
    assert_eq!(wait_for_flush(&wait), Ok(()));
}
