//! The sheet of `host.window`: the sheet that the native facts report passes through with the folder and the name of a panel,
//! null for a folder or a name that the facts do not give, a missing or null sheet gives null, and a sheet of an unknown kind,
//! without a frame or with a folder or a name that is not a string is refused. The same cases run in the Go host.
use super::*;

// contract: window.facts.sheet
#[test]
fn host_window_reports_its_sheet() {
    let frame = json!({"x": 10.0, "y": 20.0, "width": 370.0, "height": 182.0});
    for sheet in [
        json!({"kind": "save", "frame": frame, "directory": "/Users/check/Documents", "name": "host.jsonl"}),
        json!({"kind": "open", "frame": frame, "directory": "/Users/check/Documents", "name": null}),
        json!({"kind": "alert", "frame": frame, "directory": null, "name": null}),
    ] {
        assert_eq!(window_sheet(&json!({ "sheet": sheet })).unwrap(), sheet);
    }
    assert_eq!(
        window_sheet(&json!({"sheet": {"kind": "other", "frame": frame}})).unwrap(),
        json!({"kind": "other", "frame": frame, "directory": null, "name": null})
    );
    assert!(
        window_sheet(
            &json!({"sheet": {"kind": "save", "frame": frame, "directory": 3, "name": null}})
        )
        .is_err()
    );
    assert_eq!(window_sheet(&json!({"sheet": null})).unwrap(), Value::Null);
    assert_eq!(window_sheet(&json!({})).unwrap(), Value::Null);
    assert!(window_sheet(&json!({"sheet": {"kind": "panel", "frame": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}}})).is_err());
    assert!(window_sheet(&json!({"sheet": {"kind": "save"}})).is_err());
    assert!(window_sheet(&json!({"sheet": 3})).is_err());
    let declarations = host_declarations();
    let window = declarations["status"]
        .as_array()
        .unwrap()
        .iter()
        .find(|status| status["name"] == "host.window")
        .expect("the host.window declaration");
    let declared = &window["schema"]["properties"]["sheet"];
    assert_eq!(
        declared["properties"]["kind"]["enum"],
        json!(["save", "open", "alert", "other"])
    );
    assert_eq!(
        declared["properties"]["directory"],
        json!({"type": ["string", "null"]})
    );
    assert_eq!(
        declared["properties"]["name"],
        json!({"type": ["string", "null"]})
    );
}
