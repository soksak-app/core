//! The channel of a plugin host page (docs/spec/plugin-host.md#channel).

use serde_json::{Value, json};

use crate::documents::ViewReplyError;
use crate::plugin_host::{HostState, PluginHostStates, PluginHosts};
use crate::plugin_host_channel::{
    PluginHostChannels, PluginHostEvent, PluginHostReply, PluginHostRequest, Received, end_host,
    ended_event, event_message, reply_message, request_message,
};
use crate::view_lifecycle::is_queue_full;

/// Returns the channels of a window with the host of plugin probe and, when ready is set, the ready document doc-1.
fn host_channels(ready: bool) -> PluginHostChannels {
    let channels = PluginHostChannels::default();
    channels.register("probe", None);
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
            json!({"plugin": "probe", "id": 7, "result": {"sum": 3}})
        ))
    );
    for message in [
        r#"{"reply": 7}"#,
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
                json!({"plugin": "probe", "id": id, "command": command, "params": params})
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
        (14, "runtime.data.set", json!({"key": "note", "value": "new"})),
    ] {
        let message = format!(r#"{{"id": {id}, "command": "{command}", "params": {params}}}"#);
        assert_eq!(
            channels.receive("probe", &host_message(&message)),
            Ok(Received::Emit(
                "plugin-host-call",
                json!({"plugin": "probe", "id": id, "command": command, "params": params})
            ))
        );
    }
}

// contract: plugin-host.channel.call-served-set
#[test]
fn the_host_forwards_only_the_registration_calls_and_refuses_every_other_call() {
    let channels = host_channels(true);
    for command in [
        "runtime.native.call",
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
    ] {
        let message =
            format!(r#"{{"id": {id}, "command": "{command}", "params": {{"name": "probe.x"}}}}"#);
        assert_eq!(
            channels.receive("probe", &host_message(&message)),
            Ok(Received::Emit(
                "plugin-host-call",
                json!({"plugin": "probe", "id": id, "command": command, "params": {"name": "probe.x"}})
            ))
        );
    }
    assert_eq!(
        channels.open_calls("probe"),
        ["page.exposure.register", "runtime.command.register"]
    );
    // A cancel goes to the main page; the call stays open until the main page answers it, as for a view.
    assert_eq!(
        channels.receive("probe", &host_message(r#"{"id": 5, "cancel": true}"#)),
        Ok(Received::Emit(
            "plugin-host-call",
            json!({"plugin": "probe", "id": 5, "cancel": true})
        ))
    );
    channels.answer_call("probe", 5);
    assert_eq!(channels.open_calls("probe"), ["runtime.command.register"]);
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
            "declared-ui.snapshot",
            json!({"plugin": "probe", "status": "list", "seq": 2, "skipped": 1, "value": {"x": 1}})
        ))
    );
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

// contract: plugin-host.channel.ready-theme
#[test]
fn a_ready_message_records_the_ready_document_once_per_process_and_a_navigation_clears_it() {
    let channels = host_channels(false);
    assert_eq!(channels.ready_document("probe"), None);
    let ready = host_message(r#"{"event": "view.ready", "plugin": "probe", "document": "doc-1"}"#);
    assert_eq!(
        channels.receive("probe", &ready),
        Ok(Received::Ready { first: true })
    );
    assert_eq!(channels.ready_document("probe").as_deref(), Some("doc-1"));
    channels
        .state("probe", r#"{"loading": true}"#)
        .expect("the state is accepted");
    assert_eq!(
        channels.ready_document("probe"),
        None,
        "a navigation kept the ready document"
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
        is_queue_full(&overflow),
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
    assert!(!is_queue_full(&other));
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
    assert_eq!(ended_event("probe"), json!({"plugin": "probe"}));
    // The disposal on a removal of the plugin ends the host without a handle; a second end finds nothing.
    hosts.insert("probe", 13);
    channels.register("probe", None);
    assert_eq!(end_host(&hosts, &channels, "probe", None), Some(13));
    assert_eq!(end_host(&hosts, &channels, "probe", None), None);
    // The disposal of every host on a reload removes every channel.
    channels.register("probe", None);
    channels.unregister_all();
    assert!(channels.plugins().is_empty());
}

// contract: plugin-host.channel.main-page-posts
#[test]
fn the_posts_of_the_main_page_are_host_messages_and_need_a_ready_document() {
    let reply = |result: Option<Value>, error: Option<ViewReplyError>| PluginHostReply {
        plugin: "probe".into(),
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
    channels.register("probe", declared);
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
