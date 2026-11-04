//! Input reference request validation at the diagnostic endpoint boundary.
use super::parse_input_reference;
use serde_json::{Value, json};
// contract: diagnostics.input-reference.validates-document
#[test]
fn input_reference_validates_document() {
    for action in ["open", "read", "focus", "close"] {
        assert_eq!(
            parse_input_reference(json!({"action": action}).as_object().unwrap()).unwrap(),
            (action.into(), None)
        );
    }
    for document in ["", "a😀"] {
        assert_eq!(
            parse_input_reference(
                json!({"action":"wait", "document":document})
                    .as_object()
                    .unwrap()
            )
            .unwrap(),
            ("wait".into(), Some(document.into()))
        );
    }
    for params in [
        json!({}),
        json!({"action":"invalid"}),
        json!({"action":"open", "document":Value::Null}),
        json!({"action":"read", "document":""}),
        json!({"action":"close", "document":Value::Null}),
        json!({"action":"wait"}),
        json!({"action":"wait", "document":Value::Null}),
        json!({"action":"wait", "document":3}),
    ] {
        assert!(
            parse_input_reference(params.as_object().unwrap()).is_err(),
            "accepted {params}"
        );
    }
}

// contract: diagnostics.input-reference.validates-document
#[test]
fn input_reference_wait_document_accepts_expected_document() {
    for document in ["", "a😀"] {
        assert_eq!(
            parse_input_reference(
                json!({"action":"wait-document", "document":document})
                    .as_object()
                    .unwrap()
            )
            .unwrap(),
            ("wait-document".into(), Some(document.into()))
        );
    }
}

// contract: diagnostics.input-reference.validates-document
#[test]
fn input_reference_wait_document_requires_a_string() {
    for params in [
        json!({"action":"wait-document"}),
        json!({"action":"wait-document", "document":Value::Null}),
        json!({"action":"wait-document", "document":3}),
    ] {
        let error = parse_input_reference(params.as_object().unwrap()).unwrap_err();
        assert_eq!(
            error.message, "input reference wait-document and wait require a document string",
            "params {params}"
        );
    }
}

// contract: diagnostics.input-reference.validates-document
#[test]
fn input_reference_wait_document_boundary_errors_name_both_actions() {
    let invalid_action =
        parse_input_reference(json!({"action":"invalid"}).as_object().unwrap()).unwrap_err();
    assert_eq!(
        invalid_action.message,
        "input reference action must be open, read, focus, wait-document, wait or close"
    );

    let document_scope = parse_input_reference(
        json!({"action":"read", "document":"text"})
            .as_object()
            .unwrap(),
    )
    .unwrap_err();
    assert_eq!(
        document_scope.message,
        "input reference document is only for wait-document and wait"
    );
}
