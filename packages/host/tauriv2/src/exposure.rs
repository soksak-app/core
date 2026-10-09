//! 엔드포인트 요청의 창 선택, 호스트 항목, 페이지 요청 중계.
//!
//! 호스트는 `windows.list`, `input.pointer`, `input.key`, 소유자가 `host` 인 이름을 직접 처리한다.
//! 나머지 요청은 창의 메인 페이지에 `exposure-request` 이벤트로 보내고 `exposure_reply` 명령으로
//! 응답을 받는다. 메인 페이지가 표면 페이지의 이름을 요청하면 `exposure_forward` 명령으로 표면
//! 페이지에 전달한다. 호출한 문서는 명령의 웹뷰로 구분한다. 형식은 docs/spec/exposure.md 에 정의한다.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, EventTarget, LogicalSize, Manager, Webview, Window};

use crate::application_log::log_error;
use crate::endpoint::{
    missing_window, Endpoint, Failure, Service, BUTTON_HELD, HANDLER_FAILED, INVALID_PARAMS,
    MISSING_DOCUMENT, NOT_ACTIVE, NO_INPUT, PRESS_OPEN, TIMED_OUT, UNKNOWN_NAME,
};
use crate::platform;
use crate::surfaces::label_for;
use crate::windows::{self, window_data, with_native_owner, NativeFailure};

pub use crate::platform::{ButtonHeld, Delivery, FrontmostApplication, Key, Pointer};

/// 문서가 응답해야 하는 시간.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// 애플리케이션 활성화를 기다리는 시간.
const ACTIVATION: Duration = Duration::from_secs(5);

/// input.pointer 의 누름과 뗌이 문서의 수신을 기다리는 시간.
const RECEIPT: Duration = Duration::from_secs(2);

/// endpoint.json 과 소켓 이름에 쓰는 애플리케이션 이름.
const APPLICATION: &str = "tauriv2";

/// 호스트가 선언하는 항목. 형식은 plugin.json 의 exposes 와 같고, 각 종류 안에서 이름 순서이다.
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
                    "visible": {"type": "boolean"}, "focused": {"type": "boolean"}, "order": {"type": "integer"}}}},
                "regions": {"type": "array", "items": {"type": "object", "properties": {
                    "surface": {"type": "string"}, "name": {"type": "string"}, "frame": rect,
                    "visible": {"type": "boolean"}, "focused": {"type": "boolean"},
                    "presented": {"type": ["object", "null"], "properties": {
                        "sequence": {"type": "integer"}, "width": {"type": "integer"}, "height": {"type": "integer"}}},
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

/// 페이지의 `exposure.list` 결과에 호스트 항목을 등록된 항목으로 추가한다.
/// 소유자가 host 인 이름이 이 요청 방식으로 선언되었는지 확인한다. 선언되지 않은 이름은 1001 이다.
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

/// 페이지가 보낸 exposure.list 에 host 항목을 더한다. 페이지 항목은 받은 텍스트 그대로 두고, 종류는 이름
/// 순서로 쓴다(Wails host 와 같다).
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

/// 1007 오류의 메시지를 만든다. 거부한 차례의 mask 와 최전면 애플리케이션을 적는다(docs/spec/exposure.md).
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

/// `input.pointer` 의 매개변수를 읽는다.
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
            ))
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

/// `input.key` 의 매개변수를 읽는다.
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
            ))
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

/// 응답 텍스트를 host 가 읽는 값으로 바꾼다.
pub fn parsed(text: &RawValue) -> Result<Value, Failure> {
    serde_json::from_str(text.get()).map_err(|error| Failure::new(-32603, error.to_string()))
}

/// 페이지가 보낸 응답 `{id, result}` 또는 `{id, error}`. result 는 받은 텍스트 그대로 둔다.
#[derive(Deserialize)]
struct Answer {
    id: Option<u64>,
    #[serde(default)]
    result: Option<Box<RawValue>>,
    #[serde(default)]
    error: Option<Value>,
}

/// 문서에 보낸 요청과 그 응답의 대응.
#[derive(Default)]
pub struct Relay {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Waiting>>,
    /// 시간이 초과된 최근 요청의 id, 문서, 보낸 시각, 제한 시간. 늦은 답의 지연을 오류에 밝히기 위해
    /// EXPIRED_LIMIT 개까지 기억하고 가장 오래된 것을 버린다(docs/spec/exposure.md#errors).
    expired: Mutex<std::collections::VecDeque<(u64, String, std::time::Instant, Duration)>>,
}

/// 늦은 답을 위해 기억하는 시간 초과 요청 수.
const EXPIRED_LIMIT: usize = 256;

impl Relay {
    /// send 로 요청 id 를 문서 target 에 보내고 target 의 응답을 timeout 동안 기다린다. timeout 이
    /// None 이면 응답이나 문서 종료까지 기다린다. send 가 실패하면 문서가 없는 것으로 처리한다.
    pub fn request(
        &self,
        target: &str,
        timeout: Option<Duration>,
        send: impl FnOnce(u64) -> Result<(), String>,
    ) -> Result<Box<RawValue>, Failure> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|e| Failure::new(-32603, e.to_string()))?
            .insert(id, (target.to_string(), tx));
        let sent = std::time::Instant::now();
        if let Err(error) = send(id) {
            self.forget(id);
            return Err(Failure::new(MISSING_DOCUMENT, error));
        }
        let Some(timeout) = timeout else {
            // 기본값: 답을 보낼 쪽이 사라지면 문서가 닫힌 것이므로 그 오류로 답한다.
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
                    .map_err(|e| Failure::new(-32603, e.to_string()))?
                    .remove(&id)
                    .is_none();
                if taken {
                    // 제한 시간과 같은 때에 답이 요청을 가져갔으면 그 답이 곧 전달된다.
                    return rx
                        .recv()
                        .map_err(|_| Failure::new(MISSING_DOCUMENT, format!("{target} closed")))?;
                }
                let mut expired = self
                    .expired
                    .lock()
                    .map_err(|e| Failure::new(-32603, e.to_string()))?;
                if expired.len() == EXPIRED_LIMIT {
                    expired.pop_front();
                }
                expired.push_back((id, target.to_string(), sent, timeout));
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

    /// 문서 from 의 응답 `{id, result}` 또는 `{id, error}` 를 기다리는 요청에 전달한다. 전달했으면
    /// true 이다. 다른 문서에 보낸 요청의 id 는 전달하지 않는다. result 는 받은 텍스트 그대로 전달하므로
    /// 페이지 값의 키 순서가 바뀌지 않는다.
    pub fn reply(&self, from: &str, payload: &RawValue) -> Result<(), String> {
        let Answer { id, result, error } =
            serde_json::from_str::<Answer>(payload.get()).map_err(|error| error.to_string())?;
        let id = id.ok_or("exposure reply has no id")?;
        let waiting = {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
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
                // 기본값: 코드가 없는 페이지 오류는 JSON-RPC 내부 오류(-32603)로 알린다.
                error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    // 기본값: 문장이 없는 페이지 오류는 일반 문장으로 같은 오류를 알린다.
                    .unwrap_or("the document failed"),
            )),
            // 기본값: 값을 돌려주지 않은 명령의 답에는 result 가 없고, 그 결과는 null 이다.
            _ => result.map_or_else(|| raw(&Value::Null), Ok),
        };
        tx.send(outcome)
            .map_err(|_| format!("exposure reply {id} has no matching request"))
    }

    /// 기다리는 요청이 없는 답 id 의 오류. 시간이 초과된 요청이면 보낸 뒤의 지연과 제한 시간을 밝힌다.
    fn unmatched(&self, id: u64, from: &str) -> Result<String, String> {
        let mut expired = self.expired.lock().map_err(|e| e.to_string())?;
        let Some(index) = expired
            .iter()
            .position(|(held, target, _, _)| *held == id && target == from)
        else {
            return Ok(format!("exposure reply {id} has no matching request"));
        };
        let (_, _, sent, timeout) = expired.remove(index).expect("the position is in the queue");
        Ok(format!(
            "exposure reply {id} arrived {} ms after it was sent; its request timed out after {} ms",
            sent.elapsed().as_millis(),
            timeout.as_millis()
        ))
    }

    /// 문서 target 에 보낸 요청을 모두 오류 1003 으로 끝낸다.
    pub fn abandon(&self, target: &str) {
        self.abandon_matching(|held| held == target);
    }

    fn abandon_matching(&self, closed: impl Fn(&str) -> bool) {
        let gone: Vec<Waiting> = match self.pending.lock() {
            Ok(mut pending) => {
                let ids: Vec<u64> = pending
                    .iter()
                    .filter(|(_, (target, _))| closed(target))
                    .map(|(id, _)| *id)
                    .collect();
                ids.into_iter()
                    .filter_map(|id| pending.remove(&id))
                    .collect()
            }
            Err(_) => return,
        };
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
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }
}

/// 애플리케이션의 엔드포인트, 중계, 마지막으로 보낸 host.window 값.
#[derive(Default)]
pub(crate) struct Exposure {
    pub relay: Relay,
    endpoint: OnceLock<Endpoint>,
    reported: Mutex<HashMap<String, Value>>,
}

/// 엔드포인트를 연다. endpoint.json 은 publish 가 쓴다.
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

/// 첫 창 window 를 등록한 뒤 endpoint.json 을 쓴다.
pub(crate) fn publish(app: &AppHandle, window: &str) -> Result<(), String> {
    app.state::<Exposure>()
        .endpoint
        .get()
        .ok_or("the endpoint is not started")?
        .publish(window)
}

/// 엔드포인트를 닫고 소켓과 endpoint.json 을 제거한다.
pub(crate) fn stop(app: &AppHandle) {
    if let Some(endpoint) = app.state::<Exposure>().endpoint.get() {
        endpoint.stop();
    }
}

/// 창 window 의 기록을 요청한 연결에 줄 하나를 보낸다.
/// 진단 빌드가 아니면 보낼 곳이 없다.
#[cfg(feature = "diagnostics")]
pub(crate) fn log(window: &Window, line: &str) {
    if let Some(endpoint) = window.state::<Exposure>().endpoint.get() {
        endpoint.notifier().log(window.label(), line);
    }
}
#[cfg(not(feature = "diagnostics"))]
pub(crate) fn log(_window: &Window, _line: &str) {}

/// 표면을 대상으로 한 연산은 창의 메인 페이지만 호출한다. caller 는 호출한 웹뷰, window 는 창의 레이블이며,
/// 메인 페이지의 웹뷰 레이블은 창 레이블과 같다. 다른 웹뷰의 호출은 거부한다.
pub fn authorize_main_caller(caller: &str, window: &str, operation: &str) -> Result<(), String> {
    if caller != window {
        return Err(format!(
            "{operation} must come from the main webview of {window}, not {caller}"
        ));
    }
    Ok(())
}

/// 명령을 호출한 웹뷰가 창의 메인 페이지인지 확인한다.
fn main_page(webview: &Webview) -> Result<Window, String> {
    let window = webview.window();
    authorize_main_caller(webview.label(), window.label(), "exposure operations")?;
    Ok(window)
}

fn emit_to(app: &AppHandle, label: &str, event: &str, payload: Value) -> Result<(), String> {
    app.emit_to(EventTarget::webview(label), event, payload)
        .map_err(|e| e.to_string())
}

/// 호출한 문서의 응답을 기다리는 요청에 전달한다. 제한 시간이 지난 응답은 버린다.
/// 제거된 표면이 보낸 늦은 답의 관측 줄.
pub fn removed_surface_reply(id: u64, surface: &str) -> String {
    format!("exposure reply {id} of removed surface {surface:?} arrived after its request ended")
}

pub fn reply_target(window: &str, request: &Value) -> Result<String, String> {
    match request.get("surface") {
        None => Ok(window.to_string()),
        Some(Value::String(surface)) if !surface.is_empty() => {
            Ok(format!("surface-{window}-{surface}"))
        }
        Some(_) => Err("exposure reply surface must be a nonempty string".into()),
    }
}

/// 문서의 응답 텍스트를 기다리는 요청에 전달한다. 텍스트는 받은 그대로 중계하고, 응답을 보낸 문서를 고르는
/// 데만 읽는다.
pub(crate) fn reply(webview: &Webview, request: String) -> Result<(), String> {
    let window = main_page(webview)?;
    let text = RawValue::from_string(request)
        .map_err(|error| format!("exposure reply is not JSON: {error}"))?;
    let routing: Value = serde_json::from_str(text.get()).map_err(|error| error.to_string())?;
    let target = reply_target(window.label(), &routing)?;
    if let Some(surface) = routing.get("surface").and_then(Value::as_str) {
        if !crate::surfaces::surface_attached(&window, surface)? {
            // 표면을 제거할 때 그 표면의 요청은 이미 1003 으로 끝났다. 늦은 답은 답할 요청이 없으므로 버리고 관측으로
            // 남긴다(docs/spec/exposure.md).
            let id = routing
                .get("id")
                .and_then(Value::as_u64)
                .ok_or("exposure reply has no id")?;
            crate::application_log::log_info("exposure", removed_surface_reply(id, surface));
            return Ok(());
        }
    }
    webview.state::<Exposure>().relay.reply(&target, &text)
}

#[derive(Deserialize)]
pub struct Changed {
    name: String,
    #[serde(default)]
    surface: Option<String>,
    /// 페이지가 보낸 값의 JSON 텍스트. 키 순서를 바꾸지 않고 연결에 보낸다. 값이 없는 변경은 값이 null 인
    /// 변경이다.
    #[serde(default)]
    value: Option<String>,
}

/// 페이지가 이름 name 의 상태 변경을 보낼 수 있는지 확인한다. host 상태는 host 만 바꾼다.
pub fn check_page_status_change(name: &str) -> Result<(), String> {
    if name.starts_with("host.") {
        return Err(format!("the page cannot change host status {name}"));
    }
    Ok(())
}

/// 메인 페이지가 보낸 상태 변경을 감시하는 연결에 보낸다.
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
    /// 이 요청의 제한 시간(ms). 없으면 10 초다. 선언의 timeout 을 페이지가 전달한다.
    #[serde(default)]
    timeout: Value,
}

/// 전달 요청이 지정할 수 있는 가장 긴 제한 시간(ms).
const MAX_FORWARD_TIMEOUT: u64 = 600_000;

/// 전달 요청의 제한 시간을 정한다. status.next 는 값이 바뀔 때까지 답하지 않으므로 제한 시간이
/// 없고(None), timeout 을 받지 않는다. timeout 은 1 이상 600000 이하의 정수 ms 다.
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

/// 메인 페이지의 요청을 표면 페이지에 보내고 그 응답을 `{result}` 또는 `{error}` 로 반환한다. result 는
/// 표면 페이지가 보낸 텍스트 그대로다.
pub(crate) fn forward(webview: &Webview, request: Forward) -> Result<Box<RawValue>, String> {
    let window = main_page(webview)?;
    let label = label_for(&window, &request.surface);
    let app = window.app_handle().clone();
    let surface_exists = crate::surfaces::surface_handle(&window, &request.surface).is_ok();
    let outcome = match forward_timeout(&request.method, &request.timeout) {
		Err(invalid) => Err(invalid),
		Ok(_) if !surface_exists => Err(Failure::new(
			MISSING_DOCUMENT,
			format!("surface {} does not exist", request.surface),
		)),
        // status.next 는 제한 시간이 없다. 표면이 닫히면 1003 이다.
        Ok(timeout) => window
            .state::<Exposure>()
			.relay
			.request(&label, timeout, |id| {
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

/// 표면 페이지의 등록을 메인 페이지에 전달한다. 표면 페이지는 자신의 표면 id 로만 등록한다.
pub(crate) fn register(webview: &Webview, request: Register) -> Result<(), String> {
    let window = webview.window();
    if webview.label() != label_for(&window, &request.surface) {
        return Err(format!(
            "{} cannot register for surface {}",
            webview.label(),
            request.surface
        ));
    }
    if !matches!(request.kind.as_str(), "status" | "command" | "dom") {
        return Err(format!("unknown exposure kind {}", request.kind));
    }
    // 표면이 등록하는 코어 이름은 core.surface.* 뿐이다(docs/spec/exposure.md).
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
        let mut registrations = data.registrations.lock().map_err(|e| e.to_string())?;
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

/// 표면 페이지의 등록을 다시 읽힌 메인 페이지에 다시 알린다. 표면은 메인 페이지가 다시 읽혀도
/// 남으므로, 새 페이지는 이전 페이지가 받은 등록을 이 호출로 받는다.
pub(crate) fn replay_registrations(window: &Window) {
    let Ok(data) = window_data(window) else {
        return;
    };
    let registrations = match data.registrations.lock() {
        Ok(list) => list.clone(),
        Err(_) => return,
    };
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

/// 표면 페이지가 닫히거나 다시 읽힐 때 그 등록과 대기 중인 요청을 제거한다.
pub(crate) fn surface_closed(window: &Window, surface: &str) {
    window
        .state::<Exposure>()
        .relay
        .abandon(&label_for(window, surface));
    if let Ok(data) = window_data(window) {
        if let Ok(mut registrations) = data.registrations.lock() {
            registrations.retain(|(owner, _, _)| owner != surface);
        }
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

/// 메인 페이지가 다시 읽힐 때 그 페이지에 보낸 요청을 끝낸다.
pub(crate) fn page_reloaded(window: &Window) {
    window.state::<Exposure>().relay.abandon(window.label());
    windows_changed(window.app_handle());
}

/// 다시 읽힌 메인 페이지에 이 창의 감시와 진단 기록을 다시 요청한다. 페이지는 준비를 알린 뒤 호출한다.
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
    std::thread::spawn(move || {
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

/// 창이 닫힐 때 창의 문서에 보낸 요청을 끝내고 창의 상태 기록을 제거한다.
pub(crate) fn window_closed(window: &Window) {
    let state = window.state::<Exposure>();
    let main = window.label().to_string();
    let surfaces = format!("surface-{main}-");
    state
        .relay
        .abandon_matching(|target| target == main || target.starts_with(&surfaces));
    if let Ok(mut reported) = state.reported.lock() {
        reported.remove(&main);
    };
}

/// 창 목록이 바뀌었을 수 있을 때 호출한다. host.windows 를 감시하는 창마다 windows.list 결과를 보낸다.
/// 창 목록은 창 레지스트리를 잠그므로 별도 스레드에서 읽는다.
pub(crate) fn windows_changed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
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

/// host.buttons 의 감시를 설치한다. 바뀐 값은 한 스레드가 받은 차례대로 감시하는 연결에 보낸다. 엔드포인트의
/// 쓰기는 연결을 기다릴 수 있으므로 메인 스레드에서 보내지 않는다. 메인 스레드에서 endpoint.json 을 쓰기 전에
/// 호출한다(docs/spec/exposure.md#host-entries).
pub(crate) fn watch_buttons(app: &AppHandle) -> Result<(), String> {
    let (send, receive) = mpsc::channel::<Value>();
    let notifying = app.clone();
    std::thread::spawn(move || {
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
        let sent = send
            .lock()
            .map_err(|_| "the sender is poisoned".to_string())
            .and_then(|send| send.send(value).map_err(|error| error.to_string()));
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

/// host.sidecars 의 현재 값이다.
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

/// host.sidecars 가 바뀌었을 때 호출한다. 감시하는 창마다 새 값을 보낸다. 창 목록은 창 레지스트리를 잠그므로
/// 별도 스레드에서 읽는다.
pub(crate) fn sidecars_changed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
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

/// 창의 host.window 값이 바뀌었을 수 있을 때 호출한다. 감시하는 연결이 있으면 값을 계산하고,
/// 마지막으로 보낸 값과 다르면 보낸다. 네이티브 값은 메인 스레드에서 읽으므로 별도 스레드에서 계산한다.
pub(crate) fn window_changed(window: &Window) {
    let watched = window
        .state::<Exposure>()
        .endpoint
        .get()
        .is_some_and(|endpoint| endpoint.notifier().watched(window.label(), "host.window"));
    if !watched {
        return;
    }
    let window = window.clone();
    std::thread::spawn(move || {
        let value = match window_status(&window) {
            Ok(value) => value,
            // 상태를 읽기 전에 닫힌 창은 알릴 상태가 없다. 창의 닫기는 window_closed 가 알린다.
            Err(error) if error.code == MISSING_DOCUMENT => return,
            Err(error) => {
                log_error("host.window", error.message);
                return;
            }
        };
        let state = window.state::<Exposure>();
        {
            let Ok(mut reported) = state.reported.lock() else {
                return;
            };
            if reported.get(window.label()) == Some(&value) {
                return;
            }
            reported.insert(window.label().to_string(), value.clone());
        }
        if let Some(endpoint) = state.endpoint.get() {
            match raw(&value) {
                Ok(text) => endpoint
                    .notifier()
                    .changed(window.label(), "host.window", None, &text),
                Err(error) => log_error("host.window change", error.message),
            }
        }
    });
}

fn internal(error: impl ToString) -> Failure {
    Failure::new(-32603, error.to_string())
}

/// 창의 네이티브 주소를 쓴 작업의 실패를 code 의 오류로 바꾼다. 작업의 메인 스레드 단계 전에 닫힌 창은 없는
/// 창과 같다.
pub fn native_failure(window: &str, code: i64) -> impl Fn(NativeFailure) -> Failure + '_ {
    move |failure| match failure {
        NativeFailure::Closed => missing_window(window),
        NativeFailure::Failed(error) => Failure::new(code, error),
    }
}

/// 메인 스레드에서 work 를 실행하고 결과를 기다린다.
pub(crate) fn on_main<T: Send + 'static>(
    window: &Window,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    app_on_main(window.app_handle(), work)
}

/// 메인 스레드에서 work 를 실행하고 결과를 기다린다. 메인 스레드에서 부르면 바로 실행한다.
pub(crate) fn app_on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        match tx.send(work()) {
            Ok(()) => {}
            // 요청이 끝난 뒤의 실패는 그 요청이 보고하지 않았으므로 오류 줄로 남긴다.
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

/// AppKit 메인 스레드 실행기를 통해 메인 WebView를 반환한다.
///
/// Tauri endpoint worker와 비동기 명령은 창의 WebView registry를 직접 조회할 수 없다.
/// macOS에서 registry는 네이티브 WebKit 객체를 가지므로 읽기 전용 조회도 메인 스레드에서
/// 실행한다.
pub(crate) fn root_view_on_main(window: &Window) -> Result<Webview, String> {
    let target = window.clone();
    on_main(window, move || {
        crate::windows::root_view(&target).ok_or_else(|| "the main webview is gone".into())
    })
}

/// 웹뷰 작업의 결과를 받는다. 웹뷰가 파괴되어 작업을 실행하지 않고 버리면 송신자가 결과 없이 사라지므로 None 이다.
/// 작업이 보낸 오류는 그대로 반환한다.
pub fn received<T>(rx: &mpsc::Receiver<Result<T, String>>) -> Result<Option<T>, String> {
    match rx.recv() {
        Ok(result) => result.map(Some),
        Err(_) => Ok(None),
    }
}

/// 웹뷰의 네이티브 뷰로 work 를 실행한다. 닫히는 웹뷰가 작업을 실행하지 않으면 None 이다.
fn with_view_if_present<T: Send + 'static>(
    webview: &Webview,
    work: impl FnOnce(&tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
) -> Result<Option<T>, String> {
    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |view| {
            match tx.send(work(&view)) {
                Ok(()) => {}
                // 요청이 끝난 뒤의 실패는 그 요청이 보고하지 않았으므로 오류 줄로 남긴다.
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

/// 웹뷰의 네이티브 뷰로 work 를 실행하고 결과를 기다린다.
pub(crate) fn with_view<T: Send + 'static>(
    webview: &Webview,
    work: impl FnOnce(&tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |view| {
            match tx.send(work(&view)) {
                Ok(()) => {}
                // 요청이 끝난 뒤의 실패는 그 요청이 보고하지 않았으므로 오류 줄로 남긴다.
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

/// 창의 host.window 값을 계산한다. 메인 스레드가 아닌 스레드에서 호출한다.
fn window_status(window: &Window) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let target = window.clone();
    let (context, facts, named, documents, regions) = with_native_owner(window, move |handle| {
        // 등록은 Destroyed 가 지우므로 창이 열려 있는 이 단계에서 읽는다.
        let context = window_data(&target)?;
        let facts = platform.window_facts(handle)?;
        let named: HashMap<_, _> = context
            .surface_hosts
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .map(|(id, handle)| (*handle, id.clone()))
            .collect();
        let documents = context.documents.names();
        let mut regions = Vec::new();
        for (handle, (surface, name)) in context.images.names() {
            let text = platform.image_facts(handle)?;
            let mut region: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
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
    // 모달 웹뷰 잠금은 메인 스레드 작업을 기다리기 전에 푼다. 메인 스레드의 모달 배치가 같은 잠금을
    // 기다리므로, 잠금을 쥔 채 with_view 를 기다리면 두 스레드가 서로를 기다린다.
    let modal_webview = overlay.view.lock().map_err(internal)?.clone();
    // 닫히는 모달 웹뷰는 작업을 실행하지 않고 버린다. 그 모달은 그릴 뷰가 없으므로 frame 없이 보고한다.
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
        let surface = named
            .get(&address)
            .ok_or_else(|| internal("unregistered native surface"))?;
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
        webview_frames.push(json!({"frame": rect(view), "main": main_webview,
            "document": document_webview, "visible": !hidden, "focused": focused, "order": order}));
        if let Some((surface, document)) = documents.get(&address) {
            attached.push(
                json!({"surface": surface, "document": document, "frame": rect(view),
                "visible": !hidden, "focused": focused, "order": order}),
            );
        } else if modal.is_object() && modal_view == Some(address) {
            modal["frame"] = rect(view);
            // native surface 순서는 별도의 compositor plane에서 보고되므로 그 index는
            // webview subtree index와 비교할 수 없다. modal은 그 plane 전체 위에
            // 붙으므로 다음 순서를 갖는다.
            modal["order"] = json!(native_surfaces.len());
            modal["background"] = json!({"draws": view["draws"], "alpha": view["alpha"]});
        }
    }
    // 첫 응답자와 그것을 담은 웹뷰의 종류. 등록되지 않은 웹뷰는 webview, 웹뷰 밖의 뷰(예: 이미지
    // 영역)는 native 다. surface 는 첫 응답자를 담은 표면이다.
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

/// 메인 페이지를 같은 WebContent 프로세스에서 다시 읽고, 새 페이지가 준비를 알릴 때까지 기다린다. 준비된 페이지는
/// 먼저 대기 중인 저장을 끝낸다(docs/spec/projects.md#persistence). WebKit 은 새 페이지가 보이는 내용을 처음 그릴 때까지
/// 이전 페이지를 화면에 두고, 이전 페이지의 정리는 새 페이지의 시작 문서 요청이 한다(docs/spec/native-host.md#page-start).
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
        .map_err(internal)?
        .push(tx);
    if ready {
        // 준비된 페이지는 보낸 호출이 모두 답을 받은 뒤 스스로 다시 읽는다. 호스트가 다시 읽으면 그 순간 쓰고 있던
        // 응답이 사라진다(docs/spec/native-host.md#page-reload).
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
            format!("the reloaded page did not report ready within {TIMEOUT:?}"),
        )),
    }
}

/// 메인 페이지와 표시 중인 앱 문서가 현재 배치를 그릴 때까지 기다린다.
/// 창을 전체 화면으로 바꾸거나 되돌리고 전환이 끝난 뒤 반환한다. macOS 는 전환 중의 요청을
/// 무시하므로 네이티브 코드가 그 전환이 끝난 뒤에 이어서 처리한다.
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

/// 창의 표면 배치 트랜잭션과 현재 그림 래스터가 확정되고 메인 문서와 보이는 앱 문서가 그 배치를
/// 표시할 때까지 기다리고, 그 화면의 표시 시각(ms, mach 절대 시각)을 반환한다.
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
                        // 요청이 끝난 뒤의 실패는 그 요청이 보고하지 않았으므로 오류 줄로 남긴다.
                        Err(mpsc::SendError(Err(error))) => log_error("presentation", error),
                        Err(mpsc::SendError(Ok(_))) => crate::application_log::log_info(
                            "exposure",
                            "presentation completion arrived after its request ended",
                        ),
                    }
                }),
            ) {
                // 요청이 끝난 뒤의 실패는 그 요청이 보고하지 않았으므로 오류 줄로 남긴다.
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
        // 표시 장벽 대기의 계기(V5-104): 이 대기가 타임아웃에 걸리면 화면이 멈춘다.
        let barrier_started = std::time::Instant::now();
        let barrier = data.images.wait_current(remaining);
        crate::performance::observe(
            window.state::<crate::workspace::Workspace>().directory(),
            "host",
            || {
                serde_json::json!({"event": "barrier", "wait_us": barrier_started.elapsed().as_micros() as u64,
                    "ok": barrier.is_ok()})
            },
        );
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

/// 창 좌표의 점을 소유한 문서나 뷰를 반환한다.
fn hit(window: &Window, x: f64, y: f64) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let target = window.clone();
    let (found, context) = with_native_owner(window, move |handle| {
        // 등록은 Destroyed 가 지우므로 창이 열려 있는 이 단계에서 읽는다.
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
    let modal = context.overlay.view.lock().map_err(internal)?.clone();
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

/// 엔드포인트 요청을 이 애플리케이션의 창에서 실행한다.
pub(crate) struct Host(pub AppHandle);

impl Host {
    /// 창의 메인 페이지에 요청을 보내고 응답을 기다린다.
    pub(crate) fn page(
        &self,
        window: &Window,
        method: &str,
        params: Map<String, Value>,
        timeout: Duration,
    ) -> Result<Box<RawValue>, Failure> {
        self.page_then(window, method, params, Some(timeout), || {})
    }

    /// page 와 같고, 요청을 보낸 뒤 응답을 기다리기 전에 sent 를 호출한다. timeout 이 None 이면 답이나
    /// 페이지 종료까지 기다린다. 준비되지 않은 페이지는 요청을 받지 못하므로 1003 을 반환한다. 요청을
    /// 등록한 뒤 준비 여부를 보므로, 그 사이 다시 읽힌 페이지의 요청은 여기서 거부되거나 abandon 으로 끝난다.
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

    /// host.menu 가 보고하는 현재 메뉴 언어. 메뉴를 다시 만들지 않을지 정하는 상태와 같은
    /// 값이다.
    fn menu_language(&self) -> Result<String, Failure> {
        self.0
            .state::<crate::menu::MenuLanguage>()
            .0
            .lock()
            .map(|language| language.clone())
            .map_err(|_| internal("the menu language state is poisoned"))
    }

    /// 소유자가 host 인 이름의 요청을 실행한다.
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
            ("status.get", "host.dock") => {
                let platform = platform::current().map_err(internal)?;
                on_main(window, move || platform.dock_items()).map_err(internal)
            }
            ("status.get", "host.menu") => {
                // 언어는 호스트 상태에서 읽는다. 제목에서 유추하지 않는다
                // (docs/spec/host-contract.md 의 Application menu).
                let language = self.menu_language()?;
                let platform = platform::current().map_err(internal)?;
                let menus = on_main(window, move || platform.menu_items()).map_err(internal)?;
                Ok(json!({ "language": language, "menus": menus }))
            }
            (
                "status.watch" | "status.unwatch",
                "host.window" | "host.windows" | "host.screens" | "host.dock" | "host.menu"
                | "host.sidecars" | "host.buttons",
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

    /// 포인터 입력을 메인 스레드에서 전달한다. activate 이면 먼저 창을 활성화한다.
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
                            // 요청이 끝난 뒤의 실패는 그 요청이 보고하지 않았으므로 오류 줄로 남긴다.
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
            // 라이브러리는 ACTIVATION 이 지나면 멈춘 단계로 done 을 호출하므로 결과는 항상 도착한다.
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
        // 라이브러리는 RECEIPT 가 지나면 Unreceived 로 done 을 호출하므로 결과는 항상 도착한다.
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

    /// 키 입력을 메인 스레드에서 전달한다.
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

    fn call(
        &self,
        window: &str,
        method: &str,
        params: Map<String, Value>,
    ) -> Result<Box<RawValue>, Failure> {
        let window = windows::find(&self.0, window).ok_or_else(|| missing_window(window))?;
        // 모든 엔드포인트 메서드의 시간과 결과를 성능 트레이스에 남긴다(V5-104).
        // 거부도 그대로 기록한다 — 어긋난 값은 오류 문자열이 담는다.
        let started = std::time::Instant::now();
        let outcome = self.dispatch(&window, method, params);
        crate::performance::observe(
            window.state::<crate::workspace::Workspace>().directory(),
            "host",
            || {
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
            },
        );
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
                    // 기본값: 이름이 없는 요청은 host 항목이 아니므로 그대로 페이지에 보내고, 페이지가 인자를 검사한다.
                    .unwrap_or_default()
                    .to_string();
                if name == "host" || name.starts_with("host.") {
                    return raw(&self.host_entry(window, method, &name, &params)?);
                }
                // 메인 페이지는 표면에 전달한 명령을 선언의 제한 시간 안에 끝내므로 command.run 에는 제한을 두지 않는다.
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
