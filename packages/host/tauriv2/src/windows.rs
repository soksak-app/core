//! 프로젝트 창, 창 등록부, 준비/닫기/종료, 창 상태, 창 버튼.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tauri::webview::Color;
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalSize, Manager, Webview, WebviewUrl,
    WebviewWindowBuilder, Window,
};

use crate::application_log::{log_error, log_failure};
use crate::modals::Overlay;
use crate::platform::{self, Handle};
use crate::projects::project_folder;
use crate::shapes::Shapes;
use crate::sidecars::WindowSidecars;
use crate::surfaces::{Rect, Running, SurfaceComposition, Views, Watching};
use crate::theme::CurrentTheme;

/// 창 하나의 상태.
#[derive(Default)]
pub(crate) struct WindowData {
    pub overlay: Overlay,
    pub shapes: Shapes,
    pub theme: CurrentTheme,
    pub views: Views,
    /// 논리 SurfaceHost의 핸들. DOM WebView가 아니라 main WebView 아래 native host다.
    pub surface_hosts: Mutex<HashMap<String, Handle>>,
    pub watching: Watching,
    pub running: Running,
    pub root: Mutex<String>,
    pub ready: AtomicBool,
    /// 막지 않은 닫기 요청을 받은 창. 이 창은 Destroyed 전에 runtime 에서 사라지므로 목록에 넣지 않는다.
    pub closing: AtomicBool,
    /// 다음 페이지 준비를 기다리는 요청.
    pub readied: Mutex<Vec<std::sync::mpsc::Sender<()>>>,
    /// 표면 페이지가 등록한 항목 (표면, 종류, 이름). 메인 페이지가 다시 읽히면 새 페이지에 다시 알린다.
    pub registrations: Mutex<Vec<(String, String, String)>>,
    /// 표면 페이지의 문서 영역.
    pub documents: crate::documents::Documents,
    /// 표면 페이지의 그림 영역.
    pub images: crate::images::Images,
    /// 메인 페이지가 선언하고 호스트가 영역 호출 권한 검사에 쓰는 표면 합성.
    pub compositions: Mutex<HashMap<String, SurfaceComposition>>,
    /// The plugin of each surface that declared its composition; its document regions serve that plugin's package.
    pub surface_plugins: Mutex<HashMap<String, String>>,
    /// 표면별로 마지막에 적용한 완전한 합성 리비전.
    pub composition_revisions: Mutex<HashMap<String, u64>>,
}

/// 앱 DOM 재로드는 모든 플러그인 문서를 교체하지만 터미널 세션은 종료하지 않는다.
///
/// Tauri는 main-webview `PageLoadEvent::Started` callback에서 이것을 호출한다. 여기서 cleanup은
/// 의도적으로 동기적이다. 이전 image handle이 같은 AppKit run loop에서 제거 대기 중인 동안
/// 교체 page가 새 native image를 붙이면 안 되기 때문이다.
pub(crate) fn reload_surface_documents(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    let owner = native_owner(window)?;
    let platform = platform::current()?;
    let window = window.clone();
    platform.cancel_layout(owner)?;
    let surfaces: Vec<_> = data
        .surface_hosts
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|(id, handle)| (id.clone(), *handle))
        .collect();
    let reconnect = RawValue::from_string(r#"{"operation":"reconnect"}"#.to_string())
        .map_err(|error| error.to_string())?;
    let running_persistent = window
        .state::<WindowSidecars>()
        .running_persistent_names()?;
    for (surface, handle) in surfaces {
        let mut sidecars = data.images.sidecars_for_surface(&surface);
        sidecars.extend(running_persistent.iter().cloned());
        sidecars.sort();
        sidecars.dedup();
        platform.set_surface_hidden_handle(handle, true)?;
        data.images.begin_generation(&surface);
        crate::exposure::surface_closed(&window, &surface);
        for document in data.documents.remove_surface(&surface) {
            platform.close_document(document)?;
        }
        for image in data.images.remove_surface(&surface) {
            platform.close_image(image)?;
        }
        // persistent sidecar는 reconnect를 받는 즉시 새 래스터를 보낼 수 있다.
        // 새 프레임이 이전 IOSurface 종료와 경합하거나 그 token을 재사용하지 않도록
        // 모든 이전 native image를 먼저 제거한다.
        for sidecar in sidecars {
            window.state::<WindowSidecars>().send(
                &window,
                &sidecar,
                &surface,
                reconnect.as_ref(),
            )?;
        }
    }
    data.composition_revisions
        .lock()
        .map_err(|e| e.to_string())?
        .clear();
    crate::exposure::window_changed(&window);
    Ok(())
}

/// 애플리케이션의 창 등록부와 프로젝트 소유 창.
#[derive(Default)]
pub(crate) struct Windows {
    pub(crate) quit: crate::quit::Quit,
    next_window: AtomicU64,
    opening: Mutex<()>,
    windows: Mutex<HashMap<String, Arc<WindowData>>>,
    owners: Mutex<HashMap<String, String>>,
}

/// 창의 상태를 반환한다.
pub(crate) fn window_data(window: &Window) -> Result<Arc<WindowData>, String> {
    window
        .state::<Windows>()
        .windows
        .lock()
        .map_err(|e| e.to_string())?
        .get(window.label())
        .cloned()
        .ok_or_else(|| "project window is closed".into())
}

/// 창의 메인 웹뷰를 반환한다.
pub(crate) fn root_view(window: &Window) -> Option<Webview> {
    window.get_webview(window.label())
}

/// 창의 네이티브 주소를 반환한다.
pub(crate) fn native_owner(window: &Window) -> Result<Handle, String> {
    platform::current()?.window_handle(window)
}

/// 창의 네이티브 주소를 쓰는 작업의 실패.
#[derive(Debug, PartialEq)]
pub enum NativeFailure {
    /// 창이 작업의 메인 스레드 단계 전에 닫혔다. 네이티브 코드는 창을 받지 않았다.
    Closed,
    /// 주소를 읽지 못했거나 네이티브 코드가 실패했다.
    Failed(String),
}

impl std::fmt::Display for NativeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NativeFailure::Closed => f.write_str("project window is closed"),
            NativeFailure::Failed(error) => f.write_str(error),
        }
    }
}

/// 메인 스레드의 한 단계에서 실행할 작업.
pub type MainStep = Box<dyn FnOnce() + Send>;

/// owner 로 창의 네이티브 주소를 읽고 그 주소로 work 를 실행한다. 읽기와 실행은 on_main 이 실행하는 한 메인
/// 스레드 단계에 있다. 창의 닫기는 메인 스레드가 처리하고 그 처리에서 runtime 이 NSWindow 를 닫고 놓으므로,
/// 단계를 나누면 그 사이의 닫기가 닫힌 창의 주소를 네이티브 코드에 넘긴다. 단계 전에 닫힌 창은 owner 가 None 이고
/// work 를 실행하지 않고 Closed 를 반환한다.
pub fn use_owner<W: Send + 'static, T: Send + 'static>(
    window: W,
    on_main: impl FnOnce(MainStep) -> Result<(), String>,
    owner: impl FnOnce(&W) -> Result<Option<Handle>, String> + Send + 'static,
    work: impl FnOnce(Handle) -> Result<T, String> + Send + 'static,
) -> Result<T, NativeFailure> {
    let (tx, rx) = mpsc::channel();
    on_main(Box::new(move || {
        let result = match owner(&window) {
            Ok(Some(handle)) => work(handle).map_err(NativeFailure::Failed),
            Ok(None) => Err(NativeFailure::Closed),
            Err(error) => Err(NativeFailure::Failed(error)),
        };
        match tx.send(result) {
            Ok(()) => {}
            // 요청이 끝난 뒤의 실패는 그 요청이 보고하지 않았으므로 오류 줄로 남긴다.
            Err(mpsc::SendError(Err(error))) => log_error("native window work", error),
            Err(mpsc::SendError(Ok(_))) => {
                eprintln!("native window result arrived after its request ended")
            }
        }
    }))
    .map_err(NativeFailure::Failed)?;
    rx.recv()
        .map_err(|e| NativeFailure::Failed(e.to_string()))?
}

/// 등록되어 있고 닫기가 받아들여지지 않은 창의 네이티브 주소. 닫히는 창이나 Destroyed 가 등록을 지운 창은
/// None 이다. 메인 스레드에서 호출한다. 닫기 요청을 막지 않으면 runtime 은 같은 메인 스레드 처리에서 closing 을
/// 세운 뒤 창을 닫으므로, 메인 스레드에서 closing 이 아니면 창은 열려 있다.
fn open_owner(window: &Window) -> Result<Option<Handle>, String> {
    let open = window
        .state::<Windows>()
        .windows
        .lock()
        .map_err(|e| e.to_string())?
        .get(window.label())
        .is_some_and(|data| !data.closing.load(Ordering::Relaxed));
    if !open {
        return Ok(None);
    }
    native_owner(window).map(Some)
}

/// 메인 스레드의 한 단계에서 창의 네이티브 주소를 읽고 그 주소로 work 를 실행한다. 그 단계 전에 닫힌 창은
/// work 를 실행하지 않고 Closed 이다.
pub(crate) fn with_native_owner<T: Send + 'static>(
    window: &Window,
    work: impl FnOnce(Handle) -> Result<T, String> + Send + 'static,
) -> Result<T, NativeFailure> {
    use_owner(
        window.clone(),
        |step| {
            crate::exposure::on_main(window, move || {
                step();
                Ok(())
            })
        },
        open_owner,
        work,
    )
}

/// 창의 열린 표면 배치 트랜잭션을 취소한다. 닫힌 창의 트랜잭션은 그 창의 Destroyed 가 취소하므로 취소할 것이
/// 없다.
pub(crate) fn cancel_window_layout(window: &Window) -> Result<(), String> {
    let platform = platform::current()?;
    match with_native_owner(window, move |owner| platform.cancel_layout(owner)) {
        Ok(()) | Err(NativeFailure::Closed) => Ok(()),
        Err(NativeFailure::Failed(error)) => Err(error),
    }
}

/// 창의 웹뷰에 이벤트를 보낸다. main 창이면 애플리케이션 수신기에도 보낸다.
pub(crate) fn emit_window<S: Serialize + Clone>(
    window: &Window,
    event: &str,
    payload: S,
) -> tauri::Result<()> {
    let labels: Vec<_> = window
        .webviews()
        .iter()
        .map(|v| v.label().to_string())
        .collect();
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
            log_error("workspace-changed", error);
        }
    }
}

/// Whether the application is quitting, which ends the WebContent process of each window on purpose.
pub(crate) fn is_quitting(app: &AppHandle) -> bool {
    app.state::<Windows>().quit.active()
}

/// Sends sidecars-changed to every window (docs/spec/installation.md).
pub(crate) fn notify_sidecars(app: &AppHandle) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "sidecars-changed", ()) {
            log_error("sidecars-changed", error);
        }
    }
}

/// 모든 창에 plugins-changed 를 보낸다.
pub(crate) fn notify_plugins(app: &AppHandle, change: crate::plugins::Changed) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "plugins-changed", change.clone()) {
            log_error("plugins-changed", error);
        }
    }
}

/// 등록된 창 중 label 의 창을 반환한다.
pub(crate) fn find(app: &AppHandle, label: &str) -> Option<Window> {
    let registered = app
        .state::<Windows>()
        .windows
        .lock()
        .is_ok_and(|windows| windows.contains_key(label));
    if !registered {
        return None;
    }
    app.get_window(label)
}

/// 등록된 창의 식별자, 제목, 소유 프로젝트 id, 키 창 여부를 창 식별자 순서로 반환한다.
pub(crate) fn list(app: &AppHandle) -> Result<serde_json::Value, String> {
    // 식별자와 상태를 한 번에 읽는다. 따로 읽으면 그 사이에 Destroyed 가 등록을 지울 수 있다.
    let mut registered: Vec<(String, Arc<WindowData>)> = app
        .state::<Windows>()
        .windows
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|(label, data)| (label.clone(), data.clone()))
        .collect();
    registered.sort_by(|a, b| a.0.cmp(&b.0));
    let windows: Vec<(Window, Arc<WindowData>)> = registered
        .into_iter()
        .filter_map(|(label, data)| app.get_window(&label).map(|window| (window, data)))
        .collect();
    list_entries(
        windows,
        |step| crate::exposure::app_on_main(app, step),
        |(window, data)| {
            let root = data.root.lock().map_err(|e| e.to_string())?.clone();
            window_entry(
                window.label(),
                data.closing.load(Ordering::Relaxed),
                data.ready.load(Ordering::Relaxed),
                root,
                || window.title().map_err(|e| e.to_string()),
                || window.is_focused().map_err(|e| e.to_string()),
            )
        },
    )
}

/// host.windows 목록의 한 번의 메인 스레드 단계.
pub type ListStep = Box<dyn FnOnce() -> Result<Vec<serde_json::Value>, String> + Send>;

/// 창마다 entry 로 목록 항목을 만든다. 모든 창의 entry 를 on_main 이 실행하는 한 메인 스레드 단계에서
/// 만든다. 창의 닫기는 메인 스레드가 처리하므로, 한 단계 안에서는 closing 을 읽은 뒤 조회하기 전에 창이
/// runtime 에서 빠지지 않는다. 메인 스레드에서 부른 창 조회는 기다리지 않고 바로 처리된다
/// (tauri-runtime-wry 의 send_user_message).
pub fn list_entries<W: Send + 'static>(
    windows: Vec<W>,
    on_main: impl FnOnce(ListStep) -> Result<Vec<serde_json::Value>, String>,
    entry: impl Fn(&W) -> Result<Option<serde_json::Value>, String> + Send + 'static,
) -> Result<serde_json::Value, String> {
    let listed = on_main(Box::new(move || {
        let mut listed = Vec::new();
        for window in &windows {
            listed.extend(entry(window)?);
        }
        Ok(listed)
    }))?;
    Ok(serde_json::Value::Array(listed))
}

/// host.windows 의 창 하나. 닫기가 받아들여진 창은 조회하지 않고 None 이다. 그 창은 Destroyed 전에
/// runtime 에서 사라져 제목과 초점 조회가 실패하기 때문이다. 다른 창의 조회 실패는 오류로 반환한다.
pub fn window_entry(
    label: &str,
    closing: bool,
    ready: bool,
    root: String,
    title: impl FnOnce() -> Result<String, String>,
    key: impl FnOnce() -> Result<bool, String>,
) -> Result<Option<serde_json::Value>, String> {
    if closing {
        return Ok(None);
    }
    let project = if root.is_empty() { None } else { Some(root) };
    Ok(Some(serde_json::json!({
        "ready": ready,
        "window": label,
        "title": title()?,
        "project": project,
        "key": key()?,
    })))
}

/// 창에 열린 프로젝트 id 목록을 반환한다.
pub(crate) fn opened(app: &AppHandle) -> Result<Vec<String>, String> {
    Ok(app
        .state::<Windows>()
        .owners
        .lock()
        .map_err(|e| e.to_string())?
        .keys()
        .cloned()
        .collect())
}

/// 프로젝트를 열지 않은 창의 제목. 첫 창의 제목은 tauri.conf.json 이 같은 값으로 선언한다.
const WINDOW_TITLE: &str = "soksak / Tauri v2";

fn new_window(app: &AppHandle, label: &str, url: &str, title: &str) -> Result<Window, String> {
    let created = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(1200.0, 760.0)
        // 놓인 파일은 창의 파일 놓기 뷰가 받는다(docs/spec/native-surfaces.md).
        .disable_drag_drop_handler()
        .background_color(Color(16, 17, 23, 255))
        // 창은 register 가 첫 화면 표시를 준비한 뒤에 보인다.
        .visible(false);
    let created = platform::current()?.prepare_window(created)?;
    let window = created
        .build()
        .map_err(|e| e.to_string())?
        .as_ref()
        .window();
    register(window.clone())?;
    crate::exposure::windows_changed(app);
    Ok(window)
}

/// 새 프로젝트 창을 연다.
pub(crate) fn window_new_on_main(app: AppHandle) -> Result<(), String> {
    let id = app
        .state::<Windows>()
        .next_window
        .fetch_add(1, Ordering::Relaxed);
    new_window(
        &app,
        &format!("project-window-{id}"),
        "index.html",
        WINDOW_TITLE,
    )?;
    Ok(())
}

/// AppKit event-loop thread를 막지 않고 그 thread에 생성을 예약한다.
pub(crate) fn window_new(app: AppHandle) -> Result<(), String> {
    let task = app.clone();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        if tx.send(window_new_on_main(task)).is_err() {
            eprintln!("window creation result arrived after its request ended");
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// 창을 등록부에 추가하고 창 이벤트를 처리한다. 창 버튼은 페이지가 준비될 때와 창 크기가 바뀔 때 배치한다.
pub(crate) fn register(window: Window) -> Result<(), String> {
    let context = Arc::new(WindowData::default());
    window
        .state::<Windows>()
        .windows
        .lock()
        .map_err(|e| e.to_string())?
        .insert(window.label().into(), context.clone());
    let platform = platform::current()?;
    let owner = native_owner(&window)?;
    let main = root_view(&window).ok_or("the main webview is gone")?;
    let main = crate::exposure::with_view(&main, move |view| platform.view_id(view))?;
    platform.set_main_webview(owner, main)?;
    // 창은 첫 화면이 표시된 뒤에 보인다(docs/spec/native-host.md#page-start). 창은 숨긴 채 만들어지고, 투명하게
    // 화면에 올라간 뒤 첫 화면이 표시되면 불투명해진다.
    platform.reveal_after_load(owner)?;
    window.show().map_err(|e| e.to_string())?;
    // 네이티브 뷰는 DOM 위에 놓였으므로 놓인 파일은 페이지가 그 점의 DOM 요소를 기준으로 처리한다.
    let dropped = window.clone();
    // 내용의 해석과 오류 보고는 페이지가 한다(core.drop).
    platform.file_drop(
        main,
        Box::new(move |json| {
            if let Err(error) = emit_window(&dropped, "files-dropped", json) {
                log_error("files-dropped", error);
            }
        }),
    )?;
    // host.window 를 감시하는 연결에 가림 상태 변경을 알린다. Tauri 는 이 변경을 창 이벤트로 보내지 않는다.
    let occluded = window.clone();
    platform.observe_occlusion(
        owner,
        Box::new(move || crate::exposure::window_changed(&occluded)),
    )?;
    // 제목줄은 페이지가 첫 행 높이로 요청할 때까지 처음 높이를 갖는다. 창이 보이기 전에 정한다.
    initial_titlebar(&window)?;
    let host = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } if context.ready.load(Ordering::Relaxed) => {
            api.prevent_close();
            if let Err(error) = emit_window(&host, "project-close-request", ()) {
                log_error("project-close-request", error);
            }
        }
        tauri::WindowEvent::CloseRequested { .. } => {
            // 막지 않은 닫기 요청이다. 창은 곧 runtime 에서 사라지므로 목록에서 뺀다.
            context.closing.store(true, Ordering::Relaxed);
            // While the application quits, the web process of the window is killed: AppKit keeps XPC services alive
            // longer than their client, so the WebContent process would outlive the application
            // (docs/spec/hosts.md#process-lifecycle).
            if host.state::<Windows>().quit.active() {
                if let Some(view) = root_view(&host) {
                    if let Err(error) = crate::exposure::with_view(&view, |native| {
                        platform::current()?.kill_web_content_process(native)
                    }) {
                        log_error("web content kill", error);
                    }
                }
            }
        }
        tauri::WindowEvent::Destroyed => {
            crate::exposure::window_closed(&host);
            let natives = context.clone();
            log_failure(
                "window close",
                platform.enqueue_ui(Box::new(move || {
                    log_failure("surface layout cancel", platform.cancel_layout(owner));
                    // 논리 표면은 메인 웹뷰를 보유하므로 닫지 않으면 메인 웹뷰와 그 웹 콘텐츠 프로세스가 남는다.
                    let surfaces = match natives.surface_hosts.lock() {
                        Ok(mut surfaces) => std::mem::take(&mut *surfaces),
                        Err(error) => {
                            log_error("window close", error);
                            return;
                        }
                    };
                    log_failure(
                        "window close",
                        crate::surfaces::close_window_surfaces(
                            surfaces,
                            &natives.documents,
                            &natives.images,
                            &mut |native| match native {
                                crate::surfaces::WindowNative::Document(handle) => {
                                    platform.close_document(handle)
                                }
                                crate::surfaces::WindowNative::Image(handle) => {
                                    platform.close_image(handle)
                                }
                                crate::surfaces::WindowNative::Surface(handle) => {
                                    platform.close_surface(handle)
                                }
                            },
                        ),
                    );
                })),
            );
            if let Ok(mut monitor) = context.watching.0.lock() {
                if let Some(monitor) = monitor.take() {
                    log_failure("surface input", platform.unwatch_input(monitor));
                }
            }
            if let Ok(mut shapes) = context.shapes.0.lock() {
                for (_, shape) in shapes.drain() {
                    log_failure("shape", platform.destroy_shape(shape));
                }
            }
            log_failure(
                "sidecar retain",
                host.state::<WindowSidecars>().retain(&host, &|_| false),
            );
            let registry = host.state::<Windows>();
            if let Ok(mut owners) = registry.owners.lock() {
                owners.retain(|_, label| label != host.label());
            }
            if let Ok(mut windows) = registry.windows.lock() {
                windows.remove(host.label());
                if windows.is_empty() && registry.quit.active() {
                    host.app_handle().exit(0);
                }
            };
            notify_workspace(host.app_handle());
            crate::exposure::windows_changed(host.app_handle());
        }
        tauri::WindowEvent::Resized(_) => {
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
pub(crate) fn project_open(
    window: &Window,
    request: OpenProject,
) -> Result<serde_json::Value, String> {
    let host = window.clone();
    crate::exposure::on_main(window, move || project_open_on_main(&host, request))
}

fn project_open_on_main(
    window: &Window,
    request: OpenProject,
) -> Result<serde_json::Value, String> {
    if request.id.is_empty()
        || !request
            .id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err("invalid project id".into());
    }
    let folder = project_folder(window.app_handle(), request.root)?;
    let registry = window.state::<Windows>();
    let _opening = registry.opening.lock().map_err(|e| e.to_string())?;
    let owner = registry
        .owners
        .lock()
        .map_err(|e| e.to_string())?
        .get(&request.id)
        .cloned();
    if let Some(label) = owner {
        let owner = window
            .get_window(&label)
            .ok_or("project window is closed")?;
        *window_data(&owner)?
            .root
            .lock()
            .map_err(|e| e.to_string())? = folder.root;
        owner
            .set_title(&format!("{} / Tauri v2", request.title))
            .map_err(|e| e.to_string())?;
        crate::exposure::windows_changed(window.app_handle());
        if label != window.label() {
            emit_window(&owner, "project-activate", &request.id).map_err(|e| e.to_string())?;
            owner.show().map_err(|e| e.to_string())?;
            owner.set_focus().map_err(|e| e.to_string())?;
        }
        return Ok(serde_json::json!({"local": label == window.label()}));
    }
    let occupied = registry
        .owners
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .any(|label| label == window.label());
    let owner = if request.separate && occupied {
        let label = format!("project-{}", request.id);
        new_window(
            window.app_handle(),
            &label,
            &format!("index.html?project={}", request.id),
            &request.title,
        )?
    } else {
        window.clone()
    };
    registry
        .owners
        .lock()
        .map_err(|e| e.to_string())?
        .insert(request.id, owner.label().into());
    *window_data(&owner)?
        .root
        .lock()
        .map_err(|e| e.to_string())? = folder.root;
    owner
        .set_title(&format!("{} / Tauri v2", request.title))
        .map_err(|e| e.to_string())?;
    crate::exposure::windows_changed(window.app_handle());
    if let Some(g) = request.geometry.filter(|g| g.width > 0.0 && g.height > 0.0) {
        owner
            .set_size(LogicalSize::new(g.width, g.height))
            .map_err(|e| e.to_string())?;
        owner
            .set_position(tauri::LogicalPosition::new(g.x, g.y))
            .map_err(|e| e.to_string())?;
    }
    notify_workspace(window.app_handle());
    Ok(serde_json::json!({"local": owner.label() == window.label()}))
}

/// 프로젝트 id 와 창의 연결을 해제한다. 프로젝트가 남지 않은 창은 라이브러리를 보이므로 프로젝트 root 와 제목을 비운다.
pub(crate) fn project_release(window: &Window, id: String) -> Result<(), String> {
    let registry = window.state::<Windows>();
    let mut owners = registry.owners.lock().map_err(|e| e.to_string())?;
    let released = owners.remove(&id);
    let empty = released
        .as_ref()
        .is_some_and(|label| !owners.values().any(|other| other == label));
    drop(owners);
    if let (Some(label), true) = (released, empty) {
        // 창이 이미 닫혔으면 비울 상태가 없다.
        if let Some(owner) = window.app_handle().get_window(&label) {
            window_data(&owner)?
                .root
                .lock()
                .map_err(|e| e.to_string())?
                .clear();
            owner.set_title(WINDOW_TITLE).map_err(|e| e.to_string())?;
            crate::exposure::windows_changed(window.app_handle());
        }
    }
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
    // 위치와 크기는 창 좌표로 저장한다. 물리 픽셀로 저장하면 배율이 2 인 화면에서 같은 수가 두 배
    // 떨어진 자리를 가리켜, 다시 열 때마다 창이 화면 밖으로 밀려난다.
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let at = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<i32>(scale);
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    Ok(Some(Geometry {
        x: at.x,
        y: at.y,
        width: size.width,
        height: size.height,
    }))
}

/// 메인 페이지가 시작했음을 기록한다. 시작 문서 요청이 답하기 전에 부른다. 창을 준비되지 않은 상태로 두고,
/// 이전 페이지에 보낸 요청을 끝내고, 이전 페이지의 표면 문서와 그림 영역과 모달을 정리한다.
pub(crate) fn page_started(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    data.ready.store(false, Ordering::Relaxed);
    crate::exposure::page_reloaded(window);
    reload_surface_documents(window)?;
    data.overlay.discard()
}

pub(crate) fn window_ready(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    data.ready.store(true, Ordering::Relaxed);
    crate::exposure::replay_registrations(window);
    crate::exposure::windows_changed(window.app_handle());
    for ready in data.readied.lock().map_err(|e| e.to_string())?.drain(..) {
        if ready.send(()).is_err() {
            eprintln!("window readiness arrived after its request ended");
        }
    }
    crate::exposure::rewatch(window);
    emit_window(window, "page-ready", ()).map_err(|e| e.to_string())
}

/// 창을 닫는다.
pub(crate) fn window_close(window: &Window) -> Result<(), String> {
    window_data(window)?.ready.store(false, Ordering::Relaxed);
    window.close().map_err(|e| e.to_string())
}

/// Records that the page kept a modified tab when the window was asked to close, which ends a quit that asked the
/// window (docs/spec/hosts.md#process-lifecycle).
pub(crate) fn window_close_kept(window: &Window) -> Result<(), String> {
    window_data(window)?;
    window.state::<Windows>().quit.cancel();
    Ok(())
}

/// 종료 요청을 처리한다. 준비된 창이 있으면 종료를 막고 각 창에 닫기 요청을 보낸다.
pub(crate) fn quit(app: &AppHandle, api: tauri::ExitRequestApi) {
    let registry = app.state::<Windows>();
    let waiting: Vec<_> = registry
        .windows
        .lock()
        .expect("window registry")
        .iter()
        .filter(|(_, context)| context.ready.load(Ordering::Relaxed))
        .map(|(label, _)| label.clone())
        .collect();
    if waiting.is_empty() {
        return;
    }
    api.prevent_exit();
    registry.quit.begin();
    for (label, window) in app.windows() {
        let result = if waiting.contains(&label) {
            emit_window(&window, "project-close-request", ())
        } else {
            window.close()
        };
        if let Err(error) = result {
            log_error("window quit", error);
        }
    }
}

/// 창을 만들 때 정하는 제목줄 높이(pt)다. 프레임 글자 배율 1 의 첫 행 높이와 같다
/// (packages/workbench/app.css 의 --chrome-h).
const INITIAL_TITLEBAR_HEIGHT: f64 = 40.0;

/// 창의 제목줄을 처음 높이로 만든다. AppKit 이 그 높이의 세로 가운데에 창 단추를 둔다.
///
/// AppKit 은 메인 스레드에서 뷰를 배치한다. 창 등록은 메인 스레드 밖에서도 실행되고, 메인 스레드에서 답을
/// 기다리면 그 자리에서 멈추므로 메인 스레드에 예약한다. 창을 만드는 즉시 예약하므로 페이지가 제목줄 높이를
/// 요청하기 전에 실행된다.
fn initial_titlebar(window: &Window) -> Result<(), String> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            // 주소는 그 주소를 쓰는 이 단계에서 읽는다. 그 전에 닫힌 창은 제목줄을 정할 것이 없다.
            let result = open_owner(&target).and_then(|owner| match owner {
                Some(handle) => {
                    platform::current()?.set_titlebar_height(handle, INITIAL_TITLEBAR_HEIGHT)
                }
                None => Ok(()),
            });
            if let Err(error) = result {
                log_error("window title bar", error);
            }
        })
        .map_err(|e| e.to_string())
}

/// 표면 준비가 담은 제목줄 높이(pt)를 검사한다. 첫 행은 40pt 에서 프레임 글자 배율 3 의 108pt 사이다.
/// AppKit 은 0 이하의 값을 사용자 지정 높이가 없다는 뜻으로 쓰므로 그 값도 이 범위 밖이다.
pub fn validate_titlebar_height(height: f64) -> Result<(), String> {
    if height.is_nan() || !(32.0..=200.0).contains(&height) {
        return Err("title bar height must be a finite number from 32 through 200 points".into());
    }
    Ok(())
}

/// 창의 제목줄을 height(pt)로 만들고 그 뒤의 창 단추 영역과 제목줄 높이를 반환한다. 표면 준비가 창의 배치
/// 트랜잭션 안에서 메인 스레드에서 호출하므로 새 높이는 그 트랜잭션의 커밋과 함께 화면에 나간다. 전체 화면인 창은
/// 높이를 바꾸지 않고 row 0 을 반환한다.
pub(crate) fn titlebar_chrome(handle: Handle, height: f64) -> Result<TitlebarChange, String> {
    let platform = platform::current()?;
    let previous = platform.titlebar_height(handle)?;
    platform.set_titlebar_height(handle, height)?;
    let (x, y, w, h) = platform.window_controls(handle)?;
    Ok(TitlebarChange {
        chrome: Chrome {
            controls: Rect { x, y, w, h },
            row: platform.titlebar_height(handle)?,
        },
        previous,
    })
}

/// 표면 준비가 정한 제목줄. chrome 은 정한 뒤의 창 값이고 previous 는 준비 전의 높이(pt)다. 전체 화면이면 0 이다.
pub(crate) struct TitlebarChange {
    pub(crate) chrome: Chrome,
    pub(crate) previous: f64,
}

/// 준비 전의 제목줄 높이로 되돌린다. 전체 화면에서 정한 것이 없으면(0) 되돌릴 것이 없다. 메인 스레드에서 호출한다.
pub(crate) fn restore_titlebar(handle: Handle, previous: f64) -> Result<(), String> {
    if previous <= 0.0 {
        return Ok(());
    }
    platform::current()?.set_titlebar_height(handle, previous)
}

/// 페이지의 첫 그리기가 보일 첫 행의 높이(pt). 공통 설정 textSize 의 round(max(40, 36 × textSize)) 이고, 설정이
/// 없으면 40 이다(docs/spec/native-surfaces.md#title-bar-height). textSize 는 공통 전용이므로 페이지는 같은 값으로 첫
/// 행을 그린다.
pub fn start_titlebar_height(common: &serde_json::Value) -> Result<f64, String> {
    let Some(value) = common.get("textSize") else {
        return Ok(INITIAL_TITLEBAR_HEIGHT);
    };
    let Some(factor) = value.as_f64() else {
        return Err(format!(
            "common setting textSize must be a number, not {}",
            crate::arguments::kind(value)
        ));
    };
    if !(0.5..=3.0).contains(&factor) {
        return Err("common setting textSize must be from 0.5 through 3".into());
    }
    Ok((36.0 * factor).max(INITIAL_TITLEBAR_HEIGHT).round())
}

/// 시작 문서에 답하기 전에 창의 제목줄을 공통 설정의 첫 행 높이로 정한다. 아직 보이지 않는 새 창은 바로 정하고, 이전
/// 페이지를 보이는 창은 새 ticket 의 시작 트랜잭션 안에서 정해 새 페이지의 첫 표시와 함께 커밋한다
/// (docs/spec/native-surfaces.md#title-bar-height). 전체 화면인 창은 높이를 바꾸지 않는다.
pub(crate) fn start_titlebar(window: &Window, common: &serde_json::Value) -> Result<(), String> {
    let height = start_titlebar_height(common)?;
    let handle = native_owner(window)?;
    let ticket = window_data(window)?
        .running
        .prepared
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    crate::exposure::on_main(window, move || {
        platform::current()?.start_page_titlebar(
            handle,
            ticket,
            height,
            Box::new(move |result| {
                if tx.send(result).is_err() {
                    eprintln!("the start title bar result arrived after its request ended");
                }
            }),
        )
    })?;
    rx.recv().map_err(|e| e.to_string())?
}

/// 페이지가 첫 줄을 그리는 데 쓰는 창의 값. controls 는 창 단추 영역이고 row 는 제목줄 높이(pt)다.
/// 전체 화면처럼 제목줄이 없으면 row 는 0 이다.
#[derive(Clone, Serialize)]
pub(crate) struct Chrome {
    controls: Rect,
    row: f64,
}

/// 창 단추 영역과 제목줄 높이를 반환한다.
pub(crate) fn window_chrome(window: &Window) -> Result<Chrome, String> {
    let controls = window_controls(window)?;
    let handle = native_owner(window)?;
    let row =
        crate::exposure::on_main(window, move || platform::current()?.titlebar_height(handle))?;
    Ok(Chrome { controls, row })
}

/// 창 버튼이 차지하는 영역을 페이지 좌표로 반환한다. 페이지는 첫 줄에서 그 영역을 비운다.
pub(crate) fn window_controls(window: &Window) -> Result<Rect, String> {
    let handle = native_owner(window)?;
    let (x, y, w, h) = platform::current()?.window_controls(handle)?;
    Ok(Rect { x, y, w, h })
}
