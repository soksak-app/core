//! The event writer of the host (docs/spec/logging.md#writers): events enter a bounded queue without blocking, one
//! writer thread assigns `seq`, writes batches and counts the loss, and the file follows the contract that
//! `@soksak/log-contract` audits.

use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde_json::{json, Value};
use soksak_host_tauriv2::event_log::{EventLog, Level, Options, RelayedEvent};
use soksak_host_tauriv2::platform;

/// The events of a log file, parsed.
fn read_file(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// The events of a process: the lines of the main file at `path` and, when it exists, of the debug file beside it, in the order of
/// `seq` (the writer assigns `seq` across both files).
fn read(path: &Path) -> Vec<Value> {
    let mut events = read_file(path);
    let main = path.to_string_lossy();
    let debug = std::path::PathBuf::from(format!(
        "{}.debug.jsonl",
        main.strip_suffix(".jsonl").unwrap_or(&main)
    ));
    if debug.exists() {
        events.extend(read_file(&debug));
        events.sort_by_key(|event| event["seq"].as_u64().unwrap());
    }
    events
}

fn options(directory: &Path) -> Options {
    Options {
        directory: directory.to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1 << 30,
        pull: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: 1 << 40,
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
    assert_eq!(events[0]["fields"]["schema"], 2);
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
    for _ in 0..20 {
        log.emit(Level::Info, "host.app.event", &json!({"kind": "started"}));
    }
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let catalog = directory.path().join("catalog.json");
    fs::write(&catalog, json!({
        "schema": 2,
        "events": {
            "log.open": {"layer": "host", "class": "lifecycle", "level": "info",
                "fields": {"schema": "number", "pid": "number", "role": "string", "boot": "string"}},
            "log.dropped": {"layer": "host", "class": "lifecycle", "level": "warn",
                "fields": {"from_seq": "number", "to_seq": "number", "count": "number"}},
            "host.app.event": {"layer": "host", "class": "lifecycle", "level": "info", "fields": {"kind": "string"}}
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
    assert_eq!(
        log.emit_relayed(relayed(
            "page",
            "page.test.event",
            Level::Warn,
            json!({"index": 7})
        )),
        Ok(true)
    );
    let error = log
        .emit_relayed(relayed("page", "host.test.event", Level::Info, json!({})))
        .unwrap_err();
    assert!(error.contains("does not start with its layer"), "{error}");
    let error = log
        .emit_relayed(relayed(
            "unknown",
            "unknown.test.event",
            Level::Info,
            json!({}),
        ))
        .unwrap_err();
    assert!(error.contains("is not one of"), "{error}");
    let mut no_clock = relayed("page", "page.test.event", Level::Info, json!({}));
    no_clock.mono_ns = 0;
    let error = log.emit_relayed(no_clock).unwrap_err();
    assert!(error.contains("mono_ns"), "{error}");
    let mut bad_cid = relayed("page", "page.test.event", Level::Info, json!({}));
    bad_cid.cids = vec!["b1.\"1".into()];
    let error = log.emit_relayed(bad_cid).unwrap_err();
    assert!(error.contains("cid"), "{error}");
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[1]["layer"], "page");
    assert_eq!(events[1]["ts_us"], 1_791_000_000_000_123u64);
    assert_eq!(events[1]["mono_ns"], 5_000_000_123u64);
    assert_eq!(events[1]["cids"], json!(["b1.7", "b1.8"]));
    assert_eq!(events[1]["seq"], 2);
    assert_eq!(events[1]["level"], "warn");
    assert_eq!(events[1]["fields"]["index"], 7);
}

/// A relayed event of the layer with the time, the monotonic clock and the identifiers that the tests expect.
fn relayed(layer: &str, event: &str, level: Level, fields: Value) -> RelayedEvent {
    RelayedEvent {
        ts_us: 1_791_000_000_000_123,
        mono_ns: 5_000_000_123,
        layer: layer.to_string(),
        level,
        event: event.to_string(),
        cids: vec!["b1.7".into(), "b1.8".into()],
        fields: soksak_host_tauriv2::bounds::Fields::whole(
            serde_json::value::to_raw_value(&fields).unwrap(),
        ),
    }
}

// contract: log.writer.stores-both-clocks
#[test]
fn every_line_carries_the_wall_clock_and_the_monotonic_clock_of_its_call() {
    let system = platform::current().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let before_wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64;
    let before = system.monotonic_ns().unwrap();
    let log = EventLog::start(options(directory.path())).unwrap();
    for index in 0..20 {
        assert!(log.emit(Level::Info, "host.test.event", &json!({"index": index})));
    }
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let after = system.monotonic_ns().unwrap();
    let after_wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64;
    let events = read(&path);
    assert_eq!(events.len(), 21);
    let mut previous = 0;
    for event in &events {
        let mono = event["mono_ns"].as_u64().unwrap();
        assert!(
            mono >= before && mono <= after,
            "mono_ns {mono} is outside [{before}, {after}]: {event}"
        );
        assert!(mono >= previous, "mono_ns went back: {event}");
        previous = mono;
        let wall = event["ts_us"].as_u64().unwrap();
        assert!((before_wall..=after_wall).contains(&wall), "{event}");
    }
    // A wall clock rounded to a millisecond would end every value in 000.
    assert!(
        events
            .iter()
            .any(|event| event["ts_us"].as_u64().unwrap() % 1000 != 0),
        "every ts_us is a whole millisecond"
    );
}

// contract: log.writer.stores-cids
#[test]
fn an_event_with_cids_is_stored_with_them_and_an_invalid_identifier_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start(options(directory.path())).unwrap();
    let cids = vec!["b1.1".to_string(), "b1.2".to_string()];
    assert!(log.emit_cids(Level::Info, "host.test.input", &cids, &json!({"a": 1})));
    assert!(log.emit(Level::Info, "host.test.plain", &json!({})));
    for bad in ["", "b1.\"1", "b1.\\1", "b1.\n1"] {
        let cids = vec![bad.to_string()];
        assert!(
            !log.emit_cids(Level::Info, "host.test.bad", &cids, &json!({})),
            "{bad:?} was accepted"
        );
    }
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(&path);
    assert_eq!(events[1]["cids"], json!(["b1.1", "b1.2"]));
    assert!(events[2].get("cids").is_none(), "{}", events[2]);
    assert!(events.iter().all(|event| event["event"] != "host.test.bad"));
    let dropped: u64 = events
        .iter()
        .filter(|event| event["event"] == "log.dropped")
        .map(|event| event["fields"]["count"].as_u64().unwrap())
        .sum();
    assert_eq!(dropped, 4, "{events:?}");
}

// contract: log.writer.rotates-at-the-bound-and-keeps-generations
#[test]
fn the_log_rotates_at_the_bound_and_keeps_every_generation() {
    let directory = tempfile::tempdir().unwrap();
    let mut opts = options(directory.path());
    opts.rotate_bytes = 4000;
    // The queue holds every event, so no refusal makes a gap of seq that log.dropped would explain.
    opts.queue_events = 1000;
    let log = EventLog::start(opts).unwrap();
    for index in 0..300 {
        assert!(
            log.emit(
                Level::Info,
                "host.test.event",
                &json!({"index": index, "padding": "xxxxxxxxxxxxxxxxxxxx"}),
            ),
            "event {index} was refused"
        );
    }
    let path = log.path().to_path_buf();
    log.flush(Duration::from_secs(10)).unwrap();
    let generation = |n: usize| {
        let mut name = path.clone().into_os_string();
        name.push(format!(".{n}"));
        std::path::PathBuf::from(name)
    };
    // The generations are numbered in the order of the rotations and none is removed.
    let mut files = vec![path.clone()];
    while generation(files.len()).exists() {
        files.push(generation(files.len()));
    }
    assert!(
        files.len() > 8,
        "the file rotated into {} generations, want more than the 5 that an earlier writer kept",
        files.len() - 1
    );
    let current = read(&path);
    assert_eq!(current[0]["event"], "log.open");
    assert_eq!(current[1]["event"], "log.rotated");
    assert_eq!(current[1]["fields"]["generation"], files.len() - 1);
    assert!(current[1]["fields"].get("kept").is_none());
    // A file is closed when the next line would pass the bound, so it is full to within one line of 150 bytes.
    let full = current[1]["fields"]["bytes"].as_u64().unwrap();
    assert!(
        (4000 - 150..=4000).contains(&full),
        "log.rotated bytes {full}"
    );
    // Every generation is a file of the contract: it opens with log.open, and its seq is consecutive.
    for file in &files {
        assert!(fs::metadata(file).unwrap().len() <= 4000, "{file:?}");
        let events = read(file);
        assert_eq!(events[0]["event"], "log.open", "{file:?}");
        for pair in events.windows(2) {
            assert_eq!(
                pair[1]["seq"].as_u64().unwrap(),
                pair[0]["seq"].as_u64().unwrap() + 1,
                "{file:?}"
            );
        }
    }
    assert!(
        current[0]["seq"].as_u64().unwrap() > read(&generation(1))[0]["seq"].as_u64().unwrap(),
        "seq does not continue across the rotation"
    );
    for position in 2..files.len() {
        assert!(
            read(&files[position])[0]["seq"].as_u64().unwrap()
                > read(&files[position - 1])[0]["seq"].as_u64().unwrap(),
            "generation {position} does not follow generation {}",
            position - 1
        );
    }
}

// contract: log.writer.refuses-an-unbounded-file
#[test]
fn a_log_without_a_rotation_bound_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let mut opts = options(directory.path());
    opts.rotate_bytes = 0;
    match EventLog::start(opts) {
        Err(error) => assert!(error.contains("rotate_bytes"), "{error}"),
        Ok(_) => panic!("a log without a rotation bound started"),
    }
}

// contract: log.writer.announces-each-write-to-the-observer
#[test]
fn the_writer_announces_each_write_to_its_observer() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start(options(directory.path())).unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    log.set_on_write(Box::new(move |path, size| {
        let _ = sender.send((path.to_path_buf(), size));
    }));
    assert!(log.emit(Level::Info, "host.test.event", &json!({"index": 1})));
    log.flush(Duration::from_secs(5)).unwrap();
    let (path, size) = receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("the write was not announced");
    assert_eq!(path.file_name().unwrap(), "host-b1.jsonl");
    assert_eq!(size, std::fs::metadata(&path).unwrap().len());
}
