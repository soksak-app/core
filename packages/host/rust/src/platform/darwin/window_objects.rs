//! Counts the live library objects attached to windows and webviews. The implementation is window_objects.m of
//! native/darwin. It is included only in diagnostic builds.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};

use super::super::WindowObjects;

/// The same layout as sp_window_objects of native/darwin. macOS is LP64, so the long of C is i64.
#[repr(C)]
struct Counts {
    window_compositions: i64,
    surface_hosts: i64,
    input_registrations: i64,
}

unsafe extern "C" {
    fn sp_window_objects_when(
        expected: *const Counts,
        done: extern "C" fn(context: *mut c_void, counts: *const Counts, reached: bool),
        context: *mut c_void,
    );
    fn sp_window_objects_end(context: *mut c_void);
}

type Done = Box<dyn FnOnce(WindowObjects, bool) + Send>;

/// The done of each wait that has not answered, by the number that is its context. A number is never used again, so an
/// end after the answer cannot end a later wait.
static WAITS: Mutex<Option<HashMap<usize, Done>>> = Mutex::new(None);
static NEXT: AtomicUsize = AtomicUsize::new(1);

extern "C" fn counted(context: *mut c_void, counts: *const Counts, reached: bool) {
    let done = WAITS
        .lock()
        // default: a lock that a panicking thread poisoned still holds the waits, which the answer takes from; the panic hook
        // records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(HashMap::new)
        .remove(&(context as usize));
    // The library calls done once for each context.
    let Some(done) = done else { return };
    let counts = unsafe { &*counts };
    done(
        WindowObjects {
            window_compositions: counts.window_compositions,
            surface_hosts: counts.surface_hosts,
            input_registrations: counts.input_registrations,
        },
        reached,
    );
}

/// Gives done the count after the application handled one event when the count equals expected, or the count when the
/// returned end ends the wait. Call it and the end on the main thread.
pub fn when(expected: Option<WindowObjects>, done: Done) -> super::super::WaitEnd {
    // The library copies expected during the call.
    let wanted = expected.map(|counts| Counts {
        window_compositions: counts.window_compositions,
        surface_hosts: counts.surface_hosts,
        input_registrations: counts.input_registrations,
    });
    let pointer = wanted
        .as_ref()
        .map_or(std::ptr::null(), |counts| counts as *const Counts);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    WAITS
        .lock()
        // default: a lock that a panicking thread poisoned still holds the waits, which the registration extends; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(HashMap::new)
        .insert(id, done);
    unsafe { sp_window_objects_when(pointer, counted, id as *mut c_void) }
    Box::new(move || unsafe { sp_window_objects_end(id as *mut c_void) })
}
