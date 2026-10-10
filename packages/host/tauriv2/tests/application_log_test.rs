//! 애플리케이션 로그 테스트(docs/spec/hosts.md#application-log). 표준 오류 교체는 프로세스 전체에 영향을
//! 주므로 자식 프로세스에서 확인한다.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::application_log::{log_error, open_log, start_standard_error};

/// 자식 프로세스에 설정 디렉터리를 알리는 환경 변수.
const CHILD: &str = "SOKSAK_APPLICATION_LOG_CHILD";

const NAME: &str =
    "start_standard_error_writes_the_start_line_and_takes_the_standard_error_of_the_process_and_its_children";

// contract: log.open.rotates-at-100mb
#[test]
fn open_log_moves_a_file_of_one_hundred_megabytes_to_the_earlier_generation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("logs").join("application.log");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let full = "x".repeat(100 * 1024 * 1024);
    std::fs::write(&path, &full).unwrap();
    let earlier = directory.path().join("logs").join("application.log.1");
    std::fs::write(&earlier, "older\n").unwrap();
    for generation in 2..=5 {
        let path = directory
            .path()
            .join("logs")
            .join(format!("application.log.{generation}"));
        std::fs::write(path, format!("generation {generation}\n")).unwrap();
    }
    let mut file = open_log(&path).unwrap();
    file.write_all(b"new\n").unwrap();
    drop(file);
    // The earlier generations move up by one and the fifth one is dropped.
    for (generation, want) in [
        (2, "older\n"),
        (3, "generation 2\n"),
        (4, "generation 3\n"),
        (5, "generation 4\n"),
    ] {
        let moved = directory
            .path()
            .join("logs")
            .join(format!("application.log.{generation}"));
        assert_eq!(std::fs::read_to_string(moved).unwrap(), want);
    }
    assert!(!directory
        .path()
        .join("logs")
        .join("application.log.6")
        .exists());
    assert_eq!(
        std::fs::metadata(&earlier).unwrap().len(),
        full.len() as u64
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new\n");
}

// contract: log.open.appends-below-bound
#[test]
fn open_log_appends_to_a_smaller_file_and_creates_a_private_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("logs").join("application.log");
    for line in ["first\n", "second\n"] {
        let mut file = open_log(&path).unwrap();
        file.write_all(line.as_bytes()).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nsecond\n");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        !directory
            .path()
            .join("logs")
            .join("application.log.1")
            .exists(),
        "a file below the bound was rotated"
    );
}

// contract: log.application.start-replaces-standard-error
#[test]
fn start_standard_error_writes_the_start_line_and_takes_the_standard_error_of_the_process_and_its_children(
) {
    if let Some(config) = std::env::var_os(CHILD) {
        let writer = records::start_writer(std::path::Path::new(&config));
        if let Err(error) = start_standard_error(std::path::Path::new(&config), "com.soksak.test") {
            println!("{error}");
            std::process::exit(2);
        }
        let mut standard_error = std::io::stderr();
        standard_error.write_all(b"host line\n").unwrap();
        let status = Command::new("/bin/sh")
            .args(["-c", "echo child line >&2"])
            .status()
            .unwrap();
        assert!(status.success());
        writer.flush(std::time::Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
        .env(CHILD, config.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}, output {:?}",
        output.status,
        String::from_utf8_lossy(&output.stdout)
    );
    // The raw standard error of the process and its children is in the stderr file of the run, beside the event log.
    assert_eq!(
        records::standard_error_text(config.path()),
        "host line\nchild line\n"
    );
    // The run record is an event of the event log, not a line of the stderr file.
    let events = records::read_events(&records::event_log_path(config.path()));
    let run = events.last().unwrap();
    assert!(
        run["event"] == "host.record.info"
            && run["fields"]["where"] == "run"
            && run["fields"]["text"]
                .as_str()
                .unwrap()
                .starts_with("com.soksak.test pid "),
        "event log {events:?}"
    );
}

// contract: log.error.line-form
#[test]
fn log_error_writes_an_error_event_to_the_event_log() {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_standard_error(std::path::Path::new(&config), "com.soksak.test") {
            println!("{error}");
            std::process::exit(2);
        }
        let log = records::start_writer(std::path::Path::new(&config));
        log_error("surface input", "the window has no content view");
        log.flush(std::time::Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "log_error_writes_an_error_event_to_the_event_log",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, config.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}, output {:?}",
        output.status,
        String::from_utf8_lossy(&output.stdout)
    );
    let events = records::read_events(&records::event_log_path(config.path()));
    // The run record precedes it.
    let record = events.last().unwrap();
    assert!(
        events.len() == 3
            && record["event"] == "host.record.error"
            && record["level"] == "error"
            && record["fields"]["where"] == "surface input"
            && record["fields"]["text"] == "the window has no content view",
        "event log {events:?}"
    );
}

// contract: log.record.one-line
#[test]
fn a_record_is_one_line_and_escapes_a_line_feed() {
    assert_eq!(
        soksak_host_tauriv2::application_log::entry_line("error", "page", "start", "first\nsecond"),
        r"error page start: first\nsecond"
    );
    let entry = soksak_host_tauriv2::application_log::Entry::new("info", "host", "w", "a\nb");
    assert!(
        !entry.line().contains('\n'),
        "a record holds a line feed: {:?}",
        entry.line()
    );
}

// contract: log.info.record-form
#[test]
fn log_info_writes_an_info_event_to_the_event_log() {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_standard_error(std::path::Path::new(&config), "com.soksak.test") {
            println!("{error}");
            std::process::exit(2);
        }
        let log = records::start_writer(std::path::Path::new(&config));
        soksak_host_tauriv2::application_log::log_info("webkit children", "pid 7: gone");
        log.flush(std::time::Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "log_info_writes_an_info_event_to_the_event_log",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, config.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}, output {:?}",
        output.status,
        String::from_utf8_lossy(&output.stdout)
    );
    let events = records::read_events(&records::event_log_path(config.path()));
    // The run record precedes it.
    let record = events.last().unwrap();
    assert!(
        events.len() == 3
            && record["event"] == "host.record.info"
            && record["level"] == "info"
            && record["fields"]["where"] == "webkit children"
            && record["fields"]["text"] == "pid 7: gone",
        "event log {events:?}"
    );
}

// A line of the diagnostic transcript of a window also reaches the application log.
// contract: log.transcript.line-reaches-the-application-log
#[test]
fn transcript_lines_reach_the_application_log() {
    assert_eq!(
        soksak_host_tauriv2::application_log::transcript_entry(
            "main",
            "diagnostics: modal rendered m1"
        )
        .line(),
        "info host transcript main: diagnostics: modal rendered m1"
    );
}
