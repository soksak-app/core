//! Checks the owning surface check of document region requests and the document region list of a window.

use serde_json::{Value, json};
use std::time::{Duration, Instant};

use soksak_host_tauriv2::documents::{
    Documents, Key, Report, Request, StreamEffect, Streams, ViewChannels, check, go_action,
    parse_report, remove_surface_for_reload, remove_view_regions, stream_ack_refusal,
};
use soksak_host_tauriv2::images::Images;
use soksak_host_tauriv2::surfaces::ViewStart;
use soksak_host_tauriv2::view_lifecycle::{
    ViewLifecycle, is_queue_full, view_process_ended_event, view_stop_reason, view_stopped_event,
};

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
    let spec = lifecycle.track(
        "probe-surface",
        7,
        "probe",
        "ui/page.html",
        true,
        ViewStart::default(),
    );
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

// contract: view.restart.restores-state
#[test]
fn view_restart_keeps_the_surface_and_plugin_of_its_record() {
    let lifecycle = ViewLifecycle::default();
    let start = Instant::now();
    lifecycle.track(
        "probe-surface",
        7,
        "probe",
        "ui/page.html",
        true,
        ViewStart::default(),
    );
    assert!(
        lifecycle.fail("probe-surface", start),
        "the failure restarts the view"
    );
    let spec = lifecycle
        .spec("probe-surface")
        .expect("the record of the view is kept for the restart");
    assert_eq!(
        spec.surface_handle, 7,
        "the restart creates the view on the native surface of its record"
    );
    assert_eq!(
        spec.plugin, "probe",
        "the restart keeps the plugin of the view"
    );
}

// contract: view.restart.limit-shows-error
#[test]
fn view_stop_event_names_the_surface_plugin_and_reason() {
    assert_eq!(
        view_stop_reason(),
        "the view failed 4 times within 300 seconds and is created again when its tab is reopened"
    );
    let event = view_stopped_event("probe-surface", "probe");
    assert_eq!(
        event["surface"], "probe-surface",
        "the event names the surface"
    );
    assert_eq!(event["plugin"], "probe", "the event names the plugin");
    assert_eq!(
        event["reason"],
        view_stop_reason(),
        "the event carries the stop reason"
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
    assert_eq!(
        channels.call("probe-surface", READY),
        Ok(None),
        "a ready message is not a call"
    );
}

// contract: view.declared-ui.snapshot
#[test]
fn view_declared_snapshot_is_forwarded_with_its_surface_and_plugin() {
    let channels = ViewChannels::default();
    channels.register("probe-surface", "probe");
    assert_eq!(
        channels.snapshot(
            "probe-surface",
            r#"{"message":{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":3,"value":{"elements":[]},"skipped":1}}"#,
        ),
        Ok(Some(json!({
            "surface": "probe-surface",
            "plugin": "probe",
            "status": "probe.lines",
            "seq": 3,
            "skipped": 1,
            "value": {"elements": []}
        }))),
        "a snapshot is forwarded with its surface and plugin"
    );
    // A value of null stays present: the receiver validates it like any other value (docs/spec/declared-ui.md).
    assert_eq!(
        channels.snapshot(
            "probe-surface",
            r#"{"message":{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":1,"value":null,"skipped":0}}"#,
        ),
        Ok(Some(json!({
            "surface": "probe-surface",
            "plugin": "probe",
            "status": "probe.lines",
            "seq": 1,
            "skipped": 0,
            "value": null
        }))),
        "a snapshot with a null value keeps the value present"
    );
    assert_eq!(
        channels.snapshot("probe-surface", READY),
        Ok(None),
        "a ready message is not a snapshot"
    );
}

// contract: view.declared-ui.snapshot
#[test]
fn view_declared_snapshot_invalid_fields_are_errors_not_forwarded() {
    let channels = ViewChannels::default();
    channels.register("probe-surface", "probe");
    for (message, want) in [
        (
            r#"{"event":"declared-ui.snapshot","status":"probe.lines","seq":1,"value":null,"skipped":0}"#,
            "probe-surface: declared UI snapshot names no plugin",
        ),
        (
            r#"{"event":"declared-ui.snapshot","plugin":"other","status":"probe.lines","seq":1,"value":null,"skipped":0}"#,
            "probe-surface: declared UI snapshot names plugin \"other\", want plugin \"probe\"",
        ),
        (
            r#"{"event":"declared-ui.snapshot","plugin":"probe","seq":1,"value":null,"skipped":0}"#,
            "probe-surface: declared UI snapshot has no status",
        ),
        (
            r#"{"event":"declared-ui.snapshot","plugin":"probe","status":"","seq":1,"value":null,"skipped":0}"#,
            "probe-surface: declared UI snapshot has no status",
        ),
        (
            r#"{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","value":null,"skipped":0}"#,
            "probe-surface: declared UI snapshot of status \"probe.lines\" has no seq from 1",
        ),
        (
            r#"{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":0,"value":null,"skipped":0}"#,
            "probe-surface: declared UI snapshot of status \"probe.lines\" has no seq from 1",
        ),
        (
            r#"{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":1,"value":null}"#,
            "probe-surface: declared UI snapshot of status \"probe.lines\" has no skipped count",
        ),
        (
            r#"{"event":"declared-ui.snapshot","plugin":"probe","status":"probe.lines","seq":1,"skipped":0}"#,
            "probe-surface: declared UI snapshot of status \"probe.lines\" has no value",
        ),
    ] {
        let wrapped = format!(r#"{{"message":{message}}}"#);
        assert_eq!(
            channels.snapshot("probe-surface", &wrapped),
            Err(want.to_string()),
            "the snapshot {message} is an error, not a forwarding"
        );
    }
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
        Ok(
            json!({"sok": 1, "id": 8, "error": {"code": -32000, "message": "tab.state is not declared"}})
        )
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

// contract: view.channel.ready
#[test]
fn theme_message_carries_the_theme_in_its_data_field() {
    use soksak_host_tauriv2::documents::theme_message;
    let theme = json!({"scheme": "dark", "tokens": {"bg": "#000000"}});
    assert_eq!(
        theme_message(&theme),
        json!({"sok": 1, "event": "theme", "data": {"scheme": "dark", "tokens": {"bg": "#000000"}}}),
        "the theme message carries the theme in its data field, as every event does"
    );
}

// contract: view.command.request
#[test]
fn view_request_message_is_the_host_message_with_its_id_command_and_params() {
    use soksak_host_tauriv2::documents::{ViewRequest, view_request_message};
    let request = ViewRequest {
        surface: "probe-surface".to_string(),
        id: 7,
        command: "probe.run".to_string(),
        params: Some(json!({"a": 1})),
    };
    assert_eq!(
        view_request_message(&request),
        Ok(json!({"sok": 1, "id": 7, "command": "probe.run", "params": {"a": 1}})),
        "a request is posted with the sok marker, its id, its command and its params"
    );
    let no_params = ViewRequest {
        surface: "probe-surface".to_string(),
        id: 7,
        command: "probe.run".to_string(),
        params: None,
    };
    assert_eq!(
        view_request_message(&no_params),
        Ok(json!({"sok": 1, "id": 7, "command": "probe.run", "params": null })),
        "a request without params carries null"
    );
    let no_id = ViewRequest {
        surface: "probe-surface".to_string(),
        id: 0,
        command: "probe.run".to_string(),
        params: None,
    };
    assert_eq!(
        view_request_message(&no_id),
        Err("view request has no id".to_string())
    );
    let unnamed = ViewRequest {
        surface: "probe-surface".to_string(),
        id: 8,
        command: String::new(),
        params: None,
    };
    assert_eq!(
        view_request_message(&unnamed),
        Err("view request 8 has an empty command".to_string())
    );
}

// contract: view.command.request
#[test]
fn view_reply_is_forwarded_as_a_view_reply_event_with_its_plugin_and_surface() {
    let channels = soksak_host_tauriv2::documents::ViewChannels::default();
    channels.register("probe-surface", "probe");
    assert_eq!(
        channels.reply(
            "probe-surface",
            r#"{"message":{"sok":1,"reply":7,"result":{"n":2}}}"#
        ),
        Ok(Some(json!({
            "surface": "probe-surface",
            "plugin": "probe",
            "id": 7,
            "result": {"n": 2}
        }))),
        "a reply with a result is forwarded with its surface, plugin and id"
    );
    assert_eq!(
        channels.reply(
            "probe-surface",
            r#"{"message":{"sok":1,"reply":8,"error":{"code":-32000,"message":"boom"}}}"#
        ),
        Ok(Some(json!({
            "surface": "probe-surface",
            "plugin": "probe",
            "id": 8,
            "error": {"code": -32000, "message": "boom"}
        }))),
        "a reply with an error is forwarded with its error"
    );
    assert_eq!(
        channels.reply("probe-surface", READY),
        Ok(None),
        "a ready message is not a reply"
    );
    for message in [
        r#"{"message":{"reply":"7","result":1}}"#,
        r#"{"message":{"reply":7}}"#,
        r#"{"message":{"reply":7,"result":1,"error":{"code":1,"message":"x"}}}"#,
        r#"{"message":{"reply":7,"error":{"code":1}}}"#,
    ] {
        assert!(
            channels.reply("probe-surface", message).is_err(),
            "an invalid reply is refused: {message}"
        );
    }
}

// contract: view.event.push
#[test]
fn view_event_message_is_the_host_message_with_its_event_and_data() {
    use soksak_host_tauriv2::documents::{ViewEventRequest, view_event_message};
    let event = ViewEventRequest {
        surface: "probe-surface".to_string(),
        event: "probe.changed".to_string(),
        data: Some(json!({"count": 2})),
    };
    assert_eq!(
        view_event_message(&event),
        Ok(json!({"sok": 1, "event": "probe.changed", "data": {"count": 2}})),
        "an event is posted with the sok marker, its name and its data"
    );
    let null_data = ViewEventRequest {
        surface: "probe-surface".to_string(),
        event: "probe.changed".to_string(),
        data: Some(Value::Null),
    };
    assert_eq!(
        view_event_message(&null_data),
        Ok(json!({"sok": 1, "event": "probe.changed", "data": null })),
        "a null data is a value and is posted"
    );
    let unnamed = ViewEventRequest {
        surface: "probe-surface".to_string(),
        event: String::new(),
        data: Some(json!(1)),
    };
    assert_eq!(
        view_event_message(&unnamed),
        Err("view event has an empty event name".to_string())
    );
    let no_data = ViewEventRequest {
        surface: "probe-surface".to_string(),
        event: "probe.changed".to_string(),
        data: None,
    };
    assert_eq!(
        view_event_message(&no_data),
        Err("view event probe.changed has no data".to_string())
    );
}

// contract: view.call.cancel
#[test]
fn view_call_cancel_is_forwarded_with_its_plugin_and_surface() {
    let channels = soksak_host_tauriv2::documents::ViewChannels::default();
    channels.register("probe-surface", "probe");
    assert_eq!(
        channels.call("probe-surface", r#"{"message":{"id":7,"cancel":true}}"#),
        Ok(Some(json!({
            "surface": "probe-surface",
            "plugin": "probe",
            "id": 7,
            "cancel": true
        }))),
        "a cancel message is forwarded with its surface and plugin"
    );
}

// contract: view.call.forward
#[test]
fn view_call_invalid_requests_are_errors_not_forwarded() {
    let channels = soksak_host_tauriv2::documents::ViewChannels::default();
    channels.register("probe-surface", "probe");
    for message in [
        r#"{"message":{"id":"7","cancel":true}}"#,
        r#"{"message":{"id":7,"cancel":false}}"#,
        r#"{"message":{"id":7,"cancel":true,"command":"tab.state.read"}}"#,
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

// contract: view.regions.close-with-process
// contract: view.process-ended.forgets-regions
#[test]
fn a_view_process_end_sends_the_process_ended_event_of_its_surface() {
    // The page forgets the regions of the surface when this event arrives, so the payload names the surface.
    let event = view_process_ended_event("probe-surface");
    assert_eq!(
        event,
        serde_json::json!({"surface": "probe-surface"}),
        "the process-ended event names the surface"
    );
}

#[test]
fn a_view_process_end_removes_the_regions_of_its_surface() {
    // The view itself is removed before the regions, as view_failed removes it, so only the regions remain to be closed.
    let documents = Documents::default();
    let streams = Streams::default();
    let images = Images::default();
    let document: Key = ("probe-surface".to_string(), "doc".to_string());
    documents.reserve(&document).unwrap();
    assert!(documents.set(&document, 11));
    let other: Key = ("other-surface".to_string(), "doc".to_string());
    documents.reserve(&other).unwrap();
    assert!(documents.set(&other, 13));
    let image = ("probe-surface".to_string(), "picture".to_string());
    images.reserve(&image, "probe-surface", "@probe/sidecar").unwrap();
    assert!(images.set(&image, 12));
    let (closed_documents, closed_images) =
        remove_view_regions(&documents, &streams, &images, "probe-surface");
    assert_eq!(closed_documents, vec![11], "the document region of the surface is closed");
    assert_eq!(closed_images, vec![12], "the image region of the surface is closed");
    assert!(
        documents.reserve(&document).is_ok(),
        "the view created again attaches the document region again"
    );
    assert!(
        images.reserve(&image, "probe-surface", "@probe/sidecar").is_ok(),
        "the view created again attaches the image region again"
    );
    assert_eq!(documents.get(&other), Ok(13), "the regions of another surface stay");
}
