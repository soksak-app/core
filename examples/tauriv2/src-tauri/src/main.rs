// Runs the soksak example as a real Tauri v2 application, with real native
// surfaces for the browser panes.
//
// The frontend is built by examples/sync-frontend.sh from the repository
// example and is loaded from disk as frontendDist, so no bundler is involved.
//
// On every commit the example declares the frame each surface should occupy.
// sync_surfaces makes the window's child webviews match those frames: it
// creates a webview for a frame it has not seen, moves and resizes the ones it
// has, and closes the ones that are gone. Child webviews need the `unstable`
// feature of the tauri crate.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native;
mod shell;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::Mutex;

use serde::Deserialize;
use serde::Serialize;
use tauri::{
    webview::Color, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewBuilder, WebviewUrl, Window,
};

/// One surface the page wants on screen, in CSS pixels relative to the page
/// viewport.
#[derive(Debug, Deserialize)]
struct Surface {
    id: String,
    /// The colour the view starts on. A webview leaves unpainted area white, and
    /// a divider drag resizes a surface every frame, so the strip it uncovered
    /// would flash white until its page paints it.
    background: [u8; 3],
    kind: String,
    /// What the surface shows.
    url: String,
    /// Whether that address is outside this app. An address of this app's own is
    /// a path into its frontend; naming the kind here would mean editing this
    /// file for every plugin the page adds.
    external: bool,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
    /// Whether this surface is asked to stand back, which the page decides.
    dim: bool,
}

/// The page viewport in CSS pixels, used to convert page coordinates into the
/// coordinates a child webview is placed in.
#[derive(Debug, Deserialize)]
struct Viewport {
    w: f64,
    h: f64,
}

#[derive(Debug, Deserialize)]
struct SyncRequest {
    viewport: Viewport,
    surfaces: Vec<Surface>,
}

/// The page's theme, carried to the pages the host creates.
///
/// A surface and a modal are documents of their own and inherit none of the
/// main page's stylesheet, so the values travel and each page sets them on its
/// own root.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Theme {
    scheme: String,
    tokens: std::collections::HashMap<String, String>,
}

fn label_for(id: &str) -> String {
    format!("surface-{id}")
}

/// Places the window's child webviews on the frames the page declared.
///
/// A child webview is positioned inside the window's content view, and on macOS
/// that content view is taller than the page viewport by the height of the title
/// bar. Subtracting the two gives the inset without hard-coding a platform
/// constant, and without it every surface sits one title bar too high.
/// A child webview is positioned inside the window's content view, and on macOS
/// that view is taller than the page viewport by the height of the title bar.
/// Subtracting the two gives the inset without a platform constant; without it
/// everything sits one title bar too high.
fn inset(window: &Window, viewport: &Viewport) -> Result<(f64, f64), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let content = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    Ok((
        (content.width - viewport.w).max(0.0),
        (content.height - viewport.h).max(0.0),
    ))
}

/// Starts watching the window for presses, once.
///
/// A press on a surface is delivered to that surface's view and never to the
/// page, so the window is monitored instead and the surface id is sent to the
/// page. Only macOS is implemented; native.rs names the other platforms.
#[allow(unused_variables)]
fn watch_presses(
    window: &Window,
    views: &State<'_, Views>,
    watching: &State<'_, Watching>,
) -> Result<(), String> {
    let mut started = watching.0.lock().map_err(|e| e.to_string())?;
    if *started {
        return Ok(());
    }
    *started = true;

    #[cfg(target_os = "macos")]
    {
        let named = views.0.clone();
        let host = window.clone();
        let handle = window.ns_window().map_err(|e| e.to_string())?;
        native::watch_mouse(handle, move |chain| {
            let Ok(map) = named.lock() else { return };
            let Some(id) = chain.iter().find_map(|view| map.get(view)) else {
                return;
            };
            let _ = host.emit("surface-pressed", id.clone());
        });
    }
    Ok(())
}

#[tauri::command]
fn sync_surfaces(
    window: Window,
    shells: State<'_, shell::Shells>,
    views: State<'_, Views>,
    watching: State<'_, Watching>,
    request: SyncRequest,
) -> Result<Vec<String>, String> {
    watch_presses(&window, &views, &watching)?;
    let (inset_x, inset_y) = inset(&window, &request.viewport)?;

    let mut wanted: HashSet<String> = HashSet::new();
    let mut created = Vec::new();

    for s in &request.surfaces {
        let label = label_for(&s.id);
        wanted.insert(label.clone());

        // A zero-sized webview is not something anyone can see, and some
        // platforms reject it, so treat it as hidden.
        let visible = s.visible && s.w >= 1.0 && s.h >= 1.0;
        let position = LogicalPosition::new(s.x + inset_x, s.y + inset_y);
        let size = LogicalSize::new(s.w.max(1.0), s.h.max(1.0));
        let solid = if s.dim { 0.45 } else { 1.0 };

        if let Some(webview) = window.get_webview(&label) {
            webview.set_position(position).map_err(|e| e.to_string())?;
            webview.set_size(size).map_err(|e| e.to_string())?;
            if visible {
                webview.show().map_err(|e| e.to_string())?;
            } else {
                webview.hide().map_err(|e| e.to_string())?;
            }
            webview
                .with_webview(move |platform| native::alpha(&platform, solid))
                .map_err(|e| e.to_string())?;
            continue;
        }

        let target = if s.external {
            WebviewUrl::External(s.url.parse().map_err(|_| format!("bad url: {}", s.url))?)
        } else {
            WebviewUrl::App(s.url.clone().into())
        };
        let [r, g, b] = s.background;
        let builder = WebviewBuilder::new(&label, target).background_color(Color(r, g, b, 255));
        window
            .add_child(builder, position, size)
            .map_err(|e| e.to_string())?;
        if let Some(webview) = window.get_webview(&label) {
            let named = views.0.clone();
            let id = s.id.clone();
            webview
                .with_webview(move |platform| {
                    native::alpha(&platform, solid);
                    if let Ok(mut map) = named.lock() {
                        map.insert(native::view_id(&platform), id);
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        created.push(label.clone());
    }

    // The page is the only writer of this list, so a surface missing from it is
    // a surface that is gone.
    for webview in window.webviews() {
        let label = webview.label().to_string();
        if label.starts_with("surface-") && !wanted.contains(&label) {
            webview.close().map_err(|e| e.to_string())?;
        }
    }
    // A shell whose surface is gone has nothing left to write to.
    let alive: Vec<String> = request.surfaces.iter().map(|s| s.id.clone()).collect();
    shells.retain(&|id: &str| alive.iter().any(|s| s == id))?;

    Ok(created)
}

/// What a [data-native-modal] element needs in order to be drawn elsewhere.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayRequest {
    viewport: Viewport,
    /// The element's id, which names the view that draws it.
    id: String,
    rect: Rect,
    class_name: String,
    html: String,
    css: String,
    /// The element's border, already laid over its background, so it reads the
    /// same however light or dark the surface underneath happens to be.
    border: String,
    /// The element's own corner radius, applied to the view that draws it.
    radius: f64,
    /// The element's background. Given to the view at birth so that it is never
    /// the white a webview shows before its document has painted.
    background: [u8; 3],
}

#[derive(Debug, Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// What the overlay webview asks for once it has loaded.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayContent {
    css: String,
    class_name: String,
    html: String,
    border: String,
}

/// What one modal needs to be drawn, kept under the element's id: a page may
/// declare several modals, and each view must get its own, not the last one set.
#[derive(Debug, Clone, Default)]
struct Modal {
    content: OverlayContent,
    radius: f64,
}

#[derive(Default)]
struct Overlay {
    modals: Mutex<HashMap<String, Modal>>,
}

/// The theme last declared by the page.
#[derive(Default)]
struct CurrentTheme(Mutex<Theme>);

/// The view each surface draws in, so a press can be matched to one.
#[derive(Default)]
struct Views(Arc<Mutex<HashMap<usize, String>>>);

/// Whether the window is already watched for presses.
#[derive(Default)]
struct Watching(Mutex<bool>);

/// One view per modal element, named after it, so a page may have several.
fn modal_label(id: &str) -> String {
    format!("modal-{id}")
}

/// Builds one view per modal the page declares, before any of them is asked for.
///
/// A webview shows white until its document has been fetched and painted, and no
/// colour given to it covers that: on macOS the colour lands on
/// `underPageBackgroundColor`, which is the area outside the document, and
/// stopping the webview from painting its own background needs a private
/// interface. So the view is not built at the moment it is wanted. Built here,
/// every showing is of a view whose document is already drawn.
/// Draws one modal element in a webview of its own.
///
/// The view is built here and closed when the modal closes. A view added after
/// the surface views sits above them, which is what puts the modal on top, so
/// building it at the moment it is wanted needs no reordering afterwards.
///
/// A webview shows white until its document is fetched and painted. The page
/// asks for overlay.html once at startup so that this fetch is a cache hit and
/// there is nothing to wait for.
#[tauri::command]
fn overlay_show(
    window: Window,
    state: State<'_, Overlay>,
    request: OverlayRequest,
) -> Result<(), String> {
    let label = modal_label(&request.id);
    let content = OverlayContent {
        css: request.css,
        class_name: request.class_name,
        html: request.html,
        border: request.border,
    };
    state.modals.lock().map_err(|e| e.to_string())?.insert(
        request.id.clone(),
        Modal { content, radius: request.radius },
    );

    let (inset_x, inset_y) = inset(&window, &request.viewport)?;
    if let Some(existing) = window.get_webview(&label) {
        existing.close().map_err(|e| e.to_string())?;
    }
    // The id is passed in the url so the page can identify itself when it calls
    // back.
    // The page reads which framework holds it from the address it was opened at.
    let url = format!("overlay.html?id={}&framework=tauriv2", request.id);
    let [r, g, b] = request.background;
    window
        .add_child(
            WebviewBuilder::new(&label, WebviewUrl::App(url.into()))
                .background_color(Color(r, g, b, 255)),
            LogicalPosition::new(request.rect.x + inset_x, request.rect.y + inset_y),
            LogicalSize::new(request.rect.w.max(1.0), request.rect.h.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn overlay_content(state: State<'_, Overlay>, id: String) -> Result<OverlayContent, String> {
    Ok(state
        .modals
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .unwrap_or_default()
        .content)
}

/// Resizes the view to what the element needs, and reveals it.
///
/// The main page measures the element in its own document, but the modal is
/// laid out in another one, and two layouts of the same markup can differ by a
/// line of wrapped text. The view that draws it is the one that knows, so it
/// reports its size and the view follows.
///
/// Showing happens here rather than when the modal opened, because here the
/// content is drawn and the size is right. Revealing any earlier would show a
/// view that is still empty or still the wrong shape.
#[tauri::command]
fn overlay_fit(
    window: Window,
    state: State<'_, Overlay>,
    id: String,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let Some(existing) = window.get_webview(&modal_label(&id)) else {
        return Ok(());
    };
    let Some(modal) = state.modals.lock().map_err(|e| e.to_string())?.get(&id).cloned() else {
        return Ok(());
    };
    let w = w.max(1.0);
    let h = h.max(1.0);
    existing
        .set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;

    // The clip is in the view's own pixels, so it is reapplied whenever the
    // view is resized.
    let radius = modal.radius;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    existing
        .with_webview(move |platform| native::corners(&platform, radius, w, h, scale))
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn overlay_hide(window: Window, state: State<'_, Overlay>, id: String) -> Result<(), String> {
    state.modals.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(existing) = window.get_webview(&modal_label(&id)) {
        existing.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The overlay reports what was clicked; the main page decides what it means.
#[tauri::command]
fn overlay_pick(window: Window, key: String, value: String) -> Result<(), String> {
    if let Some(main) = window.get_webview("main") {
        main.emit("overlay-pick", Picked { key, value })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Replaces what an open modal draws, without rebuilding its view. A modal whose
/// controls change what the page holds is redrawn while it stands; building the
/// view again would make it blink.
#[tauri::command]
fn overlay_update(
    window: Window,
    overlay: State<'_, Overlay>,
    request: OverlayRequest,
) -> Result<(), String> {
    let content = OverlayContent {
        css: request.css,
        class_name: request.class_name,
        html: request.html,
        border: request.border,
    };
    {
        let mut modals = overlay.modals.lock().map_err(|e| e.to_string())?;
        let Some(modal) = modals.get_mut(&request.id) else { return Ok(()) };
        modal.content = content.clone();
    }
    if let Some(view) = window.get_webview(&modal_label(&request.id)) {
        view.emit("overlay-content", content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// What a modal's page reports: which control, and what it now holds. Named
/// fields, not a pair — reading a pair by index is how the page once took the
/// first character of a string for the whole answer.
#[derive(Debug, Clone, Serialize)]
struct Picked {
    key: String,
    value: String,
}

/// Starts the shell behind a terminal surface. The page asks once, when its
/// view loads, so a surface that is reopened gets a shell of its own.
#[tauri::command]
fn terminal_open(app: tauri::AppHandle, shells: State<'_, shell::Shells>, id: String) -> Result<(), String> {
    shells.open(&app, &id)
}

#[tauri::command]
fn terminal_write(shells: State<'_, shell::Shells>, id: String, data: String) -> Result<(), String> {
    shells.write(&id, &data)
}

/// Writes one line from the page's own checks into this app's log. The page has
/// no file to write to and its console is not read when the app runs outside a
/// debugger.
#[tauri::command]
fn report(line: String) {
    println!("{line}");
}

/// What a page asks for when it loads.
#[tauri::command]
fn theme(state: State<'_, CurrentTheme>) -> Result<Theme, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.clone())
}

/// Records the theme the page is now drawn in, for the pages this host creates.
/// The page calls it when a theme is chosen, not on every render.
#[tauri::command]
fn set_theme(
    window: Window,
    state: State<'_, CurrentTheme>,
    theme: Theme,
) -> Result<(), String> {
    *state.0.lock().map_err(|e| e.to_string())? = theme.clone();
    window.emit("theme", theme).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Overlay::default())
        .manage(CurrentTheme::default())
        .manage(Views::default())
        .manage(Watching::default())
        .manage(shell::Shells::default())
        .invoke_handler(tauri::generate_handler![
            sync_surfaces,
            overlay_show,
            overlay_content,
            overlay_update,
            overlay_fit,
            overlay_hide,
            overlay_pick,
            terminal_open,
            terminal_write,
            theme,
            set_theme,
            report
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the tauri application");
}
