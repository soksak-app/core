//! The start of a host ends no process of another application.

#[path = "support/folder.rs"]
mod folder;

use std::os::unix::process::{CommandExt, ExitStatusExt};

/// The start of a host ends no process: a WebKit process of another application, listed in the record file that an
/// earlier run of the host wrote with the host of that run ended, stays alive after the configuration directory is
/// prepared. macOS ends the WebKit services of a host when the host ends, so the host keeps no record of them
/// (docs/spec/hosts.md).
// contract: startup.ends-no-process
#[test]
fn the_start_ends_no_process_of_another_application() {
    // The record of an earlier run named each child with its start time in the form of ps lstart.
    let lstart = local_time("%a %b %e %H:%M:%S %Y");
    let mut foreign = std::process::Command::new("/bin/sleep")
        .arg0("com.apple.WebKit.Networking")
        .arg("30")
        .spawn()
        .unwrap();
    let mut ended = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    ended.wait().unwrap();
    let pid = foreign.id();
    let config = folder::Folder::new();
    std::fs::write(
        config.path().join("webkit-children.json"),
        serde_json::json!({"host_pid": ended.id(), "children": [{"pid": pid, "kind": "Networking",
            "lstart": lstart}]})
        .to_string(),
    )
    .unwrap();
    soksak_host::workspace::prepare_config_directory(config.path(), |_| Ok(())).unwrap();
    // The process ends only by a signal. The test sends SIGKILL now, so the wait status names SIGKILL unless the start sent
    // an earlier signal that ended it.
    foreign.kill().unwrap();
    let status = foreign.wait().unwrap();
    assert_eq!(
        status.signal(),
        Some(libc::SIGKILL),
        "the start ended process {pid} of another application (wait status {status})"
    );
}

/// The current local time in the strftime format `format`. The standard library has no local time, so libc formats it.
fn local_time(format: &str) -> String {
    let now = unsafe { libc::time(std::ptr::null_mut()) };
    let mut parts: libc::tm = unsafe { std::mem::zeroed() };
    assert!(
        !unsafe { libc::localtime_r(&now, &mut parts) }.is_null(),
        "localtime_r: {}",
        std::io::Error::last_os_error()
    );
    let format = std::ffi::CString::new(format).unwrap();
    let mut buffer = [0u8; 64];
    let length = unsafe {
        libc::strftime(
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            format.as_ptr(),
            &parts,
        )
    };
    assert!(length > 0, "strftime wrote nothing");
    String::from_utf8_lossy(&buffer[..length]).into_owned()
}
