//! The keyboard input source calls of native/darwin, which also holds the input source of each role. They are included only
//! in diagnostic builds.

use block2::{Block, RcBlock};
use std::ffi::{CStr, CString, c_char, c_void};
use std::sync::atomic::{AtomicUsize, Ordering};

use super::super::InputSourceEnd;

unsafe extern "C" {
    fn sp_input_source_current() -> *mut c_char;
    fn sp_input_source_role_identifier(role: *const c_char) -> *const c_char;
    fn sp_input_source_identifier_role(identifier: *const c_char) -> *const c_char;
    fn sp_input_source_select_and_await(
        identifier: *const c_char,
        key: *const c_void,
        adopted: &Block<dyn Fn(*const c_char)>,
    );
    fn sp_input_source_selection_end(key: *const c_void, reason: *const c_char);
    fn free(pointer: *mut c_void);
}

/// Returns the role of the currently selected keyboard input source, None for an input source without a role, and its
/// identifier. Call it on the main thread.
pub fn current() -> Result<(Option<String>, String), String> {
    let pointer = unsafe { sp_input_source_current() };
    if pointer.is_null() {
        return Err("the selected keyboard input source could not be read".into());
    }
    let identifier = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    // The role is a static string of the role table of native/darwin, or null.
    let role = unsafe { sp_input_source_identifier_role(pointer) };
    let role = (!role.is_null()).then(|| {
        unsafe { CStr::from_ptr(role) }
            .to_string_lossy()
            .into_owned()
    });
    unsafe { free(pointer as *mut c_void) };
    Ok((role, identifier))
}

/// Selects the input source of role and calls adopted after active key-view context adoption. Call it on the main thread.
pub fn select(role: &str, adopted: Box<dyn Fn(Result<(), String>)>) -> InputSourceEnd {
    let Ok(wanted) = CString::new(role) else {
        adopted(Err("input source role contains NUL".into()));
        return Box::new(|_| {});
    };
    let identifier = unsafe { sp_input_source_role_identifier(wanted.as_ptr()) };
    if identifier.is_null() {
        adopted(Err(format!(
            "the input source role {role:?} has no input source on macOS"
        )));
        return Box::new(|_| {});
    }
    await_selection(identifier, adopted)
}

/// Selects the input source with identifier source and calls adopted after active key-view context adoption. Call it on the
/// main thread.
pub fn restore(source: &str, adopted: Box<dyn Fn(Result<(), String>)>) -> InputSourceEnd {
    let Ok(wanted) = CString::new(source) else {
        adopted(Err("input source identifier contains NUL".into()));
        return Box::new(|_| {});
    };
    await_selection(wanted.as_ptr(), adopted)
}

/// The key of each selection, a number that is never used again, so an end after the adoption cannot end a later selection.
static KEYS: AtomicUsize = AtomicUsize::new(1);

fn await_selection(
    identifier: *const c_char,
    adopted: Box<dyn Fn(Result<(), String>)>,
) -> InputSourceEnd {
    let block = RcBlock::new(move |failure: *const c_char| {
        if failure.is_null() {
            adopted(Ok(()));
        } else {
            adopted(Err(unsafe { CStr::from_ptr(failure) }
                .to_string_lossy()
                .into_owned()));
        }
    });
    let key = KEYS.fetch_add(1, Ordering::Relaxed);
    unsafe { sp_input_source_select_and_await(identifier, key as *const c_void, &block) };
    Box::new(move |reason| {
        // default: a reason holds no NUL; one that does is named up to its first NUL, a text that CString takes without an
        // error.
        let named = reason.split('\0').next().unwrap_or_default();
        // default: the text before the first NUL holds no NUL, so CString takes it without an error.
        let reason = CString::new(named).unwrap_or_default();
        unsafe { sp_input_source_selection_end(key as *const c_void, reason.as_ptr()) };
    })
}
