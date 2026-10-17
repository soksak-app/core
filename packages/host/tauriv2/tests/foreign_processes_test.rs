//! The start of a host ends no process of another application.

use std::os::unix::process::CommandExt;

/// The start of a host ends no process: a WebKit process of another application, listed in the record file that an
/// earlier run of the host wrote with the host of that run ended, stays alive after the configuration directory is
/// prepared. macOS ends the WebKit services of a host when the host ends, so the host keeps no record of them
/// (docs/spec/hosts.md).
// contract: startup.ends-no-process
#[test]
fn the_start_ends_no_process_of_another_application() {
    let mut foreign = std::process::Command::new("/bin/sleep")
        .arg0("com.apple.WebKit.Networking")
        .arg("30")
        .spawn()
        .unwrap();
    let mut ended = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    ended.wait().unwrap();
    let pid = foreign.id();
    let lstart = std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let config = tempfile::tempdir().unwrap();
    std::fs::write(
        config.path().join("webkit-children.json"),
        serde_json::json!({"host_pid": ended.id(), "children": [{"pid": pid, "kind": "Networking",
            "lstart": String::from_utf8_lossy(&lstart.stdout).trim()}]})
        .to_string(),
    )
    .unwrap();
    soksak_host_tauriv2::workspace::prepare_config_directory(config.path(), |_| Ok(())).unwrap();
    let state = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&state.stdout).trim().to_string();
    foreign.kill().unwrap();
    foreign.wait().unwrap();
    assert!(
        !state.is_empty() && !state.starts_with('Z'),
        "the start ended process {pid} of another application (state {state:?})"
    );
}
