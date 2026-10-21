//! Project windows, the window registry, ready/close/exit, window state and window buttons.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, mpsc};

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

/// The state of one window.
#[derive(Default)]
pub(crate) struct WindowData {
    pub overlay: Overlay,
    pub shapes: Shapes,
    pub theme: CurrentTheme,
    pub views: Views,
    /// The handle of the logical SurfaceHost. It is a native host below the main WebView and not a DOM WebView.
    pub surface_hosts: Mutex<HashMap<String, Handle>>,
    pub watching: Watching,
    pub running: Running,
    pub root: Mutex<String>,
    pub ready: AtomicBool,
    /// The windows that received a close request that was not blocked. These windows disappear from the runtime before
    /// Destroyed, so they are not put in the list.
    pub closing: AtomicBool,
    /// The requests that wait for the next page to be ready.
    pub readied: Mutex<Vec<std::sync::mpsc::Sender<()>>>,
    /// The items (surface, kind, name) that surface pages registered. When the main page is reloaded, the new page is
    /// notified again.
    pub registrations: Mutex<Vec<(String, String, String)>>,
    /// The document regions of surface pages.
    pub documents: crate::documents::Documents,
    /// The stream subscriptions of the document regions.
    pub streams: crate::documents::Streams,
    /// The image regions of surface pages.
    pub images: crate::images::Images,
    /// The surface composition that the main page declared and that the host uses to check the authority of region
    /// calls.
    pub compositions: Mutex<HashMap<String, SurfaceComposition>>,
    /// The plugin of each surface that declared its composition; its document regions serve that plugin's package.
    pub surface_plugins: Mutex<HashMap<String, String>>,
    /// The complete composition revision applied last for each surface.
    pub composition_revisions: Mutex<HashMap<String, u64>>,
}

/// A reload of the app DOM replaces all plugin documents but does not end the terminal sessions.
///
/// The sidecars that a page reload reconnects for surface: the sidecars of its image regions and the running persistent
/// sidecars to which surface has sent, each running persistent sidecar given with the surfaces that have sent to it,
/// sorted and once each, without a sidecar that no plugin
/// declares, whose surface ended with the removal of its plugin and to which a send fails.
pub fn reconnect_targets(
    surface: &str,
    mut sidecars: Vec<String>,
    running_persistent: &[(String, Vec<String>)],
    declared: impl Fn(&str) -> bool,
) -> Vec<String> {
    // A send to a persistent sidecar from a surface that never sent to it would make that surface a sidecar session of
    // the sidecar.
    sidecars.extend(
        running_persistent
            .iter()
            .filter(|(_, surfaces)| surfaces.iter().any(|sent| sent == surface))
            .map(|(name, _)| name.clone()),
    );
    sidecars.retain(|name| declared(name));
    sidecars.sort();
    sidecars.dedup();
    sidecars
}

/// Tauri calls this from the main-webview `PageLoadEvent::Started` callback. The cleanup here is deliberately
/// synchronous: while the previous image handle waits for removal in the same AppKit run loop, the replacement page
/// must not attach a new native image.
pub(crate) fn reload_surface_documents(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    let owner = native_owner(window)?;
    let platform = platform::current()?;
    let window = window.clone();
    platform.cancel_layout(owner)?;
    let surfaces: Vec<_> = data
        .surface_hosts
        .lock()
        // default: a lock that a panicking thread poisoned still holds the surface registrations, which are only read;
        // the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .map(|(id, handle)| (id.clone(), *handle))
        .collect();
    let reconnect = RawValue::from_string(r#"{"operation":"reconnect"}"#.to_string())
        .map_err(|error| error.to_string())?;
    let running_persistent = window.state::<WindowSidecars>().running_persistent()?;
    for (surface, handle) in surfaces {
        let sidecars = reconnect_targets(
            &surface,
            data.images.sidecars_for_surface(&surface),
            &running_persistent,
            |name| window.state::<WindowSidecars>().declared(name),
        );
        platform.set_surface_hidden_handle(handle, true)?;
        data.images.begin_generation(&surface);
        crate::exposure::surface_closed(&window, &surface);
        for document in
            crate::documents::remove_surface_for_reload(&data.documents, &data.streams, &surface)
        {
            platform.close_document(document)?;
        }
        for image in data.images.remove_surface(&surface) {
            platform.close_image(image)?;
        }
        // A persistent sidecar can send a new raster as soon as it receives the reconnect. All previous native images
        // are removed first so that a new frame does not race with the termination of the previous IOSurface or reuse
        // its token.
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
        // default: a lock that a panicking thread poisoned still holds the composition revisions, which this call
        // clears; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .clear();
    crate::exposure::window_changed(&window);
    Ok(())
}

/// The window registry and the project-owned windows of the application.
#[derive(Default)]
pub(crate) struct Windows {
    pub(crate) quit: crate::quit::Quit,
    /// The command of the pending application update or relaunch, which the exit starts
    /// (docs/spec/installation.md#application-update, docs/spec/endpoint.md#diagnostic-builds).
    pub(crate) update: Mutex<Option<crate::app_update::PendingStart>>,
    removals: crate::project_removal::Removals,
    next_window: AtomicU64,
    opening: Mutex<()>,
    windows: Mutex<HashMap<String, Arc<WindowData>>>,
    owners: Mutex<HashMap<String, String>>,
}

/// Removes the window from the owner and window records, and returns whether no window is left while the application quits.
fn remove_window_records(registry: &Windows, label: &str) -> bool {
    let mut owners = registry
        .owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, and the record of the destroyed window is
        // removed from it; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    owners.retain(|_, owner| owner != label);
    drop(owners);
    let mut windows = registry
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window record, and the record of the destroyed window is
        // removed from it; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    windows.remove(label);
    windows.is_empty() && registry.quit.active()
}

/// Returns the state of the window.
pub(crate) fn window_data(window: &Window) -> Result<Arc<WindowData>, String> {
    window
        .state::<Windows>()
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window records, which are only read; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(window.label())
        .cloned()
        .ok_or_else(|| "project window is closed".into())
}

/// Returns the main webview of the window.
pub(crate) fn root_view(window: &Window) -> Option<Webview> {
    window.get_webview(window.label())
}

/// Returns the native address of the window.
pub(crate) fn native_owner(window: &Window) -> Result<Handle, String> {
    platform::current()?.window_handle(window)
}

/// The failure of an operation that writes the native address of a window.
#[derive(Debug, PartialEq)]
pub enum NativeFailure {
    /// The window closed before the main-thread step of the operation. The native code did not receive the window.
    Closed,
    /// The address could not be read or the native code failed.
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

/// The work to run in one step of the main thread.
pub type MainStep = Box<dyn FnOnce() + Send>;

/// Reads the native address of the window with owner and runs work with that address. The read and the run are in one
/// main-thread step that on_main runs. The close of a window is handled by the main thread, and in that handling the
/// runtime closes and releases the NSWindow, so if the step were split, a close between the parts would pass the
/// address of a closed window to the native code. A window that closed before the step has owner None, does not run
/// work and returns Closed.
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
            // A failure after the request ended was not reported by that request, so it is left as an error line.
            Err(mpsc::SendError(Err(error))) => log_error("native window work", error),
            Err(mpsc::SendError(Ok(_))) => crate::application_log::log_info(
                "window",
                "native window result arrived after its request ended",
            ),
        }
    }))
    .map_err(NativeFailure::Failed)?;
    rx.recv()
        .map_err(|e| NativeFailure::Failed(e.to_string()))?
}

/// The native address of a window that is registered and whose close was not accepted. It is None for a window that is
/// closing or a window whose registration Destroyed deleted. Call it on the main thread. If the close request is not
/// blocked, the runtime sets closing in the same main-thread handling and then closes the window, so a window that is
/// not closing on the main thread is open.
fn open_owner(window: &Window) -> Result<Option<Handle>, String> {
    let open = window
        .state::<Windows>()
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window records, which are only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(window.label())
        .is_some_and(|data| !data.closing.load(Ordering::Relaxed));
    if !open {
        return Ok(None);
    }
    native_owner(window).map(Some)
}

/// Reads the native address of the window in one step of the main thread and runs work with that address. A window that
/// closed before that step does not run work and is Closed.
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

/// Cancels the open surface placement transaction of the window. The transaction of a closed window is canceled by
/// Destroyed of that window, so there is nothing to cancel.
pub(crate) fn cancel_window_layout(window: &Window) -> Result<(), String> {
    let platform = platform::current()?;
    match with_native_owner(window, move |owner| platform.cancel_layout(owner)) {
        Ok(()) | Err(NativeFailure::Closed) => Ok(()),
        Err(NativeFailure::Failed(error)) => Err(error),
    }
}

/// Sends an event to the webview of the window. For the main window, it is also sent to the application receiver.
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

/// Sends workspace-changed to all windows.
pub(crate) fn notify_workspace(app: &AppHandle) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "workspace-changed", ()) {
            log_error("workspace-changed", error);
        }
    }
}

/// Sends the host event `debug-log-changed` to every window and the value of the host status `host.log` to its watchers: the notice
/// of a change of the event log (docs/spec/debug.md#following).
pub(crate) fn notify_log_notice(app: &AppHandle, notice: &crate::debug_follow::LogNotice) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "debug-log-changed", notice.clone()) {
            log_error("debug-log-changed", error);
        }
    }
    crate::exposure::log_notice_changed(app, notice);
}

/// Sends the host event to every window; every document of a window receives it.
pub(crate) fn notify_windows(app: &AppHandle, name: &str, payload: serde_json::Value) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, name, payload.clone()) {
            log_error(name, error);
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

/// Sends plugins-changed to all windows.
pub(crate) fn notify_plugins(app: &AppHandle, change: crate::plugins::Changed) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "plugins-changed", change.clone()) {
            log_error("plugins-changed", error);
        }
    }
}

/// Returns the window with the label label among the registered windows.
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

/// Returns the identifier, the title, the owning project ids and the key window state of the registered windows in the
/// order of window identifiers.
pub(crate) fn list(app: &AppHandle) -> Result<serde_json::Value, String> {
    // The identifiers and the state are read at once. If they were read separately, Destroyed could delete the
    // registration in between.
    let mut registered: Vec<(String, Arc<WindowData>)> = app
        .state::<Windows>()
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window records, which are only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
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
            let root = data
                .root
                .lock()
                // default: a lock that a panicking thread poisoned still holds the root webview of the window, which is
                // only read; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
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

/// One main-thread step of the host.windows list.
pub type ListStep = Box<dyn FnOnce() -> Result<Vec<serde_json::Value>, String> + Send>;

/// Creates the list entry with entry for each window. The entries of all windows are created in one main-thread step
/// that on_main runs. The close of a window is handled by the main thread, so within one step the window does not leave
/// the runtime between reading closing and the lookup. A window lookup made on the main thread is handled at once
/// without waiting (send_user_message of tauri-runtime-wry).
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

/// One window of host.windows. A window whose close was accepted is not looked up and is None, because that window
/// disappears from the runtime before Destroyed and the lookup of its title and focus fails. The lookup failure of
/// another window is returned as an error.
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

/// Returns the list of project ids opened in the window.
pub(crate) fn opened(app: &AppHandle) -> Result<Vec<String>, String> {
    Ok(app
        .state::<Windows>()
        .owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .keys()
        .cloned()
        .collect())
}

/// The title of a window that has no project open. tauri.conf.json declares the title of the first window with the same
/// value.
const WINDOW_TITLE: &str = "soksak / Tauri v2";

fn new_window(app: &AppHandle, label: &str, url: &str, title: &str) -> Result<Window, String> {
    let created = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(1200.0, 760.0)
        // A dropped file is received by the file drop view of the window (docs/spec/native-surfaces.md).
        .disable_drag_drop_handler()
        .background_color(Color(16, 17, 23, 255))
        // The window is shown after register has prepared the presentation of the first screen.
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

/// Opens a new project window.
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

/// Schedules the creation on the AppKit event-loop thread without blocking that thread.
pub(crate) fn window_new(app: AppHandle) -> Result<(), String> {
    let task = app.clone();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        if tx.send(window_new_on_main(task)).is_err() {
            crate::application_log::log_info(
                "window",
                "window creation result arrived after its request ended",
            );
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// Adds the window to the registry and handles the window events. The window buttons are placed when the page is ready
/// and when the window size changes.
pub(crate) fn register(window: Window) -> Result<(), String> {
    let context = Arc::new(WindowData::default());
    window
        .state::<Windows>()
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window records, which this call fills; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .insert(window.label().into(), context.clone());
    let reading = window.clone();
    crate::performance::window_add(
        window.label(),
        std::sync::Arc::new(move || crate::exposure::window_processes(&reading)),
    );
    let platform = platform::current()?;
    let owner = native_owner(&window)?;
    let main = root_view(&window).ok_or("the main webview is gone")?;
    let main = crate::exposure::with_view(&main, move |view| platform.view_id(view))?;
    platform.set_main_webview(owner, main)?;
    // The window is shown after the first screen is presented (docs/spec/native-host.md#page-start). The window is
    // created hidden, put on the screen transparent, and becomes opaque when the first screen is presented.
    platform.reveal_after_load(owner)?;
    window.show().map_err(|e| e.to_string())?;
    // The native view lies over the DOM, so the page handles a dropped file relative to the DOM element at that point.
    let dropped = window.clone();
    // The page interprets the content and reports errors (core.drop).
    platform.file_drop(
        main,
        Box::new(move |json| {
            if let Err(error) = emit_window(&dropped, "files-dropped", json) {
                log_error("files-dropped", error);
            }
        }),
    )?;
    // Notifies the connections that watch host.window of the change of the occlusion state. Tauri does not send this
    // change as a window event.
    let occluded = window.clone();
    platform.observe_occlusion(
        owner,
        Box::new(move || {
            crate::window_events::record_window_event(occluded.label(), "occlusion_changed");
            crate::exposure::window_changed(&occluded)
        }),
    )?;
    // The title bar has its initial height until the page requests the height of the first row. It is set before the
    // window is shown.
    initial_titlebar(&window)?;
    let host = window.clone();
    let window_events_label = window.label().to_string();
    let recorded = context.clone();
    window.on_window_event(move |event| {
        let kind = match event {
            tauri::WindowEvent::CloseRequested { .. } if recorded.ready.load(Ordering::Relaxed) => {
                Some("close_requested")
            }
            tauri::WindowEvent::CloseRequested { .. } => Some("closed"),
            tauri::WindowEvent::Resized(_) => Some("resize"),
            tauri::WindowEvent::Moved(_) => Some("move"),
            tauri::WindowEvent::ScaleFactorChanged { .. } => Some("scale_factor_changed"),
            tauri::WindowEvent::Focused(true) => Some("focus"),
            tauri::WindowEvent::Focused(false) => Some("lost_focus"),
            _ => None,
        };
        if let Some(kind) = kind {
            crate::window_events::record_window_event(window_events_label.as_str(), kind);
        }
    });
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } if context.ready.load(Ordering::Relaxed) => {
            api.prevent_close();
            if let Err(error) = emit_window(&host, "project-close-request", ()) {
                log_error("project-close-request", error);
            }
        }
        tauri::WindowEvent::CloseRequested { .. } => {
            // This is a close request that was not blocked. The window will soon disappear from the runtime, so it is
            // removed from the list.
            context.closing.store(true, Ordering::Relaxed);
            // While the application quits, the web process of the window is killed: AppKit keeps XPC services alive
            // longer than their client, so the WebContent process would outlive the application
            // (docs/spec/hosts.md#process-lifecycle).
            // The termination takes the handle of the main webview and runs outside `with_webview`
            // (docs/spec/hosts.md#process-lifecycle).
            if host.state::<Windows>().quit.active()
                && let Err(error) = platform.kill_web_content_process(main)
            {
                log_error("web content kill", error);
            }
        }
        tauri::WindowEvent::Destroyed => {
            // A window that ends keeps no tab, so a removal that asked it is allowed.
            host.state::<Windows>().removals.abandon(host.label());
            crate::exposure::window_closed(&host);
            let natives = context.clone();
            log_failure(
                "window close",
                platform.enqueue_ui(Box::new(move || {
                    log_failure("surface layout cancel", platform.cancel_layout(owner));
                    // A logical surface holds the main webview, so if it is not closed, the main webview and its web
                    // content process remain.
                    let surfaces = std::mem::take(
                        &mut *natives
                            .surface_hosts
                            .lock()
                            // default: a lock that a panicking thread poisoned still holds the surface registrations,
                            // which the close of the window takes and closes; the panic hook records the panic.
                            .unwrap_or_else(PoisonError::into_inner),
                    );
                    log_failure(
                        "window close",
                        crate::surfaces::close_window_surfaces(
                            surfaces,
                            &natives.documents,
                            &natives.streams,
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
            let monitor = context
                .watching
                .0
                .lock()
                // default: a lock that a panicking thread poisoned still holds the input monitor, which is taken and removed; the panic
                // hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let Some(monitor) = monitor {
                log_failure("surface input", platform.unwatch_input(monitor));
            }
            let mut shapes = context
                .shapes
                .0
                .lock()
                // default: a lock that a panicking thread poisoned still holds the shapes of the window, which are all destroyed; the
                // panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            for (_, shape) in shapes.drain() {
                log_failure("shape", platform.destroy_shape(shape));
            }
            log_failure(
                "sidecar retain",
                host.state::<WindowSidecars>().retain(&host, &|_| false),
            );
            let registry = host.state::<Windows>();
            crate::performance::window_remove(host.label());
            if remove_window_records(&registry, host.label()) {
                host.app_handle().exit(0);
            }
            notify_workspace(host.app_handle());
            crate::exposure::windows_changed(host.app_handle());
        }
        tauri::WindowEvent::Resized(_) => {
            crate::exposure::window_changed(&host);
        }
        tauri::WindowEvent::Focused(focused) => {
            if *focused && let Err(error) = emit_window(&host, "window-active", ()) {
                log_error("window-active", error);
            }
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

/// The window position and size. The position is in physical pixels and the size is in logical pixels.
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

/// Opens a project. An already open project activates its owning window, and a separate request creates a new window
/// when the requesting window owns another project.
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
    let _opening = registry
        .opening
        .lock()
        // default: a lock that a panicking thread poisoned still holds the open flag of the project open, which this call
        // holds again; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    let owner = registry
        .owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(&request.id)
        .cloned();
    if let Some(label) = owner {
        let owner = window
            .get_window(&label)
            .ok_or("project window is closed")?;
        *window_data(&owner)?
            .root
            .lock()
            // default: a lock that a panicking thread poisoned still holds the root webview of the window, which this call
            // replaces; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner) = folder.root;
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
        // default: a lock that a panicking thread poisoned still holds the owner record, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
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
        // default: a lock that a panicking thread poisoned still holds the owner record, which this call fills; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .insert(request.id, owner.label().into());
    *window_data(&owner)?
        .root
        .lock()
        // default: a lock that a panicking thread poisoned still holds the root webview of the window, which this call
        // replaces; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner) = folder.root;
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

/// Releases the link between a project id and a window. A window with no remaining project shows the library, so the
/// project root and the title are cleared.
pub(crate) fn project_release(window: &Window, id: String) -> Result<(), String> {
    let registry = window.state::<Windows>();
    let (released, empty) = release_owner(&registry.owners, &id);
    if let (Some(label), true) = (released, empty) {
        // When the window is already closed, there is no state to clear.
        if let Some(owner) = window.app_handle().get_window(&label) {
            window_data(&owner)?
                .root
                .lock()
                // default: a lock that a panicking thread poisoned still holds the root webview of the window, which
                // this call clears; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .clear();
            owner.set_title(WINDOW_TITLE).map_err(|e| e.to_string())?;
            crate::exposure::windows_changed(window.app_handle());
        }
    }
    notify_workspace(window.app_handle());
    Ok(())
}

/// Removes the link of the project id from the owner record, and returns the released window label and whether no other
/// project shows that window.
fn release_owner(owners: &Mutex<HashMap<String, String>>, id: &str) -> (Option<String>, bool) {
    let mut owners = owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, which this call amends; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    let released = owners.remove(id);
    let empty = released
        .as_ref()
        .is_some_and(|label| !owners.values().any(|other| other == label));
    (released, empty)
}

/// Asks the window that shows the project whether the project may be removed and returns its answer; returns true at
/// once when no other window shows the project (docs/spec/projects.md).
pub(crate) fn project_remove_ask(window: &Window, id: &str) -> Result<bool, String> {
    let registry = window.state::<Windows>();
    let owner = registry
        .owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(id)
        .cloned();
    let Some(label) = owner.filter(|label| label != window.label()) else {
        return Ok(true);
    };
    let asked = registry.removals.begin(id, &label)?;
    let target = window
        .get_window(&label)
        .ok_or("project window is closed")?;
    if let Err(error) = emit_window(&target, "project-remove-request", id) {
        registry.removals.abandon(&label);
        return Err(error.to_string());
    }
    asked.recv().map_err(|e| e.to_string())
}

/// Answers the removal request that `project_remove_ask` sent to this window.
pub(crate) fn project_remove_answer(
    window: &Window,
    id: &str,
    allowed: bool,
) -> Result<(), String> {
    window.state::<Windows>().removals.answer(id, allowed)
}

/// Returns the position and size of a window in the normal state. It is None for a maximized, full screen or minimized
/// window.
pub(crate) fn window_state(window: &Window) -> Result<Option<Geometry>, String> {
    if window.is_maximized().map_err(|e| e.to_string())?
        || window.is_fullscreen().map_err(|e| e.to_string())?
        || window.is_minimized().map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    // The position and size are stored in window coordinates. If they were stored in physical pixels, the same number
    // would point twice as far on a screen with scale 2, and the window would be pushed off the screen at every
    // reopening.
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

/// Records that the main page started. Call it before the start document request answers. It leaves the window not
/// ready, ends the requests sent to the previous page, and cleans up the surface documents, the image regions and the
/// modals of the previous page.
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
    for ready in data
        .readied
        .lock()
        // default: a lock that a panicking thread poisoned still holds the readiness senders, which the readiness drains;
        // the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .drain(..)
    {
        if ready.send(()).is_err() {
            crate::application_log::log_info(
                "window",
                "window readiness arrived after its request ended",
            );
        }
    }
    crate::exposure::rewatch(window);
    crate::deep_link::ready(window.app_handle());
    emit_window(window, "page-ready", ()).map_err(|e| e.to_string())
}

/// Closes a window.
pub(crate) fn window_close(window: &Window) -> Result<(), String> {
    window_data(window)?.ready.store(false, Ordering::Relaxed);
    window.close().map_err(|e| e.to_string())
}

/// Records that the page kept a modified tab when the window was asked to close, which ends a quit that asked the
/// window (docs/spec/hosts.md#process-lifecycle).
pub(crate) fn window_close_kept(window: &Window) -> Result<(), String> {
    window_data(window)?;
    window.state::<Windows>().quit.cancel();
    *window
        .state::<Windows>()
        .update
        .lock()
        // default: a lock that a panicking thread poisoned still holds the pending update, which the cancellation
        // clears; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner) = None;
    // A request of the operating system waits for its answer; the application does not quit, so the answer is the
    // cancellation.
    window
        .run_on_main_thread(|| match platform::current() {
            Ok(platform) => platform.cancel_quit_requests(),
            Err(error) => log_error("quit request cancel", error),
        })
        .map_err(|e| e.to_string())
}

/// Handles a termination request. When a ready window exists, it blocks the termination and sends a close request to
/// each window.
pub(crate) fn quit(app: &AppHandle, api: tauri::ExitRequestApi) {
    let registry = app.state::<Windows>();
    let waiting: Vec<_> = registry
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window registry, which is only read; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
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

/// The title bar height (pt) that is set when a window is created. It equals the height of the first row at frame text
/// scale 1 (--chrome-h of packages/workbench/app.css).
const INITIAL_TITLEBAR_HEIGHT: f64 = 40.0;

/// Creates the title bar of the window with its initial height. AppKit places the window buttons at the vertical center
/// of that height.
///
/// AppKit places views on the main thread. The window registration also runs outside the main thread, and waiting for
/// an answer on the main thread would stop there, so this is scheduled on the main thread. It is scheduled as soon as
/// the window is created, so it runs before the page requests the title bar height.
fn initial_titlebar(window: &Window) -> Result<(), String> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            // The address is read in this step, which uses the address. A window that closed before has no title bar to
            // set.
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

/// Checks the title bar height (pt) that a surface preparation holds. The first row is between 40 pt and 108 pt, which
/// is frame text scale 3. AppKit uses a value of 0 or less to mean that there is no custom height, so such a value is
/// also outside this range.
pub fn validate_titlebar_height(height: f64) -> Result<(), String> {
    if height.is_nan() || !(32.0..=200.0).contains(&height) {
        return Err("title bar height must be a finite number from 32 through 200 points".into());
    }
    Ok(())
}

/// Creates the title bar of the window with height (pt) and returns the window button area and the title bar height
/// after it. A surface preparation calls it on the main thread inside the placement transaction of the window, so the
/// new height reaches the screen together with the commit of that transaction. A window in full screen does not change
/// the height and returns row 0.
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

/// The title bar that a surface preparation set. chrome is the window value after it was set and previous is the height
/// (pt) before the preparation. It is 0 for full screen.
pub(crate) struct TitlebarChange {
    pub(crate) chrome: Chrome,
    pub(crate) previous: f64,
}

/// Restores the title bar height before the preparation. When nothing was set in full screen (0), there is nothing to
/// restore. Call it on the main thread.
pub(crate) fn restore_titlebar(handle: Handle, previous: f64) -> Result<(), String> {
    if previous <= 0.0 {
        return Ok(());
    }
    platform::current()?.set_titlebar_height(handle, previous)
}

/// The height (pt) of the first row that the first draw of the page will show. It is round(max(40, 36 × textSize)) of
/// the common setting textSize, and 40 when the setting is absent (docs/spec/native-surfaces.md#title-bar-height).
/// textSize is common only, so the page draws the first row with the same value.
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

/// Before it answers the start document, sets the title bar of the window to the first row height of the common
/// setting. A new window that is not visible yet is set at once, and a window that shows the previous page is set
/// inside the start transaction of a new ticket and committed together with the first presentation of the new page
/// (docs/spec/native-surfaces.md#title-bar-height). A window in full screen does not change the height.
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
                    crate::application_log::log_info(
                        "window",
                        "the start title bar result arrived after its request ended",
                    );
                }
            }),
        )
    })?;
    rx.recv().map_err(|e| e.to_string())?
}

/// The values of the window that the page uses to draw the first line. controls is the window button area and row is
/// the title bar height (pt). row is 0 when there is no title bar, as in full screen.
#[derive(Clone, Serialize)]
pub(crate) struct Chrome {
    controls: Rect,
    row: f64,
}

/// Returns the window button area and the title bar height.
pub(crate) fn window_chrome(window: &Window) -> Result<Chrome, String> {
    let controls = window_controls(window)?;
    let handle = native_owner(window)?;
    let row =
        crate::exposure::on_main(window, move || platform::current()?.titlebar_height(handle))?;
    Ok(Chrome { controls, row })
}

/// Returns the area that the window buttons occupy in page coordinates. The page leaves that area empty in its first
/// line.
pub(crate) fn window_controls(window: &Window) -> Result<Rect, String> {
    let handle = native_owner(window)?;
    let (x, y, w, h) = platform::current()?.window_controls(handle)?;
    Ok(Rect { x, y, w, h })
}

#[cfg(test)]
#[path = "windows_records_test.rs"]
mod records_test;
