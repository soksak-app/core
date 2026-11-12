//! The window capture calls of native/darwin.

use std::ffi::{CStr, CString, c_char, c_int, c_void};

use crate::platform::{Handle, LayoutRecord};

unsafe extern "C" {
    fn sp_capture_open(
        window_number: isize,
        display: bool,
        token: u64,
        error: *mut *mut c_char,
    ) -> bool;
    fn sp_capture_start(
        directory: *const c_char,
        frame_identity: bool,
        error: *mut *mut c_char,
    ) -> bool;
    fn sp_capture_error() -> *const c_char;
    fn sp_capture_wait(token: u64) -> c_int;
    fn sp_capture_stop(after: f64, token: u64) -> c_int;
    fn sp_capture_end_wait(token: u64, reason: *const c_char);
    fn sp_capture_has_stream() -> bool;
    fn sp_capture_hold_new_window(error: *mut *mut c_char) -> bool;
    fn sp_capture_wait_new_window(token: u64) -> std::os::raw::c_long;
    fn sp_capture_release_new_window();
    fn sp_document_frame_identity_start(
        document: *mut c_void,
        generation: u64,
        reply: extern "C" fn(*mut c_void, *const c_char, *const c_char),
        context: *mut c_void,
    ) -> bool;
    fn sp_document_frame_identity_freeze(
        generation: u64,
        reply: extern "C" fn(*mut c_void, *const c_char, *const c_char),
        context: *mut c_void,
    ) -> bool;
    fn sp_document_frame_identity_remove(
        generation: u64,
        reply: extern "C" fn(*mut c_void, *const c_char, *const c_char),
        context: *mut c_void,
    ) -> bool;
    fn sp_capture_limited() -> bool;
    fn sp_capture_longest_gap() -> f64;
    fn sp_capture_clock() -> f64;
    fn sp_capture_still(
        window_numbers: *const isize,
        count: c_int,
        path: *const c_char,
        token: u64,
        error: *mut *mut c_char,
    ) -> bool;
    fn sp_notifications_delivered(
        done: extern "C" fn(context: *mut std::ffi::c_void, json: *const c_char),
        context: *mut std::ffi::c_void,
    );
    fn surfaceLayoutTraceStart();
    fn surfaceLayoutTraceStop(out: *mut f64, capacity: usize) -> usize;
}

type IdentityDone = Box<dyn FnOnce(Result<String, String>) + Send>;

extern "C" fn document_frame_identity_reply(
    context: *mut c_void,
    json: *const c_char,
    error: *const c_char,
) {
    let done = unsafe { Box::from_raw(context.cast::<IdentityDone>()) };
    if !error.is_null() {
        done(Err(unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned()));
    } else if json.is_null() {
        done(Err(
            "document frame identity callback returned no JSON".into()
        ));
    } else {
        done(Ok(unsafe { CStr::from_ptr(json) }
            .to_string_lossy()
            .into_owned()));
    }
}

pub fn document_frame_identity_start(
    document: Handle,
    generation: u64,
    done: IdentityDone,
) -> Result<(), String> {
    let context = Box::into_raw(Box::new(done)).cast::<c_void>();
    if unsafe {
        sp_document_frame_identity_start(
            document as *mut c_void,
            generation,
            document_frame_identity_reply,
            context,
        )
    } {
        Ok(())
    } else {
        unsafe { drop(Box::from_raw(context.cast::<IdentityDone>())) };
        Err("start document frame identity was not scheduled".into())
    }
}

fn schedule_document_frame_identity(
    operation: &str,
    generation: u64,
    done: IdentityDone,
    schedule: unsafe extern "C" fn(
        u64,
        extern "C" fn(*mut c_void, *const c_char, *const c_char),
        *mut c_void,
    ) -> bool,
) -> Result<(), String> {
    let context = Box::into_raw(Box::new(done)).cast::<c_void>();
    if unsafe { schedule(generation, document_frame_identity_reply, context) } {
        Ok(())
    } else {
        unsafe { drop(Box::from_raw(context.cast::<IdentityDone>())) };
        Err(format!(
            "{operation} document frame identity was not scheduled"
        ))
    }
}

pub fn document_frame_identity_freeze(generation: u64, done: IdentityDone) -> Result<(), String> {
    schedule_document_frame_identity(
        "freeze",
        generation,
        done,
        sp_document_frame_identity_freeze,
    )
}

pub fn document_frame_identity_remove(generation: u64, done: IdentityDone) -> Result<(), String> {
    schedule_document_frame_identity(
        "remove",
        generation,
        done,
        sp_document_frame_identity_remove,
    )
}

extern "C" fn delivered(context: *mut std::ffi::c_void, json: *const c_char) {
    let done = unsafe { Box::from_raw(context.cast::<Box<dyn FnOnce(String) + Send>>()) };
    done(
        unsafe { CStr::from_ptr(json) }
            .to_string_lossy()
            .into_owned(),
    );
}

/// Gives done the list of notifications that the notification center still shows. Call it on the main thread.
pub fn delivered_notifications(done: Box<dyn FnOnce(String) + Send>) {
    let context = Box::into_raw(Box::new(done)).cast();
    unsafe { sp_notifications_delivered(delivered, context) }
}

/// Starts to record the times of placement transactions. Call it on the main thread.
pub fn layout_trace_start() {
    unsafe { surfaceLayoutTraceStart() }
}

/// The number of values in the native record of one transaction (SURFACE_LAYOUT_TRACE_STAGES of native): ticket, begun,
/// presented, committed, requested, commit path code, open at commit and flushed.
const SURFACE_LAYOUT_TRACE_STAGES: usize = 8;
/// The commit path codes of the native record (SURFACE_LAYOUT_COMMIT_* of native).
const SURFACE_LAYOUT_COMMIT_PRESENT: f64 = 1.0;
const SURFACE_LAYOUT_COMMIT_START: f64 = 2.0;
const SURFACE_LAYOUT_COMMIT_VIEW_JOIN: f64 = 3.0;
const SURFACE_LAYOUT_COMMIT_VIEW_ABANDON: f64 = 4.0;
const SURFACE_LAYOUT_COMMIT_CANCEL: f64 = 5.0;

/// Stops the record and returns the record of each transaction. Call it on the main thread.
pub fn layout_trace_stop() -> Result<Vec<LayoutRecord>, String> {
    const CAPACITY: usize = 4096;
    let mut values = vec![0.0; CAPACITY * SURFACE_LAYOUT_TRACE_STAGES];
    let count = unsafe { surfaceLayoutTraceStop(values.as_mut_ptr(), CAPACITY) };
    if count > CAPACITY {
        return Err(format!(
            "layout trace capacity exceeded: {count} records, capacity {CAPACITY}"
        ));
    }
    layout_records(&values, count)
}

/// The name of a commit path code of the native record. None for a code that the native code does not declare.
fn commit_path_name(code: f64) -> Option<&'static str> {
    [
        (SURFACE_LAYOUT_COMMIT_PRESENT, "present"),
        (SURFACE_LAYOUT_COMMIT_START, "start"),
        (SURFACE_LAYOUT_COMMIT_VIEW_JOIN, "view-join"),
        (SURFACE_LAYOUT_COMMIT_VIEW_ABANDON, "view-abandon"),
        (SURFACE_LAYOUT_COMMIT_CANCEL, "cancel"),
    ]
    .into_iter()
    .find(|(declared, _)| *declared == code)
    .map(|(_, name)| name)
}

/// Reads count native layout records. A commit path code that the native code does not declare is an error.
fn layout_records(values: &[f64], count: usize) -> Result<Vec<LayoutRecord>, String> {
    values
        .as_chunks::<SURFACE_LAYOUT_TRACE_STAGES>()
        .0
        .iter()
        .take(count)
        .map(|value| {
            let commit_path = if value[5].is_nan() {
                None
            } else {
                let name = commit_path_name(value[5]).ok_or_else(|| {
                    format!(
                        "layout transaction {} has the unknown commit path {}",
                        value[0] as u64, value[5]
                    )
                })?;
                Some(name)
            };
            Ok(LayoutRecord {
                ticket: value[0] as u64,
                begun: value[1],
                presented: value[2],
                committed: value[3],
                requested: value[4],
                commit_path,
                open_at_commit: value[6],
                flushed: value[7],
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "capture_layout_test.rs"]
mod layout_test;

/// Prepares the window with the window number as a capture target. When display is set, it captures the windows of this
/// application on the display that holds the window.
fn last_error(operation: &str) -> String {
    let message = unsafe { CStr::from_ptr(sp_capture_error()) };
    format!("{operation}: {}", message.to_string_lossy())
}

// It reads and releases the error of each call, and does not look up the shared error of the recording.
fn call_result(operation: &str, success: bool, error: *mut c_char) -> Result<(), String> {
    if !error.is_null() {
        let message = unsafe { CStr::from_ptr(error) }
            .to_str()
            .map(|message| format!("{operation}: {message}"))
            // default: none. An error text that is not UTF-8 is reported as an error that states that fact.
            .unwrap_or_else(|error| format!("{operation}: native error is invalid UTF-8: {error}"));
        unsafe { libc::free(error.cast()) };
        return Err(message);
    }
    if !success {
        return Err(format!("{operation}: native failure has no reason"));
    }
    Ok(())
}

pub fn open(window_number: isize, display: bool, token: u64) -> Result<(), String> {
    let mut error = std::ptr::null_mut();
    let prepared = unsafe { sp_capture_open(window_number, display, token, &mut error) };
    call_result("capture open failed", prepared, error)
}

/// Starts to record frames in directory. A path that contains a NUL character is ignored.
pub fn start(directory: &str, frame_identity: bool) -> Result<(), String> {
    let where_to = CString::new(directory)
        .map_err(|_| "capture start failed: directory contains NUL".to_owned())?;
    let mut error = std::ptr::null_mut();
    let started = unsafe { sp_capture_start(where_to.as_ptr(), frame_identity, &mut error) };
    call_result("capture start failed", started, error)
}

/// Records until the presentation time after (ms, the call time when 0), ends the record and returns the number of
/// recorded frames.
pub fn stop(after: f64, token: u64) -> Result<i32, String> {
    let frames = unsafe { sp_capture_stop(after, token) };
    let error = unsafe { CStr::from_ptr(sp_capture_error()) };
    if error.to_bytes().is_empty() {
        Ok(frames)
    } else {
        Err(format!("capture stop failed: {}", error.to_string_lossy()))
    }
}

/// Holds the next show of a window that is not on screen. Call it on the main thread.
pub fn hold_new_window() -> Result<(), String> {
    let mut error = std::ptr::null_mut();
    let held = unsafe { sp_capture_hold_new_window(&mut error) };
    call_result("capture hold of a new window failed", held, error)
}

/// Waits until a show was held and returns the window server number of that window.
pub fn wait_new_window(token: u64) -> Result<isize, String> {
    let number = unsafe { sp_capture_wait_new_window(token) };
    if number < 0 {
        let error = unsafe { CStr::from_ptr(sp_capture_error()) };
        return Err(error.to_string_lossy().into_owned());
    }
    Ok(number as isize)
}

/// Ends the hold of a new window at once: a held window goes on screen.
pub fn release_new_window() {
    unsafe { sp_capture_release_new_window() }
}

/// Reports whether the native capture module still owns the current stream and writer transaction.
pub fn has_stream() -> bool {
    unsafe { sp_capture_has_stream() }
}

/// Returns whether the last recording reached the finite frame limit and stopped automatically.
pub fn limited() -> bool {
    unsafe { sp_capture_limited() }
}

/// The longest presentation interval (ms) between consecutive frames in the record that was stopped last.
pub fn longest_gap() -> f64 {
    unsafe { sp_capture_longest_gap() }
}

/// The current time (ms). It is on the same clock as the presentation time of the recorded frames.
pub fn clock() -> f64 {
    unsafe { sp_capture_clock() }
}

/// Ends the wait of the capture call of token with reason. A reason that holds a NUL character ends it without its text.
pub fn end_wait(token: u64, reason: &str) {
    // default: a reason that holds a NUL character ends the wait without its text, as the native end names "its wait ended".
    let text = CString::new(reason).ok();
    unsafe {
        sp_capture_end_wait(
            token,
            text.as_ref().map_or(std::ptr::null(), |text| text.as_ptr()),
        )
    };
}

/// Waits for the first frame and the completion of the stream start and returns whether the frame was recorded.
pub fn wait(token: u64) -> Result<bool, String> {
    if unsafe { sp_capture_wait(token) != 0 } {
        Ok(true)
    } else {
        Err(last_error("capture wait failed"))
    }
}

/// Takes one still image of a window without giving it focus and writes it as PNG to path: the window is the first of
/// `window_numbers`, and its child windows, the rest, stand in their places over it.
pub fn still(window_numbers: &[isize], path: &str, token: u64) -> Result<(), String> {
    let target =
        CString::new(path).map_err(|_| "still capture failed: path contains NUL".to_owned())?;
    if window_numbers.is_empty() {
        return Err("still capture needs the number of a window".to_owned());
    }
    let count = c_int::try_from(window_numbers.len())
        .map_err(|_| "still capture failed: too many windows".to_owned())?;
    let mut error = std::ptr::null_mut();
    let written = unsafe {
        sp_capture_still(
            window_numbers.as_ptr(),
            count,
            target.as_ptr(),
            token,
            &mut error,
        )
    };
    call_result("still capture failed", written, error)
}
