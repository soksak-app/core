//! The sheet of `host.window`: the sheet that the native facts report passes through, a missing or null sheet gives null, and a
//! sheet of an unknown kind or without a frame is refused. The same cases run in the Go host.
use super::*;

// contract: window.facts.sheet
#[test]
fn host_window_reports_its_sheet() {
    for kind in ["save", "open", "alert", "other"] {
        let sheet =
            json!({"kind": kind, "frame": {"x": 10.0, "y": 20.0, "width": 370.0, "height": 182.0}});
        assert_eq!(window_sheet(&json!({ "sheet": sheet })).unwrap(), sheet);
    }
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
}
