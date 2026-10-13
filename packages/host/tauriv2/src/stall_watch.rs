//! The watch of the main thread (docs/spec/logging.md, stalls). A stall is the absence of events, which no event of the
//! stalled thread reports, so a thread outside the main thread sends a heartbeat to it and compares the last heartbeat with
//! the clock. No event source reports a thread that does not run, which is why this watch uses a timer. A heartbeat
//! STALL_LATE or more late is `host.stall`, the stacks of the threads go into a file of the logs folder as
//! `host.stall.sampled`, and the next heartbeat is `host.stall.resumed` with the length of the stall.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::event_log::Level;

/// The interval of the heartbeat and of the check.
const STALL_BEAT: Duration = Duration::from_millis(250);
/// The lateness of a heartbeat that is a stall.
const STALL_LATE: Duration = Duration::from_secs(1);

/// A function that runs on the watched thread.
pub type MainTask = Box<dyn FnOnce() + Send>;
/// Runs a task on the watched thread.
pub type OnMain = Box<dyn Fn(MainTask) -> Result<(), String> + Send>;
/// Writes the stacks of the threads of the process into a file.
pub type Sample = Box<dyn Fn(&Path) -> Result<(), String> + Send>;
/// Stores an event.
pub type Emit = Box<dyn Fn(Level, &str, serde_json::Value) + Send>;

/// The parts of the watch: `on_main` runs a function on the watched thread, `sample` writes the stacks of the threads of the
/// process into a file, `folder` is the logs folder and `emit_host` stores an event of the host.
pub struct StallWatchOptions {
    pub on_main: OnMain,
    pub sample: Sample,
    pub folder: PathBuf,
    pub emit_host: Emit,
}

/// Starts the watch and returns the function that stops it.
pub fn start_stall_watch(options: StallWatchOptions) -> impl FnOnce() {
    let start = Instant::now();
    let beat = Arc::new(AtomicU64::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = Arc::clone(&stopped);
    crate::routine::spawn_named("stall watch", move || {
        let emit_host = &options.emit_host;
        let mut stalled_from: Option<u64> = None;
        while !stopped.load(Ordering::Acquire) {
            std::thread::sleep(STALL_BEAT);
            let written = Arc::clone(&beat);
            let sent = (options.on_main)(Box::new(move || {
                written.store(start.elapsed().as_millis() as u64, Ordering::Release);
            }));
            // A main thread that takes no task any more ends the watch, and the error says so.
            if let Err(error) = sent {
                crate::application_log::log_error("stall watch", format!("heartbeat: {error}"));
                return;
            }
            let now = start.elapsed().as_millis() as u64;
            let last = beat.load(Ordering::Acquire);
            match stalled_from {
                None if now.saturating_sub(last) >= STALL_LATE.as_millis() as u64 => {
                    stalled_from = Some(last);
                    emit_host(Level::Warn, "host.stall", json!({"late_ms": now - last}));
                    let path = dump_path(&options.folder);
                    let fields = match (options.sample)(&path) {
                        Ok(()) => json!({"path": path}),
                        Err(error) => json!({"path": path, "error": error}),
                    };
                    emit_host(Level::Warn, "host.stall.sampled", fields);
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
        }
    });
    move || stop.store(true, Ordering::Release)
}

/// The file of a dump: `stall-host-<pid>-<ms>.txt` in the logs folder.
fn dump_path(folder: &Path) -> PathBuf {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    folder.join(format!("stall-host-{}-{ms}.txt", std::process::id()))
}
