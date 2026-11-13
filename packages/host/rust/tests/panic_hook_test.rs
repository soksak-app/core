//! The panic hook of the host records a panic as the event `host.panic` without waiting for the writer on the panicking
//! thread, which can be the thread of the interface (docs/spec/hosts.md#process-lifecycle).

#[path = "support/child.rs"]
mod child;
#[path = "support/folder.rs"]
mod folder;

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

#[path = "support/records.rs"]
mod records;

use soksak_host::application_log::{install_panic_hook, start_standard_error};
use soksak_host::event_log::{self, Options};
use soksak_host::event_record::use_host_event_log;
use soksak_host::routine::notify_start_ended;

const CHILD: &str = "SOKSAK_PANIC_HOOK_CHILD";

// contract: log.panic.does-not-wait-for-the-writer
#[test]
fn the_panic_hook_does_not_wait_for_the_writer_and_the_record_is_stored_before_the_process_ends() {
    if let Some(config) = std::env::var_os(CHILD) {
        let config = std::path::Path::new(&config);
        // The process start of the host installs the hook first (docs/spec/hosts.md#process-lifecycle).
        install_panic_hook();
        if let Err(error) = start_standard_error(config, "com.soksak.test") {
            println!("{error}");
            std::process::exit(3);
        }
        // The pull runs on the writer thread, so a pull that waits stalls the writer until the test releases it.
        let (release, stalled) = mpsc::channel::<()>();
        let stalled = Mutex::new(stalled);
        let log = event_log::start(Options {
            directory: config.join("logs"),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 64,
            queue_bytes: 64 * 1024,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: Some(Box::new(move |_| {
                // The first pull waits for the release; the end of the channel lets the later pulls through.
                stalled.lock().unwrap().recv().ok();
                Ok(0)
            })),
            pull_loss: None,
            wake: Some(Box::new(|_| Ok(()))),
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap();
        records::set_every_level(&log);
        use_host_event_log(Some(Arc::new(log)));
        // The writer stays stalled until the hook returned, so a hook that waited for the writer to store the record would not
        // return. The time of the hook is a measurement, which the child prints and the check does not judge.
        let started = Instant::now();
        let ended = std::panic::catch_unwind(|| panic!("the window has no content view"));
        assert!(ended.is_err());
        // The harness has printed the name of the test without a line feed, so the value starts its own line.
        println!("\nhook_ms={}", started.elapsed().as_millis());
        drop(release);
        // The record ends the process once the writer stored it; the child waits for the end of its input until then.
        child::wait_for_end();
    }
    let config = folder::Folder::new();
    let output = child::output_with_open_input(
        Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_panic_hook_does_not_wait_for_the_writer_and_the_record_is_stored_before_the_process_ends",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, config.path()),
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        output.status.code(),
        Some(101),
        "child output {stdout:?} {:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.lines().any(|line| line.starts_with("hook_ms=")),
        "the hook did not return while the writer was stalled: {stdout:?}"
    );
    let events = records::read_events(&records::event_log_path(config.path()));
    let panics: Vec<&serde_json::Value> = events
        .iter()
        .filter(|event| event["event"] == "host.panic")
        .collect();
    assert!(
        panics.len() == 1
            && panics[0]["fields"]["text"]
                .as_str()
                .is_some_and(|text| text.ends_with(": the window has no content view"))
            && panics[0]["fields"]["name"]
                .as_str()
                .is_some_and(|name| !name.is_empty()),
        "events {events:?}"
    );
}

const BEFORE_WRITER_CHILD: &str = "SOKSAK_PANIC_BEFORE_WRITER_CHILD";

// contract: log.panic.before-writer-is-stored-when-the-writer-opens
#[test]
fn a_panic_before_the_writer_exists_is_stored_when_the_writer_opens() {
    if let Some(config) = std::env::var_os(BEFORE_WRITER_CHILD) {
        let config = std::path::Path::new(&config);
        // The process start of the host installs the hook first, before any writer exists; this child mirrors that order.
        install_panic_hook();
        let ended = std::panic::catch_unwind(|| panic!("the lock directory cannot be read"));
        assert!(ended.is_err());
        let log = event_log::start(Options {
            directory: config.join("logs"),
            role: "host".into(),
            boot: "b2".into(),
            queue_events: 64,
            queue_bytes: 64 * 1024,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            wake: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap();
        use_host_event_log(Some(Arc::new(log)));
        // The record ends the process with PANIC_STATUS once the writer stored it; the child waits for the end of its input
        // until then.
        child::wait_for_end();
    }
    let config = folder::Folder::new();
    let output = child::output_with_open_input(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "a_panic_before_the_writer_exists_is_stored_when_the_writer_opens",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(BEFORE_WRITER_CHILD, config.path()),
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        output.status.code(),
        Some(101),
        "child output {stdout:?} {:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let events = records::read_events(&records::event_log_path(config.path()));
    let panics: Vec<&serde_json::Value> = events
        .iter()
        .filter(|event| event["event"] == "host.panic")
        .collect();
    assert!(
        panics.len() == 1
            && panics[0]["fields"]["text"]
                .as_str()
                .is_some_and(|text| text.ends_with(": the lock directory cannot be read")),
        "events {events:?}"
    );
}

const NO_WRITER_CHILD: &str = "SOKSAK_PANIC_NO_WRITER_CHILD";

// contract: log.panic.without-writer-is-written-to-the-standard-error
#[test]
fn a_panic_that_no_writer_stores_is_written_to_the_standard_error_in_full() {
    if let Some(order) = std::env::var_os(NO_WRITER_CHILD) {
        // No writer opens in this process. The start of the host ends without attaching one, before or after the panic, and
        // that end ends the wait of the thread that ends the process.
        install_panic_hook();
        if order == "start-ended-first" {
            notify_start_ended();
        }
        let ended = std::panic::catch_unwind(|| panic!("the lock directory cannot be read"));
        assert!(ended.is_err());
        if order == "panic-first" {
            notify_start_ended();
        }
        // The thread that ends the process ends it; reaching the end of the wait is the failure.
        loop {
            std::thread::park();
        }
    }
    for order in ["panic-first", "start-ended-first"] {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "a_panic_that_no_writer_stores_is_written_to_the_standard_error_in_full",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(NO_WRITER_CHILD, order)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(
            output.status.code(),
            Some(101),
            "{order}: stderr {stderr:?}"
        );
        assert!(
            stderr.contains(
                "the record of the panic is not stored: the start of the host ended without a writer"
            ) && stderr.contains("host.panic name=")
                && stderr.contains("text=")
                && stderr.contains("the lock directory cannot be read"),
            "{order}: the standard error does not hold the record of the panic: {stderr:?}"
        );
    }
}
