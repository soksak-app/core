//! Checks the Unix privacy modes of event-log and process-lock files.

#![cfg(target_os = "macos")]

#[path = "../../support/folder.rs"]
mod folder;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use folder::Folder;
use soksak_sok::event_log::{EventLog, Level, Options};
use soksak_sok::platform;

fn options(directory: &Path) -> Options {
    Options {
        directory: directory.to_path_buf(),
        role: "probe".into(),
        boot: "private-files".into(),
        layer: "sok",
        clock: || 42,
        spawn: |body| {
            std::thread::Builder::new()
                .name("private-file-writer".into())
                .spawn(body)
                .map_err(|error| error.to_string())
        },
        queue_events: 64,
        queue_bytes: 1 << 20,
        batch_interval: Duration::from_millis(10),
        rotate_bytes: 1 << 20,
        pull: None,
        policy_path: None,
        prune: None,
    }
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path)
        .expect("file metadata")
        .permissions()
        .mode()
        & 0o777
}

// contract: log.writer.files-are-private
#[test]
fn event_log_enforces_private_directory_and_file_modes() {
    let folder = Folder::new("event-log-private");
    let directory = folder.path().join("logs");
    std::fs::create_dir(&directory).expect("create existing logs directory");
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o750))
        .expect("set existing logs directory mode");

    let log = EventLog::start(options(&directory)).expect("start event log");
    assert_eq!(mode(&directory), 0o700, "the logs directory is private");
    assert_eq!(mode(log.path()), 0o600, "the event file is private");
    assert!(log.emit(Level::Debug, "sok.private.probe", &serde_json::json!({})));
    log.flush(Duration::from_secs(5))
        .expect("flush debug event");
    assert_eq!(mode(log.debug_path()), 0o600, "the debug file is private");
    log.close();
}

// contract: log.writer.files-are-private
#[test]
fn event_log_creates_missing_directory_privately() {
    let folder = Folder::new("event-log-private-created");
    let directory = folder.path().join("nested/logs");
    let log = EventLog::start(options(&directory)).expect("start event log");
    assert_eq!(mode(&directory), 0o700, "a new logs directory is private");
    assert_eq!(mode(log.path()), 0o600, "a new event file is private");
    log.close();
}

// contract: platform.private.creates-new-owner-only-file
#[test]
fn a_new_process_lock_file_is_private() {
    let folder = Folder::new("process-lock-private");
    let path = folder.path().join("process.lock");
    let file = platform::current()
        .expect("select platform")
        .open_process_lock_file(&path)
        .expect("create process lock");
    assert_eq!(mode(&path), 0o600, "the process lock file is private");
    drop(file);
}
