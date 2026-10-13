//! The mouse button watch calls of native/darwin.

use std::ffi::c_void;
use std::sync::OnceLock;

type Changed = extern "C" fn(context: *mut c_void, mask: u64);

unsafe extern "C" {
    fn sp_mouse_buttons_watch(changed: Changed, context: *mut c_void) -> bool;
}

/// The function that receives the mouse button mask. The watch is one per process, so only one is kept.
static RECEIVER: OnceLock<Box<dyn Fn(u64) + Send + Sync>> = OnceLock::new();

extern "C" fn changed(_context: *mut c_void, mask: u64) {
    if let Some(receive) = RECEIVER.get() {
        receive(mask);
    }
}

/// Installs the watch with sp_mouse_buttons_watch of native/darwin. Call it on the main thread.
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
