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

/// The recording device. A platform implementation or a fake of a check provides it.
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

/// Fault injection points of the recording. A set variable makes its point fail after the device call it names, and the
/// value is the exact error text. The device call runs first, so the device records the call as the native device does.
/// docs/operations/examples.md#test-kinds
const CAPTURE_OPEN_FAULT: &str = "SOKSAK_FAULT_CAPTURE_OPEN";
const CAPTURE_START_FAULT: &str = "SOKSAK_FAULT_CAPTURE_START";
const CAPTURE_STOP_FAULT: &str = "SOKSAK_FAULT_CAPTURE_STOP";

/// Returns the error that the fault point named by variable injects, or None when the variable is unset or empty. A value
/// that is not Unicode is reported as the error.
fn fault_error(variable: &str) -> Option<String> {
    match std::env::var(variable) {
        Ok(text) if text.is_empty() => None,
        Ok(text) => Some(text),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => Some(format!("{variable} is not valid Unicode")),
    }
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
    if let Some(error) = fault_error(CAPTURE_OPEN_FAULT) {
        return Err(error);
    }
    capture.start(directory, plan)?;
    fault_error(CAPTURE_START_FAULT).map_or(Ok(()), Err)
}

/// Stops the native recording and returns the number of frames it wrote. The recording ends also when the stop fails.
fn stop_capture(capture: &dyn Capture) -> Result<i32, String> {
    let count = capture.stop()?;
    match fault_error(CAPTURE_STOP_FAULT) {
        Some(error) => Err(error),
        None => Ok(count),
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
        if let Some(running) = &state.directory {
            return Err(format!("a capture into {} is running", running.display()));
        }
        make(directory)?;
        if let Err(error) = capture.hold_new_window() {
            return Err(match std::fs::remove_dir_all(directory) {
                Ok(()) => error,
                Err(cleanup) => format!("{error}; capture directory cleanup failed: {cleanup}"),
            });
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
        if let Some(running) = &state.directory {
            return Err(format!("a capture into {} is running", running.display()));
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
            Ok(Err(error)) => match std::fs::remove_dir_all(directory) {
                Ok(()) => Err(error),
                Err(cleanup_error) => {
                    state.directory = Some(directory.to_path_buf());
                    state.capture_stopped = true;
                    Err(format!(
                        "{error}; capture directory cleanup failed: {cleanup_error}"
                    ))
                }
            },
            Err(panic) => {
                let mut cleanup_errors = Vec::new();
                let mut retain_owner = false;
                // A panic can interrupt a start that the native capture has not ended, so a start that reached the
                // capture is stopped; the stop ends the recording also when it fails.
                let capture_stopped = if capture_open_attempted {
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        stop_capture(capture)
                    })) {
                        Ok(Ok(_)) => true,
                        Ok(Err(error)) => {
                            cleanup_errors.push(format!("capture stop failed: {error}"));
                            true
                        }
                        Err(_) => {
                            cleanup_errors.push("capture stop panicked".into());
                            retain_owner = true;
                            false
                        }
                    }
                } else {
                    true
                };
                if capture_stopped {
                    match std::fs::remove_dir_all(directory) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => {
                            retain_owner = true;
                            cleanup_errors
                                .push(format!("capture directory cleanup failed: {error}"));
                        }
                    }
                }
                if !retain_owner {
                    state.directory = None;
                    state.capture_stopped = false;
                    self.state.clear_poison();
                } else {
                    state.directory = Some(directory.to_path_buf());
                    state.capture_stopped = capture_stopped;
                }
                if !cleanup_errors.is_empty() {
                    crate::application_log::log_error("recording", cleanup_errors.join("; "));
                }
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
            if !state.capture_stopped {
                if let Err(stop_error) = stop_capture(capture) {
                    retired_stop_error = Some(format!("capture stop failed: {stop_error}"));
                }
                state.capture_stopped = true;
            }
            if let Some(directory) = state.directory.as_deref() {
                match std::fs::remove_dir_all(directory) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(match retired_stop_error {
                            Some(stop_error) => {
                                format!("{stop_error}; capture directory cleanup failed: {error}")
                            }
                            None => format!("capture directory cleanup failed: {error}"),
                        });
                    }
                }
            }
        }
        state.directory = None;
        state.capture_stopped = false;
        state.window = None;
        self.state.clear_poison();
        match retired_stop_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Ends the recording in progress and returns the folder, the number of frames and the window server number of its window, none for a display recording. The requester deletes the folder. A stop error
    /// ends the native recording too: finish then releases the recording and leaves the folder in place.
    pub fn finish(&self, capture: &dyn Capture) -> Result<(PathBuf, i32, Option<isize>), String> {
        let mut state = self
            .state
            .lock()
            // default: a poisoned state retains its owned directory and stop status for finish or abort cleanup.
            .unwrap_or_else(PoisonError::into_inner);
        if state.capture_stopped {
            return Err(
                "capture has stopped but its directory cleanup is incomplete; abort is required"
                    .into(),
            );
        }
        if state.directory.is_none() {
            return Err("no capture is running".into());
        }
        if let Err(error) = settle_new_window(&mut state) {
            // The start failed before a recording ran: the requester owns the folder, which keeps what was written.
            state.directory = None;
            state.window = None;
            self.state.clear_poison();
            return Err(error);
        }
        let window = state.window.take();
        let count = match stop_capture(capture) {
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
