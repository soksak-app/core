//! A fatal signal of the host after its standard error file is open writes an error line (docs/spec/diagnostics.md).

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

#[path = "support/crash_child.rs"]
mod crash_child;

use soksak_host::application_log::start_standard_error;

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
    let copies = folder::Folder::new();
    let output = std::fs::File::create(copies.path().join("output")).unwrap();
    let child = crash_child::spawn(
        &std::env::current_exe().unwrap(),
        &[
            "--exact",
            "a_fatal_signal_writes_an_error_line_to_the_standard_error_file",
            "--nocapture",
            "--test-threads=1",
        ],
        &format!("{CHILD}={}", config.path().display()),
        &output,
    );
    let outcome = crash_child::wait(child);
    use std::os::unix::process::ExitStatusExt;
    // The handled crash exception keeps the system from writing a crash report; the wait status still ends with SIGABRT.
    assert_eq!(
        (
            outcome.handled,
            std::process::ExitStatus::from_raw(outcome.status).signal()
        ),
        (1, Some(6)),
        "the child ended with wait status {:#x}, output {:?}",
        outcome.status,
        std::fs::read_to_string(copies.path().join("output")).unwrap_or_default()
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
