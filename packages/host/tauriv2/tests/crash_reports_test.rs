//! The watch of the crash reports of the system (support/crash_reports.rs): the system writes a report into a hidden file and
//! renames it to its saved name `<application>-<time>.ips`, and the watch removes only the saved report. The same case runs in
//! the Go host.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/crash_reports.rs"]
mod crash_reports;

use std::time::Duration;

// contract: test-support.crash-reports.removes-only-the-saved-report
#[test]
fn the_watch_removes_the_saved_report_and_not_the_hidden_file_that_the_system_renames() {
    let folder = folder::Folder::new();
    let reports = crash_reports::CrashReports::watch_in(folder.path().to_path_buf(), "probe");
    let body = "{\"app_name\":\"probe\",\"bug_type\":\"309\"}\n{\n  \"pid\" : 4242\n}\n";
    let hidden = folder.path().join(".probe-2026-10-31-000000.ips");
    let saved = folder.path().join("probe-2026-10-31-000000.ips");
    std::fs::write(&hidden, body).unwrap();
    std::fs::write(&saved, body).unwrap();
    reports.remove(4242, Duration::from_secs(10));
    assert!(!saved.exists(), "the saved report {saved:?} remains");
    assert!(
        hidden.exists(),
        "the watch removed the hidden file {hidden:?}, which the system renames to the saved report"
    );
}
