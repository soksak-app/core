//! The surface placement transaction.

use std::cell::RefCell;
use std::ffi::{CStr, c_char, c_void};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::framework::PlatformWebview;
use block2::{Block, RcBlock};

use super::super::Handle;

/// Starts the surface placement transaction ticket of the window. Whether the start is allowed is passed to ready.
pub fn begin(window: Handle, ticket: u64, ready: Box<dyn Fn(bool)>) {
    unsafe extern "C" {
        fn surfaceLayoutBegin(owner: *mut c_void, ticket: u64, ready: &Block<dyn Fn(i32)>);
    }
    let ready = RcBlock::new(move |allowed: i32| ready(allowed != 0));
    unsafe { surfaceLayoutBegin(window as *mut c_void, ticket, &ready) }
}

/// Settles the surface placement transaction ticket and returns whether it was settled.
pub fn commit(window: Handle, ticket: u64) -> bool {
    unsafe extern "C" {
        fn surfaceLayoutCommit(owner: *mut c_void, ticket: u64) -> bool;
    }
    unsafe { surfaceLayoutCommit(window as *mut c_void, ticket) }
}

/// Joins the view webview to the surface placement transaction of the window with ticket. The native join ends by the
/// presentation of the view, which runs presented once, or by the returned abandon, whichever comes first. The native side
/// does not call presented for a join that the abandon ended.
pub fn join_view(
    window: Handle,
    ticket: u64,
    view: Handle,
    presented: Box<dyn FnOnce() + Send>,
) -> Result<Option<crate::platform::ViewAbandon>, String> {
    unsafe extern "C" {
        fn surfaceLayoutJoinView(
            owner: *mut c_void,
            ticket: u64,
            view: *mut c_void,
            presented: &Block<dyn Fn()>,
        ) -> bool;
        fn surfaceLayoutAbandonView(owner: *mut c_void, view: *mut c_void) -> bool;
    }
    let ended = Arc::new(AtomicBool::new(false));
    let presented_slot = RefCell::new(Some(presented));
    let presented_ended = ended.clone();
    let done = RcBlock::new(move || {
        presented_ended.store(true, Ordering::SeqCst);
        if let Some(presented) = presented_slot.borrow_mut().take() {
            presented();
        }
    });
    let joined =
        unsafe { surfaceLayoutJoinView(window as *mut c_void, ticket, view as *mut c_void, &done) };
    if !joined {
        return Ok(None);
    }
    Ok(Some(Box::new(move || {
        if ended.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        if unsafe { surfaceLayoutAbandonView(window as *mut c_void, view as *mut c_void) } {
            Ok(())
        } else {
            Err("the native layout transaction has no open join of the view".to_string())
        }
    })))
}

/// Cancels the surface placement transaction in progress of the window.
pub fn cancel(window: Handle) {
    unsafe extern "C" {
        fn surfaceLayoutCancel(owner: *mut c_void);
    }
    unsafe { surfaceLayoutCancel(window as *mut c_void) }
}

/// Cancels the exact queued or active surface placement transaction of window.
pub fn cancel_ticket(window: Handle, ticket: u64) {
    unsafe extern "C" {
        fn surfaceLayoutCancelTicket(owner: *mut c_void, ticket: u64);
    }
    unsafe { surfaceLayoutCancelTicket(window as *mut c_void, ticket) }
}

/// Sets the title bar of the window to height (pt) when a new page starts. A visible window is set inside the start
/// transaction of ticket and committed together with the first presentation of the new page. The result is passed to
/// ready.
pub fn start_page(
    window: Handle,
    ticket: u64,
    height: f64,
    ready: Box<dyn Fn(Result<(), String>)>,
) {
    unsafe extern "C" {
        fn surfaceLayoutStartPage(
            owner: *mut c_void,
            ticket: u64,
            height: f64,
            ready: &Block<dyn Fn(*const c_char)>,
        );
    }
    let ready = RcBlock::new(move |failure: *const c_char| {
        if failure.is_null() {
            ready(Ok(()));
        } else {
            ready(Err(unsafe { CStr::from_ptr(failure) }
                .to_string_lossy()
                .into_owned()));
        }
    });
    unsafe { surfaceLayoutStartPage(window as *mut c_void, ticket, height, &ready) }
}

/// Checks the presentation readiness of the app document before the open placement is committed.
pub fn after_presentation(view: &PlatformWebview, done: Box<dyn Fn()>) {
    unsafe extern "C" {
        fn surfaceLayoutAfterPresentation(view: *mut c_void, done: &Block<dyn Fn()>);
    }
    let done = RcBlock::new(done);
    unsafe { surfaceLayoutAfterPresentation(view.inner().cast(), &done) }
}

/// Makes the block of the main web view. The block crosses main-thread steps in the hands of the caller, so it is a copy
/// that `after_settled` releases.
pub fn main_presentation(view: &PlatformWebview) -> Handle {
    unsafe extern "C" {
        fn surfaceLayoutMainPresentation(view: *mut c_void) -> *mut c_void;
        fn _Block_copy(block: *const c_void) -> *mut c_void;
    }
    unsafe { _Block_copy(surfaceLayoutMainPresentation(view.inner().cast())) as Handle }
}

/// When the window has no open surface placement transaction, checks the render completion of the block and the visible
/// app document, and then calls done with the presentation time (ms) of that screen.
pub fn after_settled(window: Handle, present: Handle, done: Box<dyn Fn(Result<f64, String>)>) {
    unsafe extern "C" {
        fn _Block_release(block: *const c_void);
        fn surfaceLayoutAfterSettled(
            window: *mut c_void,
            present: *mut c_void,
            done: &Block<dyn Fn(f64, *const c_char)>,
        );
    }
    let done = RcBlock::new(move |displayed: f64, error: *const c_char| {
        if error.is_null() {
            done(Ok(displayed));
        } else {
            let message = unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned();
            done(Err(message));
        }
    });
    unsafe {
        surfaceLayoutAfterSettled(window as *mut c_void, present as *mut c_void, &done);
        _Block_release(present as *const c_void);
    }
}

pub fn inject_settled_failure() {
    unsafe extern "C" {
        fn surfaceLayoutInjectSettledFailure();
    }
    unsafe { surfaceLayoutInjectSettledFailure() }
}
