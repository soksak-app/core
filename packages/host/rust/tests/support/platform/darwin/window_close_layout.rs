//! The scenarios of tests/window_close_layout_test.rs on macOS: the close of a window and its layout transactions on the real platform.

use std::cell::Cell;
use std::ffi::{CStr, c_void};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use core_foundation::runloop::{CFRunLoop, kCFRunLoopDefaultMode};
use soksak_host::platform::{self, Handle, Platform};
use soksak_host::windows::{WindowClose, WindowData};

use crate::main_thread::{self, MainTest};

unsafe extern "C" {
    fn sp_host_test_window_create_titled(
        width: f64,
        height: f64,
        window: *mut *mut c_void,
    ) -> *const std::ffi::c_char;
    fn sp_host_test_window_close(window: *mut c_void) -> *const std::ffi::c_char;
}

fn native_error(text: *const std::ffi::c_char) -> Result<(), String> {
    if text.is_null() {
        Ok(())
    } else {
        Err(unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned())
    }
}

/// A window with the title bar of a framework window, which closes when the value is dropped.
struct TitledWindow(*mut c_void);

impl TitledWindow {
    fn new() -> Result<TitledWindow, String> {
        let mut window: *mut c_void = std::ptr::null_mut();
        native_error(unsafe { sp_host_test_window_create_titled(400.0, 300.0, &mut window) })?;
        Ok(TitledWindow(window))
    }

    fn handle(&self) -> Handle {
        self.0 as Handle
    }
}

impl Drop for TitledWindow {
    fn drop(&mut self) {
        if let Err(error) = native_error(unsafe { sp_host_test_window_close(self.0) }) {
            eprintln!("close the window: {error}");
        }
    }
}

/// Begins the layout transaction ticket of window and returns whether the begin was allowed in its call.
fn begin(platform: &dyn Platform, window: Handle, ticket: u64) -> Result<(), String> {
    let allowed = Rc::new(Cell::new(None));
    let answer = allowed.clone();
    platform.begin_layout(
        window,
        ticket,
        Box::new(move |began| answer.set(Some(began))),
    )?;
    match allowed.get() {
        Some(true) => Ok(()),
        other => Err(format!(
            "the layout {ticket} of the window did not begin in its call: {other:?}"
        )),
    }
}

/// Runs the main run loop until the main queue served each UI work that was queued before this call: the queue serves its works in
/// order, so the last work that this call queues ends the run.
fn serve_ui_works(platform: &dyn Platform) -> Result<(), String> {
    let served = Arc::new(AtomicBool::new(false));
    let marking = served.clone();
    platform.enqueue_ui(Box::new(move || {
        marking.store(true, Ordering::SeqCst);
        CFRunLoop::get_main().stop();
    }))?;
    while !served.load(Ordering::SeqCst) {
        CFRunLoop::run_in_mode(
            unsafe { kCFRunLoopDefaultMode },
            std::time::Duration::from_secs(10),
            false,
        );
    }
    Ok(())
}

// The close of a window cancels every layout transaction of the window in the step of the close, while the framework still holds the
// native window, and queues no work that names the window: the framework releases a closed window, and a work that runs after that
// release would cancel the transaction of a later window that the operating system placed at the same address
// (docs/spec/native-surfaces.md#layout-transaction). The native window of the test stays open after the close, so its address stands
// for that later window, and the main queue holds the works that the destruction of the window queued until that window began its
// layout, because the test runs on the main thread and serves the queue only after that begin.
// contract: window-close.layout.cancelled-in-close-step
fn the_close_of_a_window_cancels_its_layout_in_the_step_of_the_close() -> Result<(), String> {
    let platform = platform::current()?;
    let window = TitledWindow::new()?;
    let owner = window.handle();
    let close = WindowClose {
        label: "main".to_string(),
        data: Arc::new(WindowData::default()),
        platform,
        owner,
        responder_observation: platform.observe_responder(owner, Box::new(|| {}))?,
        cursor_observation: platform.observe_cursor(owner, Box::new(|| {}))?,
        sheet_observation: platform.observe_sheet(owner, Box::new(|| {}))?,
    };
    let mut failures = Vec::new();
    begin(platform, owner, 1)?;
    if close.requested(|| panic!("a window whose page is not ready asked its page")) {
        return Err("a window whose page is not ready kept its close".into());
    }
    if platform.commit_layout(owner, 1)? {
        failures.push("the close of the window left its layout 1 open after the step of the close");
    }
    let closing = Ok(close.data.clone());
    close.end_natives(closing)?;
    begin(platform, owner, 2)?;
    serve_ui_works(platform)?;
    if !platform.commit_layout(owner, 2)? {
        failures.push(
            "a work that the destruction of the window queued cancelled the layout 2 that a later window began at the address of the closed window",
        );
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

const TESTS: &[MainTest] = &[(
    "the_close_of_a_window_cancels_its_layout_in_the_step_of_the_close",
    the_close_of_a_window_cancels_its_layout_in_the_step_of_the_close,
)];

pub fn main() {
    main_thread::run(TESTS);
}
