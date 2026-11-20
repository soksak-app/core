//! The host call debugFollow of a window (docs/spec/debug.md#files). The same cases run in the Go host.

use super::FollowRequest;

// contract: debug.follow.refuses-a-request-without-a-boolean
#[test]
fn debug_follow_refuses_a_request_without_a_boolean() {
    for (request, want) in [
        (
            serde_json::json!({}),
            "argument request.following is missing",
        ),
        (
            serde_json::json!({"following": null}),
            "argument request.following is missing",
        ),
        (
            serde_json::json!({"following": "yes"}),
            "argument request.following must be a boolean, not a string",
        ),
    ] {
        let arguments = serde_json::json!({ "request": request });
        let body = crate::framework::InvokeBody::Json(&arguments);
        let refused = crate::arguments::Argument::<FollowRequest>::from_body(
            "debug_follow",
            "request",
            &body,
        )
        .err()
        .unwrap_or_else(|| panic!("debugFollow {request} was accepted"));
        assert_eq!(refused, want, "debugFollow {request}");
    }
}
