use super::*;

// The parameter accepts a boolean and null, and refuses any other value and an absent parameter.
#[cfg(feature = "diagnostics")]
#[test]
fn diagnostics_motion_accepts_a_boolean_or_null_and_refuses_any_other_value() {
    assert_eq!(parse_reduce(Some(&json!(true))), Ok(Some(true)));
    assert_eq!(parse_reduce(Some(&json!(false))), Ok(Some(false)));
    assert_eq!(parse_reduce(Some(&Value::Null)), Ok(None));
    for value in [json!("yes"), json!(1), json!([])] {
        assert_eq!(
            parse_reduce(Some(&value)),
            Err("reduce must be a boolean or null"),
            "the value {value} was accepted"
        );
    }
    assert_eq!(
        parse_reduce(None),
        Err("reduce must be a boolean or null"),
        "an absent reduce was accepted"
    );
}

// The motion event and the motion command carry {reduce}, with null for the platform value.
#[test]
fn the_motion_payload_carries_reduce_with_null_for_the_platform_value() {
    assert_eq!(payload(Some(true)), json!({"reduce": true}));
    assert_eq!(payload(Some(false)), json!({"reduce": false}));
    assert_eq!(payload(None), json!({"reduce": null}));
}
