//! Checks that the writer gates a plugin event by its class, that an undeclared plugin event takes the class lifecycle and is
//! gated as it, and that the view end record passes every gate (docs/spec/logging.md#principles, #policy).

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use soksak_sok::event_bounds::Fields;
use soksak_sok::event_classes::Class;
use soksak_sok::event_log::{Level, RelayedEvent};

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

#[path = "support/policy.rs"]
mod support;

fn relay(event: &str, level: Level) -> RelayedEvent {
    RelayedEvent {
        ts_us: 1,
        mono_ns: 1,
        layer: "plugin".into(),
        page: Some("page-1".into()),
        level,
        event: event.into(),
        cids: vec![],
        fields: Fields::of(&json!({"sequence": 1})).unwrap(),
    }
}

fn stored_lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|error| panic!("{line:?}: {error}")))
        .collect()
}

fn lifecycle_off() -> soksak_sok::log_policy::LogPolicy {
    soksak_sok::log_policy::LogPolicy::parse(
        "log-policy.json",
        br#"{"schema":1,"classes":{"lifecycle":"error","input":"error","call":"error","io":"error","frame":"error"}}"#,
    )
    .unwrap()
}

// contract: log.plugin-gate.undeclared-takes-lifecycle
#[test]
fn an_undeclared_plugin_event_is_stored_with_the_class_lifecycle_and_marked_undeclared() {
    let dir = Folder::new("plugin-gate-undeclared");
    support::store_every_level(dir.path());
    let log = soksak_sok::start_tool_event_log(dir.path()).unwrap();
    assert_eq!(
        log.emit_relayed(relay("plugin.probe.other", Level::Info)),
        Ok(true)
    );
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let lines = stored_lines(log.path());
    let stored: Vec<&Value> = lines
        .iter()
        .filter(|line| line["event"] == "plugin.probe.other")
        .collect();
    assert_eq!(stored.len(), 1, "{lines:?}");
    assert_eq!(stored[0]["class"], "lifecycle", "{lines:?}");
    assert_eq!(stored[0]["undeclared"], true, "{lines:?}");
}

// contract: log.plugin-gate.undeclared-takes-lifecycle
#[test]
fn an_undeclared_plugin_event_under_a_policy_that_turns_lifecycle_off_is_refused_and_counted() {
    let dir = Folder::new("plugin-gate-refused");
    support::store_every_level(dir.path());
    let log = soksak_sok::start_tool_event_log(dir.path()).unwrap();
    log.set_policy(lifecycle_off(), "file");
    assert_eq!(
        log.emit_relayed(relay("plugin.probe.other", Level::Info)),
        Ok(false)
    );
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let lines = stored_lines(log.path());
    assert!(
        lines
            .iter()
            .all(|line| line["event"] != "plugin.probe.other"),
        "a gated plugin event was stored: {lines:?}"
    );
    assert!(
        lines.iter().any(|line| line["event"] == "log.gated"
            && line["fields"]["class"] == "lifecycle"
            && line["fields"]["level"] == "info"
            && line["fields"]["count"] == 1),
        "the refused plugin event is not counted in log.gated: {lines:?}"
    );
}

// contract: log.plugin-gate.refuses-below-the-class-level
#[test]
fn a_plugin_event_below_the_level_of_its_class_is_refused_by_the_writer_and_counted() {
    let dir = Folder::new("plugin-gate-class");
    support::store_every_level(dir.path());
    let log = soksak_sok::start_tool_event_log(dir.path()).unwrap();
    log.set_plugin_classes(HashMap::from([(
        "plugin.probe.frame".to_string(),
        Class::Frame,
    )]));
    log.set_policy(
        soksak_sok::log_policy::LogPolicy::parse(
            "log-policy.json",
            br#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"error"}}"#,
        )
        .unwrap(),
        "file",
    );
    assert_eq!(
        log.emit_relayed(relay("plugin.probe.frame", Level::Info)),
        Ok(false)
    );
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let lines = stored_lines(log.path());
    assert!(
        lines
            .iter()
            .all(|line| line["event"] != "plugin.probe.frame"),
        "a plugin event below its class level was stored: {lines:?}"
    );
    assert!(
        lines.iter().any(|line| line["event"] == "log.gated"
            && line["fields"]["class"] == "frame"
            && line["fields"]["count"] == 1),
        "the refused plugin event is not counted in log.gated: {lines:?}"
    );
}

// contract: host.view.killed.passes-every-gate
#[test]
fn the_view_end_record_is_stored_under_a_policy_that_turns_lifecycle_off() {
    let dir = Folder::new("plugin-gate-view-killed");
    support::store_every_level(dir.path());
    let log = soksak_sok::start_tool_event_log(dir.path()).unwrap();
    log.set_policy(lifecycle_off(), "file");
    assert!(
        log.emit(
            Level::Warn,
            "host.view.killed",
            &json!({"plugin": "probe", "surface": "view-1", "unsent": true}),
        ),
        "host.view.killed was refused"
    );
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let lines = stored_lines(log.path());
    let stored: Vec<&Value> = lines
        .iter()
        .filter(|line| line["event"] == "host.view.killed")
        .collect();
    assert_eq!(stored.len(), 1, "{lines:?}");
    assert_eq!(stored[0]["level"], "warn", "{lines:?}");
    assert_eq!(stored[0]["class"], "lifecycle", "{lines:?}");
}
