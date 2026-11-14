//! The pull of the native ring against the real ring of the process (docs/spec/logging.md#writers): the scheduling of the writer
//! that pulls the ring and the loss of a ring that overflows. The decoder, the refused records and the stored form of the decoded
//! events are data tests of src/event_log_native_test.rs.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/child.rs"]
mod child;

#[path = "support/records.rs"]
mod records;

#[path = "support/platform/native_event.rs"]
mod native_event;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use soksak_host::event_log::{self, Channel, EventLog, Level, Options, Rouser};
use soksak_host::platform;

/// The native ring belongs to the process, so the tests that record into it or pull it run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn read(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// The options of a writer that pulls the native ring of the platform, as the host writer does, with no way to wake it.
fn platform_options(directory: &Path, interval: Duration) -> Options {
    Options {
        directory: directory.to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: interval,
        rotate_bytes: 1 << 30,
        pull: Some(Box::new(|buffer: &mut [u8]| {
            platform::current()?.pull_native_events(buffer)
        })),
        pull_loss: Some(Box::new(|channel: Channel| {
            match platform::current()
                .and_then(|system| system.take_native_event_loss(channel.index() as u8))
            {
                Ok(loss) => loss,
                Err(error) => {
                    eprintln!("event writer: the loss of the native ring cannot be read: {error}");
                    (0, 0)
                }
            }
        })),
        wake: Some(Box::new(|_| Ok(()))),
        policy_path: None,
        retention_bytes: 1 << 40,
    }
}

/// An interval that does not end during a test, so what a test finds in the file was not written at the end of an interval.
const NO_INTERVAL: Duration = Duration::from_secs(3600);

fn stores(path: &Path, event: &str) -> bool {
    path.exists() && read(path).iter().any(|line| line["event"] == event)
}

/// A writer with the ring, the handle that wakes it and the events of its sleeps and its writes.
struct Waking {
    log: EventLog,
    rouser: Rouser,
    /// Each sleep of the writer.
    sleeps: Receiver<bool>,
    /// Each batch that the writer wrote.
    writes: Receiver<()>,
}

impl Waking {
    /// Waits for the next sleep of the writer. Only an event, a wake, a loss, a request or the report of a held count wakes a
    /// writer that sleeps, so what follows a sleep is what the test does.
    fn slept(&self) {
        self.sleeps.recv().expect("the writer did not sleep");
    }

    /// Waits for the writes of the writer until one of them stored `event`. It takes the write that stored it, so a count of
    /// the writes that follow starts after it.
    fn wait_for(&self, event: &str) {
        loop {
            self.writes
                .recv()
                .unwrap_or_else(|_| panic!("{event} was not stored at once"));
            if stores(self.log.path(), event) {
                return;
            }
        }
    }

    /// The writes that the writer made and the test did not take, without waiting.
    fn wrote(&self) -> usize {
        self.writes.try_iter().count()
    }
}

/// A writer with the native ring of the platform and the handle that wakes it, after it took what its start left and slept.
fn start_waking(directory: &Path, interval: Duration) -> Waking {
    waking(platform_options(directory, interval))
}

/// A writer with the options and the handle that wakes it, after it took what its start left and slept.
fn waking(mut options: Options) -> Waking {
    let rouser = Arc::new(Mutex::new(None));
    let given = Arc::clone(&rouser);
    options.wake = Some(Box::new(move |handle| {
        *given.lock().unwrap() = Some(handle);
        Ok(())
    }));
    let log = event_log::start(options).unwrap();
    let handle = rouser.lock().unwrap().take().unwrap();
    let (slept, sleeps) = channel();
    log.set_on_sleep(Box::new(move |count_held| {
        slept.send(count_held).unwrap();
    }));
    let (wrote, writes) = channel();
    let waking = Waking {
        log,
        rouser: handle,
        sleeps,
        writes,
    };
    waking.slept();
    waking.log.set_on_write(Box::new(move |_, _| {
        wrote.send(()).unwrap();
    }));
    waking
}

// contract: log.native.wake-stores-a-record-at-once
#[test]
fn a_wake_of_the_ring_stores_its_record_at_once() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let directory = folder::Folder::new();
    let waking = start_waking(directory.path(), NO_INTERVAL);
    assert!(native_event::record(c"native.test.late"));
    waking.rouser.wake();
    waking.wait_for("native.test.late");
}

// contract: log.native.close-stores-the-ring
#[test]
fn close_stores_the_records_of_the_ring_without_a_wake() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let directory = folder::Folder::new();
    let waking = start_waking(directory.path(), NO_INTERVAL);
    assert!(native_event::record(c"native.test.late"));
    waking.log.close();
    assert!(stores(waking.log.path(), "native.test.late"));
}

/// The start takes the ring once and sleeps, and a wake takes it at once and at the end of the interval it starts, after which
/// the writer sleeps again.
// contract: log.writer.sleeps-with-nothing-to-write
#[test]
fn a_writer_with_nothing_to_write_does_not_pull() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let pulls = Arc::new(AtomicU64::new(0));
    let directory = folder::Folder::new();
    let counted = Arc::clone(&pulls);
    let mut options = platform_options(directory.path(), Duration::from_millis(5));
    options.pull = Some(Box::new(move |buffer: &mut [u8]| {
        counted.fetch_add(1, Ordering::SeqCst);
        platform::current()?.pull_native_events(buffer)
    }));
    let waking = waking(options);
    assert_eq!(
        pulls.load(Ordering::SeqCst),
        1,
        "the pulls before the writer slept, want the one of its start"
    );
    waking.rouser.wake();
    waking.slept();
    assert_eq!(
        pulls.load(Ordering::SeqCst) - 1,
        2,
        "the pulls after one wake, want at once and at the end of the interval"
    );
}

/// The close is the one write after the first event, and the writer writes before the close returns.
// contract: log.writer.stores-the-first-event-at-once
#[test]
fn a_writer_that_slept_stores_the_first_event_at_once_and_gathers_the_next() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let directory = folder::Folder::new();
    let waking = start_waking(directory.path(), NO_INTERVAL);
    let log = &waking.log;
    assert!(log.emit(Level::Info, "host.test.first", &serde_json::json!({})));
    waking.wait_for("host.test.first");
    assert_eq!(waking.wrote(), 0, "the first event was written twice");
    assert!(log.emit(Level::Info, "host.test.second", &serde_json::json!({})));
    assert!(log.emit(Level::Info, "host.test.third", &serde_json::json!({})));
    log.close();
    assert_eq!(
        waking.wrote(),
        1,
        "the writes for the two events of an interval and the close, want the one of the close"
    );
    assert!(stores(log.path(), "host.test.second") && stores(log.path(), "host.test.third"));
}

/// Marks the child process of the test of the loss of a full ring: the ring and its loss counts belong to the process, so the test
/// runs in a child of this test binary that no other test used.
const LOSS_CHILD: &str = "SOKSAK_NATIVE_RING_LOSS_CHILD";

/// The class call and the levels info and debug as numbers of the native library; the channels other and debug store them.
const CLASS_CALL: u8 = 2;
const LEVEL_INFO: u8 = 2;
const LEVEL_DEBUG: u8 = 3;

/// A ring that no writer drains fills; the events that it refuses are counted by the channel of their level and reach the log as
/// the loss of the ring. The records come from the real producer function of the native library.
fn loss_scenario(directory: &Path) {
    let system = platform::current().unwrap();
    // The default policy of the native library stores only errors.
    system.set_native_event_policy([4, 4, 4, 4, 4]).unwrap();
    // A record of 100 KiB: the ring of 4 MiB holds a few dozen, and two of them fit the buffer of one pull.
    let fields = format!(r#"{{"pad":"{}"}}"#, "x".repeat(100 << 10));
    const NAME: &str = "native.test.fill";
    const LIMIT: usize = 256;
    let (mut stored, mut refused_other, mut refused_debug) = (0usize, 0u64, 0u64);
    while native_event::record_with_fields(CLASS_CALL, LEVEL_INFO, NAME, &fields) {
        stored += 1;
        assert!(
            stored <= LIMIT,
            "the ring held {stored} records without a writer"
        );
    }
    refused_other += 1;
    // The records that follow have the size of the refused one, so a full ring refuses each, in the channel of its level.
    for _ in 0..2 {
        assert!(
            !native_event::record_with_fields(CLASS_CALL, LEVEL_INFO, NAME, &fields),
            "a record was stored in the full ring"
        );
        refused_other += 1;
    }
    for _ in 0..2 {
        assert!(
            !native_event::record_with_fields(CLASS_CALL, LEVEL_DEBUG, NAME, &fields),
            "a record of the channel debug was stored in the full ring"
        );
        refused_debug += 1;
    }
    let log =
        records::start_every_level(platform_options(directory, Duration::from_millis(20))).unwrap();
    log.flush().unwrap();
    let (mut pulled, mut dropped, mut other, mut debug) = (0usize, 0u64, 0u64, 0u64);
    for event in records::read_events(log.path()) {
        if event["event"] == NAME {
            pulled += 1;
        } else if event["event"] == "log.dropped" {
            let fields = &event["fields"];
            let count = fields["count"].as_u64().unwrap();
            assert_eq!(fields["reason"], "the native ring was full", "{event}");
            dropped += count;
            match fields["channel"].as_str().unwrap() {
                "other" => other += count,
                "debug" => debug += count,
                channel => panic!("dropped in the channel {channel}: {event}"),
            }
        }
    }
    assert_eq!(
        (pulled, dropped),
        (stored, refused_other + refused_debug),
        "pulled of the stored records, dropped of the refused"
    );
    // The loss of the ring names the channel of the refused events.
    assert_eq!((other, debug), (refused_other, refused_debug));
}

// contract: log.native.counts-refused-records-and-ring-loss
#[test]
fn the_loss_of_a_full_ring_is_counted_as_dropped_by_channel() {
    if let Some(directory) = std::env::var_os(LOSS_CHILD) {
        loss_scenario(Path::new(&directory));
        return;
    }
    let directory = folder::Folder::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_loss_of_a_full_ring_is_counted_as_dropped_by_channel",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(LOSS_CHILD, directory.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    child::require_success(&output, directory.path());
}
