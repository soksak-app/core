// The switch of the performance trace of the host (docs/spec/performance-trace.md): the process holds it, the page turns it
// on and off, an observation is an event of the event log while it is on, and its markers are events too. No file holds the
// switch and no flag reaches a service. The writer of the records and the switch belong to the process, so the checks that
// store events run in a child process that nothing else writes in.
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::json;
use soksak_host_tauriv2::performance;

#[path = "support/records.rs"]
mod records;

const CHILD: &str = "SOKSAK_PERFORMANCE_CHILD";

/// Runs the test `name` again in a child process with a fresh configuration folder and returns that folder.
fn in_child(name: &str) -> tempfile::TempDir {
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture", "--test-threads=1"])
        .env(CHILD, config.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    config
}

fn trace_events(config: &std::path::Path) -> Vec<String> {
    records::read_events(&records::event_log_path(config))
        .into_iter()
        .filter_map(|event| event["event"].as_str().map(str::to_string))
        .filter(|name| name.starts_with("host.trace."))
        .collect()
}

// contract: performance.trace.switch-accepts-on-and-off-only
#[test]
fn the_switch_accepts_on_and_off_only() {
    for request in [
        json!({}),
        json!({"action": 7}),
        json!({"action":"line","line":{"event":"focus"}}),
        json!({"action":"toggle"}),
    ] {
        let error = performance::command(request.clone()).unwrap_err();
        assert!(
            error.contains("action must be on or off"),
            "request {request}: {error}"
        );
    }
    assert!(
        !performance::enabled(),
        "a refused request turned the trace on"
    );
}

// contract: performance.trace.switch-is-held-by-the-process
#[test]
fn the_process_holds_the_switch_and_no_file_does() {
    if let Some(config) = std::env::var_os(CHILD) {
        let config = std::path::PathBuf::from(config);
        std::fs::create_dir_all(config.join("services/fixture-service")).unwrap();
        let writer = records::start_writer(&config);
        let observe = || performance::observe("host", || json!({"event": "probe", "n": 1}));
        observe();
        performance::command(json!({"action": "on"})).unwrap();
        assert!(performance::enabled(), "the trace is off after on");
        observe();
        performance::command(json!({"action": "off"})).unwrap();
        assert!(!performance::enabled(), "the trace is on after off");
        observe();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = in_child("the_process_holds_the_switch_and_no_file_does");
    // Only the observation made while the trace was on is stored, between the markers.
    assert_eq!(
        trace_events(config.path()),
        ["host.trace.on", "host.trace.probe", "host.trace.off"]
    );
    // The switch is not a file, the trace is not a file, and a service directory holds no flag.
    for path in [
        "performance",
        "logs/performance.ndjson",
        "services/fixture-service/performance",
    ] {
        assert!(
            !config.path().join(path).exists(),
            "{path} exists after the switch"
        );
    }
}

// contract: performance.trace.already-off-writes-nothing
#[test]
fn already_off_writes_nothing() {
    if let Some(config) = std::env::var_os(CHILD) {
        let writer = records::start_writer(std::path::Path::new(&config));
        performance::command(json!({"action": "off"})).unwrap();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = in_child("already_off_writes_nothing");
    assert_eq!(trace_events(config.path()), Vec::<String>::new());
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

// contract: performance.sampler.ends-with-the-switch
#[test]
fn the_sampler_ends_when_the_trace_turns_off() {
    if std::env::var_os(CHILD).is_some() {
        assert!(
            !performance::sampler_running(),
            "a sampler runs while the trace is off"
        );
        performance::command(json!({"action": "on"})).unwrap();
        assert!(
            performance::sampler_running(),
            "no sampler runs while the trace is on"
        );
        performance::command(json!({"action": "off"})).unwrap();
        assert!(
            !performance::sampler_running(),
            "the sampler runs after the trace turned off"
        );
        performance::command(json!({"action": "on"})).unwrap();
        assert!(
            performance::sampler_running(),
            "no sampler runs after the trace turned on again"
        );
        performance::command(json!({"action": "off"})).unwrap();
        return;
    }
    in_child("the_sampler_ends_when_the_trace_turns_off");
}

/// The `fields` of the stored events named `name`.
fn trace_fields(config: &std::path::Path, name: &str) -> Vec<serde_json::Value> {
    records::read_events(&records::event_log_path(config))
        .into_iter()
        .filter(|event| event["event"] == name)
        .map(|event| event["fields"].clone())
        .collect()
}

// contract: performance.sampler.reads-every-registered-process
#[test]
fn the_sampler_reads_every_registered_process() {
    if let Some(config) = std::env::var_os(CHILD) {
        let writer = records::start_writer(std::path::Path::new(&config));
        performance::command(json!({"action": "on"})).unwrap();
        records::wait_for_first_sample(std::path::Path::new(&config), &writer);
        let mut sleeper = Command::new("sleep").arg("30").spawn().unwrap();
        performance::process_add("sidecar", "fixture", sleeper.id());
        performance::sample();
        performance::process_remove(sleeper.id());
        // A removed process is not read again.
        performance::sample();
        // A registered process whose size cannot be read is reported with its error.
        performance::process_add("sidecar", "ended", 1 << 30);
        performance::sample();
        performance::process_remove(1 << 30);
        sleeper.kill().unwrap();
        sleeper.wait().unwrap();
        performance::command(json!({"action": "off"})).unwrap();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = in_child("the_sampler_reads_every_registered_process");
    let samples = trace_fields(config.path(), "host.sampler.memory");
    let fixture: Vec<_> = samples.iter().filter(|s| s["name"] == "fixture").collect();
    assert_eq!(
        fixture.len(),
        1,
        "the registered process was sampled {} times, want 1: {samples:?}",
        fixture.len()
    );
    assert_eq!(fixture[0]["role"], "sidecar");
    assert!(
        fixture[0]["rss_kb"].as_u64().is_some_and(|size| size > 0),
        "the sample holds no resident size: {}",
        fixture[0]
    );
    let named = trace_fields(config.path(), "host.trace.process");
    let named: Vec<_> = named.iter().filter(|p| p["name"] == "fixture").collect();
    assert_eq!(named.len(), 1, "process events of the fixture: {named:?}");
    assert_eq!(named[0]["role"], "sidecar");
    assert!(named[0]["pid"].as_u64().is_some_and(|pid| pid > 0));
    let ended: Vec<_> = samples.iter().filter(|s| s["name"] == "ended").collect();
    assert_eq!(ended.len(), 1, "samples of the ended process: {ended:?}");
    assert!(ended[0].get("rss_kb").is_none() && ended[0]["pid"] == (1u64 << 30));
    assert!(
        ended[0]["error"]
            .as_str()
            .is_some_and(|text| !text.is_empty()),
        "a failed reading has no error: {}",
        ended[0]
    );
}

// contract: performance.surface.lifecycle-events-hold-the-geometry
#[test]
fn surface_lifecycle_events_hold_the_geometry() {
    if let Some(config) = std::env::var_os(CHILD) {
        let writer = records::start_writer(std::path::Path::new(&config));
        performance::command(json!({"action": "on"})).unwrap();
        performance::surface("created", "s1", None);
        performance::surface("placed", "s1", Some(([1.0, 2.0, 30.0, 40.0], true)));
        performance::surface("destroyed", "s1", None);
        performance::command(json!({"action": "off"})).unwrap();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = in_child("surface_lifecycle_events_hold_the_geometry");
    let events = trace_fields(config.path(), "host.trace.surface");
    let phases: Vec<_> = events
        .iter()
        .map(|e| e["phase"].as_str().unwrap())
        .collect();
    assert_eq!(phases, ["created", "placed", "destroyed"]);
    let placed = &events[1];
    assert_eq!(placed["surface"], "s1");
    assert_eq!(
        [
            &placed["x"],
            &placed["y"],
            &placed["w"],
            &placed["h"],
            &placed["visible"]
        ],
        [
            &json!(1.0),
            &json!(2.0),
            &json!(30.0),
            &json!(40.0),
            &json!(true)
        ]
    );
}
