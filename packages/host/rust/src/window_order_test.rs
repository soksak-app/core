//! The display and the place of a window among the windows on the screen in `host.window`, and the raise and the lower of a window
//! as host commands. The same cases run in the Go host.
use super::*;

/// host.window reports the display of the window and its place among the windows on the screen as the native facts read them,
/// null for each that the facts cannot tell, and refuses facts of another shape.
// contract: window.facts.display-and-order
#[test]
fn the_window_reports_its_display_and_its_place_among_the_windows_on_the_screen() {
    let order = json!({"index": 2, "count": 5, "otherInFront": true});
    assert_eq!(
        window_place(&json!({"display": 1, "order": order})).unwrap(),
        (json!(1), order.clone())
    );
    assert_eq!(
        window_place(&json!({"display": null, "order": null})).unwrap(),
        (Value::Null, Value::Null)
    );
    for invalid in [
        json!({"order": null}),
        json!({"display": -1, "order": null}),
        json!({"display": 0}),
        json!({"display": 0, "order": {"index": 0, "count": 1}}),
        json!({"display": 0, "order": {"index": 1, "count": 1, "otherInFront": false}}),
        json!({"display": 0, "order": {"index": 0, "count": 1, "otherInFront": 1}}),
    ] {
        assert!(
            window_place(&invalid).is_err(),
            "the facts {invalid} are refused"
        );
    }
    let declarations = host_declarations();
    let window = declarations["status"]
        .as_array()
        .unwrap()
        .iter()
        .find(|status| status["name"] == "host.window")
        .expect("the host.window declaration");
    for name in ["display", "order"] {
        assert!(
            window["schema"]["properties"].get(name).is_some(),
            "host.window declares no {name}"
        );
    }
}

/// host.window.raise and host.window.lower are commands of the host with empty parameters and a null result.
// contract: window.order.raise-and-lower
#[test]
fn the_raise_and_the_lower_of_a_window_are_host_commands() {
    let listed: Value = serde_json::from_str(
        exposure_list(
            json!({"window": "main", "owner": "host"})
                .as_object()
                .unwrap(),
            || panic!("the exposure list of the host owner asked the page"),
        )
        .unwrap()
        .get(),
    )
    .unwrap();
    for name in ["host.window.raise", "host.window.lower"] {
        let entry = listed["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == name)
            .unwrap_or_else(|| panic!("{name} is not a host command: {listed}"));
        assert_eq!(
            entry["params"],
            json!({"type": "object", "properties": {}}),
            "{name}"
        );
        assert_eq!(entry["result"], json!({"type": "null"}), "{name}");
    }
}
