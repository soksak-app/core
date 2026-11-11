//! The state of a diagnostic recording. It is included only by the cargo feature `diagnostics`.
//!
//! There is one recording at a time. A start failure removes its folder after capture cleanup. A stop failure retains
//! ownership while the capture module still owns its stream and writer transaction; once that ownership retires, finish
//! transfers the folder to its requester and abort removes it. A remaining recording or cleanup folder blocks another start.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, mpsc};

use serde_json::{Value, json};

use crate::platform::LayoutRecord;

/// The response of the request that ended a recording. It holds the frame folder, callback status artifact, number of frames,
/// whether the recording reached the limit, and the longest interval between frames.
pub fn stop_payload(
    directory: &Path,
    count: i32,
    limited: bool,
    longest_gap: f64,
    layouts: &[LayoutRecord],
    frame_identity: bool,
) -> Value {
    let callback_status = directory.join("callback-status.jsonl");
    let display_link = directory.join("display-link.json");
    let mut payload = json!({"frames": directory.to_string_lossy(), "callbackStatus": callback_status.to_string_lossy(), "displayLink": display_link.to_string_lossy(), "count": count, "limited": limited, "longestGap": longest_gap, "layouts": layout_trace(layouts)});
    if frame_identity {
        payload["frameIdentity"] = json!({"status": "complete", "manifest": directory.join("frame-identities/manifest.json").to_string_lossy()});
    }
    payload
}

/// Converts the placement transaction records into {ticket, begun, requested, presented, committed, commitPath,
/// openAtCommit}. A value that did not happen is null.
pub fn layout_trace(records: &[LayoutRecord]) -> Value {
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

/// The recording device. A platform implementation or a fake of a check provides it.
pub trait Capture {
    /// Sets the window with the window server number target.window as the recording target. An error creates no
    /// preparation and leaves any existing active recording unchanged.
    fn open(&self, target: Target) -> Result<(), String>;
    /// Starts to record frames in directory. An error rolls back resources created by this attempt; a panic may
    /// interrupt an active start, which the recording owner stops while unwinding.
    fn start(&self, directory: &Path, frame_identity: bool) -> Result<(), String>;
    /// Returns whether the first frame was recorded.
    fn wait(&self) -> Result<bool, String>;
    /// Ends the recording and returns the number of recorded frames. An error may occur after native ownership retires.
    fn stop(&self) -> Result<i32, String>;
    /// Reports whether the native capture module still owns the current stream and writer transaction.
    /// It does not report whether the operating system's asynchronous stop callback has completed.
    fn has_stream(&self) -> Result<bool, String>;
}

/// A recording device that also records a new window from its first frame: it holds the next show of a window that is
/// not on screen, and the stream start of the recording of that window puts it on screen.
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
/// then the open, the start and the first frame of its recording.
struct NewWindowStart {
    done: mpsc::Receiver<(Result<(), String>, bool)>,
    end: Arc<Mutex<NewWindowEnd>>,
}

struct State {
    directory: Option<PathBuf>,
    capture_stopped: bool,
    frame_identity: bool,
    document_identity_allowed: bool,
    identity_source: Option<(String, u64)>,
    pending: Option<NewWindowStart>,
}

/// Opens, starts and waits for the first frame of a recording, and stops a recording that did not produce it. It returns
/// the result and whether no stream remains.
fn begin(
    capture: &dyn Capture,
    target: Target,
    directory: &Path,
    frame_identity: bool,
) -> (Result<(), String>, bool) {
    if let Err(error) = capture.open(target) {
        return (Err(error), true);
    }
    if let Err(error) = capture.start(directory, frame_identity) {
        return (Err(error), true);
    }
    let error = match capture.wait() {
        Ok(true) => return (Ok(()), false),
        Ok(false) => "capture did not produce an initial frame".to_string(),
        Err(error) => error,
    };
    match capture.stop() {
        Ok(_) => (Err(error), true),
        Err(stop_error) => match capture.has_stream() {
            Ok(false) => (
                Err(format!("{error}; capture stop failed: {stop_error}")),
                true,
            ),
            Ok(true) => (
                Err(format!("{error}; capture stop failed: {stop_error}")),
                false,
            ),
            Err(query_error) => (
                Err(format!(
                    "{error}; capture stop failed: {stop_error}; capture ownership query failed: {query_error}"
                )),
                false,
            ),
        },
    }
}

/// Waits for the start of the recording of a new window, ending a hold that no show took, and returns the failure of
/// that start with whether no stream remains.
fn settle_new_window(state: &mut State) -> Result<(), (String, bool)> {
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
        Ok((Ok(()), _)) => Ok(()),
        Ok((Err(error), stopped)) => Err((error, stopped)),
        Err(_) => Err((
            "the start of the new window recording ended without a result".into(),
            true,
        )),
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
                frame_identity: false,
                document_identity_allowed: false,
                identity_source: None,
                pending: None,
            }),
        }
    }

    /// Holds the next show of a window that is not on screen and returns once the hold is set, owning directory. The
    /// recording of that window then starts on a thread of its own: once the application shows a window, the recording
    /// opens on it and starts, and the stream start puts the window on screen, so the first frame of the recording is the
    /// first frame of the window. A failure after the hold took a window shows that window. `finish` and `abort` end a
    /// hold that no show took and report the result of the start.
    pub fn start_new_window(
        &self,
        capture: Arc<dyn NewWindowCapture>,
        directory: &Path,
        frame_identity: bool,
        make: &dyn Fn(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        // default: poison paths preserve the owned directory and stop status, so start can refuse a running capture.
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(running) = &state.directory {
            return Err(format!("a capture into {} is running", running.display()));
        }
        if let Some((surface, generation)) = &state.identity_source {
            return Err(format!(
                "document frame identity cleanup for surface {surface:?} generation {generation} is incomplete"
            ));
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
        std::thread::spawn(move || {
            let register = |given: Box<dyn Fn(&'static str) + Send + Sync>| {
                // default: a lock that a panicking thread poisoned still holds the end, which this call sets.
                let mut end = registered.lock().unwrap_or_else(PoisonError::into_inner);
                match end.ended {
                    Some(reason) => given(reason),
                    None => end.end = Some(given),
                }
            };
            let result = match capture.wait_new_window(&register) {
                Err(error) => (Err(error), true),
                Ok(number) => {
                    let target = Target {
                        window: number,
                        display: false,
                    };
                    let result = begin(capture.as_ref(), target, &target_directory, frame_identity);
                    if result.0.is_err() {
                        capture.release_new_window();
                    }
                    result
                }
            };
            // default: the owner that waits for the result may have gone with the recording; nothing waits then.
            let _ = done.send(result);
        });
        state.directory = Some(directory.to_path_buf());
        state.capture_stopped = false;
        state.frame_identity = frame_identity;
        state.document_identity_allowed = false;
        state.identity_source = None;
        state.pending = Some(NewWindowStart { done: on_done, end });
        Ok(())
    }

    /// Creates directory with make and starts to record target in that folder. It returns after the first frame was
    /// recorded. On a failure it stops the recording and deletes the folder.
    pub fn start(
        &self,
        capture: &dyn Capture,
        target: Target,
        directory: &Path,
        frame_identity: bool,
        make: &dyn Fn(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        self.start_with_document_identity(capture, target, directory, frame_identity, false, make)
    }

    /// Starts a diagnostics.capture.start recording that can select one plugin-root document source.
    pub fn start_with_document_identity(
        &self,
        capture: &dyn Capture,
        target: Target,
        directory: &Path,
        frame_identity: bool,
        document_identity_allowed: bool,
        make: &dyn Fn(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        // default: poison paths preserve the owned directory and stop status before unwinding, so start can refuse a
        // running or cleanup-pending capture.
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(running) = &state.directory {
            return Err(format!("a capture into {} is running", running.display()));
        }
        if let Some((surface, generation)) = &state.identity_source {
            return Err(format!(
                "document frame identity cleanup for surface {surface:?} generation {generation} is incomplete"
            ));
        }
        // The caller owns the path until creation succeeds; a failed `make` must not trigger directory removal here.
        make(directory)?;
        let mut capture_open_attempted = false;
        let mut capture_stop_attempted = false;
        let mut capture_stopped = false;
        let started = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // The preparation decides the output size from the window size at that time, so even the same target is
            // prepared again for every recording.
            capture_open_attempted = true;
            capture.open(target)?;
            capture.start(directory, frame_identity)?;
            match capture.wait() {
                Ok(true) => Ok(()),
                Ok(false) => {
                    capture_stop_attempted = true;
                    match capture.stop() {
                        Ok(_) => {
                            capture_stopped = true;
                            Err("capture did not produce an initial frame".into())
                        }
                        Err(stop_error) => {
                            let failure = format!(
                                "capture did not produce an initial frame; stop failed: {stop_error}"
                            );
                            match capture.has_stream() {
                                Ok(false) => {
                                    capture_stopped = true;
                                    Err(failure)
                                }
                                Ok(true) => Err(failure),
                                Err(query_error) => Err(format!(
                                    "{failure}; capture ownership query failed: {query_error}"
                                )),
                            }
                        }
                    }
                }
                Err(error) => {
                    capture_stop_attempted = true;
                    match capture.stop() {
                        Ok(_) => {
                            capture_stopped = true;
                            Err(error)
                        }
                        Err(stop_error) => {
                            let failure = format!("{error}; capture stop failed: {stop_error}");
                            match capture.has_stream() {
                                Ok(false) => {
                                    capture_stopped = true;
                                    Err(failure)
                                }
                                Ok(true) => Err(failure),
                                Err(query_error) => Err(format!(
                                    "{failure}; capture ownership query failed: {query_error}"
                                )),
                            }
                        }
                    }
                }
            }
        }));
        match started {
            Ok(Ok(())) => {
                state.directory = Some(directory.to_path_buf());
                state.capture_stopped = false;
                state.frame_identity = frame_identity;
                state.document_identity_allowed = document_identity_allowed;
                state.identity_source = None;
                Ok(())
            }
            Ok(Err(error)) if capture_stop_attempted && !capture_stopped => {
                state.directory = Some(directory.to_path_buf());
                state.capture_stopped = false;
                state.frame_identity = frame_identity;
                state.document_identity_allowed = false;
                state.identity_source = None;
                Err(error)
            }
            Ok(Err(error)) => match std::fs::remove_dir_all(directory) {
                Ok(()) => Err(error),
                Err(cleanup_error) => {
                    state.directory = Some(directory.to_path_buf());
                    state.capture_stopped = capture_stopped || !capture_stop_attempted;
                    state.frame_identity = frame_identity;
                    state.document_identity_allowed = false;
                    state.identity_source = None;
                    Err(format!(
                        "{error}; capture directory cleanup failed: {cleanup_error}"
                    ))
                }
            },
            Err(panic) => {
                let mut cleanup_errors = Vec::new();
                let mut retain_owner = false;
                if !capture_open_attempted {
                    capture_stopped = true;
                }
                if capture_open_attempted && !capture_stop_attempted {
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| capture.stop()))
                    {
                        Ok(Ok(_)) => capture_stopped = true,
                        Ok(Err(error)) => {
                            cleanup_errors.push(format!("capture stop failed: {error}"));
                            match capture.has_stream() {
                                Ok(false) => capture_stopped = true,
                                Ok(true) => retain_owner = true,
                                Err(query_error) => {
                                    retain_owner = true;
                                    cleanup_errors.push(format!(
                                        "capture ownership query failed: {query_error}"
                                    ));
                                }
                            }
                        }
                        Err(_) => {
                            cleanup_errors.push("capture stop panicked".into());
                            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                capture.has_stream()
                            })) {
                                Ok(Ok(false)) => capture_stopped = true,
                                Ok(Ok(true)) => retain_owner = true,
                                Ok(Err(query_error)) => {
                                    retain_owner = true;
                                    cleanup_errors.push(format!(
                                        "capture ownership query failed: {query_error}"
                                    ));
                                }
                                Err(_) => {
                                    retain_owner = true;
                                    cleanup_errors.push("capture ownership query panicked".into());
                                }
                            }
                        }
                    }
                }
                if capture_open_attempted && capture_stop_attempted && !capture_stopped {
                    cleanup_errors.push("capture stop did not complete before panic".into());
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        capture.has_stream()
                    })) {
                        Ok(Ok(false)) => capture_stopped = true,
                        Ok(Ok(true)) => retain_owner = true,
                        Ok(Err(query_error)) => {
                            retain_owner = true;
                            cleanup_errors
                                .push(format!("capture ownership query failed: {query_error}"));
                        }
                        Err(_) => {
                            retain_owner = true;
                            cleanup_errors.push("capture ownership query panicked".into());
                        }
                    }
                }
                if !capture_stopped && cleanup_errors.is_empty() {
                    cleanup_errors.push("capture stop was not confirmed".into());
                }
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
                    state.frame_identity = false;
                    state.document_identity_allowed = false;
                    state.identity_source = None;
                    self.state.clear_poison();
                } else {
                    state.directory = Some(directory.to_path_buf());
                    state.capture_stopped = capture_stopped;
                    state.frame_identity = frame_identity;
                    state.document_identity_allowed = false;
                    state.identity_source = None;
                    crate::application_log::log_error("recording", cleanup_errors.join("; "));
                }
                if !cleanup_errors.is_empty() && !retain_owner {
                    crate::application_log::log_error("recording", cleanup_errors.join("; "));
                }
                drop(state);
                std::panic::resume_unwind(panic)
            }
        }
    }

    /// Stops the recording in progress and deletes the folder. It reports a stop error even after native ownership retires.
    /// It does nothing when there is no recording.
    pub fn abort(&self, capture: &dyn Capture) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            // default: a poisoned state retains the owned directory and stop status for an explicit cleanup retry.
            .unwrap_or_else(PoisonError::into_inner);
        let mut retired_stop_error = None;
        if state.directory.is_some() {
            if let Err((error, true)) = settle_new_window(&mut state) {
                state.capture_stopped = true;
                retired_stop_error = Some(error);
            }
            if !state.capture_stopped {
                match capture.stop() {
                    Ok(_) => state.capture_stopped = true,
                    Err(stop_error) => match capture.has_stream() {
                        Ok(true) => return Err(format!("capture stop failed: {stop_error}")),
                        Err(query_error) => {
                            return Err(format!(
                                "capture stop failed: {stop_error}; capture ownership query failed: {query_error}"
                            ));
                        }
                        Ok(false) => {
                            state.capture_stopped = true;
                            retired_stop_error = Some(format!("capture stop failed: {stop_error}"));
                        }
                    },
                }
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
        state.frame_identity = false;
        state.document_identity_allowed = false;
        state.identity_source = None;
        self.state.clear_poison();
        match retired_stop_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Ends the recording in progress and returns the folder and the number of frames. The requester deletes the
    /// folder. A stop error after native ownership retires releases recording ownership and leaves the folder in place.
    pub fn finish(&self, capture: &dyn Capture) -> Result<(PathBuf, i32, bool), String> {
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
        if let Err((error, stopped)) = settle_new_window(&mut state) {
            // The start failed before a recording ran: the requester owns the folder, which keeps what was written.
            if stopped {
                state.directory = None;
                state.frame_identity = false;
                self.state.clear_poison();
            }
            return Err(error);
        }
        let count = match capture.stop() {
            Ok(count) => count,
            Err(stop_error) => match capture.has_stream() {
                Ok(true) => return Err(stop_error),
                Err(query_error) => {
                    return Err(format!(
                        "{stop_error}; capture ownership query failed: {query_error}"
                    ));
                }
                Ok(false) => {
                    state.directory = None;
                    state.capture_stopped = false;
                    state.frame_identity = false;
                    if state.identity_source.is_none() {
                        state.document_identity_allowed = false;
                    }
                    self.state.clear_poison();
                    return Err(stop_error);
                }
            },
        };
        state.capture_stopped = true;
        let directory = state
            .directory
            .take()
            .ok_or_else(|| "capture directory disappeared while stopping".to_string())?;
        state.capture_stopped = false;
        let frame_identity = std::mem::replace(&mut state.frame_identity, false);
        if state.identity_source.is_none() {
            state.document_identity_allowed = false;
        }
        self.state.clear_poison();
        Ok((directory, count, frame_identity))
    }

    /// Returns the active identity-capture flag and its selected view root.
    pub fn frame_identity_state(&self) -> (bool, Option<(String, u64)>) {
        // default: panic paths leave state unchanged until a stop succeeds; reading the retained state is safe for cleanup.
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        (
            state.directory.is_some() && state.frame_identity && state.document_identity_allowed,
            state.identity_source.clone(),
        )
    }

    /// Selects the one current view root for the active identity capture.
    pub fn select_frame_identity_source(
        &self,
        surface: &str,
        generation: u64,
    ) -> Result<(), String> {
        if surface.is_empty() || generation == 0 {
            return Err("document frame identity source requires a surface and generation".into());
        }
        // default: source validation runs before allocation and assignment, so a panic leaves the prior state intact.
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.directory.is_none() || !state.frame_identity || !state.document_identity_allowed {
            return Err("document frame identity requires an active frameIdentity capture".into());
        }
        if let Some((selected_surface, selected_generation)) = &state.identity_source {
            return Err(format!(
                "identity capture already selected surface {selected_surface:?} generation {selected_generation}"
            ));
        }
        state.identity_source = Some((surface.to_string(), generation));
        Ok(())
    }

    /// Clears the selected source after native marker cleanup completes.
    pub fn clear_frame_identity_source(&self, surface: &str, generation: u64) -> bool {
        // default: native cleanup completes before these non-panicking state-field updates run.
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state
            .identity_source
            .as_ref()
            .is_none_or(|(selected, current)| selected != surface || *current != generation)
        {
            return false;
        }
        state.identity_source = None;
        state.document_identity_allowed = false;
        true
    }

    /// The folder of the recording in progress.
    pub fn running(&self) -> Option<PathBuf> {
        // default: panic paths leave state unchanged until capture stop succeeds; this read inspects the retained cleanup state.
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.directory.clone()
    }
}
