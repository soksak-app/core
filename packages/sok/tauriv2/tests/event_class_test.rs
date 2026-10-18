//! Checks the class of the lines of the event file of the tool and the class table of the catalog
//! (docs/spec/logging.md#event, docs/spec/logging.md#classes-and-policy).

use std::time::Duration;

use serde_json::{Value, json};
use soksak_sok::event_classes::{Class, class_of};
use soksak_sok::event_log::Level;

#[path = "support/policy.rs"]
mod support;

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

// contract: cli.log.stores-class
#[test]
fn every_line_of_the_tool_stores_the_class_of_its_catalog_entry() {
    let config = Folder::new("class");
    support::store_every_level(&config);
    let log = soksak_sok::start_tool_event_log(&config).unwrap();
    log.emit(Level::Warn, "sok.command", &json!({"name": "x"}));
    log.emit(
        Level::Error,
        "sok.panic",
        &json!({"name": "main", "text": "t", "stack": "s"}),
    );
    log.emit(Level::Info, "sok.surprise", &json!({}));
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let text = std::fs::read_to_string(log.path()).unwrap();
    let lines: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let want = [
        ("log.open", Some("lifecycle")),
        ("log.policy", Some("lifecycle")),
        ("sok.command", Some("call")),
        ("sok.panic", Some("lifecycle")),
        ("sok.surprise", None),
    ];
    assert_eq!(lines.len(), want.len(), "{lines:?}");
    for (line, (event, class)) in lines.iter().zip(want) {
        assert_eq!(line["event"], event, "{line}");
        match class {
            Some(class) => {
                assert_eq!(line["class"], class, "{line}");
                assert!(line.get("undeclared").is_none(), "{line}");
            }
            None => {
                assert!(line.get("class").is_none(), "{line}");
                assert_eq!(line["undeclared"], true, "{line}");
            }
        }
    }
}

// contract: cli.log.stores-class
#[test]
fn the_class_table_gives_the_catalog_class_of_events_and_families() {
    for (name, want) in [
        ("log.open", Class::Lifecycle),
        ("host.binding.call", Class::Call),
        ("host.input.relay", Class::Input),
        ("host.sidecar.request", Class::Io),
        ("native.observe.counted", Class::Frame),
        ("page.console.warn", Class::Lifecycle),
        ("host.trace.mark", Class::Call),
    ] {
        assert_eq!(class_of(name), Some(want), "{name}");
    }
    for name in [
        "host.nothing",
        "page.console.",
        "page.console.WARN",
        "plugin.editor.opened",
        "",
    ] {
        assert_eq!(class_of(name), None, "{name:?}");
    }
}
