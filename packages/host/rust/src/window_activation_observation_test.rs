//! The activation observation of `host.window`: the native registration and count pass through unchanged, and missing or
//! invalid values are refused. The same cases run in the Go host.
use super::*;

#[test]
fn host_window_preserves_exact_activation_observation() {
    for observation in [
        json!({"registered":true,"count":"0"}),
        json!({"registered":false,"count":"18446744073709551615"}),
    ] {
        let facts = json!({"activationObservation":observation});
        assert_eq!(window_activation_observation(&facts).unwrap(), observation);
    }
}

#[test]
fn host_window_refuses_missing_or_invalid_activation_observation() {
    let invalid = [
        Value::Null,
        json!({}),
        json!({"registered":true}),
        json!({"count":"1"}),
        json!({"registered":"true","count":"1"}),
        json!({"registered":false,"count":1}),
        json!({"registered":false,"count":""}),
        json!({"registered":false,"count":"01"}),
        json!({"registered":false,"count":"-1"}),
        json!({"registered":false,"count":"+1"}),
        json!({"registered":false,"count":"1.0"}),
        json!({"registered":false,"count":"18446744073709551616"}),
    ];
    assert!(
        window_activation_observation(&json!({}))
            .unwrap_err()
            .contains("activationObservation")
    );
    for observation in invalid {
        assert!(
            window_activation_observation(&json!({"activationObservation":observation}))
                .unwrap_err()
                .contains("activationObservation")
        );
    }
}

#[test]
fn host_window_declares_exact_activation_observation_schema() {
    let declarations = host_declarations();
    let window = declarations["status"]
        .as_array()
        .unwrap()
        .iter()
        .find(|status| status["name"] == "host.window")
        .expect("the host.window declaration");
    let fields = &window["schema"]["properties"]["activationObservation"]["properties"];
    assert_eq!(fields["registered"], json!({"type":"boolean"}));
    assert_eq!(
        fields["count"],
        json!({"type":"string","pattern":"^(0|[1-9][0-9]*)$"})
    );
}
