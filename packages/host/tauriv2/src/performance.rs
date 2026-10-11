//! The switch and the sampler of the performance trace (docs/spec/performance-trace.md). The process holds the switch; an
//! observation is an event of the event log while the switch is on. The page turns it on and off with the call `performance`.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static ON: AtomicBool = AtomicBool::new(false);
/// Orders the requests of the page to switch the trace.
static SWITCHING: Mutex<()> = Mutex::new(());

/// Whether the trace of this process is on.
pub fn enabled() -> bool {
    ON.load(Ordering::Acquire)
}

/// Builds and stores an observation only while the trace is on, as an event of the event log (`host.trace.<event>`,
/// `host.sampler.<event>`), and reports an error. The measured operation goes on.
pub fn observe(layer: &str, fields: impl FnOnce() -> Value) {
    if !enabled() {
        return;
    }
    // The observation is of the class call at the level debug: a policy that does not store it builds no fields.
    if !crate::log_policy::gate_event(
        crate::log_policy::Class::Call,
        crate::event_log::Level::Debug,
    ) {
        return;
    }
    if let Err(error) = crate::event_record::emit_trace(layer, fields()) {
        crate::application_log::log_error("performance trace", error);
    }
}

/// Runs the switch requests of the page in the order they arrive. The events of the page travel through the call `log`
/// (event_relay.rs), not through this call. Turning the trace on stores the event `host.trace.on` and starts the sampler;
/// turning it off stores `host.trace.off` before the switch goes off.
pub fn command(request: Value) -> Result<Value, String> {
    let action = request
        .get("action")
        .and_then(Value::as_str)
        .ok_or("action must be on or off")?;
    if !["on", "off"].contains(&action) {
        return Err(format!("action must be on or off, not {action}"));
    }
    let _switching = SWITCHING
        .lock()
        .map_err(|error| format!("performance switch lock: {error}"))?;
    match action {
        "on" => {
            if !ON.swap(true, Ordering::AcqRel) {
                observe("host", || json!({"event": "on"}));
                start_sampler();
            }
        }
        "off" => {
            if enabled() {
                observe("host", || json!({"event": "off"}));
                ON.store(false, Ordering::Release);
                end_sampler();
            }
        }
        _ => unreachable!("validated performance action"),
    }
    Ok(Value::Null)
}

/// Converts at to ISO-8601 (milliseconds). A time before the epoch cannot be written in this format, so it is an error.
pub fn timestamp(at: SystemTime) -> Result<String, String> {
    let since = at
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("clock is before the Unix epoch: {error}"))?;
    let millis_total = since.as_millis();
    let days = (millis_total / 86_400_000) as i64;
    let millis_day = (millis_total % 86_400_000) as u32;
    let (year, month, day) = civil_from_days(days);
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        millis_day / 3_600_000,
        (millis_day % 3_600_000) / 60_000,
        (millis_day % 60_000) / 1_000,
        millis_day % 1_000
    ))
}

/// Converts the number of days into year, month and day (civil_from_days by Howard Hinnant).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// The sampler stores the resident size of the host every 5 seconds while the trace is on. It ends with the switch: turning
/// the trace off waits until the thread returned, and turning it on again starts a new one.
struct Sampler {
    stop: std::sync::mpsc::Sender<()>,
    thread: std::thread::JoinHandle<()>,
}

static SAMPLER: Mutex<Option<Sampler>> = Mutex::new(None);

fn start_sampler() {
    let mut sampler = SAMPLER.lock().expect("the sampler");
    if sampler.is_some() {
        return;
    }
    let (stop, stopped) = std::sync::mpsc::channel::<()>();
    let thread = std::thread::Builder::new()
        .name("performance-sampler".into())
        .spawn(move || loop {
            sample();
            // A message or the end of the channel stops the thread; the timeout is the interval of the samples.
            if !matches!(
                stopped.recv_timeout(std::time::Duration::from_secs(5)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                return;
            }
        })
        .expect("the thread of the sampler");
    *sampler = Some(Sampler { stop, thread });
}

fn end_sampler() {
    let Some(sampler) = SAMPLER.lock().expect("the sampler").take() else {
        return;
    };
    // Dropping the sender ends the channel, which stops the thread at its next wait.
    drop(sampler.stop);
    if sampler.thread.join().is_err() {
        crate::application_log::log_error("performance trace", "the sampler ended with a panic");
    }
}

/// The process registry: every sidecar process the host started or connected to, by pid, with the role and the name that
/// make a memory reading attribute itself. A process leaves the registry when it ends or its connection ends.
static PROCESSES: Mutex<BTreeMap<u32, (String, String)>> = Mutex::new(BTreeMap::new());

/// Names a process for the sampler and stores the event `process` with its role, name and pid, so the samples attribute
/// themselves. Naming a pid again replaces its role and name.
pub fn process_add(role: &str, name: &str, pid: u32) {
    PROCESSES
        .lock()
        .expect("the process registry")
        .insert(pid, (role.to_string(), name.to_string()));
    observe(
        "host",
        || json!({"event": "process", "role": role, "name": name, "pid": pid}),
    );
}

/// Removes a process from the registry; a pid that is not named is ignored because both the end of a process and the end of
/// its connection remove it.
pub fn process_remove(pid: u32) {
    PROCESSES.lock().expect("the process registry").remove(&pid);
}

/// Stores the resident size of the host and of every registered process, each as one event `host.sampler.memory`. A process
/// whose size cannot be read is stored with its error.
pub fn sample() {
    observe("sampler", || memory_record(std::process::id()));
    let named: Vec<(u32, (String, String))> = PROCESSES
        .lock()
        .expect("the process registry")
        .iter()
        .map(|(pid, process)| (*pid, process.clone()))
        .collect();
    for (pid, (role, name)) in named {
        observe("sampler", || match resident_kb(pid) {
            Ok(size) => {
                json!({"event":"memory", "role":role, "name":name, "pid":pid, "rss_kb":size})
            }
            Err(error) => {
                json!({"event":"memory", "role":role, "name":name, "pid":pid, "error":error})
            }
        });
    }
}

/// Stores a phase of the life of a surface (`created`, `placed`, `destroyed`) as the event `surface` of the trace. A
/// placement adds the frame `[x, y, w, h]` the host gave the native view and whether the view is visible.
pub fn surface(phase: &str, surface: &str, placement: Option<([f64; 4], bool)>) {
    observe("host", || {
        let mut record = json!({"event": "surface", "phase": phase, "surface": surface});
        if let Some(([x, y, w, h], visible)) = placement {
            record["x"] = json!(x);
            record["y"] = json!(y);
            record["w"] = json!(w);
            record["h"] = json!(h);
            record["visible"] = json!(visible);
        }
        record
    });
}

/// Whether the sampler of the trace runs.
pub fn sampler_running() -> bool {
    SAMPLER.lock().expect("the sampler").is_some()
}

/// The memory event of pid that the sampler records. When the read fails, it records the error instead of the size.
pub fn memory_record(pid: u32) -> Value {
    match resident_kb(pid) {
        Ok(size) => json!({"event":"memory", "rss_host_kb":size}),
        Err(error) => json!({"event":"memory", "error":error}),
    }
}

/// The resident size of pid (KB). It is an error when ps cannot run or returns no size (when the process has ended).
fn resident_kb(pid: u32) -> Result<u64, String> {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .map_err(|error| format!("ps for pid {pid}: {error}"))?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|_| {
            format!(
                "ps reported no resident size for pid {pid} (status {})",
                output.status
            )
        })
}
