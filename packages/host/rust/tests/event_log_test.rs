//! The event writer of the host (docs/spec/logging.md#writers): events enter a bounded queue without blocking, one
//! writer thread assigns `seq`, writes batches and counts the loss, and the file follows the contract that
//! `@soksak/log-contract` audits.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use soksak_host::event_log::{self, EventLog, Level, Options, RelayedEvent};
use soksak_host::platform;

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
        wake: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: 1 << 40,
    }
}

// contract: log.writer.assigns-seq-and-opens-with-log-open
#[test]
fn the_first_line_is_log_open_and_seq_is_consecutive() {
    let directory = folder::Folder::new();
    let log = event_log::start(options(directory.path())).unwrap();
    records::store_every_level(&log);
    for index in 0..10 {
        assert!(log.emit(Level::Info, "host.test.event", &json!({"index": index})));
    }
    let path = log.path().to_path_buf();
    log.flush().unwrap();
    let events = read(&path);
    assert_eq!(events[0]["event"], "log.open");
    assert_eq!(events[0]["fields"]["schema"], 3);
    assert_eq!(events[0]["fields"]["role"], "host");
    assert_eq!(events[0]["fields"]["boot"], "b1");
    let seqs: Vec<u64> = events.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, (1..=12).collect::<Vec<u64>>());
    assert_eq!(events[6]["fields"]["index"], 4);
    assert!(
        events
            .iter()
            .all(|e| e["ts_us"].as_u64().unwrap() > 1_700_000_000_000_000)
    );
}

/// Holds the writer thread in its write observer, as a slow disk holds it: while the writer is held it takes nothing from the
/// queue, so the queue fills and stays full.
struct Hold {
    armed: Arc<AtomicBool>,
    entered: Receiver<()>,
    release: SyncSender<()>,
}

fn hold_writer(log: &EventLog) -> Hold {
    let armed = Arc::new(AtomicBool::new(false));
    let (entered_sender, entered) = sync_channel(1);
    let (release, released) = sync_channel(0);
    let observer_armed = Arc::clone(&armed);
    let entered_sender = Mutex::new(entered_sender);
    let released = Mutex::new(released);
    log.set_on_write(Box::new(move |_, _| {
        if observer_armed.swap(false, Ordering::SeqCst) {
            entered_sender.lock().unwrap().send(()).unwrap();
            released.lock().unwrap().recv().unwrap();
        }
    }));
    Hold {
        armed,
        entered,
        release,
    }
}

/// Holds the writer, emits 20 events into a queue of 4 and releases the writer; returns the accepted and the refused events.
/// An error is written without waiting for the batch interval, so its write is where the writer is held.
fn refuse_while_held(log: &EventLog, hold: &Hold, first: u64) -> (u64, u64) {
    hold.armed.store(true, Ordering::SeqCst);
    assert!(log.emit(
        Level::Error,
        "host.test.failure",
        &json!({"reason": "the writer is held"})
    ));
    hold.entered
        .recv()
        .expect("the writer did not write the error");
    let (mut accepted, mut refused) = (0, 0);
    for index in first..first + 20 {
        if log.emit(Level::Info, "host.test.event", &json!({"index": index})) {
            accepted += 1;
        } else {
            refused += 1;
        }
    }
    hold.release.send(()).unwrap();
    (accepted, refused)
}

/// The `log.dropped` events of a run, after checking that each names `count` consecutive `seq` before its own and that the
/// stored events and the named ranges hold every `seq` from 1 once.
fn dropped_ranges(events: &[Value]) -> Vec<&Value> {
    let mut seqs: Vec<u64> = Vec::new();
    let mut dropped = Vec::new();
    for event in events {
        let seq = event["seq"].as_u64().unwrap();
        seqs.push(seq);
        if event["event"] == "log.dropped" {
            let fields = &event["fields"];
            let (from, to) = (
                fields["from_seq"].as_u64().unwrap(),
                fields["to_seq"].as_u64().unwrap(),
            );
            assert_eq!(to + 1 - from, fields["count"].as_u64().unwrap(), "{event}");
            assert!(seq > to, "{event}");
            seqs.extend(from..=to);
            dropped.push(event);
        }
    }
    seqs.sort_unstable();
    assert_eq!(
        seqs,
        (1..=seqs.len() as u64).collect::<Vec<_>>(),
        "{events:?}"
    );
    dropped
}

// contract: log.writer.never-blocks-and-counts-loss
#[test]
fn a_full_queue_returns_false_and_the_writer_records_the_range_as_dropped() {
    let directory = folder::Folder::new();
    let mut opts = options(directory.path());
    opts.queue_events = 4;
    opts.batch_interval = Duration::from_secs(30);
    let log = event_log::start(opts).unwrap();
    records::store_every_level(&log);
    let hold = hold_writer(&log);
    let (accepted, refused) = refuse_while_held(&log, &hold, 0);
    assert_eq!((accepted, refused), (4, 16));
    log.flush().unwrap();
    let events = read(log.path());
    let dropped = dropped_ranges(&events);
    assert_eq!(dropped.len(), 1, "{events:?}");
    assert_eq!(dropped[0]["fields"]["count"], refused);
    assert_eq!(dropped[0]["fields"]["channel"], "other");
    let stored = events
        .iter()
        .filter(|e| e["event"] == "host.test.event")
        .count() as u64;
    assert_eq!(stored, accepted);
}

// contract: log.writer.never-blocks-and-counts-loss
#[test]
fn a_record_of_the_loss_between_two_refusals_splits_them_into_two_dropped_ranges() {
    // The writer records the loss counted so far each time it writes the queue (the end of an interval, an error, a flush or
    // the wakeup of a writer that slept); refusals on both sides of such a write are two ranges.
    let directory = folder::Folder::new();
    let mut opts = options(directory.path());
    opts.queue_events = 4;
    opts.batch_interval = Duration::from_secs(30);
    let log = event_log::start(opts).unwrap();
    records::store_every_level(&log);
    let hold = hold_writer(&log);
    let first = refuse_while_held(&log, &hold, 0);
    log.flush().unwrap();
    let second = refuse_while_held(&log, &hold, 20);
    assert_eq!((first, second), ((4, 16), (4, 16)));
    log.flush().unwrap();
    let events = read(log.path());
    let dropped = dropped_ranges(&events);
    assert_eq!(dropped.len(), 2, "{events:?}");
    let counts: Vec<u64> = dropped
        .iter()
        .map(|e| e["fields"]["count"].as_u64().unwrap())
        .collect();
    assert_eq!(counts, [first.1, second.1]);
    // The four events accepted after the first range are stored between the two ranges.
    let between: Vec<u64> = events
        .iter()
        .filter(|e| {
            e["event"] == "host.test.event"
                && e["seq"].as_u64().unwrap() > dropped[0]["seq"].as_u64().unwrap()
                && e["seq"].as_u64().unwrap() < dropped[1]["fields"]["from_seq"].as_u64().unwrap()
        })
        .map(|e| e["fields"]["index"].as_u64().unwrap())
        .collect();
    assert_eq!(between, [20, 21, 22, 23]);
    let stored = events
        .iter()
        .filter(|e| e["event"] == "host.test.event")
        .count() as u64;
    assert_eq!(stored, first.0 + second.0);
}

// contract: log.writer.error-wakes-the-writer
#[test]
fn an_error_is_written_without_waiting_for_the_batch_interval() {
    let directory = folder::Folder::new();
    let mut opts = options(directory.path());
    opts.batch_interval = Duration::from_secs(30);
    let log = event_log::start(opts).unwrap();
    records::store_every_level(&log);
    let (wrote, writes) = std::sync::mpsc::channel();
    log.set_on_write(Box::new(move |_, _| {
        wrote.send(()).unwrap();
    }));
    assert!(log.emit(
        Level::Error,
        "host.test.failure",
        &json!({"reason": "disk"})
    ));
    let path = log.path().to_path_buf();
    // The interval of 30 seconds ends in no test, so a write that stores the error was not the write of an interval.
    loop {
        writes.recv().expect("the error was not written");
        if read(&path)
            .iter()
            .any(|e| e["event"] == "host.test.failure")
        {
            break;
        }
    }
    log.flush().unwrap();
}

// contract: log.writer.files-are-private
#[test]
fn the_folder_is_0700_and_the_file_is_0600() {
    use std::os::unix::fs::PermissionsExt;
    let directory = folder::Folder::new();
    let log = event_log::start(options(directory.path())).unwrap();
    records::store_every_level(&log);
    let path = log.path().to_path_buf();
    log.flush().unwrap();
    let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(path.parent().unwrap()), 0o700);
}

// contract: log.writer.output-follows-the-contract
#[test]
fn the_file_passes_the_audit_of_the_contract_package() {
    let directory = folder::Folder::new();
    let log = event_log::start(options(directory.path())).unwrap();
    records::store_every_level(&log);
    for _ in 0..20 {
        log.emit(Level::Info, "host.app.event", &json!({"kind": "started"}));
    }
    let path = log.path().to_path_buf();
    log.flush().unwrap();
    let catalog = directory.path().join("catalog.json");
    fs::write(&catalog, json!({
        "schema": 3,
        "layers": ["host"],
        "events": {
            "log.open": {"layer": "host", "class": "lifecycle", "level": "info",
                "fields": {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
                    "properties": {"schema": {"type": "number"}, "pid": {"type": "number"},
                        "role": {"type": "string"}, "boot": {"type": "string"}},
                    "required": ["schema", "pid", "role", "boot"]}},
            "log.dropped": {"layer": "host", "class": "lifecycle", "level": "warn",
                "fields": {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
                    "properties": {"from_seq": {"type": "number"}, "to_seq": {"type": "number"},
                        "count": {"type": "number"}, "bytes": {"type": "number"},
                        "reason": {"type": "string"}, "channel": {"type": "string"},
                        "queued": {"type": "number"}},
                    "required": ["from_seq", "to_seq", "count", "bytes", "reason", "channel"]}},
            "log.policy": {"layer": "host", "class": "lifecycle", "level": "info",
                "fields": {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
                    "properties": {"source": {"type": "string"}, "classes": {"type": "object"}},
                    "required": ["source", "classes"]}},
            "host.app.event": {"layer": "host", "class": "lifecycle", "level": "info",
                "fields": {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
                    "properties": {"kind": {"type": "string"}}, "required": ["kind"]}}
        }
    }).to_string()).unwrap();
    // The audit command of the repository audits the log with the event contract and prints the findings as JSON.
    let audit = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../scripts/audit-log.mjs"
    );
    let output = Command::new("node")
        .args([audit, path.to_str().unwrap(), catalog.to_str().unwrap()])
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
    let directory = folder::Folder::new();
    let mut opts = options(directory.path());
    opts.batch_interval = Duration::from_secs(30);
    let log = event_log::start(opts).unwrap();
    records::store_every_level(&log);
    for index in 0..40 {
        assert!(log.emit(Level::Info, "host.test.event", &json!({"index": index})));
    }
    let path = log.path().to_path_buf();
    log.flush().unwrap();
    let stored = read(&path)
        .iter()
        .filter(|e| e["event"] == "host.test.event")
        .count();
    assert_eq!(stored, 40);
}

// contract: log.writer.relays-events-with-their-layer-and-time
#[test]
fn a_relayed_event_keeps_its_layer_and_time_and_gets_the_seq_of_the_writer() {
    let directory = folder::Folder::new();
    let log = event_log::start(options(directory.path())).unwrap();
    records::store_every_level(&log);
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
    log.flush().unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(events[2]["layer"], "page");
    assert_eq!(events[2]["ts_us"], 1_791_000_000_000_123u64);
    assert_eq!(events[2]["mono_ns"], 5_000_000_123u64);
    assert_eq!(events[2]["cids"], json!(["b1.7", "b1.8"]));
    assert_eq!(events[2]["seq"], 3);
    assert_eq!(events[2]["level"], "warn");
    assert_eq!(events[2]["fields"]["index"], 7);
}

// contract: log.writer.names-the-writing-document
#[test]
fn a_relayed_event_names_the_document_that_wrote_it_in_the_member_of_its_layer() {
    let directory = folder::Folder::new();
    let log = event_log::start(options(directory.path())).unwrap();
    records::store_every_level(&log);
    let named = |layer: &str, event: &str, page: Option<&str>, start: Option<&str>| RelayedEvent {
        page: page.map(str::to_string),
        start: start.map(str::to_string),
        ..relayed(layer, event, Level::Info, json!({}))
    };
    for accepted in [
        named("workbench", "workbench.test.event", None, Some("S1")),
        named("page", "page.test.event", Some("P1"), None),
        named("plugin", "plugin.probe.saved", None, Some("S1")),
        named("plugin", "plugin.probe.saved", Some("P1"), None),
    ] {
        assert_eq!(log.emit_relayed(accepted), Ok(true));
    }
    for (event, want) in [
        (
            named("workbench", "workbench.test.event", None, None),
            "the event workbench.test.event of the layer workbench names its writer in start",
        ),
        (
            named("workbench", "workbench.test.event", Some("P1"), Some("S1")),
            "the event workbench.test.event of the layer workbench names page, which only an event of the layer page or plugin names",
        ),
        (
            named("page", "page.test.event", Some("P1"), Some("S1")),
            "the event page.test.event of the layer page names start, which only an event of the layer workbench or plugin names",
        ),
        (
            named("plugin", "plugin.probe.saved", Some("P1"), Some("S1")),
            "the event plugin.probe.saved of the layer plugin names its writer in one of page and start, not both",
        ),
        (
            named("plugin", "plugin.probe.saved", None, None),
            "the event plugin.probe.saved of the layer plugin names its writer in page or start",
        ),
        (
            named("native", "native.test.event", None, Some("S1")),
            "the event native.test.event of the layer native names start, which only an event of the layer workbench or plugin names",
        ),
    ] {
        assert_eq!(log.emit_relayed(event).unwrap_err(), want);
    }
    let path = log.path().to_path_buf();
    log.flush().unwrap();
    let events = read(&path);
    assert_eq!(events.len(), 6, "{events:?}");
    let members: Vec<(Option<&str>, Option<&str>)> = events[2..]
        .iter()
        .map(|event| {
            (
                event.get("page").and_then(Value::as_str),
                event.get("start").and_then(Value::as_str),
            )
        })
        .collect();
    assert_eq!(
        members,
        [
            (None, Some("S1")),
            (Some("P1"), None),
            (None, Some("S1")),
            (Some("P1"), None)
        ]
    );
}

/// A relayed event of the layer with the time, the monotonic clock and the identifiers that the tests expect.
fn relayed(layer: &str, event: &str, level: Level, fields: Value) -> RelayedEvent {
    RelayedEvent {
        ts_us: 1_791_000_000_000_123,
        mono_ns: 5_000_000_123,
        layer: layer.to_string(),
        // An event of a view page or a plugin names its page and an event of the workbench its start; another layer names none.
        page: matches!(layer, "page" | "plugin").then(|| "1791948729050".to_string()),
        start: (layer == "workbench").then(|| "1791948729050".to_string()),
        level,
        event: event.to_string(),
        cids: vec!["b1.7".into(), "b1.8".into()],
        fields: soksak_host::bounds::Fields::whole(
            serde_json::value::to_raw_value(&fields).unwrap(),
        ),
    }
}

// contract: log.writer.stores-both-clocks
#[test]
fn every_line_carries_the_wall_clock_and_the_monotonic_clock_of_its_call() {
    let system = platform::current().unwrap();
    let directory = folder::Folder::new();
    let before_wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64;
    let before = system.monotonic_ns().unwrap();
    let log = event_log::start(options(directory.path())).unwrap();
    records::store_every_level(&log);
    for index in 0..20 {
        assert!(log.emit(Level::Info, "host.test.event", &json!({"index": index})));
    }
    let path = log.path().to_path_buf();
    log.flush().unwrap();
    let after = system.monotonic_ns().unwrap();
    let after_wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64;
    let events = read(&path);
    assert_eq!(events.len(), 22);
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
    let directory = folder::Folder::new();
    let log = event_log::start(options(directory.path())).unwrap();
    records::store_every_level(&log);
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
    log.flush().unwrap();
    let events = read(&path);
    assert_eq!(events[2]["cids"], json!(["b1.1", "b1.2"]));
    assert!(events[3].get("cids").is_none(), "{}", events[3]);
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
    let directory = folder::Folder::new();
    let mut opts = options(directory.path());
    opts.rotate_bytes = 4000;
    // The queue holds every event, so no refusal makes a gap of seq that log.dropped would explain.
    opts.queue_events = 1000;
    let log = event_log::start(opts).unwrap();
    records::store_every_level(&log);
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
    log.flush().unwrap();
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
    // The latest archived file contains the exact number of bytes reported by log.rotated.
    let full = current[1]["fields"]["bytes"].as_u64().unwrap();
    assert_eq!(
        full,
        fs::metadata(generation(files.len() - 1)).unwrap().len(),
        "log.rotated bytes"
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
    let directory = folder::Folder::new();
    let mut opts = options(directory.path());
    opts.rotate_bytes = 0;
    match event_log::start(opts) {
        Err(error) => assert!(error.contains("rotate_bytes"), "{error}"),
        Ok(_) => panic!("a log without a rotation bound started"),
    }
}

// contract: log.writer.announces-each-write-to-the-observer
#[test]
fn the_writer_announces_each_write_to_its_observer() {
    let directory = folder::Folder::new();
    let log = event_log::start(options(directory.path())).unwrap();
    records::store_every_level(&log);
    let (sender, receiver) = std::sync::mpsc::channel();
    log.set_on_write(Box::new(move |path, size| {
        let _ = sender.send((path.to_path_buf(), size));
    }));
    assert!(log.emit(Level::Info, "host.test.event", &json!({"index": 1})));
    log.flush().unwrap();
    let (path, size) = receiver.recv().expect("the write was not announced");
    assert_eq!(path.file_name().unwrap(), "host-b1.jsonl");
    assert_eq!(size, std::fs::metadata(&path).unwrap().len());
}

// contract: log.writer.writes-each-interval
#[test]
fn a_steady_stream_of_events_is_written_at_each_batch_interval() {
    // Events arrive every 5 ms, faster than the batch interval of 50 ms, so a writer that waits for a quiet interval
    // writes nothing while they arrive.
    let directory = folder::Folder::new();
    let mut opts = options(directory.path());
    opts.queue_events = 4096;
    opts.queue_bytes = 1 << 22;
    opts.batch_interval = Duration::from_millis(50);
    let log = event_log::start(opts).unwrap();
    records::store_every_level(&log);
    let (wrote, writes) = std::sync::mpsc::channel();
    log.set_on_write(Box::new(move |_, _| {
        wrote.send(()).unwrap();
    }));
    // The first event is written at once, by a writer that slept or at the end of its interval; the second write comes while
    // the stream still runs. The pause between two events only keeps the stream steady and decides nothing. A writer that
    // waits for a quiet interval does not write again while the stream runs, and the check stops at the limit of its runner.
    let (mut index, mut written) = (0, 0);
    while written < 2 {
        assert!(log.emit(Level::Info, "host.test.event", &json!({"index": index})));
        index += 1;
        written += writes.try_iter().count();
        std::thread::sleep(Duration::from_millis(5));
    }
    log.flush().unwrap();
}
