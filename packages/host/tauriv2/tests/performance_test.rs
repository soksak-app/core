// 성능 트레이스 호스트 쪽 계약(docs/spec/performance-trace.md, V5-104).
// 켜기는 로그 파일과 사이드카 플래그 파일을 만들고, 끄기는 플래그를 지운다.
// 페이지 줄 중계는 객체 형식을 검증하며 거부와 쓰기 오류를 명시적으로 반환한다.
use serde_json::json;
use soksak_host_tauriv2::performance;

// contract: performance.trace.enable-without-services
#[test]
fn enable_without_services_accepts_page_events() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path();
    performance::command(config, json!({"action":"on"})).unwrap();
    let result = performance::command(config, json!({"action":"line","line":{"event":"focus"}}));
    performance::disable(config).unwrap();
    assert!(
        result.is_ok(),
        "enabled trace rejected a page event without services: {result:?}"
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

// contract: performance.trace.switch-and-relay-report-filesystem-errors
#[test]
fn switch_and_relay_report_filesystem_errors() {
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
    performance::command(config, json!({"action":"on"})).unwrap();
    let target = performance::target(config);
    std::fs::remove_file(&target).unwrap();
    std::fs::create_dir(&target).unwrap();
    let result = performance::command(config, json!({"action":"line","line":{"event":"focus"}}));
    performance::disable(config).unwrap();
    assert_eq!(
        [directory_error, flag_error, result.is_err()],
        [true; 3],
        "directory, flag, and output errors must all be returned"
    );
}

// contract: performance.trace.relay-requires-object-with-event
#[test]
fn relay_rejects_invalid_event_explicitly() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path();
    std::fs::create_dir_all(config.join("services").join("fixture-service")).unwrap();
    performance::command(config, json!({"action":"on"})).unwrap();
    let result = performance::command(config, json!({"action":"line","line":{"event":7}}));
    performance::disable(config).unwrap();
    assert!(result.is_err(), "relay accepted a non-string event");
}

// contract: performance.trace.invalid-switch-and-cleanup-errors
#[test]
fn invalid_switch_and_cleanup_errors() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path();
    std::fs::create_dir(config.join("performance")).unwrap();
    let error = performance::command(config, json!({"action":"line","line":{"event":"focus"}}))
        .unwrap_err();
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
    let target = performance::enable(&config).unwrap();
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
    let target = performance::enable(&config).unwrap();
    performance::line(&target, "host", json!({"event": "trace_on"})).unwrap();
    performance::disable(&config).unwrap();
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

// contract: performance.trace.relay-requires-object-with-event
#[test]
fn relayed_page_lines_require_an_object_with_an_event() {
    let directory = temp_config("relay");
    let config = directory.path();
    let target = performance::enable(&config).unwrap();
    performance::relay(&target, json!({"event": "action", "kind": "resize"})).unwrap();
    assert!(performance::relay(&target, json!({"kind": "resize"})).is_err());
    assert!(performance::relay(&target, json!("action")).is_err());
    let text = std::fs::read_to_string(&target).unwrap();
    assert_eq!(text.lines().count(), 1, "rejected lines append nothing");
    let record: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(record["layer"], "page");
    assert_eq!(record["kind"], "resize");
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

// contract: performance.trace.relay-records-writer-pid
#[test]
fn relayed_page_line_carries_the_writer_pid() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("performance.ndjson");
    performance::relay(
        &target,
        json!({"ts":"2026-10-01T00:00:00.000Z","event":"focus"}),
    )
    .unwrap();
    let record: serde_json::Value =
        serde_json::from_str(std::fs::read_to_string(&target).unwrap().trim()).unwrap();
    assert_eq!(
        record["pid"].as_u64(),
        Some(std::process::id() as u64),
        "a relayed page line does not name the writing process: {record}"
    );
}

// contract: performance.trace.rotates-at-10mb
#[test]
fn trace_rotates_at_ten_megabytes() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("performance.ndjson");
    let full = format!("{}\n", "x".repeat(10 * 1024 * 1024 - 1));
    std::fs::write(&target, &full).unwrap();
    performance::line(&target, "host", json!({"event":"after"})).unwrap();
    let previous =
        std::fs::read_to_string(directory.path().join("performance.ndjson.1")).unwrap_or_default();
    assert!(
        previous == full,
        "the full output was not kept as the previous generation ({} bytes)",
        previous.len()
    );
    let current = std::fs::read_to_string(&target).unwrap();
    assert!(
        current.lines().count() == 1 && current.contains("\"event\":\"after\""),
        "the new line did not start a new output: {current:?}"
    );
}
