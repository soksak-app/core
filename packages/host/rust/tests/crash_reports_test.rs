//! The watch of the crash reports of the system (support/crash_reports.rs): the system writes a report into a hidden file and
//! renames it to its saved name `<application>-<time>.ips`, and the watch removes only the saved report. The same case runs in
//! the Go host.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/crash_reports.rs"]
mod crash_reports;

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
    reports.remove(4242);
    assert!(!saved.exists(), "the saved report {saved:?} remains");
    assert!(
        hidden.exists(),
        "the watch removed the hidden file {hidden:?}, which the system renames to the saved report"
    );
}

// contract: test-support.crash-reports.child-runs-under-a-name-of-its-run
#[test]
fn a_crashing_child_runs_a_copy_of_the_test_executable_under_a_name_of_its_run() {
    use std::os::unix::fs::PermissionsExt;
    let folder = folder::Folder::new();
    let executable = std::env::current_exe().unwrap();
    let expected = std::fs::metadata(&executable).unwrap().len();
    let first = crash_reports::crashing_executable(folder.path());
    let second = crash_reports::crashing_executable(folder.path());
    assert_ne!(first.file_name(), second.file_name());
    assert_ne!(first.file_name(), executable.file_name());
    for path in [&first, &second] {
        let metadata = std::fs::metadata(path).unwrap();
        assert_eq!(metadata.len(), expected, "size of {path:?}");
        assert_ne!(metadata.permissions().mode() & 0o100, 0, "mode of {path:?}");
    }
}
