//! The notices of the changes of the event log: bounded in rate, counted when coalesced, announced only for the lines that announce a change,
//! and also for the lines that a query indexes (docs/spec/debug.md#following). The same cases run in the Go host.

#[path = "support/folder.rs"]
mod folder;
#[path = "support/records.rs"]
mod records;

use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use soksak_host::debug_follow::{LogNotice, LogNotices, use_log_notices};
use soksak_host::event_log::{self, Level, Options};
use soksak_host::log_query::{query_event_logs, start_log_indexer};
use soksak_sok::log_index::{IndexUpdate, read_log_index};

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

// contract: debug.follow.a-notice-does-not-cause-itself
//
// The delivery of a notice to a window is a step of its main thread and a wake of its run loop, and a following view draws the rows it
// read; the host stores these as records of the class frame. The writer, the indexer and the publisher of the host run here with a
// delivery that stores those records, as a window that follows does with no other activity: the records of the delivery of the first
// notice cause no second notice, and the next change is the second notice with nothing coalesced into it.
#[test]
fn the_records_of_the_delivery_of_a_notice_cause_no_notice() {
    let _serial = SERIAL.lock().unwrap();
    let config = folder::Folder::new();
    let log = Arc::new(
        event_log::start(Options {
            directory: config.path().join("logs"),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 64,
            queue_bytes: 64 * 1024,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            wake: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    );
    records::store_every_level(&log);
    let (spaced_sender, spaced) = channel::<()>();
    let spaced_sender = Mutex::new(spaced_sender);
    let (ends, ends_receiver) = channel::<()>();
    let ends_receiver = Mutex::new(ends_receiver);
    let (published_sender, published) = channel::<LogNotice>();
    let published_sender = Mutex::new(published_sender);
    let delivering = Arc::clone(&log);
    let notices = Arc::new(LogNotices::spaced_by(
        move || {
            spaced_sender.lock().unwrap().send(()).unwrap();
            // The end of the check drops the sender, which also ends the spacing.
            ends_receiver.lock().unwrap().recv().unwrap_or(());
        },
        move |notice| {
            published_sender.lock().unwrap().send(notice).unwrap();
            let step = json!({"window": "main", "kind": "callback", "callback": "deliver", "entry_ns": "1", "return_ns": "2",
                "forwarded": 0, "wait_ns": "0"});
            assert!(delivering.emit(Level::Debug, "host.frame.step", &step));
            assert!(delivering.emit(
                Level::Debug,
                "host.frame.record",
                &json!({"window": "main", "outcome": "drawn"})
            ));
            assert!(delivering.emit(
                Level::Debug,
                "host.frame.complete",
                &json!({"window": "main", "commit_ns": "1", "complete_ns": "2"})
            ));
            delivering.flush().unwrap();
        },
    ));
    let (results, updates) = channel();
    let observed = Arc::clone(&notices);
    let (observe, stop) = start_log_indexer(move |_path, result| {
        if let Ok(update) = &result {
            observed.observe_update(update);
        }
        let _ = results.send(result);
    });
    log.set_on_write(observe);
    // The records of the delivery and the changes are stored at the level debug, so they are lines of the debug file alone and each update
    // announces one file.
    let main = log.path().to_path_buf();
    let path = main.with_file_name(
        main.file_name()
            .unwrap()
            .to_string_lossy()
            .replace(".jsonl", ".debug.jsonl"),
    );
    // A change writes the record `host.x.y` with its number and returns the size of the file at the end of that record. The file
    // size read after the flush is no such measure: the delivery of a notice that the change caused can append its records first.
    let change = |number: u64| {
        assert!(log.emit(Level::Debug, "host.x.y", &json!({"n": number})));
        log.flush().unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let record = format!("\"event\":\"host.x.y\",\"fields\":{{\"n\":{number}}}");
        let start = text
            .find(&record)
            .expect("the change is a record of the file");
        let end = start
            + text[start..]
                .find('\n')
                .expect("the record of the change ends its line")
            + 1;
        end as i64
    };
    let lines = |path: &std::path::Path| {
        std::fs::read_to_string(path).unwrap().matches('\n').count() as i64
    };
    let first = change(1);
    let notice = next_notice(&published);
    assert!(
        notice.notices == 1 && notice.size == first,
        "the first notice is {notice:?}, want the change of {first} bytes"
    );
    enter_spacing(&spaced);
    // The index covers the records of the delivery; an announcement of them is a notice as soon as the spacing ends.
    while !read_log_index(&path).is_ok_and(|info| info.events == lines(&path)) {
        let result = updates
            .recv()
            .expect("no update of the index followed the writes");
        assert!(result.is_ok(), "an update of the index failed: {result:?}");
    }
    ends.send(()).unwrap();
    let second = change(2);
    let notice = next_notice(&published);
    let want = LogNotice {
        path: format!("logs/{}", path.file_name().unwrap().to_string_lossy()),
        size: second,
        notices: 2,
        coalesced: 0,
    };
    assert_eq!(
        notice, want,
        "the notice after the delivery of the first, want the next change at {second} bytes with nothing coalesced"
    );
    enter_spacing(&spaced);
    drop(ends);
    notices.stop();
    stop();
}
