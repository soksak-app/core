//! 표면 페이지 안의 문서 영역. docs/spec/native-surfaces.md 의 "문서 영역"이다.
//!
//! 표면 페이지가 자기 요소 하나에 외부 문서를 붙인다. 호스트는 그 표면 웹뷰 안에 문서 웹뷰를 두고,
//! 페이지가 알린 여백으로 배치하며, 문서 상태를 그 표면에만 보낸다. 문서 웹뷰는 표면 웹뷰의 하위
//! 뷰이므로 표면과 함께 옮겨지고 숨겨진다. 표면이 제거되거나 표면 페이지가 다시 읽히면 닫는다.
//!
//! 명령은 메인 스레드 밖에서 실행되고 네이티브 작업은 메인 스레드에서 실행한다. 메인 스레드에서
//! 시작한 정리는 기다리지 않는다.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, Webview, Window};

use crate::application_log::{log_error, log_failure};
use crate::exposure::{self, on_main, with_view};
use crate::platform::{self, Handle};
use crate::surfaces::{require_region, surface_handle};
use crate::windows::{emit_window, window_data};

/// 문서 영역의 영구 사이트 데이터를 두는 설정 디렉터리 안의 디렉터리. 앱 문서의 저장소와 다르다
/// (docs/spec/native-surfaces.md#document-regions).
const DOCUMENT_DATA: &str = "document-data";

/// 표면 페이지의 문서 영역 호출. 필드는 호출마다 필요한 것만 쓴다.
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
    /// 문서의 글자 배율(docs/spec/text-size.md). 없거나 유한한 양수가 아니면 오류다.
    pub fn zoom_factor(&self) -> Result<f64, String> {
        match self.zoom {
            Some(zoom) if zoom.is_finite() && zoom > 0.0 => Ok(zoom),
            _ => Err("document zoom must be a finite positive number".into()),
        }
    }
}

/// document-state 이벤트의 값.
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

/// 표면과 문서 이름의 쌍.
pub type Key = (String, String);

/// 호출한 표면 caller 가 request.surface 이고 문서 이름이 올바른지 확인하고 키를 반환한다.
/// caller 가 None 이면 호출한 웹뷰는 이 창의 표면이 아니다.
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

/// 창의 문서 영역. 값은 문서 웹뷰의 주소이고, 만드는 중인 영역은 0 이다.
#[derive(Default)]
pub struct Documents(Mutex<HashMap<Key, Handle>>);

impl Documents {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Handle>> {
        self.0
            .lock()
            // 기본값: 잠금을 쥔 채 멈춘 스레드도 맵을 한 번의 넣기, 빼기, 읽기로만 바꾸므로 맵은 일관되고, 그 멈춤은 패닉 보고로 이미 알려졌다.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 이름을 차지한다. 같은 이름이 이미 있으면 오류다.
    pub fn reserve(&self, key: &Key) -> Result<(), String> {
        let mut all = self.lock();
        if all.contains_key(key) {
            return Err(format!("document {:?} is already attached", key.1));
        }
        all.insert(key.clone(), 0);
        Ok(())
    }

    /// 차지한 이름에 만든 문서의 주소를 적는다. 그 사이에 이름이 제거되었으면 false 다.
    pub fn set(&self, key: &Key, handle: Handle) -> bool {
        match self.lock().get_mut(key) {
            Some(slot) => {
                *slot = handle;
                true
            }
            None => false,
        }
    }

    /// 만들어진 문서의 주소를 반환한다.
    pub fn get(&self, key: &Key) -> Result<Handle, String> {
        match self.lock().get(key) {
            Some(&handle) if handle != 0 => Ok(handle),
            _ => Err(format!("document {:?} is not attached", key.1)),
        }
    }

    /// 이름을 제거하고 그 문서의 주소를 반환한다. 만드는 중이던 이름이면 주소는 0 이다.
    pub fn remove(&self, key: &Key) -> Result<Handle, String> {
        self.lock()
            .remove(key)
            .ok_or_else(|| format!("document {:?} is not attached", key.1))
    }

    /// 표면의 이름을 모두 제거하고 만들어진 문서의 주소를 반환한다.
    pub fn remove_surface(&self, surface: &str) -> Vec<Handle> {
        let mut removed = Vec::new();
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

    /// 만들어진 문서의 주소별 키.
    pub fn names(&self) -> HashMap<Handle, Key> {
        self.lock()
            .iter()
            .filter(|(_, &handle)| handle != 0)
            .map(|(key, &handle)| (handle, key.clone()))
            .collect()
    }

    /// 만들어진 문서의 주소.
    pub fn all(&self) -> Vec<Handle> {
        self.lock()
            .values()
            .copied()
            .filter(|&handle| handle != 0)
            .collect()
    }
}

/// 호출한 웹뷰의 표면 id 를 확인하고 요청의 키와 창을 반환한다.
fn owner(webview: &Webview, request: &Request) -> Result<(Key, Window), String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(webview.label(), window.label(), "surface operations")?;
    let key = check(Some(request.surface.as_str()), request)?;
    Ok((key, window))
}

/// 표면 안에 숨긴 문서 영역을 만든다. 같은 이름이 이미 있으면 오류다.
pub(crate) fn attach(webview: &Webview, request: Request) -> Result<(), String> {
    let (key, window) = owner(webview, &request)?;
    let platform = platform::current()?;
    let data = window_data(&window)?;
    require_region(&data.compositions, &key.0, &key.1, "document", None)?;
    // 이름을 먼저 차지한다. 네이티브 작업을 기다리는 동안 잠금을 쥐지 않는다.
    data.documents.reserve(&key)?;
    let handle = match create(webview, &window, &key, platform, data.overlay.dialog()) {
        Ok(handle) => handle,
        Err(error) => {
            drop(data.documents.remove(&key));
            return Err(error);
        }
    };
    // 만드는 동안 표면이 제거되었으면 만든 문서를 닫는다. 등록과 닫기는 메인 스레드의 한 작업에서 한다.
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

/// 표면 웹뷰 안에 문서 웹뷰를 만들고 주소를 반환한다.
fn create(
    webview: &Webview,
    window: &Window,
    key: &Key,
    platform: &'static dyn platform::Platform,
    dialog: bool,
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
            .map_err(|e| e.to_string())?
            .get(&surface_id)
            .cloned()
            .ok_or_else(|| format!("surface {surface_id:?} has no composition declaration"))?;
        let config = crate::config_directory(host.app_handle()).map_err(|e| e.to_string())?;
        let folder = crate::installed::plugin_folder(&config, &plugin)?;
        let folder = folder
            .to_str()
            .ok_or_else(|| format!("plugin folder is not UTF-8: {}", folder.display()))?
            .to_string();
        let handle = platform.create_document(surface, directory, &folder, &plugin, changed)?;
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

/// 열린 문서 영역에 대해 메인 스레드에서 work 를 실행한다.
fn with_document<T: Send + 'static>(
    webview: &Webview,
    request: &Request,
    work: impl FnOnce(Handle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (key, window) = owner(webview, request)?;
    let data = window_data(&window)?;
    require_region(&data.compositions, &key.0, &key.1, "document", None)?;
    // 조회와 사용을 메인 스레드의 한 작업에서 한다. 닫기도 메인 스레드에서 등록 해제와 함께 일어나므로,
    // 조회한 주소는 이 작업 동안 해제되지 않는다.
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

/// 문서의 페이지 확대를 글자 배율로 정한다.
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

/// go 요청의 동작 번호와 거리. entry 는 0 이 아닌 offset 이 필요하고 다른 동작은 offset 을 받지 않는다.
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

/// 기록 이동, 기록 항목 열기, 다시 읽기, 멈춤을 실행하고 실행했는지 반환한다.
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
    // 등록 해제와 닫기를 메인 스레드의 한 작업에서 한다.
    on_main(&window, move || {
        let handle = data.documents.remove(&key)?;
        if handle != 0 {
            platform.close_document(handle)?;
        }
        Ok(())
    })?;
    exposure::window_changed(&window);
    Ok(())
}

/// 표면의 문서 영역을 모두 닫는다. 메인 스레드 작업을 기다리지 않으므로 어느 스레드에서나 호출한다.
pub(crate) fn close_surface(window: &Window, surface: &str) {
    let Ok(data) = window_data(window) else {
        return;
    };
    let platform = match platform::current() {
        Ok(platform) => platform,
        Err(error) => return log_error("document close", error),
    };
    let host = window.clone();
    let surface = surface.to_string();
    // 등록 해제와 닫기를 메인 스레드의 한 작업에서 한다. 문서를 쓰는 다른 작업도 메인 스레드에서
    // 조회하므로 해제된 주소를 쓰지 않는다.
    log_failure(
        "document close",
        window
            .run_on_main_thread(move || {
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

/// 대화 상자가 열린 동안 문서 영역을 흐리게 표시한다. 기다리지 않는다.
pub(crate) fn set_background(window: &Window, enabled: bool) {
    let Ok(data) = window_data(window) else {
        return;
    };
    let platform = match platform::current() {
        Ok(platform) => platform,
        Err(error) => return log_error("document background", error),
    };
    // 문서 주소는 메인 스레드에서 조회한다. 닫기와 같은 스레드이므로 해제된 주소를 쓰지 않는다.
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
