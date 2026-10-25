//! Checks that the writer gives a plugin event the class that the catalog of its plugin declares, and that the catalogs are
//! read from the enabled installed plugins (docs/spec/logging.md#plugin-catalogs).

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use soksak_sok::event_classes::Class;
use soksak_sok::event_log::Level;
use soksak_sok::plugin_catalog::plugin_event_classes;

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

fn temp(label: &str) -> Folder {
    let dir = Folder::new(&format!("plugin-catalog-{label}"));
    std::fs::create_dir_all(dir.join("plugins")).unwrap();
    dir
}

#[path = "support/policy.rs"]
mod support;

// contract: log.plugin-catalog.classifies-plugin-events
#[test]
fn a_plugin_event_has_the_class_that_the_catalog_of_its_plugin_declares() {
    let dir = temp("classify");
    support::store_every_level(dir.path());
    let log = soksak_sok::start_tool_event_log(dir.path()).unwrap();
    log.set_plugin_classes(HashMap::from([(
        "plugin.probe.frame".to_string(),
        Class::Frame,
    )]));
    log.emit(Level::Info, "plugin.probe.frame", &json!({"sequence": 1}));
    log.emit(Level::Info, "plugin.probe.other", &json!({}));
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let lines: Vec<Value> = std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let got: Vec<(Value, Value, Value)> = lines
        .iter()
        .map(|line| {
            (
                line["event"].clone(),
                line["class"].clone(),
                line["undeclared"].clone(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (json!("log.open"), json!("lifecycle"), Value::Null),
            (json!("log.policy"), json!("lifecycle"), Value::Null),
            (json!("plugin.probe.frame"), json!("frame"), Value::Null),
            (json!("plugin.probe.other"), Value::Null, json!(true)),
        ]
    );
}

/// Writes an installed plugin of the configuration folder with its plugin.json and, when `catalog` is not empty, the catalog
/// file events.json that the manifest names.
fn write_plugin(config: &Path, id: &str, catalog: &str) {
    let folder = config.join("plugins").join(id).join("1.0.0");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("plugin.json"),
        format!(r#"{{"id":"{id}","events":"events.json"}}"#),
    )
    .unwrap();
    if !catalog.is_empty() {
        std::fs::write(folder.join("events.json"), catalog).unwrap();
    }
}

fn write_installed(config: &Path, plugins: &str) {
    std::fs::write(
        config.join("plugins/installed.json"),
        format!(r#"{{"format":3,"plugins":{{{plugins}}},"sidecars":{{}}}}"#),
    )
    .unwrap();
}

fn enabled(id: &str, enabled: bool) -> String {
    format!(
        r#""{id}":{{"version":"1.0.0","path":"plugins/{id}/1.0.0","enabled":{enabled},"sidecars":{{}}}}"#
    )
}

// contract: log.plugin-catalog.reads-the-enabled-plugins
#[test]
fn the_plugin_classes_are_the_catalogs_of_the_enabled_installed_plugins() {
    let dir = temp("enabled");
    write_plugin(
        dir.path(),
        "probe",
        r#"{"schema":3,"events":{"plugin.probe.frame":{"layer":"plugin","class":"frame","level":"debug","fields":{"type":"object","properties":{},"required":[]}},"plugin.probe.error":{"layer":"plugin","class":"lifecycle","level":"error","fields":{"type":"object","properties":{},"required":[]}}}}"#,
    );
    write_plugin(
        dir.path(),
        "fixture",
        r#"{"schema":3,"events":{"plugin.fixture.watch":{"layer":"plugin","class":"io","level":"debug","fields":{"type":"object","properties":{},"required":[]}}}}"#,
    );
    write_installed(
        dir.path(),
        &format!("{},{}", enabled("probe", true), enabled("fixture", false)),
    );
    let (classes, errors) = plugin_event_classes(dir.path());
    assert!(errors.is_empty(), "errors {errors:?}");
    assert_eq!(
        classes,
        HashMap::from([
            ("plugin.probe.frame".to_string(), Class::Frame),
            ("plugin.probe.error".to_string(), Class::Lifecycle),
        ])
    );
}

// contract: log.plugin-catalog.refuses-a-catalog
#[test]
fn a_catalog_that_cannot_be_used_is_an_error_that_names_its_file_and_the_other_plugins_keep_their_classes()
 {
    let dir = temp("refused");
    write_plugin(
        dir.path(),
        "probe",
        r#"{"schema":3,"events":{"plugin.probe.frame":{"class":"frame"}}}"#,
    );
    write_plugin(
        dir.path(),
        "outside",
        r#"{"schema":3,"events":{"plugin.probe.frame":{"class":"frame"}}}"#,
    );
    write_plugin(
        dir.path(),
        "classless",
        r#"{"schema":3,"events":{"plugin.classless.x":{"class":"often"}}}"#,
    );
    write_plugin(dir.path(), "broken", r#"{"events":"#);
    write_plugin(dir.path(), "missing", "");
    write_plugin(dir.path(), "old", r#"{"schema":2,"events":{"plugin.old.event":{"class":"call"}}}"#);
    let ids = ["probe", "outside", "classless", "broken", "missing", "old"];
    write_installed(
        dir.path(),
        &ids.iter()
            .map(|id| enabled(id, true))
            .collect::<Vec<_>>()
            .join(","),
    );
    let (classes, errors) = plugin_event_classes(dir.path());
    assert_eq!(
        classes,
        HashMap::from([("plugin.probe.frame".to_string(), Class::Frame)])
    );
    let file = |id: &str| {
        dir.path()
            .join("plugins")
            .join(id)
            .join("1.0.0/events.json")
            .display()
            .to_string()
    };
    assert_eq!(
        errors,
        vec![
            format!(
                "{}: the event catalog of plugin broken is not JSON",
                file("broken")
            ),
            format!(
                "{}: the event plugin.classless.x has the class often, which is not lifecycle, input, call, io or frame",
                file("classless")
            ),
            format!(
                "{}: the event catalog of plugin missing does not exist",
                file("missing")
            ),
            format!("{}: event catalog schema is 2; expected 3", file("old")),
            format!(
                "{}: the event plugin.probe.frame is not an event of plugin outside (plugin.outside.<event>)",
                file("outside")
            ),
        ]
    );
}
