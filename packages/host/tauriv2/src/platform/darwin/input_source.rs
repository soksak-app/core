//! native/darwin 의 키보드 입력 소스 호출. 진단 빌드에만 들어간다.

use std::ffi::{c_char, c_void, CStr, CString};

extern "C" {
    fn sp_input_source_current() -> *mut c_char;
    fn sp_input_source_select(identifier: *const c_char) -> bool;
    fn free(pointer: *mut c_void);
}

/// 현재 선택된 키보드 입력 소스의 식별자를 반환한다. 메인 스레드에서 호출한다.
pub fn current() -> Result<String, String> {
    let pointer = unsafe { sp_input_source_current() };
    if pointer.is_null() {
        return Err("the selected keyboard input source could not be read".into());
    }
    let identifier = unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned();
    unsafe { free(pointer as *mut c_void) };
    Ok(identifier)
}

/// 켜져 있는 입력 소스 가운데 identifier 를 선택한다. 메인 스레드에서 호출한다.
pub fn select(identifier: &str) -> Result<(), String> {
    let wanted = CString::new(identifier)
        .map_err(|_| "input source identifier contains NUL".to_owned())?;
    if unsafe { sp_input_source_select(wanted.as_ptr()) } {
        Ok(())
    } else {
        Err(format!("input source {identifier} is not enabled or could not be selected"))
    }
}
