//! The state of a diagnostic recording. It is included only by the cargo feature `diagnostics`.
//!
//! There is one recording at a time. A start failure removes its folder: the native start ends its recording when it
//! fails. A stop ends the native recording also when it fails, so finish then transfers the folder to its requester and
//! abort removes it. A remaining recording or cleanup folder blocks another start.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, mpsc};

use serde_json::{Value, json};

use crate::platform::LayoutRecord;
use crate::surfaces::LayoutViewport;

/// What the native capture reports of the recording stopped last: the planned stills without a written frame, the stills
/// requested more than one gap late, and the longest interval (ms) between the request times of two consecutive written
/// frames.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StillCounts {
    pub missed: i32,
    pub late: i32,
    pub longest_gap: f64,
}

/// The response of the request that ended a recording. It holds the frame folder, the record of the stills, the
/// display-link trace, the number of written frames, the missed and late stills, the longest interval between frames, and
/// the window server number of the recorded window, null for a display recording.
pub fn stop_payload(
    directory: &Path,
    count: i32,
    stills: StillCounts,
    window: Option<isize>,
) -> Value {
    let still_record = directory.join("stills.jsonl");
    let display_link = directory.join("display-link.json");
    json!({"frames": directory.to_string_lossy(), "stills": still_record.to_string_lossy(), "displayLink": display_link.to_string_lossy(), "count": count, "missed": stills.missed, "late": stills.late, "longestGap": stills.longest_gap, "window": window})
}

/// Converts the placement transaction records into {ticket, begun, requested, presented, committed, commitPath,
/// openAtCommit, flushed, displayed, refreshed, viewport}. A value that did not happen is null, and viewport, the size
/// {width, height} of the window that the page made the layout at (viewports, by ticket), is null for a transaction that
/// no preparation of the trace began.
pub fn layout_trace(records: &[LayoutRecord], viewports: &HashMap<u64, LayoutViewport>) -> Value {
    let stage = |value: f64| {
        if value.is_nan() {
            Value::Null
        } else {
            serde_json::json!(value)
        }
    };
    Value::Array(
        records
            .iter()
            .map(|record| {
                serde_json::json!({
                    "ticket": record.ticket,
                    "begun": stage(record.begun),
                    "requested": stage(record.requested),
                    "presented": stage(record.presented),
                    "committed": stage(record.committed),
                    "commitPath": record.commit_path,
                    "openAtCommit": stage(record.open_at_commit),
                    "flushed": stage(record.flushed),
                    "displayed": stage(record.displayed),
                    "refreshed": stage(record.refreshed),
                    "viewport": viewports.get(&record.ticket).map_or(Value::Null, |size| {
                        serde_json::json!({"width": size.width, "height": size.height})
                    }),
                })
            })
            .collect(),
    )
}

/// The recording target. When display is set, the windows of this application on the display that holds the window are
/// recorded. A window recording stops when the window is moved to another Space (full screen).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub window: isize,
    pub display: bool,
}

/// The plan of the stills of a recording: `gap` is the time in ms from the request of one still to the request of the
/// next, and the length is `seconds` or `frames`, the other 0.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Plan {
    pub gap: f64,
    pub seconds: f64,
    pub frames: i32,
}

/// The recording device. The platform implementation provides it: the native recorder of the window server.
pub trait Capture {
    /// Sets the window with the window server number target.window as the recording target. An error creates no
    /// preparation and leaves any existing active recording unchanged.
    fn open(&self, target: Target) -> Result<(), String>;
    /// Starts the recording of plan in directory and returns once still 0 is written. A failed start ends its recording; a
    /// panic may interrupt an active start, which the recording owner stops while unwinding.
    fn start(&self, directory: &Path, plan: Plan) -> Result<(), String>;
    /// Ends the recording and returns the number of written frames. The recording ends also when the stop fails.
    fn stop(&self) -> Result<i32, String>;
}

/// A recording device that also records a new window from its first still: it holds the next show of a window that is
/// not on screen, and the start of the recording of that window puts it on screen.
pub trait NewWindowCapture: Capture + Send + Sync {
    /// Holds the next show of a window that is not on screen.
    fn hold_new_window(&self) -> Result<(), String>;
    /// Waits until a show was held and returns the window server number of that window. It gives `register_end` the end
    /// of its wait; an ended wait shows a held window and fails with `no new window was shown before <reason>`.
    fn wait_new_window(
        &self,
        register_end: &dyn Fn(Box<dyn Fn(&'static str) + Send + Sync>),
    ) -> Result<isize, String>;
    /// Ends the hold at once and shows a held window.
    fn release_new_window(&self);
}

/// The end of the stop of a recording for a wait for a held window.
const NEW_WINDOW_STOP_REASON: &str = "the stop of the recording";

/// The end of the wait for the held window of a new-window recording, given once the wait registered it; an end that
/// comes before is kept and given at the registration.
#[derive(Default)]
struct NewWindowEnd {
    end: Option<Box<dyn Fn(&'static str) + Send + Sync>>,
    ended: Option<&'static str>,
}

/// The start of the recording of a new window that runs after `start_new_window` returned: the wait for the held window,
/// then the open and the start of its recording, which returns once still 0 is written.
/// `done` gives the number of the held window once still 0 of its recording is written.
struct NewWindowStart {
    done: mpsc::Receiver<Result<isize, String>>,
    end: Arc<Mutex<NewWindowEnd>>,
}

struct State {
    directory: Option<PathBuf>,
    capture_stopped: bool,
    pending: Option<NewWindowStart>,
    /// The window server number of the recorded window: none for a display recording and for a new window that no show
    /// has given yet.
    window: Option<isize>,
}

/// Opens target and starts its recording of plan in directory. It returns once still 0 is written; a failure leaves no
/// native recording.
fn begin(
    capture: &dyn Capture,
    target: Target,
    directory: &Path,
    plan: Plan,
) -> Result<(), String> {
    capture.open(target)?;
    capture.start(directory, plan)
}

/// The error of a start while directory, the folder that a recording or its cleanup owns, is some.
pub fn refuse_start(directory: Option<&Path>) -> Option<String> {
    directory.map(|running| format!("a capture into {} is running", running.display()))
}

/// The error of a finish of a recording that owns directory, whose native recording has or has not ended (capture_stopped),
/// or none when the recording can end.
pub fn refuse_finish(directory: Option<&Path>, capture_stopped: bool) -> Option<String> {
    if capture_stopped {
        return Some(
            "capture has stopped but its directory cleanup is incomplete; abort is required".into(),
        );
    }
    directory
        .is_none()
        .then(|| "no capture is running".to_string())
}

/// Whether an abort ends the native recording of the owned directory: it does not when the recording has ended already, so a
/// retry of the cleanup does not stop twice.
pub fn needs_stop(directory: Option<&Path>, capture_stopped: bool) -> bool {
    directory.is_some() && !capture_stopped
}

/// The error of an ended native recording whose stop failed with error.
pub fn stop_failure(error: &str) -> String {
    format!("capture stop failed: {error}")
}

/// The result of the removal of an owned folder: whether the recording keeps the folder, because its removal failed, and the
/// error to report, which holds the cause that led to the removal and the failure of the removal.
#[derive(Debug, PartialEq)]
pub struct Cleanup {
    pub retain_owner: bool,
    pub error: Option<String>,
}

/// Combines cause, the error that led to the removal of a folder, with removal, the error of that removal (none for a removal
/// that succeeded). A failed removal keeps the folder owned and is reported after the cause.
pub fn settle_cleanup(cause: Option<String>, removal: Option<&str>) -> Cleanup {
    match (cause, removal) {
        (cause, None) => Cleanup {
            retain_owner: false,
            error: cause,
        },
        (None, Some(removal)) => Cleanup {
            retain_owner: true,
            error: Some(format!("capture directory cleanup failed: {removal}")),
        },
        (Some(cause), Some(removal)) => Cleanup {
            retain_owner: true,
            error: Some(format!(
                "{cause}; capture directory cleanup failed: {removal}"
            )),
        },
    }
}

/// The error text of the removal of directory: none when it is removed or was not there.
fn remove_directory(directory: &Path) -> Option<String> {
    match std::fs::remove_dir_all(directory) {
        Ok(()) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => Some(error.to_string()),
    }
}

/// What the stop of the cleanup after a panic of the start answered.
#[derive(Debug, PartialEq)]
pub enum StopAnswer {
    Stopped,
    Failed(String),
    Panicked,
}

/// The state that the cleanup after a panic of the start leaves.
#[derive(Debug, PartialEq)]
pub struct PanicCleanup {
    /// Whether the native recording has ended: a start that never reached the capture, a stop and a failed stop end it, a
    /// panicking stop leaves it active.
    pub capture_stopped: bool,
    pub retain_owner: bool,
    pub errors: Vec<String>,
}

/// Decides the state after the stop of the cleanup of a panic. open_attempted is whether the start reached the capture, and
/// stop is the answer of the stop that followed it.
pub fn panic_stop(open_attempted: bool, stop: Option<StopAnswer>) -> PanicCleanup {
    match (open_attempted, stop) {
        (true, Some(StopAnswer::Failed(error))) => PanicCleanup {
            capture_stopped: true,
            retain_owner: false,
            errors: vec![stop_failure(&error)],
        },
        (true, Some(StopAnswer::Panicked)) => PanicCleanup {
            capture_stopped: false,
            retain_owner: true,
            errors: vec!["capture stop panicked".into()],
        },
        _ => PanicCleanup {
            capture_stopped: true,
            retain_owner: false,
            errors: Vec::new(),
        },
    }
}

/// Adds the removal of the folder after a stopped capture to the state of a panic cleanup: a removal that failed keeps the
/// owner.
pub fn panic_removal(mut cleanup: PanicCleanup, removal: Option<&str>) -> PanicCleanup {
    if let Some(error) = removal {
        cleanup.retain_owner = true;
        cleanup
            .errors
            .push(format!("capture directory cleanup failed: {error}"));
    }
    cleanup
}

/// Reports the errors of a cleanup after a panic as one error of the application log.
pub fn report_panic_cleanup(cleanup: &PanicCleanup) {
    if !cleanup.errors.is_empty() {
        crate::application_log::log_error("recording", cleanup.errors.join("; "));
    }
}

/// Waits for the start of the recording of a new window, ending a hold that no show took, and returns the failure of
/// that start, which leaves no native recording. A start that succeeded gives the recording its window.
fn settle_new_window(state: &mut State) -> Result<(), String> {
    let Some(pending) = state.pending.take() else {
        return Ok(());
    };
    let end = {
        // default: a lock that a panicking thread poisoned still holds the end, which this call gives.
        let mut end = pending.end.lock().unwrap_or_else(PoisonError::into_inner);
        if end.end.is_none() {
            end.ended = Some(NEW_WINDOW_STOP_REASON);
        }
        end.end.take()
    };
    if let Some(end) = end {
        end(NEW_WINDOW_STOP_REASON);
    }
    match pending.done.recv() {
        Ok(Ok(window)) => {
            state.window = Some(window);
            Ok(())
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("the start of the new window recording ended without a result".into()),
    }
}

/// The folder of the recording in progress.
pub struct Recording {
    state: Mutex<State>,
}

impl Default for Recording {
    fn default() -> Recording {
        Recording::new()
    }
}

impl Recording {
    pub const fn new() -> Recording {
        Recording {
            state: Mutex::new(State {
                directory: None,
                capture_stopped: false,
                pending: None,
                window: None,
            }),
        }
    }

    /// Holds the next show of a window that is not on screen and returns once the hold is set, owning directory. The
    /// recording of that window then starts on a thread of its own: once the application shows a window, the recording
    /// opens on it and starts with plan, and the start puts the window on screen, so still 0 of the recording holds the
    /// first content of the window. A failure after the hold took a window shows that window. `finish` and `abort` end a
    /// hold that no show took and report the result of the start.
    pub fn start_new_window(
        &self,
        capture: Arc<dyn NewWindowCapture>,
        directory: &Path,
        plan: Plan,
        make: &dyn Fn(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        // default: poison paths preserve the owned directory and stop status, so start can refuse a running capture.
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(error) = refuse_start(state.directory.as_deref()) {
            return Err(error);
        }
        make(directory)?;
        if let Err(error) = capture.hold_new_window() {
            let cleanup = settle_cleanup(Some(error), remove_directory(directory).as_deref());
            if cleanup.retain_owner {
                state.directory = Some(directory.to_path_buf());
                state.capture_stopped = true;
                state.window = None;
            }
            return Err(cleanup.error.unwrap_or_default()); // default: settle_cleanup keeps the cause it is given, so the error is present.
        }
        let end = Arc::new(Mutex::new(NewWindowEnd::default()));
        let (done, on_done) = mpsc::channel();
        let registered = end.clone();
        let target_directory = directory.to_path_buf();
        crate::routine::spawn_named("new-window-recording", move || {
            let register = |given: Box<dyn Fn(&'static str) + Send + Sync>| {
                // default: a lock that a panicking thread poisoned still holds the end, which this call sets.
                let mut end = registered.lock().unwrap_or_else(PoisonError::into_inner);
                match end.ended {
                    Some(reason) => given(reason),
                    None => end.end = Some(given),
                }
            };
            let result = match capture.wait_new_window(&register) {
                Err(error) => Err(error),
                Ok(number) => {
                    let target = Target {
                        window: number,
                        display: false,
                    };
                    let result = begin(capture.as_ref(), target, &target_directory, plan);
                    if result.is_err() {
                        capture.release_new_window();
                    }
                    result.map(|()| number)
                }
            };
            if done.send(result).is_err() {
                // The owner of the recording settles the start before it lets the recording go, so a result that no
                // owner takes is recorded.
                crate::application_log::log_error(
                    "recording",
                    "the start of a new window recording ended after its recording",
                );
            }
        });
        state.directory = Some(directory.to_path_buf());
        state.capture_stopped = false;
        state.window = None;
        state.pending = Some(NewWindowStart { done: on_done, end });
        Ok(())
    }

    /// Creates directory with make and starts to record target with plan in that folder. It returns after still 0 was
    /// written. On a failure it deletes the folder; the native start has ended its recording.
    pub fn start(
        &self,
        capture: &dyn Capture,
        target: Target,
        directory: &Path,
        plan: Plan,
        make: &dyn Fn(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        // default: poison paths preserve the owned directory and stop status before unwinding, so start can refuse a
        // running or cleanup-pending capture.
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(error) = refuse_start(state.directory.as_deref()) {
            return Err(error);
        }
        // The caller owns the path until creation succeeds; a failed `make` must not trigger directory removal here.
        make(directory)?;
        let mut capture_open_attempted = false;
        let started = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // The preparation reads the windows of the target at that time, so even the same target is prepared again
            // for every recording.
            capture_open_attempted = true;
            begin(capture, target, directory, plan)
        }));
        match started {
            Ok(Ok(())) => {
                state.directory = Some(directory.to_path_buf());
                state.capture_stopped = false;
                state.window = (!target.display).then_some(target.window);
                Ok(())
            }
            Ok(Err(error)) => {
                let cleanup = settle_cleanup(Some(error), remove_directory(directory).as_deref());
                if cleanup.retain_owner {
                    state.directory = Some(directory.to_path_buf());
                    state.capture_stopped = true;
                }
                Err(cleanup.error.unwrap_or_default()) // default: settle_cleanup names the failed removal whenever it retains the owner.
            }
            Err(panic) => {
                // A panic can interrupt a start that the native capture has not ended, so a start that reached the
                // capture is stopped; the stop ends the recording also when it fails.
                let stop = capture_open_attempted.then(|| {
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| capture.stop()))
                    {
                        Ok(Ok(_)) => StopAnswer::Stopped,
                        Ok(Err(error)) => StopAnswer::Failed(error),
                        Err(_) => StopAnswer::Panicked,
                    }
                });
                let mut cleanup = panic_stop(capture_open_attempted, stop);
                if cleanup.capture_stopped {
                    cleanup = panic_removal(cleanup, remove_directory(directory).as_deref());
                }
                if cleanup.retain_owner {
                    state.directory = Some(directory.to_path_buf());
                    state.capture_stopped = cleanup.capture_stopped;
                } else {
                    state.directory = None;
                    state.capture_stopped = false;
                    self.state.clear_poison();
                }
                report_panic_cleanup(&cleanup);
                drop(state);
                std::panic::resume_unwind(panic)
            }
        }
    }

    /// Stops the recording in progress and deletes the folder. It reports a stop error, after which the native recording
    /// has ended. It does nothing when there is no recording.
    pub fn abort(&self, capture: &dyn Capture) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            // default: a poisoned state retains the owned directory and stop status for an explicit cleanup retry.
            .unwrap_or_else(PoisonError::into_inner);
        let mut retired_stop_error = None;
        if state.directory.is_some() {
            if let Err(error) = settle_new_window(&mut state) {
                state.capture_stopped = true;
                retired_stop_error = Some(error);
            }
            if needs_stop(state.directory.as_deref(), state.capture_stopped) {
                if let Err(stop_error) = capture.stop() {
                    retired_stop_error = Some(stop_failure(&stop_error));
                }
                state.capture_stopped = true;
            }
        }
        let removal = state.directory.as_deref().and_then(remove_directory);
        let cleanup = settle_cleanup(retired_stop_error, removal.as_deref());
        if cleanup.retain_owner {
            return Err(cleanup.error.unwrap_or_default()); // default: settle_cleanup names the failed removal whenever it retains the owner.
        }
        state.directory = None;
        state.capture_stopped = false;
        state.window = None;
        self.state.clear_poison();
        cleanup.error.map_or(Ok(()), Err)
    }

    /// Ends the recording in progress and returns the folder, the number of frames and the window server number of its window, none for a display recording. The requester deletes the folder. A stop error
    /// ends the native recording too: finish then releases the recording and leaves the folder in place.
    pub fn finish(&self, capture: &dyn Capture) -> Result<(PathBuf, i32, Option<isize>), String> {
        let mut state = self
            .state
            .lock()
            // default: a poisoned state retains its owned directory and stop status for finish or abort cleanup.
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(error) = refuse_finish(state.directory.as_deref(), state.capture_stopped) {
            return Err(error);
        }
        if let Err(error) = settle_new_window(&mut state) {
            // The start failed before a recording ran: the requester owns the folder, which keeps what was written.
            state.directory = None;
            state.window = None;
            self.state.clear_poison();
            return Err(error);
        }
        let window = state.window.take();
        let count = match capture.stop() {
            Ok(count) => count,
            Err(stop_error) => {
                state.directory = None;
                state.capture_stopped = false;
                self.state.clear_poison();
                return Err(stop_error);
            }
        };
        state.capture_stopped = true;
        let directory = state
            .directory
            .take()
            .ok_or_else(|| "capture directory disappeared while stopping".to_string())?;
        state.capture_stopped = false;
        self.state.clear_poison();
        Ok((directory, count, window))
    }

    /// The folder of the recording in progress.
    pub fn running(&self) -> Option<PathBuf> {
        // default: panic paths leave state unchanged until capture stop succeeds; this read inspects the retained cleanup state.
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.directory.clone()
    }
}
