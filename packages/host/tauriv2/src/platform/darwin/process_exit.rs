//! Waits for the end of a process. The implementation is process_exit.m of native/darwin. It is included only in
//! diagnostic builds.

use std::ffi::c_void;

extern "C" {
    fn sp_process_when_exited(
        pid: i32,
        seconds: f64,
        done: extern "C" fn(context: *mut c_void, exited: bool),
        context: *mut c_void,
    );
}

type Done = Box<dyn FnOnce(bool) + Send>;

extern "C" fn answered(context: *mut c_void, exited: bool) {
    // context is the value that when_exited passed with Box::into_raw, and the library calls done once.
    let done = unsafe { Box::from_raw(context.cast::<Done>()) };
    done(exited);
}

/// Answers done when the process pid ends or seconds elapsed. Call it on the main thread.
pub fn when_exited(pid: i32, seconds: f64, done: Done) {
    let context = Box::into_raw(Box::new(done)).cast();
    unsafe { sp_process_when_exited(pid, seconds, answered, context) }
}
