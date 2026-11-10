//! Waits for the end of a process. The implementation is process_exit.m of native/darwin. It is included only in
//! diagnostic builds.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};

unsafe extern "C" {
    fn sp_process_when_exited(
        pid: i32,
        done: extern "C" fn(context: *mut c_void, exited: bool),
        context: *mut c_void,
    );
    fn sp_process_exit_end(context: *mut c_void);
}

type Done = Box<dyn FnOnce(bool) + Send>;

/// The done of each wait that has not answered, by the number that is its context. A number is never used again, so an
/// end after the answer cannot end a later wait.
static WAITS: Mutex<Option<HashMap<usize, Done>>> = Mutex::new(None);
static NEXT: AtomicUsize = AtomicUsize::new(1);

extern "C" fn answered(context: *mut c_void, exited: bool) {
    let done = WAITS
        .lock()
        // default: a lock that a panicking thread poisoned still holds the waits, which the answer takes from; the panic hook
        // records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(HashMap::new)
        .remove(&(context as usize));
    // The library calls done once for each context.
    if let Some(done) = done {
        done(exited);
    }
}

/// Answers done when the process pid ends or the returned end ends the wait. Call it and the end on the main thread.
pub fn when_exited(pid: i32, done: Done) -> super::super::WaitEnd {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    WAITS
        .lock()
        // default: a lock that a panicking thread poisoned still holds the waits, which the registration extends; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(HashMap::new)
        .insert(id, done);
    unsafe { sp_process_when_exited(pid, answered, id as *mut c_void) }
    Box::new(move || unsafe { sp_process_exit_end(id as *mut c_void) })
}
