//! The watch of the main thread records a stall, the stacks of the threads and the end of the stall without a window check.

#[path = "support/folder.rs"]
mod folder;

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use soksak_host::event_log::Level;
use soksak_host::stall_watch::{
    AwaitAwake, Clock, Heartbeat, StallWatchOptions, Wait, start_stall_watch,
};

type Recorded = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

type Work = mpsc::Sender<Box<dyn FnOnce() + Send>>;

/// The run loop of a main thread that always handles an event.
fn never_waits() -> AwaitAwake {
    Box::new(|| Ok(()))
}

/// The heartbeat to a fake main thread: a task that writes the time of the answer. The first time before an answer is the
/// first heartbeat.
fn heartbeat_through(work: Work) -> Heartbeat {
    let start = std::time::Instant::now();
    let answered = Arc::new(Mutex::new(None::<Duration>));
    Box::new(move || {
        let now = start.elapsed();
        let written = Arc::clone(&answered);
        answered.lock().unwrap().get_or_insert(now);
        work.send(Box::new(move || {
            *written.lock().unwrap() = Some(start.elapsed());
        }))
        .map_err(|error| error.to_string())?;
        Ok((now, answered.lock().unwrap().unwrap()))
    })
}

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
    let heartbeat = heartbeat_through(work.clone());
    let recorded = Arc::clone(&events);
    let samples = Arc::clone(&sampled);
    let levels: Arc<Mutex<Vec<(String, Level)>>> = Arc::new(Mutex::new(Vec::new()));
    let stored_levels = Arc::clone(&levels);
    let stop = start_stall_watch(StallWatchOptions {
        heartbeat,
        await_awake: never_waits(),
        sample: Arc::new(move |path| {
            samples.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }),
        folder: folder.path().to_path_buf(),
        emit_host: Arc::new(move |level, event, fields| {
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
        // The main thread never answers, so the time of the answer stays the time of the first heartbeat, the start of the
        // clock.
        heartbeat: {
            let clock = Arc::clone(&clock);
            Box::new(move || Ok((clock(), Duration::ZERO)))
        },
        await_awake: never_waits(),
        sample: Arc::new(|_path| Ok(())),
        folder: folder.path().to_path_buf(),
        emit_host: Arc::new(move |_level, event, fields| {
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

// contract: host.stall.sample-keeps-the-watch-running
#[test]
fn a_sample_of_the_threads_does_not_stop_the_watch() {
    // A fake main thread and a sample that lasts until the test ends it, as a sample of a loaded system lasts for seconds.
    let (work, queue) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
    std::thread::spawn(move || {
        for f in queue {
            f();
        }
    });
    let events: Recorded = Arc::new(Mutex::new(Vec::new()));
    let (release, released) = mpsc::channel::<()>();
    let released = Mutex::new(released);
    let folder = folder::Folder::new();
    let heartbeat = heartbeat_through(work.clone());
    let recorded = Arc::clone(&events);
    let stop = start_stall_watch(StallWatchOptions {
        heartbeat,
        await_awake: never_waits(),
        sample: Arc::new(move |_path| released.lock().unwrap().recv().map_err(|e| e.to_string())),
        folder: folder.path().to_path_buf(),
        emit_host: Arc::new(move |_level, event, fields| {
            recorded.lock().unwrap().push((event.to_string(), fields))
        }),
        clock: None,
        wait: None,
    });
    let block_main = || {
        let (hold, held) = mpsc::channel::<()>();
        work.send(Box::new(move || {
            let _ = held.recv();
        }))
        .unwrap();
        std::thread::sleep(Duration::from_millis(1400));
        drop(hold);
    };
    let wait_for = |name: &str, count: usize| {
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        loop {
            let found = events
                .lock()
                .unwrap()
                .iter()
                .filter(|(event, _)| event == name)
                .count();
            if found >= count {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "no {count} of {name} while the sample runs: {:?}",
                events.lock().unwrap()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    std::thread::sleep(Duration::from_millis(300));
    block_main();
    wait_for("host.stall.resumed", 1);
    block_main();
    wait_for("host.stall.resumed", 2);
    release.send(()).unwrap();
    wait_for("host.stall.sampled", 2);
    stop();
    let events = events.lock().unwrap();
    let names: Vec<&str> = events.iter().map(|(event, _)| event.as_str()).collect();
    assert_eq!(
        names,
        [
            "host.stall",
            "host.stall.resumed",
            "host.stall",
            "host.stall.sampled",
            "host.stall.resumed",
            "host.stall.sampled"
        ],
        "two stalls that end while the first sample runs, and the two samples"
    );
    for (event, fields) in events.iter() {
        if event == "host.stall" {
            assert!(fields["late_ms"].as_u64().unwrap() < 2000, "{fields}");
        }
    }
    assert_eq!(
        events[3].1["error"],
        "a sample of the threads is still running"
    );
    assert!(events[5].1.get("error").is_none(), "{:?}", events[5]);
}

/// A main run loop that waits or handles an event, with the state that the observers of the platform write: the start of a
/// wait and a wake are answers, and while it waits a heartbeat sends nothing and returns the start of the wait as both
/// times. While held it takes no heartbeat.
#[derive(Default)]
struct RunLoopState {
    wakes: bool,
    held: bool,
    answered: Duration,
    heartbeats: usize,
    blocked: usize,
}

struct FakeRunLoop {
    state: Mutex<RunLoopState>,
    awake: std::sync::Condvar,
    clock: Clock,
}

impl FakeRunLoop {
    fn new(clock: Clock) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(RunLoopState::default()),
            awake: std::sync::Condvar::new(),
            clock,
        })
    }

    fn heartbeat(self: &Arc<Self>) -> Heartbeat {
        let run_loop = Arc::clone(self);
        Box::new(move || {
            let mut state = run_loop.state.lock().unwrap();
            if !state.wakes {
                return Ok((state.answered, state.answered));
            }
            state.heartbeats += 1;
            let now = (run_loop.clock)();
            if !state.held {
                state.answered = now;
            }
            Ok((now, state.answered))
        })
    }

    fn await_awake(self: &Arc<Self>) -> AwaitAwake {
        let run_loop = Arc::clone(self);
        Box::new(move || {
            let mut state = run_loop.state.lock().unwrap();
            state.blocked += 1;
            while !state.wakes {
                state = run_loop.awake.wait(state).unwrap();
            }
            state.blocked -= 1;
            Ok(())
        })
    }

    fn wake(&self, held: bool) {
        let mut state = self.state.lock().unwrap();
        state.wakes = true;
        state.held = held;
        state.answered = (self.clock)();
        self.awake.notify_all();
    }

    fn wait(&self) {
        let mut state = self.state.lock().unwrap();
        state.wakes = false;
        state.held = false;
        state.answered = (self.clock)();
    }

    fn sent(&self) -> usize {
        self.state.lock().unwrap().heartbeats
    }

    fn await_blocked(&self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while self.state.lock().unwrap().blocked == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "the watch does not block while the run loop waits"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn await_heartbeats(&self, count: usize) {
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while self.sent() < count {
            assert!(
                std::time::Instant::now() < deadline,
                "{} heartbeats, want {count}",
                self.sent()
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

fn await_names(events: &Recorded, want: &[&str]) {
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    loop {
        let names: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .map(|(name, _)| name.clone())
            .collect();
        if names == want {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "events {names:?}, want {want:?}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

// contract: host.stall.waiting-run-loop-takes-no-heartbeat
#[test]
fn a_run_loop_that_waits_takes_no_heartbeat() {
    let now = Arc::new(Mutex::new(Duration::ZERO));
    let read = Arc::clone(&now);
    let clock: Clock = Arc::new(move || *read.lock().unwrap());
    let beat = Arc::clone(&now);
    let wait: Wait = Arc::new(move |length| {
        *beat.lock().unwrap() += length;
        std::thread::sleep(Duration::from_millis(1));
    });
    let run_loop = FakeRunLoop::new(Arc::clone(&clock));
    let events: Recorded = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let folder = folder::Folder::new();
    let stop = start_stall_watch(StallWatchOptions {
        heartbeat: run_loop.heartbeat(),
        await_awake: run_loop.await_awake(),
        sample: Arc::new(|_path| Ok(())),
        folder: folder.path().to_path_buf(),
        emit_host: Arc::new(move |_level, event, fields| {
            recorded.lock().unwrap().push((event.to_string(), fields))
        }),
        clock: Some(clock),
        wait: Some(wait),
    });

    // The run loop waits from the start of the watch.
    run_loop.await_blocked();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(run_loop.sent(), 0, "heartbeats to a run loop that waits");

    // It wakes and the beats start.
    run_loop.wake(false);
    run_loop.await_heartbeats(4);

    // It waits again: the watch blocks, and a time much longer than a beat sends nothing and stores nothing.
    run_loop.wait();
    run_loop.await_blocked();
    let sent = run_loop.sent();
    *now.lock().unwrap() += Duration::from_secs(10);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(run_loop.sent(), sent, "heartbeats to a run loop that waits");

    // The wake ends the block, and the 10 s of the wait are no lateness.
    run_loop.wake(false);
    run_loop.await_heartbeats(sent + 4);
    await_names(&events, &[]);

    // A run loop that wakes and does not turn is a stall, measured from its wake.
    run_loop.wait();
    run_loop.await_blocked();
    run_loop.wake(true);
    await_names(&events, &["host.stall", "host.stall.sampled"]);
    {
        let events = events.lock().unwrap();
        assert_eq!(events[0].1["late_ms"], 1000, "late_ms from the wake");
        assert_eq!(events[0].1["watch_late_ms"], 0);
    }
    stop();
    run_loop.wake(false);
}

// contract: host.stall.ends-when-the-run-loop-waits
#[test]
fn a_stall_that_ends_in_a_wait_is_resumed_and_its_sample_ends() {
    let (clock, wait) = controlled_time(Duration::ZERO);
    let run_loop = FakeRunLoop::new(Arc::clone(&clock));
    let events: Recorded = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let folder = folder::Folder::new();
    let (release, released) = mpsc::channel::<()>();
    let released = Mutex::new(released);
    let stop = start_stall_watch(StallWatchOptions {
        heartbeat: run_loop.heartbeat(),
        await_awake: run_loop.await_awake(),
        sample: Arc::new(move |_path| released.lock().unwrap().recv().map_err(|e| e.to_string())),
        folder: folder.path().to_path_buf(),
        emit_host: Arc::new(move |_level, event, fields| {
            recorded.lock().unwrap().push((event.to_string(), fields))
        }),
        clock: Some(clock),
        wait: Some(wait),
    });
    run_loop.await_blocked();
    run_loop.wake(true);
    await_names(&events, &["host.stall"]);

    // The main thread returns and its run loop waits before the next beat: the watch stores the end and then blocks, while
    // the sample goes on apart from it.
    run_loop.wait();
    await_names(&events, &["host.stall", "host.stall.resumed"]);
    run_loop.await_blocked();
    release.send(()).unwrap();
    await_names(
        &events,
        &["host.stall", "host.stall.resumed", "host.stall.sampled"],
    );
    assert!(events.lock().unwrap()[1].1["stalled_ms"].as_u64().unwrap() >= 1000);
    stop();
    run_loop.wake(false);
}
