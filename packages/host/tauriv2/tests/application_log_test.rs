//! 애플리케이션 로그 테스트(docs/spec/hosts.md#application-log). 표준 오류 교체는 프로세스 전체에 영향을
//! 주므로 자식 프로세스에서 확인한다.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

use soksak_host_tauriv2::application_log::{
    application_log_path, log_error, open_log, start_application_log,
};

/// 자식 프로세스에 설정 디렉터리를 알리는 환경 변수.
const CHILD: &str = "SOKSAK_APPLICATION_LOG_CHILD";

const NAME: &str =
    "start_application_log_writes_the_start_line_and_takes_the_standard_error_of_the_process_and_its_children";

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
fn start_application_log_writes_the_start_line_and_takes_the_standard_error_of_the_process_and_its_children(
) {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_application_log(std::path::Path::new(&config), "com.soksak.test")
        {
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
    let log = std::fs::read_to_string(application_log_path(config.path())).unwrap();
    let lines: Vec<&str> = log.lines().collect();
    let start = regex_start(lines.first().copied().unwrap_or(""));
    assert!(
        start && lines.get(1) == Some(&"host line") && lines.get(2) == Some(&"child line"),
        "application log {lines:?}"
    );
}

// contract: log.error.line-form
#[test]
fn log_error_writes_an_error_line_to_the_application_log() {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_application_log(std::path::Path::new(&config), "com.soksak.test")
        {
            println!("{error}");
            std::process::exit(2);
        }
        log_error("surface input", "the window has no content view");
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "log_error_writes_an_error_line_to_the_application_log",
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
    let log = std::fs::read_to_string(application_log_path(config.path())).unwrap();
    let lines: Vec<&str> = log.lines().collect();
    assert!(
        lines.len() == 2
            && is_record(lines[1])
            && lines[1].ends_with(" error host surface input: the window has no content view"),
        "application log {lines:?}"
    );
}

/// 줄이 `<ISO-8601 시각> <level> <layer> <where>: <text>` 형식의 글 기록인지 판정한다.
fn is_record(line: &str) -> bool {
    let mut parts = line.splitn(4, ' ');
    let (Some(time), Some(level), Some(layer), Some(rest)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    time.len() == 24
        && time.ends_with('Z')
        && matches!(level, "error" | "info")
        && matches!(layer, "page" | "host" | "native" | "sidecar")
        && rest.contains(": ")
}

/// 실행의 첫 줄 `<ISO-8601 시각> info host run: com.soksak.test pid <pid>` 인지 판정한다.
fn regex_start(line: &str) -> bool {
    let Some((time, rest)) = line.split_once(' ') else {
        return false;
    };
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    let shape = time.len() == 24
        && time.ends_with('Z')
        && time.as_bytes()[10] == b'T'
        && time.as_bytes()[19] == b'.';
    let Some(pid) = rest.strip_prefix("info host run: com.soksak.test pid ") else {
        return false;
    };
    shape && digits(pid)
}

// contract: log.record.one-line
#[test]
fn a_record_is_one_line_and_escapes_a_line_feed() {
    assert_eq!(
        soksak_host_tauriv2::application_log::entry_line("error", "page", "start", "first\nsecond"),
        r"error page start: first\nsecond"
    );
    let record = soksak_host_tauriv2::application_log::record_line("info", "host", "w", "a\nb");
    assert!(
        !record.contains('\n'),
        "a record holds a line feed: {record:?}"
    );
    assert!(is_record(&record), "{record:?}");
}

// contract: log.info.record-form
#[test]
fn log_info_writes_an_info_record_to_the_application_log() {
    if let Some(config) = std::env::var_os(CHILD) {
        if let Err(error) = start_application_log(std::path::Path::new(&config), "com.soksak.test")
        {
            println!("{error}");
            std::process::exit(2);
        }
        soksak_host_tauriv2::application_log::log_info("webkit children", "pid 7: gone");
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "log_info_writes_an_info_record_to_the_application_log",
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
    let log = std::fs::read_to_string(application_log_path(config.path())).unwrap();
    let lines: Vec<&str> = log.lines().collect();
    assert!(
        lines.len() == 2
            && is_record(lines[1])
            && lines[1].ends_with(" info host webkit children: pid 7: gone"),
        "application log {lines:?}"
    );
}

// A record that the page reports has the layer `page`; the host checks its level and its place before it writes it.
// contract: log.page.record-form
#[test]
fn a_page_record_has_the_layer_page_and_rejects_an_invalid_level_or_place() {
    use soksak_host_tauriv2::application_log::page_entry;
    assert_eq!(
        page_entry("error", "library plugins", "first\nsecond").unwrap(),
        r"error page library plugins: first\nsecond"
    );
    for (name, level, place) in [
        ("a level that is not error or info", "warning", "w"),
        ("an empty place", "info", ""),
        ("a place that holds the separator", "info", "a: b"),
        ("a place with a line feed", "info", "a\nb"),
    ] {
        assert!(
            page_entry(level, place, "t").is_err(),
            "{name} was accepted"
        );
    }
}
