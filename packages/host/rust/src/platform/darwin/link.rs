use std::ffi::{CStr, CString, c_char, c_void};

unsafe extern "C" {
    fn sp_link_open(url: *const c_char) -> *mut c_char;
    fn free(pointer: *mut c_void);
}

/// Opens a URL in the default application of the user for its scheme. Call it on the main thread.
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
