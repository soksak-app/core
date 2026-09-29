// 성능 트레이스 기록기의 계약(docs/spec/performance-trace.md, V5-104).
// 플래그 파일은 대상 로그 경로를 한 줄로 담고, 기록기는 그 파일에 NDJSON 줄을
// 덧붙인다. 플래그가 없으면 어떤 파일 작업도 하지 않는다.
use std::fs;
use std::path::PathBuf;
use soksak_sidecar_vt_core::performance::PerformanceTrace;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("vt-core-performance-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn trace_appends_ndjson_to_the_flagged_target() {
    let service = temp_dir("flagged");
    let log = service.join("performance.ndjson");
    fs::write(service.join("performance"), format!("{}\n", log.display())).unwrap();

    let trace = PerformanceTrace::from_service_dir(&service);
    assert!(trace.enabled(), "a flag file pointing at a target enables the trace");
    trace.line("session_start", serde_json::json!({"role": "vt-core"}));
    trace.line("frame", serde_json::json!({"reason": "output", "draw_us": 830}));

    let text = fs::read_to_string(&log).expect("the flagged target receives the lines");
    let lines: Vec<serde_json::Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).expect("every line is one JSON object"))
        .collect();
    assert_eq!(lines.len(), 2);
    for (expected, i) in [("session_start", 0), ("frame", 1)] {
        assert_eq!(lines[i]["event"], expected, "line {i} carries its event");
        assert_eq!(lines[i]["layer"], "vt-core");
        assert_eq!(lines[i]["pid"], serde_json::json!(std::process::id()));
        assert!(lines[i]["ts"].as_str().unwrap().len() >= 20, "ts is ISO-8601 with milliseconds");
    }
    assert_eq!(lines[1]["reason"], "output");
    assert_eq!(lines[1]["draw_us"], 830);
    let _ = fs::remove_dir_all(&service);
}

#[test]
fn trace_without_a_flag_writes_no_file() {
    let service = temp_dir("unflagged");
    let trace = PerformanceTrace::from_service_dir(&service);
    assert!(!trace.enabled(), "no flag file leaves the trace off");
    trace.line("frame", serde_json::json!({}));
    let entries: Vec<_> = fs::read_dir(&service).unwrap().collect();
    assert!(entries.is_empty(), "an off trace creates and writes no file");
    let _ = fs::remove_dir_all(&service);
}

#[test]
fn trace_rechecks_the_flag_on_each_service_dir_read() {
    let service = temp_dir("recheck");
    let log = service.join("performance.ndjson");
    let off = PerformanceTrace::from_service_dir(&service);
    assert!(!off.enabled());
    fs::write(service.join("performance"), format!("{}\n", log.display())).unwrap();
    let on = PerformanceTrace::from_service_dir(&service);
    assert!(on.enabled(), "the flag is read again on the next construction");
    let _ = fs::remove_dir_all(&service);
}
