//! The notification center calls of native/darwin.

use std::ffi::{CStr, CString, c_char, c_void};
use std::sync::OnceLock;

type Event = extern "C" fn(context: *mut c_void, json: *const c_char);

unsafe extern "C" {
    fn sp_notifications_start(event: Event, context: *mut c_void) -> *const c_char;
    fn sp_notifications_post(identifier: *const c_char, title: *const c_char, body: *const c_char);
    fn sp_notifications_remove(identifier: *const c_char);
}

/// The function that receives the events of the notification center. The notification center is one per process, so
/// only one is kept.
static RECEIVER: OnceLock<Box<dyn Fn(String) + Send + Sync>> = OnceLock::new();

extern "C" fn received(_context: *mut c_void, json: *const c_char) {
    let event = unsafe { CStr::from_ptr(json) }
        .to_string_lossy()
        .into_owned();
    if let Some(receive) = RECEIVER.get() {
        receive(event);
    }
}

fn text(field: &str, value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| format!("notification {field} contains a NUL byte"))
}

/// Starts to use the notification center. Call it on the main thread.
pub fn start(receive: Box<dyn Fn(String) + Send + Sync>) -> Result<(), String> {
    RECEIVER
        .set(receive)
        .map_err(|_| "system notifications are already started".to_string())?;
    let failure = unsafe { sp_notifications_start(received, std::ptr::null_mut()) };
    if failure.is_null() {
        Ok(())
    } else {
        Err(unsafe { CStr::from_ptr(failure) }
            .to_string_lossy()
            .into_owned())
    }
}

/// Posts or replaces the notification of identifier. Call it on the main thread.
pub fn post(identifier: &str, title: &str, body: &str) -> Result<(), String> {
    let (identifier, title, body) = (
        text("identifier", identifier)?,
        text("title", title)?,
        text("body", body)?,
    );
    unsafe { sp_notifications_post(identifier.as_ptr(), title.as_ptr(), body.as_ptr()) };
    Ok(())
}

/// Clears the notification of identifier. Call it on the main thread.
pub fn remove(identifier: &str) -> Result<(), String> {
    let identifier = text("identifier", identifier)?;
    unsafe { sp_notifications_remove(identifier.as_ptr()) };
    Ok(())
}
