use std::ffi::{CStr, c_char, c_void};
use std::path::PathBuf;

unsafe extern "C" {
    fn sp_diagnostic_reports_directory(failure: *mut *mut c_char) -> *mut c_char;
    fn free(pointer: *mut c_void);
}

/// The folder in which the system writes the crash reports of the current user, as the native library names it.
pub fn directory() -> Result<PathBuf, String> {
    let mut failure: *mut c_char = std::ptr::null_mut();
    // SAFETY: failure is a valid pointer for the native function to set.
    let path = unsafe { sp_diagnostic_reports_directory(&mut failure) };
    if path.is_null() {
        let message = unsafe { CStr::from_ptr(failure) }
            .to_string_lossy()
            .into_owned();
        unsafe { free(failure.cast()) };
        return Err(message);
    }
    let text = unsafe { CStr::from_ptr(path) }
        .to_str()
        .map(PathBuf::from)
        .map_err(|error| format!("the crash report folder is not UTF-8: {error}"));
    unsafe { free(path.cast()) };
    text
}
