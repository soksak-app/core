//! The error member of an endpoint reply names its code and its message (docs/spec/host-contract.md). The Go client refuses the
//! same frames.

use soksak_sok::endpoint::parse_frame;

// contract: sok.endpoint.error-member-names-code-and-message
#[test]
fn an_error_without_a_message_or_a_code_is_refused() {
    for (name, frame, want) in [
        (
            "no message",
            r#"{"id": 1, "error": {"code": -32000}}"#,
            "invalid frame from endpoint: error has no message",
        ),
        (
            "no code",
            r#"{"id": 1, "error": {"message": "failed"}}"#,
            "invalid frame from endpoint: error has no code",
        ),
    ] {
        let error = match parse_frame(frame.as_bytes()) {
            Ok(_) => panic!("{name}: the error member was accepted"),
            Err(error) => error,
        };
        assert_eq!(error, want, "{name}");
    }
}
