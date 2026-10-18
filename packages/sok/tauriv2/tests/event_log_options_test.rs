//! Checks the options of the shared event writer that the hosts and the tool start (docs/spec/logging.md#writers): the layer
//! and the clock of its own events, the thread entrance, the rotation that a writer may omit, the correlation identifiers,
//! and the source of events that cannot call into the writer.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use soksak_sok::event_bounds::Fields;
use soksak_sok::event_log::{Channel, EventLog, Level, Options, PullSink, RelayedEvent};

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

fn options(directory: &Path, boot: &str) -> Options {
    Options {
        directory: directory.to_path_buf(),
        role: "probe".into(),
        boot: boot.into(),
        layer: "host",
        clock: || 42,
        spawn: |body| {
            std::thread::Builder::new()
                .name("probe-writer".into())
                .spawn(body)
                .map_err(|error| error.to_string())
        },
        queue_events: 64,
        queue_bytes: 1 << 20,
        batch_interval: Duration::from_millis(10),
        rotate_bytes: 0,
        pull: None,
        policy_path: None,
        prune: None,
    }
}

fn stored_lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|error| panic!("{line:?}: {error}")))
        .collect()
}

// contract: cli.log.writer-options.stores-the-layer-the-clock-and-the-cids
#[test]
fn a_writer_without_rotation_stores_the_layer_the_clock_and_the_cids_of_its_options() {
    let directory = Folder::new("options-plain");
    let log = EventLog::start(options(directory.path(), "plain")).unwrap();
    assert!(log.emit_cids(
        Level::Info,
        "host.probe.event",
        &["c1".into(), "c2".into()],
        &json!({"n": 1})
    ));
    assert!(!log.emit_cids(Level::Info, "host.probe.bad", &["a\"b".into()], &json!({})));
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let lines = stored_lines(log.path());
    let events: Vec<&str> = lines.iter().map(|l| l["event"].as_str().unwrap()).collect();
    assert_eq!(events, ["log.open", "host.probe.event", "log.dropped"]);
    for line in &lines {
        assert_eq!(line["layer"], "host");
        assert_eq!(line["mono_ns"], 42);
    }
    assert_eq!(lines[1]["cids"], json!(["c1", "c2"]));
}

// contract: cli.log.writer-options.rotates-at-its-bound
#[test]
fn a_writer_rotates_at_its_bound_and_the_new_file_starts_with_log_open_and_log_rotated() {
    let directory = Folder::new("options-rotating");
    let mut rotating = options(directory.path(), "rotating");
    rotating.rotate_bytes = 600;
    let log = EventLog::start(rotating).unwrap();
    for _ in 0..20 {
        log.emit(
            Level::Info,
            "host.probe.event",
            &json!({"text": "x".repeat(100)}),
        );
    }
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let mut first_generation = log.path().as_os_str().to_owned();
    first_generation.push(".1");
    assert!(PathBuf::from(first_generation).exists());
    let lines = stored_lines(log.path());
    assert!(lines.len() >= 3);
    assert_eq!(lines[0]["event"], "log.open");
    assert_eq!(lines[1]["event"], "log.rotated");
}

// contract: cli.log.writer-options.stores-the-events-and-the-loss-of-its-pull-source
#[test]
fn a_writer_stores_the_events_and_the_loss_of_its_pull_source() {
    let directory = Folder::new("options-pulling");
    let mut pulling = options(directory.path(), "pulling");
    let mut delivered = false;
    pulling.pull = Some(Box::new(move |sink: &mut dyn PullSink| {
        if delivered {
            return;
        }
        delivered = true;
        sink.accept(RelayedEvent {
            ts_us: 7,
            mono_ns: 9,
            layer: "native".into(),
            page: None,
            level: Level::Warn,
            event: "native.probe.event".into(),
            cids: Vec::new(),
            fields: Fields::whole(
                serde_json::value::RawValue::from_string(r#"{"a":1}"#.into()).unwrap(),
            ),
        });
        sink.lost(3, 30, "the source was full", Channel::Other);
    }));
    let log = EventLog::start(pulling).unwrap();
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let lines = stored_lines(log.path());
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert_eq!(lines[1]["event"], "native.probe.event");
    assert_eq!(lines[1]["layer"], "native");
    assert_eq!(lines[1]["mono_ns"], 9);
    assert_eq!(lines[2]["event"], "log.dropped");
    assert_eq!(lines[2]["fields"]["reason"], "the source was full");
    assert_eq!(lines[2]["fields"]["count"], 3);
}
