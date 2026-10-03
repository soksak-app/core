//! 애플리케이션 로그 테스트(docs/spec/hosts.md#application-log). 표준 오류 교체는 프로세스 전체에 영향을
//! 주므로 자식 프로세스에서 확인한다.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

use soksak_host_tauriv2::application_log::{application_log_path, open_log, start_application_log};

/// 자식 프로세스에 설정 디렉터리를 알리는 환경 변수.
const CHILD: &str = "SOKSAK_APPLICATION_LOG_CHILD";

const NAME: &str =
    "start_application_log_writes_the_start_line_and_takes_the_standard_error_of_the_process_and_its_children";

// contract: log.open.rotates-at-10mb
#[test]
fn open_log_moves_a_file_of_ten_megabytes_to_the_earlier_generation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("logs").join("application.log");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let full = "x".repeat(10 * 1024 * 1024);
    std::fs::write(&path, &full).unwrap();
    let earlier = directory.path().join("logs").join("application.log.1");
    std::fs::write(&earlier, "older\n").unwrap();
    let mut file = open_log(&path).unwrap();
    file.write_all(b"new\n").unwrap();
    drop(file);
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

/// 실행의 첫 줄 `<ISO-8601 시각> application log: com.soksak.test pid <pid>` 인지 판정한다.
fn regex_start(line: &str) -> bool {
    let Some((time, rest)) = line.split_once(' ') else {
        return false;
    };
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    let shape = time.len() == 24
        && time.ends_with('Z')
        && time.as_bytes()[10] == b'T'
        && time.as_bytes()[19] == b'.';
    let Some(pid) = rest.strip_prefix("application log: com.soksak.test pid ") else {
        return false;
    };
    shape && digits(pid)
}
