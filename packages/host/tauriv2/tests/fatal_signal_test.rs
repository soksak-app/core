//! A fatal signal of the host after its application log is open writes an error line (docs/spec/diagnostics.md).

use std::process::{Command, Stdio};

use soksak_host_tauriv2::application_log::{application_log_path, start_application_log};

const CHILD: &str = "SOKSAK_FATAL_SIGNAL_CHILD";

// contract: log.fatal-signal.writes-an-error-line
#[test]
fn a_fatal_signal_writes_an_error_line_to_the_application_log() {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_application_log(std::path::Path::new(&config), "com.soksak.test")
        {
            println!("{error}");
            std::process::exit(2);
        }
        std::process::abort();
    }
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_fatal_signal_writes_an_error_line_to_the_application_log",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, config.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(
        output.status.signal(),
        Some(6),
        "the child ended with {:?}, output {:?}",
        output.status,
        String::from_utf8_lossy(&output.stdout)
    );
    let log = std::fs::read_to_string(application_log_path(config.path())).unwrap();
    let fatal: Vec<&str> = log
        .lines()
        .filter(|line| line.starts_with("error: fatal: "))
        .collect();
    assert_eq!(fatal, ["error: fatal: SIGABRT"], "application log {log:?}");
}
