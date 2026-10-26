//! Document regions in a surface page. This is the "document region" of docs/spec/native-surfaces.md.
//!
//! A surface page attaches an external document to one of its elements. The host places a document webview inside the
//! webview of that surface, lays it out with the insets that the page reported, and sends the document state only to
//! that surface. The document webview is a subview of the surface webview, so it moves and hides together with the
//! surface. It is closed when the surface is removed or the surface page is loaded again.
//!
//! Commands run outside the main thread and native work runs on the main thread. A cleanup that started on the main
//! thread is not awaited.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use tauri::{Manager, Webview, Window};

use crate::application_log::{log_error, log_failure};
use crate::event_log::Level;
use crate::event_record::emit_host;
use crate::exposure::{self, on_main, with_view};
use crate::platform::{self, Handle, Platform};
use crate::presentation_wait::{PresentationWait, ViewPlacement, presentation_abandoned_payload};
use crate::source_origins::DeclaredSourceOrigins;
use crate::surfaces::{Placement, require_region, surface_handle};
use crate::surfaces::{ViewStart, view_origin_directory};
use crate::view_lifecycle::{
    ViewLifecycle, is_queue_full, view_process_ended_event, view_stop_reason, view_stopped_event,
};
use crate::windows::{
    DeclaredSourceEventStream, WindowData, emit_window, window_data, window_data_if_registered,
    with_native_owner,
};

/// The directory inside the configuration directory that holds the persistent site data of document regions. It differs
/// from the storage of the app document.
/// (docs/spec/native-surfaces.md#document-regions).
pub(crate) const DOCUMENT_DATA: &str = "document-data";

/// A document region call of a surface page. Each call uses only the fields that it needs.
#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    pub surface: String,
    pub document: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub zoom: Option<f64>,
    #[serde(default)]
    pub offset: Option<i32>,
    /// The JSON value that documentPost sends to a plugin document.
    #[serde(default)]
    pub message: Option<serde_json::Value>,
    /// The stream of a subscribe request: elements or requests.
    #[serde(default)]
    pub stream: String,
    /// The subscription of an unsubscribe request.
    #[serde(default)]
    pub handle: Option<u64>,
    /// The base64 interactionState that documentAttach restores into the new region before its first load.
    #[serde(default, rename = "interactionState")]
    pub interaction_state: Option<String>,
}

/// The reply of documentQuery: whether the region plays audible media, whether capture is active and whether a frame holds a
/// form flag (docs/spec/plugins.md#memory-saver).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Report {
    pub media: bool,
    pub capture: bool,
    pub form: bool,
}

/// Turns the query reply of native, {media, capture, form} or {error}, into the report of the document, or into the error
/// that names the document.
pub fn parse_report(document: &str, reply: &str) -> Result<Report, String> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Reply {
        Failure { error: String },
        Report(Report),
    }
    match serde_json::from_str::<Reply>(reply) {
        Ok(Reply::Failure { error }) => Err(format!("document {document}: {error}")),
        Ok(Reply::Report(report)) => Ok(report),
        _ => Err(format!(
            "document {document} answered an invalid query reply: {reply}"
        )),
    }
}

/// The reply of a stream subscription: the handle that ends it.
#[derive(Serialize)]
pub struct Subscription {
    pub handle: u64,
}

/// A change of the collection of a stream of a document region, which the caller applies to the native document.
#[derive(Clone, Debug, PartialEq)]
pub struct StreamEffect {
    pub key: Key,
    pub stream: String,
    pub on: bool,
}

/// One message of a document stream for one subscription, which is sent only to the surface that made the subscription.
#[derive(Clone, Debug, PartialEq)]
pub struct StreamDelivery {
    pub surface: String,
    pub handle: u64,
    pub stream: String,
    pub message: Value,
}

/// The outcome of a stream message of native. ack is true for a snapshot, which native is acknowledged with seq after the deliveries.
#[derive(Debug, Default, PartialEq)]
pub struct StreamResult {
    pub deliveries: Vec<StreamDelivery>,
    pub ack: bool,
    pub seq: u64,
}

/// The event of a stream message, sent to the window of the surface that made the subscription.
#[derive(Clone, Serialize)]
struct StreamEvent {
    surface: String,
    document: String,
    stream: String,
    handle: u64,
    message: Value,
}

/// A message of a plugin document, {"message": value} or {"error": reason}: the payload of the document-message
/// event of the owning surface, or the reason that the host writes to the application log.
pub enum Message {
    Forward(serde_json::Value),
    Failure(String),
}

pub fn document_message(surface: &str, document: &str, value: &str) -> Result<Message, String> {
    let received: serde_json::Value = serde_json::from_str(value)
        .map_err(|error| format!("document message {document} is not JSON: {error}"))?;
    if let Some(reason) = received.get("error").and_then(|reason| reason.as_str()) {
        return Ok(Message::Failure(reason.to_string()));
    }
    match received.get("message") {
        Some(message) => Ok(Message::Forward(serde_json::json!({
            "surface": surface,
            "document": document,
            "message": message,
        }))),
        None => Err(format!(
            "document message {document} has neither message nor error"
        )),
    }
}

impl Request {
    /// The text scale of the document (docs/spec/text-size.md). It is an error when it is absent or not a finite
    /// positive number.
    /// The interactionState that documentAttach restores, or None. An empty value is an error.
    pub fn restore_state(&self) -> Result<Option<&str>, String> {
        match self.interaction_state.as_deref() {
            Some("") => Err("document interactionState must not be empty".into()),
            state => Ok(state),
        }
    }

    pub fn zoom_factor(&self) -> Result<f64, String> {
        match self.zoom {
            Some(zoom) if zoom.is_finite() && zoom > 0.0 => Ok(zoom),
            _ => Err("document zoom must be a finite positive number".into()),
        }
    }
}

/// The value of the document-state event.
#[derive(Clone, Serialize)]
struct State {
    surface: String,
    document: String,
    state: Value,
}

#[derive(Clone, Serialize)]
struct Event {
    surface: String,
    document: String,
    event: Value,
}

/// A pair of a surface and a document name.
pub type Key = (String, String);

/// Checks that the calling surface caller is request.surface and that the document name is valid, and returns the key.
/// When caller is None, the calling webview is not a surface of this window.
pub fn check(caller: Option<&str>, request: &Request) -> Result<Key, String> {
    if caller != Some(request.surface.as_str()) {
        return Err(format!(
            "this document is not surface {:?}",
            request.surface
        ));
    }
    let mut chars = request.document.chars();
    let valid = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && request.document.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(format!("invalid document name {:?}", request.document));
    }
    Ok((request.surface.clone(), request.document.clone()))
}

/// The stream names of a document region (docs/spec/native-surfaces.md#document-streams).
const ELEMENTS: &str = "elements";
const REQUESTS: &str = "requests";

/// The number of request entries that a document region keeps for a new subscription.
const REQUEST_LOG_LIMIT: usize = 200;

/// The text of a stream message that is not a JSON object with the fields of the stream protocol.
const NOT_JSON: &str = "document stream message is not JSON";

/// Checks that a stream name is elements or requests.
fn check_stream(name: &str) -> Result<(), String> {
    match name {
        ELEMENTS | REQUESTS => Ok(()),
        _ => Err(format!("unknown document stream {name:?}")),
    }
}

/// Returns the error of an acknowledgement that native refuses. It names the document, the stream and the seq.
pub fn stream_ack_refusal(key: &Key, stream: &str, seq: u64) -> String {
    format!(
        "document {:?} stream {stream}: seq {seq} was not sent",
        key.1
    )
}

/// Reads a string field of a stream message. A missing or null field is the empty text.
fn text_field(value: Option<&Value>) -> Result<String, String> {
    match value {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(text)) => Ok(text.clone()),
        Some(_) => Err(NOT_JSON.to_string()),
    }
}

/// A subscription of a stream of a document region.
struct Subscriber {
    key: Key,
    stream: String,
}

/// The request log of a document region: the most recent entries and the number of entries dropped since the last reset.
#[derive(Default)]
struct RequestLog {
    entries: Vec<Value>,
    dropped: u64,
}

/// The entries message of the request log: the entries and the dropped count.
fn entries_message(log: &RequestLog) -> Value {
    json!({"type": "entries", "entries": log.entries, "dropped": log.dropped})
}

#[derive(Default)]
struct StreamState {
    next: u64,
    subscribers: BTreeMap<u64, Subscriber>,
    logs: HashMap<Key, RequestLog>,
}

impl StreamState {
    fn count(&self, key: &Key, stream: &str) -> usize {
        self.subscribers
            .values()
            .filter(|subscriber| subscriber.key == *key && subscriber.stream == stream)
            .count()
    }

    /// Releases the request log of a region that has no subscription.
    fn release(&mut self, key: &Key) {
        if !self
            .subscribers
            .values()
            .any(|subscriber| subscriber.key == *key)
        {
            self.logs.remove(key);
        }
    }

    /// The message of each subscription of a stream of the region, in the order of the handles.
    fn deliveries(&self, key: &Key, stream: &str, message: &Value) -> Vec<StreamDelivery> {
        self.subscribers
            .iter()
            .filter(|(_, subscriber)| subscriber.key == *key && subscriber.stream == stream)
            .map(|(handle, _)| StreamDelivery {
                surface: key.0.clone(),
                handle: *handle,
                stream: stream.to_string(),
                message: message.clone(),
            })
            .collect()
    }

    /// Removes the subscriptions whose region matches and returns the turn-off effects of the streams that lose their last subscriber.
    fn remove(&mut self, matches: impl Fn(&Key) -> bool) -> Vec<StreamEffect> {
        let mut lost = BTreeSet::new();
        self.subscribers.retain(|_, subscriber| {
            if matches(&subscriber.key) {
                lost.insert((subscriber.key.clone(), subscriber.stream.clone()));
                false
            } else {
                true
            }
        });
        let effects = lost
            .into_iter()
            .filter(|(key, stream)| self.count(key, stream) == 0)
            .map(|(key, stream)| StreamEffect {
                key,
                stream,
                on: false,
            })
            .collect();
        let keys: Vec<Key> = self.logs.keys().cloned().collect();
        for key in &keys {
            self.release(key);
        }
        effects
    }
}

/// The stream subscriptions of the document regions of a window. The host counts the subscriptions of each region and stream;
/// the first subscription of a stream turns its collection on and the last removal turns it off. The methods do not call native,
/// so the caller applies the returned effects on the main thread.
#[derive(Default)]
pub struct Streams(Mutex<StreamState>);

impl Streams {
    fn lock(&self) -> MutexGuard<'_, StreamState> {
        self.0
            .lock()
            // default: a thread that stopped while holding the lock changed the maps only by one insert, remove or read, so the
            // state is consistent, and that stop was already reported as a panic report.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Registers a subscription of a stream on the region key. It returns the handle, the effects to apply, and the first message
    /// of the subscriber, which is the request log of a requests subscription.
    pub fn subscribe(
        &self,
        key: &Key,
        stream: &str,
    ) -> Result<(u64, Vec<StreamEffect>, Option<Value>), String> {
        check_stream(stream)?;
        let mut state = self.lock();
        state.next += 1;
        let handle = state.next;
        state.subscribers.insert(
            handle,
            Subscriber {
                key: key.clone(),
                stream: stream.to_string(),
            },
        );
        let initial = if stream == REQUESTS {
            Some(entries_message(state.logs.entry(key.clone()).or_default()))
        } else {
            None
        };
        let mut effects = Vec::new();
        if state.count(key, stream) == 1 {
            effects.push(StreamEffect {
                key: key.clone(),
                stream: stream.to_string(),
                on: true,
            });
        }
        Ok((handle, effects, initial))
    }

    /// Removes a subscription whose stream native refused to turn on. No effect is returned, because native did not turn the stream on.
    pub fn abandon(&self, handle: u64) {
        let mut state = self.lock();
        if let Some(subscriber) = state.subscribers.remove(&handle) {
            state.release(&subscriber.key);
        }
    }

    /// Ends the subscription handle of the region key. It is an error when the handle is not a subscription of that region.
    pub fn unsubscribe(&self, key: &Key, handle: u64) -> Result<Vec<StreamEffect>, String> {
        let mut state = self.lock();
        let stream = match state.subscribers.get(&handle) {
            Some(subscriber) if subscriber.key == *key => subscriber.stream.clone(),
            _ => {
                return Err(format!(
                    "document stream handle {handle} is not subscribed to document {:?}",
                    key.1
                ));
            }
        };
        state.subscribers.remove(&handle);
        let mut effects = Vec::new();
        if state.count(key, &stream) == 0 {
            effects.push(StreamEffect {
                key: key.clone(),
                stream,
                on: false,
            });
        }
        state.release(key);
        Ok(effects)
    }

    /// Removes the subscriptions of a closed region and releases its request log.
    pub fn remove_region(&self, key: &Key) -> Vec<StreamEffect> {
        self.lock().remove(|region| region == key)
    }

    /// Removes the subscriptions of a surface and returns the turn-off effects of the streams that lose their last subscriber.
    pub fn remove_surface(&self, surface: &str) -> Vec<StreamEffect> {
        self.lock().remove(|region| region.0 == surface)
    }

    /// Removes every subscription of the main page of a window and returns the turn-off effects of the streams that lose
    /// their last subscriber. Every subscription of a window is made by its main page, so this ends the subscriptions of
    /// all surfaces of the window.
    pub fn remove_page(&self) -> Vec<StreamEffect> {
        self.lock().remove(|_| true)
    }

    /// The number of subscriptions of a stream of a region.
    pub fn subscribers(&self, key: &Key, stream: &str) -> usize {
        self.lock().count(key, stream)
    }

    /// The number of entries in the request log of a region and the number of entries it dropped since the last reset.
    pub fn log_state(&self, key: &Key) -> (usize, u64) {
        self.lock()
            .logs
            .get(key)
            .map_or((0, 0), |log| (log.entries.len(), log.dropped))
    }

    /// Handles one stream message of native for the region key. A request entry that arrives while the region has no subscription
    /// belongs to a collection that is turned off, so it is not kept.
    pub fn deliver(&self, key: &Key, value: &str) -> Result<StreamResult, String> {
        let envelope: Value = serde_json::from_str(value).map_err(|_| NOT_JSON.to_string())?;
        let stream = text_field(envelope.get("stream"))?;
        let message = envelope
            .get("message")
            .ok_or_else(|| NOT_JSON.to_string())?;
        let kind = text_field(message.get("type"))?;
        let seq = match message.get("seq") {
            None | Some(Value::Null) => None,
            Some(seq) => Some(seq.as_u64().ok_or_else(|| NOT_JSON.to_string())?),
        };
        let entries = match message.get("entries") {
            None | Some(Value::Null) => None,
            Some(Value::Array(entries)) => Some(entries.clone()),
            Some(_) => return Err(NOT_JSON.to_string()),
        };
        check_stream(&stream)?;
        let mut state = self.lock();
        match (stream.as_str(), kind.as_str()) {
            (ELEMENTS, "snapshot") => {
                let seq = seq.ok_or_else(|| {
                    r#"document stream "elements" snapshot has no seq"#.to_string()
                })?;
                let deliveries = state.deliveries(key, ELEMENTS, message);
                Ok(StreamResult {
                    deliveries,
                    ack: true,
                    seq,
                })
            }
            (REQUESTS, "entries") => {
                let entries = entries.ok_or_else(|| {
                    r#"document stream "requests" entries message has no entries"#.to_string()
                })?;
                let Some(log) = state.logs.get_mut(key) else {
                    return Ok(StreamResult::default());
                };
                log.entries.extend(entries.iter().cloned());
                if log.entries.len() > REQUEST_LOG_LIMIT {
                    let overflow = log.entries.len() - REQUEST_LOG_LIMIT;
                    log.dropped += overflow as u64;
                    log.entries.drain(..overflow);
                }
                let body = json!({"type": "entries", "entries": entries, "dropped": log.dropped});
                let deliveries = state.deliveries(key, REQUESTS, &body);
                Ok(StreamResult {
                    deliveries,
                    ..StreamResult::default()
                })
            }
            (_, "reset") => {
                if stream == REQUESTS
                    && let Some(log) = state.logs.get_mut(key)
                {
                    log.entries.clear();
                    log.dropped = 0;
                }
                let body = json!({"type": "reset"});
                let deliveries = state.deliveries(key, &stream, &body);
                Ok(StreamResult {
                    deliveries,
                    ..StreamResult::default()
                })
            }
            _ => Err(format!(
                "document stream {stream:?} sent an unknown message type {kind:?}"
            )),
        }
    }
}

/// The document regions of a window. The value is the address of the document webview, and 0 for a region that is being
/// created.
#[derive(Default)]
pub struct Documents(
    Mutex<HashMap<Key, Handle>>,
    ViewChannels,
    ViewLifecycle,
    PresentationWait,
);

impl Documents {
    /// Returns the failures and the records of the view surfaces of the window.
    pub fn lifecycle(&self) -> &ViewLifecycle {
        &self.2
    }

    /// The presentation wait of the views of the window (presentation_wait.rs).
    pub fn presentation(&self) -> &PresentationWait {
        &self.3
    }
}

#[cfg(feature = "diagnostics")]
impl Documents {
    /// Returns the number of names of the document regions, including the names whose document is being created.
    pub fn count(&self) -> usize {
        self.lock().len()
    }

    /// Returns the document regions whose document is created, with the address of each document. A name that is being
    /// created has the address 0 and is not returned.
    pub fn attached(&self) -> Vec<(Key, Handle)> {
        self.lock()
            .iter()
            .filter(|(_, handle)| **handle != 0)
            .map(|(key, handle)| (key.clone(), *handle))
            .collect()
    }
}

impl Documents {
    /// The view channels of the window. A view record leaves with the view of its surface.
    pub fn views(&self) -> &ViewChannels {
        &self.1
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Handle>> {
        self.0
            .lock()
            // default: a thread that stopped while holding the lock also changed the map only by one insert, remove or
            // read, so the map is consistent, and that stop was already reported as a panic report.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Takes a name. It is an error when the same name already exists.
    pub fn reserve(&self, key: &Key) -> Result<(), String> {
        let mut all = self.lock();
        if all.contains_key(key) {
            return Err(format!("document {:?} is already attached", key.1));
        }
        all.insert(key.clone(), 0);
        Ok(())
    }

    /// Writes the address of the created document to the taken name. It is false when the name was removed in the
    /// meantime.
    pub fn set(&self, key: &Key, handle: Handle) -> bool {
        match self.lock().get_mut(key) {
            Some(slot) => {
                *slot = handle;
                true
            }
            None => false,
        }
    }

    /// Returns the address of a created document.
    pub fn get(&self, key: &Key) -> Result<Handle, String> {
        match self.lock().get(key) {
            Some(&handle) if handle != 0 => Ok(handle),
            _ => Err(format!("document {:?} is not attached", key.1)),
        }
    }

    /// Removes a name and returns the address of its document. The address is 0 when the name was being created.
    pub fn remove(&self, key: &Key) -> Result<Handle, String> {
        let handle = self
            .lock()
            .remove(key)
            .ok_or_else(|| format!("document {:?} is not attached", key.1))?;
        if key.1 == VIEW_NAME {
            self.1.forget(&key.0);
        }
        Ok(handle)
    }

    /// Removes every name of a surface and returns the addresses of the created documents.
    pub fn remove_surface(&self, surface: &str) -> Vec<Handle> {
        let mut removed = Vec::new();
        self.1.forget(surface);
        self.lock().retain(|key, handle| {
            if key.0 != surface {
                return true;
            }
            if *handle != 0 {
                removed.push(*handle);
            }
            false
        });
        removed
    }

    /// The key of each address of a created document.
    pub fn names(&self) -> HashMap<Handle, Key> {
        self.lock()
            .iter()
            .filter(|&(_, &handle)| handle != 0)
            .map(|(key, &handle)| (handle, key.clone()))
            .collect()
    }

    /// The addresses of created documents.
    pub fn all(&self) -> Vec<Handle> {
        self.lock()
            .values()
            .copied()
            .filter(|&handle| handle != 0)
            .collect()
    }
}

/// The text of the view channel script that each view configuration runs (docs/spec/native-surfaces.md#view-surfaces). The
/// application sets it once at startup from the bundled frontend.
static VIEW_CHANNEL: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Sets the view channel script. It is an error when the script is already set.
pub fn set_view_channel(text: &str) -> Result<(), String> {
    VIEW_CHANNEL
        .set(text.to_string())
        .map_err(|_| "the view channel script is already set".to_string())
}

/// The text of the view channel script. It is an error when the application has not set it.
pub(crate) fn view_channel() -> Result<&'static str, String> {
    VIEW_CHANNEL
        .get()
        .map(String::as_str)
        .ok_or_else(|| "the view channel script is not loaded".to_string())
}

/// The view channel of one view surface: the plugin of its view and its ready document. An empty document means that no ready
/// document is recorded (docs/spec/plugin-processes.md, rule 4).
struct ViewChannel {
    plugin: String,
    document: String,
    origin: ViewOrigin,
    /// Set by the first ready message of the view, which writes host.trace.view.process-ready once.
    process_ready: bool,
    /// The navigations that the last document state of the view reported. A higher count starts a new document.
    navigations: u64,
    /// The calls that the view has open, by id, with the plugin and the command of each.
    calls: BTreeMap<u64, String>,
}

/// The local identity of one native view document. It does not depend on a native handle, which can be reused after release.
#[derive(Clone, Debug)]
struct ViewOrigin {
    instance: std::sync::Arc<()>,
    generation: u64,
}

/// The result of checking a native callback before it enters the view channel.
#[derive(Debug, PartialEq, Eq)]
enum ViewIngress {
    Current,
    Cancelled,
    ProducerError(RetiredViewError),
}

#[derive(Debug, PartialEq, Eq)]
enum RetiredViewError {
    Channel(String),
    View(String),
}

/// The view channels of a window, by surface. A navigation clears the ready document, so a post cannot reach a document that
/// the view has not reported.
#[derive(Default)]
pub struct ViewChannels(Mutex<HashMap<String, ViewChannel>>);

#[derive(Deserialize)]
struct ViewReceived {
    message: Option<Value>,
    error: Option<String>,
}

/// Parses errors from a retired view while leaving valid calls and replies for cancellation.
fn retired_view_error(surface: &str, value: &str) -> Option<RetiredViewError> {
    let received: ViewReceived = match serde_json::from_str(value) {
        Ok(received) => received,
        Err(error) => {
            return Some(RetiredViewError::Channel(format!(
                "{surface}: view message is not JSON: {error}"
            )));
        }
    };
    if let Some(error) = received.error {
        return Some(RetiredViewError::Channel(error));
    }
    let Some(message) = received.message else {
        return Some(RetiredViewError::Channel(format!(
            "{surface}: view message has neither message nor error"
        )));
    };
    let Some(fields) = message.as_object() else {
        let error = match serde_json::from_value::<ViewEvent>(message) {
            Err(error) => error,
            Ok(_) => return None,
        };
        return Some(RetiredViewError::Channel(format!(
            "{surface}: view event is not an object: {error}"
        )));
    };
    match fields.get("event").and_then(Value::as_str) {
        Some("view.error") => {}
        Some("view.ready" | DECLARED_SNAPSHOT_MESSAGE) => return None,
        Some(event) => {
            return Some(RetiredViewError::Channel(format!(
                "{surface}: view event {event:?} is unknown"
            )));
        }
        None if fields.get("reply").is_some_and(|value| !value.is_null())
            || fields.get("command").is_some_and(|value| !value.is_null())
            || fields.get("cancel").is_some_and(|value| !value.is_null()) =>
        {
            return None;
        }
        None => {
            let error = match serde_json::from_value::<ViewEvent>(message) {
                Err(error) => error,
                Ok(_) => return None,
            };
            return Some(RetiredViewError::Channel(format!(
                "{surface}: view event is not an object: {error}"
            )));
        }
    }
    let Some(reason) = message
        .get("reason")
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty())
    else {
        return Some(RetiredViewError::Channel(format!(
            "{surface}: view.error has no reason"
        )));
    };
    if is_queue_full(reason) {
        Some(RetiredViewError::Channel(reason.to_string()))
    } else {
        Some(RetiredViewError::View(reason.to_string()))
    }
}

/// Writes an error produced by a retired view with the plugin and surface captured by its callback.
fn report_retired_view_error(plugin: &str, surface: &str, error: RetiredViewError) {
    match error {
        RetiredViewError::Channel(reason) => log_error("view channel", reason),
        RetiredViewError::View(reason) => log_error(&format!("view {plugin} {surface}"), reason),
    }
}

/// Stops dispatch when a callback belongs to a retired view, while retaining its explicit producer error.
fn accept_view_message(
    channels: &ViewChannels,
    plugin: &str,
    surface: &str,
    origin: &ViewOrigin,
    value: &str,
) -> bool {
    match channels.ingress(surface, origin, value) {
        ViewIngress::Current => true,
        ViewIngress::Cancelled => false,
        ViewIngress::ProducerError(error) => {
            report_retired_view_error(plugin, surface, error);
            false
        }
    }
}

/// Writes the trace record for a callback canceled after its view identity retired.
fn record_view_message_cancelled(surface: &str, reason: &str) {
    emit_host(
        Level::Debug,
        "host.trace.view.callback-cancelled",
        json!({"surface": surface, "reason": reason}),
    );
}

/// Whether origin still owns surface in a window that has not been removed.
fn view_callback_retired_reason(
    window: &Window,
    surface: &str,
    origin: &ViewOrigin,
) -> Option<&'static str> {
    match window_data(window) {
        Err(_) => Some("window-closed"),
        Ok(data) if !data.documents.views().is_current(surface, origin) => Some("retired-origin"),
        Ok(_) => None,
    }
}

#[derive(Deserialize)]
struct ViewEvent {
    event: String,
    #[serde(default)]
    plugin: String,
    #[serde(default)]
    document: String,
    #[serde(default)]
    reason: String,
}

/// The document state of a view (docs/spec/native-surfaces.md, document-state). The decoder checks that loading is a JSON boolean; the
/// ready record follows navigations, because loading is also true for each progress change of a navigation.
#[derive(Deserialize)]
struct ViewState {
    #[allow(dead_code)]
    loading: bool,
    navigations: Option<u64>,
}

#[derive(Debug, PartialEq)]
enum ViewDispatch {
    Reply(Value),
    Call(Value),
    Snapshot(Value),
    Ready(Result<bool, String>),
}

impl ViewChannels {
    fn dispatch(&self, surface: &str, value: &str) -> Result<ViewDispatch, String> {
        self.dispatch_with_decoder(surface, value, |value| {
            serde_json::from_str(value)
                .map_err(|error| format!("{surface}: view message is not JSON: {error}"))
        })
    }

    fn dispatch_with_decoder(
        &self,
        surface: &str,
        value: &str,
        mut decode: impl FnMut(&str) -> Result<ViewReceived, String>,
    ) -> Result<ViewDispatch, String> {
        let received = decode(value)?;
        let message = received.message.as_ref();
        if message.and_then(|message| message.get("reply")).is_some() {
            return self.reply_received(surface, received).map(|payload| {
                ViewDispatch::Reply(payload.expect("the reply field selected the reply handler"))
            });
        }
        let field = |name| {
            message
                .and_then(|message| message.get(name))
                .filter(|value| !value.is_null())
        };
        if field("command").is_some() || field("cancel").is_some() {
            return self.call_received(surface, received).map(|payload| {
                ViewDispatch::Call(payload.expect("a command or cancel selected the call handler"))
            });
        }
        if message
            .and_then(|message| message.get("event"))
            .and_then(Value::as_str)
            == Some(DECLARED_SNAPSHOT_MESSAGE)
        {
            return self.snapshot_received(surface, received).map(|payload| {
                ViewDispatch::Snapshot(
                    payload.expect("the snapshot event selected the snapshot handler"),
                )
            });
        }
        Ok(ViewDispatch::Ready(
            self.message_received(surface, received),
        ))
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ViewChannel>> {
        self.0
            .lock()
            // default: the map is only changed by one insert, update or remove, so it is consistent after a thread stopped
            // while it held the lock.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records the plugin of the view of surface. It runs when the view is created.
    pub fn register(&self, surface: &str, plugin: &str, generation: u64) {
        self.register_origin(surface, plugin, generation);
    }

    /// Registers a view before its native document loads and returns its local callback identity.
    fn register_origin(&self, surface: &str, plugin: &str, generation: u64) -> ViewOrigin {
        let origin = ViewOrigin {
            instance: std::sync::Arc::new(()),
            generation,
        };
        self.lock().insert(
            surface.to_string(),
            ViewChannel {
                plugin: plugin.to_string(),
                document: String::new(),
                origin: origin.clone(),
                process_ready: false,
                navigations: 0,
                calls: BTreeMap::new(),
            },
        );
        origin
    }

    /// Checks the local origin of one native callback before it enters message dispatch.
    fn ingress(&self, surface: &str, origin: &ViewOrigin, value: &str) -> ViewIngress {
        if self.is_current(surface, origin) {
            return ViewIngress::Current;
        }
        if let Some(error) = retired_view_error(surface, value) {
            return ViewIngress::ProducerError(error);
        }
        emit_host(
            Level::Debug,
            "host.trace.view.callback-cancelled",
            json!({"surface": surface, "reason": "retired-origin"}),
        );
        ViewIngress::Cancelled
    }

    /// Whether origin still owns the view channel of surface.
    fn is_current(&self, surface: &str, origin: &ViewOrigin) -> bool {
        self.lock().get(surface).is_some_and(|channel| {
            channel.origin.generation == origin.generation
                && std::sync::Arc::ptr_eq(&channel.origin.instance, &origin.instance)
        })
    }

    /// Removes the channel only when origin still owns surface.
    fn forget_if_current(&self, surface: &str, origin: &ViewOrigin) {
        let mut channels = self.lock();
        if channels.get(surface).is_some_and(|channel| {
            channel.origin.generation == origin.generation
                && std::sync::Arc::ptr_eq(&channel.origin.instance, &origin.instance)
        }) {
            channels.remove(surface);
        }
    }

    fn forget_generation(&self, surface: &str, generation: u64) -> Option<String> {
        let mut channels = self.lock();
        if channels
            .get(surface)
            .is_none_or(|channel| channel.origin.generation != generation)
        {
            return None;
        }
        channels.remove(surface).map(|channel| channel.plugin)
    }

    pub(crate) fn plugin(&self, surface: &str) -> Option<String> {
        self.lock()
            .get(surface)
            .map(|channel| channel.plugin.clone())
    }

    pub(crate) fn generation(&self, surface: &str) -> Option<u64> {
        self.lock()
            .get(surface)
            .map(|channel| channel.origin.generation)
    }

    /// Records that the view of surface has a ready message, and returns its plugin when this is its first ready message since it was
    /// created. A view without a channel returns None.
    pub fn first_ready(&self, surface: &str) -> Option<String> {
        let mut channels = self.lock();
        let channel = channels.get_mut(surface)?;
        if channel.process_ready {
            return None;
        }
        channel.process_ready = true;
        Some(channel.plugin.clone())
    }

    /// Ends the open calls of the view of surface with the reason process-ended, and returns the plugin and the command of each in the
    /// order of their ids (docs/spec/native-surfaces.md#view-surfaces).
    pub fn end_calls(&self, surface: &str) -> Vec<(String, String)> {
        let mut channels = self.lock();
        let Some(channel) = channels.get_mut(surface) else {
            return Vec::new();
        };
        let calls = std::mem::take(&mut channel.calls);
        calls
            .into_values()
            .map(|command| (channel.plugin.clone(), command))
            .collect()
    }

    /// Records that the main page answered the call id of the view of surface, so the call is no longer open.
    pub fn answer_call(&self, surface: &str, generation: u64, id: u64) {
        if let Some(channel) = self
            .lock()
            .get_mut(surface)
            .filter(|channel| channel.origin.generation == generation)
        {
            channel.calls.remove(&id);
        }
    }

    /// Removes the record of the view of surface.
    pub fn forget(&self, surface: &str) {
        self.lock().remove(surface);
    }

    /// Removes all view identities of a window that has been destroyed.
    pub fn forget_all(&self) {
        self.lock().clear();
    }

    /// Whether the surface has a view.
    pub fn has(&self, surface: &str) -> bool {
        self.lock().contains_key(surface)
    }

    /// Returns the surfaces that have a view, in order.
    pub fn surfaces(&self) -> Vec<String> {
        let mut surfaces: Vec<String> = self.lock().keys().cloned().collect();
        surfaces.sort();
        surfaces
    }

    /// Returns the ready document of the view of surface, or None when the view has none.
    pub fn ready_document(&self, surface: &str) -> Option<String> {
        self.lock()
            .get(surface)
            .map(|channel| channel.document.clone())
            .filter(|document| !document.is_empty())
    }

    /// Records a reply that the host forwards to the view, at the debug level (docs/spec/logging.md).
    fn record_view_reply(plugin: &str, surface: &str, id: u64, outcome: &str) {
        emit_host(
            Level::Debug,
            "host.view.reply",
            json!({"plugin": plugin, "surface": surface, "id": id, "outcome": outcome}),
        );
    }

    /// Dispatches one message of the sok-view handler of the view of surface, which is {"message": value} or {"error": reason}.
    /// It returns Ok(true) when the message makes the view ready, and the reason that the host logs for any other failure.
    pub fn message(&self, surface: &str, value: &str) -> Result<bool, String> {
        let received: ViewReceived = serde_json::from_str(value)
            .map_err(|error| format!("{surface}: view message is not JSON: {error}"))?;
        self.message_received(surface, received)
    }

    fn message_received(&self, surface: &str, received: ViewReceived) -> Result<bool, String> {
        if let Some(error) = received.error {
            return Err(error);
        }
        let message = received
            .message
            .ok_or_else(|| format!("{surface}: view message has neither message nor error"))?;
        let event: ViewEvent = serde_json::from_value(message)
            .map_err(|error| format!("{surface}: view event is not an object: {error}"))?;
        let plugin = self
            .lock()
            .get(surface)
            .map(|channel| channel.plugin.clone())
            .ok_or_else(|| {
                format!("{surface}: view channel message of a surface without a view")
            })?;
        match event.event.as_str() {
            "view.ready" => {
                if event.plugin != plugin || event.document.is_empty() {
                    return Err(format!(
                        "{surface}: view.ready names plugin {:?} and document {:?}, want plugin {plugin:?}",
                        event.plugin, event.document
                    ));
                }
                if let Some(channel) = self.lock().get_mut(surface) {
                    channel.document = event.document;
                }
                Ok(true)
            }
            "view.error" => {
                if is_queue_full(&event.reason) {
                    return Err(event.reason);
                }
                if event.reason.is_empty() {
                    return Err(format!("{surface}: view.error has no reason"));
                }
                // A failure of the page before its first call is written on the error display path of the view, with its plugin
                // and surface (docs/spec/native-surfaces.md#view-surfaces). The view continues, so the message is accepted.
                log_error(&format!("view {plugin} {surface}"), &event.reason);
                Ok(false)
            }
            other => Err(format!("{surface}: view event {other:?} is unknown")),
        }
    }

    /// Returns the view-reply payload of a reply of the view of surface, or None when the message has no reply field. A reply has an
    /// integer id and exactly one of result and error; an error has an integer code and a message.
    pub fn reply(&self, surface: &str, value: &str) -> Result<Option<Value>, String> {
        let received: ViewReceived = serde_json::from_str(value)
            .map_err(|error| format!("{surface}: view message is not JSON: {error}"))?;
        self.reply_received(surface, received)
    }

    fn reply_received(
        &self,
        surface: &str,
        received: ViewReceived,
    ) -> Result<Option<Value>, String> {
        let Some(message) = received.message else {
            return Ok(None);
        };
        let Some(reply) = message.get("reply") else {
            return Ok(None);
        };
        let id = reply
            .as_u64()
            .ok_or_else(|| format!("{surface}: view reply has no integer id"))?;
        let plugin = self
            .lock()
            .get(surface)
            .map(|channel| channel.plugin.clone())
            .ok_or_else(|| {
                format!("{surface}: view channel message of a surface without a view")
            })?;
        match (message.get("result"), message.get("error")) {
            (Some(_), Some(_)) => Err(format!(
                "{surface}: view reply {id} has both a result and an error"
            )),
            (None, None) => Err(format!(
                "{surface}: view reply {id} has neither a result nor an error"
            )),
            (Some(result), None) => {
                Self::record_view_reply(&plugin, surface, id, "result");
                Ok(Some(json!({
                    "surface": surface,
                    "plugin": plugin,
                    "id": id,
                    "result": result,
                })))
            }
            (None, Some(error)) => {
                let code = error.get("code").and_then(Value::as_i64).ok_or_else(|| {
                    format!("{surface}: view reply {id} has an error without an integer code")
                })?;
                let text = error
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .ok_or_else(|| {
                        format!("{surface}: view reply {id} has an error without a message")
                    })?;
                Self::record_view_reply(&plugin, surface, id, "error");
                Ok(Some(json!({
                    "surface": surface,
                    "plugin": plugin,
                    "id": id,
                    "error": {"code": code, "message": text},
                })))
            }
        }
    }

    /// Returns the view-call payload of a call request or a cancel of the view of surface, or None when the message is neither.
    /// A call request is {"id", "command", "params"}; a cancel is {"id", "cancel": true} and its payload is {"id", "cancel": true}
    /// with the surface and plugin. A cancel that is not true or that names a command is an error.
    pub fn call(&self, surface: &str, value: &str) -> Result<Option<Value>, String> {
        let received: ViewReceived = serde_json::from_str(value)
            .map_err(|error| format!("{surface}: view message is not JSON: {error}"))?;
        self.call_received(surface, received)
    }

    fn call_received(
        &self,
        surface: &str,
        received: ViewReceived,
    ) -> Result<Option<Value>, String> {
        let Some(mut message) = received.message else {
            return Ok(None);
        };
        let field = |name: &str| message.get(name).filter(|value| !value.is_null());
        if field("command").is_none() && field("cancel").is_none() {
            return Ok(None);
        }
        let id = message
            .get("id")
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("{surface}: view call has no integer id"))?;
        let cancel = field("cancel");
        if cancel.is_some_and(|cancel| *cancel != Value::Bool(true) || field("command").is_some()) {
            return Err(format!(
                "{surface}: view call {id} cancel must be true and name no command"
            ));
        }
        let command = match cancel {
            Some(_) => None,
            None => Some(
                field("command")
                    .and_then(Value::as_str)
                    .filter(|command| !command.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| format!("{surface}: view call {id} has an empty command"))?,
            ),
        };
        let plugin = self
            .lock()
            .get(surface)
            .map(|channel| channel.plugin.clone())
            .ok_or_else(|| {
                format!("{surface}: view channel message of a surface without a view")
            })?;
        let Some(command) = command else {
            return Ok(Some(json!({
                "surface": surface,
                "plugin": plugin,
                "id": id,
                "cancel": true,
            })));
        };
        // The cids of the cause of the call are forwarded only when the call has some.
        let cids = cause_cids_of(message.get("cids"))
            .map_err(|refusal| format!("{surface}: view call {id} {refusal}"))?;
        // The call is open until the main page answers it (docs/spec/native-surfaces.md#view-surfaces).
        if let Some(channel) = self.lock().get_mut(surface) {
            channel.calls.insert(id, command.clone());
        }
        let mut payload = json!({
            "surface": surface,
            "plugin": plugin,
            "id": id,
            "command": command,
        });
        // default: a call without params sends null to its command, as the call envelope has no params for it.
        payload["params"] = message
            .get_mut("params")
            .map(Value::take)
            .unwrap_or(Value::Null);
        if !cids.is_empty() {
            payload["cids"] = json!(cids);
        }
        // A call that goes to the main page is recorded at the debug level, so a call without its host.view.reply shows as a record
        // without a reply (docs/spec/logging.md).
        emit_host(
            Level::Debug,
            "host.view.call",
            json!({"plugin": plugin, "surface": surface, "id": id, "command": command}),
        );
        Ok(Some(payload))
    }

    /// Returns the declared-ui.snapshot payload of a snapshot of the view of surface, or None when the message is not one.
    /// A snapshot is {"event", "plugin", "status", "seq", "value", "skipped"} with an integer seq from 1 and a skipped
    /// count of 0 or more; a snapshot with an invalid field is an error (docs/spec/plugin-processes.md, rule 2 and
    /// messages and events). The host relays the snapshot and writes no event for it.
    pub fn snapshot(&self, surface: &str, value: &str) -> Result<Option<Value>, String> {
        let received: ViewReceived = serde_json::from_str(value)
            .map_err(|error| format!("{surface}: view message is not JSON: {error}"))?;
        self.snapshot_received(surface, received)
    }

    fn snapshot_received(
        &self,
        surface: &str,
        received: ViewReceived,
    ) -> Result<Option<Value>, String> {
        let Some(message) = received.message else {
            return Ok(None);
        };
        if message.get("event").and_then(Value::as_str) != Some(DECLARED_SNAPSHOT_MESSAGE) {
            return Ok(None);
        }
        let plugin = self
            .lock()
            .get(surface)
            .map(|channel| channel.plugin.clone())
            .ok_or_else(|| {
                format!("{surface}: view channel message of a surface without a view")
            })?;
        let named = message
            .get("plugin")
            .and_then(Value::as_str)
            .filter(|named| !named.is_empty())
            .ok_or_else(|| format!("{surface}: declared UI snapshot names no plugin"))?;
        if named != plugin {
            return Err(format!(
                "{surface}: declared UI snapshot names plugin {named:?}, want plugin {plugin:?}"
            ));
        }
        let status = message
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| !status.is_empty())
            .ok_or_else(|| format!("{surface}: declared UI snapshot has no status"))?;
        let seq = message
            .get("seq")
            .and_then(Value::as_u64)
            .filter(|seq| *seq >= 1)
            .ok_or_else(|| {
                format!("{surface}: declared UI snapshot of status {status:?} has no seq from 1")
            })?;
        let skipped = message
            .get("skipped")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                format!("{surface}: declared UI snapshot of status {status:?} has no skipped count")
            })?;
        // A value of null stays present: the receiver validates it like any other value (docs/spec/declared-ui.md).
        let value = message.get("value").ok_or_else(|| {
            format!("{surface}: declared UI snapshot of status {status:?} has no value")
        })?;
        Ok(Some(json!({
            "surface": surface,
            "plugin": plugin,
            "status": status,
            "seq": seq,
            "skipped": skipped,
            "value": value,
        })))
    }

    /// Records the navigation state of the view of surface. A navigation that starts after the last state clears the ready document
    /// of the view; the progress of a navigation keeps it, because the document that sent the ready message is still the one loading.
    pub fn state(&self, surface: &str, state: &str) -> Result<(), String> {
        let loaded: ViewState = serde_json::from_str(state)
            .map_err(|error| format!("{surface}: view state is not JSON: {error}"))?;
        let Some(navigations) = loaded.navigations else {
            return Err(format!("{surface}: view state has no navigations"));
        };
        let mut channels = self.lock();
        let Some(channel) = channels.get_mut(surface) else {
            return Ok(());
        };
        if navigations < channel.navigations {
            return Err(format!(
                "{surface}: view state counts {navigations} navigations, below the {} counted before",
                channel.navigations
            ));
        }
        if navigations > channel.navigations {
            channel.navigations = navigations;
            channel.document.clear();
        }
        Ok(())
    }

    /// Returns the error for a post to the view of surface that has no ready document.
    pub fn check_post(&self, surface: &str) -> Result<(), String> {
        match self.ready_document(surface) {
            Some(_) => Ok(()),
            None => Err(format!("{surface} has no ready document")),
        }
    }
}

/// The name of the view web view of a view surface. No composition region has an empty name, so the view cannot collide with a
/// region, and the view closes with the other documents of its surface.
const VIEW_NAME: &str = "";
/// The event name of a declared UI snapshot of a view (docs/spec/plugin-processes.md, messages and events).
/// The event name of a declared UI snapshot message that a view sends (docs/spec/plugin-host.md#declared-ui-snapshots).
pub const DECLARED_SNAPSHOT_MESSAGE: &str = "declared-ui.snapshot";
/// The window event that relays a declared UI snapshot to the main page. Tauri accepts only alphanumeric characters, '-', '/', ':' and
/// '_' in an event name, so the relay name is not the message name; the main page listens to this name.
pub const DECLARED_SNAPSHOT_WINDOW_EVENT: &str = "declared-ui-snapshot";

/// Creates the view web view of a view surface, with the view configuration (`view` is true), and loads soksak://<plugin>/<page>
/// into it. When the load does not succeed, the view is closed and the error is returned. create, load and close are the
/// platform operations, and they run on the main thread.
pub fn create_view(
    channel: &str,
    create: impl FnOnce(&str) -> Result<Handle, String>,
    load: impl FnOnce(Handle, &str) -> Result<bool, String>,
    close: impl FnOnce(Handle) -> Result<(), String>,
    plugin: &str,
    page: &str,
) -> Result<Handle, String> {
    let handle = create(channel)?;
    let address = format!("soksak://{plugin}/{page}");
    let reason = match load(handle, &address) {
        Ok(true) => return Ok(handle),
        Ok(false) => format!("view cannot load {address}"),
        Err(error) => error,
    };
    close(handle).map_err(|closing| format!("{reason}; closing the view: {closing}"))?;
    Err(reason)
}

fn register_view_source(
    origins: &DeclaredSourceOrigins,
    views: &ViewChannels,
    events: &DeclaredSourceEventStream,
    surface: &str,
    plugin: &str,
) -> Result<ViewOrigin, String> {
    let generation = origins.issue_view(surface)?;
    let origin = views.register_origin(surface, plugin, generation);
    if let Err(error) = events.send(
        "declared-ui-source-registered",
        crate::source_origins::declared_source_origin_event(plugin, Some(surface), generation),
    ) {
        views.forget_if_current(surface, &origin);
        origins.end_view(surface, generation);
        return Err(error);
    }
    Ok(origin)
}

fn retire_view_before_replacement(
    data: &WindowData,
    surface: &str,
    plugin: &str,
    origin: &ViewOrigin,
    before_process_ended: impl FnOnce(),
    replace: impl FnOnce(),
) {
    data.documents.views().forget_if_current(surface, origin);
    if data
        .declared_source_origins
        .end_view(surface, origin.generation)
        && let Err(error) = data.declared_source_events.send(
            "declared-ui-source-ended",
            crate::source_origins::declared_source_origin_event(
                plugin,
                Some(surface),
                origin.generation,
            ),
        )
    {
        log_error("view channel", error);
    }
    before_process_ended();
    let mut ended = view_process_ended_event(surface);
    ended["generation"] = json!(origin.generation);
    if let Err(error) = data
        .declared_source_events
        .send("view-process-ended", ended)
    {
        log_error("view channel", error);
    }
    replace();
}

/// Creates the view of a view surface when the surface has none, and places the view over the whole surface. Call it on the
/// main thread.
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_view(
    window: &Window,
    platform: &'static dyn platform::Platform,
    surface_handle: Handle,
    surface: &str,
    plugin: &str,
    page: &str,
    visible: bool,
    start: ViewStart,
) -> Result<(), String> {
    let data = window_data(window)?;
    if !visible {
        // A view that is not shown ends its presentation wait, because its presentation cannot come (presentation_wait.rs).
        end_surface_presentation_wait(window, surface, "hidden");
    }
    data.documents.lifecycle().track(
        surface,
        surface_handle,
        plugin,
        page,
        visible,
        start.clone(),
    );
    // A view that failed beyond the restart limit is not created again until its surface is removed (docs/spec/plugin-processes.md,
    // rule 5).
    if data.documents.lifecycle().is_stopped(surface) {
        return Ok(());
    }
    let key: Key = (surface.to_string(), VIEW_NAME.to_string());
    let handle = match data.documents.get(&key) {
        Ok(handle) => handle,
        Err(_) => {
            data.documents.reserve(&key)?;
            let origin = register_view_source(
                &data.declared_source_origins,
                data.documents.views(),
                &data.declared_source_events,
                surface,
                plugin,
            )?;
            let generation = origin.generation;
            match attach_view(
                window,
                platform,
                ViewAttachment {
                    surface,
                    surface_handle,
                    plugin,
                    page,
                    start,
                    origin: origin.clone(),
                },
            ) {
                Ok(handle) => {
                    if !data.documents.set(&key, handle) {
                        data.documents.views().forget_if_current(surface, &origin);
                        data.declared_source_origins.end_view(surface, generation);
                        emit_source_ended(window, plugin, surface, generation);
                        platform.close_document(handle)?;
                        return Err(format!(
                            "surface {surface:?} closed while its view was created"
                        ));
                    }
                    handle
                }
                Err(error) => {
                    data.documents.remove(&key)?;
                    data.documents.views().forget_if_current(surface, &origin);
                    data.declared_source_origins.end_view(surface, generation);
                    emit_source_ended(window, plugin, surface, generation);
                    return Err(error);
                }
            }
        }
    };
    platform.place_document(
        handle,
        platform::Insets {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        },
        visible,
    )
}

/// Creates the view configuration of a plugin page in the data directory and the installed folder of the plugin.
struct ViewAttachment<'a> {
    surface: &'a str,
    surface_handle: Handle,
    plugin: &'a str,
    page: &'a str,
    start: ViewStart,
    origin: ViewOrigin,
}

fn attach_view(
    window: &Window,
    platform: &'static dyn platform::Platform,
    attachment: ViewAttachment<'_>,
) -> Result<Handle, String> {
    let ViewAttachment {
        surface,
        surface_handle,
        plugin,
        page,
        start,
        origin,
    } = attachment;
    let config = crate::config_directory(window.app_handle()).map_err(|e| e.to_string())?;
    let directory = config.join(DOCUMENT_DATA);
    let directory = directory.to_str().ok_or_else(|| {
        format!(
            "document data directory is not UTF-8: {}",
            directory.display()
        )
    })?;
    let folder = crate::installed::plugin_folder(&config, plugin)?;
    let folder = folder
        .to_str()
        .ok_or_else(|| format!("plugin folder is not UTF-8: {}", folder.display()))?
        .to_string();
    let channel = VIEW_CHANNEL
        .get()
        .ok_or_else(|| "the view channel script is not loaded".to_string())?;
    let state_window = window.clone();
    let state_surface = surface.to_string();
    let state_origin = origin.clone();
    let message_window = window.clone();
    let message_surface = surface.to_string();
    let message_plugin = plugin.to_string();
    let message_origin = origin.clone();
    let ended_window = window.clone();
    let ended_surface = surface.to_string();
    let ended_plugin = plugin.to_string();
    let ended_origin = origin.clone();
    create_view(
        channel,
        |channel| {
            let document = platform.create_document(
                surface_handle,
                directory,
                &folder,
                plugin,
                Some(channel),
                Box::new(move |state: String| {
                    view_state(&state_window, &state_surface, &state_origin, &state)
                }),
            )?;
            // The receiver is set before the page loads, so the first message of the page reaches it.
            platform.set_view_message(
                document,
                Box::new(move |value: String| {
                    view_message(
                        &message_window,
                        platform,
                        &message_surface,
                        &message_plugin,
                        &message_origin,
                        document,
                        &value,
                    )
                }),
            )?;
            platform.set_view_ended(
                document,
                Box::new(move || {
                    if let Some(reason) =
                        view_callback_retired_reason(&ended_window, &ended_surface, &ended_origin)
                    {
                        record_view_message_cancelled(&ended_surface, reason);
                        return;
                    }
                    log_error(
                        "view channel",
                        format!("{ended_surface}: the view process ended"),
                    );
                    view_failed(
                        &ended_window,
                        platform,
                        &ended_surface,
                        &ended_plugin,
                        &ended_origin,
                        document,
                    );
                }),
            )?;
            let notice_window = window.clone();
            let notice_surface = surface.to_string();
            let notice_plugin = plugin.to_string();
            let notice_origin = origin.clone();
            platform.set_view_responsiveness(
                document,
                Box::new(move |responsive| {
                    if let Some(reason) = view_callback_retired_reason(
                        &notice_window,
                        &notice_surface,
                        &notice_origin,
                    ) {
                        record_view_message_cancelled(&notice_surface, reason);
                        return;
                    }
                    if !responsive {
                        end_presentation_wait_for_generation(
                            &notice_window,
                            &notice_surface,
                            notice_origin.generation,
                            "unresponsive",
                        );
                    }
                    let payload = view_responsiveness_notice(
                        &notice_surface,
                        &notice_plugin,
                        notice_origin.generation,
                        responsive,
                    );
                    if let Err(error) = crate::windows::emit_declared_source_event(
                        &notice_window,
                        "view-responsiveness",
                        payload,
                    ) {
                        log_error("view channel", error);
                    }
                }),
            )?;
            let theme = crate::theme::get(window)?;
            let theme = serde_json::to_value(&theme).map_err(|error| error.to_string())?;
            platform.add_document_script(document, &theme_script(&theme))?;
            platform.add_document_script(document, &surface_start_script(surface, &start)?)?;
            record_view_process_request(surface, plugin);
            Ok(document)
        },
        |document, url| platform.load_document(document, url),
        |document| platform.close_document(document),
        plugin,
        page,
    )
}

/// Records the navigation state of a view. A failure is written to the application log.
fn view_state(window: &Window, surface: &str, origin: &ViewOrigin, state: &str) {
    let Some(data) = window_data_if_registered(window) else {
        record_view_message_cancelled(surface, "window-closed");
        return;
    };
    if !data.documents.views().is_current(surface, origin) {
        record_view_message_cancelled(surface, "retired-origin");
        return;
    }
    if let Err(error) = data.documents.views().state(surface, state) {
        log_error("view channel", error);
    }
}

/// Dispatches a message of the sok-view handler of the view document of surface. The ready message makes the view receive the current
/// theme. A failure is written to the application log, and a queue overflow of the view ends its failure (view_failed).
fn view_message(
    window: &Window,
    platform: &'static dyn Platform,
    surface: &str,
    plugin: &str,
    origin: &ViewOrigin,
    document: Handle,
    value: &str,
) {
    let data = match window_data(window) {
        Ok(data) => data,
        Err(_) => {
            if let Some(error) = retired_view_error(surface, value) {
                report_retired_view_error(plugin, surface, error);
            }
            record_view_message_cancelled(surface, "window-closed");
            return;
        }
    };
    if !accept_view_message(data.documents.views(), plugin, surface, origin, value) {
        return;
    }
    let ready = match data.documents.views().dispatch(surface, value) {
        Ok(ViewDispatch::Reply(payload)) => {
            let payload = tag_view_generation(payload, origin.generation);
            if let Err(error) =
                crate::windows::emit_declared_source_event(window, "view-reply", payload)
            {
                log_error("view channel", error);
            }
            return;
        }
        Ok(ViewDispatch::Call(payload)) => {
            let payload = tag_view_generation(payload, origin.generation);
            if let Err(error) =
                crate::windows::emit_declared_source_event(window, "view-call", payload)
            {
                log_error("view channel", error);
            }
            return;
        }
        Ok(ViewDispatch::Snapshot(payload)) => {
            let payload = tag_view_generation(payload, origin.generation);
            if let Err(error) = crate::windows::emit_declared_source_event(
                window,
                DECLARED_SNAPSHOT_WINDOW_EVENT,
                payload,
            ) {
                log_error("view channel", error);
            }
            return;
        }
        Ok(ViewDispatch::Ready(ready)) => ready,
        Err(error) => {
            log_error("view channel", error);
            return;
        }
    };
    match ready {
        Ok(true) => {
            let first = match window_data(window) {
                Ok(data) => data.documents.views().first_ready(surface),
                Err(error) => {
                    log_error("view channel", error);
                    None
                }
            };
            if let Some(plugin) = first {
                record_view_process_ready(surface, &plugin);
            }
            if let Err(error) = post_theme(window, surface) {
                log_error("view channel", error);
            }
        }
        Ok(false) => {}
        Err(error) => {
            let overflow = is_queue_full(&error);
            log_error("view channel", error);
            if overflow {
                view_failed(window, platform, surface, plugin, origin, document);
            }
        }
    }
}

/// Handles the failure of the view document of surface: its process ended, or its message queue overflowed. The view is closed, and it
/// is created again unless the failure stops the restarts (docs/spec/plugin-processes.md, rule 5). A document that is not the current
/// view of the surface was already replaced, so its failure is not counted again.
fn view_failed(
    window: &Window,
    platform: &'static dyn Platform,
    surface: &str,
    plugin: &str,
    origin: &ViewOrigin,
    document: Handle,
) {
    let data = match window_data(window) {
        Ok(data) => data,
        Err(_) => {
            record_view_message_cancelled(surface, "window-closed");
            return;
        }
    };
    if !data.documents.views().is_current(surface, origin) {
        record_view_message_cancelled(surface, "retired-origin");
        return;
    }
    let key: Key = (surface.to_string(), VIEW_NAME.to_string());
    // default: a surface without this view, or with another view handle, means that the failure belongs to a view that was already
    // closed or replaced, so the failure is not counted again.
    match data.documents.get(&key) {
        Ok(current) if current == document => {}
        _ => return,
    }
    // The view ends here, whether its process ended or its queue overflowed (docs/spec/logging.md#principles).
    data.documents.lifecycle().record_end(surface);
    // The open calls are taken before the view is removed, because the removal drops the channel of the view.
    let open_calls = data.documents.views().end_calls(surface);
    retire_view_before_replacement(
        &data,
        surface,
        plugin,
        origin,
        || {
            end_presentation_wait_for_generation(
                window,
                surface,
                origin.generation,
                "process-ended",
            )
        },
        || {
            // The page forgets the regions that the host closed with the ended view (docs/spec/native-surfaces.md#view-surfaces).
            if let Err(error) = data.documents.remove(&key) {
                return log_error("view channel", error);
            }
            for (plugin, command) in &open_calls {
                record_view_call_peer_lost(plugin, command);
            }
            log_failure("view channel", platform.close_document(document));
            // The regions of the view belong to the composition of the ended document, so they close with it, and the view that is created
            // again attaches them again (docs/spec/native-surfaces.md#view-surfaces, regions).
            let (region_documents, region_images) =
                remove_view_regions(&data.documents, &data.streams, &data.images, surface);
            let regions_closed = !region_documents.is_empty() || !region_images.is_empty();
            for handle in region_documents {
                log_failure("view channel", platform.close_document(handle));
            }
            for handle in region_images {
                log_failure("view channel", platform.close_image(handle));
            }
            if regions_closed {
                exposure::window_changed(window);
            }
            let record = data.documents.lifecycle().spec(surface);
            if !data.documents.lifecycle().fail(surface, Instant::now()) {
                log_error("view channel", format!("{surface}: {}", view_stop_reason()));
                let Some(spec) = record else {
                    return log_error(
                        "view channel",
                        format!(
                            "{surface}: the view record is missing, so the view-stopped event is not sent"
                        ),
                    );
                };
                if let Err(error) = crate::windows::emit_declared_source_event(
                    window,
                    "view-stopped",
                    view_stopped_event(surface, &spec.plugin),
                ) {
                    log_error("view channel", error);
                }
                return;
            }
            let Some(spec) = record else {
                return log_error(
                    "view channel",
                    format!(
                        "{surface}: the view record is missing, so the view is not created again"
                    ),
                );
            };
            if let Err(error) = sync_view(
                window,
                platform,
                spec.surface_handle,
                surface,
                &spec.plugin,
                &spec.page,
                spec.visible,
                spec.start,
            ) {
                log_error("view channel", error);
            }
        },
    );
}

fn emit_source_ended(window: &Window, plugin: &str, surface: &str, generation: u64) {
    if let Err(error) = crate::windows::emit_declared_source_event(
        window,
        "declared-ui-source-ended",
        crate::source_origins::declared_source_origin_event(plugin, Some(surface), generation),
    ) {
        log_error("view channel", error);
    }
}

fn tag_view_generation(mut payload: Value, generation: u64) -> Value {
    payload["generation"] = json!(generation);
    payload
}

/// Posts message to the native document of handle and returns whether the document accepted it. The native post touches a WebKit
/// web view, which only the main thread may use, so the post runs as the task that dispatch runs on the main thread.
pub(crate) fn post_document_via(
    dispatch: impl FnOnce(Box<dyn FnOnce() -> Result<bool, String> + Send>) -> Result<bool, String>,
    handle: Handle,
    message: String,
) -> Result<bool, String> {
    dispatch(Box::new(move || {
        platform::current()?.post_document(handle, &message)
    }))
}

/// Posts the current theme to the ready document of the view of surface, with the field sok 1.
fn post_theme(window: &Window, surface: &str) -> Result<(), String> {
    let theme = crate::theme::get(window)?;
    let data = window_data(window)?;
    let handle = data
        .documents
        .get(&(surface.to_string(), VIEW_NAME.to_string()))?;
    let message = theme_message(&serde_json::to_value(&theme).map_err(|error| error.to_string())?)
        .to_string();
    if post_document_via(|task| on_main(window, task), handle, message)? {
        Ok(())
    } else {
        Err(format!("{surface}: the view document refused the message"))
    }
}

/// Posts the reply of the main page to the view of reply.surface. The main page must be the caller, and the view must have a
/// ready document, as for the theme (docs/spec/native-surfaces.md#view-surfaces).
/// Posts a command request of the main page to the view of request.surface (docs/spec/native-surfaces.md#view-surfaces).
pub(crate) fn view_request(webview: &Webview, request: ViewRequest) -> Result<Value, String> {
    let message = view_request_message(&request)?;
    let posted = post_for_view_generation(
        webview,
        "view request",
        &request.surface,
        request.generation,
        message,
    )?;
    Ok(view_request_disposition(request.generation, posted))
}

fn view_request_disposition(generation: u64, posted: bool) -> Value {
    if posted {
        Value::Null
    } else {
        json!({"cancelled": true, "sourceGeneration": generation})
    }
}

pub(crate) fn view_reply(webview: &Webview, reply: ViewReply) -> Result<(), String> {
    let message = view_reply_message(&reply)?;
    let window = webview.window();
    let window_name = window.label().to_string();
    dispatch_view_reply(
        &reply,
        &window_name,
        || {
            post_for_view_generation(
                webview,
                "view reply",
                &reply.surface,
                reply.generation,
                message,
            )
        },
        || {
            window_data(&window)?.documents.views().answer_call(
                &reply.surface,
                reply.generation,
                reply.id,
            );
            Ok(())
        },
    )
}

fn dispatch_view_reply(
    reply: &ViewReply,
    window: &str,
    post: impl FnOnce() -> Result<bool, String>,
    answer: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let posted = post()?;
    let mut fields = json!({
        "window": window,
        "page": reply.page,
        "surface": reply.surface,
        "generation": reply.generation,
        "id": reply.id,
        "outcome": if reply.error.is_some() { "error" } else { "result" },
        "disposition": if posted { "posted" } else { "discarded" },
    });
    if !posted {
        fields["reason"] = json!("view-generation-not-current");
    }
    emit_host(Level::Debug, "host.view.reply.dispatch", fields);
    if posted {
        answer()?;
    }
    Ok(())
}

/// Posts the event of a subscription to the view of event.surface. The main page must be the caller, and the view must have a ready
/// document, as for a reply (docs/spec/native-surfaces.md#view-surfaces).
pub(crate) fn view_event(webview: &Webview, event: ViewEventRequest) -> Result<bool, String> {
    let message = view_event_message(&event)?;
    post_for_view_generation(
        webview,
        "view event",
        &event.surface,
        event.generation,
        message,
    )
}

/// Posts only while the exact native view generation is current. The check and post run in one main-thread task.
fn post_for_view_generation(
    webview: &Webview,
    action: &str,
    surface: &str,
    generation: u64,
    message: Value,
) -> Result<bool, String> {
    let window = webview.window();
    exposure::authorize_main_caller(webview.label(), window.label(), action)?;
    let message = message.to_string();
    let surface = surface.to_string();
    let task_window = window.clone();
    on_main(&window, move || {
        let data = window_data(&task_window)?;
        crate::plugin_host_channel::post_if_generation_current(
            generation,
            data.declared_source_origins.current_view(&surface),
            || data.documents.views().generation(&surface) == Some(generation),
            || {
                data.documents.views().check_post(&surface)?;
                let handle = data
                    .documents
                    .get(&(surface.clone(), VIEW_NAME.to_string()))?;
                let accepted = platform::current()?.post_document(handle, &message)?;
                if accepted {
                    Ok(true)
                } else {
                    Err(format!("{surface}: the view document refused the message"))
                }
            },
        )
    })
}

/// Posts the current theme to each view of the window that has a ready document. A view without one is skipped, because the theme
/// reaches it with its ready message.
pub(crate) fn post_theme_to_views(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    for surface in data.documents.views().surfaces() {
        if data.documents.views().ready_document(&surface).is_none() {
            continue;
        }
        if let Err(error) = post_theme(window, &surface) {
            log_error("view channel", error);
        }
    }
    Ok(())
}

/// Checks the surface id of the calling webview and returns the key and the window of the request.
fn owner(webview: &Webview, request: &Request) -> Result<(Key, Window), String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(webview.label(), window.label(), "surface operations")?;
    let key = check(Some(request.surface.as_str()), request)?;
    Ok((key, window))
}

/// Creates a hidden document region inside a surface. It is an error when the same name already exists.
pub(crate) fn attach(webview: &Webview, request: Request) -> Result<(), String> {
    let (key, window) = owner(webview, &request)?;
    let platform = platform::current()?;
    let restore = request.restore_state()?.map(str::to_string);
    let data = window_data(&window)?;
    require_region(&data.compositions, &key.0, &key.1, "document", None)?;
    // The name is taken first. The lock is not held while waiting for native work.
    data.documents.reserve(&key)?;
    let handle = match create(
        webview,
        &window,
        &key,
        platform,
        data.overlay.dialog(),
        restore,
    ) {
        Ok(handle) => handle,
        Err(error) => {
            drop(data.documents.remove(&key));
            return Err(error);
        }
    };
    // When the surface was removed during creation, the created document is closed. The registration and the close
    // happen in one task of the main thread.
    let registry = data.clone();
    let stored = key.clone();
    let registered = on_main(&window, move || {
        if registry.documents.set(&stored, handle) {
            return Ok(true);
        }
        platform.close_document(handle)?;
        Ok(false)
    })?;
    if !registered {
        return Err(format!(
            "surface {:?} closed while its document was created",
            key.0
        ));
    }
    Ok(())
}

/// Creates a document webview inside the surface webview and returns its address.
fn create(
    webview: &Webview,
    window: &Window,
    key: &Key,
    platform: &'static dyn platform::Platform,
    dialog: bool,
    restore: Option<String>,
) -> Result<Handle, String> {
    with_view(webview, move |view| platform.view_id(view))?;
    let host = window.clone();
    let (surface_id, name) = key.clone();
    let state_host = host.clone();
    let state_surface = surface_id.clone();
    let state_document = name.clone();
    on_main(window, move || {
        let changed = Box::new(move |state: String| {
            let state = match serde_json::from_str(&state) {
                Ok(state) => state,
                Err(error) => {
                    log_error(
                        "document-state",
                        format!("the state is not JSON: {error}: {state}"),
                    );
                    return;
                }
            };
            let payload = State {
                surface: state_surface.clone(),
                document: state_document.clone(),
                state,
            };
            if let Err(error) = emit_window(&state_host, "document-state", payload) {
                log_error("document-state", error);
            }
            exposure::window_changed(&state_host);
        });
        let surface = surface_handle(&host, &surface_id)?;
        let directory = crate::config_directory(host.app_handle())
            .map_err(|e| e.to_string())?
            .join(DOCUMENT_DATA);
        let directory = directory.to_str().ok_or_else(|| {
            format!(
                "document data directory is not UTF-8: {}",
                directory.display()
            )
        })?;
        let plugin = window_data(&host)?
            .surface_plugins
            .lock()
            // default: a lock that a panicking thread poisoned still holds the surface plugins, which are only read;
            // the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .get(&surface_id)
            .cloned()
            .ok_or_else(|| format!("surface {surface_id:?} has no composition declaration"))?;
        let config = crate::config_directory(host.app_handle()).map_err(|e| e.to_string())?;
        let folder = crate::installed::plugin_folder(&config, &plugin)?;
        let folder = folder
            .to_str()
            .ok_or_else(|| format!("plugin folder is not UTF-8: {}", folder.display()))?
            .to_string();
        let handle =
            platform.create_document(surface, directory, &folder, &plugin, None, changed)?;
        // The history is restored before anything else uses the new region, so it loads the restored entry first.
        if let Some(state) = &restore
            && let Err(refusal) = platform.restore_document(handle, state)
        {
            platform.close_document(handle)?;
            return Err(format!("document {name}: {refusal}"));
        }
        let dark = crate::theme::is_dark(&host)?;
        platform.set_document_appearance(handle, dark)?;
        platform.set_document_background(handle, dialog)?;
        let message_host = host.clone();
        let message_surface = surface_id.clone();
        let message_document = name.clone();
        platform.set_document_message(
            handle,
            Box::new(move |value| {
                let place = format!("document message {message_document}");
                match document_message(&message_surface, &message_document, &value) {
                    Ok(Message::Forward(payload)) => {
                        if let Err(error) = emit_window(&message_host, "document-message", payload)
                        {
                            log_error(&place, error);
                        }
                    }
                    Ok(Message::Failure(reason)) => log_error(&place, reason),
                    Err(error) => log_error(&place, error),
                }
            }),
        )?;
        let stream_host = host.clone();
        let stream_key = (surface_id.clone(), name.clone());
        platform.set_document_stream(
            handle,
            Box::new(move |value| deliver_stream(&stream_host, platform, &stream_key, &value)),
        )?;
        let event_host = host.clone();
        let event_surface = surface_id.clone();
        let event_document = name.clone();
        platform.set_document_event(
            handle,
            Box::new(move |value| {
                let event = match serde_json::from_str(&value) {
                    Ok(event) => event,
                    Err(error) => {
                        log_error(
                            "document-event",
                            format!("the event is not JSON: {error}: {value}"),
                        );
                        return;
                    }
                };
                if let Err(error) = emit_window(
                    &event_host,
                    "document-event",
                    Event {
                        surface: event_surface.clone(),
                        document: event_document.clone(),
                        event,
                    },
                ) {
                    log_error("document-event", error);
                }
                exposure::window_changed(&event_host);
            }),
        )?;
        Ok(handle)
    })
}

/// Runs work on the main thread for an open document region.
fn with_document<T: Send + 'static>(
    webview: &Webview,
    request: &Request,
    work: impl FnOnce(Handle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (key, window) = owner(webview, request)?;
    let data = window_data(&window)?;
    require_region(&data.compositions, &key.0, &key.1, "document", None)?;
    // The lookup and the use happen in one task of the main thread. A close also happens on the main thread together
    // with the unregistration, so the looked-up address is not released during this task.
    on_main(&window, move || work(data.documents.get(&key)?))
}

/// Sends a JSON message to the current plugin document of a region.
pub(crate) fn post(webview: &Webview, request: Request) -> Result<(), String> {
    let platform = platform::current()?;
    let message = request
        .message
        .clone()
        .ok_or("documentPost requires a JSON message")?
        .to_string();
    let name = request.document.clone();
    with_document(webview, &request, move |handle| {
        if platform.post_document(handle, &message)? {
            Ok(())
        } else {
            Err(format!("document {name} shows no plugin document"))
        }
    })
}

pub(crate) fn load(webview: &Webview, request: Request) -> Result<(), String> {
    let platform = platform::current()?;
    let url = request.url.clone();
    with_document(webview, &request, move |handle| {
        if platform.load_document(handle, &url)? {
            Ok(())
        } else {
            Err(format!(
                "only http, https, file, and sok addresses can be opened: {url:?}"
            ))
        }
    })
}

/// Sets the page zoom of a document as the text scale.
pub(crate) fn zoom(webview: &Webview, request: Request) -> Result<(), String> {
    let platform = platform::current()?;
    let zoom = request.zoom_factor()?;
    with_document(webview, &request, move |handle| {
        if platform.zoom_document(handle, zoom)? {
            Ok(())
        } else {
            Err(format!("document zoom {zoom} was rejected"))
        }
    })
}

/// Asks a document region for its media, capture and form state (docs/spec/plugins.md#memory-saver). The reply of native
/// arrives later on the main thread, and this call waits for it outside the main thread.
pub(crate) fn query(webview: &Webview, request: Request) -> Result<Report, String> {
    let platform = platform::current()?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    with_document(webview, &request, move |handle| {
        platform.query_document(
            handle,
            Box::new(move |reply| {
                if sender.send(reply).is_err() {
                    log_error("document query", "the caller stopped waiting for the reply");
                }
            }),
        )
    })?;
    let reply = receiver
        .recv()
        .map_err(|_| format!("document {} gave no query reply", request.document))?;
    parse_report(&request.document, &reply)
}

/// Returns the interactionState of a document region as base64, empty when the web view yields none.
pub(crate) fn interaction_state(webview: &Webview, request: Request) -> Result<String, String> {
    let platform = platform::current()?;
    let name = request.document.clone();
    with_document(webview, &request, move |handle| {
        platform
            .document_interaction_state(handle)?
            .ok_or_else(|| format!("document {name} is closed"))
    })
}

/// The action number and the distance of a go request. entry needs a nonzero offset, and the other actions take no
/// offset.
pub fn go_action(request: &Request) -> Result<(i32, i32), String> {
    let action = match request.action.as_str() {
        "back" => 0,
        "forward" => 1,
        "reload" => 2,
        "stop" => 3,
        "entry" => 4,
        other => return Err(format!("unknown document action {other:?}")),
    };
    match (action, request.offset) {
        (4, Some(offset)) if offset != 0 => Ok((action, offset)),
        (4, _) => Err("document action entry requires a non-zero offset".into()),
        (_, Some(_)) => Err(format!(
            "document action {:?} does not take an offset",
            request.action
        )),
        (_, None) => Ok((action, 0)),
    }
}

/// Runs history navigation, opening a history entry, reload and stop, and returns whether it ran.
pub(crate) fn go(webview: &Webview, request: Request) -> Result<bool, String> {
    let platform = platform::current()?;
    let (action, offset) = go_action(&request)?;
    with_document(webview, &request, move |handle| {
        platform.go_document(handle, action, offset)
    })
}

pub(crate) fn detach(webview: &Webview, request: Request) -> Result<(), String> {
    let (key, window) = owner(webview, &request)?;
    let data = window_data(&window)?;
    require_region(&data.compositions, &key.0, &key.1, "document", None)?;
    let platform = platform::current()?;
    // The unregistration and the close happen in one task of the main thread.
    on_main(&window, move || {
        let handle = data.documents.remove(&key)?;
        if handle != 0 {
            platform.close_document(handle)?;
        }
        // The closed region has no native stream left to turn off, so its effects are not applied.
        data.streams.remove_region(&key);
        Ok(())
    })?;
    exposure::window_changed(&window);
    Ok(())
}

/// Ends the subscriptions of a surface whose page loaded a new document, and removes its document regions. The regions
/// close with the page, so their stream effects are not applied. It returns the handles of the regions for the caller to
/// close.
pub fn remove_surface_for_reload(
    documents: &Documents,
    streams: &Streams,
    surface: &str,
) -> Vec<Handle> {
    // The view of the surface closes with its documents (docs/spec/logging.md#principles).
    documents.lifecycle().record_end(surface);
    documents.views().forget(surface);
    streams.remove_surface(surface);
    documents.remove_surface(surface)
}

/// Removes the document and image regions of a view surface whose view process ended, after the view itself was removed, and
/// returns their handles for the caller to close. The regions belong to the composition of the ended document, so the view that
/// is created again attaches them again (docs/spec/native-surfaces.md#view-surfaces, regions). The image generation of the
/// surface advances, so a frame of a closed region is stale.
pub fn remove_view_regions(
    documents: &Documents,
    streams: &Streams,
    images: &crate::images::Images,
    surface: &str,
) -> (Vec<Handle>, Vec<Handle>) {
    // The regions close with the ended document, so their stream effects are not applied.
    streams.remove_surface(surface);
    let closed_documents = documents.remove_surface(surface);
    images.begin_generation(surface);
    (closed_documents, images.remove_surface(surface))
}

/// Ends every subscription of the main page of a window whose web content process ended, and turns off the streams that
/// lose their last subscriber in the regions that remain until the page reloads. Each failed turn-off is logged with the
/// name of its document.
pub(crate) fn main_page_process_ended(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    let platform = platform::current()?;
    for effect in data.streams.remove_page() {
        log_failure(
            &format!("document stream {}", effect.key.1),
            apply_effects(platform, &data.documents, std::slice::from_ref(&effect)),
        );
    }
    Ok(())
}

/// Closes every document region of a surface. It does not wait for main-thread work, so it can be called from any
/// thread.
pub(crate) fn close_surface(window: &Window, surface: &str) {
    let Ok(data) = window_data(window) else {
        return;
    };
    let platform = match platform::current() {
        Ok(platform) => platform,
        Err(error) => return log_error("document close", error),
    };
    // A view of the surface ends with it (docs/spec/logging.md#principles).
    data.documents.lifecycle().record_end(surface);
    data.documents.lifecycle().forget(surface);
    let host = window.clone();
    let surface = surface.to_string();
    // The unregistration and the close happen in one task of the main thread. Other work that uses a document also
    // looks it up on the main thread, so a released address is not used.
    log_failure(
        "document close",
        window
            .run_on_main_thread(move || {
                end_surface_presentation_wait(&host, &surface, "hidden");
                data.documents.presentation().forget_surface(&surface);
                if let Some(generation) = data.declared_source_origins.current_view(&surface)
                    && let Some(plugin) = data
                        .documents
                        .views()
                        .forget_generation(&surface, generation)
                    && data.declared_source_origins.end_view(&surface, generation)
                {
                    emit_source_ended(&host, &plugin, &surface, generation);
                }
                // The regions close with the surface, so their stream effects are not applied.
                data.streams.remove_surface(&surface);
                let handles = data.documents.remove_surface(&surface);
                if handles.is_empty() {
                    return;
                }
                for handle in handles {
                    log_failure("document close", platform.close_document(handle));
                }
                exposure::window_changed(&host);
            })
            .map_err(|e| e.to_string()),
    );
}

/// Dims the document regions while a dialog is open. It does not wait.
pub(crate) fn set_background(window: &Window, enabled: bool) {
    let Ok(data) = window_data(window) else {
        return;
    };
    let platform = match platform::current() {
        Ok(platform) => platform,
        Err(error) => return log_error("document background", error),
    };
    // The document address is looked up on the main thread. It is the same thread as the close, so a released address
    // is not used.
    log_failure(
        "document background",
        window
            .run_on_main_thread(move || {
                for handle in data.documents.all() {
                    log_failure(
                        "document background",
                        platform.set_document_background(handle, enabled),
                    );
                }
            })
            .map_err(|e| e.to_string()),
    );
}

/// Sends a stream event to the window. The page of the surface receives only the events of its own surface.
fn emit_stream_event(
    window: &Window,
    key: &Key,
    stream: &str,
    handle: u64,
    message: Value,
) -> Result<(), String> {
    emit_window(
        window,
        "document-stream",
        StreamEvent {
            surface: key.0.clone(),
            document: key.1.clone(),
            stream: stream.to_string(),
            handle,
            message,
        },
    )
    .map_err(|error| error.to_string())
}

/// Applies the effects to the native documents. It fails with the name of the stream that native refused.
fn apply_effects(
    platform: &dyn Platform,
    documents: &Documents,
    effects: &[StreamEffect],
) -> Result<(), String> {
    for effect in effects {
        let document = documents.get(&effect.key)?;
        if !platform.set_document_stream_on(document, &effect.stream, effect.on)? {
            return Err(format!(
                "document {:?} does not accept stream {:?}",
                effect.key.1, effect.stream
            ));
        }
    }
    Ok(())
}

/// Delivers a stream message of a document region to the subscriptions of its stream, and acknowledges a snapshot to native after the
/// delivery. It runs on the main thread.
fn deliver_stream(window: &Window, platform: &'static dyn Platform, key: &Key, value: &str) {
    let place = format!("document stream {}", key.1);
    let data = match window_data(window) {
        Ok(data) => data,
        Err(error) => return log_error(&place, error),
    };
    let result = match data.streams.deliver(key, value) {
        Ok(result) => result,
        Err(error) => return log_error(&place, error),
    };
    for delivery in result.deliveries {
        if let Err(error) = emit_stream_event(
            window,
            key,
            &delivery.stream,
            delivery.handle,
            delivery.message,
        ) {
            log_error(&place, error);
        }
    }
    if !result.ack {
        return;
    }
    let outcome = data
        .documents
        .get(key)
        .and_then(|handle| platform.ack_document_stream(handle, result.seq));
    match outcome {
        Ok(true) => {}
        Ok(false) => log_error(&place, stream_ack_refusal(key, ELEMENTS, result.seq)),
        Err(error) => log_error(&place, error),
    }
}

/// Subscribes to a stream of a document region and returns the handle. The first message of a requests subscription is the request log,
/// and the subscription receives it before native turns the stream on.
pub(crate) fn subscribe(webview: &Webview, request: Request) -> Result<Subscription, String> {
    let (key, window) = owner(webview, &request)?;
    check_stream(&request.stream)?;
    let data = window_data(&window)?;
    require_region(&data.compositions, &key.0, &key.1, "document", None)?;
    let platform = platform::current()?;
    let stream = request.stream.clone();
    let host = window.clone();
    let handle = on_main(&window, move || {
        data.documents.get(&key)?;
        let (handle, effects, initial) = data.streams.subscribe(&key, &stream)?;
        if let Some(message) = initial {
            emit_stream_event(&host, &key, &stream, handle, message)?;
        }
        if let Err(error) = apply_effects(platform, &data.documents, &effects) {
            data.streams.abandon(handle);
            return Err(error);
        }
        Ok(handle)
    })?;
    Ok(Subscription { handle })
}

/// Ends a subscription of a document region. The last removal of a stream turns its collection off.
pub(crate) fn unsubscribe(webview: &Webview, request: Request) -> Result<(), String> {
    let (key, window) = owner(webview, &request)?;
    let handle = request
        .handle
        .ok_or_else(|| "document stream unsubscribe requires a handle".to_string())?;
    let data = window_data(&window)?;
    require_region(&data.compositions, &key.0, &key.1, "document", None)?;
    let platform = platform::current()?;
    on_main(&window, move || {
        let effects = data.streams.unsubscribe(&key, handle)?;
        apply_effects(platform, &data.documents, &effects)
    })
}

/// Reads a field whose value is a JSON value from the map of a view message. A null value is kept as Value::Null, because it is a value
/// (docs/spec/native-surfaces.md#view-surfaces). An absent field is None, which the caller refuses or defaults.
pub(crate) fn value_field<'de, A: MapAccess<'de>>(map: &mut A) -> Result<Option<Value>, A::Error> {
    map.next_value::<Value>().map(Some)
}

/// A reply of the main page to a call request of a view: a result or an error (docs/spec/native-surfaces.md#view-surfaces). A null
/// result is the result of a command without a value, so it is kept as a value.
pub struct ViewReply {
    pub page: String,
    pub surface: String,
    pub generation: u64,
    pub id: u64,
    pub result: Option<Value>,
    pub error: Option<ViewReplyError>,
}

impl<'de> Deserialize<'de> for ViewReply {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = ViewReply;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a view reply")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut surface = None;
                let mut page = None;
                let mut generation = None;
                let mut id = None;
                let mut result = None;
                let mut error = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "page" => page = map.next_value::<Option<String>>()?,
                        "surface" => surface = map.next_value::<Option<String>>()?,
                        "generation" => generation = map.next_value::<Option<u64>>()?,
                        "id" => id = map.next_value::<Option<u64>>()?,
                        "result" => result = value_field(&mut map)?,
                        "error" => error = map.next_value::<Option<ViewReplyError>>()?,
                        _ => {
                            map.next_value::<de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(ViewReply {
                    page: page.ok_or_else(|| de::Error::missing_field("page"))?,
                    surface: surface.ok_or_else(|| de::Error::missing_field("surface"))?,
                    generation: generation.ok_or_else(|| de::Error::missing_field("generation"))?,
                    id: id.ok_or_else(|| de::Error::missing_field("id"))?,
                    result,
                    error,
                })
            }
        }
        deserializer.deserialize_map(Fields)
    }
}

/// The error of a view reply, with the code and the message of the call envelope.
#[derive(Deserialize, Debug, PartialEq)]
pub struct ViewReplyError {
    pub code: i64,
    pub message: String,
}

/// An event that the main page pushes to the view of surface: its name and its data (docs/spec/native-surfaces.md#view-surfaces).
/// A null data is a value; an absent data is None and is refused.
pub struct ViewEventRequest {
    pub surface: String,
    pub generation: u64,
    pub event: String,
    pub data: Option<Value>,
}

impl<'de> Deserialize<'de> for ViewEventRequest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = ViewEventRequest;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a view event")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut surface = None;
                let mut generation = None;
                let mut event = None;
                let mut data = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "surface" => surface = map.next_value::<Option<String>>()?,
                        "generation" => generation = map.next_value::<Option<u64>>()?,
                        "event" => event = map.next_value::<Option<String>>()?,
                        "data" => data = value_field(&mut map)?,
                        _ => {
                            map.next_value::<de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(ViewEventRequest {
                    surface: surface.ok_or_else(|| de::Error::missing_field("surface"))?,
                    generation: generation.ok_or_else(|| de::Error::missing_field("generation"))?,
                    event: event.ok_or_else(|| de::Error::missing_field("event"))?,
                    data,
                })
            }
        }
        deserializer.deserialize_map(Fields)
    }
}

/// A command request that the main page sends to the view of surface: the command, its id, its params and the correlation identifiers
/// of its cause, which are empty when the cause has none (docs/spec/native-surfaces.md#view-surfaces).
pub struct ViewRequest {
    pub surface: String,
    pub generation: u64,
    pub id: u64,
    pub command: String,
    pub params: Option<Value>,
    pub cids: Vec<String>,
}

impl<'de> Deserialize<'de> for ViewRequest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = ViewRequest;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a view request")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut surface = None;
                let mut generation = None;
                let mut id = None;
                let mut command = None;
                let mut params = None;
                let mut cids = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "surface" => surface = map.next_value::<Option<String>>()?,
                        "generation" => generation = map.next_value::<Option<u64>>()?,
                        "id" => id = map.next_value::<Option<u64>>()?,
                        "command" => command = map.next_value::<Option<String>>()?,
                        "params" => params = value_field(&mut map)?,
                        "cids" => cids = map.next_value::<Option<Vec<String>>>()?,
                        _ => {
                            map.next_value::<de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(ViewRequest {
                    surface: surface.ok_or_else(|| de::Error::missing_field("surface"))?,
                    generation: generation.ok_or_else(|| de::Error::missing_field("generation"))?,
                    id: id.ok_or_else(|| de::Error::missing_field("id"))?,
                    command: command.ok_or_else(|| de::Error::missing_field("command"))?,
                    params,
                    // default: an absent cids member is an empty list, and a null member counts as absent (docs/spec/native-host.md).
                    cids: cids.unwrap_or_default(),
                })
            }
        }
        deserializer.deserialize_map(Fields)
    }
}

/// Returns the host message of a command request: {"sok", "id", "command", "params"}, with the member "cids" when the request has
/// cids. A request has an id and a command, and a request without params carries null. A cids list that a log line cannot hold is
/// refused (docs/spec/logging.md#correlation).
pub fn view_request_message(request: &ViewRequest) -> Result<Value, String> {
    if request.generation == 0 {
        return Err("view request has no source generation".to_string());
    }
    crate::source_origins::validate_declared_source_generation_limit(
        request.generation,
        "view request",
    )?;
    if request.id == 0 {
        return Err("view request has no id".to_string());
    }
    if request.command.is_empty() {
        return Err(format!("view request {} has an empty command", request.id));
    }
    if !valid_cause_cids(&request.cids) {
        return Err(format!(
            "view request {} cids must be non-empty strings without a quote, a backslash or a control character",
            request.id
        ));
    }
    let mut message = json!({
        "sok": 1,
        "id": request.id,
        "command": request.command,
        "params": request.params,
    });
    if !request.cids.is_empty() {
        message["cids"] = json!(request.cids);
    }
    Ok(message)
}

/// Returns the cids member of a view message: none for an absent member, otherwise the list, whose identifiers must all be
/// non-empty strings without a quote, a backslash or a control character (docs/spec/logging.md#correlation). A null member is
/// refused like any other non-list, because the spec defines only an omitted list.
fn cause_cids_of(value: Option<&Value>) -> Result<Vec<String>, String> {
    const REFUSAL: &str =
        "cids must be non-empty strings without a quote, a backslash or a control character";
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    match serde_json::from_value::<Vec<String>>(value.clone()) {
        Ok(cids) if valid_cause_cids(&cids) => Ok(cids),
        Ok(_) | Err(_) => Err(REFUSAL.to_string()),
    }
}

/// Reports whether every identifier is a non-empty string without a quote, a backslash or a control character, which a log line holds.
fn valid_cause_cids(cids: &[String]) -> bool {
    cids.iter().all(|cid| {
        !cid.is_empty()
            && !cid
                .chars()
                .any(|c| c == '"' || c == '\\' || c < ' ' || c == '\u{7f}')
    })
}

/// Returns the theme message of a view: {"sok", "event": "theme", "data": theme}, as every event carries its value in data.
pub fn theme_message(theme: &Value) -> Value {
    json!({"sok": 1, "event": "theme", "data": theme})
}

/// Returns the host message of an event push: {"sok", "event", "data"}. An empty name and an absent data are errors.
pub fn view_event_message(event: &ViewEventRequest) -> Result<Value, String> {
    if event.generation == 0 {
        return Err("view event has no source generation".to_string());
    }
    crate::source_origins::validate_declared_source_generation_limit(
        event.generation,
        "view event",
    )?;
    if event.event.is_empty() {
        return Err("view event has an empty event name".to_string());
    }
    let Some(data) = &event.data else {
        return Err(format!("view event {} has no data", event.event));
    };
    Ok(json!({"sok": 1, "event": event.event, "data": data}))
}

/// Returns the message that the host posts to the view for a reply: {"sok", "id", "result"} or {"sok", "id", "error"}.
pub fn view_reply_message(reply: &ViewReply) -> Result<Value, String> {
    if reply.page.is_empty() {
        return Err("view reply names no page".to_string());
    }
    if reply.generation == 0 {
        return Err("view reply has no source generation".to_string());
    }
    crate::source_origins::validate_declared_source_generation_limit(
        reply.generation,
        "view reply",
    )?;
    match (&reply.result, &reply.error) {
        (None, None) => Err(format!(
            "view reply {} has neither a result nor an error",
            reply.id
        )),
        (Some(_), Some(_)) => Err(format!(
            "view reply {} has both a result and an error",
            reply.id
        )),
        (None, Some(error)) if error.message.is_empty() => Err(format!(
            "view reply {} has an error without a message",
            reply.id
        )),
        (None, Some(error)) => Ok(json!({
            "sok": 1,
            "id": reply.id,
            "error": {"code": error.code, "message": error.message}
        })),
        (Some(result), None) => Ok(json!({"sok": 1, "id": reply.id, "result": result})),
    }
}

/// Records a responsiveness notice of the view of surface: it writes the trace event of the notice and returns the payload of the
/// view-responsiveness event that the window receives. The notice ends no call of the view (docs/spec/native-surfaces.md#view-surfaces).
pub fn view_responsiveness_notice(
    surface: &str,
    plugin: &str,
    generation: u64,
    responsive: bool,
) -> Value {
    let fields = json!({"plugin": plugin, "surface": surface});
    if responsive {
        emit_host(Level::Debug, "host.trace.view.responsive", fields);
    } else {
        emit_host(Level::Debug, "host.trace.view.unresponsive", fields);
    }
    json!({"surface": surface, "plugin": plugin, "generation": generation, "responsive": responsive})
}

/// Writes host.trace.view.process-request for the view of surface that is created.
pub fn record_view_process_request(surface: &str, plugin: &str) {
    emit_host(
        Level::Debug,
        "host.trace.view.process-request",
        json!({"plugin": plugin, "surface": surface}),
    );
}

/// Writes host.trace.view.process-ready for the view of surface whose first ready message arrived.
pub fn record_view_process_ready(surface: &str, plugin: &str) {
    emit_host(
        Level::Debug,
        "host.trace.view.process-ready",
        json!({"plugin": plugin, "surface": surface}),
    );
}

#[cfg(test)]
#[path = "view_responsiveness_test.rs"]
mod tests;

/// The document-start script that sets window.sokTheme to the frozen theme value {scheme, tokens}, which the first page script of a
/// view reads (docs/spec/native-surfaces.md#view-surfaces).
pub fn theme_script(theme: &Value) -> String {
    format!("window.sokTheme = Object.freeze({theme});")
}

/// The document-start script that sets window.sokSurface to the frozen start values of the view of surface, which the first page
/// script of the view reads (docs/spec/native-surfaces.md#view-surfaces). A value that the surface has none of is carried as JSON
/// null, except the origin, which must be present and of its form; a missing or malformed origin is refused.
pub fn surface_start_script(surface: &str, start: &ViewStart) -> Result<String, String> {
    let params = start
        .params
        .as_ref()
        .map_or_else(|| "null".to_string(), |value| value.to_string());
    let directory = view_origin_directory(surface, start.origin.as_ref())?.map_or_else(
        || "null".to_string(),
        |directory| Value::String(directory).to_string(),
    );
    let project = start.project.as_ref().map_or_else(
        || "null".to_string(),
        |project| {
            let id = Value::String(project.id.clone());
            let root = Value::String(project.root.clone());
            format!("Object.freeze({{\"id\":{id},\"root\":{root}}})")
        },
    );
    let declarations = start
        .declarations
        .as_ref()
        .map_or_else(|| "{}".to_string(), |value| value.to_string());
    let id = Value::String(surface.to_string());
    Ok(format!(
        "window.sokSurface = Object.freeze({{\"surface\":{id},\"params\":{params},\"origin\":Object.freeze({{\"directory\":{directory}}}),\"project\":{project},\"declarations\":Object.freeze({declarations})}});"
    ))
}

#[cfg(test)]
#[path = "view_theme_test.rs"]
mod theme_tests;

#[cfg(test)]
#[path = "view_start_test.rs"]
mod start_tests;

/// Writes host.call.peer-lost {plugin, command, reason: process-ended} for a view call that was open when its view process ended
/// (docs/spec/native-surfaces.md#view-surfaces).
pub fn record_view_call_peer_lost(plugin: &str, command: &str) {
    emit_host(
        Level::Error,
        "host.call.peer-lost",
        json!({"plugin": plugin, "command": command, "reason": "process-ended"}),
    );
}

#[cfg(test)]
#[path = "view_call_peer_test.rs"]
mod call_peer_tests;

/// Takes the bytes that the binary store of the document name of surface keeps under id, through take, and releases the id. A
/// document that is not attached gives the error `document "<name>" is not attached`, the text of the other document operations, and
/// the error text of the native take is passed on unchanged (docs/spec/native-surfaces.md#document-regions).
/// The caller must satisfy the thread precondition of the supplied native take operation.
pub fn take_document_binary_of(
    documents: &Documents,
    surface: &str,
    name: &str,
    id: &str,
    take: impl FnOnce(Handle, &str) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    let handle = documents.get(&(surface.to_string(), name.to_string()))?;
    take(handle, id)
}

#[cfg(test)]
#[path = "document_binary_take_test.rs"]
mod binary_take_tests;

/// Ends the presentation wait of the view of surface with reason, and writes the failure of the end to the application log.
/// Joins each changed visible root placement to the open layout transaction of window with ticket
/// (docs/spec/plugin-processes.md, rule 6). A surface without a view document has no presentation to wait for, so it is skipped.
pub(crate) fn join_shown_views(
    window: &Window,
    platform: &'static dyn Platform,
    ticket: u64,
    placements: &[Placement],
) -> Result<(), String> {
    let data = window_data(window)?;
    for placement in placements {
        let surface = placement.id.as_str();
        if !placement.visible {
            end_surface_presentation_wait(window, surface, "hidden");
            continue;
        }
        if data.documents.lifecycle().spec(surface).is_none() {
            continue;
        }
        let Some(generation) = data.documents.views().generation(surface) else {
            continue;
        };
        let view_placement = ViewPlacement {
            frame: [placement.x, placement.y, placement.w, placement.h],
            visible: placement.visible,
        };
        if !data
            .documents
            .presentation()
            .needs_join(surface, generation, view_placement)
        {
            continue;
        }
        let key: Key = (surface.to_string(), VIEW_NAME.to_string());
        let Ok(view) = data.documents.get(&key) else {
            continue;
        };
        if !data
            .documents
            .presentation()
            .begin(surface, generation, ticket)
        {
            return Err(format!(
                "view {surface} generation {generation} already waits for layout ticket {ticket}"
            ));
        }
        let presented_window = window.clone();
        let presented_surface = surface.to_string();
        let presented: Box<dyn FnOnce() + Send> = Box::new(move || {
            let ended = platform::current().and_then(|platform| {
                platform.enqueue_ui(Box::new(move || {
                    end_ticket_presentation_wait(
                        &presented_window,
                        &presented_surface,
                        generation,
                        ticket,
                        "presented",
                    )
                }))
            });
            if let Err(error) = ended {
                log_error("view channel", error);
            }
        });
        let joined = with_native_owner(window, move |owner| {
            platform.join_view(owner, ticket, view, presented)
        });
        match joined {
            Ok(Some(abandon)) => {
                data.documents
                    .presentation()
                    .attach_abandon(surface, generation, ticket, abandon);
            }
            Ok(None) => data
                .documents
                .presentation()
                .remove_unjoined(surface, generation, ticket),
            Err(error) => {
                data.documents
                    .presentation()
                    .remove_unjoined(surface, generation, ticket);
                return Err(error.to_string());
            }
        };
    }
    Ok(())
}

/// Ends every presentation join for a view generation and reports each abandoned layout ticket.
fn end_presentation_wait_for_generation(
    window: &Window,
    surface: &str,
    generation: u64,
    reason: &str,
) {
    let result = window_data(window).and_then(|data| {
        data.documents
            .presentation()
            .end_generation(surface, generation, reason)
            .map(|ended| ended.len())
            .map_err(|error| error.to_string())
    });
    report_ended_presentation_waits(window, surface, reason, result);
}

/// Ends every presentation join for a hidden or closed surface.
fn end_surface_presentation_wait(window: &Window, surface: &str, reason: &str) {
    let result = window_data(window).and_then(|data| {
        data.documents
            .presentation()
            .end_surface(surface, reason)
            .map(|ended| ended.len())
            .map_err(|error| error.to_string())
    });
    report_ended_presentation_waits(window, surface, reason, result);
}

/// Ends only the join identified by its surface, view generation and layout ticket.
fn end_ticket_presentation_wait(
    window: &Window,
    surface: &str,
    generation: u64,
    ticket: u64,
    reason: &str,
) {
    let result = window_data(window).and_then(|data| {
        data.documents
            .presentation()
            .end(surface, generation, ticket, reason)
            .map(|ended| usize::from(ended))
            .map_err(|error| error.to_string())
    });
    report_ended_presentation_waits(window, surface, reason, result);
}

fn report_ended_presentation_waits(
    window: &Window,
    surface: &str,
    reason: &str,
    result: Result<usize, String>,
) {
    match result {
        Ok(ended) if reason != "presented" => {
            for _ in 0..ended {
                let payload = presentation_abandoned_payload(surface, reason);
                if let Err(error) = emit_window(window, "view-presentation-abandoned", payload) {
                    log_error("view channel", error);
                }
            }
        }
        Ok(_) => {}
        Err(error) => log_error("view channel", error),
    }
}

/// Abandons the joins of a canceled ticket after removing its waits, so late callbacks cannot affect a later ticket.
pub(crate) fn abandon_layout_presentation_waits(
    window: &Window,
    ticket: u64,
) -> Result<(), String> {
    let Ok(data) = window_data(window) else {
        return Ok(());
    };
    data.documents.presentation().abandon_ticket(ticket)
}

/// Removes all presentation waits before the owner-wide layout cancellation of a window reload.
pub(crate) fn abandon_all_layout_presentation_waits(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    data.documents.presentation().abandon_all()
}

#[cfg(test)]
#[path = "view_origin_test.rs"]
mod view_origin_tests;

#[cfg(test)]
#[path = "../tests/declared_source_origins/view_generation_test.rs"]
mod view_generation_tests;

#[cfg(test)]
#[path = "../tests/documents/view_decode_test.rs"]
mod view_decode_tests;
