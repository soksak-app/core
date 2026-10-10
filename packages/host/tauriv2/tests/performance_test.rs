// 성능 트레이스 호스트 쪽 계약(docs/spec/performance-trace.md, V5-104).
// 켜기는 로그 파일과 사이드카 플래그 파일을 만들고, 끄기는 플래그를 지운다.
// 스위치는 on 과 off 만 받고 거부와 쓰기 오류를 명시적으로 반환한다. 페이지 event 는 호출 log 로 간다(event_relay).
use serde_json::json;
use soksak_host_tauriv2::performance;

// contract: performance.trace.enable-without-services
#[test]
fn enable_without_services_creates_the_output() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path();
    performance::command(config, json!({"action":"on"})).unwrap();
    let created = performance::target(config).exists();
    performance::disable(config).unwrap();
    assert!(
        created,
        "enabling without a service directory created no output"
    );
}

// contract: performance.trace.switch-accepts-on-and-off-only
#[test]
fn the_switch_accepts_on_and_off_only() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path();
    for request in [
        json!({}),
        json!({"action": 7}),
        json!({"action":"line","line":{"event":"focus"}}),
        json!({"action":"toggle"}),
    ] {
        let error = performance::command(config, request.clone()).unwrap_err();
        assert!(
            error.contains("action must be on or off"),
            "request {request}: {error}"
        );
    }
    assert!(
        !performance::target(config).exists(),
        "a refused request created output"
    );
}

// contract: performance.trace.already-off-writes-nothing
#[test]
fn already_off_writes_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path();
    std::fs::create_dir_all(config.join("logs")).unwrap();
    performance::command(config, json!({"action":"off"})).unwrap();
    assert!(
        !performance::target(config).exists(),
        "disabled trace created output"
    );
}

// contract: performance.trace.switch-reports-filesystem-errors
#[test]
fn switch_reports_filesystem_errors() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path();
    std::fs::write(config.join("services"), "not a directory").unwrap();
    let directory_error = performance::command(config, json!({"action":"on"})).is_err();
    std::fs::remove_file(config.join("services")).unwrap();
    let flag = config
        .join("services")
        .join("fixture-service")
        .join("performance");
    std::fs::create_dir_all(&flag).unwrap();
    let flag_error = performance::command(config, json!({"action":"on"})).is_err();
    std::fs::remove_dir(&flag).unwrap();
    assert_eq!(
        [directory_error, flag_error],
        [true; 2],
        "directory and flag errors must both be returned"
    );
}

// contract: performance.trace.invalid-switch-and-cleanup-errors
#[test]
fn invalid_switch_and_cleanup_errors() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path();
    std::fs::create_dir(config.join("performance")).unwrap();
    let error = performance::command(config, json!({"action":"off"})).unwrap_err();
    assert!(
        error.contains("performance switch"),
        "invalid switch was hidden: {error}"
    );
    std::fs::remove_dir(config.join("performance")).unwrap();
    let flag = config
        .join("services")
        .join("fixture-service")
        .join("performance");
    std::fs::create_dir_all(&flag).unwrap();
    assert!(
        performance::disable(config).is_err(),
        "disable removed an invalid flag directory instead of reporting it"
    );
    assert!(flag.is_dir(), "invalid flag directory was removed");
}

// contract: performance.trace.derive-service-flags-and-reset
#[test]
fn derive_service_flags_and_reset() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path();
    performance::command(config, json!({"action":"on"})).unwrap();
    let flag = config
        .join("services")
        .join("fixture-service")
        .join("performance");
    std::fs::create_dir_all(flag.parent().unwrap()).unwrap();
    performance::sync_services(config).unwrap();
    assert_eq!(
        std::fs::read_to_string(&flag).unwrap(),
        format!("{}\n", performance::target(config).display())
    );
    performance::disable(config).unwrap();
    assert!(!flag.exists());
    assert!(!config.join("performance").exists());
    let mut formatted = 0;
    performance::observe(config, "host", || {
        formatted += 1;
        json!({"event":"focus"})
    });
    assert_eq!(formatted, 0, "disabled observation formatted events");
    std::fs::write(
        &flag,
        format!("{}\n", performance::target(config).display()),
    )
    .unwrap();
    performance::sync_services(config).unwrap();
    assert!(!flag.exists(), "disabled reattachment retained stale flag");
}

fn temp_config(name: &str) -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix(&format!("tauri-performance-{name}-"))
        .tempdir()
        .unwrap();
    std::fs::create_dir_all(dir.path().join("services").join("fixture-service")).unwrap();
    dir
}

// contract: performance.trace.enable-writes-log-and-sidecar-flags
#[test]
fn enable_writes_the_log_and_the_sidecar_flags() {
    let directory = temp_config("enable");
    let config = directory.path();
    let target = performance::enable(config).unwrap();
    assert_eq!(target, config.join("logs").join("performance.ndjson"));

    let flag = std::fs::read_to_string(
        config
            .join("services")
            .join("fixture-service")
            .join("performance"),
    )
    .expect("every existing service directory receives the flag");
    assert_eq!(flag.trim(), target.display().to_string());

    performance::line(&target, "host", json!({"event": "trace_on"})).unwrap();
    let text = std::fs::read_to_string(&target).unwrap();
    let record: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(record["layer"], "host");
    assert_eq!(record["event"], "trace_on");
    directory.close().unwrap();
}

// contract: performance.trace.disable-removes-flags-keeps-log
#[test]
fn disable_removes_the_sidecar_flags_but_keeps_the_log() {
    let directory = temp_config("disable");
    let config = directory.path();
    let target = performance::enable(config).unwrap();
    performance::line(&target, "host", json!({"event": "trace_on"})).unwrap();
    performance::disable(config).unwrap();
    assert!(!config
        .join("services")
        .join("fixture-service")
        .join("performance")
        .exists());
    assert!(
        target.exists(),
        "the log belongs to the trace, not the switch"
    );
    directory.close().unwrap();
}

// contract: performance.sampler.failed-reading-is-explicit
#[test]
fn sampler_reports_a_failed_reading() {
    // 존재하지 않는 pid 의 상주 크기는 읽을 수 없다. 0 으로 바꾸지 않고 오류로 기록한다.
    let record = performance::memory_record(1 << 30);
    assert!(
        record.get("rss_host_kb").is_none(),
        "a failed reading was recorded as a size: {record}"
    );
    assert!(
        record["error"]
            .as_str()
            .is_some_and(|text| !text.is_empty()),
        "a failed reading has no error: {record}"
    );
    let own = performance::memory_record(std::process::id());
    assert!(
        own["rss_host_kb"].as_u64().is_some_and(|size| size > 0),
        "the current process has no resident size: {own}"
    );
}

// contract: performance.clock.before-epoch-is-explicit
#[test]
fn a_clock_before_the_epoch_is_reported() {
    let before = std::time::UNIX_EPOCH - std::time::Duration::from_secs(1);
    assert!(
        performance::timestamp(before).is_err(),
        "a time before the epoch was written as the epoch"
    );
    assert_eq!(
        performance::timestamp(
            std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_790_000_000_123)
        ),
        Ok("2026-09-21T14:13:20.123Z".to_string())
    );
}

// contract: performance.trace.line-records-writer-pid
#[test]
fn a_host_line_carries_the_writer_pid() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("performance.ndjson");
    performance::line(&target, "host", json!({"event":"focus"})).unwrap();
    let record: serde_json::Value =
        serde_json::from_str(std::fs::read_to_string(&target).unwrap().trim()).unwrap();
    assert_eq!(
        record["pid"].as_u64(),
        Some(std::process::id() as u64),
        "a host line does not name the writing process: {record}"
    );
}

// A trace file rotates at 100 MB and keeps the five earlier generations, so the records cover a long session.
// contract: performance.trace.rotates-at-100mb
#[test]
fn trace_rotates_at_one_hundred_megabytes_and_keeps_five_generations() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("performance.ndjson");
    let small = format!("{}\n", "x".repeat(10 * 1024 * 1024 - 1));
    std::fs::write(&target, &small).unwrap();
    performance::line(&target, "host", json!({"event":"below"})).unwrap();
    assert!(
        !directory.path().join("performance.ndjson.1").exists(),
        "a file of 10 MB was rotated"
    );
    // Six rotations: the oldest generation is dropped and the others move up.
    for generation in 1..=6u8 {
        let letter = (b'a' + generation) as char;
        let full = format!("{}\n", letter.to_string().repeat(100 * 1024 * 1024 - 1));
        std::fs::write(&target, &full).unwrap();
        performance::line(&target, "host", json!({"event":"after"})).unwrap();
    }
    for generation in 1..=5u8 {
        let path = directory
            .path()
            .join(format!("performance.ndjson.{generation}"));
        let head = std::fs::read(&path)
            .unwrap_or_else(|error| panic!("generation {generation} is missing: {error}"))[0];
        // The newest rotated file is .1 (written sixth, letter 'g'); .5 is the second written ('c').
        assert_eq!(head, b'a' + 7 - generation, "generation {generation}");
    }
    assert!(
        !directory.path().join("performance.ndjson.6").exists(),
        "a sixth earlier generation was kept"
    );
    let current = std::fs::read_to_string(&target).unwrap();
    assert!(
        current.lines().count() == 1 && current.contains("\"event\":\"after\""),
        "the new line did not start a new output: {current:?}"
    );
}

// 스위치, 서비스 플래그, 트레이스 출력은 현재 사용자만 읽고 쓴다.
// contract: performance.trace.owner-only-files
#[test]
fn enable_creates_owner_only_files() {
    use std::os::unix::fs::PermissionsExt;
    let directory = temp_config("owner-only");
    let config = directory.path();
    let target = performance::enable(config).unwrap();
    performance::line(&target, "host", json!({"event": "trace_on"})).unwrap();
    for path in [
        config.join("performance"),
        config
            .join("services")
            .join("fixture-service")
            .join("performance"),
        target,
    ] {
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{} has mode {mode:o}", path.display());
    }
    directory.close().unwrap();
}
