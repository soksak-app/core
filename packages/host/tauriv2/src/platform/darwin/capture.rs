//! The window capture calls of native/darwin.

use std::ffi::{CStr, CString, c_char, c_int, c_void};

use crate::platform::Handle;

unsafe extern "C" {
    fn sp_capture_open(window_number: isize, display: bool, error: *mut *mut c_char) -> bool;
    fn sp_capture_start(
        directory: *const c_char,
        frame_identity: bool,
        error: *mut *mut c_char,
    ) -> bool;
    fn sp_capture_error() -> *const c_char;
    fn sp_capture_wait() -> c_int;
    fn sp_capture_stop(after: f64) -> c_int;
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
    fn sp_capture_still(window_number: isize, path: *const c_char, error: *mut *mut c_char)
    -> bool;
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

/// Stops the record and returns ticket, begun, presented, committed and requested for each transaction. Call it on the
/// main thread. The number of values equals SURFACE_LAYOUT_TRACE_STAGES of native.
pub fn layout_trace_stop() -> Result<Vec<[f64; 5]>, String> {
    const CAPACITY: usize = 4096;
    let mut values = vec![0.0; CAPACITY * 5];
    let count = unsafe { surfaceLayoutTraceStop(values.as_mut_ptr(), CAPACITY) };
    if count > CAPACITY {
        return Err(format!(
            "layout trace capacity exceeded: {count} records, capacity {CAPACITY}"
        ));
    }
    Ok(values
        .as_chunks::<5>()
        .0
        .iter()
        .take(count)
        .copied()
        .collect())
}

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

pub fn open(window_number: isize, display: bool) -> Result<(), String> {
    let mut error = std::ptr::null_mut();
    let prepared = unsafe { sp_capture_open(window_number, display, &mut error) };
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
pub fn stop(after: f64) -> Result<i32, String> {
    let frames = unsafe { sp_capture_stop(after) };
    let error = unsafe { CStr::from_ptr(sp_capture_error()) };
    if error.to_bytes().is_empty() {
        Ok(frames)
    } else {
        Err(format!("capture stop failed: {}", error.to_string_lossy()))
    }
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

/// Waits for the first frame and returns whether it was recorded.
pub fn wait() -> Result<bool, String> {
    if unsafe { sp_capture_wait() != 0 } {
        Ok(true)
    } else {
        Err(last_error("capture wait failed"))
    }
}

/// Takes one still image of the window with the window number without giving it focus and writes it as PNG to path.
pub fn still(window_number: isize, path: &str) -> Result<(), String> {
    let target =
        CString::new(path).map_err(|_| "still capture failed: path contains NUL".to_owned())?;
    let mut error = std::ptr::null_mut();
    let written = unsafe { sp_capture_still(window_number, target.as_ptr(), &mut error) };
    call_result("still capture failed", written, error)
}
