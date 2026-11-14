//! The JSON-RPC 2.0 server of the local endpoint.
//!
//! Each message is a 4-byte big-endian length followed by one JSON object of that length. A message that exceeds the
//! length limit, malformed JSON, a value that is not a JSON-RPC 2.0 object, or an undeclared method closes the
//! connection without a response. Requests run on their own threads and responses are told apart by `id`. [`Service`]
//! handles windows and pages, and this file handles the transport, the `window` parameter, the watch list of each
//! connection and the notifications. The transport is provided by `platform/<os>/endpoint.*`. The format is defined in
//! docs/spec/endpoint.md.

#[cfg(test)]
#[path = "endpoint_response_test.rs"]
mod response_tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, TryLockError};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};

use crate::application_log::{log_error, log_info};
use crate::bounds::ENDPOINT_TOPIC_CHANGES;
use crate::buffer_bounds::record_buffer_drop;
use crate::endpoint_record::Call;
use crate::platform::{self, Listener};

pub use crate::platform::Connection;

/// The maximum length of a message body.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

/// Invalid parameters.
pub const INVALID_PARAMS: i64 = -32602;
/// An undeclared name.
pub const UNKNOWN_NAME: i64 = 1001;
/// A name that is declared but not registered.
pub const NOT_REGISTERED: i64 = 1002;
/// There is no window or owner document.
pub const MISSING_DOCUMENT: i64 = 1003;
/// Native input cannot be delivered on this platform.
pub const NO_INPUT: i64 = 1004;
/// The owner document did not respond within the time limit.
pub const TIMED_OUT: i64 = 1005;
/// The window is not active. A pointer move needs the key window.
pub const NOT_ACTIVE: i64 = 1006;
/// AppKit reports a pressed mouse button, so a synthetic press or release was not delivered.
pub const BUTTON_HELD: i64 = 1007;
/// The press of that button of the pointer is still open, so the press was not delivered.
pub const PRESS_OPEN: i64 = 1008;
/// An open press of another pointer would share the state that the input changes, so the input was not delivered.
pub const POINTER_HELD: i64 = 1011;
/// A registered command or state handler failed.
pub const HANDLER_FAILED: i64 = -32000;

/// The methods that every build declares.
const METHODS: &[&str] = &[
    "windows.list",
    "log.query",
    "exposure.list",
    "status.get",
    "status.watch",
    "status.unwatch",
    "command.run",
    "element.rect",
    "element.act",
    "input.pointer",
    "input.key",
    "input.text",
    "input.dialog.answer",
];

/// The subscription methods that turn the diagnostic record on and off. They exist only in diagnostic builds.
#[cfg(feature = "diagnostics")]
const TRANSCRIPT: &str = "diagnostics.transcript";

/// The methods that only a diagnostic build declares.
#[cfg(feature = "diagnostics")]
const DIAGNOSTICS: &[&str] = &[
    "diagnostics.fixture",
    "diagnostics.clock",
    "diagnostics.drag",
    "diagnostics.layout.trace",
    "diagnostics.capture.start",
    "diagnostics.capture.stop",
    "diagnostics.capture.still",
    "diagnostics.modal.hold",
    "diagnostics.modal.held",
    "diagnostics.presentation.failure",
    "diagnostics.window.draw-covered",
    "diagnostics.input.source",
    "diagnostics.input.reference",
    "diagnostics.log.flush",
    "diagnostics.host.relaunch",
    "diagnostics.test.mark",
    "diagnostics.stall.dump",
    "diagnostics.notifications",
    "diagnostics.page.collect",
    "diagnostics.native.objects",
    "diagnostics.native.window-color-space",
    "diagnostics.document.viewport-marker",
    "diagnostics.objects",
    "diagnostics.process.exit",
    "diagnostics.memory.pressure",
    "diagnostics.page.request",
    "diagnostics.page.calls",
    "diagnostics.host.events",
    "diagnostics.surface.hold",
    "diagnostics.surface.held",
    "diagnostics.layout.fail",
    TRANSCRIPT,
];
#[cfg(not(feature = "diagnostics"))]
const DIAGNOSTICS: &[&str] = &[];

/// The code and message of a JSON-RPC error response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Failure {
    pub code: i64,
    pub message: String,
}

/// Error 1003 for a window that does not exist.
pub fn missing_window(window: &str) -> Failure {
    Failure::new(
        MISSING_DOCUMENT,
        format!("window {window:?} does not exist"),
    )
}

impl Failure {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The invalid parameters error.
    pub fn params(message: impl Into<String>) -> Self {
        Self::new(INVALID_PARAMS, message)
    }
}

/// Uses a value that the host created as the response text. A value that the page sent is relayed as the received text.
pub fn raw(value: &Value) -> Result<Box<RawValue>, Failure> {
    serde_json::value::to_raw_value(value).map_err(|error| Failure::new(-32603, error.to_string()))
}

/// The transport outcome of one endpoint response, distinct from its command result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReplyOutcome {
    Written,
    NoResponse,
    WriteFailed(String),
    Abandoned,
}

type ReplyCallback = Box<dyn FnOnce(ReplyOutcome) + Send + 'static>;
type ConnectionEndCallback = Box<dyn FnOnce() + Send + 'static>;
#[derive(Default)]
struct ReplyState {
    outcome: Option<ReplyOutcome>,
    callbacks: Vec<ReplyCallback>,
    connection: ConnectionEnd,
    /// The watches of the connection end that this request holds while its response is not complete
    /// (ReplyScope::after_connection_end); the completion of the response drops them.
    connection_watches: Vec<ConnectionWatch>,
}

/// The end of one endpoint connection. A request that waits follows it: no answer reaches a closed connection, so the end of
/// the connection ends such a wait, and a request that opened a diagnostic hold registers the end of the hold here
/// (docs/spec/endpoint.md).
#[derive(Clone, Default)]
pub struct ConnectionEnd(Arc<Mutex<ConnectionEndState>>);

#[derive(Default)]
struct ConnectionEndState {
    closed: bool,
    next: u64,
    watches: HashMap<u64, ConnectionEndCallback>,
    callbacks: Vec<ConnectionEndCallback>,
}

impl ConnectionEnd {
    /// The end of a connection that is open.
    pub fn open() -> Self {
        Self::default()
    }

    /// Closes the connection. Its watches run under the lock, so a watch that its request drops returns after a run of it:
    /// an end of waits that ran late would end the waits of a later request; a watch takes no lock of this connection. Then
    /// each callback of on_close runs once, outside the lock. A later close does nothing.
    pub fn close(&self) {
        let callbacks = {
            // default: a lock that a panicking thread poisoned still holds the watches and callbacks of the end, which the
            // close takes once; the panic hook records the panic.
            let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            state.closed = true;
            for (_, on_end) in std::mem::take(&mut state.watches) {
                on_end();
            }
            std::mem::take(&mut state.callbacks)
        };
        for callback in callbacks {
            callback();
        }
    }

    /// Runs on_end when the connection closes before the returned watch is dropped; on a connection that already closed it
    /// runs on_end at once.
    pub fn watch(&self, on_end: impl FnOnce() + Send + 'static) -> ConnectionWatch {
        {
            // default: a lock that a panicking thread poisoned still holds the watches of the connection, which the
            // registration extends; the panic hook records the panic.
            let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            if !state.closed {
                let id = state.next;
                state.next += 1;
                state.watches.insert(id, Box::new(on_end));
                return ConnectionWatch {
                    end: self.clone(),
                    id: Some(id),
                };
            }
        }
        on_end();
        ConnectionWatch {
            end: self.clone(),
            id: None,
        }
    }

    /// Runs callback when the connection closes, or at once when it is already closed.
    pub fn on_close(&self, callback: impl FnOnce() + Send + 'static) {
        {
            // default: a lock that a panicking thread poisoned still holds the callbacks of the end, which the
            // registration extends; the panic hook records the panic.
            let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            if !state.closed {
                state.callbacks.push(Box::new(callback));
                return;
            }
        }
        callback();
    }

    /// Whether other is the end of the same connection.
    pub fn is(&self, other: &ConnectionEnd) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// A watch of ConnectionEnd::watch; dropping it ends the watch.
pub struct ConnectionWatch {
    end: ConnectionEnd,
    id: Option<u64>,
}

impl Drop for ConnectionWatch {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            // default: a lock that a panicking thread poisoned still holds the watches of the connection, from which
            // this watch is removed; the panic hook records the panic.
            let mut state = self.end.0.lock().unwrap_or_else(PoisonError::into_inner);
            state.watches.remove(&id);
        }
    }
}

/// Owned context for work that must follow this request's response attempt.
/// Cloning or dropping the context does not complete the response.
#[derive(Clone)]
pub struct ReplyScope(Arc<Mutex<ReplyState>>);

impl ReplyScope {
    /// The scope of a request of the connection whose end is connection.
    pub(crate) fn pending_on(connection: ConnectionEnd) -> (Self, ReplyCompletion) {
        let scope = Self(Arc::new(Mutex::new(ReplyState {
            connection,
            ..ReplyState::default()
        })));
        let completion = ReplyCompletion {
            scope: scope.clone(),
            finished: false,
        };
        (scope, completion)
    }

    /// The end of the connection of this request.
    pub fn connection_end(&self) -> ConnectionEnd {
        self.0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the state of the reply, from which the
            // connection end is read; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .connection
            .clone()
    }

    /// Runs callback once when the endpoint connection of the request ends before the response completes. A connection
    /// that already ended runs it at once; a complete response drops it. A scope of no connection never runs it.
    pub fn after_connection_end(&self, callback: impl FnOnce() + Send + 'static) {
        let connection = {
            // default: a lock that a panicking thread poisoned still holds the state of the reply, which the
            // registration reads; the panic hook records the panic.
            let state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            if state.outcome.is_some() {
                return;
            }
            state.connection.clone()
        };
        // The watch runs callback at once on a connection that ended, so it is made outside the lock of the reply.
        let watch = connection.watch(callback);
        // default: a lock that a panicking thread poisoned still holds the state of the reply, which the registration
        // extends; the panic hook records the panic.
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if state.outcome.is_none() {
            state.connection_watches.push(watch);
            return;
        }
        // A response that completed meanwhile drops the watch, outside the lock of the reply, since the end of the
        // connection runs its watches under its own lock.
        drop(state);
        drop(watch);
    }

    /// Runs once after response completion, outside the scope and connection writer locks.
    /// Registration after completion runs immediately with the retained transport outcome.
    pub fn after_response(&self, callback: impl FnOnce(ReplyOutcome) + Send + 'static) {
        let outcome = {
            // default: a lock that a panicking thread poisoned still holds the outcome and callbacks of the reply,
            // which the registration reads or extends; the panic hook records the panic.
            let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            match &state.outcome {
                Some(outcome) => outcome.clone(),
                None => {
                    state.callbacks.push(Box::new(callback));
                    return;
                }
            }
        };
        callback(outcome);
    }
}

/// The answer side of a reply scope: finishing it completes the response once, and dropping it unfinished abandons it.
pub(crate) struct ReplyCompletion {
    scope: ReplyScope,
    finished: bool,
}

impl ReplyCompletion {
    pub(crate) fn finish(&mut self, outcome: ReplyOutcome) -> bool {
        if self.finished {
            return false;
        }
        self.finished = true;
        let watches;
        let callbacks = {
            // default: a lock that a panicking thread poisoned still holds the callbacks of the reply, which the
            // completion takes once; the panic hook records the panic.
            let mut state = self.scope.0.lock().unwrap_or_else(PoisonError::into_inner);
            state.outcome = Some(outcome.clone());
            // The work that the end of the connection would end is over with the response.
            watches = std::mem::take(&mut state.connection_watches);
            std::mem::take(&mut state.callbacks)
        };
        // The watches go outside the lock of the reply, since the end of the connection runs them under its own lock.
        drop(watches);
        for callback in callbacks {
            callback(outcome.clone());
        }
        true
    }
}

impl Drop for ReplyCompletion {
    fn drop(&mut self) {
        self.finish(ReplyOutcome::Abandoned);
    }
}

/// Runs endpoint requests in windows and pages.
pub trait Service: Send + Sync + 'static {
    /// Returns the result of `windows.list`.
    fn windows(&self) -> Result<Value, Failure>;
    /// Returns whether the window with the window identifier window exists.
    fn exists(&self, window: &str) -> bool;
    /// Runs method in the window window. params does not hold `window`. The call waits until the response is ready. The
    /// result is the JSON text for the response, and a value that the page sent is the received text.
    /// reply is the owned external request context; internal watch maintenance has no response context.
    fn call(
        &self,
        window: &str,
        method: &str,
        params: Map<String, Value>,
        reply: Option<ReplyScope>,
    ) -> Result<Box<RawValue>, Failure>;
    /// Called when the last connection stops watching the status name of the window window without a surface
    /// specification, after the change that ended the watch is queued.
    fn unwatched(&self, window: &str, name: &str);
}

/// One watch. surface is the surface that the watch specified, and a watch that specified one differs from a watch that
/// did not.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Watch {
    pub window: String,
    pub name: String,
    pub surface: Option<String>,
}

impl Watch {
    /// The params of the watch request to send to the page.
    pub fn params(&self) -> Map<String, Value> {
        let mut params = Map::new();
        params.insert("name".into(), Value::String(self.name.clone()));
        if let Some(surface) = &self.surface {
            params.insert("surface".into(), Value::String(surface.clone()));
        }
        params
    }
}

/// The write target and the watch list of one connection. changes is the sequence number of the change that was last
/// received for each subscription.
struct Peer {
    writer: Arc<Mutex<Box<dyn Connection>>>,
    watches: HashSet<Watch>,
    #[cfg(feature = "diagnostics")]
    transcript: HashSet<String>,
    changes: HashMap<Topic, u64>,
}

/// The target that a connection subscribes to. The subscription changes sent to the page run in the order received for
/// each target.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Topic {
    Status(Watch),
    /// The diagnostic record of a window. It exists only in diagnostic builds.
    #[cfg(feature = "diagnostics")]
    Transcript(String),
}

impl Topic {
    /// The name of the target in the messages about it.
    fn name(&self) -> &str {
        match self {
            Topic::Status(watch) => &watch.name,
            #[cfg(feature = "diagnostics")]
            Topic::Transcript(_) => TRANSCRIPT,
        }
    }

    fn window(&self) -> &str {
        match self {
            Topic::Status(watch) => &watch.window,
            #[cfg(feature = "diagnostics")]
            Topic::Transcript(window) => window,
        }
    }

    /// The start or stop request to send to the page.
    fn request(&self, on: bool) -> (&'static str, Map<String, Value>) {
        match self {
            Topic::Status(watch) => (
                if on { "status.watch" } else { "status.unwatch" },
                watch.params(),
            ),
            #[cfg(feature = "diagnostics")]
            Topic::Transcript(_) => {
                let mut params = Map::new();
                params.insert("on".into(), Value::Bool(on));
                (TRANSCRIPT, params)
            }
        }
    }

    fn held(&self, peer: &Peer) -> bool {
        match self {
            Topic::Status(watch) => peer.watches.contains(watch),
            #[cfg(feature = "diagnostics")]
            Topic::Transcript(window) => peer.transcript.contains(window),
        }
    }

    fn set(&self, peer: &mut Peer, on: bool) {
        match (self, on) {
            (Topic::Status(watch), true) => {
                peer.watches.insert(watch.clone());
            }
            (Topic::Status(watch), false) => {
                peer.watches.remove(watch);
            }
            #[cfg(feature = "diagnostics")]
            (Topic::Transcript(window), true) => {
                peer.transcript.insert(window.clone());
            }
            #[cfg(feature = "diagnostics")]
            (Topic::Transcript(window), false) => {
                peer.transcript.remove(window);
            }
        }
    }
}

/// The target to which the response of a request is written.
struct Answer {
    writer: Arc<Mutex<Box<dyn Connection>>>,
    id: Option<Value>,
    call: Call,
    completion: ReplyCompletion,
}

/// A success response. result is written as the received text.
#[derive(Serialize)]
struct Success<'a> {
    jsonrpc: &'static str,
    id: &'a Value,
    result: &'a RawValue,
}

impl Answer {
    fn send(mut self, outcome: Result<Box<RawValue>, Failure>) {
        // The event is stored before the reply is written, so a client that has its reply finds the event after a flush.
        self.call.record(&outcome);
        let Some(id) = self.id else {
            self.completion.finish(ReplyOutcome::NoResponse);
            return;
        };
        let written = {
            // default: a lock that a panicking thread poisoned still holds the connection of the client, which the
            // reply is written to; the panic hook records the panic.
            let mut writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
            match outcome {
                Ok(result) => write_to_peer(
                    &mut *writer,
                    &Success {
                        jsonrpc: "2.0",
                        id: &id,
                        result: &result,
                    },
                ),
                Err(failure) => write_to_peer(
                    &mut *writer,
                    &json!({"jsonrpc": "2.0", "id": id,
                    "error": {"code": failure.code, "message": failure.message}}),
                ),
            }
        };
        let completion = match written {
            Ok(()) => ReplyOutcome::Written,
            Err(Unsent::PeerClosed) => {
                log_info("endpoint", format!("reply to {id} not sent: peer closed"));
                ReplyOutcome::WriteFailed(String::from("peer closed"))
            }
            Err(Unsent::Failed(error)) => {
                log_error("endpoint reply", error.clone());
                ReplyOutcome::WriteFailed(error)
            }
        };
        self.completion.finish(completion);
    }
}

/// One subscription change. last shows that no connection subscribes to this target after a stop change.
struct Change {
    peer: u64,
    order: u64,
    on: bool,
    last: bool,
    answer: Option<Answer>,
}

/// The pending changes of one target. page shows whether the page follows this target.
#[derive(Default)]
struct Line {
    changes: VecDeque<Change>,
    running: bool,
    page: bool,
}

/// The pointer and button of a press in its window: each pointer holds its own presses (docs/spec/exposure.md#named-pointers).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct PressKey {
    window: String,
    pointer: String,
    /// 0 left, 1 right.
    button: i32,
}

/// An open press: the connection whose `down` delivered it, the point of its last delivered `down` or `drag`, and the click
/// count of its `down`.
#[derive(Clone, Debug)]
struct Press {
    peer: u64,
    x: f64,
    y: f64,
    clicks: i32,
}

/// The release of a press that waits for the event that lifts its refusal: `BUTTON_HELD` waits for `host.buttons` mask 0 and
/// `POINTER_HELD` for the next end of a press.
struct Release {
    key: PressKey,
    press: Press,
    code: i64,
}

/// The open presses of the endpoint and the releases that wait (docs/spec/exposure.md#methods).
#[derive(Default)]
struct Presses {
    open: HashMap<PressKey, Press>,
    waiting: Vec<Release>,
    /// The number of events that lifted each refusal, `BUTTON_HELD` first and `POINTER_HELD` second, so a release that was
    /// refused while such an event came is delivered again at once instead of waiting for the next one.
    lifts: [u64; 2],
}

/// The place of the refusal code in `Presses::lifts`.
fn lift_index(code: i64) -> usize {
    usize::from(code == POINTER_HELD)
}

struct Shared {
    service: Arc<dyn Service>,
    peers: Mutex<HashMap<u64, Peer>>,
    lines: Mutex<HashMap<Topic, Line>>,
    /// The open presses, which a delivered `input.pointer` changes. A lock of it is taken after the lock of `peers` when both
    /// are held.
    presses: Mutex<Presses>,
    next: AtomicU64,
    orders: AtomicU64,
    /// Whether the endpoint stopped and started to close the connections. It distinguishes the reason for closing a
    /// connection.
    stopping: AtomicBool,
    /// The configuration folder, whose event files the method `log.query` reads.
    config: PathBuf,
    /// Whether the endpoint holds the connection activity of the platform (`hold_connection_activity`). It changes only
    /// while the lock of `peers` is held.
    activity: AtomicBool,
}

/// Sends a notification to the connections. After the endpoint stops there is no connection to send to.
#[derive(Clone)]
pub struct Notifier(Arc<Shared>);

impl Notifier {
    /// Returns the number of subscriptions to the notifications of window: each connection counts once for each of its
    /// watches of the window (a name, with or without a surface).
    #[cfg(feature = "diagnostics")]
    pub fn subscribers(&self, window: &str) -> usize {
        self.0
            .peers
            .lock()
            // default: a lock that a panicking thread poisoned still holds the connections of the endpoint, which are
            // only read; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .flat_map(|peer| peer.watches.iter())
            .filter(|watch| watch.window == window)
            .count()
    }

    /// Returns whether a connection watches name of the window window without a surface specification.
    pub fn watched(&self, window: &str, name: &str) -> bool {
        watched(
            &self.0,
            &Watch {
                window: window.into(),
                name: name.into(),
                surface: None,
            },
        )
    }

    /// Sends `status.changed` for each window to the connections that watch the state name, which is not bound to a
    /// window, without a surface specification.
    pub fn notify_watchers(&self, name: &str, value: &RawValue) {
        let mut windows: Vec<String> = self
            .0
            .peers
            .lock()
            // default: a lock that a panicking thread poisoned still holds the peers and their watches, which are only
            // read; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .flat_map(|peer| peer.watches.iter())
            .filter(|watch| watch.name == name && watch.surface.is_none())
            .map(|watch| watch.window.clone())
            .collect();
        windows.sort();
        windows.dedup();
        for window in windows {
            self.changed(&window, name, None, value);
        }
        // A mask 0 lifts the refusal 1007 of the releases that wait for it.
        if name == "host.buttons"
            && serde_json::from_str::<Value>(value.get())
                .is_ok_and(|buttons| buttons["mask"] == json!(0))
        {
            release_waiting(&self.0, BUTTON_HELD);
        }
    }

    /// Ends the watches whose producer ended: with `surface`, the watches of that surface of the window window, which end when
    /// the surface closes or its document is replaced; without it, every watch of the window, which ends when the window
    /// closes. Each connection that holds such a watch receives one `status.ended {window, name, surface?, reason}` after the
    /// `status.changed` that it received before, and the watch is removed without a `status.unwatch` to the page, so a later
    /// `status.watch` of it starts anew (docs/spec/exposure.md#methods). The diagnostic record is no watch and stays. The watches
    /// end in this call, so no later `status.changed` reaches them; a write of the endpoint can wait for a connection, so the
    /// main thread that closes a window or a surface hands the notifications to their own routine.
    pub fn ended(&self, window: &str, surface: Option<&str>, reason: &str) {
        let ends = |watch: &Watch| {
            watch.window == window && (surface.is_none() || watch.surface.as_deref() == surface)
        };
        let mut notices = Vec::new();
        {
            // default: a lock that a panicking thread poisoned still holds the peers and the lines, which the end of
            // the watches updates together; the panic hook records the panic.
            let mut peers = self.0.peers.lock().unwrap_or_else(PoisonError::into_inner);
            // default: a lock that a panicking thread poisoned still holds the lines, which the end orders with the
            // peers; the panic hook records the panic.
            let mut lines = self.0.lines.lock().unwrap_or_else(PoisonError::into_inner);
            for state in peers.values_mut() {
                let mut watches: Vec<Watch> = state
                    .watches
                    .iter()
                    .filter(|watch| ends(watch))
                    .cloned()
                    .collect();
                if watches.is_empty() {
                    continue;
                }
                watches.sort();
                for watch in &watches {
                    state.watches.remove(watch);
                    // A start of this watch that the page refuses later finds no change of this connection to revert.
                    state.changes.remove(&Topic::Status(watch.clone()));
                }
                notices.push((state.writer.clone(), watches));
            }
            lines.retain(|topic, line| match topic {
                Topic::Status(watch) if ends(watch) => {
                    // The page that followed the value ended with its producer, so the next start goes to the page again.
                    line.page = false;
                    line.running || !line.changes.is_empty()
                }
                _ => true,
            });
        }
        #[derive(Serialize)]
        struct Params<'a> {
            window: &'a str,
            name: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            surface: Option<&'a str>,
            reason: &'a str,
        }
        #[derive(Serialize)]
        struct Notification<'a> {
            jsonrpc: &'static str,
            method: &'static str,
            params: Params<'a>,
        }
        if notices.is_empty() {
            return;
        }
        let reason = reason.to_string();
        crate::routine::spawn_named("endpoint-ended", move || {
            for (writer, watches) in notices {
                // default: a lock that a panicking thread poisoned still holds the connection, which is written as
                // before; the panic hook records the panic.
                let mut writer = writer.lock().unwrap_or_else(PoisonError::into_inner);
                for watch in watches {
                    let message = Notification {
                        jsonrpc: "2.0",
                        method: "status.ended",
                        params: Params {
                            window: &watch.window,
                            name: &watch.name,
                            surface: watch.surface.as_deref(),
                            reason: &reason,
                        },
                    };
                    match write_to_peer(&mut *writer, &message) {
                        Ok(()) => {}
                        Err(Unsent::PeerClosed) => {
                            log_info(
                                "endpoint",
                                "notification status.ended not sent: peer closed",
                            );
                        }
                        Err(Unsent::Failed(error)) => log_error("endpoint notification", error),
                    }
                }
            }
        });
    }

    /// Returns the watches of the window window.
    pub fn watches(&self, window: &str) -> Vec<Watch> {
        let mut watches: Vec<Watch> = self
            .0
            .peers
            .lock()
            // default: a lock that a panicking thread poisoned still holds the peers and their watches, which are only
            // read; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .flat_map(|peer| peer.watches.iter())
            .filter(|watch| watch.window == window)
            .cloned()
            .collect();
        watches.sort();
        watches.dedup();
        watches
    }

    /// Returns whether a connection requested the record of the window window.
    #[cfg(feature = "diagnostics")]
    pub fn transcribed(&self, window: &str) -> bool {
        transcribed(&self.0, window)
    }

    /// Sends `status.changed` to the connections that watch name of the window window. surface is the surface that the
    /// watch specified. value is sent as the received text, so the key order of the page value does not change.
    pub fn changed(&self, window: &str, name: &str, surface: Option<&str>, value: &RawValue) {
        #[derive(Serialize)]
        struct Params<'a> {
            window: &'a str,
            name: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            surface: Option<&'a str>,
            value: &'a RawValue,
        }
        #[derive(Serialize)]
        struct Notification<'a> {
            jsonrpc: &'static str,
            method: &'static str,
            params: Params<'a>,
        }
        let key = Watch {
            window: window.into(),
            name: name.into(),
            surface: surface.map(str::to_string),
        };
        let message = Notification {
            jsonrpc: "2.0",
            method: "status.changed",
            params: Params {
                window,
                name,
                surface,
                value,
            },
        };
        self.send(
            "status.changed",
            |peer| peer.watches.contains(&key),
            &message,
        );
    }

    /// Sends `diagnostics.log` to the connections that requested the record of the window window.
    #[cfg(feature = "diagnostics")]
    pub fn log(&self, window: &str, line: &str) {
        let message = json!({"jsonrpc": "2.0", "method": "diagnostics.log",
            "params": {"window": window, "line": line}});
        self.send(
            "diagnostics.log",
            |peer| peer.transcript.contains(window),
            &message,
        );
    }

    fn send<T: Serialize + ?Sized>(
        &self,
        method: &str,
        wanted: impl Fn(&Peer) -> bool,
        message: &T,
    ) {
        let writers: Vec<_> = self
            .0
            .peers
            .lock()
            // default: a lock that a panicking thread poisoned still holds the peers, which are only read to select the
            // writers; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter(|peer| wanted(peer))
            .map(|peer| peer.writer.clone())
            .collect();
        for writer in writers {
            // default: a lock that a panicking thread poisoned still holds the connection, which is written as before;
            // the panic hook records the panic.
            let mut writer = writer.lock().unwrap_or_else(PoisonError::into_inner);
            match write_to_peer(&mut *writer, message) {
                Ok(()) => {}
                Err(Unsent::PeerClosed) => {
                    log_info(
                        "endpoint",
                        format!("notification {method} not sent: peer closed"),
                    );
                }
                Err(Unsent::Failed(error)) => log_error("endpoint notification", error),
            }
        }
    }
}

/// An open local endpoint and its endpoint.json.
/// Accept faults that a test injects. A fault names a sockets directory and the error text; the next accept of a listener whose
/// address lies under that directory returns the error instead of a connection. No ordinary input makes an accept fail, so the
/// owning test of the accept error record uses this seam.
static ACCEPT_FAULTS: Mutex<Vec<(PathBuf, String)>> = Mutex::new(Vec::new());

/// Accepts one connection of listener, or returns the injected fault of its address.
fn accept_connection(
    listener: &dyn Listener,
) -> Result<Box<dyn crate::platform::Connection>, String> {
    let address = PathBuf::from(listener.address());
    let fault = {
        // default: a lock that a panicking thread poisoned still holds the accept faults, which only a test sets; the
        // panic hook records the panic.
        let mut faults = ACCEPT_FAULTS.lock().unwrap_or_else(PoisonError::into_inner);
        faults
            .iter()
            .position(|(directory, _)| address.starts_with(directory))
            .map(|index| faults.remove(index).1)
    };
    match fault {
        Some(error) => Err(error),
        None => listener.accept(),
    }
}

/// Makes the next accept of the endpoint whose sockets directory is directory fail with error.
pub fn fail_accept_for_test(directory: &Path, error: &str) {
    ACCEPT_FAULTS
        .lock()
        // default: a lock that a panicking thread poisoned still holds the accept faults, which only a test sets; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .push((directory.to_path_buf(), error.to_string()));
}

pub struct Endpoint {
    shared: Arc<Shared>,
    listener: Arc<dyn Listener>,
    process_lock: Mutex<Option<ProcessLock>>,
    unrecorded_end: Option<UnrecordedEnd>,
    address: String,
    directory: PathBuf,
    file: PathBuf,
    // The content of the endpoint.json that this endpoint publishes. At close, the file is deleted only when it has
    // this content.
    record: Value,
    published: AtomicBool,
    stopped: Arc<AtomicBool>,
}

/// How many times the acquisition opens the lock file again after the file that it opened was replaced.
const LOCK_ATTEMPTS: usize = 8;

/// The owner that process.lock holds: the process identifier and the boot identifier of its host run
/// (docs/spec/endpoint.md#discovery). A file of another form is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LockOwner {
    pub pid: u32,
    pub boot: String,
}

/// One application process owns one configuration directory. The lock file stays open and locked with an exclusive
/// advisory lock (flock) for the life of the process. A held lock means a live owner. A file that is present and not
/// locked was left by an owner that ended without removing it, and the next owner takes it over. The lock is taken
/// on the open file, so two starters that open the same file cannot both replace it.
struct ProcessLock {
    path: PathBuf,
    _file: File,
    /// The earlier run that left the file, when the file was present and not locked.
    unrecorded_end: Option<UnrecordedEnd>,
}

/// The earlier run that left process.lock without removing it. The file of the current form names the run by its boot
/// and pid. Another content is reported as it was written, cut to 256 bytes, and the boot and pid are None.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnrecordedEnd {
    pub boot: Option<String>,
    pub pid: Option<u32>,
    pub previous: Option<String>,
}

/// The number of bytes of a lock content that a refusal or an unrecorded end reports.
const REPORTED_CONTENT_BYTES: usize = 256;

/// The content of a lock file for a report: its first bytes, with an invalid sequence replaced.
fn reported_content(contents: &[u8]) -> String {
    String::from_utf8_lossy(&contents[..contents.len().min(REPORTED_CONTENT_BYTES)]).into_owned()
}

/// The earlier run that a free lock file with these contents left.
fn unrecorded_end_of(contents: &[u8]) -> UnrecordedEnd {
    // default: contents that are not UTF-8 are not the current form, and they are reported as their cut text.
    match std::str::from_utf8(contents).ok().and_then(parse_owner) {
        Some(owner) => UnrecordedEnd {
            boot: Some(owner.boot),
            pid: Some(owner.pid),
            previous: None,
        },
        None => UnrecordedEnd {
            boot: None,
            pid: None,
            previous: Some(reported_content(contents)),
        },
    }
}

/// The refusal of a second start while the lock is held. The owner is live, so the refusal does not depend on the content:
/// the content names the owner when it is the current form, and it is reported otherwise.
fn held_refusal(directory: &Path, contents: &[u8]) -> String {
    // default: contents that are not UTF-8 name no owner, and the refusal reports them as their cut text.
    if let Some(owner) = std::str::from_utf8(contents).ok().and_then(parse_owner) {
        return format!(
            "configuration directory {} is already owned by process {}",
            directory.display(),
            owner.pid
        );
    }
    if contents.iter().all(u8::is_ascii_whitespace) {
        return format!(
            "configuration directory {} is already owned by a live process",
            directory.display()
        );
    }
    format!(
        "configuration directory {} is already owned by a live process; process.lock is not the current form: {}",
        directory.display(),
        reported_content(contents)
    )
}

/// The owner that the contents of a lock file name: a JSON object with a positive pid and a non-empty boot.
fn parse_owner(contents: &str) -> Option<LockOwner> {
    // default: contents that do not parse are not the current form, and the callers report them.
    let owner: LockOwner = serde_json::from_str(contents).ok()?;
    (owner.pid > 0 && !owner.boot.is_empty()).then_some(owner)
}

impl ProcessLock {
    fn acquire(directory: &Path) -> Result<Self, String> {
        let platform = platform::current()?;
        platform.create_private_directories(directory)?;
        let path = directory.join("process.lock");
        for _ in 0..LOCK_ATTEMPTS {
            let (file, existed) = match platform.create_private_file(&path) {
                Ok(file) => (file, false),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    match platform.open_private_file(&path) {
                        Ok(file) => (file, true),
                        // The file was removed after the create failed, so the next attempt creates it.
                        Err(error) if error.kind() == ErrorKind::NotFound => continue,
                        Err(error) => return Err(format!("{}: {error}", path.display())),
                    }
                }
                Err(error) => return Err(format!("{}: {error}", path.display())),
            };
            match file.try_lock() {
                Ok(()) => {}
                Err(TryLockError::WouldBlock) => {
                    // The owner removes the file before it unlocks, so a file that is gone now was released.
                    let contents = match std::fs::read(&path) {
                        Ok(contents) => contents,
                        Err(error) if error.kind() == ErrorKind::NotFound => continue,
                        Err(error) => return Err(format!("{}: {error}", path.display())),
                    };
                    return Err(held_refusal(directory, &contents));
                }
                Err(TryLockError::Error(error)) => {
                    return Err(format!("{}: {error}", path.display()));
                }
            }
            // The file at path was replaced after this open, so the lock is on a file that no longer names the lock.
            if !platform.is_named_file(&file, &path)? {
                continue;
            }
            // A free lock file that was present was left by an owner that ended without removing it, whatever its content, except
            // an empty file: a starter creates the file before it locks it, so an empty file that is free can belong to a starter
            // that has not locked it yet. No owner writes a record into an empty file, so it names no earlier run.
            let mut unrecorded_end = None;
            if existed {
                // The contents are read through the locked file, so they cannot change while they are checked.
                let mut contents = Vec::new();
                (&file)
                    .read_to_end(&mut contents)
                    .map_err(|read| format!("{}: {read}", path.display()))?;
                if !contents.is_empty() {
                    unrecorded_end = Some(unrecorded_end_of(&contents));
                }
                #[cfg(feature = "diagnostics")]
                crate::process_lock_hook::observe_stale_lock(directory);
            }
            let owner = LockOwner {
                pid: std::process::id(),
                boot: crate::event_log::process_boot().to_string(),
            };
            let contents = serde_json::to_string(&owner)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            file.set_len(0)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            (&file)
                .seek(SeekFrom::Start(0))
                .map_err(|error| format!("{}: {error}", path.display()))?;
            (&file)
                .write_all(contents.as_bytes())
                .map_err(|error| format!("{}: {error}", path.display()))?;
            file.sync_all()
                .map_err(|error| format!("{}: {error}", path.display()))?;
            return Ok(Self {
                path,
                _file: file,
                unrecorded_end,
            });
        }
        Err(format!(
            "{}: the process lock was replaced in each of {LOCK_ATTEMPTS} attempts",
            path.display()
        ))
    }
}

impl Drop for ProcessLock {
    /// Removes the lock file while the lock is still held. The file closes after this, which releases the lock, so a
    /// starter that locks the file next finds the path gone or a new file.
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.path)
            && error.kind() != ErrorKind::NotFound
        {
            log_error(&self.path.display().to_string(), error);
        }
    }
}

impl Endpoint {
    /// Opens the endpoint of the application name in the sockets directory. `<directory>/endpoint.json` is written by
    /// [`Endpoint::publish`] after the first window is registered.
    pub fn start(
        sockets: &Path,
        directory: &Path,
        application: &str,
        service: Arc<dyn Service>,
    ) -> Result<Endpoint, String> {
        let process_lock = ProcessLock::acquire(directory)?;
        let unrecorded_end = process_lock.unrecorded_end.clone();
        let listener: Arc<dyn Listener> = platform::current()?
            .endpoint_listen(sockets, application)?
            .into();
        let address = listener.address();
        let file = directory.join("endpoint.json");
        let shared = Arc::new(Shared {
            service,
            peers: Mutex::new(HashMap::new()),
            lines: Mutex::new(HashMap::new()),
            presses: Mutex::new(Presses::default()),
            next: AtomicU64::new(1),
            orders: AtomicU64::new(1),
            stopping: AtomicBool::new(false),
            config: directory.to_path_buf(),
            activity: AtomicBool::new(false),
        });
        let mut endpoint = Endpoint {
            shared,
            listener,
            process_lock: Mutex::new(Some(process_lock)),
            unrecorded_end,
            address,
            directory: directory.to_path_buf(),
            file,
            record: Value::Null,
            published: AtomicBool::new(false),
            stopped: Arc::new(AtomicBool::new(false)),
        };
        let executable = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|error| format!("executable path: {error}"))?;
        let record = json!({
            "transport": endpoint.listener.transport(),
            "address": endpoint.address,
            "pid": std::process::id(),
            "application": application,
            "version": env!("CARGO_PKG_VERSION"),
            "executable": executable.to_string_lossy(),
            "started": timestamp(SystemTime::now())?,
        });
        endpoint.record = record;
        let listener = endpoint.listener.clone();
        let shared = endpoint.shared.clone();
        let stopped = endpoint.stopped.clone();
        crate::routine::spawn_named("endpoint-accept", move || {
            loop {
                match accept_connection(&*listener) {
                    Ok(connection) => {
                        let shared = shared.clone();
                        crate::routine::spawn_named("endpoint-serve", move || {
                            serve(shared, connection)
                        });
                    }
                    Err(error) => {
                        if !stopped.load(Ordering::Relaxed) {
                            log_error("endpoint accept", error);
                        }
                        return;
                    }
                }
            }
        });
        Ok(endpoint)
    }

    /// Writes endpoint.json when the window window is registered. It is called once after the first window is
    /// registered, so that a client that read the file can send requests to that window at once.
    pub fn publish(&self, window: &str) -> Result<(), String> {
        if !self.shared.service.exists(window) {
            return Err(format!(
                "endpoint.json is not written: window {window} does not exist"
            ));
        }
        if self.published.swap(true, Ordering::SeqCst) {
            return Err("endpoint.json is already written".into());
        }
        write_record(&self.directory, &self.file, &self.record)
    }

    /// The earlier run that left process.lock without removing it. The host reports it with [`report_unrecorded_end`].
    pub fn unrecorded_end(&self) -> Option<&UnrecordedEnd> {
        self.unrecorded_end.as_ref()
    }

    /// The socket path or the pipe name.
    pub fn address(&self) -> &str {
        &self.address
    }

    /// The value that sends notifications to the connections of this endpoint.
    pub fn notifier(&self) -> Notifier {
        Notifier(self.shared.clone())
    }

    /// Stops accepting new connections and removes the address file and endpoint.json. It can be called several times.
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::Relaxed) {
            return;
        }
        self.listener.remove();
        // An endpoint.json that another process replaced belongs to that process, so it is not deleted.
        match std::fs::read(&self.file) {
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => log_error(&self.file.display().to_string(), error),
            Ok(data) => match serde_json::from_slice::<Value>(&data) {
                Err(error) => log_error(
                    &self.file.display().to_string(),
                    format!("endpoint file is not valid JSON: {error}"),
                ),
                Ok(current) if current == self.record => {
                    if let Err(error) = std::fs::remove_file(&self.file)
                        && error.kind() != ErrorKind::NotFound
                    {
                        log_error(&self.file.display().to_string(), error);
                    }
                }
                Ok(_) => {}
            },
        }
        self.shared.stopping.store(true, Ordering::Relaxed);
        let peers = self
            .shared
            .peers
            .lock()
            // default: a lock that a panicking thread poisoned still holds the connections, and each one is closed; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        for peer in peers.values() {
            // default: a lock that a panicking thread poisoned still holds the connection, which is closed as before;
            // the panic hook records the panic.
            let writer = peer.writer.lock().unwrap_or_else(PoisonError::into_inner);
            if let Err(error) = writer.close() {
                log_error("endpoint connection close", error);
            }
        }
        // The lock is released last, after the endpoint file is removed (ProcessLock::drop).
        drop(
            self.process_lock
                .lock()
                // default: a lock that a panicking thread poisoned still holds the process lock, which the stop takes;
                // the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .take(),
        );
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Stores the event `host.run.unrecorded-end` for an earlier run that left process.lock without removing it. The fields are
/// `boot` and `pid` (null when the file is not the current form) and `previous`, the content of the file, when it is not
/// the current form.
pub fn report_unrecorded_end(end: &UnrecordedEnd) {
    let mut fields = json!({"boot": end.boot, "pid": end.pid});
    if let Some(previous) = &end.previous {
        fields["previous"] = json!(previous);
    }
    crate::event_record::emit_host(
        crate::event_log::Level::Error,
        "host.run.unrecorded-end",
        fields,
    );
}

/// The directory in which the application places its sockets. It is under the temporary directory of the user.
pub fn socket_directory() -> std::path::PathBuf {
    std::env::temp_dir().join("soksak")
}

/// Writes one message with its length.
pub fn write_frame<W: Write + ?Sized, T: Serialize + ?Sized>(
    writer: &mut W,
    message: &T,
) -> Result<(), String> {
    let frame = frame_of(message)?;
    writer.write_all(&frame).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

/// The length prefix and the body of one message.
fn frame_of<T: Serialize + ?Sized>(message: &T) -> Result<Vec<u8>, String> {
    let body = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    if body.len() > MAX_FRAME {
        return Err(format!(
            "message of {} bytes exceeds {MAX_FRAME}",
            body.len()
        ));
    }
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// Why a frame was not written to a connection.
enum Unsent {
    /// The peer closed the connection: the write failed with a broken pipe or a reset.
    PeerClosed,
    /// Any other failure, with its text.
    Failed(String),
}

/// Writes one message to the connection of a peer and tells a close by the peer from the other failures.
fn write_to_peer<W: Write + ?Sized, T: Serialize + ?Sized>(
    writer: &mut W,
    message: &T,
) -> Result<(), Unsent> {
    let frame = frame_of(message).map_err(Unsent::Failed)?;
    writer
        .write_all(&frame)
        .and_then(|()| writer.flush())
        .map_err(|error| match error.kind() {
            ErrorKind::BrokenPipe | ErrorKind::ConnectionReset => Unsent::PeerClosed,
            _ => Unsent::Failed(error.to_string()),
        })
}

/// The reason for a failure to read a message body.
enum BodyError {
    /// The body length exceeds the limit.
    TooLarge(usize),
    /// The connection cannot be read.
    Io(String),
}

/// Reads the body of one message. It returns None when the connection is closed at a message boundary.
fn read_body<R: Read + ?Sized>(reader: &mut R) -> Result<Option<Vec<u8>>, BodyError> {
    let mut prefix = [0u8; 4];
    let mut filled = 0;
    while filled < prefix.len() {
        match reader.read(&mut prefix[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => {
                return Err(BodyError::Io(
                    "connection closed inside a length prefix".into(),
                ));
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if filled == 0 && e.kind() == ErrorKind::ConnectionReset => return Ok(None),
            Err(e) => return Err(BodyError::Io(e.to_string())),
        }
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_FRAME {
        return Err(BodyError::TooLarge(length));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).map_err(|e| {
        BodyError::Io(if e.kind() == ErrorKind::UnexpectedEof {
            "connection closed inside a frame body".into()
        } else {
            e.to_string()
        })
    })?;
    Ok(Some(body))
}

/// Reads one message. It returns None when the connection is closed at a message boundary.
pub fn read_frame<R: Read + ?Sized>(reader: &mut R) -> Result<Option<Value>, String> {
    match read_body(reader) {
        Ok(None) => Ok(None),
        Ok(Some(body)) => serde_json::from_slice(&body)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(BodyError::TooLarge(length)) => {
            Err(format!("message of {length} bytes exceeds {MAX_FRAME}"))
        }
        Err(BodyError::Io(error)) => Err(error),
    }
}

/// Writes endpoint.json at once by renaming a file.
fn write_record(directory: &Path, file: &Path, record: &Value) -> Result<(), String> {
    platform::current()?.create_private_directories(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut temporary, record).map_err(|e| e.to_string())?;
    temporary.write_all(b"\n").map_err(|e| e.to_string())?;
    temporary
        .persist(file)
        .map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(())
}

/// Converts a time to an ISO 8601 UTC string in seconds.
fn timestamp(time: SystemTime) -> Result<String, String> {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| format!("the system clock is before 1970: {e}"))? as i64;
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Converts the number of days since 1970-01-01 to a Gregorian date (civil_from_days by Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    ))
}

/// A request that passed the check.
struct Request {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

/// Returns the request when it is a JSON-RPC 2.0 request object.
fn parse(message: Value) -> Option<Request> {
    let Value::Object(mut object) = message else {
        return None;
    };
    if object.get("jsonrpc") != Some(&Value::String("2.0".into())) {
        return None;
    }
    let Some(Value::String(method)) = object.remove("method") else {
        return None;
    };
    let id = object.remove("id");
    if !matches!(
        id,
        None | Some(Value::String(_) | Value::Number(_) | Value::Null)
    ) {
        return None;
    }
    Some(Request {
        id,
        method,
        params: object.remove("params"),
    })
}

fn declared(method: &str) -> bool {
    METHODS.contains(&method) || DIAGNOSTICS.contains(&method)
}

/// Holds the activity of the process while a connection is open, so that the system does not run the host in the background
/// while a client waits for its answers (docs/spec/endpoint.md#transport). The caller holds the lock of the peers, so the
/// requests follow the order of the changes of the connections. It reports whether the platform made the change.
fn hold_connection_activity(held: bool) -> bool {
    if let Err(error) =
        platform::current().and_then(|platform| platform.hold_connection_activity(held))
    {
        log_error("endpoint activity", error);
        return false;
    }
    true
}

/// Reads and runs the requests of one connection. Subscription changes are applied in the order received, and the other
/// requests run on their own threads.
fn serve(shared: Arc<Shared>, mut connection: Box<dyn Connection>) {
    let writer = match connection.try_clone() {
        Ok(writer) => Arc::new(Mutex::new(writer)),
        Err(error) => {
            log_error("endpoint connection", error);
            return;
        }
    };
    let peer = shared.next.fetch_add(1, Ordering::Relaxed);
    {
        let mut peers = shared
            .peers
            .lock()
            // default: a lock that a panicking thread poisoned still holds the peers, and the new connection is registered
            // in them; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        peers.insert(
            peer,
            Peer {
                writer: writer.clone(),
                watches: HashSet::new(),
                #[cfg(feature = "diagnostics")]
                transcript: HashSet::new(),
                changes: HashMap::new(),
            },
        );
        if peers.len() == 1 {
            shared
                .activity
                .store(hold_connection_activity(true), Ordering::Relaxed);
        }
    }
    let mut reason = String::from("peer closed");
    // The end of this connection, which ends the work of its requests whose response is not complete.
    let ended = ConnectionEnd::open();
    loop {
        let body = match read_body(&mut connection) {
            Ok(Some(body)) => body,
            Ok(None) => break,
            Err(BodyError::Io(error)) => {
                reason = error;
                break;
            }
            Err(BodyError::TooLarge(length)) => {
                reason = format!("frame of {length} bytes exceeds the limit of {MAX_FRAME}");
                break;
            }
        };
        // default: a frame that is not JSON-RPC becomes the close reason below, which carries the frame text.
        let Some(request) = serde_json::from_slice(&body).ok().and_then(parse) else {
            reason = format!(
                "frame is not a JSON-RPC 2.0 request: {}",
                String::from_utf8_lossy(&body)
            );
            break;
        };
        if !declared(&request.method) {
            reason = format!("method {:?} is not declared", request.method);
            break;
        }
        let (reply, completion) = ReplyScope::pending_on(ended.clone());
        let answer = Answer {
            writer: writer.clone(),
            id: request.id,
            call: Call::begin(&request.method, &body),
            completion,
        };
        if SUBSCRIPTIONS.contains(&request.method.as_str()) {
            match subscription(&shared, &request.method, request.params) {
                Ok((topic, on)) => change(&shared, peer, topic, on, Some(answer), body.len()),
                Err(failure) => answer.send(Err(failure)),
            }
            continue;
        }
        let input = (request.method == "input.pointer")
            .then(|| pointer_input(request.params.as_ref()))
            .flatten();
        let shared = shared.clone();
        crate::routine::spawn_named("endpoint-run", move || {
            let outcome = run(&shared, &request.method, request.params, Some(reply));
            // The press is the connection's before the answer goes, so a request that follows the answer finds it.
            if outcome.is_ok()
                && let Some((window, input)) = input
            {
                delivered(&shared, peer, window, &input);
            }
            // A request that ended without its result is an error that the requesting side receives, but only this
            // record keeps which method and what ended it.
            if let Err(failure) = &outcome
                && failure.code == TIMED_OUT
            {
                log_error(
                    "endpoint no result",
                    format!("{}: {}", request.method, failure.message),
                );
            }
            answer.send(outcome)
        });
    }
    if shared.stopping.load(Ordering::Relaxed) {
        reason = String::from("the endpoint closed");
    }
    log_info("endpoint", format!("connection closed: {reason}"));
    // The waits of the requests of this connection and the diagnostic holds that they opened end with it.
    ended.close();
    if let Err(error) = connection.close() {
        log_error("endpoint connection close", error);
    }
    forget(&shared, peer);
}

/// The methods that change the subscriptions of a connection.
#[cfg(feature = "diagnostics")]
const SUBSCRIPTIONS: &[&str] = &["status.watch", "status.unwatch", TRANSCRIPT];
#[cfg(not(feature = "diagnostics"))]
const SUBSCRIPTIONS: &[&str] = &["status.watch", "status.unwatch"];

/// Checks params and takes out the window name.
fn target(
    shared: &Shared,
    method: &str,
    params: Option<Value>,
) -> Result<(String, Map<String, Value>), Failure> {
    let mut params = match params {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(params)) => params,
        Some(_) => return Err(Failure::params("params must be an object")),
    };
    // The window is checked first, then the name, then the existence of the window
    // (endpoint.rpc.target-params-are-checked-in-order).
    let window = match params.remove("window") {
        Some(Value::String(window)) if !window.is_empty() => window,
        _ => return Err(Failure::params("window must be a non-empty string")),
    };
    if matches!(
        method,
        "status.get"
            | "status.watch"
            | "status.unwatch"
            | "command.run"
            | "element.rect"
            | "element.act"
    ) {
        name(&params)?;
    }
    if !shared.service.exists(&window) {
        return Err(missing_window(&window));
    }
    Ok((window, params))
}

/// Returns the target of a subscription change request and whether it starts.
fn subscription(
    shared: &Shared,
    method: &str,
    params: Option<Value>,
) -> Result<(Topic, bool), Failure> {
    let (window, params) = target(shared, method, params)?;
    match method {
        "status.watch" => Ok((Topic::Status(watch_key(&window, &params)?), true)),
        "status.unwatch" => Ok((Topic::Status(watch_key(&window, &params)?), false)),
        #[cfg(feature = "diagnostics")]
        TRANSCRIPT => match params.get("on") {
            Some(Value::Bool(on)) => Ok((Topic::Transcript(window), *on)),
            _ => Err(Failure::params("on must be a boolean")),
        },
        other => Err(Failure::new(
            -32601,
            format!("{other} is not a subscription"),
        )),
    }
}

/// Changes the subscription of the connection peer at once and puts the change to send to the page into the queue of
/// the target. Both operations run inside the lock of the connection list, so the order of the queue equals the order
/// in which the subscription changes were applied. A watch is refused, and not applied, when `ENDPOINT_TOPIC_CHANGES`
/// changes of the target wait for the page already: the refusal is the event `host.buffer.dropped` and an error answer.
/// An unwatch is never refused: it enters the queue only when the last change of its connection for the target, queued
/// or held, is a watch, so each queued unwatch follows a queued or held watch and the queue holds at most one unwatch
/// per watch. Any other unwatch changes nothing and is answered null at once, without the queue and without a page
/// call. The release of the subscriptions of a closed connection has no answer and releases only the targets that the
/// connection held. `size` is the size of the request in bytes.
fn change(
    shared: &Arc<Shared>,
    peer: u64,
    topic: Topic,
    on: bool,
    answer: Option<Answer>,
    size: usize,
) {
    let (start, refused, unchanged) = {
        // default: a lock that a panicking thread poisoned still holds the peers and the lines, which the change
        // updates in order; the panic hook records the panic.
        let mut peers = shared.peers.lock().unwrap_or_else(PoisonError::into_inner);
        // default: a lock that a panicking thread poisoned still holds the lines, which the change orders with the
        // peers; the panic hook records the panic.
        let mut lines = shared.lines.lock().unwrap_or_else(PoisonError::into_inner);
        let waiting = lines.get(&topic).map_or(0, |line| line.changes.len());
        // A change is applied to the peer at once, so what the peer holds is its last change, queued or held.
        let watched = peers.get(&peer).is_some_and(|state| topic.held(state));
        if !on && !watched {
            (false, None, answer)
        } else if on && answer.is_some() && waiting >= ENDPOINT_TOPIC_CHANGES {
            (false, answer, None)
        } else {
            let order = shared.orders.fetch_add(1, Ordering::Relaxed);
            if let Some(state) = peers.get_mut(&peer) {
                topic.set(state, on);
                state.changes.insert(topic.clone(), order);
            }
            let last = !on && !peers.values().any(|other| topic.held(other));
            let line = lines.entry(topic.clone()).or_default();
            line.changes.push_back(Change {
                peer,
                order,
                on,
                last,
                answer,
            });
            (!std::mem::replace(&mut line.running, true), None, None)
        }
    };
    if let Some(answer) = unchanged {
        answer.send(raw(&Value::Null));
        return;
    }
    if let Some(answer) = refused {
        record_buffer_drop(
            "endpoint topic changes",
            size,
            &format!("{ENDPOINT_TOPIC_CHANGES} messages"),
        );
        answer.send(Err(Failure::new(
            HANDLER_FAILED,
            format!(
                "the subscription changes of {} are not keeping up: {ENDPOINT_TOPIC_CHANGES} changes are pending, so this change is refused",
                topic.name()
            ),
        )));
        return;
    }
    if start {
        let shared = shared.clone();
        crate::routine::spawn_named("endpoint-drain", move || drain(&shared, topic));
    }
}

/// Sends the changes in the queue of the target topic to the page in order and answers.
fn drain(shared: &Shared, topic: Topic) {
    loop {
        let (next, page) = {
            // default: a lock that a panicking thread poisoned still holds the queued changes, which are taken in
            // order; the panic hook records the panic.
            let mut lines = shared.lines.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(line) = lines.get_mut(&topic) else {
                return;
            };
            match line.changes.pop_front() {
                Some(next) => (next, line.page),
                None => {
                    line.running = false;
                    if !line.page {
                        lines.remove(&topic);
                    }
                    return;
                }
            }
        };
        if let Topic::Status(watch) = &topic
            && watch.surface.is_none()
            && !next.on
            && next.last
        {
            shared.service.unwatched(&watch.window, &watch.name);
        }
        let (method, params) = topic.request(next.on);
        let reply = next
            .answer
            .as_ref()
            .map(|answer| answer.completion.scope.clone());
        let (outcome, following) = if next.on && !page {
            match shared.service.call(topic.window(), method, params, reply) {
                Ok(result) => (Ok(result), true),
                Err(failure) => {
                    // If this connection did not change this target again after that, the start is reverted.
                    // default: a lock that a panicking thread poisoned still holds the peers, which are updated to
                    // revert the start; the panic hook records the panic.
                    let mut peers = shared.peers.lock().unwrap_or_else(PoisonError::into_inner);
                    if let Some(state) = peers.get_mut(&next.peer)
                        && state.changes.get(&topic) == Some(&next.order)
                    {
                        topic.set(state, false);
                    }
                    (Err(failure), false)
                }
            }
        } else if !next.on && next.last && page {
            // Even if the page fails a stop request, a later start request is sent to the page again.
            (
                shared.service.call(topic.window(), method, params, reply),
                false,
            )
        } else {
            (raw(&Value::Null), page)
        };
        // default: a lock that a panicking thread poisoned still holds the lines, and the page state of the target is
        // updated in them; the panic hook records the panic.
        let mut lines = shared.lines.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(line) = lines.get_mut(&topic) {
            line.page = following;
        }
        drop(lines);
        if let Some(answer) = next.answer {
            answer.send(outcome);
        }
    }
}

/// Runs one request that is not a subscription change.
fn run(
    shared: &Shared,
    method: &str,
    params: Option<Value>,
    reply: Option<ReplyScope>,
) -> Result<Box<RawValue>, Failure> {
    if method == "windows.list" {
        return shared.service.windows().and_then(|list| raw(&list));
    }
    if method == "log.query" {
        return crate::log_query::answer(&shared.config, params);
    }
    let (window, params) = target(shared, method, params)?;
    #[cfg(feature = "diagnostics")]
    if method == "diagnostics.clock" {
        return raw(&crate::diagnostics::clock()?);
    }
    // The endpoint answers the names of the host and the invalid input itself, before the window service receives the request
    // (docs/spec/exposure.md#methods); the service delivers the input and runs the commands of the host.
    match method {
        "exposure.list" => {
            return crate::exposure::exposure_list(&params, || {
                shared.service.call(&window, method, Map::new(), reply)
            });
        }
        "status.get" | "command.run" | "element.rect" | "element.act" => {
            host_request(method, &params)?;
        }
        "input.pointer" => {
            crate::exposure::pointer(&params)?;
        }
        "input.key" => {
            crate::exposure::key(&params)?;
        }
        "input.text" => {
            crate::exposure::text_input(&params)?;
        }
        "input.dialog.answer" => {
            crate::exposure::dialog_answer(&params)?;
        }
        _ => {}
    }
    shared.service.call(&window, method, params, reply)
}

/// Checks a request whose name has the owner `host` against the entries that the host declares: an undeclared name is 1001, the
/// host declares no element entry, and the params of a host command are an object.
fn host_request(method: &str, params: &Map<String, Value>) -> Result<(), Failure> {
    let name = name(params)?;
    if !name.starts_with("host.") {
        return Ok(());
    }
    if matches!(method, "element.rect" | "element.act") {
        return Err(Failure::new(
            UNKNOWN_NAME,
            format!("the host declares no element entry {name}"),
        ));
    }
    crate::exposure::check_host_name(method, &name)?;
    if method == "command.run"
        && !matches!(
            params.get("params"),
            None | Some(Value::Null | Value::Object(_))
        )
    {
        return Err(Failure::params(format!(
            "params of {name} must be an object"
        )));
    }
    Ok(())
}

/// Returns name of params.
pub(crate) fn name(params: &Map<String, Value>) -> Result<String, Failure> {
    match params.get("name") {
        Some(Value::String(name)) if valid_name(name) => Ok(name.clone()),
        _ => Err(Failure::params(
            "name is required and must have the form <owner>.<name>",
        )),
    }
}

/// Returns whether the name has the form `<owner>.<name>`. Each part is lowercase letters, digits and hyphens.
pub fn valid_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() >= 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}

/// Builds the watch key from name and surface of params.
fn watch_key(window: &str, params: &Map<String, Value>) -> Result<Watch, Failure> {
    let name = name(params)?;
    // A status of the host has no surface: its watch is the watch of the window.
    if name.starts_with("host.") {
        crate::exposure::check_host_name("status.watch", &name)?;
        return Ok(Watch {
            window: window.into(),
            name,
            surface: None,
        });
    }
    let surface = match params.get("surface") {
        None => None,
        Some(Value::String(surface)) if !surface.is_empty() => Some(surface.clone()),
        Some(Value::String(_)) => return Err(Failure::params("surface must not be empty")),
        Some(_) => return Err(Failure::params("surface must be a string")),
    };
    Ok(Watch {
        window: window.into(),
        name,
        surface,
    })
}

/// Returns whether a connection has the watch key key.
fn watched(shared: &Shared, key: &Watch) -> bool {
    shared
        .peers
        .lock()
        .is_ok_and(|peers| peers.values().any(|peer| peer.watches.contains(key)))
}

/// Returns whether a connection requested the record of the window window.
#[cfg(feature = "diagnostics")]
fn transcribed(shared: &Shared, window: &str) -> bool {
    shared
        .peers
        .lock()
        .is_ok_and(|peers| peers.values().any(|peer| peer.transcript.contains(window)))
}

/// Ends the subscriptions of a closed connection with the last change in the order received. A target that has no
/// remaining subscriber is asked to stop in the page.
fn forget(shared: &Arc<Shared>, peer: u64) {
    // default: a lock that a panicking thread poisoned still holds the peers, which are only read to end the
    // subscriptions of the connection; the panic hook records the panic.
    let peers = shared.peers.lock().unwrap_or_else(PoisonError::into_inner);
    let topics: Vec<Topic> = match peers.get(&peer) {
        Some(state) => {
            let topics = state.watches.iter().cloned().map(Topic::Status);
            #[cfg(feature = "diagnostics")]
            let topics = topics.chain(state.transcript.iter().cloned().map(Topic::Transcript));
            topics.collect()
        }
        None => return,
    };
    drop(peers);
    for topic in topics {
        change(shared, peer, topic, false, None, 0);
    }
    {
        let mut peers = shared
            .peers
            .lock()
            // default: a lock that a panicking thread poisoned still holds the peers, and the connection that ended is
            // removed from them; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        peers.remove(&peer);
        if peers.is_empty() && shared.activity.load(Ordering::Relaxed) {
            shared
                .activity
                .store(!hold_connection_activity(false), Ordering::Relaxed);
        }
    }
    // The connection is gone from the peers, so a `down` of it that is delivered after this releases its press itself.
    let owned: Vec<(PressKey, Press)> = {
        let mut presses = shared
            .presses
            .lock()
            // default: a lock that a panicking thread poisoned still holds the presses, and the presses of the
            // connection are taken from them; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let mut keys: Vec<PressKey> = presses
            .open
            .iter()
            .filter(|(_, press)| press.peer == peer)
            .map(|(key, _)| key.clone())
            .collect();
        keys.sort();
        keys.into_iter()
            .filter_map(|key| presses.open.remove(&key).map(|press| (key, press)))
            .collect()
    };
    for (key, press) in owned {
        release(shared, key, press);
    }
}

/// Reads the window and the pointer input of the params of `input.pointer`. Params that the host refuses are no input, and
/// the request fails without a press.
fn pointer_input(params: Option<&Value>) -> Option<(String, crate::platform::Pointer)> {
    let params = params?.as_object()?;
    let window = params.get("window")?.as_str()?.to_string();
    // default: params that do not parse are refused by the request itself, which delivers nothing.
    let input = crate::exposure::pointer(params).ok()?;
    Some((window, input))
}

/// Applies a delivered `input.pointer` of the connection peer to the open presses: a `down` opens the press of the connection,
/// a `drag` moves its point, and an `up` ends it, whichever connection sent it.
fn delivered(shared: &Shared, peer: u64, window: String, input: &crate::platform::Pointer) {
    let key = PressKey {
        window,
        pointer: input.pointer.clone(),
        button: input.button,
    };
    match input.phase {
        1 => {
            let press = Press {
                peer,
                x: input.x,
                y: input.y,
                clicks: input.clicks,
            };
            {
                // default: a lock that a panicking thread poisoned still holds the peers, which are only read; the
                // panic hook records the panic.
                let peers = shared.peers.lock().unwrap_or_else(PoisonError::into_inner);
                if peers.contains_key(&peer) {
                    let mut presses = shared
                        .presses
                        .lock()
                        // default: a lock that a panicking thread poisoned still holds the presses, which take the new
                        // press; the panic hook records the panic.
                        .unwrap_or_else(PoisonError::into_inner);
                    // A release that waits for an earlier press of this pointer and button found that press ended, since a
                    // new press of them was delivered.
                    presses.waiting.retain(|release| release.key != key);
                    presses.open.insert(key, press);
                    return;
                }
            }
            // The connection closed while its `down` was delivered, so its close found no press to release.
            release(shared, key, press);
        }
        2 => {
            let mut presses = shared
                .presses
                .lock()
                // default: a lock that a panicking thread poisoned still holds the presses, whose point the drag moves;
                // the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(press) = presses.open.get_mut(&key) {
                press.x = input.x;
                press.y = input.y;
            }
        }
        3 => {
            {
                let mut presses = shared
                    .presses
                    .lock()
                    // default: a lock that a panicking thread poisoned still holds the presses, which the release ends;
                    // the panic hook records the panic.
                    .unwrap_or_else(PoisonError::into_inner);
                presses.open.remove(&key);
                // A release that waits for this press finds it ended.
                presses.waiting.retain(|release| release.key != key);
            }
            release_waiting(shared, POINTER_HELD);
        }
        _ => {}
    }
}

/// The text of a press in the application log.
fn press_text(key: &PressKey) -> String {
    let button = if key.button == 1 { "right" } else { "left" };
    format!(
        "pointer {} button {button} in window {}",
        key.pointer, key.window
    )
}

/// Delivers the `up` of a press that its connection left open, at the point of its last delivered input. A refusal 1007 or
/// 1011 waits for the event that lifts it, and any other refusal finds the press ended already; both are written to the
/// application log at `info` (docs/spec/exposure.md#methods).
fn release(shared: &Shared, key: PressKey, press: Press) {
    let mut params = Map::new();
    params.insert("pointer".into(), json!(key.pointer));
    params.insert("x".into(), json!(press.x));
    params.insert("y".into(), json!(press.y));
    params.insert("phase".into(), json!("up"));
    params.insert(
        "button".into(),
        json!(if key.button == 1 { "right" } else { "left" }),
    );
    params.insert("clicks".into(), json!(press.clicks));
    loop {
        let before = shared
            .presses
            .lock()
            // default: a lock that a panicking thread poisoned still holds the presses, whose lift counts are only
            // read; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .lifts;
        let failure = match shared
            .service
            .call(&key.window, "input.pointer", params.clone(), None)
        {
            Ok(_) => {
                release_waiting(shared, POINTER_HELD);
                return;
            }
            Err(failure) => failure,
        };
        if failure.code != BUTTON_HELD && failure.code != POINTER_HELD {
            log_info(
                "endpoint",
                format!(
                    "the release of {} ended nothing: code {}: {}",
                    press_text(&key),
                    failure.code,
                    failure.message
                ),
            );
            return;
        }
        {
            let mut presses = shared
                .presses
                .lock()
                // default: a lock that a panicking thread poisoned still holds the presses, which keep the release that
                // waits; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            let index = lift_index(failure.code);
            // The event that lifts the refusal came while the release was refused, so the release goes again now.
            if presses.lifts[index] != before[index] {
                continue;
            }
            presses.waiting.push(Release {
                key: key.clone(),
                press,
                code: failure.code,
            });
        }
        let lift = if failure.code == BUTTON_HELD {
            "host.buttons mask 0"
        } else {
            "the end of a press"
        };
        log_info(
            "endpoint",
            format!(
                "the release of {} waits for {lift}: code {}",
                press_text(&key),
                failure.code
            ),
        );
        return;
    }
}

/// Delivers again the releases that wait for the event that lifts the refusal code.
fn release_waiting(shared: &Shared, code: i64) {
    let lifted: Vec<Release> = {
        let mut presses = shared
            .presses
            .lock()
            // default: a lock that a panicking thread poisoned still holds the presses, whose waiting releases are
            // taken; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        presses.lifts[lift_index(code)] += 1;
        let (lifted, kept) = std::mem::take(&mut presses.waiting)
            .into_iter()
            .partition(|release| release.code == code);
        presses.waiting = kept;
        lifted
    };
    for waiting in lifted {
        release(shared, waiting.key, waiting.press);
    }
}

#[cfg(test)]
#[path = "endpoint_lock_test.rs"]
mod lock_test;

#[cfg(all(test, feature = "diagnostics"))]
mod draw_covered_declaration_test {
    // contract: diagnostics.window.draw-covered.is-declared
    #[test]
    fn draw_covered_method_is_declared() {
        assert!(super::declared("diagnostics.window.draw-covered"));
    }
}

#[cfg(all(test, not(feature = "diagnostics")))]
mod draw_covered_release_declaration_test {
    // contract: image.drawing.covered-window-never-draws-without-diagnostics
    #[test]
    fn a_build_without_diagnostics_declares_no_draw_covered() {
        assert!(!super::declared("diagnostics.window.draw-covered"));
    }
}

#[cfg(all(test, feature = "diagnostics"))]
mod input_reference_declaration_test {
    // contract: diagnostics.input-reference.declared
    #[test]
    fn input_reference_method_is_declared() {
        assert!(super::declared("diagnostics.input.reference"));
    }
}

#[cfg(all(test, feature = "diagnostics"))]
mod native_window_color_space_declaration_test {
    // contract: diagnostics.native-window-color-space.reports-appkit-profile
    #[test]
    fn native_window_color_space_method_is_declared() {
        assert!(super::declared("diagnostics.native.window-color-space"));
    }
}

#[cfg(all(test, feature = "diagnostics"))]
mod document_viewport_marker_declaration_test {
    // contract: diagnostics.document.viewport-marker.is-declared
    #[test]
    fn document_viewport_marker_method_is_declared() {
        assert!(super::declared("diagnostics.document.viewport-marker"));
    }
}
