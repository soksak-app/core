//! native/darwin 의 창 캡처 호출.

use std::ffi::{c_char, c_int, CStr, CString};

extern "C" {
    fn sp_capture_open(window_number: isize, display: bool) -> bool;
    fn sp_capture_start(directory: *const c_char) -> bool;
    fn sp_capture_error() -> *const c_char;
    fn sp_capture_wait() -> c_int;
    fn sp_capture_stop(after: f64) -> c_int;
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

extern "C" fn delivered(context: *mut std::ffi::c_void, json: *const c_char) {
    let done = unsafe { Box::from_raw(context.cast::<Box<dyn FnOnce(String) + Send>>()) };
    done(
        unsafe { CStr::from_ptr(json) }
            .to_string_lossy()
            .into_owned(),
    );
}

/// 알림 센터가 아직 보이는 알림 목록을 done 에 준다. 메인 스레드에서 호출한다.
pub fn delivered_notifications(done: Box<dyn FnOnce(String) + Send>) {
    let context = Box::into_raw(Box::new(done)).cast();
    unsafe { sp_notifications_delivered(delivered, context) }
}

/// 배치 트랜잭션 시각의 기록을 시작한다. 메인 스레드에서 호출한다.
pub fn layout_trace_start() {
    unsafe { surfaceLayoutTraceStart() }
}

/// 기록을 멈추고 트랜잭션마다 ticket, begun, presented, committed 를 반환한다. 메인 스레드에서 호출한다.
pub fn layout_trace_stop() -> Result<Vec<[f64; 4]>, String> {
    const CAPACITY: usize = 4096;
    let mut values = vec![0.0; CAPACITY * 4];
    let count = unsafe { surfaceLayoutTraceStop(values.as_mut_ptr(), CAPACITY) };
    if count > CAPACITY {
        return Err(format!(
            "layout trace capacity exceeded: {count} records, capacity {CAPACITY}"
        ));
    }
    Ok(values
        .chunks_exact(4)
        .take(count)
        .map(|record| [record[0], record[1], record[2], record[3]])
        .collect())
}

/// 창 번호의 창을 캡처 대상으로 준비한다. display 이면 창이 있는 디스플레이에서 이 앱의 창을 캡처한다.
fn last_error(operation: &str) -> String {
    let message = unsafe { CStr::from_ptr(sp_capture_error()) };
    format!("{operation}: {}", message.to_string_lossy())
}

pub fn open(window_number: isize, display: bool) -> Result<(), String> {
    if unsafe { sp_capture_open(window_number, display) } {
        Ok(())
    } else {
        Err(last_error("capture open failed"))
    }
}

/// directory 에 프레임 기록을 시작한다. NUL 문자를 포함한 경로는 무시한다.
pub fn start(directory: &str) -> Result<(), String> {
    let where_to = CString::new(directory)
        .map_err(|_| "capture start failed: directory contains NUL".to_owned())?;
    if unsafe { sp_capture_start(where_to.as_ptr()) } {
        Ok(())
    } else {
        Err(last_error("capture start failed"))
    }
}

/// after 의 표시 시각(ms, 0 이면 호출 시각)까지 기록한 뒤 기록을 끝내고 기록한 프레임 수를 반환한다.
pub fn stop(after: f64) -> Result<i32, String> {
    let frames = unsafe { sp_capture_stop(after) };
    let error = unsafe { CStr::from_ptr(sp_capture_error()) };
    if error.to_bytes().is_empty() {
        Ok(frames)
    } else {
        Err(format!("capture stop failed: {}", error.to_string_lossy()))
    }
}

/// 마지막 녹화가 유한한 프레임 상한에 도달해 자동으로 멈췄는지 반환한다.
pub fn limited() -> bool {
    unsafe { sp_capture_limited() }
}

/// 마지막으로 멈춘 기록에서 연속한 프레임 사이의 가장 긴 표시 간격(ms).
pub fn longest_gap() -> f64 {
    unsafe { sp_capture_longest_gap() }
}

/// 현재 시각(ms). 기록 프레임의 표시 시각과 같은 시계다.
pub fn clock() -> f64 {
    unsafe { sp_capture_clock() }
}

/// 첫 프레임을 기다리고 기록 여부를 반환한다.
pub fn wait() -> Result<bool, String> {
    if unsafe { sp_capture_wait() != 0 } {
        Ok(true)
    } else {
        Err(last_error("capture wait failed"))
    }
}

/// 창 번호의 창을 포커스를 주지 않고 한 장 찍어 path 에 PNG 로 쓴다.
pub fn still(window_number: isize, path: &str) -> Result<(), String> {
    let target =
        CString::new(path).map_err(|_| "still capture failed: path contains NUL".to_owned())?;
    let mut error = std::ptr::null_mut();
    let written = unsafe { sp_capture_still(window_number, target.as_ptr(), &mut error) };
    if !error.is_null() {
        let message = unsafe { CStr::from_ptr(error) }
            .to_str()
            .map(|message| format!("still capture failed: {message}"))
            .unwrap_or_else(|error| format!("still capture returned invalid UTF-8 error: {error}"));
        unsafe { libc::free(error.cast()) };
        return Err(message);
    }
    if !written {
        return Err("still capture failed without a native reason".to_owned());
    }
    Ok(())
}
