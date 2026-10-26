//! The keyboard input source calls of native/darwin. They are included only in diagnostic builds.

use block2::{Block, RcBlock};
use std::ffi::{CStr, CString, c_char, c_void};

unsafe extern "C" {
    fn sp_input_source_current() -> *mut c_char;
    fn sp_input_source_select_and_await(
        identifier: *const c_char,
        adopted: &Block<dyn Fn(*const c_char)>,
    );
    fn free(pointer: *mut c_void);
}

/// Returns the identifier of the currently selected keyboard input source. Call it on the main thread.
pub fn current() -> Result<String, String> {
    let pointer = unsafe { sp_input_source_current() };
    if pointer.is_null() {
        return Err("the selected keyboard input source could not be read".into());
    }
    let identifier = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    unsafe { free(pointer as *mut c_void) };
    Ok(identifier)
}

/// Selects identifier and calls adopted after active key-view context adoption. Call it on the main thread.
pub fn select(identifier: &str, adopted: Box<dyn Fn(Result<(), String>)>) {
    let Ok(wanted) = CString::new(identifier) else {
        adopted(Err("input source identifier contains NUL".into()));
        return;
    };
    let block = RcBlock::new(move |failure: *const c_char| {
        if failure.is_null() {
            adopted(Ok(()));
        } else {
            adopted(Err(unsafe { CStr::from_ptr(failure) }
                .to_string_lossy()
                .into_owned()));
        }
    });
    unsafe { sp_input_source_select_and_await(wanted.as_ptr(), &block) };
}
