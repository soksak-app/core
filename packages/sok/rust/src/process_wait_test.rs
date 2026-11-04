use super::{Options, process, run_with_process_wait};
use std::path::Path;

// contract: cli.process-wait.platform-error-is-reported
#[test]
fn process_wait_reports_platform_errors() {
    let args = [
        "process".to_string(),
        "wait".to_string(),
        "1234".to_string(),
        "--timeout-ms".to_string(),
        "4321".to_string(),
    ];
    let options = Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(Path::new("/tmp")),
        core_version: super::version::CORE_VERSION,
    };
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut wait = |pid, timeout| {
        assert_eq!(pid, 1234);
        assert_eq!(timeout, std::time::Duration::from_millis(4321));
        Err(process::WaitError::Operation("kernel wait failed".into()))
    };

    let status = run_with_process_wait(&args, &mut stdout, &mut stderr, &options, &mut wait);

    assert_eq!(status, 1);
    assert!(stdout.is_empty());
    assert_eq!(
        String::from_utf8(stderr).unwrap(),
        "sok: process wait: kernel wait failed\n"
    );
}
