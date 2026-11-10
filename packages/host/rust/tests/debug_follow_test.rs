//! The notices of the changes of the event log: bounded in rate, counted when coalesced, announced only for the lines that announce a change,
//! and also for the lines that a query indexes (docs/spec/debug.md#following). The same cases run in the Go host.

#[path = "support/folder.rs"]
mod folder;

use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use soksak_host::debug_follow::{LogNotice, LogNotices, use_log_notices};
use soksak_host::log_query::query_event_logs;
use soksak_sok::log_index::IndexUpdate;

/// The publisher of the notices is process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn next_notice(notices: &Receiver<LogNotice>) -> LogNotice {
    notices.recv().expect("a notice did not arrive")
}

// contract: debug.follow.coalesces-writes-into-a-notice
//
// The check ends each interval itself: the publisher enters the spacing after a notice and stays in it until the check lets it out, so
// the announcements made while it is in the spacing are the ones that the bound on the rate folds into the next notice.
#[test]
fn log_notices_are_bounded_in_rate_and_count_what_they_coalesce() {
    let _serial = SERIAL.lock().unwrap();
    let (spaced_sender, spaced) = channel::<()>();
    let spaced_sender = Mutex::new(spaced_sender);
    let (ends, ends_receiver) = channel::<()>();
    let ends_receiver = Mutex::new(ends_receiver);
    let (published_sender, published) = channel::<LogNotice>();
    let published_sender = Mutex::new(published_sender);
    let notices = LogNotices::spaced_by(
        move || {
            spaced_sender.lock().unwrap().send(()).unwrap();
            // The end of the check drops the sender, which also ends the spacing.
            ends_receiver.lock().unwrap().recv().unwrap_or(());
        },
        move |notice| published_sender.lock().unwrap().send(notice).unwrap(),
    );
    let notice = |size, notices, coalesced| LogNotice {
        path: "logs/host-b1.jsonl".into(),
        size,
        notices,
        coalesced,
    };
    assert_eq!(notices.value(), LogNotice::default());
    notices.observe("logs/host-b1.jsonl", 1);
    assert_eq!(next_notice(&published), notice(1, 1, 0), "the first notice");
    enter_spacing(&spaced);
    // The publisher is in the spacing, so every announcement returns without waiting for it, and none is published before the interval
    // ends.
    for size in 2..=50 {
        notices.observe("logs/host-b1.jsonl", size);
    }
    if let Ok(early) = published.try_recv() {
        panic!("the notice {early:?} was published before the interval ended");
    }
    ends.send(()).unwrap();
    let last = next_notice(&published);
    assert_eq!(
        last,
        notice(50, 2, 48),
        "the notice after the interval, want the latest write with the 48 announcements before it coalesced"
    );
    enter_spacing(&spaced);
    assert_eq!(notices.value(), last);
    // No notice follows the latest write: after the interval, a new announcement is the next notice, and no announcement was folded
    // into it.
    ends.send(()).unwrap();
    notices.observe("logs/host-b1.jsonl", 51);
    assert_eq!(
        next_notice(&published),
        notice(51, 3, 48),
        "the notice after the latest write, want only the new announcement"
    );
    enter_spacing(&spaced);
    drop(ends);
    notices.stop();
}

/// Waits until the publisher entered the spacing after a notice.
fn enter_spacing(spaced: &Receiver<()>) {
    spaced
        .recv()
        .expect("the publisher did not enter the spacing after a notice");
}

// contract: debug.follow.announces-only-changes-that-are-not-log-reads
#[test]
fn an_update_of_the_index_announces_only_when_a_line_announces_a_change() {
    let _serial = SERIAL.lock().unwrap();
    let (sender, published) = channel::<LogNotice>();
    let sender = Mutex::new(sender);
    let notices = LogNotices::start(Duration::from_millis(1), move |notice| {
        sender.lock().unwrap().send(notice).unwrap();
    });
    let update = |announcing, size| IndexUpdate {
        file: "logs/host-b1.jsonl".into(),
        changed: true,
        lines: 3,
        announcing,
        size,
        ..IndexUpdate::default()
    };
    notices.observe_update(&update(0, 300));
    // An announcement of the first update would be a notice before the one of the second update or would be counted as coalesced in it.
    notices.observe_update(&update(1, 400));
    let notice = next_notice(&published);
    assert_eq!(
        (
            notice.path.as_str(),
            notice.size,
            notice.notices,
            notice.coalesced
        ),
        ("logs/host-b1.jsonl", 400, 1, 0),
        "{notice:?}"
    );
    notices.stop();
}

fn event_lines(count: i64) -> String {
    let mut text = String::from(
        "{\"ts_us\":1000,\"mono_ns\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"log.open\",\"fields\":{\"schema\":3,\"pid\":1,\"role\":\"host\",\"boot\":\"b1\"}}\n",
    );
    for seq in 2..=count {
        text.push_str(&format!(
            "{{\"ts_us\":{},\"mono_ns\":{seq},\"seq\":{seq},\"level\":\"debug\",\"layer\":\"host\",\"event\":\"host.x.y\",\"fields\":{{\"n\":{seq}}}}}\n",
            1000 + seq
        ));
    }
    text
}

// contract: debug.follow.query-announces-the-lines-it-indexes
#[test]
fn a_query_that_indexes_lines_announces_them_once() {
    let _serial = SERIAL.lock().unwrap();
    let (sender, published) = channel::<LogNotice>();
    let sender = Mutex::new(sender);
    let notices = Arc::new(LogNotices::start(Duration::from_millis(1), move |notice| {
        sender.lock().unwrap().send(notice).unwrap();
    }));
    use_log_notices(Some(Arc::clone(&notices)));
    let config = folder::Folder::new();
    let logs = config.path().join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(logs.join("host-b1.jsonl"), event_lines(5)).unwrap();
    query_event_logs(config.path(), r#"{"channel":"all"}"#).expect("the query");
    let notice = next_notice(&published);
    assert!(
        notice.path == "logs/host-b1.jsonl" && notice.size > 0,
        "the query that built the index announced {notice:?}"
    );
    // The same query again finds the index current and announces nothing.
    query_event_logs(config.path(), r#"{"channel":"all"}"#).expect("the query again");
    // An announcement of the second query would be a notice before the one that follows or would be counted as coalesced in it.
    notices.observe("logs/after.jsonl", 1);
    let next = next_notice(&published);
    assert!(
        next.path == "logs/after.jsonl" && next.notices == 2 && next.coalesced == 0,
        "a query of a current index announced a change: the next notice is {next:?}"
    );
    use_log_notices(None);
    notices.stop();
}
