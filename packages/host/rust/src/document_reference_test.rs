//! Document reference request validation before any window or platform work. The same cases run in the Go host.
use super::{DocumentReferenceRequest, parse_request};
use serde_json::json;

// contract: diagnostics.capture.document-reference.rejects-invalid-request-before-platform-dispatch
#[test]
fn document_reference_observation_rejects_invalid_requests() {
    for params in [
        json!({"window":"main","document":"page","requestId":1}),
        json!({"window":"main","surface":"","document":"page","requestId":1}),
        json!({"window":"main","surface":"browser-a","requestId":1}),
        json!({"window":"main","surface":"browser-a","document":"Not A Name","requestId":1}),
        json!({"window":"main","surface":"browser-a","document":"page","requestId":0}),
        json!({"window":"main","surface":"browser-a","document":"page",
            "requestId":9_007_199_254_740_992u64}),
        json!({"window":"main","surface":"browser-a","document":"page","requestId":1,
            "expected":{"text":"invented producer truth"}}),
    ] {
        let error = parse_request(params.as_object().unwrap())
            .err()
            .unwrap_or_else(|| panic!("invalid reference request {params} was accepted"));
        assert!(
            error.message.contains("document reference"),
            "invalid reference request {params} returned {error:?}"
        );
    }
    for document in ["", "page"] {
        let params =
            json!({"window":"main","surface":"browser-a","document":document,"requestId":1});
        assert_eq!(
            parse_request(params.as_object().unwrap()),
            Ok(DocumentReferenceRequest {
                surface: "browser-a".into(),
                document: document.into(),
                request_id: 1,
            }),
            "valid reference request {params}"
        );
    }
}
