//! A panic of the host after its application log is open writes an error line (docs/spec/diagnostics.md).

use std::process::{Command, Stdio};

use soksak_host_tauriv2::application_log::{application_log_path, start_application_log};

const CHILD: &str = "SOKSAK_PANIC_HOOK_CHILD";

// contract: log.panic.writes-an-error-line
#[test]
fn a_panic_writes_an_error_line_to_the_application_log() {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_application_log(std::path::Path::new(&config), "com.soksak.test")
        {
            println!("{error}");
            std::process::exit(2);
        }
        let ended = std::thread::spawn(|| panic!("the window has no content view")).join();
        assert!(ended.is_err());
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_panic_writes_an_error_line_to_the_application_log",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, config.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}, output {:?}",
        output.status,
        String::from_utf8_lossy(&output.stdout)
    );
    let log = std::fs::read_to_string(application_log_path(config.path())).unwrap();
    let errors: Vec<&str> = log
        .lines()
        .filter(|line| line.starts_with("error: panic: "))
        .collect();
    assert!(
        errors.len() == 1
            && errors[0].contains("panic_hook_test.rs:")
            && errors[0].ends_with(": the window has no content view"),
        "application log {log:?}"
    );
}
