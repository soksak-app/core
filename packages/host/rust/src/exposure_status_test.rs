use std::collections::HashSet;

use super::*;

/// A watch that starts after the watch of the window ended receives the value of the window that changed while no
/// connection watched it. The value sent before the watch ended is not sent again to the new watch.
// contract: status.window.rewatch-notifies
#[test]
fn a_new_watch_receives_the_next_window_value_after_a_stale_record() {
    let mut reported = HashMap::new();
    let open = json!({"modal": "open"});
    let closed = json!({"modal": "closed"});
    assert_eq!(
        decide_window_notify(&mut reported, "main", true, &open),
        WindowNotify::Sent(open.clone()),
        "the first value of a watched window is sent"
    );
    // The last watch of the window ends.
    forget_window_notify(&mut reported, "main");
    assert_eq!(
        decide_window_notify(&mut reported, "main", false, &closed),
        WindowNotify::Unwatched,
        "a value of a window that no connection watches is not sent"
    );
    assert_eq!(
        decide_window_notify(&mut reported, "main", true, &open),
        WindowNotify::Sent(open.clone()),
        "a new watch receives the value of the window after the earlier watch ended"
    );
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

/// Returns the waiting requests of a relay, whether or not its lock is poisoned.
fn waiting(relay: &Relay) -> usize {
    relay
        .pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .len()
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn abandon_answers_the_waiting_request_of_a_poisoned_lock() {
    let relay = Relay::default();
    let (tx, rx) = mpsc::channel();
    relay.pending.lock().unwrap().insert(
        1,
        (
            Held {
                target: "main".to_string(),
                origin: None,
            },
            tx,
        ),
    );
    poison(&relay.pending);
    relay.abandon("main");
    let answered = matches!(
        rx.try_recv(),
        Ok(Err(failure)) if failure.code == MISSING_DOCUMENT
    );
    assert!(
        answered,
        "abandon did not answer the request of a poisoned lock"
    );
    assert_eq!(
        waiting(&relay),
        0,
        "abandon kept the request of a poisoned lock"
    );
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn forget_removes_the_request_of_a_poisoned_lock() {
    let relay = Relay::default();
    let (tx, _rx) = mpsc::channel();
    relay.pending.lock().unwrap().insert(
        1,
        (
            Held {
                target: "main".to_string(),
                origin: None,
            },
            tx,
        ),
    );
    poison(&relay.pending);
    relay.forget(1);
    assert_eq!(waiting(&relay), 0, "forget kept the request that ended");
}

// contract: host.locks.poisoned-state-is-recovered
#[test]
fn a_poisoned_pending_lock_still_answers_a_request() {
    let relay = Arc::new(Relay::default());
    poison(&relay.pending);
    let (started, started_rx) = mpsc::channel::<u64>();
    let answering = Arc::clone(&relay);
    let handle = std::thread::spawn(move || {
        let id = started_rx.recv().unwrap();
        let payload = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": 7
        }))
        .unwrap();
        answering
            .reply("main", &RawValue::from_string(payload).unwrap())
            .expect("the reply failed while the pending lock was poisoned");
    });
    let answer = relay.request("main", move |id| {
        started.send(id).unwrap();
        Ok(())
    });
    handle.join().unwrap();
    assert!(
        answer.is_ok(),
        "the request failed while the pending lock was poisoned"
    );
}
// contract: host.locks.poisoned-state-is-recovered
#[cfg(feature = "diagnostics")]
#[test]
fn the_pending_count_is_read_when_the_pending_lock_is_poisoned() {
    let relay = Relay::default();
    let (tx, _rx) = mpsc::channel();
    relay.pending.lock().unwrap().insert(
        1,
        (
            Held {
                target: "main".to_string(),
                origin: None,
            },
            tx,
        ),
    );
    poison(&relay.pending);
    assert_eq!(
        relay.pending_count("main"),
        1,
        "the waiting requests of a poisoned lock were not counted"
    );
}

/// The view of a view surface is registered as the document "" of its surface, and a first responder in it is the owner
/// surface with that surface and no document; a first responder in a document region is the owner document, and a first
/// responder in the main web view, which draws the workbench, is the owner workbench.
// contract: window.responder.view-is-owner-surface
#[test]
fn the_first_responder_in_the_view_of_a_view_surface_is_owner_surface() {
    let named = HashMap::from([(10, "tab-view".to_string())]);
    let documents = HashMap::from([
        (
            20,
            (
                "tab-view".to_string(),
                crate::documents::VIEW_NAME.to_string(),
            ),
        ),
        (30, ("tab-view".to_string(), "page".to_string())),
    ]);
    assert_eq!(
        responder_of("WKWebView", 20, 10, false, &named, &documents, None),
        json!({"class": "WKWebView", "owner": "surface", "surface": "tab-view", "document": null})
    );
    assert_eq!(
        responder_of("WKWebView", 30, 10, false, &named, &documents, None),
        json!({"class": "WKWebView", "owner": "document", "surface": "tab-view", "document": "page"})
    );
    assert_eq!(
        responder_of("WKWebView", 40, 0, true, &named, &documents, None),
        json!({"class": "WKWebView", "owner": "workbench", "surface": null, "document": null})
    );
}

/// Sends a request to a surface from another thread and returns the channel of its outcome after the relay holds it.
fn pending_surface(
    relay: &std::sync::Arc<Relay>,
    reloading: &std::sync::Arc<AtomicBool>,
    label: &'static str,
) -> mpsc::Receiver<Result<Box<RawValue>, Failure>> {
    let (outcome, received) = mpsc::channel();
    let (sent, wait) = mpsc::channel();
    let (relay, reloading) = (relay.clone(), reloading.clone());
    std::thread::spawn(move || {
        let reply = request_surface(&relay, &reloading, label, |_| {
            sent.send(()).map_err(|error| error.to_string())
        });
        outcome.send(reply).expect("the test holds the receiver");
    });
    wait.recv()
        .expect("the request to the surface was not sent");
    received
}

/// Sends a request to a surface whose document answers it at once.
fn relay_answers_surface(relay: &Relay, reloading: &AtomicBool) -> Result<Box<RawValue>, Failure> {
    request_surface(relay, reloading, "surface-main-tab", |id| {
        let value = RawValue::from_string("1".to_string()).map_err(|error| error.to_string())?;
        let pending = relay.pending.lock().map_err(|error| error.to_string())?;
        let (_, reply) = pending.get(&id).ok_or("the relay holds no request")?;
        reply.send(Ok(value)).map_err(|error| error.to_string())
    })
}

// contract: exposure.relay.page-reload-ends-surface-requests
#[test]
fn a_reload_asked_of_a_page_ends_the_requests_to_its_surfaces() {
    let relay = std::sync::Arc::new(Relay::default());
    let reloading = std::sync::Arc::new(AtomicBool::new(false));
    let other_reloading = std::sync::Arc::new(AtomicBool::new(false));
    let mine = pending_surface(&relay, &reloading, "surface-main-tab");
    let theirs = pending_surface(&relay, &other_reloading, "surface-second-tab");
    ask_page_to_reload(&relay, &reloading, "main", || {
        assert!(
            mine.try_recv().is_err(),
            "the request ended before the page received the reload request"
        );
        Ok(())
    })
    .expect("the reload request is sent");
    let ended = mine
        .recv()
        .expect("the request to a surface of the reloading page answers");
    assert!(
        matches!(ended, Err(failure) if failure.code == MISSING_DOCUMENT),
        "the request to a surface of the reloading page did not end with the closed-document code"
    );
    assert!(
        theirs.try_recv().is_err(),
        "the request to a surface of another window ended"
    );
    relay.abandon("surface-second-tab");
    assert!(
        theirs
            .recv()
            .expect("the abandoned request answers")
            .is_err(),
        "the abandoned request did not fail"
    );
}

// contract: exposure.relay.page-reload-ends-surface-requests
#[test]
fn a_request_after_the_reload_is_refused_until_the_new_page_starts() {
    let relay = Relay::default();
    let reloading = AtomicBool::new(false);
    ask_page_to_reload(&relay, &reloading, "main", || Ok(())).expect("the reload request is sent");
    let mut sent = false;
    let refused = request_surface(&relay, &reloading, "surface-main-tab", |_| {
        sent = true;
        Ok(())
    });
    assert!(
        !sent,
        "a request sent after the reload request reached the document"
    );
    assert!(
        matches!(refused, Err(failure) if failure.code == MISSING_DOCUMENT),
        "a request after the reload request was not refused with the closed-document code"
    );
    end_page_reload(&reloading);
    let accepted = relay_answers_surface(&relay, &reloading);
    assert!(
        accepted.is_ok(),
        "a request after the new page started was not sent"
    );
}

/// A run held open. runs records each value with the thread it ran on, each run sends on begins when it begins and waits for a
/// message on release.
struct HeldWork {
    work: LatestWork<u32>,
    runs: Arc<Mutex<Vec<(u32, std::thread::ThreadId)>>>,
    release: std::sync::mpsc::Sender<()>,
    begins: std::sync::mpsc::Receiver<()>,
}

fn held_latest_work() -> HeldWork {
    let runs = Arc::new(Mutex::new(Vec::new()));
    let recording = Arc::clone(&runs);
    let (release, released) = std::sync::mpsc::channel::<()>();
    let released = Mutex::new(released);
    let (began, begins) = std::sync::mpsc::channel::<()>();
    let work = LatestWork::new("latest-work-test", move |value| {
        recording
            .lock()
            .unwrap()
            .push((value, std::thread::current().id()));
        began.send(()).unwrap();
        released.lock().unwrap().recv().unwrap();
    });
    HeldWork {
        work,
        runs,
        release,
        begins,
    }
}

/// The requests that arrive during a run join into one further run on the same thread, so a burst of changes holds one thread
/// and the last value of the burst is the last one that runs.
// contract: status.window.latest-value-last
#[test]
fn a_burst_of_window_changes_is_one_more_read_on_one_thread() {
    let HeldWork {
        work,
        runs,
        release,
        begins,
    } = held_latest_work();
    work.ask("main", 0);
    begins.recv_timeout(Duration::from_secs(5)).unwrap();
    for value in 1..=100 {
        work.ask("main", value);
    }
    // Every run that the burst started has begun or never will: it is released, and the last value decides the end.
    for _ in 0..101 {
        release.send(()).unwrap();
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while runs.lock().unwrap().last().map(|run| run.0) != Some(100)
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(5));
    }
    std::thread::sleep(Duration::from_millis(100));
    let runs = runs.lock().unwrap();
    let values: Vec<u32> = runs.iter().map(|run| run.0).collect();
    assert_eq!(values, [0, 100], "the runs of the burst");
    let threads: HashSet<_> = runs.iter().map(|run| run.1).collect();
    assert_eq!(threads.len(), 1, "the threads of the burst");
}

/// Two keys both run, and a later request after the burst ended runs on the thread that the first request started.
// contract: status.window.latest-reads-run-on-one-thread
#[test]
fn each_window_keeps_its_own_latest_read_on_the_same_thread() {
    let HeldWork {
        work,
        runs,
        release,
        begins,
    } = held_latest_work();
    work.ask("main", 1);
    begins.recv_timeout(Duration::from_secs(5)).unwrap();
    work.ask("second", 2);
    work.ask("third", 3);
    release.send(()).unwrap();
    begins.recv_timeout(Duration::from_secs(5)).unwrap();
    release.send(()).unwrap();
    begins.recv_timeout(Duration::from_secs(5)).unwrap();
    release.send(()).unwrap();
    // The queue is empty now; the thread waits and takes the next request.
    work.ask("main", 4);
    begins.recv_timeout(Duration::from_secs(5)).unwrap();
    release.send(()).unwrap();
    let runs = runs.lock().unwrap();
    let mut values: Vec<u32> = runs.iter().map(|run| run.0).collect();
    values.sort_unstable();
    assert_eq!(values, [1, 2, 3, 4]);
    let threads: HashSet<_> = runs.iter().map(|run| run.1).collect();
    assert_eq!(threads.len(), 1, "the threads of the requests");
}
