//! A view sidecar send without correlation identifiers is accepted with an absent, null or empty `cids` field. The same case runs
//! in the Go host.
use super::ViewSidecarSendRequest;

// contract: sidecars.view-send.uncorrelated-cids-are-accepted
#[test]
fn view_sidecar_send_preserves_uncorrelated_cids_carriers() {
    for suffix in ["", r#","cids":null"#, r#","cids":[]"#] {
        let raw = format!(
            r#"{{"source":"probe","generation":1,"sidecar":"worker","surface":"probe","body":{{}}{suffix}}}"#
        );
        let request: ViewSidecarSendRequest = serde_json::from_str(&raw)
            .unwrap_or_else(|error| panic!("uncorrelated request {raw} was refused: {error}"));
        assert_eq!(
            request.check(),
            Ok(()),
            "uncorrelated request {raw} was refused"
        );
        assert!(
            request.cids.as_deref().unwrap_or(&[]).is_empty(),
            "uncorrelated request {raw} acquired CIDs: {:?}",
            request.cids
        );
    }
}
