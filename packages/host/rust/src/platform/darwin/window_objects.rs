//! Counts the live library objects attached to windows and webviews. The implementation is window_objects.m of
//! native/darwin. It is included only in diagnostic builds.

use std::ffi::c_void;

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
        seconds: f64,
        done: extern "C" fn(context: *mut c_void, counts: *const Counts, reached: bool),
        context: *mut c_void,
    );
}

type Done = Box<dyn FnOnce(WindowObjects, bool) + Send>;

extern "C" fn counted(context: *mut c_void, counts: *const Counts, reached: bool) {
    // context is the value that when passed with Box::into_raw, and the library calls done once.
    let done = unsafe { Box::from_raw(context.cast::<Done>()) };
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

/// Gives done the count after the application handled one event when the count equals expected, or the count when
/// seconds elapsed. Call it on the main thread.
pub fn when(expected: Option<WindowObjects>, seconds: f64, done: Done) {
    // The library copies expected during the call.
    let wanted = expected.map(|counts| Counts {
        window_compositions: counts.window_compositions,
        surface_hosts: counts.surface_hosts,
        input_registrations: counts.input_registrations,
    });
    let pointer = wanted
        .as_ref()
        .map_or(std::ptr::null(), |counts| counts as *const Counts);
    let context = Box::into_raw(Box::new(done)).cast();
    unsafe { sp_window_objects_when(pointer, seconds, counted, context) }
}
