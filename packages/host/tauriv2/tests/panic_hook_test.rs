//! A panic of the host after its application log is open writes an error line (docs/spec/diagnostics.md).

use std::process::{Command, Stdio};

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::application_log::start_standard_error;

const CHILD: &str = "SOKSAK_PANIC_HOOK_CHILD";

// contract: log.panic.writes-an-error-line
#[test]
fn a_panic_writes_an_error_event_to_the_event_log() {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_standard_error(std::path::Path::new(&config), "com.soksak.test") {
            println!("{error}");
            std::process::exit(2);
        }
        let _writer = records::start_writer(std::path::Path::new(&config));
        let ended = std::thread::spawn(|| panic!("the window has no content view")).join();
        assert!(ended.is_err());
        // The process ends at once, as it does after a panic with panic = abort: the record is stored only when the hook
        // flushed the writer.
        std::process::exit(0);
    }
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_panic_writes_an_error_event_to_the_event_log",
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
    let log = records::text_of(&records::read_events(&records::event_log_path(
        config.path(),
    )));
    let errors: Vec<&str> = log
        .lines()
        .filter(|line| line.contains(" error host panic: "))
        .collect();
    assert!(
        errors.len() == 1
            && errors[0].contains("panic_hook_test.rs:")
            && errors[0].ends_with(": the window has no content view"),
        "event log {log:?}"
    );
}
