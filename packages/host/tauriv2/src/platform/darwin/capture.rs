//! native/darwin 의 창 캡처 호출.

use std::ffi::{c_char, c_int, CString};

extern "C" {
    fn sp_capture_open(window_number: isize);
    fn sp_capture_start(directory: *const c_char);
    fn sp_capture_wait() -> c_int;
    fn sp_capture_stop() -> c_int;
}

/// 창 번호의 창을 캡처 대상으로 준비한다.
pub fn open(window_number: isize) {
    unsafe { sp_capture_open(window_number) }
}

/// directory 에 프레임 기록을 시작한다. NUL 문자를 포함한 경로는 무시한다.
pub fn start(directory: &str) {
    let Ok(where_to) = CString::new(directory) else { return };
    unsafe { sp_capture_start(where_to.as_ptr()) }
}

/// 기록을 끝내고 기록한 프레임 수를 반환한다.
pub fn stop() -> i32 {
    unsafe { sp_capture_stop() }
}

/// 첫 프레임을 기다리고 기록 여부를 반환한다.
pub fn wait() -> bool {
    unsafe { sp_capture_wait() != 0 }
}
