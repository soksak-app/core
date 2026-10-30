//! The host gives the writer the classes that the catalogs of the enabled installed plugins declare, and records a catalog that
//! it cannot use as an error that names the file (docs/spec/logging.md#plugin-catalogs).

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use soksak_host_tauriv2::event_log::{Level, Options};
use soksak_host_tauriv2::event_record::use_host_event_log;
use soksak_host_tauriv2::installed::apply_plugin_event_classes;

fn write_plugin(config: &Path, id: &str, catalog: &str) -> String {
    let folder = config.join("plugins").join(id).join("1.0.0");
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        folder.join("plugin.json"),
        format!(r#"{{"id":"{id}","events":"events.json"}}"#),
    )
    .unwrap();
    fs::write(folder.join("events.json"), catalog).unwrap();
    folder.join("events.json").display().to_string()
}

// contract: log.plugin-catalog.host-applies-the-installed-catalogs
#[test]
fn the_host_classifies_plugin_events_by_the_installed_catalogs_and_records_a_catalog_it_cannot_use()
{
    let directory = folder::Folder::new();
    let log = Arc::new(
        records::start_every_level(Options {
            directory: directory.path().join("logs"),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 64,
            queue_bytes: 64 << 20,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    );
    use_host_event_log(Some(Arc::clone(&log)));
    let config = directory.path().join("config");
    write_plugin(
        &config,
        "probe",
        r#"{"schema":3,"events":{"plugin.probe.frame":{"layer":"plugin","class":"frame","level":"debug","fields":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"sequence":{"type":"number"}},"required":["sequence"]}}}}"#,
    );
    let broken = write_plugin(&config, "broken", r#"{"events":"#);
    fs::write(
        config.join("plugins/installed.json"),
        r#"{"format":3,"plugins":{"probe":{"version":"1.0.0","path":"plugins/probe/1.0.0","enabled":true,"sidecars":{}},"broken":{"version":"1.0.0","path":"plugins/broken/1.0.0","enabled":true,"sidecars":{}}},"sidecars":{}}"#,
    )
    .unwrap();
    apply_plugin_event_classes(&log, &config);
    log.emit(Level::Info, "plugin.probe.frame", &json!({"sequence": 1}));
    log.flush(Duration::from_secs(5)).unwrap();
    use_host_event_log(None);
    let events: Vec<Value> = fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let frame = events
        .iter()
        .find(|event| event["event"] == "plugin.probe.frame")
        .unwrap_or_else(|| panic!("no plugin event in {events:?}"));
    assert_eq!(frame["class"], "frame", "{frame}");
    assert!(frame.get("undeclared").is_none(), "{frame}");
    let record = events
        .iter()
        .find(|event| event["event"] == "host.record.error")
        .unwrap_or_else(|| panic!("no error record in {events:?}"));
    assert_eq!(record["fields"]["where"], "plugin catalog", "{record}");
    assert_eq!(
        record["fields"]["text"],
        format!("{broken}: the event catalog of plugin broken is not JSON"),
        "{record}"
    );
}

// contract: log.plugin-catalog.keeps-the-catalogs-of-earlier-plugins
#[test]
fn the_host_keeps_the_classes_of_a_plugin_that_a_change_removed() {
    let directory = folder::Folder::new();
    let log = Arc::new(
        records::start_every_level(Options {
            directory: directory.path().join("logs"),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 64,
            queue_bytes: 64 << 20,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    );
    let config = directory.path().join("config");
    write_plugin(
        &config,
        "probe",
        r#"{"schema":3,"events":{"plugin.probe.frame":{"layer":"plugin","class":"frame","level":"debug","fields":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"sequence":{"type":"number"}},"required":["sequence"]}}}}"#,
    );
    let installed = config.join("plugins/installed.json");
    fs::write(
        &installed,
        r#"{"format":3,"plugins":{"probe":{"version":"1.0.0","path":"plugins/probe/1.0.0","enabled":true,"sidecars":{}}},"sidecars":{}}"#,
    )
    .unwrap();
    apply_plugin_event_classes(&log, &config);
    // The change removes the plugin; a page that loaded it before the change still runs its code until it reloads.
    fs::write(&installed, r#"{"format":3,"plugins":{},"sidecars":{}}"#).unwrap();
    apply_plugin_event_classes(&log, &config);
    log.emit(Level::Info, "plugin.probe.frame", &json!({"sequence": 1}));
    log.flush(Duration::from_secs(5)).unwrap();
    let events: Vec<Value> = fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let frame = events
        .iter()
        .find(|event| event["event"] == "plugin.probe.frame")
        .unwrap_or_else(|| panic!("no plugin event in {events:?}"));
    assert_eq!(frame["class"], "frame", "{frame}");
    assert!(frame.get("undeclared").is_none(), "{frame}");
}

// contract: log.plugin-catalog.records-the-held-catalogs
#[test]
fn the_writer_records_the_plugin_catalogs_it_holds_at_each_apply() {
    let directory = folder::Folder::new();
    let log = Arc::new(
        records::start_every_level(Options {
            directory: directory.path().join("logs"),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 64,
            queue_bytes: 64 << 20,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    );
    use_host_event_log(Some(Arc::clone(&log)));
    let config = directory.path().join("config");
    write_plugin(
        &config,
        "probe",
        r#"{"schema":3,"events":{"plugin.probe.frame":{"layer":"plugin","class":"frame","level":"debug","fields":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"sequence":{"type":"number"}},"required":["sequence"]}}}}"#,
    );
    write_plugin(&config, "broken", r#"{"events":"#);
    let installed = |probe_enabled: &str| {
        format!(
            r#"{{"format":3,"plugins":{{"probe":{{"version":"1.0.0","path":"plugins/probe/1.0.0","enabled":{probe_enabled},"sidecars":{{}}}},"broken":{{"version":"1.0.0","path":"plugins/broken/1.0.0","enabled":true,"sidecars":{{}}}}}},"sidecars":{{}}}}"#
        )
    };
    fs::write(config.join("plugins/installed.json"), installed("true")).unwrap();
    apply_plugin_event_classes(&log, &config);
    fs::write(config.join("plugins/installed.json"), installed("false")).unwrap();
    apply_plugin_event_classes(&log, &config);
    log.flush(Duration::from_secs(5)).unwrap();
    use_host_event_log(None);
    let events: Vec<Value> = fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let applies: Vec<&Value> = events
        .iter()
        .filter(|event| event["event"] == "log.plugins")
        .collect();
    assert_eq!(
        applies.len(),
        2,
        "one log.plugins record per apply: {events:?}"
    );
    // default: the writer keeps the catalog of a plugin that a change disabled, and a catalog it cannot use is not held.
    for record in applies {
        assert_eq!(
            record["fields"]["plugins"],
            json!([{"plugin": "probe", "version": "1.0.0"}]),
            "{record}"
        );
    }
}
