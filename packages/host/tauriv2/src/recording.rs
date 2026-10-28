//! The state of a diagnostic recording. It is included only by the cargo feature `diagnostics`.
//!
//! There is one recording at a time. A start failure removes its folder after capture cleanup; when stopping fails, the
//! owned folder and stop state remain so `abort` can retry and block another start. A successful finish transfers the
//! folder to the requester.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde_json::{Value, json};

/// The response of the request that ended a recording. It holds the frame folder, callback status artifact, number of frames,
/// whether the recording reached the limit, and the longest interval between frames.
pub fn stop_payload(
    directory: &Path,
    count: i32,
    limited: bool,
    longest_gap: f64,
    layouts: &[[f64; 5]],
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

/// Converts the placement transaction record into {ticket, begun, presented, committed}. A stage that did not happen is
/// null.
pub fn layout_trace(records: &[[f64; 5]]) -> Value {
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
                    "ticket": record[0] as u64,
                    "begun": stage(record[1]),
                    "requested": stage(record[4]),
                    "presented": stage(record[2]),
                    "committed": stage(record[3]),
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
    /// Ends the recording and returns the number of recorded frames.
    fn stop(&self) -> Result<i32, String>;
}

struct State {
    directory: Option<PathBuf>,
    capture_stopped: bool,
    frame_identity: bool,
    document_identity_allowed: bool,
    identity_source: Option<(String, u64)>,
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
            }),
        }
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
                        Err(stop_error) => Err(format!(
                            "capture did not produce an initial frame; stop failed: {stop_error}"
                        )),
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
                            Err(format!("{error}; capture stop failed: {stop_error}"))
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
                if !capture_open_attempted {
                    capture_stopped = true;
                }
                if capture_open_attempted && !capture_stop_attempted {
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| capture.stop()))
                    {
                        Ok(Ok(_)) => capture_stopped = true,
                        Ok(Err(error)) => {
                            cleanup_errors.push(format!("capture stop failed: {error}"));
                        }
                        Err(_) => cleanup_errors.push("capture stop panicked".into()),
                    }
                }
                if !capture_stopped && cleanup_errors.is_empty() {
                    cleanup_errors.push("capture stop was not confirmed".into());
                }
                if capture_stopped {
                    match std::fs::remove_dir_all(directory) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => cleanup_errors
                            .push(format!("capture directory cleanup failed: {error}")),
                    }
                }
                if cleanup_errors.is_empty() {
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
                drop(state);
                std::panic::resume_unwind(panic)
            }
        }
    }

    /// Stops the recording in progress and deletes the folder. It does nothing when there is no recording.
    pub fn abort(&self, capture: &dyn Capture) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            // default: a poisoned state retains the owned directory and stop status for an explicit cleanup retry.
            .unwrap_or_else(PoisonError::into_inner);
        if state.directory.is_some() {
            if !state.capture_stopped {
                capture.stop()?;
                state.capture_stopped = true;
            }
            if let Some(directory) = state.directory.as_deref() {
                match std::fs::remove_dir_all(directory) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!("capture directory cleanup failed: {error}"));
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
        Ok(())
    }

    /// Ends the recording in progress and returns the folder and the number of frames. The requester deletes the
    /// folder.
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
        let count = capture.stop()?;
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
