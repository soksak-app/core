//! Validation of the action of a person at the diagnostic endpoint boundary.
use super::parse_input_person;
use serde_json::json;
// contract: diagnostics.input-person.validates-parameters
#[test]
fn input_person_refuses_parameters_out_of_their_form() {
    for (params, want) in [
        (
            json!({"action":"drag","x":1,"y":2}),
            "action must be press, move or scroll",
        ),
        (json!({"x":1,"y":2}), "action must be press, move or scroll"),
        (json!({"action":"move","y":2}), "x and y must be numbers"),
        (
            json!({"action":"move","x":"1","y":2}),
            "x and y must be numbers",
        ),
        (
            json!({"action":"scroll","x":1,"y":null}),
            "x and y must be numbers",
        ),
    ] {
        let failure = parse_input_person(params.as_object().unwrap()).unwrap_err();
        assert_eq!(
            (failure.code, failure.message.as_str()),
            (-32602, want),
            "{params}"
        );
    }
    assert_eq!(
        parse_input_person(json!({"action":"press","x":1.5,"y":2}).as_object().unwrap()).unwrap(),
        ("press".into(), 1.5, 2.0)
    );
}
