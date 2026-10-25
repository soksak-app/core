use super::{ViewChannels, tag_view_generation};
use serde_json::json;

// contract: view.source-registration-precedes-provider-messages
#[test]
fn a_view_lifecycle_snapshot_and_status_call_share_the_issued_generation() {
    let origins = crate::source_origins::DeclaredSourceOrigins::default();
    let generation = origins
        .issue_view("surface")
        .expect("the view origin is issued");
    let channels = ViewChannels::default();
    channels.register_origin("surface", "probe", generation);

    let registered =
        crate::source_origins::declared_source_origin_event("probe", Some("surface"), generation);
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

// contract: view.source-generation
#[test]
fn a_stale_view_ack_is_not_posted_and_a_stale_pull_is_cancelled() {
    let origins = crate::source_origins::DeclaredSourceOrigins::default();
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

// contract: view.call.reply
#[test]
fn a_view_reply_requires_the_current_main_page_identity() {
    let body = r#"{"surface":"probe","generation":1,"id":7,"result":null}"#;
    let decoded = serde_json::from_str::<crate::documents::ViewReply>(body);
    assert!(
        decoded.is_err(),
        "a view reply without page identity was accepted"
    );
}

// contract: view.call.reply
#[test]
fn a_view_reply_dispatch_record_follows_the_native_post_result() {
    use crate::documents::{ViewReply, dispatch_view_reply};
    use crate::event_record::buffered_fields;
    use serde_json::json;

    let reply = ViewReply {
        page: "page-1".into(),
        surface: "probe-surface".into(),
        generation: 7,
        id: 90210,
        result: Some(json!(null)),
        error: None,
    };
    let post_returned = std::cell::Cell::new(false);
    let mut answered = false;
    dispatch_view_reply(
        &reply,
        "main",
        || {
            assert!(
                buffered_fields("host.view.reply.dispatch")
                    .iter()
                    .all(|fields| fields["id"] != 90210),
                "dispatch record exists before native post returns"
            );
            post_returned.set(true);
            Ok(true)
        },
        || {
            assert!(
                post_returned.get(),
                "answer ran before native post returned"
            );
            assert!(buffered_fields("host.view.reply.dispatch").iter().any(|fields| {
                fields == &json!({
                    "window":"main", "page":"page-1", "surface":"probe-surface",
                    "generation":7, "id":90210, "outcome":"result", "disposition":"posted"
                })
            }), "answer ran before the dispatch record");
            answered = true;
            Ok(())
        },
    )
    .expect("a posted view reply succeeds");
    assert!(answered, "a posted reply did not finish its call");
}

// contract: view.call.reply
#[test]
fn a_stale_view_reply_is_recorded_as_discarded_without_answering_the_call() {
    use crate::documents::{ViewReply, dispatch_view_reply};
    use crate::event_record::buffered_fields;
    use serde_json::json;

    let reply = ViewReply {
        page: "page-1".into(),
        surface: "probe-surface".into(),
        generation: 8,
        id: 90211,
        result: None,
        error: Some(crate::documents::ViewReplyError {
            code: -32000,
            message: "cancelled".into(),
        }),
    };
    let post_returned = std::cell::Cell::new(false);
    dispatch_view_reply(
        &reply,
        "main",
        || {
            post_returned.set(true);
            Ok(false)
        },
        || panic!("a stale reply must not answer the call"),
    )
    .expect("a stale post is a normal no-op");
    assert!(post_returned.get());
    assert!(
        buffered_fields("host.view.reply.dispatch")
            .iter()
            .any(|fields| {
                fields
                    == &json!({
                        "window":"main", "page":"page-1", "surface":"probe-surface",
                        "generation":8, "id":90211, "outcome":"error", "disposition":"discarded",
                        "reason":"view-generation-not-current"
                    })
            })
    );
}

// contract: view.call.reply
#[test]
fn a_failed_view_reply_post_returns_without_a_dispatch_record() {
    use crate::documents::{ViewReply, dispatch_view_reply};
    use crate::event_record::buffered_fields;
    use serde_json::json;

    let reply = ViewReply {
        page: "page-1".into(),
        surface: "probe-surface".into(),
        generation: 9,
        id: 90212,
        result: Some(json!(null)),
        error: None,
    };
    let error = dispatch_view_reply(
        &reply,
        "main",
        || Err("native post failed".into()),
        || panic!("a failed post must not answer the call"),
    )
    .expect_err("a failed native post is returned to the caller");
    assert_eq!(error, "native post failed");
    assert!(
        buffered_fields("host.view.reply.dispatch")
            .iter()
            .all(|fields| fields["id"] != 90212)
    );
}
