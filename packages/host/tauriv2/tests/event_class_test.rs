//! The class of an event line (docs/spec/logging.md#event): the writer stores the class that the catalog declares for the
//! event name, and marks an event the catalog does not declare.

use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use soksak_host_tauriv2::bounds::Fields;
use soksak_host_tauriv2::event_log::{EventLog, Level, Options, RelayedEvent};

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
        rotate_bytes: 1 << 30,
        pull: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: 1 << 40,
    }
}

fn relayed(layer: &str, event: &str, fields: &str) -> RelayedEvent {
    RelayedEvent {
        ts_us: 1,
        mono_ns: 1,
        layer: layer.into(),
        level: Level::Info,
        event: event.into(),
        cids: Vec::new(),
        fields: Fields::whole(serde_json::value::RawValue::from_string(fields.into()).unwrap()),
    }
}

// contract: log.writer.stores-class
#[test]
fn every_line_stores_the_class_of_its_catalog_entry() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start(options(directory.path())).unwrap();
    assert!(log.emit(Level::Info, "host.app.event", &json!({"kind": "started"})));
    assert!(log.emit_cids(
        Level::Info,
        "host.input.relay",
        &["b1.1".to_string()],
        &json!({"surface": "s", "name": "n", "type": "t"})
    ));
    assert!(log.emit(
        Level::Info,
        "host.sidecar.reply",
        &json!({"name": "n", "surface": "s", "bytes": 1, "ok": true})
    ));
    assert!(log
        .emit_relayed(relayed("page", "page.start", r#"{"time_origin":1,"url":"u"}"#))
        .unwrap());
    assert!(log
        .emit_relayed(relayed("page", "page.console.info", r#"{"text":"x"}"#))
        .unwrap());
    log.flush(Duration::from_secs(5)).unwrap();
    let want = [
        ("log.open", "lifecycle"),
        ("host.app.event", "lifecycle"),
        ("host.input.relay", "input"),
        ("host.sidecar.reply", "io"),
        ("page.start", "lifecycle"),
        ("page.console.info", "lifecycle"),
    ];
    let events = read(log.path());
    for (name, class) in want {
        let event = events
            .iter()
            .find(|event| event["event"] == name)
            .unwrap_or_else(|| panic!("{name} was not stored"));
        assert_eq!(event["class"], class, "{event}");
        assert!(event.get("undeclared").is_none(), "{event}");
    }
}

// contract: log.writer.marks-undeclared
#[test]
fn an_event_the_catalog_does_not_declare_is_marked_undeclared_and_has_no_class() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start(options(directory.path())).unwrap();
    assert!(log.emit(Level::Info, "host.test.event", &json!({"index": 1})));
    assert!(log
        .emit_relayed(relayed("plugin", "plugin.editor.opened", "{}"))
        .unwrap());
    log.flush(Duration::from_secs(5)).unwrap();
    let events = read(log.path());
    let marked: Vec<&Value> = events
        .iter()
        .filter(|event| event["event"] == "host.test.event" || event["event"] == "plugin.editor.opened")
        .collect();
    assert_eq!(marked.len(), 2);
    for event in marked {
        assert_eq!(event["undeclared"], true, "{event}");
        assert!(event.get("class").is_none(), "{event}");
    }
}

// contract: log.writer.stores-class
#[test]
fn the_events_of_the_writer_itself_store_their_class() {
    let directory = tempfile::tempdir().unwrap();
    let mut opts = options(directory.path());
    opts.rotate_bytes = 600;
    opts.queue_events = 4;
    opts.batch_interval = Duration::from_secs(30);
    let log = EventLog::start(opts).unwrap();
    for _ in 0..40 {
        log.emit(Level::Info, "host.app.event", &json!({"kind": "started"}));
    }
    log.flush(Duration::from_secs(5)).unwrap();
    let mut names = Vec::new();
    let path = log.path().to_path_buf();
    for name in [".1", ".2", ".3", ""] {
        let file = format!("{}{name}", path.display());
        if !Path::new(&file).exists() {
            continue;
        }
        for event in read(Path::new(&file)) {
            if matches!(
                event["event"].as_str(),
                Some("log.open" | "log.rotated" | "log.dropped")
            ) {
                assert_eq!(event["class"], "lifecycle", "{event}");
                names.push(event["event"].as_str().unwrap().to_string());
            }
        }
    }
    for want in ["log.rotated", "log.dropped"] {
        assert!(names.iter().any(|name| name == want), "{names:?}");
    }
}
