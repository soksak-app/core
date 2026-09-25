use std::ffi::{c_char, c_void, CStr, CString};

extern "C" {
    fn sp_link_open(url: *const c_char) -> *mut c_char;
    fn free(pointer: *mut c_void);
}

/// URL 을 그 스킴의 사용자 기본 애플리케이션으로 연다. 메인 스레드에서 호출한다.
pub fn open(url: &str) -> Result<(), String> {
    let url = CString::new(url).map_err(|_| "link URL contains a NUL byte".to_string())?;
    let failure = unsafe { sp_link_open(url.as_ptr()) };
    if failure.is_null() {
        return Ok(());
    }
    let message = unsafe { CStr::from_ptr(failure) }
        .to_string_lossy()
        .into_owned();
    unsafe { free(failure.cast()) };
    Err(message)
}
