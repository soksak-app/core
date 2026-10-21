//! The channel of a plugin host page (docs/spec/plugin-host.md#channel). The page sends through the sok-view handler and
//! receives the host messages that the host posts to its ready document. A reply answers a request of the main page and
//! goes to it as the event plugin-host-reply; a registration call or a cancel of the page goes to the main page as the
//! event plugin-host-call, and the main page answers it with the plugin_host_reply command; a declared UI snapshot goes to
//! the main page as the event declared-ui.snapshot. The host answers a call of any other command itself with
//! plugin host call <name> is not served. The events carry the plugin and no surface, because the host page holds no
//! surface.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Webview, Window};

use crate::application_log::{log_error, log_failure};
use crate::documents::{ViewReplyError, theme_message};
use crate::event_log::Level;
use crate::event_record::emit_host;
use crate::platform::{self, Handle};
use crate::plugin_host::{
    Failure, HostState, PluginHostRestarts, PluginHostStates, PluginHosts, state_call,
};
use crate::sidecars::{RESTART_LIMIT, RESTART_WINDOW};
use crate::view_lifecycle::is_queue_full;
use crate::windows::{emit_window, window_data};

/// The event name of a declared UI snapshot (docs/spec/plugin-host.md#declared-ui-snapshots).
const DECLARED_SNAPSHOT_EVENT: &str = "declared-ui.snapshot";
/// The code with which the host refuses a call that the channel does not serve: EXPOSURE_ERRORS.failed of plugin-api.
const REFUSAL_CODE: i64 = -32000;

/// The channel of one plugin host: its declared state, its ready document, whether its first ready message arrived, and
/// its calls that the main page has not answered. An empty document means that no ready document is recorded, and no
/// state means that the host declaration names none.
#[derive(Default)]
struct Channel {
    state: Option<HostState>,
    document: String,
    process_ready: bool,
    calls: BTreeMap<u64, String>,
}

/// The channels of the plugin hosts of one window, by plugin id.
#[derive(Default)]
pub struct PluginHostChannels(Mutex<HashMap<String, Channel>>);

/// What the host does with one message of a host page.
#[derive(Debug, PartialEq)]
pub enum Received {
    /// Sends the window event of the name with the payload to the main page.
    Emit(&'static str, Value),
    /// Posts the message to the ready document of the host page, such as the refusal of a call that is not served.
    Post(Value),
    /// The message made the page ready: the theme follows; first is true for the first ready message since the creation.
    Ready { first: bool },
    /// A state call that the host answers itself from the saved value of the plugin with its declared state
    /// (docs/spec/plugin-host.md#state).
    State {
        id: u64,
        command: String,
        params: Value,
        declared: Option<HostState>,
    },
}

#[derive(Deserialize)]
struct HostReceived {
    message: Option<Value>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct NavigationState {
    #[serde(default)]
    loading: bool,
}

/// Returns true when the channel forwards the call command to the main page: the registration calls of exposure
/// (docs/spec/plugin-host.md#channel).
pub fn forwarded_call(command: &str) -> bool {
    matches!(
        command,
        "runtime.command.register"
            | "page.exposure.register"
            | "runtime.sidecar.send"
            | "runtime.sidecar.on"
            | "runtime.sidecar.onFailure"
    )
}

impl PluginHostChannels {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Channel>> {
        // default: a lock that a panicking thread poisoned still holds the channels of the plugin hosts; the panic hook records the panic.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records the channel of plugin with its declared state. It runs when the host webview is created.
    pub fn register(&self, plugin: &str, state: Option<HostState>) {
        self.lock().insert(
            plugin.to_string(),
            Channel {
                state,
                ..Channel::default()
            },
        );
    }

    /// Removes the channel of plugin. It runs when the host webview is disposed.
    pub fn unregister(&self, plugin: &str) {
        self.lock().remove(plugin);
    }

    /// Removes every channel. It runs when every host webview of the window is disposed.
    pub fn unregister_all(&self) {
        self.lock().clear();
    }

    /// Returns the plugins that the window has a channel of, in id order.
    pub fn plugins(&self) -> Vec<String> {
        let mut plugins: Vec<String> = self.lock().keys().cloned().collect();
        plugins.sort();
        plugins
    }

    /// Returns the ready document of the host of plugin, or None when the page has sent no ready message.
    pub fn ready_document(&self, plugin: &str) -> Option<String> {
        self.lock()
            .get(plugin)
            .map(|channel| channel.document.clone())
            .filter(|document| !document.is_empty())
    }

    /// Returns the error for a post to the host of plugin that has no ready document.
    pub fn check_post(&self, plugin: &str) -> Result<(), String> {
        match self.ready_document(plugin) {
            Some(_) => Ok(()),
            None => Err(format!("plugin {plugin} has no ready document")),
        }
    }

    /// Records the navigation state of the host of plugin. A loading document clears its ready document, so the next ready
    /// message of the new document is the first record of it.
    pub fn state(&self, plugin: &str, state: &str) -> Result<(), String> {
        let loaded: NavigationState = serde_json::from_str(state)
            .map_err(|error| format!("plugin {plugin}: state is not JSON: {error}"))?;
        if loaded.loading
            && let Some(channel) = self.lock().get_mut(plugin)
        {
            channel.document.clear();
        }
        Ok(())
    }

    /// Records that the main page answered the call id of the host of plugin, so the call is no longer open.
    pub fn answer_call(&self, plugin: &str, id: u64) {
        if let Some(channel) = self.lock().get_mut(plugin) {
            channel.calls.remove(&id);
        }
    }

    /// Returns the commands of the calls of the host of plugin that the main page has not answered, in the order of their
    /// ids.
    pub fn open_calls(&self, plugin: &str) -> Vec<String> {
        self.lock()
            .get(plugin)
            .map(|channel| channel.calls.values().cloned().collect())
            // default: a window without the host of plugin has no open calls.
            .unwrap_or_default()
    }

    /// Dispatches one message of the sok-view handler of the host of plugin, which is {"message": value} or
    /// {"error": reason}. It returns what the host does with it, or the reason that the host writes to the application
    /// log; a reason that is_queue_full accepts closes the host.
    pub fn receive(&self, plugin: &str, value: &str) -> Result<Received, String> {
        let received: HostReceived = serde_json::from_str(value)
            .map_err(|error| format!("plugin {plugin}: message is not JSON: {error}"))?;
        if let Some(error) = received.error {
            return Err(error);
        }
        let message = received
            .message
            .ok_or_else(|| format!("plugin {plugin}: message has neither message nor error"))?;
        if !self.lock().contains_key(plugin) {
            return Err(format!(
                "plugin {plugin}: channel message of a window without the host"
            ));
        }
        let fields = message
            .as_object()
            .ok_or_else(|| format!("plugin {plugin}: message is not an object"))?;
        let field = |name: &str| fields.get(name).filter(|value| !value.is_null());
        if fields.contains_key("reply") {
            return reply(plugin, fields)
                .map(|payload| Received::Emit("plugin-host-reply", payload));
        }
        if field("command").is_some() || field("cancel").is_some() {
            return self.call(plugin, fields);
        }
        let event = fields
            .get("event")
            .and_then(Value::as_str)
            // default: a message without an event name is refused below as the unknown event "".
            .unwrap_or_default();
        match event {
            DECLARED_SNAPSHOT_EVENT => snapshot(plugin, fields)
                .map(|payload| Received::Emit(DECLARED_SNAPSHOT_EVENT, payload)),
            "view.ready" => {
                let named = fields
                    .get("plugin")
                    .and_then(Value::as_str)
                    // default: a missing plugin is an empty text, which the check below refuses.
                    .unwrap_or_default();
                let document = fields
                    .get("document")
                    .and_then(Value::as_str)
                    // default: a missing document is an empty text, which the check below refuses.
                    .unwrap_or_default();
                if named != plugin || document.is_empty() {
                    return Err(format!(
                        "plugin {plugin}: view.ready names plugin {named:?} and document {document:?}"
                    ));
                }
                let mut channels = self.lock();
                let channel = channels.get_mut(plugin).ok_or_else(|| {
                    format!("plugin {plugin}: channel message of a window without the host")
                })?;
                channel.document = document.to_string();
                let first = !channel.process_ready;
                channel.process_ready = true;
                Ok(Received::Ready { first })
            }
            "view.error" => Err(fields
                .get("reason")
                .and_then(Value::as_str)
                // default: a view.error without a reason is logged as the empty reason, which closes nothing.
                .unwrap_or_default()
                .to_string()),
            other => Err(format!("plugin {plugin}: event {other:?} is unknown")),
        }
    }

    /// Returns what the host does with a call request or a cancel of the host of plugin. A registration call is forwarded
    /// to the main page and stays open until the main page answers it; a call of another command is refused to the page.
    fn call(
        &self,
        plugin: &str,
        fields: &serde_json::Map<String, Value>,
    ) -> Result<Received, String> {
        let field = |name: &str| fields.get(name).filter(|value| !value.is_null());
        let id = fields
            .get("id")
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("plugin host {plugin}: call has no integer id"))?;
        if let Some(cancel) = field("cancel") {
            if *cancel != Value::Bool(true) || field("command").is_some() {
                return Err(format!(
                    "plugin host {plugin}: call {id} cancel must be true and name no command"
                ));
            }
            return Ok(Received::Emit(
                "plugin-host-call",
                json!({"plugin": plugin, "id": id, "cancel": true}),
            ));
        }
        let command = field("command")
            .and_then(Value::as_str)
            .filter(|command| !command.is_empty())
            .ok_or_else(|| format!("plugin host {plugin}: call {id} has an empty command"))?;
        if state_call(command) {
            // The host answers a state call itself and forwards it to no page (docs/spec/plugin-host.md#state).
            let declared = self.lock().get(plugin).and_then(|channel| channel.state);
            return Ok(Received::State {
                id,
                command: command.to_string(),
                // default: a call without params sends null to its command, as the call envelope has no params for it.
                params: fields.get("params").cloned().unwrap_or(Value::Null),
                declared,
            });
        }
        if !forwarded_call(command) {
            // A call that the channel does not serve is refused to the page and forwarded to no page
            // (docs/spec/plugin-host.md#channel).
            return Ok(Received::Post(json!({
                "sok": 1,
                "id": id,
                "error": {"code": REFUSAL_CODE, "message": format!("plugin host call {command} is not served")},
            })));
        }
        if let Some(channel) = self.lock().get_mut(plugin) {
            channel.calls.insert(id, command.to_string());
        }
        // default: a call without params sends null to its command, as the call envelope has no params for it.
        let params = fields.get("params").cloned().unwrap_or(Value::Null);
        Ok(Received::Emit(
            "plugin-host-call",
            json!({"plugin": plugin, "id": id, "command": command, "params": params}),
        ))
    }
}

/// Returns the plugin-host-reply payload of a reply of the host of plugin. A reply has an integer id and exactly one of
/// result and error; an error has an integer code and a message.
fn reply(plugin: &str, fields: &serde_json::Map<String, Value>) -> Result<Value, String> {
    let id = fields
        .get("reply")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("plugin host {plugin}: reply has no integer id"))?;
    let result = fields.get("result").filter(|value| !value.is_null());
    match (result, fields.get("error")) {
        (Some(result), None) => Ok(json!({"plugin": plugin, "id": id, "result": result})),
        (None, Some(error)) => {
            let code = error.get("code").and_then(Value::as_i64).ok_or_else(|| {
                format!("plugin host {plugin}: reply {id} has an error without an integer code")
            })?;
            let text = error
                .get("message")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .ok_or_else(|| {
                    format!("plugin host {plugin}: reply {id} has an error without a message")
                })?;
            Ok(json!({"plugin": plugin, "id": id, "error": {"code": code, "message": text}}))
        }
        _ => Err(format!(
            "plugin host {plugin}: reply {id} has both or neither of a result and an error"
        )),
    }
}

/// Returns the declared-ui.snapshot payload of a snapshot of the host of plugin. A snapshot names the plugin, a status,
/// an integer seq from 1, a skipped count of 0 or more and a value. The host relays the snapshot and writes no event for
/// it (docs/spec/plugin-host.md#declared-ui-snapshots).
fn snapshot(plugin: &str, fields: &serde_json::Map<String, Value>) -> Result<Value, String> {
    let named = fields
        .get("plugin")
        .and_then(Value::as_str)
        .filter(|named| !named.is_empty())
        .ok_or_else(|| format!("plugin host {plugin}: declared UI snapshot names no plugin"))?;
    if named != plugin {
        return Err(format!(
            "plugin host {plugin}: declared UI snapshot names plugin {named:?}, want plugin {plugin:?}"
        ));
    }
    let status = fields
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| !status.is_empty())
        .ok_or_else(|| format!("plugin host {plugin}: declared UI snapshot has no status"))?;
    let seq = fields
        .get("seq")
        .and_then(Value::as_u64)
        .filter(|seq| *seq >= 1)
        .ok_or_else(|| {
            format!(
                "plugin host {plugin}: declared UI snapshot of status {status:?} has no seq from 1"
            )
        })?;
    let skipped = fields.get("skipped").and_then(Value::as_u64).ok_or_else(|| {
        format!("plugin host {plugin}: declared UI snapshot of status {status:?} has no skipped count")
    })?;
    let value = fields.get("value").ok_or_else(|| {
        format!("plugin host {plugin}: declared UI snapshot of status {status:?} has no value")
    })?;
    Ok(json!({"plugin": plugin, "status": status, "seq": seq, "skipped": skipped, "value": value}))
}

fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// The reply of the main page to a call request of the host of plugin. It has a result or an error, not both.
#[derive(Deserialize)]
pub struct PluginHostReply {
    pub plugin: String,
    pub id: u64,
    #[serde(default, deserialize_with = "present")]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<ViewReplyError>,
}

/// A request of the main page to the host of plugin, such as the pull of a declared status
/// (docs/spec/plugin-host.md#declared-ui-snapshots).
#[derive(Deserialize)]
pub struct PluginHostRequest {
    pub plugin: String,
    pub id: u64,
    pub command: String,
    #[serde(default, deserialize_with = "present")]
    pub params: Option<Value>,
}

/// An event that the main page pushes to the host of plugin, such as the acknowledgement of a declared UI snapshot.
#[derive(Deserialize)]
pub struct PluginHostEvent {
    pub plugin: String,
    pub event: String,
    #[serde(default, deserialize_with = "present")]
    pub data: Option<Value>,
}

/// Returns the host message of a reply of the main page: {"sok", "id", "result"} or {"sok", "id", "error"}.
pub fn reply_message(reply: &PluginHostReply) -> Result<Value, String> {
    if reply.plugin.is_empty() {
        return Err("plugin host reply names no plugin".to_string());
    }
    match (&reply.result, &reply.error) {
        (Some(result), None) => Ok(json!({"sok": 1, "id": reply.id, "result": result})),
        (None, Some(error)) => Ok(json!({
            "sok": 1,
            "id": reply.id,
            "error": {"code": error.code, "message": error.message},
        })),
        _ => Err(format!(
            "plugin host reply {} has both or neither of a result and an error",
            reply.id
        )),
    }
}

/// Returns the host message of a request of the main page: {"sok", "id", "command", "params"}. A request has an id and a
/// command, and a request without params carries null.
pub fn request_message(request: &PluginHostRequest) -> Result<Value, String> {
    if request.plugin.is_empty() {
        return Err("plugin host request names no plugin".to_string());
    }
    if request.id == 0 {
        return Err("plugin host request has no id".to_string());
    }
    if request.command.is_empty() {
        return Err(format!(
            "plugin host request {} has an empty command",
            request.id
        ));
    }
    Ok(json!({
        "sok": 1,
        "id": request.id,
        "command": request.command,
        // default: a request without params carries null, as the call envelope has no params for it.
        "params": request.params.clone().unwrap_or(Value::Null),
    }))
}

/// Returns the host message of an event of the main page: {"sok", "event", "data"}. An empty name and an absent data are
/// errors.
pub fn event_message(event: &PluginHostEvent) -> Result<Value, String> {
    if event.plugin.is_empty() {
        return Err("plugin host event names no plugin".to_string());
    }
    if event.event.is_empty() {
        return Err("plugin host event has an empty event name".to_string());
    }
    let Some(data) = &event.data else {
        return Err(format!("plugin host event {} has no data", event.event));
    };
    Ok(json!({"sok": 1, "event": event.event, "data": data}))
}

/// Ends the host of plugin in the records of the window: it removes the host webview record and the channel and returns
/// the handle to close. With Some(handle) it ends the host only while handle is still the host webview of plugin, so the
/// end of a webview that was already replaced or disposed returns None.
pub fn end_host(
    hosts: &PluginHosts,
    channels: &PluginHostChannels,
    plugin: &str,
    handle: Option<Handle>,
) -> Option<Handle> {
    if let Some(handle) = handle
        && hosts.get(plugin) != Some(handle)
    {
        return None;
    }
    channels.unregister(plugin);
    hosts.take(plugin)
}

/// Returns the payload of the event plugin-host-ended, which tells the main page that the registrations of the host of
/// plugin ended (docs/spec/plugin-host.md#channel).
pub fn ended_event(plugin: &str) -> Value {
    json!({"plugin": plugin})
}

/// Closes the host webview of plugin and sends plugin-host-ended to the main page. With Some(handle) it ends the host
/// only while handle is its current webview. It runs on the main thread.
pub(crate) fn end(window: &Window, plugin: &str, handle: Option<Handle>) {
    let data = match window_data(window) {
        Ok(data) => data,
        Err(error) => return log_error("plugin host", error),
    };
    let Some(handle) = end_host(
        &data.plugin_hosts,
        &data.plugin_host_channels,
        plugin,
        handle,
    ) else {
        return;
    };
    match platform::current() {
        Ok(platform) => {
            if let Err(error) = platform.close_document(handle) {
                log_error("plugin host", error);
            }
        }
        Err(error) => log_error("plugin host", error),
    }
    if let Err(error) = emit_window(window, "plugin-host-ended", ended_event(plugin)) {
        log_error("plugin host", error);
    }
}

/// Handles the end of the page process of the host webview handle of plugin: the end is written to the application log
/// and handled as a failure of the host.
pub(crate) fn ended(window: &Window, plugin: &str, handle: Handle) {
    let data = match window_data(window) {
        Ok(data) => data,
        Err(error) => return log_error("plugin host", error),
    };
    if data.plugin_hosts.get(plugin) != Some(handle) {
        return;
    }
    log_error(
        "plugin host",
        format!("plugin {plugin}: the host process ended"),
    );
    failed(window, plugin, handle);
}

/// Handles a failure of the host webview handle of plugin in window: an end of its page process that the host did not
/// cause, or the queue overflow of its channel. It closes the host and counts the failure in the record of the plugin
/// over every window; below the limit it creates the host again in this window, and at the fourth failure within 300 s
/// it stops the restarts and closes the host of the plugin in every window (docs/spec/plugin-host.md#restarts). It runs
/// on the main thread.
fn failed(window: &Window, plugin: &str, handle: Handle) {
    end(window, plugin, Some(handle));
    match window.state::<PluginHostRestarts>().failed(plugin) {
        Failure::Restart(attempt) => {
            emit_host(
                Level::Error,
                "host.plugin-host.restart",
                json!({"plugin": plugin, "attempt": attempt}),
            );
            crate::windows::load_plugin_hosts(window);
        }
        Failure::Stop => {
            log_error(
                &format!("plugin host {plugin}"),
                format!(
                    "restart limit: {RESTART_LIMIT} failures within {} s",
                    RESTART_WINDOW.as_secs()
                ),
            );
            emit_host(
                Level::Error,
                "host.plugin-host.restart-limit",
                json!({"plugin": plugin}),
            );
            for other in window.app_handle().windows().into_values() {
                end(&other, plugin, None);
            }
        }
        // A failure that arrives after the stop restarts nothing; the stop closed the host in every window.
        Failure::Stopped => {}
    }
}

/// Handles the open of a surface of plugin by the person in window: when the limit stopped the restarts of its plugin
/// host, it clears the record, writes host.trace.plugin-host.restart-reset, and creates the host again in every window
/// (docs/spec/plugin-host.md#restarts).
pub(crate) fn surface_opened(window: &Window, plugin: &str) {
    if !window.state::<PluginHostRestarts>().reset(plugin) {
        return;
    }
    emit_host(
        Level::Debug,
        "host.trace.plugin-host.restart-reset",
        json!({"plugin": plugin}),
    );
    for other in window.app_handle().windows().into_values() {
        let target = other.clone();
        log_failure(
            "plugin host",
            crate::exposure::on_main(&other, move || {
                crate::windows::load_plugin_hosts(&target);
                Ok(())
            }),
        );
    }
}

/// Handles the enable of plugin by the person: when the limit stopped the restarts of its plugin host, it clears the record,
/// writes host.trace.plugin-host.restart-reset, and creates the host again in every window, as the open of a surface does
/// (docs/spec/plugin-host.md#restarts).
pub(crate) fn plugin_enabled(app: &AppHandle, plugin: &str) {
    let windows = app.windows();
    let labels: Vec<String> = windows.keys().cloned().collect();
    let cleared = clear_enabled_stop(
        &app.state::<PluginHostRestarts>(),
        plugin,
        &labels,
        |label| {
            let Some(other) = windows.get(label) else {
                return;
            };
            let target = other.clone();
            log_failure(
                "plugin host",
                crate::exposure::on_main(other, move || {
                    crate::windows::load_plugin_hosts(&target);
                    Ok(())
                }),
            );
        },
    );
    if cleared {
        emit_host(
            Level::Debug,
            "host.trace.plugin-host.restart-reset",
            json!({"plugin": plugin}),
        );
    }
}

/// Clears the restart-limit stop of plugin when the person enables it, and calls reload once for each window label.
/// It calls reload for no label and returns false when the reset cleared no stop; it returns true when it cleared one.
pub(crate) fn clear_enabled_stop(
    restarts: &PluginHostRestarts,
    plugin: &str,
    labels: &[String],
    mut reload: impl FnMut(&str),
) -> bool {
    if !restarts.reset(plugin) {
        return false;
    }
    for label in labels {
        reload(label);
    }
    true
}

/// Records the navigation state of the host of plugin. A failure is written to the application log.
pub(crate) fn state(window: &Window, plugin: &str, state: &str) {
    let result =
        window_data(window).and_then(|data| data.plugin_host_channels.state(plugin, state));
    if let Err(error) = result {
        log_error("plugin host channel", error);
    }
}

/// Dispatches one message of the sok-view handler of the host webview handle of plugin. A failure is written to the
/// application log, and a queue overflow closes the host (docs/spec/plugin-host.md#channel).
pub(crate) fn message(window: &Window, plugin: &str, handle: Handle, value: &str) {
    let received =
        window_data(window).and_then(|data| data.plugin_host_channels.receive(plugin, value));
    let result = match received {
        Ok(Received::Emit(name, payload)) => {
            emit_window(window, name, payload).map_err(|error| error.to_string())
        }
        Ok(Received::Post(message)) => post(window, plugin, &message),
        Ok(Received::State {
            id,
            command,
            params,
            declared,
        }) => {
            let reply = window
                .state::<PluginHostStates>()
                .answer(plugin, declared, id, &command, &params);
            post(window, plugin, &reply)
        }
        Ok(Received::Ready { first }) => {
            if first {
                emit_host(
                    Level::Debug,
                    "host.trace.plugin-host.process-ready",
                    json!({"plugin": plugin, "window": window.label()}),
                );
            }
            // The current theme is the first message to a ready document, as it is for a view.
            post_theme(window, plugin)
        }
        Err(error) => {
            let overflow = is_queue_full(&error);
            log_error("plugin host channel", error);
            if overflow {
                // The page has lost messages, so its host webview is closed and restarted within the restart limit
                // (docs/spec/plugin-host.md#channel).
                failed(window, plugin, handle);
            }
            return;
        }
    };
    if let Err(error) = result {
        log_error("plugin host channel", error);
    }
}

/// Posts message to the ready document of the host of plugin.
fn post(window: &Window, plugin: &str, message: &Value) -> Result<(), String> {
    let data = window_data(window)?;
    data.plugin_host_channels.check_post(plugin)?;
    let handle = data
        .plugin_hosts
        .get(plugin)
        .ok_or_else(|| format!("plugin {plugin} has no host webview"))?;
    let platform = platform::current()?;
    if platform.post_document(handle, &message.to_string())? {
        Ok(())
    } else {
        Err(format!(
            "plugin {plugin}: the host document refused the message"
        ))
    }
}

/// Posts the current theme to the ready document of the host of plugin.
fn post_theme(window: &Window, plugin: &str) -> Result<(), String> {
    let theme = crate::theme::get(window)?;
    let theme = serde_json::to_value(&theme).map_err(|error| error.to_string())?;
    post(window, plugin, &theme_message(&theme))
}

/// Posts the current theme to each plugin host of the window that has a ready document. A host without one is skipped,
/// because the theme reaches it with its ready message.
pub(crate) fn post_theme_to_plugin_hosts(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    for plugin in data.plugin_host_channels.plugins() {
        if data.plugin_host_channels.ready_document(&plugin).is_none() {
            continue;
        }
        if let Err(error) = post_theme(window, &plugin) {
            log_error("plugin host channel", error);
        }
    }
    Ok(())
}

/// Posts message from the main page to the host of plugin, after the main page is confirmed as the caller. The action
/// names the command in the error of an unauthorized caller.
fn post_from_main(
    webview: &Webview,
    action: &str,
    plugin: &str,
    message: &Value,
) -> Result<(), String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(webview.label(), window.label(), action)?;
    post(&window, plugin, message)
}

/// Posts the reply of the main page to a call request of the host of reply.plugin, and records that the call is no
/// longer open.
pub(crate) fn plugin_host_reply(webview: &Webview, reply: PluginHostReply) -> Result<(), String> {
    let message = reply_message(&reply)?;
    post_from_main(webview, "plugin host reply", &reply.plugin, &message)?;
    window_data(&webview.window())?
        .plugin_host_channels
        .answer_call(&reply.plugin, reply.id);
    Ok(())
}

/// Posts a request of the main page to the host of request.plugin.
pub(crate) fn plugin_host_request(
    webview: &Webview,
    request: PluginHostRequest,
) -> Result<(), String> {
    let message = request_message(&request)?;
    post_from_main(webview, "plugin host request", &request.plugin, &message)
}

/// Posts an event of the main page to the host of event.plugin.
pub(crate) fn plugin_host_event(webview: &Webview, event: PluginHostEvent) -> Result<(), String> {
    let message = event_message(&event)?;
    post_from_main(webview, "plugin host event", &event.plugin, &message)
}
