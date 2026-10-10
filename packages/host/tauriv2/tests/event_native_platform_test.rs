//! The pull of the native ring through the platform (docs/spec/logging.md#writers): the host writer starts with the pull of
//! the platform, and an empty ring yields no record and no loss.

use std::time::Duration;

use soksak_host_tauriv2::event_log::EventLog;
use soksak_host_tauriv2::platform;

// contract: log.native.platform-pulls-the-ring
#[test]
fn the_platform_pulls_an_empty_native_ring_as_zero_bytes_and_no_loss() {
    let system = platform::current().unwrap();
    let mut buffer = vec![0u8; 4096];
    assert_eq!(system.pull_native_events(&mut buffer), Ok(0));
    assert_eq!(system.take_native_event_loss(), Ok((0, 0)));
    assert!(system.pull_native_events(&mut []).is_err());
}

// contract: log.native.host-writer-starts-with-the-platform-pull
#[test]
fn the_host_writer_starts_with_the_pull_of_the_platform() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start_host(directory.path()).unwrap();
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].contains("\"event\":\"log.open\""), "{}", lines[0]);
}
