//! Tests of the native window of a view of the GPUI platform. The native layer runs only on the main thread, so this target runs
//! its tests on the main thread of its process through the runner of tests/support.

#[path = "../../support/main_thread.rs"]
mod main_thread;

use objc2::{ClassType, MainThreadMarker, msg_send, rc::Retained};
use objc2_app_kit::NSView;
use soksak_host_gpuikit::platform::darwin::window_pointer_for_test;

fn a_view_outside_a_window_has_no_native_window() -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("the test runs off the main thread".to_string());
    }
    // A view that no window holds: its native window is an error, which the callers propagate.
    let view: Retained<NSView> = unsafe { msg_send![NSView::class(), new] };
    match window_pointer_for_test(&view) {
        Err(_) => Ok(()),
        Ok(pointer) => Err(format!(
            "a view outside a window has the window pointer {pointer:?}"
        )),
    }
}

fn main() {
    main_thread::run(&[(
        "a_view_outside_a_window_has_no_native_window",
        a_view_outside_a_window_has_no_native_window,
    )]);
}
