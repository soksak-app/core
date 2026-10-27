//! The state of a diagnostic recording. It is included only by the cargo feature `diagnostics`.
//!
//! There is one recording at a time. Whichever stage a start fails in, and when a request fails before it returns the
//! recording folder to the requester, the recording is stopped and the folder is deleted. A remaining recording blocks
//! the next recording, and a remaining folder cannot be deleted by the requester.

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
    /// Sets the window with the window server number target.window as the recording target.
    fn open(&self, target: Target) -> Result<(), String>;
    /// Starts to record frames in directory.
    fn start(&self, directory: &Path, frame_identity: bool) -> Result<(), String>;
    /// Returns whether the first frame was recorded.
    fn wait(&self) -> Result<bool, String>;
    /// Ends the recording and returns the number of recorded frames.
    fn stop(&self) -> Result<i32, String>;
}

struct State {
    directory: Option<PathBuf>,
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
        // default: a lock that a panicking thread poisoned still holds the recording state, which the start reads and
        // amends; the panic hook records the panic.
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
        let started = (|| -> Result<(), String> {
            // The preparation decides the output size from the window size at that time, so even the same target is
            // prepared again for every recording.
            capture.open(target)?;
            capture.start(directory, frame_identity)?;
            match capture.wait() {
                Ok(true) => Ok(()),
                Ok(false) => match capture.stop() {
                    Ok(_) => Err("capture did not produce an initial frame".into()),
                    Err(stop_error) => Err(format!(
                        "capture did not produce an initial frame; stop failed: {stop_error}"
                    )),
                },
                Err(error) => match capture.stop() {
                    Ok(_) => Err(error),
                    Err(stop_error) => Err(format!("{error}; capture stop failed: {stop_error}")),
                },
            }
        })();
        match started {
            Ok(()) => {
                state.directory = Some(directory.to_path_buf());
                state.frame_identity = frame_identity;
                state.document_identity_allowed = document_identity_allowed;
                state.identity_source = None;
                Ok(())
            }
            Err(error) => match std::fs::remove_dir_all(directory) {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(format!(
                    "{error}; capture directory cleanup failed: {cleanup_error}"
                )),
            },
        }
    }

    /// Stops the recording in progress and deletes the folder. It does nothing when there is no recording.
    pub fn abort(&self, capture: &dyn Capture) -> Result<(), String> {
        let directory = {
            let mut state = self
                .state
                .lock()
                // default: a lock that a panicking thread poisoned still holds the recording state, which the stop amends; the
                // panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            state.frame_identity = false;
            state.document_identity_allowed = false;
            state.identity_source = None;
            state.directory.take()
        };
        if let Some(directory) = directory {
            let stop_error = capture.stop().err();
            let cleanup_error = std::fs::remove_dir_all(directory)
                .err()
                .map(|error| error.to_string());
            match (stop_error, cleanup_error) {
                (None, None) => {}
                (Some(error), None) | (None, Some(error)) => return Err(error),
                (Some(stop_error), Some(cleanup_error)) => {
                    return Err(format!(
                        "capture stop failed: {stop_error}; capture directory cleanup failed: {cleanup_error}"
                    ));
                }
            }
        }
        Ok(())
    }

    /// Ends the recording in progress and returns the folder and the number of frames. The requester deletes the
    /// folder.
    pub fn finish(&self, capture: &dyn Capture) -> Result<(PathBuf, i32, bool), String> {
        let (directory, frame_identity) = {
            let mut state = self
                .state
                .lock()
                // default: a lock that a panicking thread poisoned still holds the recording state, which the stop amends;
                // the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            let directory = state.directory.take();
            let frame_identity = std::mem::replace(&mut state.frame_identity, false);
            if state.identity_source.is_none() {
                state.document_identity_allowed = false;
            }
            (directory, frame_identity)
        };
        let directory = directory.ok_or_else(|| "no capture is running".to_string())?;
        let count = match capture.stop() {
            Ok(count) => count,
            Err(error) => return Err(error),
        };
        Ok((directory, count, frame_identity))
    }

    /// Returns the active identity-capture flag and its selected view root.
    pub fn frame_identity_state(&self) -> (bool, Option<(String, u64)>) {
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
        // default: a lock that a panicking thread poisoned still holds the recording state, which is only read; the
        // panic hook records the panic.
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.directory.clone()
    }
}
