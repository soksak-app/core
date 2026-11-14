//! The scenarios of tests/stall_watch_test.rs on macOS: the main run loop and the held main thread of each child process, and the
//! records that the watch stores for each scenario.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex, Once};
use std::time::{Duration, Instant};

use core_foundation::date::CFDate;
use core_foundation::runloop::{
    CFRunLoop, CFRunLoopRunResult, CFRunLoopTimer, CFRunLoopTimerRef, kCFRunLoopDefaultMode,
};
use serde_json::Value;
use soksak_host::event_log::EventLog;
use soksak_host::event_record::{emit_host, use_host_event_log};
use soksak_host::platform;
use soksak_host::stall_watch::{Heartbeat, StallWatchOptions, StopWaits, start_stall_watch};

use crate::main_thread::{self, MainTest};
use crate::{folder, records};

/// The environment variable that names the scenario that a child process runs.
const SCENARIO: &str = "SOKSAK_STALL_SCENARIO";
/// The environment variable that names the configuration folder of the scenario.
const CONFIG: &str = "SOKSAK_STALL_CONFIG";
/// The time after which a scenario that still waits for a record ends with an error.
const DEADLINE: Duration = Duration::from_secs(30);
/// The fault point of the sample of a stall, which names the FIFO that holds the sample (src/stall_fault.rs).
#[cfg(feature = "diagnostics")]
const FAULT_STALL_SAMPLE: &str = "SOKSAK_FAULT_STALL_SAMPLE";

unsafe extern "C" {
    fn sp_stall_counts(sent: *mut u64, sent_in_wait: *mut u64, answered: *mut u64);
}

/// The number of heartbeats that sent their block to the main thread since the start of the process.
fn heartbeats_sent() -> u64 {
    let (mut sent, mut sent_in_wait, mut answered) = (0u64, 0u64, 0u64);
    unsafe { sp_stall_counts(&mut sent, &mut sent_in_wait, &mut answered) };
    sent
}

extern "C" fn never_fires(_timer: CFRunLoopTimerRef, _info: *mut c_void) {}

/// Runs the main run loop of the calling thread, which must be the main thread, for `duration`. The run loop waits for an
/// event while it has none, and wakes when the time ends. A run loop whose mode has no source or timer returns at once
/// instead of waiting, so a timer that fires after a day keeps the default mode.
fn pump(duration: Duration) -> Result<(), String> {
    static PREPARED: Once = Once::new();
    PREPARED.call_once(|| {
        let timer = CFRunLoopTimer::new(
            CFDate::now().abs_time() + 86_400.0,
            0.0,
            0,
            0,
            never_fires,
            std::ptr::null_mut(),
        );
        CFRunLoop::get_main().add_timer(&timer, unsafe { kCFRunLoopDefaultMode });
    });
    match CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, duration, false) {
        CFRunLoopRunResult::TimedOut => Ok(()),
        other => Err(format!(
            "the run loop ended with {other:?} before its time of {duration:?}"
        )),
    }
}

/// The names of the records that the watch stored, and a notice of each record.
struct Names {
    stored: Mutex<Vec<String>>,
    changed: Condvar,
}

impl Names {
    fn counted(stored: &[String], name: &str) -> usize {
        stored.iter().filter(|stored| *stored == name).count()
    }
}

type Stop = Box<dyn FnOnce() + Send>;

/// The watch of a scenario with the real platform and the real event log, and the count of the records that the watch
/// stored, which the scenario waits for.
struct Run {
    log: Arc<EventLog>,
    stop: Option<Stop>,
    names: Arc<Names>,
    deadline: Instant,
}

impl Run {
    /// Starts the event log of the configuration folder with every level stored and the watch of the main thread. A None
    /// heartbeat is the heartbeat of the platform; `stop_waits` is the StopWaits of the watch.
    fn start(
        config: &Path,
        heartbeat: Option<Heartbeat>,
        stop_waits: Option<StopWaits>,
    ) -> Result<Run, String> {
        let system = platform::current()?;
        let log = records::start_writer(config);
        let names = Arc::new(Names {
            stored: Mutex::new(Vec::new()),
            changed: Condvar::new(),
        });
        let heartbeat = heartbeat.unwrap_or_else(|| {
            Box::new(move || {
                let (now, answered) = system.stall_heartbeat()?;
                Ok((Duration::from_nanos(now), Duration::from_nanos(answered)))
            })
        });
        let emitted = Arc::clone(&names);
        let stop = start_stall_watch(StallWatchOptions {
            heartbeat,
            await_awake: Box::new(move || system.stall_await_awake()),
            schedule: Box::new(move || system.stall_schedule()),
            sample: Arc::new(move |path| system.sample_threads(path)),
            folder: config.join("logs"),
            emit_host: Arc::new(move |level, name, fields| {
                emit_host(level, name, fields);
                emitted.stored.lock().unwrap().push(name.to_string());
                emitted.changed.notify_all();
            }),
            stop_waits,
        });
        Ok(Run {
            log,
            stop: Some(Box::new(stop)),
            names,
            deadline: Instant::now() + DEADLINE,
        })
    }

    /// The names of the records that the watch stored, in order.
    fn joined(&self) -> String {
        self.names.stored.lock().unwrap().join(",")
    }

    /// Holds the main thread, so that it runs no run loop, until the watch stored `count` records of `name`.
    fn hold_until(&self, name: &str, count: usize) -> Result<(), String> {
        let mut stored = self.names.stored.lock().unwrap();
        while Names::counted(&stored, name) < count {
            let left = self
                .deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    format!(
                        "the watch stored {:?}, want {count} of {name}",
                        stored.join(",")
                    )
                })?;
            stored = self.names.changed.wait_timeout(stored, left).unwrap().0;
        }
        Ok(())
    }

    /// Runs the main run loop until the watch stored `count` records of `name`.
    fn pump_until(&self, name: &str, count: usize) -> Result<(), String> {
        while Names::counted(&self.names.stored.lock().unwrap(), name) < count {
            if Instant::now() >= self.deadline {
                return Err(format!(
                    "the watch stored {:?}, want {count} of {name}",
                    self.joined()
                ));
            }
            pump(Duration::from_millis(100))?;
        }
        Ok(())
    }

    /// Takes the stop of the watch, for a scenario that stops it on a thread of its own.
    #[cfg(feature = "diagnostics")]
    fn take_stop(&mut self) -> Result<Stop, String> {
        self.stop
            .take()
            .ok_or_else(|| "the watch is already stopped".to_string())
    }

    /// Stops the watch, which waits for its running sample, and ends the event log, which stores what the watch stored.
    fn finish(mut self) -> Result<(), String> {
        if let Some(stop) = self.stop.take() {
            stop();
        }
        use_host_event_log(None);
        self.log.flush()?;
        self.log.close();
        Ok(())
    }
}

/// Runs the main run loop and holds it from a time on: the watch records the stall and its sample, and when the main
/// thread runs the run loop again, the end of the stall.
fn blocked(config: &Path) -> Result<(), String> {
    let run = Run::start(config, None, None)?;
    // The main thread answers each heartbeat while it runs its run loop, and a turn of 600 ms is no stall.
    pump(Duration::from_millis(600))?;
    if !run.joined().is_empty() {
        return Err(format!(
            "the watch stored {:?} for a main thread that ran its run loop",
            run.joined()
        ));
    }
    // The thread is held from here: the heartbeat of the watch is late by a second and the sample of that stall ends.
    run.hold_until("host.stall.sampled", 1)?;
    // The main thread answers again, which is the end of the stall.
    run.pump_until("host.stall.resumed", 1)?;
    run.finish()
}

/// Starts the watch, runs a main run loop that waits for 2 s, which is longer than a stall, and then holds it from its wake.
/// The heartbeat of the platform counts the heartbeats that it sent through the counts of the native library.
fn waits(config: &Path) -> Result<(), String> {
    let system = platform::current()?;
    // The count of the heartbeats that read a wait of the run loop and the count of sent heartbeats at the first of them.
    let reads = Arc::new(Mutex::new((0u64, 0u64)));
    let counted = Arc::clone(&reads);
    let heartbeat: Heartbeat = Box::new(move || {
        let before = heartbeats_sent();
        let (now, answered) = system.stall_heartbeat()?;
        let after = heartbeats_sent();
        if after == before {
            // A heartbeat that sent nothing read a wait of the run loop.
            let mut reads = counted.lock().unwrap();
            if reads.0 == 0 {
                reads.1 = after;
            }
            reads.0 += 1;
        }
        Ok((Duration::from_nanos(now), Duration::from_nanos(answered)))
    });
    let run = Run::start(config, Some(heartbeat), None)?;
    // The run loop waits for 2 s: the watch reads the wait with its heartbeat, sends nothing to the waiting run loop, and
    // stores nothing for the 2 s.
    pump(Duration::from_secs(2))?;
    let sent = heartbeats_sent();
    let (read, at_read) = *reads.lock().unwrap();
    if read == 0 {
        return Err("no heartbeat of the watch read the wait of the run loop".to_string());
    }
    if sent != at_read {
        return Err(format!(
            "{} heartbeats were sent to a run loop that waits",
            sent - at_read
        ));
    }
    // The wake ends the block, and the 2 s of the wait are no lateness.
    pump(Duration::from_millis(600))?;
    if !run.joined().is_empty() {
        return Err(format!(
            "the watch stored {:?} for a run loop that waited",
            run.joined()
        ));
    }
    // A run loop that wakes and does not turn is a stall, measured from its wake.
    run.hold_until("host.stall.sampled", 1)?;
    run.finish()
}

/// Opens the FIFO of the fault point for writing and closes it, which ends the wait of the sample that the FIFO holds.
#[cfg(feature = "diagnostics")]
fn release_samples(fifo: &Path) -> Result<(), String> {
    std::fs::OpenOptions::new()
        .write(true)
        .open(fifo)
        .map(drop)
        .map_err(|error| format!("{}: {error}", fifo.display()))
}

/// The FIFO that the parent made and named in the fault point of this child.
#[cfg(feature = "diagnostics")]
fn held_samples() -> Result<PathBuf, String> {
    std::env::var_os(FAULT_STALL_SAMPLE)
        .map(PathBuf::from)
        .ok_or_else(|| format!("the scenario has no FIFO in {FAULT_STALL_SAMPLE}"))
}

/// Holds the sample of the first stall while the main thread has two stalls with an end each: the watch keeps sending
/// heartbeats, so the second stall is found and reports the sample that runs.
#[cfg(feature = "diagnostics")]
fn sample_keeps_the_watch(config: &Path) -> Result<(), String> {
    let fifo = held_samples()?;
    let run = Run::start(config, None, None)?;
    pump(Duration::from_millis(600))?;
    // The thread is held until the watch stores the stall, and answers again, which ends it.
    run.hold_until("host.stall", 1)?;
    run.pump_until("host.stall.resumed", 1)?;
    // The sample of the first stall still runs when the second stall is found.
    run.hold_until("host.stall.sampled", 1)?;
    run.pump_until("host.stall.resumed", 2)?;
    release_samples(&fifo)?;
    // The run loop turns while the sample ends, so the wait for its record starts no later stall.
    run.pump_until("host.stall.sampled", 2)?;
    run.finish()
}

/// Holds the sample of a stall while the main thread ends the stall and its run loop waits.
#[cfg(feature = "diagnostics")]
fn ends_in_a_wait(config: &Path) -> Result<(), String> {
    let fifo = held_samples()?;
    let run = Run::start(config, None, None)?;
    pump(Duration::from_millis(600))?;
    run.hold_until("host.stall", 1)?;
    // The main thread returns and its run loop waits: the watch stores the end and parks in that wait, while the sample
    // goes on apart from it.
    run.pump_until("host.stall.resumed", 1)?;
    if run.joined() != "host.stall,host.stall.resumed" {
        return Err(format!(
            "the watch stored {:?} before the sample ended",
            run.joined()
        ));
    }
    release_samples(&fifo)?;
    // The run loop turns while the sample ends, so the wait for its record starts no later stall.
    run.pump_until("host.stall.sampled", 1)?;
    run.finish()
}

/// Stops the watch while the sample of a stall runs: the stop begins to wait for the sample, returns only after the sample
/// ended and stored its record, and the watch has run one sample.
#[cfg(feature = "diagnostics")]
fn stop_waits(config: &Path) -> Result<(), String> {
    enum Event {
        Waiting,
        Returned,
    }
    let fifo = held_samples()?;
    let (events, event) = std::sync::mpsc::channel::<Event>();
    let waiting = events.clone();
    let mut run = Run::start(
        config,
        None,
        Some(Box::new(move || {
            waiting
                .send(Event::Waiting)
                .expect("the scenario ended before the stop began to wait")
        })),
    )?;
    pump(Duration::from_millis(600))?;
    // The main thread is held until the watch stores the stall, whose sample lasts until the FIFO is released.
    run.hold_until("host.stall", 1)?;
    let stop = run.take_stop()?;
    std::thread::spawn(move || {
        stop();
        events
            .send(Event::Returned)
            .expect("the scenario ended before the stop returned");
    });
    // The sample ends only after the stop began to wait for it, so a stop that returns before that event returned while
    // the sample ran, and one that neither waits nor returns ends at the limit of the scenario.
    let still_ran = "the stop of the watch returned while the sample of the threads still ran";
    match event.recv_timeout(DEADLINE) {
        Ok(Event::Waiting) => {}
        Ok(Event::Returned) => return Err(still_ran.to_string()),
        Err(_) => {
            return Err("the stop of the watch did not begin to wait for the sample".to_string());
        }
    }
    if event.try_recv().is_ok() {
        return Err(still_ran.to_string());
    }
    release_samples(&fifo)?;
    match event.recv_timeout(DEADLINE) {
        Ok(Event::Returned) => {}
        Ok(Event::Waiting) | Err(_) => {
            return Err("the stop of the watch did not return after the sample ended".to_string());
        }
    }
    if run.joined() != "host.stall,host.stall.sampled" {
        return Err(format!(
            "the stop returned with the events {:?}, want the stall and its sample",
            run.joined()
        ));
    }
    run.finish()
}

/// Runs the scenario of a child process on the main thread.
fn run_scenario(name: &str) -> Result<(), String> {
    let config = std::env::var_os(CONFIG).map(PathBuf::from).ok_or_else(|| {
        format!("the stall scenario {name:?} has no configuration folder in {CONFIG}")
    })?;
    match name {
        "blocked" => blocked(&config),
        "waits" => waits(&config),
        #[cfg(feature = "diagnostics")]
        "sample-keeps-the-watch" => sample_keeps_the_watch(&config),
        #[cfg(feature = "diagnostics")]
        "ends-in-a-wait" => ends_in_a_wait(&config),
        #[cfg(feature = "diagnostics")]
        "stop-waits" => stop_waits(&config),
        _ => Err(format!("unknown stall scenario {name:?}")),
    }
}

/// A record of the watch in the event log.
struct Record {
    name: String,
    level: String,
    fields: Value,
}

impl Record {
    /// A field of the record, which the event log stores as a number.
    fn milliseconds(&self, key: &str) -> Result<u64, String> {
        self.fields[key].as_u64().ok_or_else(|| {
            format!(
                "{} field {key} is {}, want a number",
                self.name, self.fields[key]
            )
        })
    }

    /// Requires the late_ms of a stall found by a heartbeat that is one second or more late, at most one beat and the
    /// scheduling of a loaded system after the threshold. The exact values are the cases of the table test of the step.
    fn require_late(&self) -> Result<(), String> {
        let late = self.milliseconds("late_ms")?;
        if !(1000..2000).contains(&late) {
            return Err(format!(
                "late_ms {late} of a main thread that did not turn, want 1000 up to 2000"
            ));
        }
        Ok(())
    }

    /// Requires the watch_late_ms of a watch that wakes on time, which is less than a beat.
    fn require_watch_on_time(&self) -> Result<(), String> {
        let late = self.milliseconds("watch_late_ms")?;
        if late >= 250 {
            return Err(format!(
                "watch_late_ms {late}, want a watch that wakes on time"
            ));
        }
        Ok(())
    }

    /// Requires the record of a sample that ended without an error and wrote its file.
    fn require_sample(&self) -> Result<(), String> {
        let path = self.fields["path"].as_str().unwrap_or_default();
        if !path.contains("stall-host-") {
            return Err(format!(
                "the sample path is {path:?}, want a stall-host file"
            ));
        }
        if let Some(failure) = self.fields.get("error") {
            return Err(format!("the sample reports {failure}"));
        }
        std::fs::metadata(path).map_err(|error| format!("the sample file: {error}"))?;
        Ok(())
    }
}

/// Requires the names of the records that the scenario stored.
fn require_names(records: &[Record], want: &str, meaning: &str) -> Result<(), String> {
    let got = records
        .iter()
        .map(|record| record.name.as_str())
        .collect::<Vec<_>>()
        .join(",");
    if got != want {
        return Err(format!("events {got:?}, want {meaning}"));
    }
    Ok(())
}

/// Requires the level of each record: the stall and its dump are warnings, which the policy stores through the gate
/// exception of passes_every_gate, and the end of the stall is info.
fn require_levels(records: &[Record]) -> Result<(), String> {
    for record in records {
        let want = if record.name == "host.stall.resumed" {
            "info"
        } else {
            "warn"
        };
        if record.level != want {
            return Err(format!("{} at {}, want {want}", record.name, record.level));
        }
    }
    Ok(())
}

/// Makes the FIFO that only the owner reads and writes, for the fault point that holds a sample.
#[cfg(feature = "diagnostics")]
fn make_fifo(path: &Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let text = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|error| format!("{}: {error}", path.display()))?;
    if unsafe { libc::mkfifo(text.as_ptr(), 0o600) } != 0 {
        return Err(format!(
            "mkfifo {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// Runs the scenario in a child process of this test binary with the configuration folder `config`, which the caller keeps
/// until it has judged the files of the records, and returns the records of the watch in the event log of that folder. `held`
/// makes a FIFO in the folder and names it in the fault point of the child, which holds the sample of each stall until the
/// scenario closes the FIFO.
fn records_of(config: &folder::Folder, scenario: &str, held: bool) -> Result<Vec<Record>, String> {
    let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    command.env(SCENARIO, scenario).env(CONFIG, config.path());
    if held {
        #[cfg(feature = "diagnostics")]
        {
            let fifo = config.path().join("sample.fifo");
            make_fifo(&fifo)?;
            command.env(FAULT_STALL_SAMPLE, &fifo);
        }
        #[cfg(not(feature = "diagnostics"))]
        return Err(format!(
            "the scenario {scenario:?} needs the diagnostics feature"
        ));
    }
    let output = command
        .output()
        .map_err(|error| format!("start the child {scenario}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "child {scenario} ended with {:?}, output {:?}, error output {:?}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let events = records::read_events(&records::event_log_path(config.path()));
    Ok(events
        .into_iter()
        .filter(|event| {
            event["event"]
                .as_str()
                .is_some_and(|name| name.starts_with("host.stall"))
        })
        .map(|event| Record {
            name: event["event"].as_str().unwrap_or_default().to_string(),
            level: event["level"].as_str().unwrap_or_default().to_string(),
            fields: event["fields"].clone(),
        })
        .collect())
}

// contract: host.stall.recorded-without-a-check, host.stall.watch-late-separates-blocked-main, host.stall.carries-priority, host.stall.resumed-carries-cpu
fn a_blocked_main_thread_is_recorded_with_its_stacks_and_its_end() -> Result<(), String> {
    let config = folder::Folder::new();
    let records = records_of(&config, "blocked", false)?;
    require_names(
        &records,
        "host.stall,host.stall.sampled,host.stall.resumed",
        "the stall, its sample and its end",
    )?;
    records[0].require_late()?;
    // The watch wakes on every beat while the main thread is blocked, so its own wake is not late by a beat.
    records[0].require_watch_on_time()?;
    // The real platform reads the schedule of the process: the stall carries its priority and the end its CPU time.
    if !records[0].fields["priority"].is_number() {
        return Err(format!(
            "the stall carries no priority: {}",
            records[0].fields
        ));
    }
    records[2].milliseconds("cpu_ms")?;
    records[1].require_sample()?;
    let (stalled, late) = (
        records[2].milliseconds("stalled_ms")?,
        records[0].milliseconds("late_ms")?,
    );
    if stalled < late {
        return Err(format!(
            "stalled_ms {stalled} is shorter than late_ms {late} of the same stall"
        ));
    }
    require_levels(&records)
}

// contract: host.stall.waiting-run-loop-takes-no-heartbeat
fn a_run_loop_that_waits_takes_no_heartbeat() -> Result<(), String> {
    let config = folder::Folder::new();
    let records = records_of(&config, "waits", false)?;
    require_names(
        &records,
        "host.stall,host.stall.sampled",
        "the stall of the wake and its sample only",
    )?;
    records[0].require_late()?;
    records[0].require_watch_on_time()?;
    records[1].require_sample()
}

// contract: host.stall.sample-keeps-the-watch-running
#[cfg(feature = "diagnostics")]
fn a_sample_of_the_threads_does_not_stop_the_watch() -> Result<(), String> {
    let config = folder::Folder::new();
    let records = records_of(&config, "sample-keeps-the-watch", true)?;
    let want = "host.stall,host.stall.resumed,host.stall,host.stall.sampled,host.stall.resumed,host.stall.sampled";
    require_names(&records, want, want)?;
    for record in &records {
        if record.name == "host.stall" {
            record.require_late()?;
        }
    }
    if records[3].fields["error"] != "a sample of the threads is still running" {
        return Err(format!("the second sample reports {}", records[3].fields));
    }
    records[5].require_sample()?;
    require_levels(&records)
}

// contract: host.stall.ends-when-the-run-loop-waits
#[cfg(feature = "diagnostics")]
fn a_stall_that_ends_in_a_wait_is_resumed_and_its_sample_ends() -> Result<(), String> {
    let config = folder::Folder::new();
    let records = records_of(&config, "ends-in-a-wait", true)?;
    require_names(
        &records,
        "host.stall,host.stall.resumed,host.stall.sampled",
        "the stall, its end and its sample",
    )?;
    records[0].require_late()?;
    let stalled = records[1].milliseconds("stalled_ms")?;
    if !(1000..3000).contains(&stalled) {
        return Err(format!("stalled_ms {stalled}, want 1000 up to 3000"));
    }
    records[2].require_sample()?;
    require_levels(&records)
}

// contract: host.stall.stop-waits-for-the-sample
#[cfg(feature = "diagnostics")]
fn stopping_the_watch_waits_for_the_running_sample() -> Result<(), String> {
    let config = folder::Folder::new();
    let records = records_of(&config, "stop-waits", true)?;
    require_names(
        &records,
        "host.stall,host.stall.sampled",
        "the stall and its sample",
    )?;
    records[0].require_late()?;
    records[1].require_sample()?;
    require_levels(&records)
}

const TESTS: &[MainTest] = &[
    (
        "a_blocked_main_thread_is_recorded_with_its_stacks_and_its_end",
        a_blocked_main_thread_is_recorded_with_its_stacks_and_its_end,
    ),
    (
        "a_run_loop_that_waits_takes_no_heartbeat",
        a_run_loop_that_waits_takes_no_heartbeat,
    ),
    #[cfg(feature = "diagnostics")]
    (
        "a_sample_of_the_threads_does_not_stop_the_watch",
        a_sample_of_the_threads_does_not_stop_the_watch,
    ),
    #[cfg(feature = "diagnostics")]
    (
        "a_stall_that_ends_in_a_wait_is_resumed_and_its_sample_ends",
        a_stall_that_ends_in_a_wait_is_resumed_and_its_sample_ends,
    ),
    #[cfg(feature = "diagnostics")]
    (
        "stopping_the_watch_waits_for_the_running_sample",
        stopping_the_watch_waits_for_the_running_sample,
    ),
];

/// Runs the scenario that the environment names, as a child process does, or the tests of this target.
pub fn main() {
    if let Some(name) = std::env::var_os(SCENARIO) {
        if let Err(error) = run_scenario(&name.to_string_lossy()) {
            println!("{error}");
            std::process::exit(2);
        }
        std::process::exit(0);
    }
    main_thread::run(TESTS);
}
