//! The watch of the folder in which the system writes crash reports, so a test whose child crashes on purpose removes the report
//! that the system writes for that child.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

pub struct CrashReports {
    // The watcher ends the watch when it is dropped, so it lives as long as the receiver of its events.
    _watcher: RecommendedWatcher,
    events: Receiver<notify::Result<Event>>,
    directory: PathBuf,
}

impl CrashReports {
    /// Starts the watch of the crash reports before the test starts the child that crashes.
    pub fn watch() -> Self {
        let directory = soksak_host_tauriv2::platform::current()
            .unwrap()
            .diagnostic_reports_directory()
            .unwrap();
        let (sender, events) = channel();
        let mut watcher = notify::recommended_watcher(sender)
            .unwrap_or_else(|error| panic!("crash report watch: {error}"));
        watcher
            .watch(&directory, RecursiveMode::NonRecursive)
            .unwrap_or_else(|error| panic!("crash report watch of {directory:?}: {error}"));
        CrashReports {
            _watcher: watcher,
            events,
            directory,
        }
    }

    /// Waits until the system wrote the crash report of the process pid and removes it. The wait ends after limit when no
    /// report arrives, so the failure names the missing report.
    pub fn remove(&self, pid: u32, limit: Duration) {
        let deadline = Instant::now() + limit;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let event = match self.events.recv_timeout(left) {
                Ok(Ok(event)) => event,
                Ok(Err(error)) => panic!("crash report watch of {:?}: {error}", self.directory),
                Err(RecvTimeoutError::Timeout) => panic!(
                    "the system wrote no crash report of process {pid} in {:?} within {limit:?}",
                    self.directory
                ),
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("crash report watch of {:?} ended", self.directory)
                }
            };
            for path in event.paths {
                if path.extension().is_some_and(|extension| extension == "ips")
                    && report_pid(&path) == Some(pid)
                {
                    std::fs::remove_file(&path).unwrap_or_else(|error| {
                        panic!("remove the crash report {path:?}: {error}")
                    });
                    assert!(
                        !path.exists(),
                        "the crash report {path:?} of process {pid} remains"
                    );
                    return;
                }
            }
        }
    }
}

/// The pid of the body of a report, the JSON value after the header line, or None while the system has not written the whole
/// body.
fn report_pid(path: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(path).ok()?;
    let (_, body) = text.split_once('\n')?;
    let body: serde_json::Value = serde_json::from_str(body).ok()?;
    u32::try_from(body.get("pid")?.as_u64()?).ok()
}
