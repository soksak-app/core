//! Checks that unsupported private-file operations fail with the affected path.

#![cfg(windows)]

#[path = "../../support/folder.rs"]
mod folder;

use folder::Folder;
use soksak_sok::platform;

#[test]
fn private_file_operations_report_unsupported_paths() {
    let folder = Folder::new("private-files-unsupported");
    let logs = folder.path().join("logs");
    let event = logs.join("sok-boot.jsonl");
    let process_lock = folder.path().join("process.lock");
    let platform = platform::current().expect("select platform");

    assert_eq!(
        platform.prepare_log_directory(&logs).unwrap_err(),
        format!(
            "event log directory {} is not implemented on windows",
            logs.display()
        )
    );
    assert_eq!(
        platform.create_log_file(&event).unwrap_err(),
        format!(
            "event log file {} is not implemented on windows",
            event.display()
        )
    );
    assert_eq!(
        platform.append_log_file(&event).unwrap_err(),
        format!(
            "event log file {} is not implemented on windows",
            event.display()
        )
    );
    assert_eq!(
        platform.open_process_lock_file(&process_lock).unwrap_err(),
        format!(
            "process lock file {} is not implemented on windows",
            process_lock.display()
        )
    );
    assert!(
        !logs.exists(),
        "the unsupported operation created the logs directory"
    );
    assert!(
        !process_lock.exists(),
        "the unsupported operation created the lock file"
    );
}
