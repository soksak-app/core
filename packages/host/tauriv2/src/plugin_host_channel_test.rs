//! The channel of a plugin host page (docs/spec/plugin-host.md#channel).

use serde_json::{Value, json};

use crate::documents::ViewReplyError;
use crate::plugin_host::{HostState, PluginHostStates, PluginHosts};
use crate::plugin_host_channel::{
    PluginHostChannels, PluginHostEvent, PluginHostReply, PluginHostRequest, Received, end_host,
    ended_event, event_message, host_end_report, late_message_error, late_state_error,
    plugin_host_queue_full, reply_message, request_message,
};

/// Returns the channels of a window with the host of plugin probe and, when ready is set, the ready document doc-1.
fn host_channels(ready: bool) -> PluginHostChannels {
    let channels = PluginHostChannels::default();
    channels.register("probe", None, 1);
    if ready {
        channels
            .receive(
                "probe",
                &host_message(r#"{"event": "view.ready", "plugin": "probe", "document": "doc-1"}"#),
            )
            .expect("the ready message is accepted");
    }
    channels
}

/// Returns the envelope of the sok-view handler of a host page around the message value.
fn host_message(value: &str) -> String {
    format!(r#"{{"message": {value}}}"#)
}

// contract: plugin-host.channel.reply
#[test]
fn a_reply_of_the_page_goes_to_the_main_page_as_plugin_host_reply_without_a_surface() {
    let channels = host_channels(true);
    assert_eq!(
        channels.receive(
            "probe",
            &host_message(r#"{"reply": 7, "result": {"sum": 3}}"#)
        ),
        Ok(Received::Emit(
            "plugin-host-reply",
            json!({"plugin": "probe", "generation": 1, "id": 7, "result": {"sum": 3}})
        ))
    );
    assert_eq!(
        channels.receive("probe", &host_message(r#"{"reply": 8, "result": null}"#)),
        Ok(Received::Emit(
            "plugin-host-reply",
            json!({"plugin": "probe", "generation": 1, "id": 8, "result": null})
        ))
    );
    for message in [
        r#"{"reply": 7}"#,
        r#"{"reply": 7, "result": null, "error": {"code": -32000, "message": "x"}}"#,
        r#"{"reply": 7, "result": 1, "error": null}"#,
        r#"{"reply": 7, "result": null, "error": null}"#,
        r#"{"reply": 7, "error": null}"#,
        r#"{"reply": 7, "result": 1, "error": {"code": -32000, "message": "x"}}"#,
        r#"{"reply": 7, "error": {"message": "x"}}"#,
        r#"{"reply": 7, "error": {"code": -32000}}"#,
        r#"{"reply": "7", "result": 1}"#,
    ] {
        assert!(
            channels.receive("probe", &host_message(message)).is_err(),
            "the reply {message} is accepted"
        );
    }
}

// contract: plugin-host.channel.call-served-set
#[test]
fn the_host_forwards_the_sidecar_calls_to_the_main_page() {
    let channels = host_channels(true);
    let params =
        json!({"id": "plugin:probe:project-a:fixture-sidecar", "sidecar": "fixture-sidecar"});
    for (id, command) in [
        (7, "runtime.sidecar.send"),
        (8, "runtime.sidecar.on"),
        (9, "runtime.sidecar.onFailure"),
    ] {
        let message = format!(r#"{{"id": {id}, "command": "{command}", "params": {params}}}"#);
        assert_eq!(
            channels.receive("probe", &host_message(&message)),
            Ok(Received::Emit(
                "plugin-host-call",
                json!({"plugin": "probe", "generation": 1, "id": id, "command": command, "params": params})
            ))
        );
    }
}

// contract: plugin-host.data.calls
#[test]
fn the_host_forwards_the_project_data_calls_to_the_main_page() {
    let channels = host_channels(true);
    for (id, command, params) in [
        (13, "runtime.data.get", json!({"key": "note"})),
        (
            14,
            "runtime.data.set",
            json!({"key": "note", "value": "new"}),
        ),
    ] {
        let message = format!(r#"{{"id": {id}, "command": "{command}", "params": {params}}}"#);
        assert_eq!(
            channels.receive("probe", &host_message(&message)),
            Ok(Received::Emit(
                "plugin-host-call",
                json!({"plugin": "probe", "generation": 1, "id": id, "command": command, "params": params})
            ))
        );
    }
}

// contract: plugin-host.channel.call-served-set
#[test]
fn the_host_forwards_only_the_registration_calls_and_refuses_every_other_call() {
    let channels = host_channels(true);
    for command in [
        "runtime.native.off",
        "tab.state.read",
        "runtime.clipboard.read",
        "runtime.links.open",
    ] {
        let message = format!(r#"{{"id": 4, "command": "{command}", "params": {{"name": "x"}}}}"#);
        assert_eq!(
            channels.receive("probe", &host_message(&message)),
            Ok(Received::Post(json!({
                "sok": 1,
                "id": 4,
                "error": {"code": -32000, "message": format!("plugin host call {command} is not served")},
            })))
        );
    }
    assert!(
        channels.open_calls("probe").is_empty(),
        "a refused call is open"
    );
    for (id, command) in [
        (5, "page.exposure.register"),
        (6, "runtime.command.register"),
        (7, "runtime.native.on"),
        (8, "runtime.native.call"),
    ] {
        let message =
            format!(r#"{{"id": {id}, "command": "{command}", "params": {{"name": "probe.x"}}}}"#);
        assert_eq!(
            channels.receive("probe", &host_message(&message)),
            Ok(Received::Emit(
                "plugin-host-call",
                json!({"plugin": "probe", "generation": 1, "id": id, "command": command, "params": {"name": "probe.x"}})
            ))
        );
    }
    assert_eq!(
        channels.open_calls("probe"),
        [
            "page.exposure.register",
            "runtime.command.register",
            "runtime.native.on",
            "runtime.native.call",
        ]
    );
    // A cancel goes to the main page; the call stays open until the main page answers it, as for a view.
    assert_eq!(
        channels.receive("probe", &host_message(r#"{"id": 5, "cancel": true}"#)),
        Ok(Received::Emit(
            "plugin-host-call",
            json!({"plugin": "probe", "generation": 1, "id": 5, "cancel": true})
        ))
    );
    channels.answer_call("probe", 1, 5);
    assert_eq!(
        channels.open_calls("probe"),
        [
            "runtime.command.register",
            "runtime.native.on",
            "runtime.native.call"
        ]
    );
    for message in [
        r#"{"command": "x"}"#,
        r#"{"id": 9, "command": ""}"#,
        r#"{"id": 9, "cancel": true, "command": "x"}"#,
    ] {
        assert!(
            channels.receive("probe", &host_message(message)).is_err(),
            "the call {message} is accepted"
        );
    }
}

// contract: plugin-host.error.display
#[test]
fn the_host_forwards_the_error_call_to_the_main_page() {
    let channels = host_channels(true);
    let params = json!({"where": "listing", "text": "cannot read folder"});
    let message = format!(r#"{{"id": 15, "command": "runtime.error", "params": {params}}}"#);
    assert_eq!(
        channels.receive("probe", &host_message(&message)),
        Ok(Received::Emit(
            "plugin-host-call",
            json!({"plugin": "probe", "generation": 1, "id": 15, "command": "runtime.error", "params": params})
        ))
    );
}

// contract: plugin-host.command.run
#[test]
fn the_host_forwards_the_command_call_to_the_main_page() {
    let channels = host_channels(true);
    let params = json!({"name": "core.file.open", "params": {"path": "notes.md"}});
    let message = format!(r#"{{"id": 16, "command": "runtime.command", "params": {params}}}"#);
    assert_eq!(
        channels.receive("probe", &host_message(&message)),
        Ok(Received::Emit(
            "plugin-host-call",
            json!({"plugin": "probe", "generation": 1, "id": 16, "command": "runtime.command", "params": params})
        ))
    );
}

// contract: plugin-host.log.write
#[test]
fn the_host_forwards_the_log_call_to_the_main_page() {
    let channels = host_channels(true);
    let params =
        json!({"level": "info", "event": "input.key", "fields": {"key": "a"}, "cids": ["c.1"]});
    let message = format!(r#"{{"id": 17, "command": "runtime.log", "params": {params}}}"#);
    assert_eq!(
        channels.receive("probe", &host_message(&message)),
        Ok(Received::Emit(
            "plugin-host-call",
            json!({"plugin": "probe", "generation": 1, "id": 17, "command": "runtime.log", "params": params})
        ))
    );
}

// contract: plugin-host.channel.snapshot
#[test]
fn a_snapshot_of_the_page_goes_to_the_main_page_without_a_surface() {
    let channels = host_channels(true);
    assert_eq!(
        channels.receive(
            "probe",
            &host_message(
                r#"{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "seq": 2, "skipped": 1, "value": {"x": 1}}"#
            )
        ),
        Ok(Received::Emit(
            "declared-ui-snapshot",
            json!({"plugin": "probe", "generation": 1, "status": "list", "seq": 2, "skipped": 1, "value": {"x": 1}})
        ))
    );
    // Tauri accepts only alphanumeric characters, '-', '/', ':' and '_' in a window event name, so the name of the relayed snapshot
    // must be one of them (the host refuses any other name at emit).
    match channels.receive(
        "probe",
        &host_message(r#"{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "seq": 3, "skipped": 0, "value": null}"#),
    ) {
        Ok(Received::Emit(name, _)) => assert!(
            name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')),
            "the window event name {name:?} has a character that Tauri refuses"
        ),
        other => panic!("a snapshot is not relayed: {other:?}"),
    }
    for message in [
        r#"{"event": "declared-ui.snapshot", "status": "list", "seq": 2, "skipped": 0, "value": null}"#,
        r#"{"event": "declared-ui.snapshot", "plugin": "other", "status": "list", "seq": 2, "skipped": 0, "value": null}"#,
        r#"{"event": "declared-ui.snapshot", "plugin": "probe", "seq": 2, "skipped": 0, "value": null}"#,
        r#"{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "skipped": 0, "value": null}"#,
        r#"{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "seq": 0, "skipped": 0, "value": null}"#,
        r#"{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "seq": 2, "value": null}"#,
        r#"{"event": "declared-ui.snapshot", "plugin": "probe", "status": "list", "seq": 2, "skipped": 0}"#,
    ] {
        assert!(
            channels.receive("probe", &host_message(message)).is_err(),
            "the snapshot {message} is accepted"
        );
    }
}

// contract: plugin-host.channel.source-generation
#[test]
fn a_plugin_host_snapshot_carries_its_native_source_generation() {
    let channels = PluginHostChannels::default();
    channels.register("probe", None, 1);
    let snapshot = channels
        .receive(
            "probe",
            &host_message(
                r#"{"event":"declared-ui.snapshot","plugin":"probe","status":"items","seq":1,"skipped":0,"value":{"n":1}}"#,
            ),
        )
        .expect("the current host snapshot is valid");
    assert_eq!(
        snapshot,
        Received::Emit(
            "declared-ui-snapshot",
            json!({"plugin":"probe","generation":1,"status":"items","seq":1,"skipped":0,"value":{"n":1}})
        ),
        "the host snapshot has no native source generation"
    );
}

// contract: plugin-host.channel.source-generation
#[test]
fn an_old_ack_generation_does_not_post_to_a_replacement_host() {
    let posts = std::cell::Cell::new(0);
    let stale = crate::plugin_host_channel::post_if_generation_current(
        1,
        Some(2),
        || true,
        || {
            posts.set(posts.get() + 1);
            Ok(true)
        },
    );
    assert_eq!(stale, Ok(false));
    assert_eq!(posts.get(), 0, "stale ACK reached the replacement provider");

    let current = crate::plugin_host_channel::post_if_generation_current(
        2,
        Some(2),
        || true,
        || {
            posts.set(posts.get() + 1);
            Ok(true)
        },
    );
    assert_eq!(current, Ok(true));
    assert_eq!(posts.get(), 1, "current ACK was not posted exactly once");
}

// contract: plugin-host.channel.source-generation
#[test]
fn a_stale_pull_returns_an_explicit_source_cancellation() {
    assert_eq!(
        crate::plugin_host_channel::request_disposition(7, false),
        json!({"cancelled": true, "sourceGeneration": 7}),
    );
    assert_eq!(
        crate::plugin_host_channel::request_disposition(7, true),
        Value::Null,
        "an accepted pull remains pending for the provider reply"
    );
}

// contract: plugin-host.channel.stale-instance-message
#[test]
fn a_delayed_callback_from_a_disposed_host_is_not_received_by_a_recreated_host() {
    let channels = PluginHostChannels::default();
    let old_instance = channels.register("probe", None, 1);
    channels
        .receive(
            "probe",
            &host_message(r#"{"event": "view.ready", "plugin": "probe", "document": "doc-1"}"#),
        )
        .expect("the old host's ready message is accepted");
    let message = host_message(
        r#"{"event":"declared-ui.snapshot","plugin":"probe","status":"items","seq":1,"skipped":0,"value":{"source":"old"}}"#,
    );
    let delayed_callback = || channels.receive_from("probe", &old_instance, &message);
    channels.unregister("probe");
    let current_instance = channels.register("probe", None, 2);
    assert!(
        !std::sync::Arc::ptr_eq(&old_instance, &current_instance),
        "a recreated provider has a new local identity independent of its native handle"
    );
    assert_eq!(
        delayed_callback(),
        Ok(crate::plugin_host_channel::ProviderMessage::Stale(None)),
        "a callback of the disposed instance must be canceled after recreation"
    );
    let old_error = channels.receive_from(
        "probe",
        &old_instance,
        &host_message(r#"{"event":"view.error","reason":"queue full for probe"}"#),
    );
    assert_eq!(
        old_error,
        Ok(crate::plugin_host_channel::ProviderMessage::Stale(Some(
            "plugin probe: queue full for probe".to_string()
        ))),
        "an old queue error remains reportable without failing the replacement host"
    );
    assert!(matches!(
        channels.receive_from(
            "probe",
            &current_instance,
            &host_message(
                r#"{"event":"declared-ui.snapshot","plugin":"probe","status":"items","seq":1,"skipped":0,"value":{"source":"current"}}"#
            )
        ),
        Ok(crate::plugin_host_channel::ProviderMessage::Current(
            Received::Emit("declared-ui-snapshot", _)
        ))
    ));
}

// contract: plugin-host.channel.stale-instance-message
#[test]
fn a_callback_during_creation_uses_the_registered_instance_before_the_native_handle_is_stored() {
    let channels = PluginHostChannels::default();
    let instance = channels.register("probe", None, 1);
    assert!(matches!(
        channels.receive_from(
            "probe",
            &instance,
            &host_message(
                r#"{"event":"declared-ui.snapshot","plugin":"probe","status":"items","seq":1,"skipped":0,"value":{"source":"early"}}"#
            )
        ),
        Ok(crate::plugin_host_channel::ProviderMessage::Current(
            Received::Emit("declared-ui-snapshot", _)
        )),
    ), "a callback after channel registration remains valid before host creation returns");
}

/// The document state of a host page as the native host sends it: loading and the count of navigations that the page started.
fn navigation_state(loading: bool, navigations: u64) -> String {
    format!(r#"{{"loading": {loading}, "navigations": {navigations}}}"#)
}

// contract: plugin-host.channel.ready-theme
// contract: plugin-host.channel.progress-keeps-ready
#[test]
fn a_ready_message_records_the_ready_document_once_per_process_and_a_new_navigation_clears_it() {
    let channels = host_channels(false);
    assert_eq!(channels.ready_document("probe"), None);
    // The navigation starts before the page script runs, so its state arrives before the ready message.
    channels
        .state("probe", &navigation_state(true, 1))
        .expect("the state is accepted");
    let ready = host_message(r#"{"event": "view.ready", "plugin": "probe", "document": "doc-1"}"#);
    assert_eq!(
        channels.receive("probe", &ready),
        Ok(Received::Ready { first: true })
    );
    assert_eq!(channels.ready_document("probe").as_deref(), Some("doc-1"));
    channels
        .state("probe", &navigation_state(true, 1))
        .expect("the progress state is accepted");
    assert_eq!(
        channels.ready_document("probe").as_deref(),
        Some("doc-1"),
        "the progress of the same navigation cleared the ready document"
    );
    channels
        .state("probe", &navigation_state(true, 2))
        .expect("the new navigation state is accepted");
    assert_eq!(
        channels.ready_document("probe"),
        None,
        "a new navigation kept the ready document"
    );
    assert_eq!(
        channels.receive("probe", &ready),
        Ok(Received::Ready { first: false })
    );
    for message in [
        r#"{"event": "view.ready", "plugin": "other", "document": "d"}"#,
        r#"{"event": "view.ready", "plugin": "probe"}"#,
    ] {
        assert!(
            channels.receive("probe", &host_message(message)).is_err(),
            "the ready message {message} is accepted"
        );
    }
    let unknown = channels.receive(
        "probe",
        &host_message(r#"{"event": "runtime.native.event"}"#),
    );
    assert!(
        unknown
            .as_ref()
            .is_err_and(|error| error.contains(r#""runtime.native.event" is unknown"#)),
        "unknown event: {unknown:?}"
    );
}

// contract: plugin-host.channel.state-navigations-required
#[test]
fn a_host_state_without_navigations_or_with_a_lower_count_is_refused() {
    let channels = host_channels(false);
    assert_eq!(
        channels.state("probe", r#"{"loading": true}"#),
        Err("plugin probe: state has no navigations".to_string())
    );
    channels
        .state("probe", &navigation_state(true, 2))
        .expect("the state with two navigations is accepted");
    assert_eq!(
        channels.state("probe", &navigation_state(true, 1)),
        Err("plugin probe: state counts 1 navigations, below the 2 counted before".to_string())
    );
}

// contract: plugin-host.channel.queue-full-closes
#[test]
fn a_queue_overflow_of_the_page_closes_the_host() {
    let channels = host_channels(true);
    let hosts = PluginHosts::default();
    hosts.insert("probe", 11);
    let overflow = channels
        .receive(
            "probe",
            &host_message(r#"{"event": "view.error", "reason": "queue full for probe"}"#),
        )
        .expect_err("the overflow is a failure");
    assert!(
        plugin_host_queue_full("probe", &overflow),
        "the overflow {overflow:?} does not close the host"
    );
    assert_eq!(end_host(&hosts, &channels, "probe", Some(11)), Some(11));
    assert_eq!(
        hosts.get("probe"),
        None,
        "the host webview is recorded after the overflow"
    );
    assert!(
        channels.plugins().is_empty(),
        "the channel is recorded after the overflow"
    );
    // Another view.error reason is a failure that closes nothing.
    let channels = host_channels(true);
    let other = channels
        .receive(
            "probe",
            &host_message(r#"{"event": "view.error", "reason": "message without the sok marker"}"#),
        )
        .expect_err("the view.error is a failure");
    assert!(!plugin_host_queue_full("probe", &other));
}

// contract: plugin-host.channel.view-error-names-plugin
#[test]
fn a_view_error_names_its_plugin_once() {
    for (reason, expected) in [
        (
            "uncaught error: Script error.",
            "plugin probe: uncaught error: Script error.",
        ),
        (
            "plugin probe: existing detail",
            "plugin probe: existing detail",
        ),
        (
            "plugin other: existing detail",
            "plugin probe: plugin other: existing detail",
        ),
        ("queue full for probe", "plugin probe: queue full for probe"),
    ] {
        let channels = host_channels(true);
        let error = channels
            .receive(
                "probe",
                &host_message(&format!(
                    r#"{{"event": "view.error", "reason": {}}}"#,
                    serde_json::to_string(reason).expect("the reason is JSON")
                )),
            )
            .expect_err("the view.error is a failure");
        assert_eq!(error, expected);
    }
}

// contract: plugin-host.channel.ended
#[test]
fn the_end_of_the_current_host_tells_the_main_page_and_a_replaced_host_changes_nothing() {
    let channels = host_channels(true);
    let hosts = PluginHosts::default();
    hosts.insert("probe", 11);
    assert_eq!(end_host(&hosts, &channels, "probe", Some(12)), None);
    assert_eq!(
        hosts.get("probe"),
        Some(11),
        "the end of a replaced webview removed the host"
    );
    assert_eq!(end_host(&hosts, &channels, "probe", Some(11)), Some(11));
    assert_eq!(
        ended_event("probe", 1),
        json!({"plugin": "probe", "generation": 1})
    );
    // The disposal on a removal of the plugin ends the host without a handle; a second end finds nothing.
    hosts.insert("probe", 13);
    channels.register("probe", None, 2);
    assert_eq!(end_host(&hosts, &channels, "probe", None), Some(13));
    assert_eq!(end_host(&hosts, &channels, "probe", None), None);
    // The disposal of every host on a reload removes every channel.
    channels.register("probe", None, 3);
    channels.unregister_all();
    assert!(channels.plugins().is_empty());
}

// contract: plugin-host.channel.main-page-posts
#[test]
fn the_posts_of_the_main_page_are_host_messages_and_need_a_ready_document() {
    let reply = |result: Option<Value>, error: Option<ViewReplyError>| PluginHostReply {
        plugin: "probe".into(),
        generation: 1,
        id: 7,
        result,
        error,
    };
    assert_eq!(
        reply_message(&reply(Some(json!(1)), None)),
        Ok(json!({"sok": 1, "id": 7, "result": 1}))
    );
    assert_eq!(
        reply_message(&reply(
            None,
            Some(ViewReplyError {
                code: -32000,
                message: "refused".into()
            })
        )),
        Ok(json!({"sok": 1, "id": 7, "error": {"code": -32000, "message": "refused"}}))
    );
    assert!(reply_message(&reply(None, None)).is_err());
    let request = |command: &str| PluginHostRequest {
        plugin: "probe".into(),
        generation: 1,
        id: 9,
        command: command.into(),
        params: Some(json!({"status": "x"})),
    };
    assert_eq!(
        request_message(&request("declared-ui.snapshot.request")),
        Ok(
            json!({"sok": 1, "id": 9, "command": "declared-ui.snapshot.request", "params": {"status": "x"}})
        )
    );
    assert!(request_message(&request("")).is_err());
    let event = |name: &str| PluginHostEvent {
        plugin: "probe".into(),
        generation: 1,
        event: name.into(),
        data: Some(json!({"plugin": "probe", "status": "x", "seq": 1})),
    };
    assert_eq!(
        event_message(&event("declared-ui.snapshot.ack")),
        Ok(
            json!({"sok": 1, "event": "declared-ui.snapshot.ack", "data": {"plugin": "probe", "status": "x", "seq": 1}})
        )
    );
    assert!(event_message(&event("")).is_err());
    // A host without a ready document refuses the posts of the main page with its plugin.
    assert_eq!(
        host_channels(false).check_post("probe"),
        Err("plugin probe has no ready document".to_string())
    );
    assert_eq!(host_channels(true).check_post("probe"), Ok(()));
}

// contract: plugin-host.source-generation
#[test]
fn plugin_host_commands_reject_generations_above_the_javascript_safe_integer_limit() {
    let generation = 9_007_199_254_740_992;
    let reply = PluginHostReply {
        plugin: "probe".into(),
        generation,
        id: 7,
        result: Some(json!(null)),
        error: None,
    };
    let request = PluginHostRequest {
        plugin: "probe".into(),
        generation,
        id: 7,
        command: "declared-ui.snapshot.request".into(),
        params: Some(json!({"status":"items"})),
    };
    let event = PluginHostEvent {
        plugin: "probe".into(),
        generation,
        event: "declared-ui.snapshot.ack".into(),
        data: Some(json!({"status":"items","seq":1})),
    };

    assert_eq!(
        reply_message(&reply),
        Err("plugin host reply source generation exceeds the JavaScript safe integer limit".into())
    );
    assert_eq!(
        request_message(&request),
        Err(
            "plugin host request source generation exceeds the JavaScript safe integer limit"
                .into()
        )
    );
    assert_eq!(
        event_message(&event),
        Err("plugin host event source generation exceeds the JavaScript safe integer limit".into())
    );

    let at_limit = PluginHostReply {
        generation: 9_007_199_254_740_991,
        ..reply
    };
    assert!(reply_message(&at_limit).is_ok());
}

// contract: plugin-host.source-generation
#[test]
fn a_late_plugin_host_reply_cannot_remove_a_replacement_calls_record() {
    let channels = host_channels(true);
    channels
        .receive(
            "probe",
            &host_message(r#"{"id": 7, "command": "runtime.native.call"}"#),
        )
        .expect("the old host call is accepted");
    channels.register("probe", None, 2);
    channels
        .receive(
            "probe",
            &host_message(r#"{"event":"view.ready","plugin":"probe","document":"doc-2"}"#),
        )
        .expect("the replacement host becomes ready");
    channels
        .receive(
            "probe",
            &host_message(r#"{"id": 7, "command": "runtime.native.call"}"#),
        )
        .expect("the replacement host call is accepted");
    assert_eq!(channels.generation("probe"), Some(2));
    assert_eq!(channels.open_calls("probe"), ["runtime.native.call"]);

    channels.answer_call("probe", 1, 7);

    assert_eq!(
        channels.open_calls("probe"),
        ["runtime.native.call"],
        "a reply from the old host removed the replacement call"
    );
}

// contract: plugin-host.declared-ui.expanded
#[test]
fn the_main_page_posts_declared_ui_expansion_to_the_host() {
    let data = json!({
        "status": "tree-status",
        "tree": "example-tree",
        "path": ["root", "child"],
        "expanded": true,
    });
    let event = PluginHostEvent {
        plugin: "probe".into(),
        generation: 1,
        event: "declared-ui.expanded".into(),
        data: Some(data.clone()),
    };
    assert_eq!(
        event_message(&event),
        Ok(json!({
            "sok": 1,
            "event": "declared-ui.expanded",
            "data": data,
        }))
    );
}

/// Returns the channels of a window whose host of plugin probe declares declared and has the ready document doc-1.
fn state_channels(declared: Option<HostState>) -> PluginHostChannels {
    let channels = PluginHostChannels::default();
    channels.register("probe", declared, 1);
    channels
        .receive(
            "probe",
            &host_message(r#"{"event": "view.ready", "plugin": "probe", "document": "doc-1"}"#),
        )
        .expect("the ready message is accepted");
    channels
}

/// Sends the state call command with params as the call request id of the host page of probe and returns the host
/// message of the reply that the host posts for it.
fn state_call(
    channels: &PluginHostChannels,
    states: &PluginHostStates,
    id: u64,
    command: &str,
    params: &str,
) -> Value {
    let message = format!(r#"{{"id": {id}, "command": "{command}", "params": {params}}}"#);
    match channels.receive("probe", &host_message(&message)) {
        Ok(Received::State {
            id,
            command,
            params,
            declared,
        }) => states.answer("probe", declared, id, &command, &params),
        other => panic!("the state call {message} is {other:?}, want a state call of the host"),
    }
}

/// Returns the host message of a refused state call id with message.
fn refusal(id: u64, message: &str) -> Value {
    json!({"sok": 1, "id": id, "error": {"code": -32000, "message": message}})
}

// contract: plugin-host.state.calls
#[test]
fn state_write_and_state_read_keep_one_value_per_plugin() {
    let declared = Some(HostState {
        format: 1,
        max_bytes: 64,
    });
    let channels = state_channels(declared);
    let states = PluginHostStates::default();
    assert_eq!(
        state_call(&channels, &states, 1, "state.read", "null"),
        json!({"sok": 1, "id": 1, "result": {"value": null}})
    );
    assert_eq!(
        state_call(
            &channels,
            &states,
            2,
            "state.write",
            r#"{"value": {"n": 1}}"#
        ),
        json!({"sok": 1, "id": 2, "result": null})
    );
    assert_eq!(
        state_call(&channels, &states, 3, "state.read", "null"),
        json!({"sok": 1, "id": 3, "result": {"value": {"n": 1}}})
    );
    // The host page of another window reads and replaces the same value of the plugin, and no state call is open.
    let second = state_channels(declared);
    assert_eq!(
        state_call(&second, &states, 4, "state.read", "null"),
        json!({"sok": 1, "id": 4, "result": {"value": {"n": 1}}})
    );
    state_call(&second, &states, 5, "state.write", r#"{"value": [2]}"#);
    assert_eq!(
        state_call(&channels, &states, 6, "state.read", "null"),
        json!({"sok": 1, "id": 6, "result": {"value": [2]}})
    );
    assert!(
        channels.open_calls("probe").is_empty(),
        "a state call is open"
    );
}

// contract: plugin-host.state.refusals
#[test]
fn state_calls_are_refused_without_a_declaration_over_the_limit_and_for_another_format() {
    let states = PluginHostStates::default();
    let undeclared = state_channels(None);
    for (id, command) in [(1, "state.read"), (2, "state.write")] {
        assert_eq!(
            state_call(&undeclared, &states, id, command, r#"{"value": 1}"#),
            refusal(id, "plugin probe declares no host state")
        );
    }
    let channels = state_channels(Some(HostState {
        format: 1,
        max_bytes: 8,
    }));
    assert_eq!(
        state_call(
            &channels,
            &states,
            3,
            "state.write",
            r#"{"value": "123456789"}"#
        ),
        refusal(3, "plugin probe state of 11 bytes exceeds 8")
    );
    for (id, params) in [(4, "null"), (5, r#"{"other": 1}"#), (6, "[1]")] {
        assert_eq!(
            state_call(&channels, &states, id, "state.write", params),
            refusal(id, "plugin probe state.write has no value")
        );
    }
    assert_eq!(
        state_call(&channels, &states, 7, "state.read", "null"),
        json!({"sok": 1, "id": 7, "result": {"value": null}}),
        "a refused write saved a value"
    );
    // A value saved with format 1 is refused to a host that declares format 2 after an update of the plugin.
    state_call(&channels, &states, 8, "state.write", r#"{"value": 5}"#);
    let updated = state_channels(Some(HostState {
        format: 2,
        max_bytes: 8,
    }));
    assert_eq!(
        state_call(&updated, &states, 9, "state.read", "null"),
        refusal(9, "plugin probe state format 1 is not 2")
    );
}

// contract: plugin-host.state.removal
#[test]
fn the_state_ends_with_the_removal_or_disable_of_the_plugin() {
    let channels = state_channels(Some(HostState {
        format: 1,
        max_bytes: 64,
    }));
    let states = PluginHostStates::default();
    state_call(&channels, &states, 1, "state.write", r#"{"value": 1}"#);
    states.plugin_changed("update", "probe");
    states.plugin_changed("remove", "other");
    assert_eq!(
        state_call(&channels, &states, 2, "state.read", "null"),
        json!({"sok": 1, "id": 2, "result": {"value": 1}}),
        "an update or the removal of another plugin dropped the value"
    );
    for (id, action) in [(10, "remove"), (11, "disable")] {
        state_call(&channels, &states, id, "state.write", r#"{"value": 1}"#);
        states.plugin_changed(action, "probe");
        assert_eq!(
            state_call(&channels, &states, id + 10, "state.read", "null"),
            json!({"sok": 1, "id": id + 10, "result": {"value": null}}),
            "the {action} of the plugin kept the value"
        );
    }
}

/// Returns the camel case name of a command of the table, which is the name the page and the plugins use.
fn camel_case(snake: &str) -> String {
    let mut name = String::new();
    let mut upper = false;
    for character in snake.chars() {
        if character == '_' {
            upper = true;
        } else if upper {
            name.extend(character.to_uppercase());
            upper = false;
        } else {
            name.push(character);
        }
    }
    name
}

// contract: plugin-host.call.refuses-unlisted-commands
#[test]
fn a_plugin_host_call_for_a_command_outside_the_allowlist_is_refused() {
    // The plugin allowlist is the exposure reply and the region calls of a view. The names are fixtures of this check.
    // Every other command of the Tauri command table is refused by the channel of a plugin host page.
    let allowed = [
        "exposureReply",
        "compositionDeclare",
        "compositionPlace",
        "documentAttach",
        "documentLoad",
        "documentZoom",
        "documentGo",
        "documentDetach",
        "documentSubscribe",
        "documentUnsubscribe",
        "documentPost",
        "documentQuery",
        "documentInteractionState",
        "imageAttach",
        "imageFocus",
        "imageCaret",
        "imageText",
        "imageDetach",
    ];
    let channels = host_channels(true);
    let mut checked = 0;
    for snake in crate::bindings::command_names() {
        let command = camel_case(snake);
        if allowed.contains(&command.as_str()) {
            continue;
        }
        checked += 1;
        let received = channels
            .receive(
                "probe",
                &host_message(&format!(r#"{{"id": 9, "command": "{command}"}}"#)),
            )
            .expect("the call request of the host page is accepted");
        assert_eq!(
            received,
            Received::Post(json!({
                "sok": 1,
                "id": 9,
                "error": {"code": -32000, "message": format!("plugin host call {command} is not served")},
            })),
            "the command {command} outside the allowlist is not refused"
        );
    }
    assert!(
        checked > 0,
        "the command table has no command outside the allowlist"
    );
}

// A view.error without a reason is refused with an error that names the plugin. An empty reason would give an error with no text.
// contract: plugin-host.channel.view-error-without-reason-is-refused
#[test]
fn a_view_error_without_a_reason_is_refused() {
    let channels = host_channels(true);
    let error = channels
        .receive("probe", &host_message(r#"{"event": "view.error"}"#))
        .expect_err("a view.error is a failure");
    assert_eq!(error, "plugin probe: view.error has no reason");
}

// contract: plugin-host.channel.ui-thread
#[test]
fn a_native_document_post_is_a_main_thread_task() {
    let dispatched = std::cell::Cell::new(0);
    let result = crate::documents::post_document_via(
        |task| {
            dispatched.set(dispatched.get() + 1);
            drop(task);
            Ok(true)
        },
        0,
        "{}".to_string(),
    );
    assert_eq!(result, Ok(true));
    assert_eq!(
        dispatched.get(),
        1,
        "the native post runs on the main thread through the dispatch"
    );
}

// contract: view.channel.ui-thread
#[test]
fn a_native_view_post_is_a_main_thread_task() {
    let dispatched = std::cell::Cell::new(0);
    let result = crate::documents::post_document_via(
        |task| {
            dispatched.set(dispatched.get() + 1);
            drop(task);
            Ok(true)
        },
        0,
        "{\"event\":\"theme\"}".to_string(),
    );
    assert_eq!(result, Ok(true));
    assert_eq!(
        dispatched.get(),
        1,
        "the native view post runs on the main thread through the dispatch"
    );
}

// contract: plugin-host.project.post
// A change of the project that the window shows is posted to each plugin host with a ready document as the event project with {id, root}
// or null; a host without a ready document is skipped (docs/spec/plugin-host.md#configuration).
#[test]
fn a_project_change_posts_the_project_event_to_each_host_with_a_ready_document() {
    let plugins = vec!["probe".to_string(), "other".to_string()];
    let ready = |plugin: &str| plugin == "probe";
    let mut posted = vec![];
    let project: crate::surfaces::SurfaceProject =
        serde_json::from_value(json!({"id": "prj-two", "root": "/work/two"}))
            .expect("the project has its form");
    let failed = crate::plugin_host_channel::post_project_via(
        &plugins,
        ready,
        Some(&project),
        |plugin, message| {
            posted.push((plugin.to_string(), message.clone()));
            Ok(())
        },
    );
    assert!(failed.is_empty());
    assert_eq!(
        posted,
        vec![(
            "probe".to_string(),
            serde_json::json!({"sok": 1, "event": "project", "data": {"id": "prj-two", "root": "/work/two"}})
        )]
    );
    posted.clear();
    crate::plugin_host_channel::post_project_via(&plugins, ready, None, |plugin, message| {
        posted.push((plugin.to_string(), message.clone()));
        Ok(())
    });
    assert_eq!(
        posted,
        vec![(
            "probe".to_string(),
            serde_json::json!({"sok": 1, "event": "project", "data": null})
        )]
    );
}

// contract: plugin-host.channel.end-of-closed-window-is-not-an-error
#[test]
fn the_end_of_a_host_whose_window_is_closed_is_not_reported() {
    let closed: Result<std::sync::Arc<crate::windows::WindowData>, String> =
        Err("project window is closed".to_string());
    assert_eq!(
        host_end_report(&closed, "probe", 7),
        None,
        "the end of a host of a closed window is not a failure"
    );
    let records = std::sync::Arc::new(crate::windows::WindowData::default());
    records.plugin_hosts.insert("probe", 7);
    let open = Ok(records);
    assert_eq!(
        host_end_report(&open, "probe", 7),
        Some("plugin probe: the host process ended".to_string()),
        "the end of the current host is reported"
    );
    assert_eq!(
        host_end_report(&open, "probe", 8),
        None,
        "the end of a host that is not the current one is not reported"
    );
}

// contract: plugin-host.channel.late-state-of-closed-window-is-not-an-error
#[test]
fn a_navigation_state_that_arrives_after_its_window_closed_is_not_reported() {
    let closed: Result<std::sync::Arc<crate::windows::WindowData>, String> =
        Err("project window is closed".to_string());
    assert_eq!(
        late_state_error(&closed, "probe", r#"{"loading": false, "navigations": 1}"#),
        None,
        "the late state of a closed window is not a failure"
    );
    let open = Ok(std::sync::Arc::new(crate::windows::WindowData::default()));
    assert!(
        late_state_error(&open, "probe", r#"{"loading": false}"#).is_some(),
        "a state without navigations of an open window is still refused"
    );
}

// contract: plugin-host.channel.late-error-preserved
#[test]
fn a_late_provider_error_is_preserved_after_window_records_are_removed() {
    let data = Err("project window is closed".to_string());
    assert_eq!(
        late_message_error(
            &data,
            "probe",
            r#"{"error":"provider failed after its window closed"}"#
        ),
        Some("plugin probe: provider failed after its window closed".to_string()),
        "an explicit provider error must remain observable after window teardown"
    );
    assert_eq!(
        late_message_error(
            &data,
            "probe",
            &host_message(r#"{"event":"declared-ui.snapshot","plugin":"probe"}"#)
        ),
        None,
        "an ordinary late provider message must remain a canceled callback"
    );
}
