use super::*;
use serde_json::json;

// contract: projects.shown-ignores-unknown-fields
#[test]
fn project_shown_ignores_unknown_outer_fields() {
    let decoded = serde_json::from_value::<ProjectShown>(json!({
        "project": null,
        "unknown": true,
    }));

    assert!(
        decoded.is_ok(),
        "unknown outer field was rejected: {decoded:?}"
    );
}

// contract: projects.shown-ignores-unknown-fields
#[test]
fn shown_project_ignores_unknown_nested_fields() {
    let decoded = serde_json::from_value::<ProjectShown>(json!({
        "project": {
            "id": "project-one",
            "root": "/tmp/project-one",
            "title": "One",
            "unknown": true,
        },
    }));

    assert!(
        decoded.is_ok(),
        "unknown nested field was rejected: {decoded:?}"
    );
}
