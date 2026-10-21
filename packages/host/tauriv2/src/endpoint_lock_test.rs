//! Checks that a poisoned lock of the endpoint connections and subscriptions is recovered, so that the write, the
//! subscription change and the connection removal complete.

use std::sync::PoisonError;
use std::time::Duration;

use super::*;

/// A connection that keeps the bytes written to it.
#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Read for Sink {
    fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
        Ok(0)
    }
}

impl Write for Sink {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Connection for Sink {
    fn try_clone(&self) -> Result<Box<dyn Connection>, String> {
        Ok(Box::new(self.clone()))
    }

    fn set_read_timeout(&self, _timeout: Option<Duration>) -> Result<(), String> {
        Ok(())
    }

    fn close(&self) -> Result<(), String> {
        Ok(())
    }
}

/// A service that records each page call and answers it with success, or with a failure when `refuse` is set.
#[derive(Default)]
struct Pages {
    calls: Arc<Mutex<Vec<String>>>,
    refuse: bool,
}

impl Service for Pages {
    fn windows(&self) -> Result<Value, Failure> {
        Ok(json!([]))
    }

    fn exists(&self, _window: &str) -> bool {
        true
    }

    fn call(
        &self,
        window: &str,
        method: &str,
        _params: Map<String, Value>,
    ) -> Result<Box<RawValue>, Failure> {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(format!("{window} {method}"));
        if self.refuse {
            return Err(Failure::new(HANDLER_FAILED, "the page refused the call"));
        }
        raw(&Value::Null)
    }

    fn unwatched(&self, _window: &str, _name: &str) {}
}

/// Poisons the lock by panicking while its guard is held.
fn poison<T>(lock: &Mutex<T>) {
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = lock.lock().unwrap();
            panic!("the test poisons the lock");
        }))
        .is_err(),
        "the closure must panic"
    );
    assert!(lock.is_poisoned(), "the lock was not poisoned");
}

fn shared(service: Pages) -> Arc<Shared> {
    Arc::new(Shared {
        service: Arc::new(service),
        peers: Mutex::new(HashMap::new()),
        lines: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        orders: AtomicU64::new(1),
        stopping: AtomicBool::new(false),
        config: PathBuf::new(),
    })
}

fn watch(name: &str) -> Watch {
    Watch {
        window: "main".into(),
        name: name.into(),
        surface: None,
    }
}

fn writer_of(sink: &Sink) -> Arc<Mutex<Box<dyn Connection>>> {
    Arc::new(Mutex::new(Box::new(sink.clone())))
}

fn peer(writer: Arc<Mutex<Box<dyn Connection>>>, watches: &[Watch]) -> Peer {
    Peer {
        writer,
        watches: watches.iter().cloned().collect(),
        #[cfg(feature = "diagnostics")]
        transcript: HashSet::new(),
        changes: HashMap::new(),
    }
}

fn recovered<T>(lock: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(PoisonError::into_inner)
}

// contract: host.locks.poisoned-state-is-recovered
// The watches of the window are read from the peer list when its lock is poisoned.
// contract: host.locks.poisoned-state-is-recovered
#[test]
fn watches_are_read_when_the_peer_list_lock_is_poisoned() {
    let shared = shared(Pages::default());
    let sink = Sink::default();
    shared
        .peers
        .lock()
        .unwrap()
        .insert(1, peer(writer_of(&sink), &[watch("state")]));
    poison(&shared.peers);
    let watches = Notifier(shared.clone()).watches("main");
    assert_eq!(
        watches,
        vec![watch("state")],
        "the watches of a poisoned peer list were not read"
    );
}

// contract: host.locks.poisoned-state-is-recovered
// A notification reaches a watching connection when the peer list lock is poisoned.
// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_notification_is_written_when_the_peer_list_lock_is_poisoned() {
    let shared = shared(Pages::default());
    let sink = Sink::default();
    shared
        .peers
        .lock()
        .unwrap()
        .insert(1, peer(writer_of(&sink), &[watch("state")]));
    poison(&shared.peers);
    Notifier(shared.clone()).changed("main", "state", None, &raw(&json!(1)).unwrap());
    assert!(
        !sink.0.lock().unwrap().is_empty(),
        "a notification was not written while the peer list lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
// A notification reaches a watching connection when the lock of its writer is poisoned.
// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_notification_is_written_when_the_writer_lock_is_poisoned() {
    let shared = shared(Pages::default());
    let sink = Sink::default();
    let writer = writer_of(&sink);
    shared
        .peers
        .lock()
        .unwrap()
        .insert(1, peer(writer.clone(), &[watch("state")]));
    poison(&writer);
    Notifier(shared.clone()).changed("main", "state", None, &raw(&json!(1)).unwrap());
    assert!(
        !sink.0.lock().unwrap().is_empty(),
        "a notification was not written while the writer lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
// A connection that ends is removed from the peer list when the list lock is poisoned.
// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_closed_connection_is_removed_when_the_peer_list_lock_is_poisoned() {
    let shared = shared(Pages::default());
    let sink = Sink::default();
    shared
        .peers
        .lock()
        .unwrap()
        .insert(7, peer(writer_of(&sink), &[]));
    poison(&shared.peers);
    forget(&shared, 7);
    assert!(
        !recovered(&shared.peers).contains_key(&7),
        "a closed connection stayed in the peer list"
    );
}

// contract: host.locks.poisoned-state-is-recovered
// A subscription change is applied when the lock of the subscription lines is poisoned.
// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_subscription_change_is_applied_when_the_lines_lock_is_poisoned() {
    let shared = shared(Pages::default());
    let sink = Sink::default();
    shared
        .peers
        .lock()
        .unwrap()
        .insert(1, peer(writer_of(&sink), &[]));
    poison(&shared.lines);
    change(&shared, 1, Topic::Status(watch("state")), true, None, 0);
    assert!(
        recovered(&shared.peers)[&1]
            .watches
            .contains(&watch("state")),
        "a subscription change was not applied while the lines lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
// A subscription change is applied when the peer list lock is poisoned.
// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_subscription_change_is_applied_when_the_peer_list_lock_is_poisoned() {
    let shared = shared(Pages::default());
    let sink = Sink::default();
    shared
        .peers
        .lock()
        .unwrap()
        .insert(1, peer(writer_of(&sink), &[]));
    poison(&shared.peers);
    change(&shared, 1, Topic::Status(watch("state")), true, None, 0);
    assert!(
        recovered(&shared.peers)[&1]
            .watches
            .contains(&watch("state")),
        "a subscription change was not applied while the peer list lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
// A queued subscription change is sent to the page when the lines lock is poisoned.
// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_queued_change_is_sent_to_the_page_when_the_lines_lock_is_poisoned() {
    let pages = Pages::default();
    let calls = pages.calls.clone();
    let shared = shared(pages);
    let sink = Sink::default();
    shared
        .peers
        .lock()
        .unwrap()
        .insert(1, peer(writer_of(&sink), &[watch("state")]));
    let topic = Topic::Status(watch("state"));
    shared.lines.lock().unwrap().insert(
        topic.clone(),
        Line {
            changes: VecDeque::from([Change {
                peer: 1,
                order: 1,
                on: true,
                last: false,
                answer: None,
            }]),
            running: true,
            page: false,
        },
    );
    poison(&shared.lines);
    drain(&shared, topic);
    assert!(
        !recovered(&calls).is_empty(),
        "a queued change was not sent to the page while the lines lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
// A start that the page refuses is reverted when the peer list lock is poisoned.
// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_refused_start_is_reverted_when_the_peer_list_lock_is_poisoned() {
    let shared = shared(Pages {
        refuse: true,
        ..Pages::default()
    });
    let sink = Sink::default();
    let mut state = peer(writer_of(&sink), &[watch("state")]);
    let topic = Topic::Status(watch("state"));
    state.changes.insert(topic.clone(), 1);
    shared.peers.lock().unwrap().insert(1, state);
    shared.lines.lock().unwrap().insert(
        topic.clone(),
        Line {
            changes: VecDeque::from([Change {
                peer: 1,
                order: 1,
                on: true,
                last: false,
                answer: None,
            }]),
            running: true,
            page: false,
        },
    );
    poison(&shared.peers);
    drain(&shared, topic);
    assert!(
        !recovered(&shared.peers)[&1]
            .watches
            .contains(&watch("state")),
        "a refused start was not reverted while the peer list lock was poisoned"
    );
}

// contract: host.locks.poisoned-state-is-recovered
// A state notification reaches the watching connections when the peer list lock is poisoned.
#[test]
fn a_state_notification_is_written_when_the_peer_list_lock_is_poisoned() {
    let shared = shared(Pages::default());
    let sink = Sink::default();
    shared
        .peers
        .lock()
        .unwrap()
        .insert(1, peer(writer_of(&sink), &[watch("state")]));
    poison(&shared.peers);
    Notifier(shared.clone()).notify_watchers("state", &raw(&json!(1)).unwrap());
    assert!(
        !sink.0.lock().unwrap().is_empty(),
        "a state notification was not written while the peer list lock was poisoned"
    );
}
