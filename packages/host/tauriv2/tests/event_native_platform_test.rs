//! The pull of the native ring through the platform (docs/spec/logging.md#writers): the host writer starts with the pull of
//! the platform, and an empty ring yields no record and no loss.

#[path = "support/folder.rs"]
mod folder;

use std::sync::Mutex;
use std::time::Duration;

use soksak_host_tauriv2::event_log;
use soksak_host_tauriv2::platform;

/// The native ring, its policy and the activity observers belong to the process, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

// contract: log.native.platform-pulls-the-ring
#[test]
fn the_platform_pulls_an_empty_native_ring_as_zero_bytes_and_no_loss() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let system = platform::current().unwrap();
    let mut buffer = vec![0u8; 4096];
    // The activity observers that an earlier test of this process installed store events into the ring; the ring is emptied
    // first, so the pull below reads an empty ring.
    while system.pull_native_events(&mut buffer).unwrap() > 0 {}
    for channel in 0..2 {
        system.take_native_event_loss(channel).unwrap();
    }
    assert_eq!(system.pull_native_events(&mut buffer), Ok(0));
    for channel in 0..2 {
        assert_eq!(system.take_native_event_loss(channel), Ok((0, 0)));
    }
    assert!(system.pull_native_events(&mut []).is_err());
}

// contract: log.native.platform-reads-the-clock-and-takes-the-boot
#[test]
fn the_platform_reads_a_monotonic_clock_and_takes_the_boot_identifier() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let system = platform::current().unwrap();
    let first = system.monotonic_ns().unwrap();
    std::thread::sleep(Duration::from_millis(5));
    let second = system.monotonic_ns().unwrap();
    assert!(first > 0 && second >= first + 4_000_000, "{first} {second}");
    assert!(system.set_event_boot("b1-7_x").is_ok());
    for bad in ["", "a,b", "a\"b", "a.b", &"x".repeat(65)] {
        assert!(system.set_event_boot(bad).is_err(), "{bad:?} was accepted");
    }
}

// contract: log.native.platform-takes-the-policy
#[test]
fn the_platform_takes_the_policy_of_the_native_library_and_refuses_a_level_outside_the_enumeration()
{
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let system = platform::current().unwrap();
    assert!(system.set_native_event_policy([4, 3, 2, -1, 0]).is_ok());
    for bad in [[4, 4, 4, 4, 5], [-2, 4, 4, 4, 4]] {
        assert!(
            system.set_native_event_policy(bad).is_err(),
            "{bad:?} was accepted"
        );
    }
    system.set_native_event_policy([4, 4, 4, 4, 4]).unwrap();
}

// contract: log.native.host-writer-starts-with-the-platform-pull
#[test]
fn the_host_writer_starts_with_the_pull_of_the_platform() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let directory = folder::Folder::new();
    let log = event_log::start_host(directory.path()).unwrap();
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[0].contains("\"event\":\"log.open\""), "{}", lines[0]);
    // The activity observers that the writer installs store native events after log.open and nothing else follows.
    assert!(
        lines[1..]
            .iter()
            .all(|line| line.contains("\"layer\":\"native\"")),
        "{lines:?}"
    );
}

// contract: log.native.shutdown-flushes-the-observers-before-the-writer
#[test]
fn the_shutdown_flushes_the_native_observers_before_the_writer_flush() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let directory = folder::Folder::new();
    let log = event_log::start_host(directory.path()).unwrap();
    let mut flushed = false;
    let result = event_log::flush_event_log(
        &log,
        || {
            flushed = true;
            // The flush of the observers stores the tail of a counted source; the writer flush that follows writes it.
            log.emit(
                event_log::Level::Info,
                "host.test.observer_tail",
                &serde_json::json!({"count": 3}),
            );
            Ok(())
        },
        Duration::from_secs(5),
    );
    assert_eq!(result, Ok(()));
    assert!(flushed);
    let text = std::fs::read_to_string(log.path()).unwrap();
    assert!(
        text.contains("\"event\":\"host.test.observer_tail\""),
        "{text}"
    );
}

// contract: log.native.shutdown-reports-a-failed-observer-flush
#[test]
fn the_shutdown_reports_a_failed_observer_flush_and_still_flushes_the_writer() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let directory = folder::Folder::new();
    let log = event_log::start_host(directory.path()).unwrap();
    log.emit(
        event_log::Level::Info,
        "host.test.before_failure",
        &serde_json::json!({}),
    );
    let error = event_log::flush_event_log(
        &log,
        || Err("refused by the platform".to_string()),
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(
        error.contains("native observers") && error.contains("refused by the platform"),
        "{error}"
    );
    let text = std::fs::read_to_string(log.path()).unwrap();
    assert!(
        text.contains("\"event\":\"host.test.before_failure\""),
        "{text}"
    );
}

// contract: log.native.platform-flushes-the-observers
#[test]
fn the_platform_flushes_the_native_observers_without_an_error() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let system = platform::current().unwrap();
    assert_eq!(system.flush_native_observers(), Ok(()));
}
