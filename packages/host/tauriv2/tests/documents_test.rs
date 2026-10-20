//! Checks the owning surface check of document region requests and the document region list of a window.

use serde_json::{Value, json};
use std::time::{Duration, Instant};

use soksak_host_tauriv2::documents::{
    Documents, Key, Report, Request, StreamEffect, Streams, ViewChannels, check, go_action,
    parse_report, remove_surface_for_reload, stream_ack_refusal,
};
use soksak_host_tauriv2::view_lifecycle::{ViewLifecycle, is_queue_full};

fn request(surface: &str, document: &str) -> Request {
    serde_json::from_value(serde_json::json!({"surface": surface, "document": document})).unwrap()
}

fn key(surface: &str, name: &str) -> Key {
    (surface.to_string(), name.to_string())
}

// contract: documents.request.accepts-own-surface, documents.request.rejects-foreign-or-missing-caller, documents.request.rejects-invalid-names
#[test]
fn document_requests_belong_to_the_calling_surface() {
    assert_eq!(
        check(Some("tab-1"), &request("tab-1", "page")),
        Ok(key("tab-1", "page"))
    );
    for caller in [None, Some("tab-2")] {
        let error = check(caller, &request("tab-1", "page")).unwrap_err();
        assert!(error.contains("not surface"), "caller {caller:?}: {error}");
    }
    for name in ["", "Page", "-page", "a/b", &"a".repeat(65)] {
        assert!(
            check(Some("tab-1"), &request("tab-1", name)).is_err(),
            "name {name:?} was accepted"
        );
    }
}

// contract: documents.request.ignores-placement-fields, documents.request.url-and-action-default-empty
#[test]
fn document_request_does_not_expose_individual_placement() {
    let request: Request = serde_json::from_str(
        r#"{"surface":"tab-1","document":"page","left":1.5,"top":2,"right":3,"bottom":4,"visible":true}"#,
    )
    .unwrap();
    assert_eq!(
        (request.surface.as_str(), request.document.as_str()),
        ("tab-1", "page")
    );
    assert!(request.url.is_empty());
    assert!(request.action.is_empty());
}

// contract: documents.registry.rejects-duplicate-reservation, documents.registry.reserved-name-is-not-attached, documents.registry.set-attaches-reserved-name, documents.registry.lists-names-by-handle, documents.registry.surface-close-removes-only-its-documents, documents.registry.rejects-set-after-surface-removed, documents.registry.remove-reserved-returns-empty, documents.registry.remove-attached-returns-handle-once
#[test]
fn documents_reserve_names_and_close_with_their_surface() {
    let docs = Documents::default();
    let (one, two, other) = (
        key("tab-1", "page"),
        key("tab-1", "side"),
        key("tab-2", "page"),
    );
    for k in [&one, &two, &other] {
        docs.reserve(k).unwrap();
    }
    assert!(docs.reserve(&one).unwrap_err().contains("already attached"));
    assert!(
        docs.get(&one).is_err(),
        "a reserved name is not an attached document"
    );
    assert!(docs.set(&one, 1) && docs.set(&two, 2) && docs.set(&other, 3));
    assert_eq!(docs.get(&one), Ok(1));
    let names = docs.names();
    assert_eq!(names.len(), 3);
    assert_eq!(names.get(&3), Some(&other));
    assert_eq!(docs.all().len(), 3);

    let mut removed = docs.remove_surface("tab-1");
    removed.sort();
    assert_eq!(removed, vec![1, 2]);
    assert!(
        docs.get(&one).is_err(),
        "a document of a removed surface remains"
    );
    assert_eq!(
        docs.get(&other),
        Ok(3),
        "another surface's document was removed"
    );
    assert!(
        !docs.set(&one, 1),
        "a document created after its surface was removed was accepted"
    );

    docs.reserve(&two).unwrap();
    assert_eq!(docs.remove(&two), Ok(0));
    assert_eq!(docs.remove(&other), Ok(3));
    assert!(
        docs.remove(&other).is_err(),
        "a detached name was removed twice"
    );
}

// contract: documents.request.zoom-must-be-finite-positive
#[test]
fn document_zoom_must_be_a_finite_positive_factor() {
    for body in [
        r#"{"surface":"s","document":"d"}"#,
        r#"{"surface":"s","document":"d","zoom":0}"#,
        r#"{"surface":"s","document":"d","zoom":-1}"#,
    ] {
        let request: Request = serde_json::from_str(body).unwrap();
        assert!(request.zoom_factor().is_err(), "{body}: zoom was accepted");
    }
    let request: Request =
        serde_json::from_str(r#"{"surface":"tab-1","document":"page","zoom":1.25}"#).unwrap();
    assert_eq!(request.zoom_factor(), Ok(1.25));
}

// contract: documents.request.entry-requires-offset
#[test]
fn document_entry_requires_a_non_zero_offset() {
    for body in [
        r#"{"surface":"s","document":"d","action":"entry"}"#,
        r#"{"surface":"s","document":"d","action":"entry","offset":0}"#,
        r#"{"surface":"s","document":"d","action":"back","offset":1}"#,
        r#"{"surface":"s","document":"d","action":"home"}"#,
    ] {
        let request: Request = serde_json::from_str(body).unwrap();
        assert!(
            go_action(&request).is_err(),
            "{body}: the request was accepted"
        );
    }
    let request: Request =
        serde_json::from_str(r#"{"surface":"s","document":"d","action":"entry","offset":-2}"#)
            .unwrap();
    assert_eq!(go_action(&request), Ok((4, -2)));
    let request: Request =
        serde_json::from_str(r#"{"surface":"s","document":"d","action":"stop"}"#).unwrap();
    assert_eq!(go_action(&request), Ok((3, 0)));
}

fn stream_key(surface: &str, name: &str) -> Key {
    key(surface, name)
}

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

// contract: document.stream.subscribe-rejects-unknown-stream
#[test]
fn stream_subscribe_rejects_an_unknown_stream() {
    let streams = Streams::default();
    let error = streams
        .subscribe(&stream_key("tab-1", "page"), "pixels")
        .unwrap_err();
    assert_eq!(error, r#"unknown document stream "pixels""#);
}

// contract: document.stream.unsubscribe-rejects-unknown-handle
#[test]
fn stream_unsubscribe_rejects_a_handle_of_another_document() {
    let streams = Streams::default();
    let page = stream_key("tab-1", "page");
    let (handle, _, _) = streams.subscribe(&page, "elements").unwrap();
    let error = streams
        .unsubscribe(&stream_key("tab-1", "side"), handle)
        .unwrap_err();
    assert_eq!(
        error,
        format!(r#"document stream handle {handle} is not subscribed to document "side""#)
    );
    assert!(streams.unsubscribe(&page, handle + 100).is_err());
}

// contract: document.stream.first-on-last-off
#[test]
fn stream_turns_collection_on_at_the_first_subscription_and_off_at_the_last() {
    let streams = Streams::default();
    let page = stream_key("tab-1", "page");
    let (first, effects, _) = streams.subscribe(&page, "requests").unwrap();
    assert_eq!(
        effects,
        vec![StreamEffect {
            key: page.clone(),
            stream: "requests".into(),
            on: true
        }]
    );
    let (second, effects, _) = streams.subscribe(&page, "requests").unwrap();
    assert!(effects.is_empty());
    assert_eq!(streams.subscribers(&page, "requests"), 2);
    assert!(streams.unsubscribe(&page, first).unwrap().is_empty());
    let effects = streams.unsubscribe(&page, second).unwrap();
    assert_eq!(
        effects,
        vec![StreamEffect {
            key: page.clone(),
            stream: "requests".into(),
            on: false
        }]
    );
    assert_eq!(streams.subscribers(&page, "requests"), 0);
}

// contract: document.stream.native-refusal-rejects-subscription
#[test]
fn stream_abandoned_subscription_is_not_kept() {
    let streams = Streams::default();
    let page = stream_key("tab-1", "page");
    let (handle, _, _) = streams.subscribe(&page, "requests").unwrap();
    streams.abandon(handle);
    assert_eq!(streams.subscribers(&page, "requests"), 0);
    assert!(streams.unsubscribe(&page, handle).is_err());
}

// contract: document.stream.page-load-removes-subscriptions, document.stream.region-close-removes-subscriptions
#[test]
fn stream_removal_ends_subscriptions_and_releases_the_log() {
    let streams = Streams::default();
    let page = stream_key("tab-1", "page");
    let side = stream_key("tab-1", "side");
    let other = stream_key("tab-2", "page");
    for k in [&page, &side, &other] {
        for stream in ["elements", "requests"] {
            streams.subscribe(k, stream).unwrap();
        }
    }
    streams.remove_surface("tab-1");
    for k in [&page, &side] {
        for stream in ["elements", "requests"] {
            assert_eq!(streams.subscribers(k, stream), 0);
        }
    }
    assert_eq!(streams.subscribers(&other, "requests"), 1);
    streams.remove_region(&other);
    assert_eq!(streams.subscribers(&other, "requests"), 0);
    assert_eq!(streams.log_state(&other), (0, 0));
}

// contract: document.stream.request-log-replays-with-dropped
#[test]
fn stream_request_log_replays_its_last_entries_with_the_dropped_count() {
    let streams = Streams::default();
    let page = stream_key("tab-1", "page");
    streams.subscribe(&page, "requests").unwrap();
    let batch: Vec<Value> = (0..250).map(|i| json!({"url": format!("e{i}")})).collect();
    let result = streams
        .deliver(
            &page,
            &json!({"stream": "requests", "message": {"type": "entries", "entries": batch}})
                .to_string(),
        )
        .unwrap();
    assert_eq!(result.deliveries.len(), 1);
    assert!(!result.ack);
    assert_eq!(streams.log_state(&page), (200, 50));
    let (_, _, initial) = streams.subscribe(&page, "requests").unwrap();
    let replay = initial.expect("a requests subscription receives its log");
    assert_eq!(replay["type"], "entries");
    assert_eq!(replay["dropped"], 50);
    let entries = replay["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 200);
    assert_eq!(entries[0], json!({"url": "e50"}));
    assert_eq!(entries[199], json!({"url": "e249"}));
    let result = streams
        .deliver(
            &page,
            r#"{"stream":"requests","message":{"type":"entries","entries":[{"url":"e250"}]}}"#,
        )
        .unwrap();
    assert_eq!(result.deliveries.len(), 2);
    assert_eq!(
        result.deliveries[1].message,
        json!({"type": "entries", "entries": [{"url": "e250"}], "dropped": 51})
    );
}

// contract: document.stream.reset-clears-request-log
#[test]
fn stream_reset_clears_the_request_log() {
    let streams = Streams::default();
    let page = stream_key("tab-1", "page");
    streams.subscribe(&page, "requests").unwrap();
    streams
        .deliver(
            &page,
            r#"{"stream":"requests","message":{"type":"entries","entries":[{"url":"a"},{"url":"b"}]}}"#,
        )
        .unwrap();
    let result = streams
        .deliver(&page, r#"{"stream":"requests","message":{"type":"reset"}}"#)
        .unwrap();
    assert_eq!(result.deliveries.len(), 1);
    assert_eq!(result.deliveries[0].message, json!({"type": "reset"}));
    assert_eq!(streams.log_state(&page), (0, 0));
    let (_, _, initial) = streams.subscribe(&page, "requests").unwrap();
    assert_eq!(
        initial,
        Some(json!({"type": "entries", "entries": [], "dropped": 0}))
    );
}

// contract: document.stream.delivers-to-subscribing-surface-only
#[test]
fn stream_messages_reach_only_the_subscriptions_of_their_stream() {
    let streams = Streams::default();
    let page = stream_key("tab-1", "page");
    let other = stream_key("tab-2", "page");
    let (requests, _, _) = streams.subscribe(&page, "requests").unwrap();
    let (elements, _, _) = streams.subscribe(&page, "elements").unwrap();
    let (foreign, _, _) = streams.subscribe(&other, "requests").unwrap();
    let result = streams
        .deliver(
            &page,
            r#"{"stream":"requests","message":{"type":"entries","entries":[{"url":"a"}]}}"#,
        )
        .unwrap();
    assert_eq!(result.deliveries.len(), 1);
    assert_eq!(result.deliveries[0].surface, "tab-1");
    assert_eq!(result.deliveries[0].handle, requests);
    assert!(result.deliveries[0].handle != elements && result.deliveries[0].handle != foreign);
}

// contract: document.stream.snapshot-acknowledged-after-delivery
#[test]
fn stream_snapshot_is_acknowledged_after_its_delivery() {
    let streams = Streams::default();
    let page = stream_key("tab-1", "page");
    let (handle, _, _) = streams.subscribe(&page, "elements").unwrap();
    let snapshot = r#"{"stream":"elements","message":{"type":"snapshot","seq":3,"nodes":[{"depth":0,"tag":"html","id":"","class":""}],"total":1,"truncated":false}}"#;
    let result = streams.deliver(&page, snapshot).unwrap();
    assert!(result.ack);
    assert_eq!(result.seq, 3);
    assert_eq!(result.deliveries.len(), 1);
    assert_eq!(result.deliveries[0].handle, handle);
    assert_eq!(
        result.deliveries[0].message,
        json_of(
            r#"{"type":"snapshot","seq":3,"nodes":[{"depth":0,"tag":"html","id":"","class":""}],"total":1,"truncated":false}"#
        )
    );
    streams.unsubscribe(&page, handle).unwrap();
    let result = streams
        .deliver(
            &page,
            r#"{"stream":"elements","message":{"type":"snapshot","seq":4,"nodes":[],"total":0,"truncated":false}}"#,
        )
        .unwrap();
    assert!(result.ack);
    assert_eq!(result.seq, 4);
    assert!(result.deliveries.is_empty());
}

// contract: document.stream.rejects-unknown-message
#[test]
fn stream_rejects_invalid_messages() {
    let streams = Streams::default();
    let page = stream_key("tab-1", "page");
    streams.subscribe(&page, "elements").unwrap();
    for (body, want) in [
        ("not json", "document stream message is not JSON"),
        (
            r#"{"stream":"pixels","message":{"type":"reset"}}"#,
            r#"unknown document stream "pixels""#,
        ),
        (
            r#"{"stream":"requests","message":{"type":"pixels"}}"#,
            r#"document stream "requests" sent an unknown message type "pixels""#,
        ),
        (
            r#"{"stream":"elements","message":{"type":"snapshot"}}"#,
            r#"document stream "elements" snapshot has no seq"#,
        ),
    ] {
        assert_eq!(
            streams.deliver(&page, body).err().as_deref(),
            Some(want),
            "{body}"
        );
    }
}

// contract: document.stream.ack-refusal-names-seq
#[test]
fn stream_ack_refusal_names_the_document_stream_and_seq() {
    assert_eq!(
        stream_ack_refusal(&stream_key("tab-1", "page"), "elements", 7),
        r#"document "page" stream elements: seq 7 was not sent"#
    );
}

// contract: document.stream.process-end-removes-subscriptions, document.stream.window-close-removes-subscriptions
#[test]
fn stream_ended_surface_or_window_loses_its_subscriptions() {
    let streams = Streams::default();
    let page = stream_key("tab-1", "page");
    streams.subscribe(&page, "requests").unwrap();
    streams
        .deliver(
            &page,
            r#"{"stream":"requests","message":{"type":"entries","entries":[{"url":"a"}]}}"#,
        )
        .unwrap();
    streams.remove_surface("tab-1");
    assert_eq!(streams.subscribers(&page, "requests"), 0);
    assert_eq!(streams.log_state(&page), (0, 0));
}

// contract: document.stream.page-load-removes-subscriptions
#[test]
fn a_new_page_document_removes_the_subscriptions_of_its_surface() {
    let documents = Documents::default();
    let streams = Streams::default();
    let (page, side, other) = (
        stream_key("tab-1", "page"),
        stream_key("tab-1", "side"),
        stream_key("tab-2", "page"),
    );
    for (k, handle) in [(&page, 1), (&side, 2), (&other, 3)] {
        documents.reserve(k).unwrap();
        assert!(documents.set(k, handle));
        for stream in ["elements", "requests"] {
            streams.subscribe(k, stream).unwrap();
        }
    }
    let mut closed = remove_surface_for_reload(&documents, &streams, "tab-1");
    closed.sort();
    assert_eq!(closed, vec![1, 2]);
    for k in [&page, &side] {
        for stream in ["elements", "requests"] {
            assert_eq!(
                streams.subscribers(k, stream),
                0,
                "{k:?} {stream} kept a subscription after its page loaded a new document"
            );
        }
    }
    assert_eq!(streams.subscribers(&other, "requests"), 1);
    assert_eq!(streams.subscribers(&other, "elements"), 1);
    assert!(documents.get(&page).is_err());
    assert_eq!(documents.get(&other), Ok(3));
}

// contract: document.stream.process-end-removes-subscriptions
#[test]
fn a_page_process_end_removes_every_subscription_of_the_page() {
    let streams = Streams::default();
    let (first, second) = (stream_key("tab-1", "page"), stream_key("tab-2", "page"));
    streams.subscribe(&first, "requests").unwrap();
    streams.subscribe(&second, "elements").unwrap();
    streams
        .deliver(
            &first,
            r#"{"stream":"requests","message":{"type":"entries","entries":[{"url":"a"}]}}"#,
        )
        .unwrap();
    let mut effects = streams.remove_page();
    effects.sort_by(|a, b| a.key.cmp(&b.key));
    assert_eq!(
        effects,
        vec![
            StreamEffect {
                key: first.clone(),
                stream: "requests".to_string(),
                on: false,
            },
            StreamEffect {
                key: second.clone(),
                stream: "elements".to_string(),
                on: false,
            },
        ]
    );
    assert_eq!(streams.subscribers(&first, "requests"), 0);
    assert_eq!(streams.subscribers(&second, "elements"), 0);
    assert_eq!(streams.log_state(&first), (0, 0));
}

// contract: documents.query.reply-is-the-region-report
#[test]
fn document_query_reply_is_the_region_report() {
    assert_eq!(
        parse_report("page", r#"{"media":true,"capture":true,"form":false}"#),
        Ok(Report {
            media: true,
            capture: true,
            form: false
        })
    );
    assert_eq!(
        parse_report("page", r#"{"error":"the document region is closed"}"#),
        Err("document page: the document region is closed".into())
    );
    for reply in [
        r#"{"media":"playing","capture":false,"form":false}"#,
        r#"{"media":false,"capture":false}"#,
        "not json",
    ] {
        assert_eq!(
            parse_report("page", reply),
            Err(format!(
                "document page answered an invalid query reply: {reply}"
            ))
        );
    }
}

// contract: documents.request.interaction-state-must-not-be-empty
#[test]
fn document_interaction_state_must_not_be_empty() {
    let absent = request("s", "d");
    assert_eq!(absent.restore_state(), Ok(None));
    let empty: Request =
        serde_json::from_str(r#"{"surface":"s","document":"d","interactionState":""}"#).unwrap();
    assert_eq!(
        empty.restore_state(),
        Err("document interactionState must not be empty".into())
    );
    let state: Request =
        serde_json::from_str(r#"{"surface":"s","document":"d","interactionState":"AAAA"}"#)
            .unwrap();
    assert_eq!(state.restore_state(), Ok(Some("AAAA")));
}

// contract: view.create-loads-page
#[test]
fn a_view_surface_creates_a_view_configuration_and_loads_its_page() {
    // The view is created with the channel script, and the page is loaded from sok://<plugin>/<page> right after creation.
    let created = std::cell::RefCell::new(Vec::new());
    let loaded = std::cell::RefCell::new(Vec::new());
    let closed = std::cell::RefCell::new(Vec::new());
    let handle = soksak_host_tauriv2::documents::create_view(
        "channel-script",
        |channel| {
            created.borrow_mut().push(channel.to_string());
            Ok(7)
        },
        |document, url| {
            loaded.borrow_mut().push((document, url.to_string()));
            Ok(true)
        },
        |document| {
            closed.borrow_mut().push(document);
            Ok(())
        },
        "probe",
        "ui/page.html",
    )
    .expect("the view is created");
    assert_eq!(handle, 7, "the created view is returned");
    assert_eq!(
        *created.borrow(),
        vec!["channel-script".to_string()],
        "the view configuration is created with the channel script"
    );
    assert_eq!(
        *loaded.borrow(),
        vec![(7, "sok://probe/ui/page.html".to_string())],
        "the view loads its page at creation"
    );
    assert!(closed.borrow().is_empty(), "a loaded view is not closed");
}

const READY: &str = r#"{"message":{"event":"view.ready","plugin":"probe","document":"doc-1"}}"#;

// contract: view.channel.ready
#[test]
fn view_channel_records_the_ready_document_and_clears_it_on_navigation() {
    let channels = soksak_host_tauriv2::documents::ViewChannels::default();
    channels.register("probe-surface", "probe");
    assert_eq!(
        channels.message("probe-surface", READY),
        Ok(true),
        "a ready message makes the view ready"
    );
    assert_eq!(channels.check_post("probe-surface"), Ok(()));
    assert_eq!(
        channels.state("probe-surface", r#"{"loading":true}"#),
        Ok(())
    );
    assert_eq!(
        channels.check_post("probe-surface"),
        Err("probe-surface has no ready document".to_string()),
        "a navigation clears the ready record"
    );
}

// contract: view.channel.post-before-ready
#[test]
fn view_channel_refuses_a_post_before_ready_with_its_text() {
    let channels = soksak_host_tauriv2::documents::ViewChannels::default();
    channels.register("probe-surface", "probe");
    assert_eq!(
        channels.check_post("probe-surface"),
        Err("probe-surface has no ready document".to_string())
    );
}

// contract: view.channel.queue-full
#[test]
fn view_channel_reports_queue_full_and_foreign_frame_with_their_reasons() {
    let channels = soksak_host_tauriv2::documents::ViewChannels::default();
    channels.register("probe-surface", "probe");
    assert_eq!(
        channels.message(
            "probe-surface",
            r#"{"message":{"event":"view.error","plugin":"probe","reason":"queue full for probe"}}"#
        ),
        Err("queue full for probe".to_string())
    );
    assert_eq!(
        channels.message(
            "probe-surface",
            r#"{"error":"the view channel message comes from a frame that is not the main frame"}"#
        ),
        Err("the view channel message comes from a frame that is not the main frame".to_string())
    );
}

/// Returns the instant that is the given number of seconds after start, so each failure of a test has a fixed time.
fn seconds_after(start: Instant, seconds: u64) -> Instant {
    start + Duration::from_secs(seconds)
}

// contract: view.restart.limit
#[test]
fn view_restart_stops_at_the_fourth_failure_within_the_window() {
    // The failures are passed with their instants, so the window is measured without a timer.
    let lifecycle = ViewLifecycle::default();
    let start = Instant::now();
    let spec = lifecycle.track("probe-surface", 7, "probe", "ui/page.html", true);
    assert_eq!(
        spec.surface_handle, 7,
        "the record keeps the native surface of the view"
    );
    assert_eq!(
        lifecycle.spec("probe-surface").map(|kept| kept.page),
        Some("ui/page.html".to_string()),
        "the record of the view is kept for the restart"
    );
    assert!(
        lifecycle.fail("probe-surface", start),
        "the first failure restarts the view"
    );
    assert!(
        lifecycle.fail("probe-surface", seconds_after(start, 60)),
        "the second failure restarts the view"
    );
    assert!(
        lifecycle.fail("probe-surface", seconds_after(start, 120)),
        "the third failure restarts the view"
    );
    assert!(
        !lifecycle.fail("probe-surface", seconds_after(start, 180)),
        "the fourth failure within 300 seconds stops the restarts"
    );
    assert!(lifecycle.is_stopped("probe-surface"));
    assert!(
        !lifecycle.fail("probe-surface", seconds_after(start, 190)),
        "a stopped surface records no restart"
    );
    lifecycle.forget("probe-surface");
    assert!(
        !lifecycle.is_stopped("probe-surface"),
        "a removed surface clears its stop, so the reopened tab starts with no failure"
    );
    assert!(
        lifecycle.fail("probe-surface", seconds_after(start, 200)),
        "the reopened view restarts after a failure"
    );
}

// contract: view.channel.overflow-closes
#[test]
fn view_channel_overflow_is_the_queue_full_reason_that_closes_the_view() {
    let channels = ViewChannels::default();
    channels.register("probe-surface", "probe");
    let reason = channels
        .message(
            "probe-surface",
            r#"{"message":{"event":"view.error","plugin":"probe","reason":"queue full for probe"}}"#,
        )
        .expect_err("a queue full report is an error of the view");
    assert!(
        is_queue_full(&reason),
        "the queue full reason closes the view: {reason}"
    );
    assert!(
        !is_queue_full("the view channel message comes from a frame that is not the main frame"),
        "a foreign frame message does not close the view"
    );
}

// contract: view.call.forward
#[test]
fn view_call_request_is_forwarded_with_its_plugin_and_surface() {
    let channels = soksak_host_tauriv2::documents::ViewChannels::default();
    channels.register("probe-surface", "probe");
    assert_eq!(
        channels.call(
            "probe-surface",
            r#"{"message":{"sok":1,"id":7,"command":"tab.state.read","params":{"a":1}}}"#
        ),
        Ok(Some(json!({
            "surface": "probe-surface",
            "plugin": "probe",
            "id": 7,
            "command": "tab.state.read",
            "params": {"a": 1}
        }))),
        "a call request is forwarded with its surface and plugin"
    );
    assert_eq!(channels.call("probe-surface", READY), Ok(None), "a ready message is not a call");
}

// contract: view.call.reply
#[test]
fn view_call_reply_is_the_channel_message_with_its_id() {
    use soksak_host_tauriv2::documents::{ViewReply, ViewReplyError, view_reply_message};
    let result = ViewReply {
        surface: "probe-surface".to_string(),
        id: 7,
        result: Some(json!({"count": 2})),
        error: None,
    };
    assert_eq!(
        view_reply_message(&result),
        Ok(json!({"sok": 1, "id": 7, "result": {"count": 2}}))
    );
    let failed = ViewReply {
        surface: "probe-surface".to_string(),
        id: 8,
        result: None,
        error: Some(ViewReplyError {
            code: -32000,
            message: "tab.state is not declared".to_string(),
        }),
    };
    assert_eq!(
        view_reply_message(&failed),
        Ok(json!({"sok": 1, "id": 8, "error": {"code": -32000, "message": "tab.state is not declared"}}))
    );
    let empty = ViewReply {
        surface: "probe-surface".to_string(),
        id: 9,
        result: None,
        error: None,
    };
    assert_eq!(
        view_reply_message(&empty),
        Err("view reply 9 has neither a result nor an error".to_string())
    );
}

// contract: view.call.forward
#[test]
fn view_call_cancel_and_invalid_requests_are_errors_not_forwarded() {
    let channels = soksak_host_tauriv2::documents::ViewChannels::default();
    channels.register("probe-surface", "probe");
    for message in [
        r#"{"message":{"id":7,"cancel":true}}"#,
        r#"{"message":{"command":"tab.state.read"}}"#,
        r#"{"message":{"id":"7","command":"tab.state.read"}}"#,
        r#"{"message":{"id":7,"command":""}}"#,
    ] {
        assert!(
            channels.call("probe-surface", message).is_err(),
            "message {message} is accepted, want an error"
        );
    }
}
