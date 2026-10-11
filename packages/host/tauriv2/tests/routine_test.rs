//! The entrance of the threads of the host (docs/spec/hosts.md#process-lifecycle): a panic of a thread that started through
//! `spawn_named` is the event `host.panic` in the event log before the process ends with status 101.

use std::process::{Command, Stdio};

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::application_log::start_standard_error;
use soksak_host_tauriv2::routine::spawn_named;

const CHILD: &str = "SOKSAK_ROUTINE_CHILD";

// contract: log.panic.records-an-event
#[test]
fn a_panic_of_a_thread_is_recorded_as_an_event_before_the_process_ends() {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_standard_error(std::path::Path::new(&config), "com.soksak.test") {
            println!("{error}");
            std::process::exit(3);
        }
        let _writer = records::start_writer(std::path::Path::new(&config));
        let _ = spawn_named("probe", || panic!("the window has no content view")).join();
        // The entrance ends the process; reaching the end of the wait is the failure.
        std::thread::sleep(std::time::Duration::from_secs(10));
        std::process::exit(4);
    }
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_panic_of_a_thread_is_recorded_as_an_event_before_the_process_ends",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, config.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(101),
        "child output {:?} {:?}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let events = records::read_events(&records::event_log_path(config.path()));
    let panics: Vec<&serde_json::Value> = events
        .iter()
        .filter(|event| event["event"] == "host.panic")
        .collect();
    assert_eq!(panics.len(), 1, "events {events:?}");
    let fields = &panics[0]["fields"];
    assert!(
        panics[0]["level"] == "error"
            && fields["name"] == "probe"
            && fields["text"]
                .as_str()
                .is_some_and(|text| text.ends_with(": the window has no content view"))
            && fields["stack"]
                .as_str()
                .is_some_and(|stack| stack.contains("routine_test")),
        "host.panic event {:?}",
        panics[0]
    );
}
