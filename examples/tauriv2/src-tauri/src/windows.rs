use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use tauri::{EventTarget, WebviewWindowBuilder};

#[derive(Default)]
pub(crate) struct WindowData {
    pub overlay: Overlay,
    pub shapes: Shapes,
    pub theme: CurrentTheme,
    pub views: Views,
    pub watching: Watching,
    pub resizing: Resizing,
    pub running: Running,
    pub shells: shell::Shells,
    pub root: Mutex<String>,
    pub ready: AtomicBool,
}

#[derive(Default)]
pub(crate) struct Windows {
    quitting: AtomicBool,
    opening: Mutex<()>,
    windows: Mutex<HashMap<String, Arc<WindowData>>>,
    owners: Mutex<HashMap<String, String>>,
}

pub(crate) fn window_data(window: &Window) -> Result<Arc<WindowData>, String> {
    window.state::<Windows>().windows.lock().map_err(|e| e.to_string())?
        .get(window.label()).cloned().ok_or_else(|| "project window is closed".into())
}

pub(crate) fn root_view(window: &Window) -> Option<Webview> { window.get_webview(window.label()) }

pub(crate) fn native_owner(window: &Window) -> Result<usize, String> {
    #[cfg(target_os = "macos")]
    return window.ns_window().map(|h| h as usize).map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    { let _ = window; Ok(0) }
}

pub(crate) fn emit_window<S: Serialize + Clone>(window: &Window, event: &str, payload: S) -> tauri::Result<()> {
    let labels: Vec<_> = window.webviews().iter().map(|v| v.label().to_string()).collect();
    window.emit_filter(event, payload, |target| match target {
        EventTarget::Webview { label } => labels.contains(label),
        EventTarget::App => window.label() == "main",
        _ => false,
    })
}

pub(crate) fn register(window: Window) -> Result<(), String> {
    let context = Arc::new(WindowData::default());
    window.state::<Windows>().windows.lock().map_err(|e| e.to_string())?
        .insert(window.label().into(), context.clone());
    place_window_controls(&window)?;
    let owner = native_owner(&window)?;
    let host = window.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } if context.ready.load(Ordering::Relaxed) => {
                api.prevent_close();
                if let Err(error) = emit_window(&host, "project-close-request", ()) { eprintln!("{error}"); }
            }
            tauri::WindowEvent::Destroyed => {
                native::cancel_surface_layout(owner);
                if let Ok(mut monitor) = context.watching.0.lock() {
                    if let Some(monitor) = monitor.take() { native::unwatch_mouse(monitor); }
                }
                if let Ok(mut shapes) = context.shapes.0.lock() {
                    for (_, shape) in shapes.drain() { native::shape_destroy(shape); }
                }
                let _ = context.shells.retain(&|_| false);
                let registry = host.state::<Windows>();
                if let Ok(mut owners) = registry.owners.lock() { owners.retain(|_, label| label != host.label()); }
                if let Ok(mut windows) = registry.windows.lock() {
                    windows.remove(host.label());
                    if windows.is_empty() && registry.quitting.load(Ordering::Relaxed) { host.app_handle().exit(0); }
                };
            }
            tauri::WindowEvent::Resized(_) => { let _ = place_window_controls(&host); }
            _ => {}
        }
    });
    Ok(())
}

#[derive(Serialize)]
pub(crate) struct Folder { root: String, identity: String }

pub(crate) fn folder(root: &str, home: &Path) -> Result<Folder, String> {
    if root.trim().is_empty() { return Err("project directory is empty".into()); }
    let path = if root == "~" { home.to_path_buf() }
        else if root.starts_with("~/") || root.starts_with("~\\") { home.join(&root[2..]) }
        else { PathBuf::from(root) };
    let path = path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))?;
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_dir() { return Err(format!("not a project directory: {}", path.display())); }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(windows)]
    let identity = {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use ::windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS}};
        let file = std::fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0).open(&path).map_err(|e| e.to_string())?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info).map_err(|e| e.to_string())?; }
        format!("{}:{}", info.dwVolumeSerialNumber, (info.nFileIndexHigh as u64) << 32 | info.nFileIndexLow as u64)
    };
    Ok(Folder { root: path.to_str().ok_or("project path is not UTF-8")?.into(), identity })
}

#[tauri::command(async)]
pub(crate) fn project_folder(app: AppHandle, root: String) -> Result<Folder, String> {
    folder(&root, &app.path().home_dir().map_err(|e| e.to_string())?)
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Geometry { x: i32, y: i32, width: f64, height: f64 }
#[derive(Deserialize)]
pub(crate) struct OpenProject { id: String, root: String, title: String, separate: bool, geometry: Option<Geometry> }

#[tauri::command(async)]
pub(crate) fn project_open(window: Window, request: OpenProject) -> Result<serde_json::Value, String> {
    if request.id.is_empty() || !request.id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
        return Err("invalid project id".into());
    }
    let folder = project_folder(window.app_handle().clone(), request.root)?;
    let registry = window.state::<Windows>();
    let _opening = registry.opening.lock().map_err(|e| e.to_string())?;
    let owner = registry.owners.lock().map_err(|e| e.to_string())?.get(&request.id).cloned();
    if let Some(label) = owner {
        let owner = window.get_window(&label).ok_or("project window is closed")?;
        *window_data(&owner)?.root.lock().map_err(|e| e.to_string())? = folder.root;
        owner.set_title(&format!("{} / Tauri v2", request.title)).map_err(|e| e.to_string())?;
        if label != window.label() {
            emit_window(&owner, "project-activate", &request.id).map_err(|e| e.to_string())?;
            owner.show().map_err(|e| e.to_string())?;
            owner.set_focus().map_err(|e| e.to_string())?;
        }
        return Ok(serde_json::json!({"local":label == window.label()}));
    }
    let occupied = registry.owners.lock().map_err(|e| e.to_string())?.values().any(|label| label == window.label());
    let owner = if request.separate && occupied {
        let label = format!("project-{}", request.id);
        let created = WebviewWindowBuilder::new(window.app_handle(), &label,
            WebviewUrl::App(format!("index.html?project={}", request.id).into()))
            .title(&request.title).inner_size(1200.0,760.0)
            .background_color(Color(16,17,23,255));
        #[cfg(target_os = "macos")]
        let created = created.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).accept_first_mouse(true);
        let created = created.build().map_err(|e| e.to_string())?.as_ref().window();
        register(created.clone())?;
        created
    } else { window.clone() };
    registry.owners.lock().map_err(|e| e.to_string())?.insert(request.id, owner.label().into());
    *window_data(&owner)?.root.lock().map_err(|e| e.to_string())? = folder.root;
    owner.set_title(&format!("{} / Tauri v2", request.title)).map_err(|e| e.to_string())?;
    if let Some(g) = request.geometry.filter(|g| g.width > 0.0 && g.height > 0.0) {
        owner.set_size(LogicalSize::new(g.width, g.height)).map_err(|e| e.to_string())?;
        owner.set_position(tauri::PhysicalPosition::new(g.x, g.y)).map_err(|e| e.to_string())?;
    }
    Ok(serde_json::json!({"local":owner.label() == window.label()}))
}

#[tauri::command]
pub(crate) fn project_release(window: Window, id: String) -> Result<(), String> {
    window.state::<Windows>().owners.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[tauri::command]
pub(crate) fn window_state(window: Window) -> Result<Option<Geometry>, String> {
    if window.is_maximized().map_err(|e| e.to_string())? || window.is_fullscreen().map_err(|e| e.to_string())? || window.is_minimized().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    let at = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    Ok(Some(Geometry { x:at.x, y:at.y, width:size.width, height:size.height }))
}

#[tauri::command]
pub(crate) fn window_ready(window: Window) -> Result<(), String> {
    window_data(&window)?.ready.store(true, Ordering::Relaxed);
    emit_window(&window, "page-ready", ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn window_close(window: Window) -> Result<(), String> {
    window_data(&window)?.ready.store(false, Ordering::Relaxed);
    window.close().map_err(|e| e.to_string())
}

pub(crate) fn quit(app: &AppHandle, api: tauri::ExitRequestApi) {
    let registry = app.state::<Windows>();
    let waiting: Vec<_> = registry.windows.lock().expect("window registry").iter()
        .filter(|(_, context)| context.ready.load(Ordering::Relaxed)).map(|(label,_)| label.clone()).collect();
    if waiting.is_empty() { return; }
    api.prevent_exit();
    registry.quitting.store(true, Ordering::Relaxed);
    for (label, window) in app.windows() {
        let result = if waiting.contains(&label) { emit_window(&window, "project-close-request", ()) }
            else { window.close() };
        if let Err(error) = result { eprintln!("{error}"); }
    }
}
