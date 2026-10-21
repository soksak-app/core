//! The panic hook of the host records a panic as the event `host.panic` without waiting for the writer on the panicking
//! thread, which can be the thread of the interface (docs/spec/hosts.md#process-lifecycle).

#[path = "support/folder.rs"]
mod folder;

use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::application_log::{
    install_panic_hook, install_panic_hook_with_writer_deadline, start_standard_error,
};
use soksak_host_tauriv2::event_log::{self, Options};
use soksak_host_tauriv2::event_record::use_host_event_log;

const CHILD: &str = "SOKSAK_PANIC_HOOK_CHILD";

/// The longest the panicking thread may spend in the hook while the writer is stalled; waiting for the writer takes the
/// whole flush deadline of 2 s.
// The hook that waited for the stalled writer held the thread for its bounded wait of two seconds (docs/spec/hosts.md); the bound is
// below that wait and above the time that building a backtrace takes on a loaded machine (606 ms was measured under a load average of 30).
const HOOK_BOUND: Duration = Duration::from_millis(1500);

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
        let release = Arc::new(AtomicBool::new(false));
        let stalled = Arc::clone(&release);
        let log = event_log::start(Options {
            directory: config.join("logs"),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 64,
            queue_bytes: 64 * 1024,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: Some(Box::new(move |_| {
                while !stalled.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(0)
            })),
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap();
        records::store_every_level(&log);
        use_host_event_log(Some(Arc::new(log)));
        let started = Instant::now();
        let ended = std::panic::catch_unwind(|| panic!("the window has no content view"));
        assert!(ended.is_err());
        // The harness has printed the name of the test without a line feed, so the value starts its own line.
        println!("\nhook_ms={}", started.elapsed().as_millis());
        release.store(true, Ordering::SeqCst);
        // The record ends the process once the writer stored it; reaching the end of the wait is the failure.
        std::thread::sleep(Duration::from_secs(10));
        std::process::exit(4);
    }
    let config = folder::Folder::new();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_panic_hook_does_not_wait_for_the_writer_and_the_record_is_stored_before_the_process_ends",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, config.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        output.status.code(),
        Some(101),
        "child output {stdout:?} {:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let hook_ms: u128 = stdout
        .lines()
        .find_map(|line| line.strip_prefix("hook_ms="))
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| panic!("the child printed no hook time: {stdout:?}"));
    assert!(
        hook_ms < HOOK_BOUND.as_millis(),
        "the hook held the panicking thread for {hook_ms} ms while the writer was stalled"
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
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap();
        use_host_event_log(Some(Arc::new(log)));
        // The record ends the process with PANIC_STATUS once the writer stored it; reaching the end of the wait is the failure.
        std::thread::sleep(Duration::from_secs(10));
        std::process::exit(4);
    }
    let config = folder::Folder::new();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_panic_before_the_writer_exists_is_stored_when_the_writer_opens",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(BEFORE_WRITER_CHILD, config.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
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
    if std::env::var_os(NO_WRITER_CHILD).is_some() {
        // The writer never opens in this process; the thread that ends the process gives up after the short deadline.
        install_panic_hook_with_writer_deadline(Duration::from_millis(100));
        let ended = std::panic::catch_unwind(|| panic!("the lock directory cannot be read"));
        assert!(ended.is_err());
        // The writer never opens, so the process ends by the bounded wait; reaching the end of the wait is the failure.
        std::thread::sleep(Duration::from_secs(10));
        std::process::exit(4);
    }
    let started = Instant::now();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_panic_that_no_writer_stores_is_written_to_the_standard_error_in_full",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(NO_WRITER_CHILD, "1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "the child ended after {elapsed:?}; the writer deadline of the test must not be waited in real time"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(101), "stderr {stderr:?}");
    assert!(
        stderr.contains("no writer opened within")
            && stderr.contains("host.panic name=")
            && stderr.contains("text=")
            && stderr.contains("the lock directory cannot be read"),
        "the standard error does not hold the record of the panic: {stderr:?}"
    );
}
