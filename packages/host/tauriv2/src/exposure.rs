//! Window selection of endpoint requests, host entries and relay of page requests.
//!
//! The host handles `windows.list`, `input.pointer`, `input.key` and the names whose owner is `host` itself. The other
//! requests are sent to the main page of the window with the `exposure-request` event, and the response is received
//! with the `exposure_reply` command. When the main page requests a name of a surface page, the request is forwarded to
//! the surface page with the `exposure_forward` command. The calling document is distinguished by the webview of the
//! command. The format is defined in docs/spec/exposure.md.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter, EventTarget, LogicalSize, Manager, Webview, Window};

use crate::application_log::log_error;
use crate::buffer_bounds::record_buffer_drop;
use crate::endpoint::{
    BUTTON_HELD, Endpoint, Failure, HANDLER_FAILED, INVALID_PARAMS, MISSING_DOCUMENT, NO_INPUT,
    NOT_ACTIVE, PRESS_OPEN, Service, TIMED_OUT, UNKNOWN_NAME, missing_window,
};
use crate::event_log::Level;
use crate::event_record::emit_host;
use crate::platform;
use crate::surfaces::label_for;
use crate::windows::{self, NativeFailure, window_data, with_native_owner};

pub use crate::platform::{ButtonHeld, Delivery, FrontmostApplication, Key, Pointer};

/// The time within which a document must respond.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// The time to wait for the application activation.
const ACTIVATION: Duration = Duration::from_secs(5);

/// The time that the press and release of input.pointer wait for the document to receive them.
const RECEIPT: Duration = Duration::from_secs(2);

/// The application name used for endpoint.json and the socket name.
const APPLICATION: &str = "tauriv2";

/// The entries that the host declares. The format is the same as exposes of plugin.json, and each kind is in name
/// order.
fn host_declarations() -> Value {
    let rect = json!({"type": "object", "properties": {
        "x": {"type": "number"}, "y": {"type": "number"},
        "width": {"type": "number"}, "height": {"type": "number"}}});
    let empty = json!({"type": "object", "properties": {}});
    let nothing = json!({"type": "null"});
    json!({
        "status": [{
            "name": "host.buttons",
            "description": "The mouse buttons that AppKit reports as pressed: {mask}, the NSEvent.pressedMouseButtons mask (bit 0 left, bit 1 right). It changes with a press or release of a person's button in any application; input.pointer refuses a press or release with 1007 while it is not 0.",
            "schema": {"type": "object", "properties": {"mask": {"type": "integer"}}},
        }, {
            "name": "host.dock",
            "description": "The titles of the application's Dock menu items in order.",
            "schema": {"type": "array", "items": {"type": "string"}},
        }, {
            "name": "host.log",
            "description": "The latest notice of a change of the event log: {path, size, notices, coalesced}. path is the event file under the configuration folder (logs/<name>) and size its size in bytes; notices counts the notices published since the start, at most one per 250 ms, and coalesced counts the announcements that were folded into a later notice. A line announces a change except the record of a call that only reads the log. The page follows the same notice with the host event debug-log-changed; a client queries log.query with since after a notice.",
            "schema": {"type": "object", "properties": {
                "path": {"type": "string"}, "size": {"type": "integer"},
                "notices": {"type": "integer"}, "coalesced": {"type": "integer"}}},
        }, {
            "name": "host.menu",
            "description": "The active menu language and the application menu: each submenu's title and its items' titles and key equivalents, without separators.",
            "schema": {"type": "object", "properties": {
                "language": {"type": "string"},
                "menus": {"type": "array", "items": {"type": "object", "properties": {
                    "title": {"type": "string"},
                    "items": {"type": "array", "items": {"type": "object", "properties": {
                        "title": {"type": "string"},
                        "key": {"type": "string"},
                    }}},
                }}},
            }},
        }, {
            "name": "host.screens",
            "description": "The displays in screen coordinates with their backing scale and the area not covered by the menu bar and Dock.",
            "schema": {"type": "array", "items": {"type": "object", "properties": {
                "visible": rect,
                "x": {"type": "number"}, "y": {"type": "number"},
                "width": {"type": "number"}, "height": {"type": "number"},
                "scale": {"type": "number"}}}},
        }, {
            "name": "host.sidecars",
            "description": "The surfaces whose closed the host has sent and the sidecar has not answered, sorted by sidecar and surface, and the persistent sidecars whose service runs another version than the installed one, sorted by sidecar, with the running version (null when the service sent none), the installed version and the number of open surfaces of the service: {closing: [{sidecar, surface}], outdated: [{sidecar, running, installed, sessions}]}.",
            "schema": {"type": "object", "properties": {
                "closing": {"type": "array", "items": {"type": "object", "properties": {
                    "sidecar": {"type": "string"}, "surface": {"type": "string"}}}},
                "outdated": {"type": "array", "items": {"type": "object", "properties": {
                    "sidecar": {"type": "string"}, "running": {"type": ["string", "null"]},
                    "installed": {"type": "string"}, "sessions": {"type": "integer"}}}}}},
        }, {
            "name": "host.window",
            "description": "Window frame and system pointer location in screen coordinates, content size, backing scale, the maximum refresh rate of its screen (null when the window is on no screen), maximized, key and application active state, whether other windows cover the whole window, child window count, the WebContent process of the app page (0 before it starts), whether the application is quitting, window buttons, webview frames, native surfaces, document regions, image regions, and the open native modal.",
            "schema": {"type": "object", "properties": {
                "frame": rect,
                "pointer": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}}},
                "content": rect,
                "scale": {"type": "number"},
                "refreshRate": {"type": ["integer", "null"]},
                "pageProcess": {"type": "integer"},
                "quitting": {"type": "boolean"},
                "maximized": {"type": "boolean"},
                "key": {"type": "boolean"},
                "active": {"type": "boolean"},
                "occluded": {"type": "boolean"},
                "children": {"type": "integer"},
                "controls": {"type": "array", "items": rect},
                "webviews": {"type": "array", "items": {"type": "object", "properties": {
                    "frame": rect, "main": {"type": "boolean"}, "document": {"type": "boolean"},
                    "visible": {"type": "boolean"}, "focused": {"type": "boolean"}, "order": {"type": "integer"}}}},
                "surfaces": {"type": "array", "items": {"type": "object", "properties": {
                    "id": {"type": "string"}, "frame": rect,
                    "visible": {"type": "boolean"}, "order": {"type": "integer"}}}},
                "documents": {"type": "array", "items": {"type": "object", "properties": {
                    "surface": {"type": "string"}, "document": {"type": "string"}, "frame": rect,
                    "visible": {"type": "boolean"}, "focused": {"type": "boolean"}, "order": {"type": "integer"},
                    "process": {"type": "integer"}}}},
                "regions": {"type": "array", "items": {"type": "object", "properties": {
                    "surface": {"type": "string"}, "name": {"type": "string"}, "frame": rect,
                    "visible": {"type": "boolean"}, "focused": {"type": "boolean"},
                    "presented": {"type": ["object", "null"], "properties": {
                        "sequence": {"type": "integer"}, "generation": {"type": "integer"}, "raster": {"type": "integer"},
                        "width": {"type": "integer"}, "height": {"type": "integer"}, "scale": {"type": "number"}}},
                    "error": {"type": ["string", "null"]}}}},
                "modal": {"type": "object", "properties": {
                    "id": {"type": "string"}, "mode": {"type": "string"},
                    "shown": {"type": "boolean"}, "frame": rect, "order": {"type": "integer"},
                    "background": {"type": "object", "properties": {
                        "draws": {"type": "boolean"}, "alpha": {"type": "number"}}}}},
            }},
        }, {
            "name": "host.windows",
            "description": "The windows of the application in the windows.list format.",
            "schema": {"type": "array", "items": {"type": "object", "properties": {
                "window": {"type": "string"}, "title": {"type": "string"},
                "project": {"type": "string"}, "key": {"type": "boolean"}, "ready": {"type": "boolean"}}}},
        }],
        "commands": [
            {"name": "host.dock.select", "description": "Performs the Dock menu item with the title.",
             "params": {"type": "object", "properties": {"title": {"type": "string"}}}, "result": nothing},
            {"name": "host.hit", "description": "Returns the owner and native hit-view class and frame of a point in window coordinates.",
             "params": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}}},
             "result": {"type": "object", "properties": {
                 "kind": {"type": "string", "enum": ["page", "document", "native"]},
                 "surface": {"type": "string"}, "document": {"type": "string"},
                 "identifier": {"type": "string"},
                 "view": {"type": ["object", "null"], "properties": {
                     "class": {"type": "string"}, "frame": rect}}}}},
            {"name": "host.menu.select", "description": "Performs the application menu item with the title in the submenu with the menu title.",
             "params": {"type": "object", "properties": {"menu": {"type": "string"}, "title": {"type": "string"}}}, "result": nothing},
            {"name": "host.quit", "description": "Requests normal application termination, including pending saves.",
             "params": empty, "result": nothing},
            {"name": "host.window.close", "description": "Closes the window through its normal close action.",
             "params": empty, "result": nothing},
            {"name": "host.window.fullscreen", "description": "Enters full screen, or leaves it with on false.",
             "params": {"type": "object", "properties": {"on": {"type": "boolean"}}}, "result": nothing},
            {"name": "host.window.maximize", "description": "Maximizes the window, or restores it with on false.",
             "params": {"type": "object", "properties": {"on": {"type": "boolean"}}}, "result": nothing},
            {"name": "host.window.move", "description": "Moves the window frame origin to a point in screen coordinates.",
             "params": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}}},
             "result": nothing},
            {"name": "host.window.presented", "description": "Resolves after the main page, visible application documents, and visible image regions have presented their current geometry and raster, with the display time of that frame.",
             "params": empty, "result": {"type": "object", "properties": {"displayed": {"type": "number"}}}},
            {"name": "host.window.reload", "description": "Reloads the main page.",
             "params": empty, "result": nothing},
            {"name": "host.window.resize", "description": "Resizes the content area.",
             "params": {"type": "object", "properties": {"width": {"type": "number"}, "height": {"type": "number"}}},
             "result": nothing},
        ],
        "dom": [],
    })
}

/// Checks that the name whose owner is host is declared for this request method. An undeclared name is 1001.
pub fn check_host_name(method: &str, name: &str) -> Result<(), Failure> {
    let kind = match method {
        "status.get" | "status.watch" | "status.unwatch" | "status.next" => "status",
        "command.run" => "commands",
        _ => "",
    };
    let declared = host_declarations();
    let listed = declared[kind]
        .as_array()
        .is_some_and(|entries| entries.iter().any(|entry| entry["name"] == name));
    if listed {
        Ok(())
    } else {
        Err(Failure::new(
            UNKNOWN_NAME,
            format!("{name} is not declared"),
        ))
    }
}

/// Adds the host entries to the exposure.list that the page sent. The page entries stay as the received text, and each
/// kind is written in name order (the same as the Wails host).
pub fn with_host_entries(listed: &RawValue) -> Result<Box<RawValue>, Failure> {
    let Ok(mut lists) = serde_json::from_str::<BTreeMap<String, Vec<Box<RawValue>>>>(listed.get())
    else {
        return Err(Failure::new(
            -32603,
            "the page returned an exposure list that is not an object of arrays",
        ));
    };
    let Value::Object(declared) = host_declarations() else {
        unreachable!("host declarations are an object")
    };
    for (kind, entries) in declared {
        let Some(entries) = entries.as_array().cloned() else {
            return Err(Failure::new(
                -32603,
                format!("the host declarations of {kind} are not an array"),
            ));
        };
        let target = lists.entry(kind).or_default();
        for mut entry in entries {
            entry["registered"] = Value::Bool(true);
            target.push(raw(&entry)?);
        }
    }
    serde_json::value::to_raw_value(&lists).map_err(|error| Failure::new(-32603, error.to_string()))
}

fn number(params: &Map<String, Value>, name: &str) -> Result<f64, Failure> {
    params
        .get(name)
        .and_then(Value::as_f64)
        .ok_or_else(|| Failure::params(format!("{name} must be a number")))
}

fn optional_number(params: &Map<String, Value>, name: &str) -> Result<f64, Failure> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(0.0),
        Some(_) => number(params, name),
    }
}

/// Builds the message of error 1007. It states the mask of the rejected press and the frontmost application
/// (docs/spec/exposure.md).
pub fn button_held_message(held: &ButtonHeld) -> String {
    let frontmost = match &held.frontmost {
        None => "no application".to_string(),
        Some(FrontmostApplication {
            bundle_identifier: None,
            pid,
        }) => format!("an application without a bundle identifier (pid {pid})"),
        Some(FrontmostApplication {
            bundle_identifier: Some(bundle),
            pid,
        }) => format!("{bundle} (pid {pid})"),
    };
    format!(
        "AppKit reports NSEvent.pressedMouseButtons mask {:#x} while {frontmost} is frontmost; the synthetic press or release was not delivered",
        held.mask
    )
}

/// Reads the parameters of `input.pointer`.
pub fn pointer(params: &Map<String, Value>) -> Result<Pointer, Failure> {
    let phase = match params.get("phase").and_then(Value::as_str) {
        Some("move") => 0,
        Some("down") => 1,
        Some("drag") => 2,
        Some("up") => 3,
        Some("scroll") => 4,
        _ => {
            return Err(Failure::params(
                "phase must be move, down, drag, up, or scroll",
            ));
        }
    };
    let button = match params.get("button") {
        None | Some(Value::Null) => 0,
        Some(Value::String(button)) if button == "left" => 0,
        Some(Value::String(button)) if button == "right" => 1,
        Some(_) => return Err(Failure::params("button must be left or right")),
    };
    let activate = match params.get("activate") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(activate)) => *activate,
        Some(_) => return Err(Failure::params("activate must be a boolean")),
    };
    if activate && phase != 0 {
        return Err(Failure::params("activate applies only to phase move"));
    }
    Ok(Pointer {
        x: number(params, "x")?,
        y: number(params, "y")?,
        phase,
        button,
        delta_x: optional_number(params, "deltaX")?,
        delta_y: optional_number(params, "deltaY")?,
        activate,
    })
}

/// Reads the parameters of `input.key`.
pub fn key(params: &Map<String, Value>) -> Result<Key, Failure> {
    let key = match params.get("key") {
        Some(Value::String(key)) if !key.is_empty() => key.clone(),
        _ => return Err(Failure::params("key must be a non-empty string")),
    };
    let text = match params.get("text") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return Err(Failure::params("text must be a string")),
    };
    let mut modifiers = 0;
    match params.get("modifiers") {
        None | Some(Value::Null) => {}
        Some(Value::Array(names)) => {
            for name in names {
                modifiers |= match name.as_str() {
                    Some("shift") => 1,
                    Some("control") => 2,
                    Some("option") => 4,
                    Some("command") => 8,
                    _ => return Err(Failure::params(format!("unknown modifier {name}"))),
                };
            }
        }
        Some(_) => {
            return Err(Failure::params(
                "modifiers must be an array of shift, control, option, command",
            ));
        }
    }
    let down = match params.get("phase").and_then(Value::as_str) {
        Some("down") => true,
        Some("up") => false,
        _ => return Err(Failure::params("phase must be down or up")),
    };
    Ok(Key {
        key,
        text,
        modifiers,
        down,
    })
}

type Waiting = (String, Sender<Result<Box<RawValue>, Failure>>);

pub use crate::endpoint::raw;

/// Converts a response text into a value that the host reads.
pub fn parsed(text: &RawValue) -> Result<Value, Failure> {
    serde_json::from_str(text.get()).map_err(|error| Failure::new(-32603, error.to_string()))
}

/// The response `{id, result}` or `{id, error}` that the page sent. result stays as the received text.
#[derive(Deserialize)]
struct Answer {
    id: Option<u64>,
    #[serde(default)]
    result: Option<Box<RawValue>>,
    #[serde(default)]
    error: Option<Value>,
}

/// The correspondence between the requests sent to documents and their responses.
#[derive(Default)]
pub struct Relay {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Waiting>>,
    /// The recent requests that timed out. To state the delay of a late reply in its error, up to EXPIRED_LIMIT of them are
    /// kept and the oldest is discarded (docs/spec/exposure.md#errors).
    expired: Mutex<std::collections::VecDeque<Expired>>,
}

/// The number of timed-out requests that are kept for late replies.
const EXPIRED_LIMIT: usize = 256;

/// The plugin command that a request carries. A request without one writes no call event.
#[derive(Clone)]
pub struct RelayCall {
    pub plugin: String,
    pub command: String,
}

/// A request that timed out: its id, document, send time, time limit and the command it carries, if any.
struct Expired {
    id: u64,
    target: String,
    sent: Instant,
    timeout: Duration,
    call: Option<RelayCall>,
}

#[cfg(feature = "diagnostics")]
impl Relay {
    /// Returns the number of requests that wait for a reply from target.
    pub fn pending_count(&self, target: &str) -> usize {
        self.pending
            .lock()
            // default: a lock that a panicking thread poisoned still holds the waiting requests, which are only read;
            // the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .filter(|(waiting, _)| waiting == target)
            .count()
    }
}

/// Returns the number of subscriptions to the notifications of window. It is 0 before the endpoint starts.
#[cfg(feature = "diagnostics")]
pub(crate) fn subscribers(window: &Window) -> usize {
    window
        .state::<Exposure>()
        .endpoint
        .get()
        .map_or(0, |endpoint| {
            endpoint.notifier().subscribers(window.label())
        })
}

impl Relay {
    /// Sends the request id to the document target with send, and waits for the response of target for timeout. When
    /// timeout is None, it waits for the response or the end of the document. When send fails, the document is treated
    /// as absent.
    pub fn request(
        &self,
        target: &str,
        timeout: Option<Duration>,
        send: impl FnOnce(u64) -> Result<(), String>,
    ) -> Result<Box<RawValue>, Failure> {
        self.request_call(target, None, timeout, send)
    }

    /// The same as request for a request that carries call. A time limit that passes writes the event `host.call.timeout`, and a
    /// late reply to it writes `host.trace.call.late-reply`.
    pub fn request_call(
        &self,
        target: &str,
        call: Option<RelayCall>,
        timeout: Option<Duration>,
        send: impl FnOnce(u64) -> Result<(), String>,
    ) -> Result<Box<RawValue>, Failure> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            // default: a lock that a panicking thread poisoned still holds the request, which this call registers; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, (target.to_string(), tx));
        let sent = std::time::Instant::now();
        if let Err(error) = send(id) {
            self.forget(id);
            return Err(Failure::new(MISSING_DOCUMENT, error));
        }
        let Some(timeout) = timeout else {
            // default: when the side that would send the reply is gone, the document is closed, so the request answers
            // with that error.
            return rx.recv().unwrap_or_else(|_| {
                Err(Failure::new(MISSING_DOCUMENT, format!("{target} closed")))
            });
        };
        match rx.recv_timeout(timeout) {
            Ok(outcome) => outcome,
            Err(_) => {
                let taken = self
                    .pending
                    .lock()
                    // default: a lock that a panicking thread poisoned still holds the request, which the time limit
                    // removes; the panic hook records the panic.
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&id)
                    .is_none();
                if taken {
                    // If a reply took the request at the same time as the time limit, that reply is delivered next.
                    return rx
                        .recv()
                        .map_err(|_| Failure::new(MISSING_DOCUMENT, format!("{target} closed")))?;
                }
                let mut expired = self
                    .expired
                    .lock()
                    // default: a lock that a panicking thread poisoned still holds the expired requests, which the time
                    // limit records; the panic hook records the panic.
                    .unwrap_or_else(PoisonError::into_inner);
                if expired.len() == EXPIRED_LIMIT {
                    // The oldest entry is forgotten: a late reply to it has no matching request. The loss is counted.
                    expired.pop_front();
                    record_buffer_drop(
                        "relay expired requests",
                        0,
                        &format!("{EXPIRED_LIMIT} requests"),
                    );
                }
                if let Some(call) = &call {
                    emit_host(
                        Level::Error,
                        "host.call.timeout",
                        json!({"plugin": call.plugin, "command": call.command}),
                    );
                }
                expired.push_back(Expired {
                    id,
                    target: target.to_string(),
                    sent,
                    timeout,
                    call,
                });
                Err(Failure::new(
                    TIMED_OUT,
                    format!(
                        "the document did not reply within {} ms",
                        timeout.as_millis()
                    ),
                ))
            }
        }
    }

    /// Delivers the response `{id, result}` or `{id, error}` of the document from to the request that waits for it. It
    /// returns true when delivered. The id of a request sent to another document is not delivered. result is delivered
    /// as the received text, so the key order of the page value does not change.
    pub fn reply(&self, from: &str, payload: &RawValue) -> Result<(), String> {
        let Answer { id, result, error } =
            serde_json::from_str::<Answer>(payload.get()).map_err(|error| error.to_string())?;
        let id = id.ok_or("exposure reply has no id")?;
        let waiting = {
            // default: a lock that a panicking thread poisoned still holds the request, which the reply removes; the
            // panic hook records the panic.
            let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
            if pending.get(&id).is_some_and(|(target, _)| target == from) {
                pending.remove(&id)
            } else {
                None
            }
        };
        let Some((_, tx)) = waiting else {
            return Err(self.unmatched(id, from)?);
        };
        let outcome = match error {
            Some(error) if !error.is_null() => Err(Failure::new(
                // default: a page error without a code is reported as a JSON-RPC internal error (-32603).
                error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    // default: a page error without a message is reported as the same error with a generic message.
                    .unwrap_or("the document failed"),
            )),
            // default: the reply of a command that returned no value has no result, and its result is null.
            _ => result.map_or_else(|| raw(&Value::Null), Ok),
        };
        tx.send(outcome)
            .map_err(|_| format!("exposure reply {id} has no matching request"))
    }

    /// The error of a reply id that no request waits for. For a request that timed out, it states the delay after
    /// sending and the time limit.
    fn unmatched(&self, id: u64, from: &str) -> Result<String, String> {
        // default: a lock that a panicking thread poisoned still holds the expired requests, which the reply reads; the
        // panic hook records the panic.
        let mut expired = self.expired.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(index) = expired
            .iter()
            .position(|held| held.id == id && held.target == from)
        else {
            return Ok(format!("exposure reply {id} has no matching request"));
        };
        let Expired {
            sent,
            timeout,
            call,
            ..
        } = expired.remove(index).expect("the position is in the queue");
        let delay = sent.elapsed().as_millis();
        if let Some(call) = call {
            emit_host(
                Level::Debug,
                "host.trace.call.late-reply",
                json!({"plugin": call.plugin, "command": call.command, "delay": delay as u64}),
            );
        }
        Ok(format!(
            "exposure reply {id} arrived {delay} ms after it was sent; its request timed out after {} ms",
            timeout.as_millis()
        ))
    }

    /// Ends every request sent to the document target with error 1003.
    pub fn abandon(&self, target: &str) {
        self.abandon_matching(|held| held == target);
    }

    fn abandon_matching(&self, closed: impl Fn(&str) -> bool) {
        // default: a lock that a panicking thread poisoned still holds the waiting requests, and each one must be answered
        // so that its caller does not wait; the panic hook records the panic.
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        let ids: Vec<u64> = pending
            .iter()
            .filter(|(_, (target, _))| closed(target))
            .map(|(id, _)| *id)
            .collect();
        let gone: Vec<Waiting> = ids
            .into_iter()
            .filter_map(|id| pending.remove(&id))
            .collect();
        drop(pending);
        for (target, tx) in gone {
            if tx
                .send(Err(Failure::new(
                    MISSING_DOCUMENT,
                    format!("{target} closed"),
                )))
                .is_err()
            {
                crate::application_log::log_info(
                    "exposure",
                    format!("closed-document failure of {target} arrived after its request ended"),
                );
            }
        }
    }

    fn forget(&self, id: u64) {
        self.pending
            .lock()
            // default: a lock that a panicking thread poisoned still holds the waiting requests, and the request that ended is
            // removed from them; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    }
}

/// The endpoint of the application, the relay, and the host.window value that was sent last.
#[derive(Default)]
pub(crate) struct Exposure {
    pub relay: Relay,
    endpoint: OnceLock<Endpoint>,
    reported: Mutex<HashMap<String, Value>>,
}

/// Opens the endpoint. publish writes endpoint.json.
pub(crate) fn start(app: &AppHandle, directory: &std::path::Path) -> Result<(), String> {
    let endpoint = Endpoint::start(
        &crate::endpoint::socket_directory(),
        directory,
        APPLICATION,
        Arc::new(Host(app.clone())),
    )?;
    app.state::<Exposure>()
        .endpoint
        .set(endpoint)
        .map_err(|_| "the endpoint is already started".to_string())
}

/// The owner that an earlier run left in process.lock without removing it, or None when the endpoint is not started.
pub(crate) fn unrecorded_end(app: &AppHandle) -> Option<crate::endpoint::UnrecordedEnd> {
    app.state::<Exposure>()
        .endpoint
        .get()
        .and_then(|endpoint| endpoint.unrecorded_end().cloned())
}

/// Writes endpoint.json after the first window window is registered.
pub(crate) fn publish(app: &AppHandle, window: &str) -> Result<(), String> {
    app.state::<Exposure>()
        .endpoint
        .get()
        .ok_or("the endpoint is not started")?
        .publish(window)
}

/// Closes the endpoint and removes the socket and endpoint.json.
pub(crate) fn stop(app: &AppHandle) {
    if let Some(endpoint) = app.state::<Exposure>().endpoint.get() {
        endpoint.stop();
    }
}

/// Writes one line of the diagnostic record to the application log and also sends it to the connections that requested
/// the record of the window window.
pub(crate) fn note(window: &Window, line: &str) {
    crate::application_log::transcript_entry(window.label(), line).log();
    log(window, line);
}

/// Sends one line to the connections that requested the record of the window window.
/// Without a diagnostic build there is no place to send it to.
#[cfg(feature = "diagnostics")]
pub(crate) fn log(window: &Window, line: &str) {
    if let Some(endpoint) = window.state::<Exposure>().endpoint.get() {
        endpoint.notifier().log(window.label(), line);
    }
}
#[cfg(not(feature = "diagnostics"))]
pub(crate) fn log(_window: &Window, _line: &str) {}

/// An operation that targets a surface is called only by the main page of the window. caller is the calling webview and
/// window is the label of the window; the webview label of the main page equals the window label. A call from another
/// webview is rejected.
pub fn authorize_main_caller(caller: &str, window: &str, operation: &str) -> Result<(), String> {
    if caller != window {
        return Err(format!(
            "{operation} must come from the main webview of {window}, not {caller}"
        ));
    }
    Ok(())
}

/// Checks that the webview that called the command is the main page of the window.
fn main_page(webview: &Webview) -> Result<Window, String> {
    let window = webview.window();
    authorize_main_caller(webview.label(), window.label(), "exposure operations")?;
    Ok(window)
}

fn emit_to(app: &AppHandle, label: &str, event: &str, payload: Value) -> Result<(), String> {
    app.emit_to(EventTarget::webview(label), event, payload)
        .map_err(|e| e.to_string())
}

/// The observation line of a late reply that a removed surface sent.
pub fn removed_surface_reply(id: u64, surface: &str) -> String {
    format!("exposure reply {id} of removed surface {surface:?} arrived after its request ended")
}

/// Delivers the response of the calling document to the request that waits for it. A response after the time limit is
/// discarded.
pub fn reply_target(window: &str, request: &Value) -> Result<String, String> {
    match request.get("surface") {
        None => Ok(window.to_string()),
        Some(Value::String(surface)) if !surface.is_empty() => {
            Ok(format!("surface-{window}-{surface}"))
        }
        Some(_) => Err("exposure reply surface must be a nonempty string".into()),
    }
}

/// Delivers the response text of a document to the request that waits for it. The text is relayed as received and is
/// read only to choose the document that sent the response.
pub(crate) fn reply(webview: &Webview, request: String) -> Result<(), String> {
    let window = main_page(webview)?;
    let text = RawValue::from_string(request)
        .map_err(|error| format!("exposure reply is not JSON: {error}"))?;
    let routing: Value = serde_json::from_str(text.get()).map_err(|error| error.to_string())?;
    let target = reply_target(window.label(), &routing)?;
    if let Some(surface) = routing.get("surface").and_then(Value::as_str)
        && !crate::surfaces::surface_attached(&window, surface)?
    {
        // When a surface is removed, the requests of that surface have already ended with 1003. A late reply is
        // discarded because no request is left to answer, and it is left as an observation (docs/spec/exposure.md).
        let id = routing
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("exposure reply has no id")?;
        crate::application_log::log_info("exposure", removed_surface_reply(id, surface));
        return Ok(());
    }
    webview.state::<Exposure>().relay.reply(&target, &text)
}

#[derive(Deserialize)]
pub struct Changed {
    name: String,
    #[serde(default)]
    surface: Option<String>,
    /// The JSON text of the value that the page sent. It is sent to the connections without changing the key order. A
    /// change without a value is a change whose value is null.
    #[serde(default)]
    value: Option<String>,
}

/// Checks that the page can send a state change of the name name. Only the host changes host state.
pub fn check_page_status_change(name: &str) -> Result<(), String> {
    if name.starts_with("host.") {
        return Err(format!("the page cannot change host status {name}"));
    }
    Ok(())
}

/// Sends a state change that the main page sent to the connections that watch it.
pub(crate) fn changed(webview: &Webview, request: Changed) -> Result<(), String> {
    let window = main_page(webview)?;
    check_page_status_change(&request.name)?;
    let text = match request.value {
        Some(text) => text,
        None => "null".to_string(),
    };
    let value = RawValue::from_string(text)
        .map_err(|error| format!("status {} value is not JSON: {error}", request.name))?;
    if let Some(endpoint) = window.state::<Exposure>().endpoint.get() {
        endpoint.notifier().changed(
            window.label(),
            &request.name,
            request.surface.as_deref(),
            &value,
        );
    }
    Ok(())
}

#[derive(Deserialize)]
pub(crate) struct Forward {
    surface: String,
    method: String,
    #[serde(default)]
    params: Value,
    /// The time limit of this request (ms). It is 10 seconds when absent. The page passes the timeout of the
    /// declaration.
    #[serde(default)]
    timeout: Value,
}

/// The longest time limit that a forward request can specify (ms).
const MAX_FORWARD_TIMEOUT: u64 = 600_000;

/// Sets the time limit of a forward request. status.next does not answer until the value changes, so it has no time
/// limit (None) and accepts no timeout. timeout is an integer in ms from 1 to 600000.
pub fn forward_timeout(method: &str, timeout: &Value) -> Result<Option<Duration>, Failure> {
    if timeout.is_null() {
        return Ok((method != "status.next").then_some(TIMEOUT));
    }
    if method == "status.next" {
        return Err(Failure::params("status.next has no timeout"));
    }
    let ms = timeout
        .as_f64()
        .filter(|ms| ms.fract() == 0.0 && *ms >= 1.0 && *ms <= MAX_FORWARD_TIMEOUT as f64)
        .ok_or_else(|| {
            Failure::params(format!(
                "timeout must be an integer from 1 to {MAX_FORWARD_TIMEOUT} milliseconds"
            ))
        })?;
    Ok(Some(Duration::from_millis(ms as u64)))
}

/// Sends a request of the main page to a surface page and returns the response as `{result}` or `{error}`. result is
/// the text that the surface page sent, as received.
pub(crate) fn forward(webview: &Webview, request: Forward) -> Result<Box<RawValue>, String> {
    let window = main_page(webview)?;
    let label = label_for(&window, &request.surface);
    let app = window.app_handle().clone();
    let surface_exists = crate::surfaces::surface_handle(&window, &request.surface).is_ok();
    // A surface that declared its composition has its plugin (surfaces.rs checks it), so the call names that plugin.
    let call = window_data(&window)?
        .surface_plugins
        .lock()
        // default: a lock that a panicking thread poisoned still holds the surface plugins, which are only read; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(&request.surface)
        .map(|plugin| RelayCall {
            plugin: plugin.clone(),
            command: request.method.clone(),
        });
    let outcome = match forward_timeout(&request.method, &request.timeout) {
		Err(invalid) => Err(invalid),
		Ok(_) if !surface_exists => Err(Failure::new(
			MISSING_DOCUMENT,
			format!("surface {} does not exist", request.surface),
		)),
        // status.next has no time limit. When the surface closes, it ends with 1003.
        Ok(timeout) => window
            .state::<Exposure>()
			.relay
			.request_call(&label, call, timeout, |id| {
				emit_to(
					&app,
					window.label(),
					"exposure-request",
					json!({"id": id, "surface": request.surface, "method": request.method, "params": request.params}),
				)
			}),
    };
    let text = match outcome {
        Ok(result) => format!(r#"{{"result":{}}}"#, result.get()),
        Err(error) => json!({"error": error}).to_string(),
    };
    RawValue::from_string(text).map_err(|error| error.to_string())
}

#[derive(Deserialize)]
pub(crate) struct Register {
    surface: String,
    kind: String,
    name: String,
}

/// Verifies a registration caller: either the page view of the surface itself (surface_label is the label of that
/// surface view), or the main page of the window registering for a surface with a view. The page of a view has no
/// surface bridge of its own, so the main page relays its registration (docs/spec/exposure.md#relay).
pub fn check_registration_caller(
    caller: &str,
    surface_label: &str,
    requested: &str,
    caller_is_main_page: bool,
    has_view: bool,
) -> Result<(), String> {
    if caller == surface_label {
        return Ok(());
    }
    if caller_is_main_page && has_view {
        return Ok(());
    }
    Err(format!("{caller} cannot register for surface {requested}"))
}

/// Passes the registration of a surface page to the main page. A surface page registers only with its own surface id;
/// the main page relays the registration of a view page (docs/spec/exposure.md#relay).
pub(crate) fn register(webview: &Webview, request: Register) -> Result<(), String> {
    let window = webview.window();
    let caller = webview.label();
    let caller_is_main_page = caller == window.label();
    let has_view = caller_is_main_page && {
        // default: a window whose data is not available holds no view, so the check below refuses the relay of
        // the main page with its own error.
        let data = window_data(&window).ok();
        data.is_some_and(|data| data.documents.views().has(&request.surface))
    };
    check_registration_caller(
        caller,
        &label_for(&window, &request.surface),
        &request.surface,
        caller_is_main_page,
        has_view,
    )?;
    if !matches!(request.kind.as_str(), "status" | "command" | "dom") {
        return Err(format!("unknown exposure kind {}", request.kind));
    }
    // The only core names that a surface registers are core.surface.* (docs/spec/exposure.md).
    let name = &request.name;
    let core = name.starts_with("core.") && !name.starts_with("core.surface.");
    if !crate::endpoint::valid_name(name) || name.starts_with("host.") || core {
        return Err(format!("a surface cannot register {name:?}"));
    }
    let entry = (
        request.surface.clone(),
        request.kind.clone(),
        request.name.clone(),
    );
    {
        let data = window_data(&window)?;
        let mut registrations = data
            .registrations
            .lock()
            // default: a lock that a panicking thread poisoned still holds the registrations, which this call amends; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        if !registrations.contains(&entry) {
            registrations.push(entry);
        }
    }
    emit_to(
        window.app_handle(),
        window.label(),
        "exposure-registered",
        json!({"surface": request.surface, "kind": request.kind, "name": request.name}),
    )
}

/// Notifies the reloaded main page again of the registrations of the surface pages. A surface remains when the main
/// page is reloaded, so the new page receives the registrations that the previous page received through this call.
pub(crate) fn replay_registrations(window: &Window) {
    let Ok(data) = window_data(window) else {
        return;
    };
    let registrations = data
        .registrations
        .lock()
        // default: a lock that a panicking thread poisoned still holds the registrations, which are only copied; the panic hook
        // records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    for (surface, kind, name) in registrations {
        if let Err(error) = emit_to(
            window.app_handle(),
            window.label(),
            "exposure-registered",
            json!({"surface": surface, "kind": kind, "name": name}),
        ) {
            log_error("exposure-registered", error);
        }
    }
}

/// Removes the registrations and the pending requests of a surface page when it closes or reloads.
pub(crate) fn surface_closed(window: &Window, surface: &str) {
    window
        .state::<Exposure>()
        .relay
        .abandon(&label_for(window, surface));
    if let Ok(data) = window_data(window) {
        data.registrations
            .lock()
            // default: a lock that a panicking thread poisoned still holds the registrations, and the registrations of a closed
            // surface are removed from them; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|(owner, _, _)| owner != surface);
    }
    if let Err(error) = emit_to(
        window.app_handle(),
        window.label(),
        "exposure-registered",
        json!({"surface": surface, "closed": true}),
    ) {
        log_error("exposure-registered", error);
    }
}

/// Ends the requests sent to the main page when it reloads.
pub(crate) fn page_reloaded(window: &Window) {
    window.state::<Exposure>().relay.abandon(window.label());
    windows_changed(window.app_handle());
}

/// Requests the watches and the diagnostic record of this window again from the reloaded main page. The page calls it
/// after it reports that it is ready.
pub(crate) fn rewatch(window: &Window) {
    let Some(notifier) = window
        .state::<Exposure>()
        .endpoint
        .get()
        .map(Endpoint::notifier)
    else {
        return;
    };
    let window = window.clone();
    crate::routine::spawn_named("window-watches", move || {
        let host = Host(window.app_handle().clone());
        for watch in notifier.watches(window.label()) {
            if watch.name.starts_with("host.") {
                continue;
            }
            if let Err(error) = host.page(&window, "status.watch", watch.params(), TIMEOUT) {
                log(
                    &window,
                    &format!("rewatch {}: {}", watch.name, error.message),
                );
            }
        }
        #[cfg(feature = "diagnostics")]
        if notifier.transcribed(window.label()) {
            let mut params = Map::new();
            params.insert("on".into(), Value::Bool(true));
            if let Err(error) = host.page(&window, "diagnostics.transcript", params, TIMEOUT) {
                log(
                    &window,
                    &format!("rewatch diagnostics.log: {}", error.message),
                );
            }
        }
    });
}

/// When the window closes, ends the requests sent to the documents of the window and removes the state record of the
/// window.
pub(crate) fn window_closed(window: &Window) {
    let state = window.state::<Exposure>();
    let main = window.label().to_string();
    let surfaces = format!("surface-{main}-");
    state
        .relay
        .abandon_matching(|target| target == main || target.starts_with(&surfaces));
    state
        .reported
        .lock()
        // default: a lock that a panicking thread poisoned still holds the record of the values sent, and the record of the closed
        // window is removed from it; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&main);
}

/// Called when the window list may have changed. Sends the windows.list result to each window that watches
/// host.windows. The window list locks the window registry, so it is read on a separate thread.
pub(crate) fn windows_changed(app: &AppHandle) {
    let app = app.clone();
    crate::routine::spawn_named("windows-changed", move || {
        let Some(notifier) = app
            .state::<Exposure>()
            .endpoint
            .get()
            .map(Endpoint::notifier)
        else {
            return;
        };
        let list = match windows::list(&app) {
            Ok(list) => list,
            Err(error) => {
                log_error("host.windows", error);
                return;
            }
        };
        let Some(entries) = list.as_array().cloned() else {
            log_error(
                "host.windows",
                format!("the window list is not an array: {list}"),
            );
            return;
        };
        for entry in entries {
            let Some(window) = entry["window"].as_str() else {
                continue;
            };
            if notifier.watched(window, "host.windows") {
                match raw(&list) {
                    Ok(text) => notifier.changed(window, "host.windows", None, &text),
                    Err(error) => log_error("host.windows change", error.message),
                }
            }
        }
    });
}

/// Sends the value of host.log to the connections that watch it. A write of the endpoint can wait for a connection, so the publisher of
/// the notices, which runs on its own thread, is the caller.
pub(crate) fn log_notice_changed(app: &AppHandle, notice: &crate::debug_follow::LogNotice) {
    let Some(notifier) = app
        .state::<Exposure>()
        .endpoint
        .get()
        .map(Endpoint::notifier)
    else {
        log_error("host.log change", "the endpoint is not started");
        return;
    };
    match raw(&json!(notice)) {
        Ok(text) => notifier.notify_watchers("host.log", &text),
        Err(error) => log_error("host.log change", error.message),
    }
}

/// Installs the watch of host.buttons. A changed value is sent to the watching connections by one thread in the order
/// received. A write of the endpoint can wait for a connection, so it is not sent from the main thread. It is called
/// before endpoint.json is written on the main thread (docs/spec/exposure.md#host-entries).
pub(crate) fn watch_buttons(app: &AppHandle) -> Result<(), String> {
    let (send, receive) = mpsc::channel::<Value>();
    let notifying = app.clone();
    crate::routine::spawn_named("button-watch", move || {
        for value in receive {
            let Some(notifier) = notifying
                .state::<Exposure>()
                .endpoint
                .get()
                .map(Endpoint::notifier)
            else {
                log_error("host.buttons change", "the endpoint is not started");
                continue;
            };
            match raw(&value) {
                Ok(text) => notifier.notify_watchers("host.buttons", &text),
                Err(error) => log_error("host.buttons change", error.message),
            }
        }
    });
    let send = Mutex::new(send);
    app.manage(crate::buttons::Buttons::new(move |value| {
        let sender = send.lock();
        // default: a lock that a panicking thread poisoned still holds the sender, which has no state a panic can leave inconsistent; the panic hook records the panic.
        let sender = sender.unwrap_or_else(PoisonError::into_inner);
        let sent = sender.send(value).map_err(|error| error.to_string());
        if let Err(error) = sent {
            log_error("host.buttons change", error);
        }
    }));
    let reporting = app.clone();
    platform::current()?
        .watch_buttons(Box::new(move |mask| {
            reporting.state::<crate::buttons::Buttons>().report(mask)
        }))
        .map_err(|error| format!("mouse buttons: {error}"))
}

/// The current value of host.sidecars.
/// The value of the host status name of window for the debug view: `host.window`, `host.sidecars` or `host.screens`
/// (docs/spec/debug.md).
pub(crate) fn host_status(window: &Window, name: &str) -> Result<Value, String> {
    match name {
        "host.window" => window_status(window).map_err(|failure| failure.message),
        "host.sidecars" => Ok(sidecars_status(window.app_handle())),
        "host.screens" => {
            let platform = platform::current()?;
            on_main(window, move || platform.screens())
        }
        other => Err(format!(
            "debug: {other} is not a host status of the debug view"
        )),
    }
}

fn sidecars_status(app: &AppHandle) -> Value {
    let sidecars = app.state::<crate::sidecars::WindowSidecars>();
    json!({ "closing": sidecars.closing(), "outdated": sidecars.outdated() })
}

/// Called when host.sidecars changed. Sends the new value to each watching window. The window list locks the window
/// registry, so it is read on a separate thread.
pub(crate) fn sidecars_changed(app: &AppHandle) {
    let app = app.clone();
    crate::routine::spawn_named("sidecars-changed", move || {
        windows::notify_sidecars(&app);
        let Some(notifier) = app
            .state::<Exposure>()
            .endpoint
            .get()
            .map(Endpoint::notifier)
        else {
            return;
        };
        let value = sidecars_status(&app);
        let list = match windows::list(&app) {
            Ok(list) => list,
            Err(error) => {
                log_error("host.sidecars", error);
                return;
            }
        };
        let Some(entries) = list.as_array().cloned() else {
            log_error(
                "host.sidecars",
                format!("the window list is not an array: {list}"),
            );
            return;
        };
        for entry in entries {
            let Some(window) = entry["window"].as_str() else {
                continue;
            };
            if notifier.watched(window, "host.sidecars") {
                match raw(&value) {
                    Ok(text) => notifier.changed(window, "host.sidecars", None, &text),
                    Err(error) => log_error("host.sidecars change", error.message),
                }
            }
        }
    });
}

/// Called when the host.window value of a window may have changed. If a connection watches it, the value is calculated
/// and sent when it differs from the value sent last. Native values are read on the main thread, so the calculation
/// runs on a separate thread.
pub(crate) fn window_changed(window: &Window) {
    let watched = window
        .state::<Exposure>()
        .endpoint
        .get()
        .is_some_and(|endpoint| endpoint.notifier().watched(window.label(), "host.window"));
    if !watched {
        trace_window_notify(window.label(), &WindowNotify::Unwatched);
        return;
    }
    let window = window.clone();
    crate::routine::spawn_named("window-status", move || {
        let value = match window_status(&window) {
            Ok(value) => value,
            // A failed read is logged, including the read of a window that closed before its state was read.
            Err(error) => {
                log_error("host.window", error.message);
                return;
            }
        };
        let state = window.state::<Exposure>();
        let Some(endpoint) = state.endpoint.get() else {
            return;
        };
        let decision = {
            let mut reported = state
                .reported
                .lock()
                // default: a lock that a panicking thread poisoned still holds the record of the values sent, which decides whether
                // the value is sent; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            // The watch is read under the lock of the record. A watch that ends before this read clears the record after
            // this decision, so the next watch receives the next value.
            let watched = endpoint.notifier().watched(window.label(), "host.window");
            decide_window_notify(&mut reported, window.label(), watched, &value)
        };
        trace_window_notify(window.label(), &decision);
        if let WindowNotify::Sent(value) = decision {
            match raw(&value) {
                Ok(text) => endpoint
                    .notifier()
                    .changed(window.label(), "host.window", None, &text),
                Err(error) => log_error("host.window change", error.message),
            }
        }
    });
}

/// The decision of one host.window notification for a window.
#[derive(Debug, PartialEq)]
pub(crate) enum WindowNotify {
    /// The value differs from the value sent last, and it is sent to the watching connections.
    Sent(Value),
    /// The value equals the value sent last, so nothing is sent.
    Unchanged,
    /// No connection watches host.window of the window, so nothing is sent and the record of the window is kept.
    Unwatched,
}

/// Decides whether the value of host.window of a window is sent. reported holds the value sent last for each window.
/// A value is sent when a connection watches the window and the value differs from the value sent last, and the sent
/// value is recorded.
pub(crate) fn decide_window_notify(
    reported: &mut HashMap<String, Value>,
    window: &str,
    watched: bool,
    value: &Value,
) -> WindowNotify {
    if !watched {
        return WindowNotify::Unwatched;
    }
    if reported.get(window) == Some(value) {
        return WindowNotify::Unchanged;
    }
    reported.insert(window.to_string(), value.clone());
    WindowNotify::Sent(value.clone())
}

/// Removes the value sent last for a window. It is called when the last connection that watches host.window of the window
/// stops watching, so that the next watch receives the value of the next change.
pub(crate) fn forget_window_notify(reported: &mut HashMap<String, Value>, window: &str) {
    reported.remove(window);
}

/// Stores the decision of a host.window notification as the trace event `host.trace.status.notify`.
fn trace_window_notify(window: &str, decision: &WindowNotify) {
    let decision = match decision {
        WindowNotify::Sent(_) => "sent",
        WindowNotify::Unchanged => "unchanged",
        WindowNotify::Unwatched => "unwatched",
    };
    emit_host(
        Level::Debug,
        "host.trace.status.notify",
        json!({"status": "host.window", "window": window, "decision": decision}),
    );
}

/// Called when the last connection stops watching host.window of a window: the record of the value sent last for the
/// window is removed.
pub(crate) fn window_unwatched(app: &AppHandle, window: &str) {
    let exposure = app.state::<Exposure>();
    let mut reported = exposure
        .reported
        .lock()
        // default: a lock that a panicking thread poisoned still holds the record of the value sent last for the window,
        // which this call removes; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    forget_window_notify(&mut reported, window);
}

#[cfg(test)]
#[path = "exposure_status_test.rs"]
mod status_test;

fn internal(error: impl ToString) -> Failure {
    Failure::new(-32603, error.to_string())
}

/// Returns the surface id that the registry names for a native surface view. A view without a registered surface fails
/// with an error that names the view address, which is the `view` of the window facts that locates the view.
pub fn registered_surface(
    named: &HashMap<platform::Handle, String>,
    view: platform::Handle,
) -> Result<&String, String> {
    named
        .get(&view)
        .ok_or_else(|| format!("unregistered native surface {view}"))
}

/// Converts the failure of an operation that wrote the native address of a window into an error with code. A window
/// that closed before the main-thread step of the operation is the same as a window that does not exist.
pub fn native_failure(window: &str, code: i64) -> impl Fn(NativeFailure) -> Failure + '_ {
    move |failure| match failure {
        NativeFailure::Closed => missing_window(window),
        NativeFailure::Failed(error) => Failure::new(code, error),
    }
}

/// Runs work on the main thread and waits for the result.
pub(crate) fn on_main<T: Send + 'static>(
    window: &Window,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    app_on_main(window.app_handle(), work)
}

/// Runs work on the main thread and waits for the result. When it is called on the main thread, it runs at once.
pub(crate) fn app_on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        match tx.send(work()) {
            Ok(()) => {}
            // A failure after the request ended was not reported by that request, so it is left as an error line.
            Err(mpsc::SendError(Err(error))) => log_error("main-thread work", error),
            Err(mpsc::SendError(Ok(_))) => crate::application_log::log_info(
                "exposure",
                "main-thread result arrived after its request ended",
            ),
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// Returns the main WebView through the AppKit main-thread executor.
///
/// The Tauri endpoint worker and the asynchronous commands cannot look up the WebView registry of a window directly. On
/// macOS the registry holds native WebKit objects, so even a read-only lookup runs on the main thread.
pub(crate) fn root_view_on_main(window: &Window) -> Result<Webview, String> {
    let target = window.clone();
    on_main(window, move || {
        crate::windows::root_view(&target).ok_or_else(|| "the main webview is gone".into())
    })
}

/// Receives the result of a webview task. When the webview is destroyed and discards the task without running it, the
/// sender disappears without a result, so the value is None. An error that the task sent is returned as it is.
pub fn received<T>(rx: &mpsc::Receiver<Result<T, String>>) -> Result<Option<T>, String> {
    match rx.recv() {
        Ok(result) => result.map(Some),
        Err(_) => Ok(None),
    }
}

/// Runs work with the native view of a webview. It is None when a closing webview does not run the task.
fn with_view_if_present<T: Send + 'static>(
    webview: &Webview,
    work: impl FnOnce(&tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
) -> Result<Option<T>, String> {
    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |view| {
            match tx.send(work(&view)) {
                Ok(()) => {}
                // A failure after the request ended was not reported by that request, so it is left as an error line.
                Err(mpsc::SendError(Err(error))) => log_error("webview work", error),
                Err(mpsc::SendError(Ok(_))) => crate::application_log::log_info(
                    "exposure",
                    "webview result arrived after its request ended",
                ),
            }
        })
        .map_err(|e| e.to_string())?;
    received(&rx)
}

/// Runs work with the native view of a webview and waits for the result.
pub(crate) fn with_view<T: Send + 'static>(
    webview: &Webview,
    work: impl FnOnce(&tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |view| {
            match tx.send(work(&view)) {
                Ok(()) => {}
                // A failure after the request ended was not reported by that request, so it is left as an error line.
                Err(mpsc::SendError(Err(error))) => log_error("webview work", error),
                Err(mpsc::SendError(Ok(_))) => crate::application_log::log_info(
                    "exposure",
                    "webview result arrived after its request ended",
                ),
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// Reads the WebContent processes of the page and of the document web views of a window for the sampler of the performance
/// trace. It reads the window status, which runs on the main thread, so it is called from a thread that is not the main thread.
pub(crate) fn window_processes(
    window: &Window,
) -> Result<crate::performance::WindowProcesses, String> {
    let status = window_status(window).map_err(|failure| failure.message)?;
    let page = status["pageProcess"]
        .as_u64()
        .ok_or("window status has no pageProcess")?;
    let documents = status["documents"]
        .as_array()
        .ok_or("window status has no documents")?
        .iter()
        .map(|document| {
            let surface = document["surface"]
                .as_str()
                .ok_or("a document of the window status has no surface")?;
            let process = document["process"]
                .as_u64()
                .ok_or("a document of the window status has no process")?;
            Ok((surface.to_string(), process as u32))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(crate::performance::WindowProcesses {
        page: page as u32,
        documents,
    })
}

/// Calculates the host.window value of a window. It is called from a thread that is not the main thread.
fn window_status(window: &Window) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let target = window.clone();
    let (context, facts, named, documents, regions) = with_native_owner(window, move |handle| {
        // Destroyed deletes the registration, so it is read in this step, while the window is open.
        let context = window_data(&target)?;
        let facts = platform.window_facts(handle)?;
        let named: HashMap<_, _> = context
            .surface_hosts
            .lock()
            // default: a lock that a panicking thread poisoned still holds the surface registrations, which are only
            // read; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|(id, handle)| (*handle, id.clone()))
            .collect();
        let documents = context.documents.names();
        let mut regions = Vec::new();
        for (handle, (surface, name)) in context.images.names() {
            let presented = context
                .images
                .presented_frame(&(surface.clone(), name.clone()));
            let text = platform.image_facts(handle)?;
            let mut region: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            // presented is the size of the presented image with the identity of the frame that the host marked presented;
            // null while no frame of the current raster is presented.
            region["presented"] = match (region["presented"].take(), presented) {
                (Value::Object(mut size), Some(frame)) => {
                    size.insert("generation".into(), json!(frame.generation));
                    size.insert("raster".into(), json!(frame.raster));
                    size.insert("sequence".into(), json!(frame.sequence));
                    Value::Object(size)
                }
                _ => Value::Null,
            };
            region["surface"] = Value::String(surface);
            region["name"] = Value::String(name);
            regions.push(region);
        }
        Ok((context, facts, named, documents, regions))
    })
    .map_err(native_failure(window.label(), -32603))?;
    let webviews = facts["webviews"]
        .as_array()
        .ok_or_else(|| internal("window facts missing webviews"))?;
    let document_webviews = facts["documentWebviews"]
        .as_u64()
        .ok_or_else(|| internal("window facts missing documentWebviews"))?;
    let app_dom_webviews = facts["appDomWebviews"]
        .as_u64()
        .ok_or_else(|| internal("window facts missing appDomWebviews"))?;
    let overlay = &context.overlay;
    let mut surfaces = Vec::new();
    let mut attached = Vec::new();
    let mut webview_frames = Vec::new();
    // The lock of the modal webviews is released before waiting for main-thread work. The modal placement on the main
    // thread waits for the same lock, so waiting for with_view while holding the lock would make the two threads wait
    // for each other.
    let modal_webview = overlay
        .view
        .lock()
        // default: a lock that a panicking thread poisoned still holds the modal webview, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    // A closing modal webview discards the task without running it. That modal has no view to draw, so it is reported
    // without a frame.
    let modal_view = modal_webview
        .map(|view| {
            with_view_if_present(&view, move |view| platform.view_id(view)).map_err(internal)
        })
        .transpose()?
        .flatten();
    let mut modal = match overlay.open_state() {
        Some((id, mode, shown)) => json!({"id": id, "mode": mode, "shown": shown,
            "frame": null, "order": null, "background": null}),
        None => Value::Null,
    };
    let rect = |view: &Value| json!({"x": view["x"], "y": view["y"], "width": view["width"], "height": view["height"]});
    let native_surfaces = facts["nativeSurfaces"]
        .as_array()
        .ok_or_else(|| internal("window facts missing nativeSurfaces"))?;
    for (order, view) in native_surfaces.iter().enumerate() {
        let address = view["view"]
            .as_u64()
            .ok_or_else(|| internal("surface facts missing view"))?
            as platform::Handle;
        let surface = registered_surface(&named, address).map_err(internal)?;
        let hidden = view["hidden"]
            .as_bool()
            .ok_or_else(|| internal("surface facts missing hidden"))?;
        surfaces
            .push(json!({"id": surface, "frame": rect(view), "visible": !hidden, "order": order}));
    }
    for (order, view) in webviews.iter().enumerate() {
        let address = view["view"]
            .as_u64()
            .ok_or_else(|| internal("webview facts missing view"))?;
        let address = address as platform::Handle;
        let main_webview = view["main"].as_bool().ok_or_else(|| {
            internal(format!(
                "webview facts missing main at index {order}: {view}"
            ))
        })?;
        let document_webview = view["document"]
            .as_bool()
            .ok_or_else(|| internal("webview facts missing document"))?;
        let hidden = view["hidden"]
            .as_bool()
            .ok_or_else(|| internal("webview facts missing hidden"))?;
        let focused = view["focused"]
            .as_bool()
            .ok_or_else(|| internal("webview facts missing focused"))?;
        let process = view["process"]
            .as_i64()
            .ok_or_else(|| internal("webview facts missing process"))?;
        webview_frames.push(json!({"frame": rect(view), "main": main_webview,
            "document": document_webview, "visible": !hidden, "focused": focused, "order": order}));
        if let Some((surface, document)) = documents.get(&address) {
            attached.push(
                json!({"surface": surface, "document": document, "frame": rect(view),
                "visible": !hidden, "focused": focused, "order": order, "process": process}),
            );
        } else if modal.is_object() && modal_view == Some(address) {
            modal["frame"] = rect(view);
            // The order of native surfaces is reported in a separate compositor plane, so its index cannot be compared
            // with the index of the webview subtree. The modal is attached above that whole plane, so it has the next
            // order.
            modal["order"] = json!(native_surfaces.len());
            modal["background"] = json!({"draws": view["draws"], "alpha": view["alpha"]});
        }
    }
    // The first responder and the kind of webview that holds it. A webview that is not registered is webview, and a
    // view outside the webviews (for example an image region) is native. surface is the surface that holds the first
    // responder.
    let responder_facts = &facts["responder"];
    let class = responder_facts["class"]
        .as_str()
        .ok_or_else(|| internal("window facts missing responder class"))?;
    let owner = responder_facts["webview"]
        .as_u64()
        .ok_or_else(|| internal("window facts missing responder webview"))?
        as platform::Handle;
    let container = responder_facts["surface"]
        .as_u64()
        .ok_or_else(|| internal("window facts missing responder surface"))?
        as platform::Handle;
    let main = responder_facts["main"]
        .as_bool()
        .ok_or_else(|| internal("window facts missing responder main"))?;
    let surface = if container == 0 {
        None
    } else {
        named.get(&container).cloned()
    };
    let responder = if owner == 0 {
        json!({"class": class, "owner": "native", "surface": surface, "document": null})
    } else if let Some((surface, document)) = documents.get(&owner) {
        json!({"class": class, "owner": "document", "surface": surface, "document": document})
    } else if surface.is_some() {
        json!({"class": class, "owner": "surface", "surface": surface, "document": null})
    } else if modal_view == Some(owner) {
        json!({"class": class, "owner": "modal", "surface": null, "document": null})
    } else if main {
        json!({"class": class, "owner": "page", "surface": null, "document": null})
    } else {
        json!({"class": class, "owner": "webview", "surface": null, "document": null})
    };
    Ok(json!({
        "responder": responder,
        "frame": facts["frame"],
        "pointer": facts["pointer"],
        "content": {"x": 0.0, "y": 0.0, "width": facts["content"]["width"], "height": facts["content"]["height"]},
        "scale": facts["scale"],
        "refreshRate": facts["refreshRate"],
        "maximized": facts["zoomed"],
        "key": facts["key"],
        "active": facts["active"],
        "occluded": facts["occluded"],
        "children": facts["children"],
        "pageProcess": facts["pageProcess"],
        "quitting": window.state::<crate::windows::Windows>().quit.active(),
        "appDomWebviews": app_dom_webviews,
        "documentWebviews": document_webviews,
        "controls": facts["controls"],
        "webviews": webview_frames,
        "surfaces": surfaces,
        "documents": attached,
        "regions": regions,
        "modal": modal,
    }))
}

/// Reloads the main page in the same WebContent process and waits until the new page reports that it is ready. The
/// ready page first finishes the pending save (docs/spec/projects.md#persistence). WebKit keeps the previous page on
/// the screen until the new page first draws visible content, and the cleanup of the previous page is done by the start
/// document request of the new page (docs/spec/native-host.md#page-start).
fn reload(host: &Host, window: &Window) -> Result<Value, Failure> {
    let ready = window_data(window)
        .map_err(internal)?
        .ready
        .load(Ordering::Relaxed);
    if ready {
        let mut flush = Map::new();
        flush.insert("name".into(), Value::from("core.projects.flush"));
        flush.insert("params".into(), Value::Object(Map::new()));
        host.page(window, "command.run", flush, TIMEOUT)?;
    }
    let (tx, rx) = mpsc::channel();
    window_data(window)
        .map_err(internal)?
        .readied
        .lock()
        // default: a lock that a panicking thread poisoned still holds the readiness senders, which this call fills;
        // the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .push(tx);
    if ready {
        // A ready page reloads itself after all the calls it sent have received their answers. If the host reloaded it,
        // the response being written at that moment would be lost (docs/spec/native-host.md#page-reload).
        crate::windows::emit_window(window, "page-reload", serde_json::json!({}))
            .map_err(internal)?;
    } else {
        let target = window.clone();
        on_main(window, move || {
            crate::windows::root_view(&target)
                .ok_or_else(|| "the main page is gone".to_string())?
                .reload()
                .map_err(|error| error.to_string())
        })
        .map_err(internal)?;
    }
    match rx.recv_timeout(TIMEOUT) {
        Ok(()) => Ok(Value::Null),
        Err(_) => Err(Failure::new(
            TIMED_OUT,
            crate::running_calls::reload_timeout_text(
                TIMEOUT,
                &crate::running_calls::RUNNING_CALLS.of(window.label(), std::time::Instant::now()),
            ),
        )),
    }
}

/// Changes the window to full screen or back, and returns after the transition ends. macOS ignores a request during a
/// transition, so the native code continues to handle it after that transition ends.
fn fullscreen(window: &Window, on: bool) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let (tx, rx) = mpsc::channel();
    with_native_owner(window, move |handle| {
        platform.fullscreen(
            handle,
            on,
            Box::new(move || {
                if tx.send(()).is_err() {
                    crate::application_log::log_info(
                        "exposure",
                        "fullscreen completion arrived after its request ended",
                    );
                }
            }),
        )
    })
    .map_err(native_failure(window.label(), -32603))?;
    match rx.recv_timeout(TIMEOUT) {
        Ok(()) => Ok(Value::Null),
        Err(_) => Err(Failure::new(
            TIMED_OUT,
            format!("the window did not change full screen within {TIMEOUT:?}"),
        )),
    }
}

/// Waits until the surface placement transaction and the current image raster of the window are settled and the main
/// document and the visible app document present that placement, and returns the presentation time of that screen (ms,
/// mach absolute time).
pub(crate) fn presented(window: &Window, timeout: Duration) -> Result<f64, Failure> {
    let deadline = Instant::now() + timeout;
    let data = window_data(window).map_err(internal)?;
    let wait_frame = || -> Result<f64, Failure> {
        let platform = platform::current().map_err(internal)?;
        let main = root_view_on_main(window).map_err(internal)?;
        let (tx, rx) = mpsc::channel();
        let failed = tx.clone();
        main.with_webview(move |view| {
            let done = tx.clone();
            if let Err(error) = platform.after_settled(
                &view,
                Box::new(move |displayed| {
                    match done.send(displayed) {
                        Ok(()) => {}
                        // A failure after the request ended was not reported by that request, so it is left as an error
                        // line.
                        Err(mpsc::SendError(Err(error))) => log_error("presentation", error),
                        Err(mpsc::SendError(Ok(_))) => crate::application_log::log_info(
                            "exposure",
                            "presentation completion arrived after its request ended",
                        ),
                    }
                }),
            ) {
                // A failure after the request ended was not reported by that request, so it is left as an error line.
                if let Err(mpsc::SendError(Err(error))) = failed.send(Err(error)) {
                    log_error("presentation", error);
                }
            }
        })
        .map_err(internal)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| {
                Failure::new(
                    TIMED_OUT,
                    format!("the window did not present within {timeout:?}"),
                )
            })?;
        match rx.recv_timeout(remaining) {
            Ok(outcome) => outcome.map_err(internal),
            Err(_) => Err(Failure::new(
                TIMED_OUT,
                format!("the window did not present within {timeout:?}"),
            )),
        }
    };

    wait_frame()?;
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err(Failure::new(
                TIMED_OUT,
                format!(
                    "the current image raster did not present within {timeout:?}; pending {}",
                    data.images.pending_rasters()
                ),
            ));
        };
        // The trigger of the wait for the presentation barrier (V5-104): when this wait times out, the screen is
        // stopped.
        let barrier_started = std::time::Instant::now();
        let barrier = data.images.wait_current(remaining);
        crate::performance::observe("host", || {
            serde_json::json!({"event": "barrier", "wait_us": barrier_started.elapsed().as_micros() as u64,
                    "ok": barrier.is_ok()})
        });
        if let Err(reason) = barrier {
            if reason == "presentationTimeout" {
                return Err(Failure::new(
                    TIMED_OUT,
                    format!(
                        "the current image raster did not present within {timeout:?}; pending {}",
                        data.images.pending_rasters()
                    ),
                ));
            }
            return Err(Failure::new(
                HANDLER_FAILED,
                format!("the current image raster failed to present: {reason}"),
            ));
        }
        let displayed = wait_frame()?;
        if data.images.current_presented() {
            return Ok(displayed);
        }
    }
}

#[cfg(feature = "diagnostics")]
pub(crate) fn inject_presentation_failure(window: &Window) -> Result<(), Failure> {
    let platform = platform::current().map_err(internal)?;
    on_main(window, move || platform.inject_settled_failure()).map_err(internal)
}

/// Returns the document or view that owns the point in window coordinates.
fn hit(window: &Window, x: f64, y: f64) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let target = window.clone();
    let (found, context) = with_native_owner(window, move |handle| {
        // Destroyed deletes the registration, so it is read in this step, while the window is open.
        Ok((platform.hit(handle, x, y)?, window_data(&target)?))
    })
    .map_err(native_failure(window.label(), -32603))?;
    let documents = context.documents.names();
    let owner = found.chain.iter().find_map(|view| {
        documents
            .get(view)
            .map(|(surface, document)| json!({"kind": "document", "surface": surface, "document": document}))
    });
    if let Some(owner) = owner {
        return Ok(owner);
    }
    let hit_view = match (found.view_class, found.view_frame) {
        (Some(class), Some((x, y, width, height))) => json!({
            "class": class, "frame": {"x": x, "y": y, "width": width, "height": height}
        }),
        (None, None) => Value::Null,
        _ => return Err(internal("window hit view class and frame are inconsistent")),
    };
    let modal = context
        .overlay
        .view
        .lock()
        // default: a lock that a panicking thread poisoned still holds the modal webview, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    if let (Some(view), Some((id, _, _))) = (modal, context.overlay.open_state()) {
        let handle = with_view(&view, move |view| platform.view_id(view)).map_err(internal)?;
        if found.chain.contains(&handle) {
            return Ok(
                json!({"kind": "native", "identifier": format!("modal:{id}"), "view": hit_view}),
            );
        }
    }
    let main = root_view_on_main(window).map_err(internal)?;
    let page = with_view(&main, move |view| platform.view_id(view)).map_err(internal)?;
    if found.chain.contains(&page) {
        return Ok(json!({"kind": "page"}));
    }
    Ok(json!({"kind": "native", "identifier": found.identifier, "view": hit_view}))
}

/// Runs endpoint requests in the windows of this application.
pub(crate) struct Host(pub AppHandle);

impl Host {
    /// Sends a request to the main page of the window and waits for the response.
    pub(crate) fn page(
        &self,
        window: &Window,
        method: &str,
        params: Map<String, Value>,
        timeout: Duration,
    ) -> Result<Box<RawValue>, Failure> {
        self.page_then(window, method, params, Some(timeout), || {})
    }

    /// The same as page, and calls sent after the request is sent and before it waits for the response. When timeout is
    /// None, it waits for the answer or the end of the page. A page that is not ready cannot receive the request, so
    /// 1003 is returned. The readiness is checked after the request is registered, so a request of a page that was
    /// reloaded in between is rejected here or ends with abandon.
    pub(crate) fn page_then(
        &self,
        window: &Window,
        method: &str,
        params: Map<String, Value>,
        timeout: Option<Duration>,
        sent: impl FnOnce(),
    ) -> Result<Box<RawValue>, Failure> {
        let label = window.label().to_string();
        root_view_on_main(window).map_err(|error| Failure::new(MISSING_DOCUMENT, error))?;
        let data = window_data(window).map_err(|e| Failure::new(MISSING_DOCUMENT, e))?;
        self.0
            .state::<Exposure>()
            .relay
            .request(&label, timeout, |id| {
                if !data.ready.load(Ordering::Relaxed) {
                    return Err("the main page is not ready".to_string());
                }
                emit_to(
                    &self.0,
                    &label,
                    "exposure-request",
                    json!({"id": id, "method": method, "params": params}),
                )?;
                sent();
                Ok(())
            })
    }

    /// The current menu language that host.menu reports. It is the same value as the state that decides whether the
    /// menu is not rebuilt.
    fn menu_language(&self) -> Result<String, Failure> {
        let state = self.0.state::<crate::menu::MenuLanguage>();
        let language = state.0.lock();
        // default: a lock that a panicking thread poisoned still holds the menu language, which is only read; the panic hook records the panic.
        let language = language.unwrap_or_else(PoisonError::into_inner);
        Ok(language.clone())
    }

    /// Runs the request of a name whose owner is host.
    fn host_entry(
        &self,
        window: &Window,
        method: &str,
        name: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, Failure> {
        check_host_name(method, name)?;
        let unknown = || Failure::new(UNKNOWN_NAME, format!("{name} is not declared"));
        match (method, name) {
            ("status.get", "host.window") => window_status(window),
            ("status.get", "host.screens") => {
                let platform = platform::current().map_err(internal)?;
                on_main(window, move || platform.screens()).map_err(internal)
            }
            ("status.get", "host.windows") => windows::list(&self.0).map_err(internal),
            ("status.get", "host.sidecars") => Ok(sidecars_status(&self.0)),
            ("status.get", "host.buttons") => self
                .0
                .try_state::<crate::buttons::Buttons>()
                .map(|buttons| buttons.value())
                .ok_or_else(|| internal("the mouse buttons are not watched")),
            ("status.get", "host.log") => self
                .0
                .try_state::<crate::LogNoticeState>()
                .map(|state| json!(state.0.value()))
                .ok_or_else(|| internal("the log notices are not started")),
            ("status.get", "host.dock") => {
                let platform = platform::current().map_err(internal)?;
                on_main(window, move || platform.dock_items()).map_err(internal)
            }
            ("status.get", "host.menu") => {
                // The language is read from the host state. It is not inferred from the title (Application menu in
                // docs/spec/host-contract.md).
                let language = self.menu_language()?;
                let platform = platform::current().map_err(internal)?;
                let menus = on_main(window, move || platform.menu_items()).map_err(internal)?;
                Ok(json!({ "language": language, "menus": menus }))
            }
            (
                "status.watch" | "status.unwatch",
                "host.window" | "host.windows" | "host.screens" | "host.dock" | "host.menu"
                | "host.sidecars" | "host.buttons" | "host.log",
            ) => Ok(Value::Null),
            ("command.run", _) => {
                let arguments = match params.get("params") {
                    None | Some(Value::Null) => Map::new(),
                    Some(Value::Object(arguments)) => arguments.clone(),
                    Some(_) => return Err(Failure::params("params must be an object")),
                };
                self.host_command(window, name, &arguments)
                    .ok_or_else(unknown)?
            }
            _ => Err(unknown()),
        }
    }

    fn host_command(
        &self,
        window: &Window,
        name: &str,
        arguments: &Map<String, Value>,
    ) -> Option<Result<Value, Failure>> {
        let done = |result: tauri::Result<()>| result.map(|_| Value::Null).map_err(internal);
        Some(match name {
            "host.window.close" => done(window.close()),
            "host.window.maximize" => match arguments.get("on") {
                None | Some(Value::Bool(true)) => done(window.maximize()),
                Some(Value::Bool(false)) => done(window.unmaximize()),
                Some(_) => Err(Failure::params("on must be a boolean")),
            },
            "host.window.fullscreen" => match arguments.get("on") {
                None | Some(Value::Bool(true)) => fullscreen(window, true),
                Some(Value::Bool(false)) => fullscreen(window, false),
                Some(_) => Err(Failure::params("on must be a boolean")),
            },
            "host.window.resize" => (|| {
                let width = number(arguments, "width")?;
                let height = number(arguments, "height")?;
                if width <= 0.0 || height <= 0.0 {
                    return Err(Failure::params("width and height must be positive"));
                }
                done(window.set_size(LogicalSize::new(width, height)))
            })(),
            "host.window.reload" => reload(self, window),
            "host.window.presented" => {
                presented(window, TIMEOUT).map(|displayed| json!({"displayed": displayed}))
            }
            "host.window.move" => (|| {
                let x = number(arguments, "x")?;
                let y = number(arguments, "y")?;
                let platform = platform::current().map_err(internal)?;
                with_native_owner(window, move |handle| platform.move_window(handle, x, y))
                    .map_err(native_failure(window.label(), -32603))?;
                Ok(Value::Null)
            })(),
            "host.menu.select" => (|| {
                let text = |name: &str| {
                    arguments
                        .get(name)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .ok_or_else(|| Failure::params(format!("{name} must be a string")))
                };
                let (menu, title) = (text("menu")?, text("title")?);
                let platform = platform::current().map_err(internal)?;
                on_main(window, move || platform.menu_select(&menu, &title)).map_err(internal)?;
                Ok(Value::Null)
            })(),
            "host.dock.select" => (|| {
                let title = arguments
                    .get("title")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Failure::params("title must be a string"))?
                    .to_string();
                let platform = platform::current().map_err(internal)?;
                on_main(window, move || platform.dock_select(&title)).map_err(internal)?;
                Ok(Value::Null)
            })(),
            "host.hit" => (|| hit(window, number(arguments, "x")?, number(arguments, "y")?))(),
            "host.quit" => {
                self.0.exit(0);
                Ok(Value::Null)
            }
            _ => return None,
        })
    }

    /// Delivers pointer input on the main thread. When activate is set, the window is activated first.
    fn input_pointer(&self, window: &Window, pointer: Pointer) -> Result<Value, Failure> {
        let platform = platform::current().map_err(|e| Failure::new(NO_INPUT, e))?;
        if pointer.activate {
            let (tx, rx) = mpsc::channel();
            with_native_owner(window, move |handle| {
                platform.input_activate(
                    handle,
                    pointer.x,
                    pointer.y,
                    ACTIVATION,
                    Box::new(move |result| {
                        match tx.send(result) {
                            Ok(()) => {}
                            // A failure after the request ended was not reported by that request, so it is left as an
                            // error line.
                            Err(mpsc::SendError(Err(error))) => log_error("activation", error),
                            Err(mpsc::SendError(Ok(()))) => crate::application_log::log_info(
                                "exposure",
                                "activation result arrived after its request ended",
                            ),
                        }
                    }),
                )
            })
            .map_err(native_failure(window.label(), NO_INPUT))?;
            // The library calls done with the stopped stage after ACTIVATION elapsed, so the result always arrives.
            rx.recv()
                .map_err(|e| e.to_string())
                .and_then(|result| result)
                .map_err(|e| Failure::new(NOT_ACTIVE, e))?;
        }
        let (tx, rx) = mpsc::channel();
        with_native_owner(window, move |handle| {
            platform.input_pointer(
                handle,
                pointer,
                RECEIPT,
                Box::new(move |delivery| {
                    if tx.send(delivery).is_err() {
                        crate::application_log::log_info(
                            "exposure",
                            "pointer delivery arrived after its request ended",
                        );
                    }
                }),
            )
        })
        .map_err(native_failure(window.label(), NO_INPUT))?;
        // The library calls done with Unreceived after RECEIPT elapsed, so the result always arrives.
        match rx
            .recv()
            .map_err(|e| Failure::new(NO_INPUT, e.to_string()))?
        {
            Delivery::Delivered => {
                if pointer.phase == 1 {
                    crate::surfaces::press_at(window, pointer.x, pointer.y)
                        .map_err(native_failure(window.label(), NO_INPUT))?;
                }
                Ok(Value::Null)
            }
            Delivery::Inactive => Err(Failure::new(NOT_ACTIVE, "the window is not active")),
            Delivery::Rejected => Err(Failure::new(
                INVALID_PARAMS,
                "the window did not accept the input",
            )),
            Delivery::Unreceived => Err(Failure::new(
                TIMED_OUT,
                format!(
                    "the document did not receive the input within {} ms",
                    RECEIPT.as_millis()
                ),
            )),
            Delivery::ButtonHeld(held) => {
                Err(Failure::new(BUTTON_HELD, button_held_message(&held)))
            }
            Delivery::PressOpen => Err(Failure::new(
                PRESS_OPEN,
                "a synthetic press of this button is still open in the window; send up before the next down",
            )),
        }
    }

    /// Delivers key input on the main thread.
    fn input_key(&self, window: &Window, key: Key) -> Result<Value, Failure> {
        let platform = platform::current().map_err(|e| Failure::new(NO_INPUT, e))?;
        match with_native_owner(window, move |handle| platform.input_key(handle, &key)) {
            Ok(Delivery::Delivered) => Ok(Value::Null),
            Ok(Delivery::Inactive) => Err(Failure::new(
                NOT_ACTIVE,
                "keys reach only the key window of the active application",
            )),
            Ok(_) => Err(Failure::new(
                INVALID_PARAMS,
                "the window did not accept the input",
            )),
            Err(failure) => Err(native_failure(window.label(), NO_INPUT)(failure)),
        }
    }
}

impl Service for Host {
    fn windows(&self) -> Result<Value, Failure> {
        windows::list(&self.0).map_err(internal)
    }

    fn exists(&self, window: &str) -> bool {
        windows::find(&self.0, window).is_some()
    }

    fn unwatched(&self, window: &str, name: &str) {
        if name == "host.window" {
            window_unwatched(&self.0, window);
        }
    }

    fn call(
        &self,
        window: &str,
        method: &str,
        params: Map<String, Value>,
    ) -> Result<Box<RawValue>, Failure> {
        let window = windows::find(&self.0, window).ok_or_else(|| missing_window(window))?;
        // The time and result of every endpoint method are recorded in the performance trace (V5-104). A rejection is
        // recorded as it is: a mismatched value is contained in the error string.
        let started = std::time::Instant::now();
        let outcome = self.dispatch(&window, method, params);
        crate::performance::observe("host", || {
            let (ok, error) = match &outcome {
                Ok(_) => (true, None),
                Err(failure) => (false, Some(failure.message.clone())),
            };
            let mut fields = serde_json::json!({
                "name": method, "us": started.elapsed().as_micros() as u64, "ok": ok,
            });
            if let Some(message) = error {
                fields["error"] = serde_json::Value::String(message);
            }
            fields["event"] = serde_json::Value::String("endpoint".into());
            fields
        });
        outcome
    }
}

impl Host {
    fn dispatch(
        &self,
        window: &tauri::Window,
        method: &str,
        params: Map<String, Value>,
    ) -> Result<Box<RawValue>, Failure> {
        match method {
            "input.pointer" => raw(&self.input_pointer(window, pointer(&params)?)?),
            "input.key" => raw(&self.input_key(window, key(&params)?)?),
            "exposure.list" => with_host_entries(&self.page(window, method, params, TIMEOUT)?),
            #[cfg(feature = "diagnostics")]
            _ if method.starts_with("diagnostics.") => {
                raw(&crate::diagnostics::call(self, window, method, params)?)
            }
            _ => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    // default: a request without a name is not a host entry, so it is sent to the page as it is, and
                    // the page checks the arguments.
                    .unwrap_or_default()
                    .to_string();
                if name == "host" || name.starts_with("host.") {
                    return raw(&self.host_entry(window, method, &name, &params)?);
                }
                // The main page ends a command forwarded to a surface within the time limit of its declaration, so
                // command.run has no limit.
                let timeout = if method == "command.run" {
                    None
                } else {
                    Some(TIMEOUT)
                };
                self.page_then(window, method, params, timeout, || {})
            }
        }
    }
}
