//! native/darwin 의 마우스 버튼 감시 호출.

use std::ffi::c_void;
use std::sync::OnceLock;

type Changed = extern "C" fn(context: *mut c_void, mask: u64);

extern "C" {
    fn sp_mouse_buttons_watch(changed: Changed, context: *mut c_void) -> bool;
}

/// 마우스 버튼 mask 를 받는 함수. 감시는 프로세스에 하나이므로 하나만 둔다.
static RECEIVER: OnceLock<Box<dyn Fn(u64) + Send + Sync>> = OnceLock::new();

extern "C" fn changed(_context: *mut c_void, mask: u64) {
    if let Some(receive) = RECEIVER.get() {
        receive(mask);
    }
}

/// native/darwin 의 sp_mouse_buttons_watch 로 감시를 설치한다. 메인 스레드에서 호출한다.
pub fn watch(receive: Box<dyn Fn(u64) + Send + Sync>) -> Result<(), String> {
    RECEIVER
        .set(receive)
        .map_err(|_| "the mouse buttons are already watched".to_string())?;
    if unsafe { sp_mouse_buttons_watch(changed, std::ptr::null_mut()) } {
        Ok(())
    } else {
        Err("AppKit did not install the mouse button event monitors (sp_mouse_buttons_watch must run once on the main thread)".into())
    }
}
