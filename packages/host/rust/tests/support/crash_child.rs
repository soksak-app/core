//! Runs a child whose EXC_CRASH task exception port is serviced by the host test library
//! (native/darwin/tests/support/host_test_api.h). A handled crash exception keeps the system from writing a crash report.

use std::ffi::{CStr, CString, c_char, c_int};
use std::fs::File;
use std::os::unix::io::AsRawFd;
use std::path::Path;

unsafe extern "C" {
    fn sp_host_test_spawn_handled_crash(
        path: *const c_char,
        arguments: *const c_char,
        environment: *const c_char,
        output_fd: c_int,
        pid: *mut c_int,
        handle: *mut usize,
    ) -> *const c_char;
    fn sp_host_test_wait_handled_crash(
        handle: usize,
        status: *mut c_int,
        handled: *mut c_int,
    ) -> *const c_char;
}

/// A started child; `wait` consumes it.
pub struct Child {
    handle: usize,
}

/// The wait status of the child and the number of crash exceptions the test answered.
pub struct Outcome {
    pub status: c_int,
    pub handled: c_int,
}

fn check(message: *const c_char) {
    if !message.is_null() {
        let text = unsafe { CStr::from_ptr(message) }.to_string_lossy();
        panic!("host test library: {text}");
    }
}

/// Starts `path` with `arguments` separated by newlines and `NAME=VALUE` added to the environment; its standard output and
/// standard error go to `output`.
pub fn spawn(path: &Path, arguments: &[&str], environment: &str, output: &File) -> Child {
    let path = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    let arguments = CString::new(arguments.join("\n")).unwrap();
    let environment = CString::new(environment).unwrap();
    let mut pid: c_int = 0;
    let mut handle: usize = 0;
    check(unsafe {
        sp_host_test_spawn_handled_crash(
            path.as_ptr(),
            arguments.as_ptr(),
            environment.as_ptr(),
            output.as_raw_fd(),
            &mut pid,
            &mut handle,
        )
    });
    Child { handle }
}

/// Waits for the child to end and joins the crash exception service.
pub fn wait(child: Child) -> Outcome {
    let mut status: c_int = 0;
    let mut handled: c_int = 0;
    check(unsafe { sp_host_test_wait_handled_crash(child.handle, &mut status, &mut handled) });
    Outcome { status, handled }
}
