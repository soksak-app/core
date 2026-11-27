//! The native window of the surface tests on macOS: a real window with its main webview, which the platform of the host
//! lays out. The window is created and closed on the main thread (tests/surface_fixture_test.rs).

use std::ffi::{CStr, CString, c_void};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use core_foundation::runloop::{CFRunLoop, kCFRunLoopDefaultMode};
use soksak_host::platform::{self, Platform};

unsafe extern "C" {
    fn sp_host_test_window_create_titled(
        width: f64,
        height: f64,
        window: *mut *mut c_void,
    ) -> *const std::ffi::c_char;
    fn sp_host_test_window_close(window: *mut c_void) -> *const std::ffi::c_char;
    fn sp_host_test_window_main_webview(
        window: *mut c_void,
        fixture: *const std::ffi::c_char,
        webview: *mut *mut c_void,
    ) -> *const std::ffi::c_char;
    fn sp_host_test_webview_loaded(webview: *mut c_void) -> *const std::ffi::c_char;
    fn sp_document_store_close(
        directory: *const std::ffi::c_char,
        closed: extern "C" fn(*mut c_void, *const std::ffi::c_char),
        context: *mut c_void,
    );
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

/// A real window of 500 by 400 points with its main page loaded, and the main webview of that window. The platform of the
/// host holds the main webview as the root of the window. It runs on the main thread, because the native layer does.
pub fn create_main_window() -> Result<(*mut c_void, *mut c_void), String> {
    objc2::rc::autoreleasepool(|_| {
        let platform: &'static dyn Platform = platform::current()?;
        let mut window: *mut c_void = std::ptr::null_mut();
        native_error(unsafe { sp_host_test_window_create_titled(500.0, 400.0, &mut window) })?;
        let fixture = CString::new("main-page.html").expect("the fixture name has no NUL");
        let mut main: *mut c_void = std::ptr::null_mut();
        native_error(unsafe {
            sp_host_test_window_main_webview(window, fixture.as_ptr(), &mut main)
        })?;
        // The load of the main page is delivered by the run loop of the main thread, so the wait runs on a thread of its own.
        let loaded = Arc::new(AtomicBool::new(false));
        let main_address = main as usize;
        let finished = loaded.clone();
        let wait = std::thread::spawn(move || {
            let result =
                native_error(unsafe { sp_host_test_webview_loaded(main_address as *mut c_void) });
            finished.store(true, Ordering::SeqCst);
            CFRunLoop::get_main().stop();
            result
        });
        while !loaded.load(Ordering::SeqCst) {
            CFRunLoop::run_in_mode(
                unsafe { kCFRunLoopDefaultMode },
                std::time::Duration::from_secs(10),
                false,
            );
        }
        wait.join()
            .map_err(|_| "the load wait panicked".to_string())??;
        platform.set_main_webview(window as usize, main as usize)?;
        Ok((window, main))
    })
}

/// Closes the window of create_main_window on the main thread.
pub fn close_window(window: *mut c_void) -> Result<(), String> {
    objc2::rc::autoreleasepool(|_| native_error(unsafe { sp_host_test_window_close(window) }))
}

/// The end of the data store that `end_document_store` waits for: `None` until the store ended, then its error, if any.
type StoreEnd = std::cell::RefCell<Option<Result<(), String>>>;

extern "C" fn store_ended(context: *mut c_void, error: *const std::ffi::c_char) {
    let end = unsafe { &*(context as *const StoreEnd) };
    *end.borrow_mut() = Some(if error.is_null() {
        Ok(())
    } else {
        Err(unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned())
    });
    CFRunLoop::get_main().stop();
}

/// Ends the document data store of directory on the main thread and runs the run loop until the store ended
/// (docs/spec/native-surfaces.md#document-regions). The network process of WebKit writes its caches into the directory after
/// its document closed, so the folder is removed only after the store ended.
pub fn end_document_store(directory: &str) -> Result<(), String> {
    let directory = CString::new(directory).map_err(|error| error.to_string())?;
    let end: StoreEnd = std::cell::RefCell::new(None);
    unsafe {
        sp_document_store_close(
            directory.as_ptr(),
            store_ended,
            &end as *const StoreEnd as *mut c_void,
        )
    };
    while end.borrow().is_none() {
        CFRunLoop::run_in_mode(
            unsafe { kCFRunLoopDefaultMode },
            std::time::Duration::from_secs(10),
            false,
        );
    }
    end.into_inner().expect("the store ended")
}
