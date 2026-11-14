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
/// Reads the scheduling priority of the process and the CPU time of its threads in nanoseconds, which the stall and its end
/// carry; a read that fails is the error record `stall watch`.
pub type Schedule = Box<dyn Fn() -> Result<(i32, u64), String> + Send>;
/// Writes the stacks of the threads of the process into a file.
pub type Sample = Arc<dyn Fn(&Path) -> Result<(), String> + Send + Sync>;
/// Stores an event.
pub type Emit = Arc<dyn Fn(Level, &str, serde_json::Value) + Send + Sync>;
/// Called by the stop when it begins to wait for a sample that runs, before it waits. A check releases the sample that it
/// holds (the fault point SOKSAK_FAULT_STALL_SAMPLE, stall_fault.rs) after this event, so a stop that returns before it finds
/// the sample running; the host gives none.
pub type StopWaits = Box<dyn FnOnce() + Send>;

/// The parts of the watch: `heartbeat` and `await_awake` reach the watched thread, `schedule` reads the schedule of the
/// process, `sample` writes the stacks of the threads of the process into a file, `folder` is the logs folder and `emit_host`
/// stores an event of the host. `stop_waits` is the event of the stop that begins to wait for a running sample.
pub struct StallWatchOptions {
    pub heartbeat: Heartbeat,
    pub await_awake: AwaitAwake,
    pub schedule: Schedule,
    pub sample: Sample,
    pub folder: PathBuf,
    pub emit_host: Emit,
    pub stop_waits: Option<StopWaits>,
}

/// The state of the watch between two beats.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct StallState {
    /// The last answer of the open stall in milliseconds, or None when no stall is open.
    stalled_from: Option<u64>,
    /// The CPU time of the process in nanoseconds when the open stall was recorded, when it was read.
    cpu: Option<u64>,
}

/// What the watch reads on one beat: the time of the heartbeat and the time of its last answer in milliseconds, the lateness
/// of the wake of the watch beyond STALL_BEAT, and the schedule, which only a beat that starts or ends a stall reads
/// (`stall_changes`); the schedule of any other beat is `Ok((0, 0))`, which `stall_step` does not read.
#[derive(Clone, Debug, PartialEq)]
struct StallReading {
    now: u64,
    last: u64,
    watch_late: Duration,
    schedule: Result<(i32, u64), String>,
}

/// The event of the host that a beat stores.
#[derive(Debug, PartialEq)]
struct StallRecord {
    level: Level,
    event: &'static str,
    fields: serde_json::Value,
}

/// The decision of the watch on one beat. `next` is the state after the beat. `record` is the event of the host that the beat
/// stores, and it is None for a beat that stores none. `starts` reports that the beat starts a stall, which starts a sample.
/// `schedule_error` is the failure of the schedule read that the beat reports.
#[derive(Debug, PartialEq)]
struct StallOutcome {
    next: StallState,
    starts: bool,
    record: Option<StallRecord>,
    schedule_error: Option<String>,
}

/// Whether a beat finds a stall: no stall is open and the last answer is STALL_LATE or more before the heartbeat.
fn stall_starts(state: &StallState, now: u64, last: u64) -> bool {
    state.stalled_from.is_none() && now.saturating_sub(last) >= STALL_LATE.as_millis() as u64
}

/// Whether a beat finds the end of the open stall: the thread answered after the stall was recorded.
fn stall_ends(state: &StallState, last: u64) -> bool {
    state.stalled_from.is_some_and(|from| last > from)
}

/// Whether a beat starts or ends a stall, which are the only beats that read the schedule.
fn stall_changes(state: &StallState, now: u64, last: u64) -> bool {
    stall_starts(state, now, last) || stall_ends(state, last)
}

/// The decision of the watch on one beat from its state and its readings. A beat that neither starts nor ends a stall stores
/// nothing and keeps the state. The schedule of the reading is read only when `stall_changes` reports the beat.
fn stall_step(state: &StallState, reading: &StallReading) -> StallOutcome {
    if stall_starts(state, reading.now, reading.last) {
        let mut fields = json!({
            "late_ms": reading.now - reading.last,
            "watch_late_ms": reading.watch_late.as_millis() as u64,
        });
        let mut outcome = StallOutcome {
            next: StallState {
                stalled_from: Some(reading.last),
                cpu: None,
            },
            starts: true,
            record: None,
            schedule_error: None,
        };
        match &reading.schedule {
            Ok((priority, cpu)) => {
                fields["priority"] = json!(priority);
                outcome.next.cpu = Some(*cpu);
            }
            Err(error) => outcome.schedule_error = Some(error.clone()),
        }
        outcome.record = Some(StallRecord {
            level: Level::Warn,
            event: "host.stall",
            fields,
        });
        return outcome;
    }
    if let Some(from) = state.stalled_from
        && stall_ends(state, reading.last)
    {
        let mut fields = json!({"stalled_ms": reading.last - from});
        let mut outcome = StallOutcome {
            next: StallState {
                stalled_from: None,
                cpu: state.cpu,
            },
            starts: false,
            record: None,
            schedule_error: None,
        };
        match &reading.schedule {
            Ok((_, cpu)) => {
                if let Some(at_stall) = state.cpu {
                    fields["cpu_ms"] = json!(cpu.saturating_sub(at_stall) / 1_000_000);
                }
            }
            Err(error) => outcome.schedule_error = Some(error.clone()),
        }
        outcome.record = Some(StallRecord {
            level: Level::Info,
            event: "host.stall.resumed",
            fields,
        });
        return outcome;
    }
    StallOutcome {
        next: *state,
        starts: false,
        record: None,
        schedule_error: None,
    }
}

/// What the watch does with the sample of a beat.
#[derive(Clone, Copy, Debug, PartialEq)]
enum StallAction {
    /// The beat starts no stall.
    None,
    /// Starts the sample of the stall.
    Start,
    /// Reports the stall as a sample that cannot start, because the sample of an earlier stall still runs.
    Running,
    /// Ends the watch without a record: the stop came before the stall was recorded.
    Stopped,
}

/// What the loop of the watch does after one beat: the action on the sample and whether the watch blocks until the run loop of
/// the watched thread wakes.
#[derive(Clone, Copy, Debug, PartialEq)]
struct StallLoopDecision {
    sample: StallAction,
    await_awake: bool,
}

/// The decision of the loop on the outcome of one beat, from whether the sample of an earlier stall runs and whether the stop
/// came. An open stall keeps the beat: the heartbeat of the beat was sent before the run loop could start to wait, so a stall
/// that ended in that wait has its end only from the next heartbeat, which the wait answers with its start. The watch blocks
/// only while no stall is open, which is also the only time the run loop of the watched thread waits.
fn stall_loop_step(outcome: &StallOutcome, sampling: bool, stopped: bool) -> StallLoopDecision {
    let mut decision = StallLoopDecision {
        sample: StallAction::None,
        await_awake: outcome.next.stalled_from.is_none(),
    };
    if outcome.starts {
        if stopped {
            decision.sample = StallAction::Stopped;
            decision.await_awake = false;
        } else if sampling {
            decision.sample = StallAction::Running;
        } else {
            decision.sample = StallAction::Start;
        }
    }
    decision
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
pub fn start_stall_watch(mut options: StallWatchOptions) -> impl FnOnce() {
    let stop_waits = options.stop_waits.take();
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
        let mut state = StallState::default();
        while !stopped.load(Ordering::Acquire) {
            let before = Instant::now();
            std::thread::sleep(STALL_BEAT);
            // The lateness of this beat: the time that the watch slept beyond STALL_BEAT. When the whole process is not scheduled,
            // the watch wakes late as well as the main thread; when the main thread is blocked, the watch wakes on time.
            let watch_late = before.elapsed().saturating_sub(STALL_BEAT);
            let (sent, answered) = match (options.heartbeat)() {
                Ok(times) => times,
                Err(error) => return refused(error),
            };
            let now = sent.as_millis() as u64;
            let last = answered.as_millis() as u64;
            let schedule = if stall_changes(&state, now, last) {
                (options.schedule)()
            } else {
                Ok((0, 0))
            };
            let outcome = stall_step(
                &state,
                &StallReading {
                    now,
                    last,
                    watch_late,
                    schedule,
                },
            );
            let end = outcome.starts.then(|| {
                ending
                    .lock()
                    // default: a lock that a panicking thread poisoned still holds the state of the end; the panic hook records
                    // the panic.
                    .unwrap_or_else(PoisonError::into_inner)
            });
            let decision = stall_loop_step(
                &outcome,
                sampling.load(Ordering::Acquire),
                stopped.load(Ordering::Acquire),
            );
            if decision.sample == StallAction::Stopped {
                // A stall that the watch finds after its stop is not recorded: the host ends, and the stop joins only a sample
                // that started before it.
                return;
            }
            state = outcome.next;
            if let Some(error) = &outcome.schedule_error {
                crate::application_log::log_error("stall watch", error);
            }
            if let Some(record) = outcome.record {
                // events: host.stall, host.stall.resumed
                emit_host(record.level, record.event, record.fields);
            }
            match decision.sample {
                StallAction::Running => {
                    drop(end);
                    emit_host(
                        Level::Warn,
                        "host.stall.sampled",
                        json!({"path": dump_path(&options.folder), "error": STALL_SAMPLE_RUNNING}),
                    );
                }
                StallAction::Start => {
                    if let Some(mut end) = end {
                        // Only this thread starts a sample, and the sample ends by itself, so the flag that the decision read
                        // stays false until this store.
                        sampling.store(true, Ordering::Release);
                        let path = dump_path(&options.folder);
                        // A sample lasts for seconds on a loaded system. The watch keeps sending heartbeats meanwhile, so that
                        // time is not read as lateness of the main thread.
                        let sample = Arc::clone(&options.sample);
                        let emit = Arc::clone(&options.emit_host);
                        let running = Arc::clone(&sampling);
                        end.sample = Some(crate::routine::spawn_named("stall sample", move || {
                            let fields = match fault::sample_fault().and_then(|()| sample(&path)) {
                                Ok(()) => json!({"path": path}),
                                Err(error) => json!({"path": path, "error": error}),
                            };
                            emit(Level::Warn, "host.stall.sampled", fields);
                            running.store(false, Ordering::Release);
                        }));
                    }
                }
                StallAction::None | StallAction::Stopped => {}
            }
            if decision.await_awake
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
        if let Some(sample) = sample {
            // A sample starts only under the lock of the end and before the stop, so a sample that ended now never runs again.
            if !sample.is_finished()
                && let Some(stop_waits) = stop_waits
            {
                stop_waits();
            }
            if sample.join().is_err() {
                crate::application_log::log_error(
                    "stall watch",
                    "the sample of the threads panicked",
                );
            }
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

#[cfg(feature = "diagnostics")]
#[path = "stall_fault.rs"]
mod fault;

#[cfg(not(feature = "diagnostics"))]
#[path = "stall_fault_release.rs"]
mod fault;

#[cfg(test)]
#[path = "stall_watch_test.rs"]
mod stall_watch_test;
