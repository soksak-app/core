//! The watch of the main thread records a stall, the stacks of the threads and the end of the stall without a window check.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use soksak_host_tauriv2::stall_watch::{StallWatchOptions, start_stall_watch};

type Recorded = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

// contract: host.stall.recorded-without-a-check
#[test]
fn a_blocked_main_thread_is_recorded_with_its_stacks_and_its_end() {
    // A fake main thread: the watch sends its heartbeat here, and the test holds the thread for 1.6 s.
    let (work, queue) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
    std::thread::spawn(move || {
        for f in queue {
            f();
        }
    });
    let events: Recorded = Arc::new(Mutex::new(Vec::new()));
    let sampled = Arc::new(Mutex::new(Vec::new()));
    let folder = tempfile::tempdir().unwrap();
    let on_main = work.clone();
    let recorded = Arc::clone(&events);
    let samples = Arc::clone(&sampled);
    let stop = start_stall_watch(StallWatchOptions {
        on_main: Box::new(move |f| on_main.send(f).map_err(|e| e.to_string())),
        sample: Box::new(move |path| {
            samples.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }),
        folder: folder.path().to_path_buf(),
        emit_host: Box::new(move |_, event, fields| {
            recorded.lock().unwrap().push((event.to_string(), fields))
        }),
    });
    std::thread::sleep(Duration::from_millis(600));
    let (release, held) = mpsc::channel::<()>();
    work.send(Box::new(move || held.recv().unwrap())).unwrap();
    std::thread::sleep(Duration::from_millis(1600));
    release.send(()).unwrap();
    std::thread::sleep(Duration::from_millis(800));
    stop();
    let events = events.lock().unwrap();
    let names: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        ["host.stall", "host.stall.sampled", "host.stall.resumed"],
        "{events:?}"
    );
    assert!(events[0].1["late_ms"].as_u64().unwrap() >= 1000);
    let path = events[1].1["path"].as_str().unwrap();
    assert!(path.contains("stall-host-"), "{path}");
    assert_eq!(sampled.lock().unwrap().len(), 1);
    assert!(events[2].1["stalled_ms"].as_u64().unwrap() >= 1000);
}
