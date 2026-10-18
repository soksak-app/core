//! A fatal signal of the host after its standard error file is open writes an error line (docs/spec/diagnostics.md).

#[path = "support/folder.rs"]
mod folder;

use std::process::{Command, Stdio};

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::application_log::start_standard_error;

const CHILD: &str = "SOKSAK_FATAL_SIGNAL_CHILD";

// contract: log.fatal-signal.writes-an-error-line
#[test]
fn a_fatal_signal_writes_an_error_line_to_the_standard_error_file() {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_standard_error(std::path::Path::new(&config), "com.soksak.test") {
            println!("{error}");
            std::process::exit(2);
        }
        std::process::abort();
    }
    let config = folder::Folder::new();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_fatal_signal_writes_an_error_line_to_the_standard_error_file",
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
    let log = records::standard_error_text(config.path());
    // A record is `<time> <level> <layer> <where>: <text>`; the fatal record of the native library has no other text.
    let fatal: Vec<&str> = log
        .lines()
        .filter(|line| line.contains(" error native fatal: "))
        .map(|line| line.split_once(' ').expect("a time and a record").1)
        .collect();
    assert_eq!(
        fatal,
        ["error native fatal: SIGABRT"],
        "standard error file {log:?}"
    );
}
