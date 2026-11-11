//! Replaces the standard error of the process with an open file (docs/spec/hosts.md#application-log).

use std::os::fd::AsRawFd;

pub fn replace(file: &std::fs::File) -> Result<(), String> {
    // SAFETY: file is an open descriptor, and dup2 replaces the standard error descriptor with a duplicate of it.
    if unsafe { libc::dup2(file.as_raw_fd(), libc::STDERR_FILENO) } < 0 {
        return Err(format!(
            "replace standard error: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// Installs the fatal signal and uncaught exception handlers of the native library (application_log.h).
pub fn install_fatal_handlers() {
    unsafe extern "C" {
        fn sp_log_install_fatal_handlers();
    }
    // SAFETY: the native function installs process-wide handlers and takes no arguments.
    unsafe { sp_log_install_fatal_handlers() }
}

/// Runs body and ends the process when an Objective-C exception leaves it, as an uncaught exception ends it: the native library
/// writes the record of the exception and aborts. Rust stops such an exception at the start of its thread with an abort whose
/// record names only `SIGABRT`, and the uncaught exception handler never runs (docs/spec/diagnostics.md). A panic of body
/// passes through unchanged.
pub fn end_on_exception<T>(body: impl FnOnce() -> T) -> T {
    unsafe extern "C" {
        fn sp_log_fatal_exception(exception: *mut objc2::runtime::AnyObject) -> !;
    }
    match objc2::exception::catch(std::panic::AssertUnwindSafe(body)) {
        Ok(value) => value,
        Err(exception) => {
            let thrown = exception
                .as_deref()
                .map_or(std::ptr::null_mut(), |exception| {
                    let object: &objc2::runtime::AnyObject = exception;
                    std::ptr::from_ref(object).cast_mut()
                });
            // SAFETY: thrown is the exception that was caught, which `exception` keeps alive, or NULL for `@throw nil`; the
            // native function writes its record and aborts.
            unsafe { sp_log_fatal_exception(thrown) }
        }
    }
}
