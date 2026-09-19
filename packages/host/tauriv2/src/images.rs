//! 표면 페이지의 외부 그림 표시 영역. docs/spec/sidecars.md 의 "그림 봉투"와 관련된다.
//!
//! 표면 페이지가 그림을 네이티브 영역에 표시하도록 요청한다. 호스트는 표면 웹뷰 안에
//! 그림 영역을 만들고, 페이지가 알린 여백으로 배치하며, 사이드카가 보낸 그림을 영역에
//! 표시한다. 그림 영역은 표면 웹뷰의 하위 뷰이므로 표면과 함께 옮겨지고 숨겨진다.
//! 표면이 제거되거나 표면 페이지가 다시 읽히면 닫는다.
//!
//! 명령은 메인 스레드 밖에서 실행되고 네이티브 작업은 메인 스레드에서 실행한다. 메인 스레드에서
//! 시작한 정리는 기다리지 않는다.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use serde::Deserialize;
use tauri::Webview;

use crate::exposure::{self, on_main, with_view};
use crate::log_error;
use crate::platform::{self, Handle, Insets};
use crate::windows::window_data;

/// 표면 페이지의 그림 영역 호출.
#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    pub surface: String,
    pub name: String,
    pub sidecar: Option<String>,
    #[serde(default)]
    pub left: f64,
    #[serde(default)]
    pub top: f64,
    #[serde(default)]
    pub right: f64,
    #[serde(default)]
    pub bottom: f64,
    #[serde(default)]
    pub visible: bool,
}

/// 표면과 그림 이름의 쌍.
pub type Key = (String, String);

/// 그림 영역을 등록한 사이드카 소유자.
pub struct Owner {
    pub sidecar_owner: String,
}

/// 호출한 표면 caller 가 request.surface 이고 그림 이름이 올바른지 확인하고 키를 반환한다.
pub fn check(caller: Option<&str>, request: &Request) -> Result<Key, String> {
    if caller != Some(request.surface.as_str()) {
        return Err(format!("this image is not surface {:?}", request.surface));
    }
    let mut chars = request.name.chars();
    let valid = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && request.name.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(format!("invalid image name {:?}", request.name));
    }
    Ok((request.surface.clone(), request.name.clone()))
}

/// 창의 그림 영역.
#[derive(Default)]
pub struct Images {
    inner: Mutex<Inner>,
}

struct Inner {
    handles: HashMap<Key, Handle>,
    owners: HashMap<Key, String>,
    sidecars: HashMap<Key, String>, // sidecar name for each image
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            handles: HashMap::new(),
            owners: HashMap::new(),
            sidecars: HashMap::new(),
        }
    }
}

impl Images {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 이름을 차지한다. sidecar 가 없거나 빈 문자열이면 오류를 반환한다.
    pub fn reserve(&self, key: &Key, owner: &str, sidecar: &str) -> Result<(), String> {
        if sidecar.is_empty() {
            return Err(format!("image {:?}: reserve requires a sidecar", key.1));
        }
        let mut inner = self.lock();
        if inner.handles.contains_key(key) {
            return Err(format!("image {:?} is already attached", key.1));
        }
        inner.handles.insert(key.clone(), 0);
        inner.owners.insert(key.clone(), owner.to_string());
        inner.sidecars.insert(key.clone(), sidecar.to_string());
        Ok(())
    }

    /// 차지한 이름에 만든 그림 영역의 주소를 적는다.
    pub fn set(&self, key: &Key, handle: Handle) -> bool {
        match self.lock().handles.get_mut(key) {
            Some(slot) => {
                *slot = handle;
                true
            }
            None => false,
        }
    }

    /// 만들어진 그림 영역의 주소를 반환한다.
    pub fn get(&self, key: &Key) -> Result<Handle, String> {
        match self.lock().handles.get(key) {
            Some(&handle) if handle != 0 => Ok(handle),
            _ => Err(format!("image {:?} is not attached", key.1)),
        }
    }

    /// 그림 영역을 등록한 사이드카 소유자를 반환한다.
    pub fn get_owner(&self, key: &Key) -> Result<String, String> {
        let inner = self.lock();
        if inner.handles.get(key).map(|&h| h != 0).unwrap_or(false) {
            Ok(inner.owners.get(key).cloned().unwrap_or_default())
        } else {
            Err(format!("image {:?} is not attached", key.1))
        }
    }

    /// 그림 영역을 등록한 사이드카 이름을 반환한다.
    pub fn get_sidecar(&self, key: &Key) -> Result<String, String> {
        let inner = self.lock();
        if inner.handles.get(key).map(|&h| h != 0).unwrap_or(false) {
            Ok(inner.sidecars.get(key).cloned().unwrap_or_default())
        } else {
            Err(format!("image {:?} is not attached", key.1))
        }
    }

    /// 이름을 제거하고 그 그림 영역의 주소를 반환한다.
    pub fn remove(&self, key: &Key) -> Result<Handle, String> {
        let mut inner = self.lock();
        match inner.handles.remove(key) {
            Some(handle) => {
                inner.owners.remove(key);
                inner.sidecars.remove(key);
                Ok(handle)
            }
            None => Err(format!("image {:?} is not attached", key.1)),
        }
    }

    /// 표면의 이름을 모두 제거하고 만들어진 그림 영역의 주소를 반환한다.
    pub fn remove_surface(&self, surface: &str) -> Vec<Handle> {
        let mut removed = Vec::new();
        let mut inner = self.lock();
        let keys: Vec<_> = inner.handles.keys().filter(|k| k.0 == surface).cloned().collect();
        for key in keys {
            if let Some(handle) = inner.handles.remove(&key) {
                inner.owners.remove(&key);
                inner.sidecars.remove(&key);
                if handle != 0 {
                    removed.push(handle);
                }
            }
        }
        removed
    }

    /// 만들어진 그림 영역의 주소별 키.
    pub fn names(&self) -> HashMap<Handle, Key> {
        let inner = self.lock();
        inner
            .handles
            .iter()
            .filter(|(_, &handle)| handle != 0)
            .map(|(key, &handle)| (handle, key.clone()))
            .collect()
    }

    /// 만들어진 그림 영역의 주소.
    pub fn all(&self) -> Vec<Handle> {
        self.lock().handles.values().copied().filter(|&handle| handle != 0).collect()
    }
}

/// 호출한 표면 caller 의 웹뷰와 요청된 표면을 확인하고 window 를 반환한다.
fn owner(webview: &Webview, request: &Request) -> Result<(Key, tauri::Window), String> {
    let window = webview.window();
    let label = webview.label();
    let prefix = format!("surface-{}-", window.label());
    let surface_id = label.strip_prefix(&prefix).ok_or_else(|| "invalid surface webview label".to_string())?;
    let key = check(Some(surface_id), request)?;
    Ok((key, window))
}

/// 만든 그림 영역을 창에 등록하고 핸들을 반환한다. 만드는 동안 표면이 제거되면 닫는다.
fn create(
    webview: &Webview,
    window: &tauri::Window,
    key: &Key,
    platform: &'static dyn platform::Platform,
) -> Result<Handle, String> {
    let surface = with_view(webview, move |view| platform.view_id(view))?;
    let (_surface_id, name) = key.clone();

    on_main(window, move || {
        let event = Box::new(move |_json: String| {
            // 그림 영역 이벤트는 나중에 구현
        });
        let handle = platform.create_image(surface, &name, event)?;
        Ok(handle)
    })
}

/// 만들어진 그림 영역에 대해 메인 스레드에서 run 을 실행한다.
fn with_image<T: Send + 'static>(
    webview: &Webview,
    request: &Request,
    run: impl Fn(Handle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let window = webview.window();
    let label = webview.label().to_string();
    let prefix = format!("surface-{}-", window.label());
    let surface_id = label.strip_prefix(&prefix).ok_or_else(|| "invalid surface webview label".to_string())?;
    let key = check(Some(surface_id), request)?;

    let Ok(data) = window_data(&window) else {
        return Err("cannot get window data".to_string());
    };

    on_main(&window, move || {
        let handle = data.images.get(&key)?;
        run(handle)
    })
}

/// 호출한 표면 페이지의 요소에 그림 영역을 붙인다.
pub(crate) fn attach(webview: &Webview, request: Request) -> Result<(), String> {
    let sidecar = request
        .sidecar
        .as_deref()
        .ok_or_else(|| format!("image {:?}: attach requires a sidecar", request.name))?;
    if sidecar.is_empty() {
        return Err(format!("image {:?}: attach requires a sidecar", request.name));
    }

    let (key, window) = owner(webview, &request)?;
    let platform = platform::current()?;
    let Ok(data) = window_data(&window) else {
        return Err("cannot get window data".to_string());
    };

    // 이름을 먼저 차지한다. 네이티브 작업을 기다리는 동안 잠금을 쥐지 않는다.
    data.images.reserve(&key, "", sidecar)?;
    let handle = match create(webview, &window, &key, platform) {
        Ok(handle) => handle,
        Err(error) => {
            if let Err(e) = data.images.remove(&key) {
                eprintln!("failed to remove reserved image {}: {}", key.1, e);
            }
            return Err(error);
        }
    };
    if !data.images.set(&key, handle) {
        if let Err(e) = on_main(&window, move || {
            let platform = platform::current()?;
            platform.close_image(handle)
        }) {
            eprintln!("failed to close image on main thread: {}", e);
        }
        if let Err(e) = data.images.remove(&key) {
            eprintln!("failed to remove image after failed set: {}", e);
        }
        return Err(format!("surface {:?} closed while its image was created", key.0));
    }
    exposure::window_changed(&window);
    Ok(())
}

/// 그림 영역을 표면 뷰포트 여백으로 배치한다.
pub(crate) fn place(webview: &Webview, request: Request) -> Result<(), String> {
    let platform = platform::current()?;
    let insets = Insets {
        left: request.left,
        top: request.top,
        right: request.right,
        bottom: request.bottom,
    };
    let visible = request.visible;
    with_image(webview, &request, move |handle| {
        platform.place_image(handle, insets, visible)
    })?;
    exposure::window_changed(&webview.window());
    Ok(())
}

/// 그림 영역을 첫 응답자로 만들고 포커스 이벤트를 보낸다.
pub(crate) fn focus(webview: &Webview, request: Request) -> Result<(), String> {
    let platform = platform::current()?;
    with_image(webview, &request, move |handle| platform.focus_image(handle))?;
    exposure::window_changed(&webview.window());
    Ok(())
}

/// 캐럿(입력 커서) 위치를 받아 둔다.
pub(crate) fn caret(webview: &Webview, request: Request, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let platform = platform::current()?;
    with_image(webview, &request, move |handle| platform.caret_image(handle, x, y, w, h))?;
    Ok(())
}

/// 접근성 값으로 보일 문자열을 받아 둔다.
pub(crate) fn text(webview: &Webview, request: Request, text: String) -> Result<(), String> {
    let platform = platform::current()?;
    with_image(webview, &request, move |handle| platform.text_image(handle, &text))?;
    Ok(())
}

/// 그림 영역을 닫는다.
pub(crate) fn detach(webview: &Webview, request: Request) -> Result<(), String> {
    let (key, window) = owner(webview, &request)?;
    let Ok(data) = window_data(&window) else {
        return Err("cannot get window data".to_string());
    };
    let platform = platform::current()?;

    // 등록 해제와 닫기를 메인 스레드의 한 작업에서 한다.
    on_main(&window, move || {
        let handle = data.images.remove(&key)?;
        if handle != 0 {
            platform.close_image(handle)?;
        }
        Ok(())
    })?;
    exposure::window_changed(&window);
    Ok(())
}

/// 표면의 그림 영역을 모두 닫는다. 메인 스레드 작업을 기다리지 않으므로 어느 스레드에서나 호출한다.
pub(crate) fn close_surface(window: &tauri::Window, surface: &str) {
    let Ok(data) = window_data(window) else { return };
    let Ok(platform) = platform::current() else { return };
    let host = window.clone();
    let surface = surface.to_string();

    log_error(
        window
            .run_on_main_thread(move || {
                let handles = data.images.remove_surface(&surface);
                if handles.is_empty() {
                    return;
                }
                for handle in handles {
                    log_error(platform.close_image(handle));
                }
                exposure::window_changed(&host);
            })
            .map_err(|e| e.to_string()),
    );
}

/// 이미지 봉투 의사 결정의 결과.
#[derive(Debug)]
pub enum Decision {
    /// 본문에 이미지 필드가 없음. 호출자가 페이지로 전달해야 함.
    NotImage,
    /// 응답을 사이드카에 보낼 오류.
    Reply {
        name: String,
        json: serde_json::Value,
    },
    /// 표시할 이미지.
    Present {
        id: u32,
        nonce: [u8; 16],
        width: i32,
        height: i32,
        scale: f64,
        name: String,
        sequence: i32,
    },
}

/// 이미지 봉투를 파싱하고 유효성을 검사하여 의사 결정을 반환한다.
/// body 는 "image" 필드를 포함하는 JSON 객체여야 한다.
/// 이미지 봉투가 아니면 NotImage 를 반환한다.
/// 유효하지 않으면 Reply 를 반환한다.
/// 유효하고 등록되어 있으면 Present 를 반환한다.
pub fn decide(body_str: &str, sender: &str, surface: &str, images: &Images) -> Decision {
    // 이벤트 본문을 파싱하여 image 필드 확인
    let obj: serde_json::Value = match serde_json::from_str(body_str) {
        Ok(obj) => obj,
        Err(_) => return Decision::NotImage,
    };

    let Some(image_val) = obj.get("image") else {
        return Decision::NotImage;
    };

    // 이미지 봉투 구조 정의
    #[derive(Deserialize)]
    struct ImageEnvelope {
        name: String,
        token: TokenInfo,
        width: i32,
        height: i32,
        scale: f64,
        format: String,
        sequence: i32,
    }

    #[derive(Deserialize)]
    struct TokenInfo {
        kind: String,
        id: u32,
        nonce: String,
    }

    let envelope: ImageEnvelope = match serde_json::from_value(image_val.clone()) {
        Ok(e) => e,
        Err(_) => return Decision::NotImage,
    };

    // 포맷과 토큰 종류 검증
    if envelope.format != "bgra8" || envelope.token.kind != "iosurface-global" {
        let name = envelope.name;
        return Decision::Reply {
            name: name.clone(),
            json: serde_json::json!({
                "image": {
                    "error": "unsupported",
                    "name": name,
                    "sequence": envelope.sequence
                }
            }),
        };
    }

    // nonce 를 base64 에서 디코딩하여 [u8; 16] 배열로 변환
    let decoded_nonce = match base64::engine::general_purpose::STANDARD.decode(&envelope.token.nonce) {
        Ok(bytes) => bytes,
        Err(_) => {
            let name = envelope.name;
            return Decision::Reply {
                name: name.clone(),
                json: serde_json::json!({
                    "image": {
                        "error": "unsupported",
                        "name": name,
                        "sequence": envelope.sequence
                    }
                }),
            };
        }
    };

    // 디코딩된 nonce 가 정확히 16바이트여야 함
    if decoded_nonce.len() != 16 {
        let name = envelope.name;
        return Decision::Reply {
            name: name.clone(),
            json: serde_json::json!({
                "image": {
                    "error": "unsupported",
                    "name": name,
                    "sequence": envelope.sequence
                }
            }),
        };
    }

    // nonce 를 [u8; 16] 배열로 변환
    let mut nonce: [u8; 16] = [0; 16];
    nonce.copy_from_slice(&decoded_nonce[..16]);

    // 이미지가 등록되어 있고 발신자가 일치하는지 확인
    let key = (surface.to_string(), envelope.name.clone());
    match images.get_sidecar(&key) {
        Ok(registered_sender) if registered_sender == sender => {
            // 발신자가 일치함 - 표시 가능
            Decision::Present {
                id: envelope.token.id,
                nonce,
                width: envelope.width,
                height: envelope.height,
                scale: envelope.scale,
                name: envelope.name,
                sequence: envelope.sequence,
            }
        }
        _ => {
            // 등록되지 않았거나 발신자가 다름
            let name = envelope.name;
            Decision::Reply {
                name: name.clone(),
                json: serde_json::json!({
                    "image": {
                        "error": "notAttached",
                        "name": name,
                        "sequence": envelope.sequence
                    }
                }),
            }
        }
    }
}

/// 이미지 표시 후 응답을 생성한다.
/// ok 가 true 면 released 응답을 반환하고, false 면 reason 을 오류로 반환한다.
pub fn after_present(ok: bool, reason: Option<&str>, name: &str, sequence: i32) -> serde_json::Value {
    if ok {
        serde_json::json!({
            "image": {
                "released": {
                    "name": name,
                    "sequence": sequence
                }
            }
        })
    } else {
        serde_json::json!({
            "image": {
                "error": reason.unwrap_or("unknown"),
                "name": name,
                "sequence": sequence
            }
        })
    }
}

/// 이미지 봉투를 처리한다. 메인 스레드에서 실행할 작업과 응답 전송 방식을 인자로 받는다.
/// 봉투를 처리했으면 true, 아니면 false를 반환한다.
pub fn handle_envelope<OnMain, SendResponse>(
    body_str: &str,
    sender: &str,
    surface: &str,
    images: &Images,
    on_main: OnMain,
    send_response: SendResponse,
) -> bool
where
    OnMain: Fn(Box<dyn Fn() -> Result<(), String> + Send>) -> Result<(), String>,
    SendResponse: Fn(&str, serde_json::Value) -> Result<(), String>,
{
    let decision = decide(body_str, sender, surface, images);

    match decision {
        Decision::NotImage => false,
        Decision::Reply { name, json } => {
            if let Err(e) = send_response(&name, json) {
                eprintln!("image reply {}: {}", name, e);
            }
            true
        }
        Decision::Present {
            id,
            nonce,
            width,
            height,
            scale,
            name,
            sequence,
        } => {
            let key = (surface.to_string(), name.clone());
            match images.get(&key) {
                Ok(handle) => {
                    let ok = match on_main(Box::new(move || {
                        match platform::current() {
                            Ok(plat) => {
                                plat.present_image(handle, id, nonce, width as f64, height as f64, scale).map(|_| ())
                            }
                            Err(e) => Err(e),
                        }
                    })) {
                        Ok(()) => true,
                        Err(e) => {
                            eprintln!("image present on main thread error: {}", e);
                            false
                        }
                    };

                    let response = if ok {
                        after_present(true, None, &name, sequence)
                    } else {
                        after_present(false, Some("presentFailed"), &name, sequence)
                    };
                    if let Err(e) = send_response(&name, response) {
                        eprintln!("image response {}: {}", name, e);
                    }
                }
                Err(_) => {
                    let response = after_present(false, Some("notAttached"), &name, sequence);
                    if let Err(e) = send_response(&name, response) {
                        eprintln!("image notAttached {}: {}", name, e);
                    }
                }
            }
            true
        }
    }
}
