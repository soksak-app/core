// The rasterprobe service: the fake persistent sidecar of the core window checks. It holds sessions of surfaces, each with one
// child process, and draws frames into the image region of its surface (see service.rs for its requests).
//
//     sok-rasterprobe --service-dir <dir> [--log-dir <dir>]   the service that the host starts (docs/spec/persistent-services.md)
//     sok-rasterprobe --session <id>                           the child process of one session: it ends when its input ends
mod events;
mod iosurface;
mod raster;
mod server;
mod service;

use std::ffi::{CString, c_char};
use std::io::Read;
use std::path::PathBuf;

unsafe extern "C" {
    fn soksak_process_set_display_name(display_name: *const c_char, error: *mut c_char, error_capacity: usize) -> i32;
}

/// The version of package.json and the displayName of sidecar.json, embedded at build time.
pub const VERSION: &str = env!("RASTERPROBE_VERSION");
const DISPLAY_NAME: &str = env!("RASTERPROBE_DISPLAY_NAME");

fn fail(text: &str) -> ! {
    events::record("error", "start", text);
    std::process::exit(1);
}

/// Registers the declared display name of the sidecar before the service starts (docs/spec/process-identity.md).
fn set_display_name() {
    let name = CString::new(DISPLAY_NAME).expect("the display name holds no NUL");
    let mut error = [0 as c_char; 512];
    // SAFETY: the name is NUL-terminated and the error buffer has the capacity passed.
    let status = unsafe { soksak_process_set_display_name(name.as_ptr(), error.as_mut_ptr(), error.len()) };
    if status != 0 {
        // SAFETY: the function writes a NUL-terminated diagnostic into the buffer on failure.
        let text = unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) }.to_string_lossy().into_owned();
        fail(&format!("display name {DISPLAY_NAME}: {text}"));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--session") {
        // A session process holds nothing but its input: the service closes the input to end it, and the end of the service
        // ends it as well.
        let mut sink = Vec::new();
        // A failed read ends the session as the end of its input does.
        let _ = std::io::stdin().read_to_end(&mut sink);
        return;
    }
    let mut service_dir = None;
    let mut log_dir = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--service-dir" => service_dir = rest.next().map(PathBuf::from),
            "--log-dir" => log_dir = rest.next().map(PathBuf::from),
            other => fail(&format!("unknown argument {other}")),
        }
    }
    let Some(service_dir) = service_dir else { fail("--service-dir is required") };
    set_display_name();
    if let Err(error) = server::run(&service_dir, log_dir) {
        fail(&error);
    }
}
