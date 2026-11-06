//! The watch of the main thread (docs/spec/logging.md, stalls). A stall is the absence of events, which no event of the
//! stalled thread reports, so a thread outside the main thread sends a heartbeat to it and compares the last heartbeat with
//! the clock. No event source reports a thread that does not run, which is why this watch uses a timer while the thread
//! handles an event. A run loop that waits for an event cannot be stalled, so the watch blocks without a timer through
//! that wait. A heartbeat STALL_LATE or more late is `host.stall`, with `watch_late_ms`, the lateness of the watch's own wake: a stall in which the
//! watch wakes late too is a process that the system did not schedule, and one in which it wakes on time is a blocked main
//! thread. The stacks of the threads go into a file of the logs folder as
//! `host.stall.sampled`, and the next heartbeat is `host.stall.resumed` with the length of the stall.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::event_log::Level;

/// The interval of the heartbeat and of the check.
const STALL_BEAT: Duration = Duration::from_millis(250);
/// The lateness of a heartbeat that is a stall.
const STALL_LATE: Duration = Duration::from_secs(1);
/// The error of a stall during the sample of an earlier stall.
const STALL_SAMPLE_RUNNING: &str = "a sample of the threads is still running";

/// Sends a heartbeat that the watched thread answers and returns the time of the call and the time of the last answer on
/// one clock, where the time of the answer is the time of the first heartbeat while none was answered. While the run loop
/// of the watched thread waits for an event, it sends nothing and returns the start of that wait as both times.
pub type Heartbeat = Box<dyn Fn() -> Result<(Duration, Duration), String> + Send>;
/// Blocks while the run loop of the watched thread waits for an event, and returns while it does not.
pub type AwaitAwake = Box<dyn Fn() -> Result<(), String> + Send>;
/// Writes the stacks of the threads of the process into a file.
pub type Sample = Arc<dyn Fn(&Path) -> Result<(), String> + Send + Sync>;
/// Stores an event.
pub type Emit = Arc<dyn Fn(Level, &str, serde_json::Value) + Send + Sync>;
/// The time since the watch started. A test gives a clock that it controls; the host gives none.
pub type Clock = Arc<dyn Fn() -> Duration + Send + Sync>;
/// Waits one beat. A test gives a wait that advances its clock; the host gives none, and the watch sleeps.
pub type Wait = Arc<dyn Fn(Duration) + Send + Sync>;

/// The parts of the watch: `heartbeat` and `await_awake` reach the watched thread, `sample` writes the stacks of the threads of the
/// process into a file, `folder` is the logs folder and `emit_host` stores an event of the host. `clock` and `wait` are the
/// seams of the time: None takes the monotonic clock and the thread sleep.
pub struct StallWatchOptions {
    pub heartbeat: Heartbeat,
    pub await_awake: AwaitAwake,
    pub sample: Sample,
    pub folder: PathBuf,
    pub emit_host: Emit,
    pub clock: Option<Clock>,
    pub wait: Option<Wait>,
}

/// The end of the watch: whether it stopped, and the thread of the sample that started last. The watch starts a sample only
/// while it holds this state and the stop has not come, so the stop joins every sample that started.
#[derive(Default)]
struct Ending {
    stopped: bool,
    sample: Option<std::thread::JoinHandle<()>>,
}

/// Starts the watch and returns the function that stops it. The stop starts no sample after it and returns when the
/// running sample ended and stored its `host.stall.sampled`, so the process of the sample does not outlive the host and the
/// stall keeps its dump.
pub fn start_stall_watch(options: StallWatchOptions) -> impl FnOnce() {
    // default: the host gives no clock, so the watch measures time with the monotonic clock from its start.
    let clock: Clock = options.clock.clone().unwrap_or_else(|| {
        let start = Instant::now();
        Arc::new(move || start.elapsed())
    });
    let wait: Wait = options
        .wait
        .clone()
        // default: the host gives no wait, so the watch sleeps one beat on its thread.
        .unwrap_or_else(|| Arc::new(std::thread::sleep));
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = Arc::clone(&stopped);
    let sampling = Arc::new(AtomicBool::new(false));
    let ending = Arc::new(Mutex::new(Ending::default()));
    let stop_ending = Arc::clone(&ending);
    crate::routine::spawn_named("stall watch", move || {
        let emit_host = &options.emit_host;
        // A watched thread that takes no heartbeat any more ends the watch, and the error says so.
        let refused = |error: String| {
            crate::application_log::log_error("stall watch", format!("heartbeat: {error}"));
        };
        if let Err(error) = (options.await_awake)() {
            return refused(error);
        }
        // The first heartbeat is the reference of the answers until the watched thread answers one.
        if let Err(error) = (options.heartbeat)() {
            return refused(error);
        }
        let mut stalled_from: Option<u64> = None;
        while !stopped.load(Ordering::Acquire) {
            let before = clock();
            wait(STALL_BEAT);
            // The lateness of this beat: the time that the watch slept beyond STALL_BEAT. When the whole process is not scheduled,
            // the watch wakes late as well as the main thread; when the main thread is blocked, the watch wakes on time.
            let watch_late = clock().saturating_sub(before).saturating_sub(STALL_BEAT);
            let (sent, answered) = match (options.heartbeat)() {
                Ok(times) => times,
                Err(error) => return refused(error),
            };
            let now = sent.as_millis() as u64;
            let last = answered.as_millis() as u64;
            match stalled_from {
                None if now.saturating_sub(last) >= STALL_LATE.as_millis() as u64 => {
                    // A stall that the watch finds after its stop is not recorded: the host ends, and the stop joins only a
                    // sample that started before it.
                    let mut end = ending
                        .lock()
                        // default: a lock that a panicking thread poisoned still holds the state of the end; the panic hook
                        // records the panic.
                        .unwrap_or_else(PoisonError::into_inner);
                    if end.stopped {
                        return;
                    }
                    stalled_from = Some(last);
                    emit_host(
                        Level::Warn,
                        "host.stall",
                        json!({"late_ms": now - last, "watch_late_ms": watch_late.as_millis() as u64}),
                    );
                    let path = dump_path(&options.folder);
                    if sampling.swap(true, Ordering::AcqRel) {
                        emit_host(
                            Level::Warn,
                            "host.stall.sampled",
                            json!({"path": path, "error": STALL_SAMPLE_RUNNING}),
                        );
                    } else {
                        // A sample lasts for seconds on a loaded system. The watch keeps sending heartbeats meanwhile, so that
                        // time is not read as lateness of the main thread.
                        let sample = Arc::clone(&options.sample);
                        let emit = Arc::clone(&options.emit_host);
                        let running = Arc::clone(&sampling);
                        end.sample = Some(crate::routine::spawn_named("stall sample", move || {
                            let fields = match sample(&path) {
                                Ok(()) => json!({"path": path}),
                                Err(error) => json!({"path": path, "error": error}),
                            };
                            emit(Level::Warn, "host.stall.sampled", fields);
                            running.store(false, Ordering::Release);
                        }));
                    }
                }
                Some(from) if last > from => {
                    stalled_from = None;
                    emit_host(
                        Level::Info,
                        "host.stall.resumed",
                        json!({"stalled_ms": last - from}),
                    );
                }
                _ => {}
            }
            // An open stall keeps the beat: the heartbeat of this check was sent before the run loop could start to wait, so a
            // stall that ended in that wait has its end only from the next heartbeat, which the wait answers with its start.
            // The watch blocks only while no stall is open, which is also the only time the run loop of the watched thread
            // waits.
            if stalled_from.is_none()
                && let Err(error) = (options.await_awake)()
            {
                return refused(error);
            }
        }
    });
    move || {
        let sample = {
            let mut end = stop_ending
                .lock()
                // default: a lock that a panicking thread poisoned still holds the state of the end; the panic hook records
                // the panic.
                .unwrap_or_else(PoisonError::into_inner);
            end.stopped = true;
            stop.store(true, Ordering::Release);
            end.sample.take()
        };
        if let Some(sample) = sample
            && sample.join().is_err()
        {
            crate::application_log::log_error("stall watch", "the sample of the threads panicked");
        }
    }
}

/// The file of a dump: `stall-host-<pid>-<ms>.txt` in the logs folder.
fn dump_path(folder: &Path) -> PathBuf {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    folder.join(format!("stall-host-{}-{ms}.txt", std::process::id()))
}
