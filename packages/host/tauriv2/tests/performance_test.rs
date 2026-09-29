// 성능 트레이스 호스트 쪽 계약(docs/spec/performance-trace.md, V5-104).
// 켜기는 로그 파일과 사이드카 플래그 파일을 만들고, 끄기는 플래그를 지운다.
// 페이지 줄 중계는 객체 형식을 검증하고 대상에 그대로 덧붙인다. 계기는 진단이므로 모든
// 쓰기 함수가 실패를 조용히 흡수한다 — 거부는 파일에 줄이 남지 않는 것으로 관측한다.
use serde_json::json;
use soksak_host_tauriv2::performance;

fn temp_config(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tauri-performance-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("services").join("soksak-vt-alacritty")).unwrap();
    dir
}

// contract: performance.trace.enable-writes-log-and-sidecar-flags
#[test]
fn enable_writes_the_log_and_the_sidecar_flags() {
    let config = temp_config("enable");
    let target = performance::enable(&config);
    assert_eq!(target, config.join("logs").join("performance.ndjson"));

    let flag = std::fs::read_to_string(
        config
            .join("services")
            .join("soksak-vt-alacritty")
            .join("performance"),
    )
    .expect("every existing service directory receives the flag");
    assert_eq!(flag.trim(), target.display().to_string());

    performance::line(&target, "host", json!({"event": "trace_on"}));
    let text = std::fs::read_to_string(&target).unwrap();
    let record: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(record["layer"], "host");
    assert_eq!(record["event"], "trace_on");
    let _ = std::fs::remove_dir_all(&config);
}

// contract: performance.trace.disable-removes-flags-keeps-log
#[test]
fn disable_removes_the_sidecar_flags_but_keeps_the_log() {
    let config = temp_config("disable");
    let target = performance::enable(&config);
    performance::line(&target, "host", json!({"event": "trace_on"}));
    performance::disable(&config);
    assert!(!config
        .join("services")
        .join("soksak-vt-alacritty")
        .join("performance")
        .exists());
    assert!(
        target.exists(),
        "the log belongs to the trace, not the switch"
    );
    let _ = std::fs::remove_dir_all(&config);
}

// contract: performance.trace.relay-requires-object-with-event
#[test]
fn relayed_page_lines_require_an_object_with_an_event() {
    let config = temp_config("relay");
    let target = performance::enable(&config);
    performance::relay(&target, json!({"event": "action", "kind": "resize"}));
    performance::relay(&target, json!({"kind": "resize"}));
    performance::relay(&target, json!("action"));
    let text = std::fs::read_to_string(&target).unwrap();
    assert_eq!(text.lines().count(), 1, "rejected lines append nothing");
    let record: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(record["layer"], "page");
    assert_eq!(record["kind"], "resize");
    let _ = std::fs::remove_dir_all(&config);
}
