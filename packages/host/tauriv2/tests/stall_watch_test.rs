//! The watch of the main thread records a stall, the stacks of the threads and the end of the stall without a window check.

#[path = "support/folder.rs"]
mod folder;

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use soksak_host_tauriv2::event_log::Level;
use soksak_host_tauriv2::stall_watch::{Clock, StallWatchOptions, Wait, start_stall_watch};

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
    let folder = folder::Folder::new();
    let on_main = work.clone();
    let recorded = Arc::clone(&events);
    let samples = Arc::clone(&sampled);
    let levels: Arc<Mutex<Vec<(String, Level)>>> = Arc::new(Mutex::new(Vec::new()));
    let stored_levels = Arc::clone(&levels);
    let stop = start_stall_watch(StallWatchOptions {
        on_main: Box::new(move |f| on_main.send(f).map_err(|e| e.to_string())),
        sample: Box::new(move |path| {
            samples.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }),
        folder: folder.path().to_path_buf(),
        emit_host: Box::new(move |level, event, fields| {
            stored_levels
                .lock()
                .unwrap()
                .push((event.to_string(), level));
            recorded.lock().unwrap().push((event.to_string(), fields))
        }),
        clock: None,
        wait: None,
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
    // The stall and its dump are warnings, which the policy stores through the gate exception of passes_every_gate; the end
    // of the stall is info.
    for (name, level) in levels.lock().unwrap().iter() {
        let want = if name == "host.stall.resumed" {
            Level::Info
        } else {
            Level::Warn
        };
        assert_eq!(*level, want, "{name}");
    }
}

/// A clock that the test controls. Each wait advances it by one beat, and by `extra` on the first beat, which models a
/// process that the system does not schedule for that long; the wait sleeps 1 ms so that the watch does not spin.
fn controlled_time(extra: Duration) -> (Clock, Wait) {
    let now = Arc::new(Mutex::new(Duration::ZERO));
    let first = Arc::new(Mutex::new(true));
    let clock_now = Arc::clone(&now);
    let clock: Clock = Arc::new(move || *clock_now.lock().unwrap());
    let wait: Wait = Arc::new(move |beat| {
        let mut first = first.lock().unwrap();
        let mut now = now.lock().unwrap();
        *now += beat + if *first { extra } else { Duration::ZERO };
        *first = false;
        drop(now);
        drop(first);
        std::thread::sleep(Duration::from_millis(1));
    });
    (clock, wait)
}

/// Runs the watch with a main thread that never takes a task, and returns the fields of the first `host.stall` record.
fn first_stall(clock: Clock, wait: Wait) -> serde_json::Value {
    let (sent, records) = mpsc::channel::<(String, serde_json::Value)>();
    let folder = folder::Folder::new();
    let stop = start_stall_watch(StallWatchOptions {
        on_main: Box::new(|_task| Ok(())),
        sample: Box::new(|_path| Ok(())),
        folder: folder.path().to_path_buf(),
        emit_host: Box::new(move |_level, event, fields| {
            let _ = sent.send((event.to_string(), fields));
        }),
        clock: Some(clock),
        wait: Some(wait),
    });
    let fields = loop {
        let (name, fields) = records
            .recv_timeout(Duration::from_secs(10))
            .expect("a host.stall record");
        if name == "host.stall" {
            break fields;
        }
    };
    stop();
    fields
}

// contract: host.stall.watch-late-separates-scheduling
#[test]
fn a_stall_of_an_unscheduled_process_carries_its_lateness_in_the_watch() {
    // The first beat is 1600 ms late for the watch and for the main thread alike, so the stall is seen at 1850 ms.
    let (clock, wait) = controlled_time(Duration::from_millis(1600));
    let fields = first_stall(clock, wait);
    assert_eq!(fields["late_ms"], 1850, "{fields}");
    assert_eq!(fields["watch_late_ms"], 1600, "{fields}");
}

// contract: host.stall.watch-late-separates-blocked-main
#[test]
fn a_stall_of_a_blocked_main_thread_has_no_lateness_in_the_watch() {
    // The watch wakes on every beat; the main thread never runs the heartbeat, so the stall is seen at 1000 ms.
    let (clock, wait) = controlled_time(Duration::ZERO);
    let fields = first_stall(clock, wait);
    assert_eq!(fields["late_ms"], 1000, "{fields}");
    assert_eq!(fields["watch_late_ms"], 0, "{fields}");
}
