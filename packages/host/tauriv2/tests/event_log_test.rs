//! The event writer of the host (docs/spec/logging.md#writers): events enter a bounded queue without blocking, one
//! writer thread assigns `seq`, writes batches and counts the loss, and the file follows the contract that
//! `@soksak/log-contract` audits.

use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde_json::{json, Value};
use soksak_host_tauriv2::event_log::{EventLog, Level, Options};

/// The events of a log file, parsed.
fn read(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn options(directory: &Path) -> Options {
    Options {
        directory: directory.to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: Duration::from_millis(20),
    }
}

// contract: log.writer.assigns-seq-and-opens-with-log-open
#[test]
fn the_first_line_is_log_open_and_seq_is_consecutive() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start(options(directory.path())).unwrap();
    for index in 0..10 {
        assert!(log.emit(Level::Info, "host.test.event", &json!({"index": index})));
    }
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events[0]["event"], "log.open");
    assert_eq!(events[0]["fields"]["schema"], 1);
    assert_eq!(events[0]["fields"]["role"], "host");
    assert_eq!(events[0]["fields"]["boot"], "b1");
    let seqs: Vec<u64> = events.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, (1..=11).collect::<Vec<u64>>());
    assert_eq!(events[5]["fields"]["index"], 4);
    assert!(events
        .iter()
        .all(|e| e["ts_us"].as_u64().unwrap() > 1_700_000_000_000_000));
}

// contract: log.writer.never-blocks-and-counts-loss
#[test]
fn a_full_queue_returns_false_and_the_writer_records_the_range_as_dropped() {
    let directory = tempfile::tempdir().unwrap();
    let mut opts = options(directory.path());
    opts.queue_events = 4;
    // The writer waits a long time between batches, so the queue stays full while the producer pushes.
    opts.batch_interval = Duration::from_secs(30);
    let log = EventLog::start(opts).unwrap();
    let mut accepted = 0;
    let mut refused = 0;
    for index in 0..50 {
        if log.emit(Level::Info, "host.test.event", &json!({"index": index})) {
            accepted += 1;
        } else {
            refused += 1;
        }
    }
    assert!(
        accepted >= 4 && refused > 0,
        "accepted {accepted}, refused {refused}"
    );
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    let dropped: Vec<&Value> = events
        .iter()
        .filter(|e| e["event"] == "log.dropped")
        .collect();
    assert_eq!(dropped.len(), 1, "{events:?}");
    assert_eq!(dropped[0]["fields"]["count"], refused);
    let stored = events
        .iter()
        .filter(|e| e["event"] == "host.test.event")
        .count();
    assert_eq!(stored, accepted);
}

// contract: log.writer.error-wakes-the-writer
#[test]
fn an_error_is_written_without_waiting_for_the_batch_interval() {
    let directory = tempfile::tempdir().unwrap();
    let mut opts = options(directory.path());
    opts.batch_interval = Duration::from_secs(30);
    let log = EventLog::start(opts).unwrap();
    assert!(log.emit(
        Level::Error,
        "host.test.failure",
        &json!({"reason": "disk"})
    ));
    let path = log.path().to_path_buf();
    // The file is the only place where the write shows; no event source announces it, so the test reads it in short
    // steps until a deadline.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if read(&path)
            .iter()
            .any(|e| e["event"] == "host.test.failure")
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the error was not written within 5 seconds"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    log.flush(Duration::from_secs(5)).unwrap();
}

// contract: log.writer.files-are-private
#[test]
fn the_folder_is_0700_and_the_file_is_0600() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start(options(directory.path())).unwrap();
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(path.parent().unwrap()), 0o700);
}

// contract: log.writer.output-follows-the-contract
#[test]
fn the_file_passes_the_audit_of_the_contract_package() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start(options(directory.path())).unwrap();
    for index in 0..20 {
        log.emit(Level::Info, "host.test.event", &json!({"index": index}));
    }
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let catalog = directory.path().join("catalog.json");
    fs::write(&catalog, json!({
        "schema": 1,
        "events": {
            "log.open": {"layer": "host", "class": "lifecycle", "level": "info",
                "fields": {"schema": "number", "pid": "number", "role": "string", "boot": "string"}},
            "log.dropped": {"layer": "host", "class": "lifecycle", "level": "warn",
                "fields": {"from_seq": "number", "to_seq": "number", "count": "number"}},
            "host.test.event": {"layer": "host", "class": "lifecycle", "level": "info", "fields": {"index": "number"}}
        }
    }).to_string()).unwrap();
    // The checker is the package of the contract; the test reads its result as JSON.
    let script = format!(
        "import {{ readFileSync }} from 'node:fs'; import {{ auditLog }} from {:?};\
         const catalog = JSON.parse(readFileSync({:?}, 'utf8'));\
         console.log(JSON.stringify(auditLog({:?}, readFileSync({:?}, 'utf8'), catalog)));",
        format!(
            "file://{}/../../log-contract/index.js",
            env!("CARGO_MANIFEST_DIR")
        ),
        catalog,
        path,
        path
    );
    let output = Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let findings: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(findings, json!([]));
}

// contract: log.writer.flush-at-exit
#[test]
fn flush_writes_every_accepted_event_before_it_returns() {
    let directory = tempfile::tempdir().unwrap();
    let mut opts = options(directory.path());
    opts.batch_interval = Duration::from_secs(30);
    let log = EventLog::start(opts).unwrap();
    for index in 0..40 {
        assert!(log.emit(Level::Info, "host.test.event", &json!({"index": index})));
    }
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let stored = read(&path)
        .iter()
        .filter(|e| e["event"] == "host.test.event")
        .count();
    assert_eq!(stored, 40);
}

// contract: log.writer.relays-events-with-their-layer-and-time
#[test]
fn a_relayed_event_keeps_its_layer_and_time_and_gets_the_seq_of_the_writer() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start(options(directory.path())).unwrap();
    let fields = serde_json::value::to_raw_value(&json!({"index": 7})).unwrap();
    assert_eq!(
        log.emit_relayed(
            1_791_000_000_000_123,
            "page",
            Level::Warn,
            "page.test.event",
            fields
        ),
        Ok(true)
    );
    let bad_layer = serde_json::value::to_raw_value(&json!({})).unwrap();
    let error = log
        .emit_relayed(1, "page", Level::Info, "host.test.event", bad_layer)
        .unwrap_err();
    assert!(error.contains("does not start with its layer"), "{error}");
    let unknown = serde_json::value::to_raw_value(&json!({})).unwrap();
    let error = log
        .emit_relayed(1, "unknown", Level::Info, "unknown.test.event", unknown)
        .unwrap_err();
    assert!(error.contains("is not one of"), "{error}");
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[1]["layer"], "page");
    assert_eq!(events[1]["ts_us"], 1_791_000_000_000_123u64);
    assert_eq!(events[1]["seq"], 2);
    assert_eq!(events[1]["level"], "warn");
    assert_eq!(events[1]["fields"]["index"], 7);
}
