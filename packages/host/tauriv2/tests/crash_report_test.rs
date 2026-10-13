//! The crash reports of the system (docs/spec/logging.md#automatic-entrances): the start of the host announces each crash report
//! of the application once as the event `host.crash.found`. The same cases run in the Go host.

#[path = "support/records.rs"]
mod records;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use soksak_host_tauriv2::crash_report::{CRASH_REPORT_LIMIT, announce_crash_reports};
use soksak_host_tauriv2::event_log::EventLog;
use soksak_host_tauriv2::event_record::use_host_event_log;

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

/// Writes a report of the process `pid` of the application in the form of the system: a header line with the name and the
/// time, and the body, a JSON document with the process identifier.
fn write_report(directory: &Path, name: &str, application: &str, pid: u64, stamp: &str) -> PathBuf {
    let path = directory.join(name);
    fs::write(
        &path,
        format!("{{\"app_name\":\"{application}\",\"timestamp\":\"{stamp}\",\"bug_type\":\"309\"}}\n{{\n  \"pid\" : {pid},\n  \"procName\" : \"{application}\"\n}}\n"),
    )
    .unwrap();
    path
}

/// The events `host.crash.found` that the writer stored.
fn found(log: &EventLog) -> Vec<Value> {
    log.flush(Duration::from_secs(5)).unwrap();
    records::read_events(log.path())
        .into_iter()
        .filter(|event| event["event"] == "host.crash.found")
        .collect()
}

/// Runs `body` with a writer attached and a folder of reports and a ledger file in disposable folders.
fn with_log(body: impl FnOnce(&Arc<EventLog>, &Path, &Path)) {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = tempfile::tempdir().unwrap();
    let reports = tempfile::tempdir().unwrap();
    let ledger = tempfile::tempdir().unwrap();
    let log = records::start_writer(config.path());
    body(&log, reports.path(), &ledger.path().join("crash-found.txt"));
    use_host_event_log(None);
}

// contract: diagnostics.crash.report-is-announced-once
#[test]
fn a_crash_report_of_the_application_is_announced_once() {
    with_log(|log, reports, ledger| {
        let path = write_report(
            reports,
            "soksak-2026-10-11-023343.ips",
            "soksak",
            4242,
            "2026-10-11 02:33:43.00 +0900",
        );
        for _ in 0..2 {
            announce_crash_reports(reports, ledger, "soksak").unwrap();
        }
        let events = found(log);
        assert_eq!(events.len(), 1, "{events:?}");
        let fields = &events[0]["fields"];
        assert_eq!(events[0]["level"], "warn");
        assert_eq!(fields["path"], path.to_str().unwrap());
        assert_eq!(fields["pid"], 4242);
        assert_eq!(fields["time"], "2026-10-11 02:33:43.00 +0900");
        // A report that appears after the first start is announced at the next start, and the earlier one is not announced again.
        let later = write_report(
            reports,
            "soksak-2026-10-12-010000.ips",
            "soksak",
            77,
            "2026-10-12 01:00:00.00 +0900",
        );
        announce_crash_reports(reports, ledger, "soksak").unwrap();
        let events = found(log);
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[1]["fields"]["path"], later.to_str().unwrap());
    });
}

// contract: diagnostics.crash.report-belongs-to-the-application
#[test]
fn only_a_report_of_the_application_is_announced() {
    with_log(|log, reports, ledger| {
        write_report(
            reports,
            "other-2026-10-11-023343.ips",
            "other",
            1,
            "2026-10-11 02:33:43.00 +0900",
        );
        write_report(
            reports,
            "soksak-helper-2026-10-11-023344.ips",
            "soksak-helper",
            2,
            "2026-10-11 02:33:44.00 +0900",
        );
        fs::write(
            reports.join("soksak-2026-10-11-023345.diag"),
            "not a crash report",
        )
        .unwrap();
        let mine = write_report(
            reports,
            "soksak-2026-10-11-023346.ips",
            "soksak",
            3,
            "2026-10-11 02:33:46.00 +0900",
        );
        announce_crash_reports(reports, ledger, "soksak").unwrap();
        let events = found(log);
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0]["fields"]["path"], mine.to_str().unwrap());
    });
}

// contract: diagnostics.crash.lookup-is-bounded
#[test]
fn the_lookup_of_crash_reports_reads_the_newest_reports_only() {
    with_log(|log, reports, ledger| {
        for index in 0..CRASH_REPORT_LIMIT + 6 {
            write_report(
                reports,
                &format!("soksak-2026-10-11-{index:06}.ips"),
                "soksak",
                100 + index as u64,
                "2026-10-11 00:00:00.00 +0900",
            );
        }
        announce_crash_reports(reports, ledger, "soksak").unwrap();
        let events = found(log);
        assert_eq!(events.len(), CRASH_REPORT_LIMIT);
        assert!(
            events[0]["fields"]["path"]
                .as_str()
                .unwrap()
                .ends_with("000006.ips")
        );
    });
}

// contract: diagnostics.crash.unreadable-report-is-an-error
#[test]
fn a_report_that_cannot_be_read_is_an_error_and_is_not_repeated() {
    with_log(|log, reports, ledger| {
        let broken = reports.join("soksak-2026-10-11-023343.ips");
        fs::write(
            &broken,
            "{\"app_name\":\"soksak\",\"timestamp\":\"2026-10-11 02:33:43.00 +0900\"}\nnot json\n",
        )
        .unwrap();
        let error = announce_crash_reports(reports, ledger, "soksak").unwrap_err();
        assert!(
            error.contains(broken.to_str().unwrap()) && error.contains("pid"),
            "{error}"
        );
        assert_eq!(announce_crash_reports(reports, ledger, "soksak"), Ok(()));
        assert!(found(log).is_empty());
    });
}

// contract: diagnostics.crash.missing-folder-has-no-reports
#[test]
fn a_missing_folder_of_crash_reports_has_no_reports() {
    with_log(|log, reports, ledger| {
        assert_eq!(
            announce_crash_reports(&reports.join("absent"), ledger, "soksak"),
            Ok(())
        );
        assert!(found(log).is_empty());
    });
}

// contract: diagnostics.crash.folder-that-cannot-be-read-is-an-error
#[test]
fn a_folder_of_crash_reports_that_cannot_be_read_is_an_error() {
    with_log(|_, reports, ledger| {
        let file = reports.join("file");
        fs::write(&file, "").unwrap();
        let error = announce_crash_reports(&file, ledger, "soksak").unwrap_err();
        assert!(error.contains(file.to_str().unwrap()), "{error}");
    });
}

// contract: diagnostics.crash.folder-is-named-by-the-platform
#[test]
fn the_platform_names_the_folder_of_crash_reports() {
    let directory = soksak_host_tauriv2::platform::current()
        .unwrap()
        .diagnostic_reports_directory()
        .unwrap();
    assert!(directory.is_absolute());
    assert!(
        directory.ends_with("Library/Logs/DiagnosticReports"),
        "{directory:?}"
    );
}
