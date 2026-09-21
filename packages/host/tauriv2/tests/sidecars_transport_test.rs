//! Persistent transport contract checks paired with the Wails transport harness.

use serde_json::json;

#[test]
fn endpoint_and_handshake_use_protocol_one() {
    let endpoint = json!({
        "protocol": 1,
        "pid": 7,
        "socket": "/private/tmp/service.sock",
        "token": "os-random-token"
    });
    let hello = json!({
        "op": "hello",
        "protocol": 1,
        "token": endpoint["token"],
        "client": "canonical-config-directory"
    });

    assert_eq!(endpoint["protocol"], 1);
    assert_eq!(hello["op"], "hello");
    assert_eq!(hello["protocol"], endpoint["protocol"]);
    assert_eq!(hello["token"], endpoint["token"]);
}

#[test]
fn close_owner_ack_preserves_request_identity_and_failure() {
    let response = json!({
        "op": "closed-owner",
        "request": "close-17",
        "ok": false,
        "error": "service drain failed"
    });

    assert_eq!(response["op"], "closed-owner");
    assert_eq!(response["request"], "close-17");
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"], "service drain failed");
}
