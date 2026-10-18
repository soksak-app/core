//! The notices of the changes of the event log: bounded in rate, counted when coalesced, announced only for the lines that announce a change,
//! and also for the lines that a query indexes (docs/spec/debug.md#following). The same cases run in the Go host.

#[path = "support/folder.rs"]
mod folder;

use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use soksak_host_tauriv2::debug_follow::{LogNotice, LogNotices, use_log_notices};
use soksak_host_tauriv2::log_query::query_event_logs;
use soksak_sok::log_index::IndexUpdate;

/// The publisher of the notices is process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn next_notice(notices: &Receiver<LogNotice>) -> LogNotice {
    notices
        .recv_timeout(Duration::from_secs(5))
        .expect("a notice did not arrive")
}

// contract: debug.follow.coalesces-writes-into-a-notice
#[test]
fn log_notices_are_bounded_in_rate_and_count_what_they_coalesce() {
    let _serial = SERIAL.lock().unwrap();
    let interval = Duration::from_millis(150);
    let (release_sender, release_receiver) = channel::<()>();
    let release_receiver = Mutex::new(release_receiver);
    let (published_sender, published) = channel::<(LogNotice, Instant)>();
    let published_sender = Mutex::new(published_sender);
    let notices = LogNotices::start(interval, move |notice| {
        release_receiver.lock().unwrap().recv().unwrap();
        published_sender
            .lock()
            .unwrap()
            .send((notice, Instant::now()))
            .unwrap();
    });
    assert_eq!(notices.value(), LogNotice::default());
    let started = Instant::now();
    for size in 1..=50 {
        notices.observe("logs/host-b1.jsonl", size);
    }
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the writer waited {:?} for the notices",
        started.elapsed()
    );
    // Permits for the first notice and for the notices that follow the interval; the writer announced all 50 before the first was released.
    for _ in 0..4 {
        release_sender.send(()).unwrap();
    }
    let mut times = vec![];
    let mut last = LogNotice::default();
    while last.size != 50 {
        let (notice, time) = published
            .recv_timeout(Duration::from_secs(5))
            .expect("a notice did not arrive");
        last = notice;
        times.push(time);
    }
    assert_eq!(last.path, "logs/host-b1.jsonl");
    assert_eq!(
        (last.notices + last.coalesced, last.notices),
        (50, times.len() as i64),
        "the last notice is {last:?} after {} notices, want the latest write with 50 announcements counted as published or coalesced",
        times.len()
    );
    for pair in times.windows(2) {
        assert!(
            pair[1] - pair[0] >= interval,
            "a notice came {:?} after the one before, under the bound of {interval:?}",
            pair[1] - pair[0]
        );
    }
    assert_eq!(notices.value(), last);
    assert!(
        published.recv_timeout(2 * interval).is_err(),
        "a notice follows the latest write"
    );
    notices.stop();
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
    assert!(
        published.recv_timeout(Duration::from_millis(300)).is_err(),
        "an update whose lines are all log reads announced a change"
    );
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
        "{\"ts_us\":1000,\"mono_ns\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"log.open\",\"fields\":{\"schema\":2,\"pid\":1,\"role\":\"host\",\"boot\":\"b1\"}}\n",
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
    assert!(
        published.recv_timeout(Duration::from_millis(300)).is_err(),
        "a query of a current index announced a change"
    );
    use_log_notices(None);
    notices.stop();
}
