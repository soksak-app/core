//! A writer with nothing to write sleeps, and what wakes it is stored at once (docs/spec/logging.md#writers). The Go writer has
//! the same tests. An interval of an hour ends in no test, so what a test finds in the file was not written at its end.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use serde_json::value::RawValue;
use soksak_sok::event_bounds::Fields;
use soksak_sok::event_classes::Class;
use soksak_sok::event_log::{Channel, EventLog, Level, LossReason, Options, RelayedEvent, Rouser};

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

const HOUR: Duration = Duration::from_secs(3600);

#[derive(Default)]
struct Source {
    pulls: AtomicU64,
    held: Mutex<Vec<String>>,
}

impl Source {
    fn hold(&self, event: &str) {
        self.held.lock().unwrap().push(event.to_string());
    }
}

struct Idle {
    log: EventLog,
    source: Arc<Source>,
    rouser: Rouser,
    path: PathBuf,
    /// Each sleep of the writer, with whether it holds a count of the gate.
    sleeps: Receiver<bool>,
    /// Each batch that the writer wrote.
    writes: Receiver<()>,
    _folder: Folder,
}

fn options(directory: &Path, interval: Duration) -> Options {
    Options {
        directory: directory.to_path_buf(),
        role: "probe".into(),
        boot: "idle".into(),
        layer: "host",
        clock: || 42,
        spawn: |body| {
            std::thread::Builder::new()
                .name("probe-writer".into())
                .spawn(body)
                .map_err(|error| error.to_string())
        },
        queue_events: 64,
        queue_bytes: 1 << 20,
        batch_interval: interval,
        rotate_bytes: 0,
        pull: None,
        wake: None,
        policy_path: None,
        prune: None,
    }
}

/// Starts a writer with a source, and returns it once the writer took what its start left and slept.
fn idle(interval: Duration) -> Idle {
    let folder = Folder::new("event-log-idle");
    let source = Arc::new(Source::default());
    let pulled = Arc::clone(&source);
    let given = Arc::new(Mutex::new(None));
    let handle = Arc::clone(&given);
    let mut options = options(folder.path(), interval);
    options.pull = Some(Box::new(move |sink| {
        pulled.pulls.fetch_add(1, Ordering::SeqCst);
        for event in pulled.held.lock().unwrap().drain(..) {
            sink.accept(RelayedEvent {
                ts_us: 1,
                mono_ns: 1,
                layer: "native".into(),
                page: None,
                start: None,
                level: Level::Info,
                event,
                cids: Vec::new(),
                fields: Fields::whole(RawValue::from_string("{}".into()).unwrap()),
            });
        }
    }));
    options.wake = Some(Box::new(move |rouser| {
        *handle.lock().unwrap() = Some(rouser);
        Ok(())
    }));
    let log = EventLog::start(options).unwrap();
    let rouser = given.lock().unwrap().take().unwrap();
    let path = log.path().to_path_buf();
    let (slept, sleeps) = channel();
    log.set_on_sleep(Box::new(move |count_held| {
        slept.send(count_held).unwrap();
    }));
    let (wrote, writes) = channel();
    let idle = Idle {
        log,
        source,
        rouser,
        path,
        sleeps,
        writes,
        _folder: folder,
    };
    idle.slept();
    idle.log.set_on_write(Box::new(move |_, _| {
        wrote.send(()).unwrap();
    }));
    idle
}

impl Idle {
    fn pulls(&self) -> u64 {
        self.source.pulls.load(Ordering::SeqCst)
    }

    /// Waits for the next sleep of the writer and returns whether it holds a count of the gate. Only an event, a wake, a loss, a
    /// request or the report of a held count wakes a writer that sleeps, so what follows a sleep is what the test does.
    fn slept(&self) -> bool {
        self.sleeps.recv().expect("the writer did not sleep")
    }

    /// The writes that the writer made so far and the test did not take, without waiting.
    fn wrote(&self) -> usize {
        self.writes.try_iter().count()
    }

    fn stores(&self, event: &str) -> bool {
        std::fs::read_to_string(&self.path)
            .unwrap_or_default()
            .contains(event)
    }

    /// Waits for the writes of the writer until one of them left `event` in the file. It takes the write that stored it, so a
    /// count of the writes that follow starts after it.
    fn wait_for(&self, event: &str) {
        loop {
            self.writes
                .recv()
                .unwrap_or_else(|_| panic!("{event} was not stored at once"));
            if self.stores(event) {
                return;
            }
        }
    }
}

// A wakeup of each interval would be ten wakeups each second of an idle application, which G2 of docs/spec/hosts.md does not
// leave room for. The start takes the source once and sleeps.
// contract: log.writer.sleeps-with-nothing-to-write
#[test]
fn a_writer_with_nothing_to_write_does_not_wake() {
    let idle = idle(Duration::from_millis(5));
    assert_eq!(
        idle.pulls(),
        1,
        "the pulls before the writer slept, want the one of its start"
    );
}

// contract: log.writer.sleeps-with-nothing-to-write
#[test]
fn the_writer_sleeps_again_after_a_wake() {
    let idle = idle(Duration::from_millis(5));
    let from = idle.pulls();
    idle.rouser.wake();
    idle.slept();
    assert_eq!(
        idle.pulls() - from,
        2,
        "at once and at the end of the interval"
    );
}

// contract: log.writer.stores-the-first-event-at-once
#[test]
fn the_first_event_is_stored_at_once() {
    let idle = idle(HOUR);
    assert!(idle.log.emit(Level::Info, "writer.idle.first", &json!({})));
    idle.wait_for("writer.idle.first");
}

// contract: log.native.wake-stores-a-record-at-once
#[test]
fn the_first_record_of_the_source_is_stored_at_once() {
    let idle = idle(HOUR);
    idle.source.hold("native.idle.first");
    idle.rouser.wake();
    idle.wait_for("native.idle.first");
}

/// The flush is the one write after the first, and the writer writes before it answers the flush.
// contract: log.writer.stores-the-first-event-at-once
#[test]
fn the_events_after_the_first_wait_for_the_batch() {
    let idle = idle(HOUR);
    assert!(idle.log.emit(Level::Info, "writer.idle.first", &json!({})));
    idle.wait_for("writer.idle.first");
    assert_eq!(idle.wrote(), 0, "the first event was written twice");
    assert!(idle.log.emit(Level::Info, "writer.idle.second", &json!({})));
    assert!(idle.log.emit(Level::Info, "writer.idle.third", &json!({})));
    idle.log.flush().unwrap();
    assert_eq!(
        idle.wrote(),
        1,
        "the writes for the two events of an interval and the flush, want the one of the flush"
    );
    assert!(idle.stores("writer.idle.second") && idle.stores("writer.idle.third"));
}

/// A refused event makes no write of its own, which would wake the indexer as well: a writer that sleeps keeps the count, and
/// the next event carries it to the file. The first count wakes the writer for the start and the end of one interval, after
/// which it sleeps with the count held, and a further count wakes nothing. The check sets the bound on the rate of the reports
/// to zero, so the carrier is not held back by it.
// contract: log.writer.a-count-waits-for-a-write
#[test]
fn a_count_waits_for_the_next_write() {
    let idle = idle(Duration::from_millis(5));
    idle.log.set_gated_report_interval(Duration::ZERO);
    let from = idle.pulls();
    assert!(!idle.log.gate(Class::Io, Level::Trace));
    assert!(
        idle.slept(),
        "the writer slept without the count of the gate"
    );
    for _ in 0..49 {
        assert!(!idle.log.gate(Class::Io, Level::Trace));
    }
    assert!(
        !idle.stores("log.gated") && idle.wrote() == 0,
        "a count alone was written to the file"
    );
    let pulls = idle.pulls() - from;
    assert_eq!(
        pulls, 2,
        "the counts woke the writer for {pulls} pulls; the first count takes the start and the end of one interval"
    );
    assert!(
        idle.log
            .emit(Level::Info, "writer.idle.carrier", &json!({}))
    );
    idle.wait_for("log.gated");
}

/// The check sets the wait and the bound on the rate of the reports to zero, so the report follows the end of one interval.
// contract: log.writer.a-count-waits-for-a-write
#[test]
fn a_count_of_the_gate_wakes_the_writer() {
    let idle = idle(Duration::from_millis(5));
    idle.log.set_gated_wait(Duration::ZERO);
    idle.log.set_gated_report_interval(Duration::ZERO);
    assert!(!idle.log.gate(Class::Io, Level::Trace));
    idle.wait_for("log.gated");
}

// contract: log.writer.sleeps-with-nothing-to-write
#[test]
fn a_loss_wakes_the_writer() {
    let idle = idle(HOUR);
    idle.log
        .count_loss(Channel::Other, LossReason::QueueFull, 1, 7);
    idle.wait_for("log.dropped");
}

// contract: log.native.close-stores-the-ring
#[test]
fn close_stores_what_waits_and_what_the_source_holds() {
    let idle = idle(HOUR);
    assert!(idle.log.emit(Level::Info, "writer.idle.first", &json!({})));
    idle.wait_for("writer.idle.first");
    assert!(idle.log.emit(Level::Info, "writer.idle.second", &json!({})));
    idle.source.hold("native.idle.held");
    idle.log.close();
    assert!(idle.stores("writer.idle.second"));
    assert!(idle.stores("native.idle.held"));
}

// contract: log.native.close-stores-the-ring
#[test]
fn a_writer_that_sleeps_takes_the_source_when_it_flushes_and_closes() {
    let idle = idle(HOUR);
    idle.source.hold("native.idle.flushed");
    idle.log.flush().unwrap();
    assert!(idle.stores("native.idle.flushed"));
    idle.source.hold("native.idle.closed");
    idle.log.close();
    assert!(idle.stores("native.idle.closed"));
}

// contract: log.native.pull-needs-a-wake
#[test]
fn a_pull_without_a_wake_is_refused() {
    let folder = Folder::new("event-log-idle");
    let mut options = options(folder.path(), HOUR);
    options.pull = Some(Box::new(|_| {}));
    match EventLog::start(options) {
        Err(error) => assert!(error.contains("wake"), "{error}"),
        Ok(_) => panic!("a pull without a wake was accepted"),
    }
}
