use super::{ViewChannels, tag_view_generation};
use serde_json::json;

#[test]
fn a_view_lifecycle_snapshot_and_status_call_share_the_issued_generation() {
    let origins = crate::windows::DeclaredSourceOrigins::default();
    let generation = origins
        .issue_view("surface")
        .expect("the view origin is issued");
    let channels = ViewChannels::default();
    channels.register_origin("surface", "probe", generation);

    let registered =
        crate::windows::declared_source_origin_event("probe", Some("surface"), generation);
    let snapshot = tag_view_generation(
        channels
            .snapshot(
                "surface",
                r#"{"message":{"event":"declared-ui.snapshot","plugin":"probe","status":"items","seq":1,"skipped":0,"value":{"items":[]}}}"#,
            )
            .expect("the view snapshot envelope is valid")
            .expect("the view snapshot is relayed"),
        generation,
    );
    let status_registration = tag_view_generation(
        channels
            .call(
                "surface",
                r#"{"message":{"id":2,"command":"runtime.status.watch","params":{"name":"items"}}}"#,
            )
            .expect("the view status call is valid")
            .expect("the view status call is relayed"),
        generation,
    );

    assert_eq!(
        registered,
        json!({"plugin":"probe","surface":"surface","generation":generation})
    );
    assert_eq!(snapshot["generation"], generation);
    assert_eq!(status_registration["generation"], generation);
}

#[test]
fn a_stale_view_ack_is_not_posted_and_a_stale_pull_is_cancelled() {
    let origins = crate::windows::DeclaredSourceOrigins::default();
    let old = origins
        .issue_view("surface")
        .expect("the first view origin is issued");
    let current = origins
        .issue_view("surface")
        .expect("the replacement view origin is issued");
    let channels = ViewChannels::default();
    channels.register_origin("surface", "probe", current);
    let posts = std::cell::Cell::new(0);

    let accepted = crate::plugin_host_channel::post_if_generation_current(
        old,
        origins.current_view("surface"),
        || channels.generation("surface") == Some(old),
        || {
            posts.set(posts.get() + 1);
            Ok(true)
        },
    )
    .expect("the stale event is cancelled without a posting error");

    assert!(!accepted, "a stale view event was accepted");
    assert_eq!(posts.get(), 0, "a stale ACK reached the replacement view");
    assert_eq!(
        super::view_request_disposition(old, accepted),
        json!({"cancelled":true,"sourceGeneration":old}),
    );
}
