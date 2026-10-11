//! The panic hook of the host records a panic as the event `host.panic` without waiting for the writer on the panicking
//! thread, which can be the thread of the interface (docs/spec/hosts.md#process-lifecycle).

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::application_log::start_standard_error;
use soksak_host_tauriv2::event_log::{EventLog, Options};
use soksak_host_tauriv2::event_record::use_host_event_log;

const CHILD: &str = "SOKSAK_PANIC_HOOK_CHILD";

/// The longest the panicking thread may spend in the hook while the writer is stalled; waiting for the writer takes the
/// whole flush deadline of 2 s.
const HOOK_BOUND: Duration = Duration::from_millis(500);

// contract: log.panic.does-not-wait-for-the-writer
#[test]
fn the_panic_hook_does_not_wait_for_the_writer_and_the_record_is_stored_before_the_process_ends() {
    if let Some(config) = std::env::var_os(CHILD) {
        let config = std::path::Path::new(&config);
        if let Err(error) = start_standard_error(config, "com.soksak.test") {
            println!("{error}");
            std::process::exit(3);
        }
        // The pull runs on the writer thread, so a pull that waits stalls the writer until the test releases it.
        let release = Arc::new(AtomicBool::new(false));
        let stalled = Arc::clone(&release);
        let log = EventLog::start(Options {
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
    let config = tempfile::tempdir().unwrap();
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
