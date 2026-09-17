//! 프로젝트 창, 창 등록부, 준비/닫기/종료, 창 상태, 창 버튼.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::webview::Color;
use tauri::{AppHandle, Emitter, EventTarget, LogicalSize, Manager, Webview, WebviewUrl, WebviewWindowBuilder, Window};

use crate::log_error;
use crate::modals::Overlay;
use crate::platform::{self, Handle};
use crate::projects::project_folder;
use crate::shapes::Shapes;
use crate::sidecars::WindowSidecars;
use crate::surfaces::{Rect, Resizing, Running, Views, Watching};
use crate::theme::CurrentTheme;

/// 창 하나의 상태.
#[derive(Default)]
pub(crate) struct WindowData {
    pub overlay: Overlay,
    pub shapes: Shapes,
    pub theme: CurrentTheme,
    pub views: Views,
    pub watching: Watching,
    pub resizing: Resizing,
    pub running: Running,
    pub root: Mutex<String>,
    pub ready: AtomicBool,
    /// 다음 페이지 준비를 기다리는 요청.
    pub readied: Mutex<Vec<std::sync::mpsc::Sender<()>>>,
    /// 표면 페이지가 등록한 항목 (표면, 종류, 이름). 메인 페이지가 다시 읽히면 새 페이지에 다시 알린다.
    pub registrations: Mutex<Vec<(String, String, String)>>,
}

/// 애플리케이션의 창 등록부와 프로젝트 소유 창.
#[derive(Default)]
pub(crate) struct Windows {
    quitting: AtomicBool,
    next_window: AtomicU64,
    opening: Mutex<()>,
    windows: Mutex<HashMap<String, Arc<WindowData>>>,
    owners: Mutex<HashMap<String, String>>,
}

/// 창 버튼 위치. 콘텐츠 왼쪽 위에서 잰 값으로, 맨 왼쪽 버튼의 왼쪽 끝과 버튼의 세로 중앙이다.
/// 세로 중앙은 페이지 첫 행(`packages/workbench/app.css` 의 `.chrome-bar`, 45px)의 가운데다.
/// Wails 호스트도 같은 위치에 배치하고, `e2e/controls.test.mjs` 가 두 호스트의 결과를 측정한다.
const CONTROLS_AT: (f64, f64) = (12.0, 22.5);

/// 창의 상태를 반환한다.
pub(crate) fn window_data(window: &Window) -> Result<Arc<WindowData>, String> {
    window.state::<Windows>().windows.lock().map_err(|e| e.to_string())?
        .get(window.label()).cloned().ok_or_else(|| "project window is closed".into())
}

/// 창의 메인 웹뷰를 반환한다.
pub(crate) fn root_view(window: &Window) -> Option<Webview> {
    window.get_webview(window.label())
}

/// 창의 네이티브 주소를 반환한다.
pub(crate) fn native_owner(window: &Window) -> Result<Handle, String> {
    platform::current()?.window_handle(window)
}

/// 창의 웹뷰에 이벤트를 보낸다. main 창이면 애플리케이션 수신기에도 보낸다.
pub(crate) fn emit_window<S: Serialize + Clone>(window: &Window, event: &str, payload: S) -> tauri::Result<()> {
    let labels: Vec<_> = window.webviews().iter().map(|v| v.label().to_string()).collect();
    window.emit_filter(event, payload, |target| match target {
        EventTarget::Webview { label } => labels.contains(label),
        EventTarget::App => window.label() == "main",
        _ => false,
    })
}

/// 모든 창에 workspace-changed 를 보낸다.
pub(crate) fn notify_workspace(app: &AppHandle) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "workspace-changed", ()) {
            eprintln!("{error}");
        }
    }
}

/// 등록된 창 중 label 의 창을 반환한다.
pub(crate) fn find(app: &AppHandle, label: &str) -> Option<Window> {
    let registered = app.state::<Windows>().windows.lock().is_ok_and(|windows| windows.contains_key(label));
    if !registered {
        return None;
    }
    app.get_window(label)
}

/// 등록된 창의 식별자, 제목, 소유 프로젝트 id, 키 창 여부를 창 식별자 순서로 반환한다.
pub(crate) fn list(app: &AppHandle) -> Result<serde_json::Value, String> {
    let registry = app.state::<Windows>();
    let mut labels: Vec<String> = registry.windows.lock().map_err(|e| e.to_string())?.keys().cloned().collect();
    labels.sort();
    let mut listed = Vec::new();
    for label in labels {
        let Some(window) = app.get_window(&label) else { continue };
        let root = window_data(&window)?.root.lock().map_err(|e| e.to_string())?.clone();
        let project = if root.is_empty() { None } else { Some(root) };
        let ready = window_data(&window)?.ready.load(Ordering::Relaxed);
        listed.push(serde_json::json!({
            "ready": ready,
            "window": label,
            "title": window.title().map_err(|e| e.to_string())?,
            "project": project,
            "key": window.is_focused().map_err(|e| e.to_string())?,
        }));
    }
    Ok(serde_json::Value::Array(listed))
}

/// 창에 열린 프로젝트 id 목록을 반환한다.
pub(crate) fn opened(app: &AppHandle) -> Result<Vec<String>, String> {
    Ok(app.state::<Windows>().owners.lock().map_err(|e| e.to_string())?.keys().cloned().collect())
}

fn new_window(app: &AppHandle, label: &str, url: &str, title: &str) -> Result<Window, String> {
    let created = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(1200.0, 760.0)
        .background_color(Color(16, 17, 23, 255));
    let created = platform::current()?.prepare_window(created)?;
    let window = created.build().map_err(|e| e.to_string())?.as_ref().window();
    register(window.clone())?;
    crate::exposure::windows_changed(app);
    Ok(window)
}

/// 새 프로젝트 창을 연다.
pub(crate) fn window_new(app: AppHandle) -> Result<(), String> {
    let id = app.state::<Windows>().next_window.fetch_add(1, Ordering::Relaxed);
    new_window(&app, &format!("project-window-{id}"), "index.html", "soksak / Tauri v2")?;
    Ok(())
}

/// 창을 등록부에 추가하고 창 이벤트를 처리한다. 창 버튼은 페이지가 준비될 때와 창 크기가 바뀔 때 배치한다.
pub(crate) fn register(window: Window) -> Result<(), String> {
    let context = Arc::new(WindowData::default());
    window.state::<Windows>().windows.lock().map_err(|e| e.to_string())?
        .insert(window.label().into(), context.clone());
    let platform = platform::current()?;
    let owner = native_owner(&window)?;
    let host = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } if context.ready.load(Ordering::Relaxed) => {
            api.prevent_close();
            if let Err(error) = emit_window(&host, "project-close-request", ()) {
                eprintln!("{error}");
            }
        }
        tauri::WindowEvent::Destroyed => {
            crate::exposure::window_closed(&host);
            log_error(platform.cancel_layout(owner));
            if let Ok(mut monitor) = context.watching.0.lock() {
                if let Some(monitor) = monitor.take() {
                    log_error(platform.unwatch_input(monitor));
                }
            }
            if let Ok(mut shapes) = context.shapes.0.lock() {
                for (_, shape) in shapes.drain() {
                    log_error(platform.destroy_shape(shape));
                }
            }
            log_error(host.state::<WindowSidecars>().retain(&host, &|_| false));
            let registry = host.state::<Windows>();
            if let Ok(mut owners) = registry.owners.lock() {
                owners.retain(|_, label| label != host.label());
            }
            if let Ok(mut windows) = registry.windows.lock() {
                windows.remove(host.label());
                if windows.is_empty() && registry.quitting.load(Ordering::Relaxed) {
                    host.app_handle().exit(0);
                }
            };
            notify_workspace(host.app_handle());
            crate::exposure::windows_changed(host.app_handle());
        }
        tauri::WindowEvent::Resized(_) => {
            log_error(place_window_controls(&host));
            crate::exposure::window_changed(&host);
        }
        tauri::WindowEvent::Focused(_) => {
            crate::exposure::window_changed(&host);
            crate::exposure::windows_changed(host.app_handle());
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            crate::exposure::window_changed(&host);
        }
        _ => {}
    });
    Ok(())
}

/// 창 위치와 크기. 위치는 물리 픽셀, 크기는 논리 픽셀이다.
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Geometry {
    x: i32,
    y: i32,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
pub(crate) struct OpenProject {
    id: String,
    root: String,
    title: String,
    separate: bool,
    geometry: Option<Geometry>,
}

/// 프로젝트를 연다. 이미 열린 프로젝트는 소유 창을 활성화하고, separate 이고 요청 창이 다른
/// 프로젝트를 소유하면 새 창을 만든다.
pub(crate) fn project_open(window: &Window, request: OpenProject) -> Result<serde_json::Value, String> {
    if request.id.is_empty() || !request.id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
        return Err("invalid project id".into());
    }
    let folder = project_folder(window.app_handle(), request.root)?;
    let registry = window.state::<Windows>();
    let _opening = registry.opening.lock().map_err(|e| e.to_string())?;
    let owner = registry.owners.lock().map_err(|e| e.to_string())?.get(&request.id).cloned();
    if let Some(label) = owner {
        let owner = window.get_window(&label).ok_or("project window is closed")?;
        *window_data(&owner)?.root.lock().map_err(|e| e.to_string())? = folder.root;
        owner.set_title(&format!("{} / Tauri v2", request.title)).map_err(|e| e.to_string())?;
        crate::exposure::windows_changed(window.app_handle());
        if label != window.label() {
            emit_window(&owner, "project-activate", &request.id).map_err(|e| e.to_string())?;
            owner.show().map_err(|e| e.to_string())?;
            owner.set_focus().map_err(|e| e.to_string())?;
        }
        return Ok(serde_json::json!({"local": label == window.label()}));
    }
    let occupied = registry.owners.lock().map_err(|e| e.to_string())?.values().any(|label| label == window.label());
    let owner = if request.separate && occupied {
        let label = format!("project-{}", request.id);
        new_window(window.app_handle(), &label, &format!("index.html?project={}", request.id), &request.title)?
    } else {
        window.clone()
    };
    registry.owners.lock().map_err(|e| e.to_string())?.insert(request.id, owner.label().into());
    *window_data(&owner)?.root.lock().map_err(|e| e.to_string())? = folder.root;
    owner.set_title(&format!("{} / Tauri v2", request.title)).map_err(|e| e.to_string())?;
    crate::exposure::windows_changed(window.app_handle());
    if let Some(g) = request.geometry.filter(|g| g.width > 0.0 && g.height > 0.0) {
        owner.set_size(LogicalSize::new(g.width, g.height)).map_err(|e| e.to_string())?;
        owner.set_position(tauri::PhysicalPosition::new(g.x, g.y)).map_err(|e| e.to_string())?;
    }
    notify_workspace(window.app_handle());
    Ok(serde_json::json!({"local": owner.label() == window.label()}))
}

/// 프로젝트 id 와 창의 연결을 해제한다.
pub(crate) fn project_release(window: &Window, id: String) -> Result<(), String> {
    window.state::<Windows>().owners.lock().map_err(|e| e.to_string())?.remove(&id);
    notify_workspace(window.app_handle());
    Ok(())
}

/// 일반 상태 창의 위치와 크기를 반환한다. 최대화, 전체 화면, 최소화 상태이면 None 이다.
pub(crate) fn window_state(window: &Window) -> Result<Option<Geometry>, String> {
    if window.is_maximized().map_err(|e| e.to_string())?
        || window.is_fullscreen().map_err(|e| e.to_string())?
        || window.is_minimized().map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    let at = window.outer_position().map_err(|e| e.to_string())?;
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    Ok(Some(Geometry { x: at.x, y: at.y, width: size.width, height: size.height }))
}

/// 페이지가 창 닫기 요청을 처리할 준비가 되었음을 기록한다.
pub(crate) fn window_ready(window: &Window) -> Result<(), String> {
    // 창을 등록할 때 AppKit 이 아직 단추를 만들지 않았을 수 있다. 페이지가 준비되면 창이
    // 표시된 상태이므로 여기서도 단추를 둔다.
    place_window_controls(window)?;
    let data = window_data(window)?;
    data.ready.store(true, Ordering::Relaxed);
    crate::exposure::replay_registrations(window);
    crate::exposure::windows_changed(window.app_handle());
    for ready in data.readied.lock().map_err(|e| e.to_string())?.drain(..) {
        let _ = ready.send(());
    }
    crate::exposure::rewatch(window);
    emit_window(window, "page-ready", ()).map_err(|e| e.to_string())
}

/// 창을 닫는다.
pub(crate) fn window_close(window: &Window) -> Result<(), String> {
    window_data(window)?.ready.store(false, Ordering::Relaxed);
    window.close().map_err(|e| e.to_string())
}

/// 종료 요청을 처리한다. 준비된 창이 있으면 종료를 막고 각 창에 닫기 요청을 보낸다.
pub(crate) fn quit(app: &AppHandle, api: tauri::ExitRequestApi) {
    let registry = app.state::<Windows>();
    let waiting: Vec<_> = registry.windows.lock().expect("window registry").iter()
        .filter(|(_, context)| context.ready.load(Ordering::Relaxed))
        .map(|(label, _)| label.clone())
        .collect();
    if waiting.is_empty() {
        return;
    }
    api.prevent_exit();
    registry.quitting.store(true, Ordering::Relaxed);
    for (label, window) in app.windows() {
        let result = if waiting.contains(&label) {
            emit_window(&window, "project-close-request", ())
        } else {
            window.close()
        };
        if let Err(error) = result {
            eprintln!("{error}");
        }
    }
}

/// 창 버튼을 페이지 첫 줄 안에 배치하고 결과를 반환한다.
///
/// 플랫폼은 표준 제목 표시줄 높이에 맞춰 버튼을 배치하고, 그 높이는 페이지 첫 줄보다 낮다.
/// AppKit 은 메인 스레드에서 뷰를 배치한다. 호출하는 창 이벤트와 동기 명령은 메인 스레드에서
/// 실행되고, 네이티브 함수가 이를 확인한다.
fn place_window_controls(window: &Window) -> Result<(), String> {
    let handle = native_owner(window)?;
    platform::current()?.place_window_controls(handle, CONTROLS_AT.0, CONTROLS_AT.1)
}

/// 창 버튼이 차지하는 영역을 페이지 좌표로 반환한다. 페이지는 첫 줄에서 그 영역을 비운다.
pub(crate) fn window_controls(window: &Window) -> Result<Rect, String> {
    let handle = native_owner(window)?;
    let (x, y, w, h) = platform::current()?.window_controls(handle)?;
    Ok(Rect { x, y, w, h })
}
