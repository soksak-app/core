//! native/darwin 의 알림 센터 호출.

use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::OnceLock;

type Event = extern "C" fn(context: *mut c_void, json: *const c_char);

extern "C" {
    fn sp_notifications_start(event: Event, context: *mut c_void) -> *const c_char;
    fn sp_notifications_post(identifier: *const c_char, title: *const c_char, body: *const c_char);
    fn sp_notifications_remove(identifier: *const c_char);
}

/// 알림 센터 사건을 받는 함수. 알림 센터는 프로세스에 하나이므로 하나만 둔다.
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

/// 알림 센터를 쓰기 시작한다. 메인 스레드에서 호출한다.
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

/// identifier 의 알림을 게시하거나 바꾼다. 메인 스레드에서 호출한다.
pub fn post(identifier: &str, title: &str, body: &str) -> Result<(), String> {
    let (identifier, title, body) = (
        text("identifier", identifier)?,
        text("title", title)?,
        text("body", body)?,
    );
    unsafe { sp_notifications_post(identifier.as_ptr(), title.as_ptr(), body.as_ptr()) };
    Ok(())
}

/// identifier 의 알림을 지운다. 메인 스레드에서 호출한다.
pub fn remove(identifier: &str) -> Result<(), String> {
    let identifier = text("identifier", identifier)?;
    unsafe { sp_notifications_remove(identifier.as_ptr()) };
    Ok(())
}
