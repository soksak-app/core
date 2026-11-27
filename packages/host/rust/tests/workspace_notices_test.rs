//! Tests of the notice center store, notices.json (docs/spec/native-host.md#project-and-settings-operations).

#[path = "support/folder.rs"]
mod folder;

use std::fs;

use serde_json::{Value, json};
use soksak_host::workspace::Workspace;

fn apply(store: &Workspace, request: Value) -> Result<Value, String> {
    store.apply(serde_json::from_value(request).unwrap())
}

// contract: workspace.notices.put-replaces-list
#[test]
fn notices_put_replaces_the_list_and_another_store_reads_it() {
    let config = folder::Folder::new();
    let store = Workspace::new(config.path().into());
    assert_eq!(
        apply(&store, json!({"kind":"notices"})).unwrap(),
        Value::Null
    );
    let first = json!([
        {"id":"n1", "kind":"info", "title":"Built"},
        {"id":"n2", "kind":"error", "title":"Failed"}
    ]);
    let written = apply(&store, json!({"kind":"noticesPut", "notices":first})).unwrap();
    let size = fs::metadata(config.path().join("notices.json"))
        .unwrap()
        .len();
    assert_eq!(
        written,
        json!(size),
        "a put returns the size of the written file"
    );
    // Another store of the same configuration directory reads the list that the put wrote.
    let other = Workspace::new(config.path().into());
    assert_eq!(
        apply(&other, json!({"kind":"notices"})).unwrap(),
        json!({"format":1, "notices":first})
    );
    // A put replaces the whole list, so an empty list leaves no entry.
    apply(&store, json!({"kind":"noticesPut", "notices":[]})).unwrap();
    assert_eq!(
        apply(&store, json!({"kind":"notices"})).unwrap(),
        json!({"format":1, "notices":[]})
    );
}

// contract: workspace.notices.rejects-other-format
#[test]
fn notices_reject_other_format_and_non_list_values() {
    let config = folder::Folder::new();
    let store = Workspace::new(config.path().into());
    let path = config.path().join("notices.json");
    fs::write(&path, r#"{"format":2,"notices":[]}"#).unwrap();
    let want = format!("{}: notices.json: format must be 1", path.display());
    assert_eq!(
        apply(&store, json!({"kind":"noticesPut", "notices":[]})).unwrap_err(),
        want
    );
    assert_eq!(apply(&store, json!({"kind":"notices"})).unwrap_err(), want);
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        r#"{"format":2,"notices":[]}"#,
        "a refused put changed the file"
    );
    fs::remove_file(&path).unwrap();
    for value in [json!(null), json!({}), json!("n1")] {
        assert_eq!(
            apply(&store, json!({"kind":"noticesPut", "notices":value})).unwrap_err(),
            "notices put requires a list of notices",
        );
    }
    assert_eq!(
        apply(&store, json!({"kind":"noticesPut"})).unwrap_err(),
        "notices put requires a list of notices"
    );
    assert!(!path.exists(), "a refused put created notices.json");
}
