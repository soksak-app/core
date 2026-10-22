//! Counts the elements and documents of a web view. The implementation is sp_webview_count_objects of native/darwin,
//! which evaluates the count in the page content world or in the content world of document regions. It is included only
//! in diagnostic builds.

use std::ffi::{CStr, c_char, c_void};

use super::super::Handle;
use crate::object_counts::PageObjects;

unsafe extern "C" {
    fn sp_webview_count_objects(
        webview: *mut c_void,
        document: bool,
        done: extern "C" fn(
            context: *mut c_void,
            elements: i64,
            documents: i64,
            error: *const c_char,
        ),
        context: *mut c_void,
    );
}

type Done = crate::object_counts::PageCountDone;

extern "C" fn counted(context: *mut c_void, elements: i64, documents: i64, error: *const c_char) {
    // context is the value that Box::into_raw made from done, and the library calls done once.
    let done = unsafe { Box::from_raw(context.cast::<Done>()) };
    let result = if error.is_null() {
        Ok(PageObjects {
            elements: elements as usize,
            documents: documents as usize,
        })
    } else {
        Err(unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned())
    };
    done(result);
}

/// Gives done the element and document counts of the web view view. Call it on the main thread.
pub fn count(view: Handle, document: bool, done: Done) {
    let context = Box::into_raw(Box::new(done)).cast();
    unsafe { sp_webview_count_objects(view as *mut c_void, document, counted, context) }
}
