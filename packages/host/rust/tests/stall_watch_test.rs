//! The watch of the main thread records a stall, the stacks of the threads and the end of the stall without a window check.

#[path = "support/folder.rs"]
mod folder;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use soksak_host::event_log::Level;
use soksak_host::stall_watch::{
    AwaitAwake, Clock, Heartbeat, StallWatchOptions, Wait, start_stall_watch,
};

/// The run loop of a main thread that always handles an event.
fn never_waits() -> AwaitAwake {
    Box::new(|| Ok(()))
}

/// Blocks the thread of a watch whose test ended, so that the watch neither spins nor records after its test.
fn park_for_good() -> ! {
    loop {
        std::thread::park();
    }
}

/// A clock that the test moves. The wait of each beat tells the test that the watch parked there, and the watch takes the
/// beat when the test lets it, late by an extra time that models a process that the system does not schedule for that long.
/// The watch handles a beat in full before it waits for the next one, so the place where it parks is the event after which
/// that beat stores nothing more.
struct SteppedTime {
    now: Arc<Mutex<Duration>>,
    parks: mpsc::SyncSender<&'static str>,
    parked: mpsc::Receiver<&'static str>,
    proceed: mpsc::Sender<Duration>,
    taken: Arc<Mutex<mpsc::Receiver<Duration>>>,
}

impl SteppedTime {
    fn new() -> Self {
        let (parks, parked) = mpsc::sync_channel(0);
        let (proceed, taken) = mpsc::channel();
        Self {
            now: Arc::new(Mutex::new(Duration::ZERO)),
            parks,
            parked,
            proceed,
            taken: Arc::new(Mutex::new(taken)),
        }
    }

    fn clock(&self) -> Clock {
        let now = Arc::clone(&self.now);
        Arc::new(move || *now.lock().unwrap())
    }

    fn advance(&self, length: Duration) {
        *self.now.lock().unwrap() += length;
    }

    /// The park of the watch at a place: "beat" for the wait of a beat and "awake" for the wait of the run loop.
    fn park(&self) -> impl Fn(&'static str) + Send + Sync + use<> {
        let parks = Mutex::new(self.parks.clone());
        move |place| {
            if parks.lock().unwrap().send(place).is_err() {
                park_for_good();
            }
        }
    }

    fn wait(&self) -> Wait {
        let park = self.park();
        let taken = Arc::clone(&self.taken);
        let now = Arc::clone(&self.now);
        Arc::new(move |beat| {
            park("beat");
            match taken.lock().unwrap().recv() {
                Ok(extra) => *now.lock().unwrap() += beat + extra,
                Err(_) => park_for_good(),
            }
        })
    }

    /// Requires that the watch parks next at `place`.
    fn require_park(&self, place: &str) {
        let got = self.parked.recv().expect("the watch did not park");
        assert_eq!(got, place, "the place where the watch parked");
    }

    /// Lets the watch that parked at a beat take it, late by `extra`, and requires that it parks next at `place`.
    fn beat(&self, extra: Duration, place: &str) {
        self.proceed.send(extra).unwrap();
        self.require_park(place);
    }

    /// Lets the watch take `count` beats on time, each followed by the wait of the next beat.
    fn beats(&self, count: usize) {
        for _ in 0..count {
            self.beat(Duration::ZERO, "beat");
        }
    }
}

/// The records of a watch: their names, levels and fields, and a notice of each record.
#[derive(Clone)]
struct Records {
    stored: Arc<Mutex<Vec<(String, Level, serde_json::Value)>>>,
    added: Arc<(Mutex<usize>, Condvar)>,
}

impl Records {
    fn new() -> Self {
        Self {
            stored: Arc::new(Mutex::new(Vec::new())),
            added: Arc::new((Mutex::new(0), Condvar::new())),
        }
    }

    fn emit(&self) -> soksak_host::stall_watch::Emit {
        let records = self.clone();
        Arc::new(move |level, event, fields| {
            records
                .stored
                .lock()
                .unwrap()
                .push((event.to_string(), level, fields));
            let (count, added) = &*records.added;
            *count.lock().unwrap() += 1;
            added.notify_all();
        })
    }

    fn names(&self) -> Vec<String> {
        self.stored
            .lock()
            .unwrap()
            .iter()
            .map(|(name, _, _)| name.clone())
            .collect()
    }

    fn fields(&self, index: usize) -> serde_json::Value {
        self.stored.lock().unwrap()[index].2.clone()
    }

    /// Checks the records that the beats stored, after the watch parked.
    fn require(&self, want: &[&str]) {
        assert_eq!(self.names(), want, "the records of the watch");
    }

    /// Checks the records that the beats stored, after the watch parked, while the sample of the stall runs apart from the beats
    /// and ends without a wait of its own: its `host.stall.sampled` comes before or after that park, so it is not one of them.
    fn require_beats(&self, want: &[&str]) {
        let names: Vec<String> = self
            .names()
            .into_iter()
            .filter(|name| name != "host.stall.sampled")
            .collect();
        assert_eq!(names, want, "the records that the beats stored");
    }

    /// Waits for the records of a sample, which ends apart from the beats.
    fn wait_for(&self, want: &[&str]) {
        let (count, added) = &*self.added;
        let mut seen = count.lock().unwrap();
        while self.names() != want {
            seen = added.wait(seen).unwrap();
        }
    }
}

/// A main run loop that waits or handles an event, with the state that the observers of the platform write: the start of a
/// wait and a wake are answers, and while it waits a heartbeat sends nothing and returns the start of the wait as both
/// times. While held it takes no heartbeat. The watch parks in its wait as "awake" of the stepped clock.
#[derive(Default)]
struct RunLoopState {
    wakes: bool,
    held: bool,
    answered: Duration,
    heartbeats: usize,
}

struct FakeRunLoop {
    state: Mutex<RunLoopState>,
    awake: Condvar,
    clock: Clock,
}

impl FakeRunLoop {
    fn new(clock: Clock) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(RunLoopState::default()),
            awake: Condvar::new(),
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

    fn await_awake(self: &Arc<Self>, time: &SteppedTime) -> AwaitAwake {
        let run_loop = Arc::clone(self);
        let park = time.park();
        Box::new(move || {
            if run_loop.state.lock().unwrap().wakes {
                return Ok(());
            }
            park("awake");
            let mut state = run_loop.state.lock().unwrap();
            while !state.wakes {
                state = run_loop.awake.wait(state).unwrap();
            }
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
}

// contract: host.stall.recorded-without-a-check
#[test]
fn a_blocked_main_thread_is_recorded_with_its_stacks_and_its_end() {
    // A fake main thread that answers each heartbeat until the test holds it.
    let time = SteppedTime::new();
    let run_loop = FakeRunLoop::new(time.clock());
    run_loop.wake(false);
    let records = Records::new();
    let sampled = Arc::new(Mutex::new(Vec::new()));
    let samples = Arc::clone(&sampled);
    let folder = folder::Folder::new();
    let stop = start_stall_watch(StallWatchOptions {
        heartbeat: run_loop.heartbeat(),
        await_awake: run_loop.await_awake(&time),
        sample: Arc::new(move |path| {
            samples.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }),
        folder: folder.path().to_path_buf(),
        emit_host: records.emit(),
        clock: Some(time.clock()),
        wait: Some(time.wait()),
        stop_waits: None,
    });
    // The first heartbeat and two beats are answered. The main thread is held from 500 ms, and the fourth beat after that is
    // 1000 ms late; the sample of that stall ends before the next beat.
    time.require_park("beat");
    time.beats(2);
    run_loop.wake(true);
    time.beats(4);
    records.require_beats(&["host.stall"]);
    records.wait_for(&["host.stall", "host.stall.sampled"]);
    // The main thread answers again, and the next beat at 1750 ms is the end of the stall.
    run_loop.wake(false);
    time.beats(1);
    records.require(&["host.stall", "host.stall.sampled", "host.stall.resumed"]);
    stop();
    assert_eq!(records.fields(0)["late_ms"], 1000);
    let fields = records.fields(1);
    let path = fields["path"].as_str().unwrap();
    assert!(path.contains("stall-host-"), "{path}");
    assert_eq!(
        sampled.lock().unwrap().as_slice(),
        [std::path::PathBuf::from(path)]
    );
    assert_eq!(records.fields(2)["stalled_ms"], 1250);
    // The stall and its dump are warnings, which the policy stores through the gate exception of passes_every_gate; the end
    // of the stall is info.
    for (name, level, _) in records.stored.lock().unwrap().iter() {
        let want = if name == "host.stall.resumed" {
            Level::Info
        } else {
            Level::Warn
        };
        assert_eq!(*level, want, "{name}");
    }
}

/// Runs the watch with a main thread that never takes a task, and returns the fields of the first `host.stall` record. The
/// first beat is late by `extra`.
fn first_stall(extra: Duration) -> serde_json::Value {
    let time = SteppedTime::new();
    let records = Records::new();
    let folder = folder::Folder::new();
    let stop = start_stall_watch(StallWatchOptions {
        // The main thread never answers, so the time of the answer stays the time of the first heartbeat, the start of the
        // clock.
        heartbeat: {
            let clock = time.clock();
            Box::new(move || Ok((clock(), Duration::ZERO)))
        },
        await_awake: never_waits(),
        sample: Arc::new(|_path| Ok(())),
        folder: folder.path().to_path_buf(),
        emit_host: records.emit(),
        clock: Some(time.clock()),
        wait: Some(time.wait()),
        stop_waits: None,
    });
    time.require_park("beat");
    let mut late = extra;
    for _ in 0..4 {
        time.beat(late, "beat");
        late = Duration::ZERO;
        if let Some(name) = records.names().first() {
            assert_eq!(name, "host.stall", "the first record");
            stop();
            return records.fields(0);
        }
    }
    panic!("no host.stall record after 4 beats of a main thread that never answers");
}

// contract: host.stall.watch-late-separates-scheduling
#[test]
fn a_stall_of_an_unscheduled_process_carries_its_lateness_in_the_watch() {
    // The first beat is 1600 ms late for the watch and for the main thread alike, so the stall is seen at 1850 ms.
    let fields = first_stall(Duration::from_millis(1600));
    assert_eq!(fields["late_ms"], 1850, "{fields}");
    assert_eq!(fields["watch_late_ms"], 1600, "{fields}");
}

// contract: host.stall.watch-late-separates-blocked-main
#[test]
fn a_stall_of_a_blocked_main_thread_has_no_lateness_in_the_watch() {
    // The watch wakes on every beat; the main thread never runs the heartbeat, so the stall is seen at 1000 ms.
    let fields = first_stall(Duration::ZERO);
    assert_eq!(fields["late_ms"], 1000, "{fields}");
    assert_eq!(fields["watch_late_ms"], 0, "{fields}");
}

// contract: host.stall.sample-keeps-the-watch-running
#[test]
fn a_sample_of_the_threads_does_not_stop_the_watch() {
    // A fake main thread and a sample that lasts until the test ends it, as a sample of a loaded system lasts for seconds.
    let time = SteppedTime::new();
    let run_loop = FakeRunLoop::new(time.clock());
    run_loop.wake(false);
    let records = Records::new();
    let (release, released) = mpsc::channel::<()>();
    let released = Mutex::new(released);
    let folder = folder::Folder::new();
    let stop = start_stall_watch(StallWatchOptions {
        heartbeat: run_loop.heartbeat(),
        await_awake: run_loop.await_awake(&time),
        sample: Arc::new(move |_path| released.lock().unwrap().recv().map_err(|e| e.to_string())),
        folder: folder.path().to_path_buf(),
        emit_host: records.emit(),
        clock: Some(time.clock()),
        wait: Some(time.wait()),
        stop_waits: None,
    });
    // Holds the main thread for four beats, which is a stall, and answers again on the next beat, which ends it.
    let stall_and_end = |want: &[&str]| {
        run_loop.wake(true);
        time.beats(4);
        run_loop.wake(false);
        time.beats(1);
        records.require(want);
    };
    time.require_park("beat");
    time.beats(1);
    stall_and_end(&["host.stall", "host.stall.resumed"]);
    stall_and_end(&[
        "host.stall",
        "host.stall.resumed",
        "host.stall",
        "host.stall.sampled",
        "host.stall.resumed",
    ]);
    release.send(()).unwrap();
    records.wait_for(&[
        "host.stall",
        "host.stall.resumed",
        "host.stall",
        "host.stall.sampled",
        "host.stall.resumed",
        "host.stall.sampled",
    ]);
    stop();
    for (event, _, fields) in records.stored.lock().unwrap().iter() {
        if event == "host.stall" {
            assert_eq!(fields["late_ms"], 1000, "a main thread held for four beats");
        }
    }
    assert_eq!(
        records.fields(3)["error"],
        "a sample of the threads is still running"
    );
    assert!(
        records.fields(5).get("error").is_none(),
        "{}",
        records.fields(5)
    );
}

// contract: host.stall.waiting-run-loop-takes-no-heartbeat
#[test]
fn a_run_loop_that_waits_takes_no_heartbeat() {
    let time = SteppedTime::new();
    let run_loop = FakeRunLoop::new(time.clock());
    let records = Records::new();
    let folder = folder::Folder::new();
    let stop = start_stall_watch(StallWatchOptions {
        heartbeat: run_loop.heartbeat(),
        await_awake: run_loop.await_awake(&time),
        sample: Arc::new(|_path| Ok(())),
        folder: folder.path().to_path_buf(),
        emit_host: records.emit(),
        clock: Some(time.clock()),
        wait: Some(time.wait()),
        stop_waits: None,
    });

    // The run loop waits from the start of the watch, and the watch parks in that wait before it sends anything.
    time.require_park("awake");
    assert_eq!(run_loop.sent(), 0, "heartbeats to a run loop that waits");

    // It wakes and the beats start.
    run_loop.wake(false);
    time.require_park("beat");
    time.beats(3);
    assert_eq!(run_loop.sent(), 4, "the first heartbeat and three beats");

    // It waits again: the beat after that parks the watch in the wait, so a time much longer than a beat sends nothing and
    // stores nothing.
    run_loop.wait();
    time.beat(Duration::ZERO, "awake");
    let sent = run_loop.sent();
    time.advance(Duration::from_secs(10));
    assert_eq!(run_loop.sent(), sent, "heartbeats to a run loop that waits");

    // The wake ends the block, and the 10 s of the wait are no lateness.
    run_loop.wake(false);
    time.require_park("beat");
    time.beats(4);
    assert_eq!(run_loop.sent(), sent + 4, "the heartbeats after the wake");
    records.require(&[]);

    // A run loop that wakes and does not turn is a stall, measured from its wake.
    run_loop.wait();
    time.beat(Duration::ZERO, "awake");
    run_loop.wake(true);
    time.require_park("beat");
    time.beats(4);
    records.require_beats(&["host.stall"]);
    records.wait_for(&["host.stall", "host.stall.sampled"]);
    assert_eq!(records.fields(0)["late_ms"], 1000, "late_ms from the wake");
    assert_eq!(records.fields(0)["watch_late_ms"], 0);
    stop();
    run_loop.wake(false);
}

// contract: host.stall.ends-when-the-run-loop-waits
#[test]
fn a_stall_that_ends_in_a_wait_is_resumed_and_its_sample_ends() {
    let time = SteppedTime::new();
    let run_loop = FakeRunLoop::new(time.clock());
    let records = Records::new();
    let folder = folder::Folder::new();
    let (release, released) = mpsc::channel::<()>();
    let released = Mutex::new(released);
    let stop = start_stall_watch(StallWatchOptions {
        heartbeat: run_loop.heartbeat(),
        await_awake: run_loop.await_awake(&time),
        sample: Arc::new(move |_path| released.lock().unwrap().recv().map_err(|e| e.to_string())),
        folder: folder.path().to_path_buf(),
        emit_host: records.emit(),
        clock: Some(time.clock()),
        wait: Some(time.wait()),
        stop_waits: None,
    });
    time.require_park("awake");
    run_loop.wake(true);
    time.require_park("beat");
    time.beats(4);
    records.require(&["host.stall"]);

    // The main thread returns and its run loop waits before the next beat: the watch stores the end and parks in that wait,
    // while the sample goes on apart from it.
    run_loop.wait();
    time.beat(Duration::ZERO, "awake");
    records.require(&["host.stall", "host.stall.resumed"]);
    release.send(()).unwrap();
    records.wait_for(&["host.stall", "host.stall.resumed", "host.stall.sampled"]);
    assert_eq!(records.fields(1)["stalled_ms"], 1000);
    stop();
    run_loop.wake(false);
}

// contract: host.stall.stop-waits-for-the-sample
#[test]
fn stopping_the_watch_waits_for_the_running_sample() {
    // The main thread never answers, so the fourth beat of the stepped clock is a stall that starts a sample. The sample
    // lasts until the test ends it, as the sample of the system lasts for a second, and the stop of the watch comes while it
    // runs.
    let time = SteppedTime::new();
    let records = Records::new();
    let folder = folder::Folder::new();
    let (started, starts) = mpsc::channel::<()>();
    let started = Mutex::new(started);
    let (release, released) = mpsc::channel::<()>();
    let released = Mutex::new(released);
    let samples = Arc::new(AtomicUsize::new(0));
    let ended = Arc::new(AtomicBool::new(false));
    let counted = Arc::clone(&samples);
    let finished = Arc::clone(&ended);
    let (waits, waiting) = mpsc::channel::<()>();
    let stop = start_stall_watch(StallWatchOptions {
        heartbeat: {
            let clock = time.clock();
            Box::new(move || Ok((clock(), Duration::ZERO)))
        },
        await_awake: never_waits(),
        sample: Arc::new(move |_path| {
            counted.fetch_add(1, Ordering::SeqCst);
            started
                .lock()
                .unwrap()
                .send(())
                .map_err(|e| e.to_string())?;
            released.lock().unwrap().recv().map_err(|e| e.to_string())?;
            finished.store(true, Ordering::SeqCst);
            Ok(())
        }),
        folder: folder.path().to_path_buf(),
        emit_host: records.emit(),
        clock: Some(time.clock()),
        wait: Some(time.wait()),
        stop_waits: Some(Box::new(move || waits.send(()).unwrap())),
    });
    time.require_park("beat");
    time.beats(4);
    starts.recv().expect("no sample of the stall started");
    // The sample ends only after the stop began to wait for it, so a stop that returns before that event returned while the
    // sample ran, and one that neither waits nor returns stops at the limit of the runner.
    let (events, event) = mpsc::channel::<Option<bool>>();
    let returned = events.clone();
    let stopped = Arc::clone(&ended);
    std::thread::spawn(move || {
        stop();
        returned.send(Some(stopped.load(Ordering::SeqCst))).unwrap();
    });
    std::thread::spawn(move || {
        if waiting.recv().is_ok() {
            events.send(None).unwrap();
        }
    });
    assert_eq!(
        event.recv().unwrap(),
        None,
        "the stop of the watch returned while the sample of the threads still ran"
    );
    assert!(
        event.try_recv().is_err(),
        "the stop of the watch returned while the sample of the threads still ran"
    );
    release.send(()).unwrap();
    assert_eq!(
        event.recv().unwrap(),
        Some(true),
        "the stop of the watch returned while the sample of the threads still ran"
    );
    assert_eq!(records.names(), ["host.stall", "host.stall.sampled"]);
    assert_eq!(samples.load(Ordering::SeqCst), 1);
}
