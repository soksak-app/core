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
