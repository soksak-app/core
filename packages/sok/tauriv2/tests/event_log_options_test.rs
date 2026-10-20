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

// contract: cli.log.writer-options.records-refused-events-as-loss-before-the-next-accepted-event
#[test]
fn refused_events_are_recorded_as_loss_before_the_next_accepted_event() {
    let directory = Folder::new("options-full-queue");
    let mut full = options(directory.path(), "full-queue");
    full.queue_events = 2;
    // The pull runs on the writer thread at each drain. Holding it there keeps the writer from taking the queued events, so the
    // queue stays full until the test releases it.
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let mut entered_tx = Some(entered_tx);
    full.pull = Some(Box::new(move |_sink: &mut dyn PullSink| {
        if let Some(entered) = entered_tx.take() {
            entered.send(()).unwrap();
            release_rx.recv().unwrap();
        }
    }));
    let log = EventLog::start(full).unwrap();
    let policy = soksak_sok::log_policy::LogPolicy::parse(
        "log-policy.json",
        br#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}"#,
    )
    .unwrap();
    log.set_policy(policy, "file");
    entered_rx.recv().unwrap();
    assert!(log.emit(Level::Warn, "host.stall.dump", &json!({"path": "/first"})));
    assert!(log.emit(Level::Warn, "host.stall.dump", &json!({"path": "/second"})));
    for _ in 0..2 {
        let error = log
            .emit_placed(
                Level::Warn,
                "host.stall.dump",
                serde_json::value::RawValue::from_string(r#"{"path":"/refused"}"#.into()).unwrap(),
                Duration::from_secs(5),
            )
            .unwrap_err();
        assert_eq!(
            error, "the event writer refused host.stall.dump because its queue was full",
            "{error}"
        );
    }
    release_tx.send(()).unwrap();
    log.flush(Duration::from_secs(5)).unwrap();
    assert!(log.emit(Level::Info, "sok.command", &json!({"name": "after"})));
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let lines = stored_lines(log.path());
    let dropped = lines
        .iter()
        .position(|line| line["event"] == "log.dropped")
        .unwrap_or_else(|| panic!("no log.dropped records the two refused events: {lines:?}"));
    assert_eq!(lines[dropped]["fields"]["count"], 2, "{lines:?}");
    assert_eq!(
        lines[dropped]["fields"]["reason"], "the queue was full",
        "{lines:?}"
    );
    assert_eq!(lines[dropped]["fields"]["channel"], "other", "{lines:?}");
    assert_eq!(lines[dropped]["fields"]["queued"], 2, "{lines:?}");
    assert_eq!(lines[dropped]["level"], "warn", "{lines:?}");
    let after = lines
        .iter()
        .position(|line| line["event"] == "sok.command" && line["fields"]["name"] == "after")
        .unwrap_or_else(|| panic!("the event after the refusals is not stored: {lines:?}"));
    assert!(
        dropped < after,
        "log.dropped is stored after the next accepted event: {lines:?}"
    );
}

// contract: cli.log.writer-options.refuses-a-placed-event-by-its-cause
#[test]
fn a_placed_event_refused_by_the_policy_names_the_policy() {
    let directory = Folder::new("options-policy-refusal");
    let log = EventLog::start(options(directory.path(), "policy-refusal")).unwrap();
    // The default policy stores only errors, so a warning of a lifecycle class is refused by the gate and not by the queue.
    let error = log
        .emit_placed(
            Level::Warn,
            "host.stall.dump",
            serde_json::value::RawValue::from_string(r#"{"path":"/probe"}"#.into()).unwrap(),
            Duration::from_secs(5),
        )
        .unwrap_err();
    assert_eq!(
        error, "the event writer refused host.stall.dump because the policy does not store it",
        "{error}"
    );
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let lines = stored_lines(log.path());
    assert!(
        lines.iter().all(|line| line["event"] != "log.dropped"),
        "a gated event was recorded as a loss: {lines:?}"
    );
    assert!(
        lines.iter().any(|line| line["event"] == "log.gated"
            && line["fields"]["class"] == "lifecycle"
            && line["fields"]["level"] == "warn"
            && line["fields"]["count"] == 1),
        "the gated event is not recorded by log.gated: {lines:?}"
    );
}

// contract: log.closed.passes-every-gate
#[test]
fn a_closed_record_is_stored_under_a_policy_that_turns_lifecycle_off() {
    let directory = Folder::new("closed-record");
    let log = EventLog::start(options(directory.path(), "b1")).unwrap();
    let policy = soksak_sok::log_policy::LogPolicy::parse(
        "log-policy.json",
        br#"{"schema":1,"classes":{"lifecycle":"error","input":"error","call":"error","io":"error","frame":"error"}}"#,
    )
    .unwrap();
    log.set_policy(policy, "file");
    assert!(
        log.record_closed("signal", Some(15)),
        "the record was refused"
    );
    log.flush(Duration::from_secs(5)).unwrap();
    let events = stored_lines(log.path());
    let closed: Vec<&Value> = events
        .iter()
        .filter(|event| event["event"] == "log.closed")
        .collect();
    assert_eq!(closed.len(), 1, "{events:?}");
    assert_eq!(closed[0]["level"], "info", "{events:?}");
    assert_eq!(closed[0]["class"], "lifecycle", "{events:?}");
    assert_eq!(
        closed[0]["fields"],
        json!({"cause": "signal", "signal": 15}),
        "{events:?}"
    );
}
