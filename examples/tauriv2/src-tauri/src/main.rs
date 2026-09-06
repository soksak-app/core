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
    webview::Color, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State,
    WebviewBuilder, WebviewUrl, WebviewWindowBuilder, Window,
};

/// One surface the page declares, in CSS pixels relative to the page viewport.
#[derive(Debug, Deserialize)]
struct Surface {
    id: String,
    /// The colour the view starts on. A webview leaves unpainted area white, and
    /// a divider drag resizes a surface every frame, so the strip it uncovered
    /// would flash white until its page paints it.
    background: [u8; 3],
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

/// The page's own height. Everything else the page sends is already in the
/// coordinates a child webview is placed in; this is the one difference.
#[derive(Debug, Deserialize)]
struct Viewport {
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

/// How far below the window's top the page begins.
///
/// A child webview is placed from the window's top, and the page begins below
/// the title bar, so a rect measured in the page moves down by that much. The
/// height the page reports is the only number involved — no platform constant,
/// and no guess about which chrome the window happens to have.
///
/// Wails needs none of this: there a child view is added to the content view
/// the page's own view already sits in, so the two origins are the same.
fn inset(window: &Window, viewport: &Viewport) -> Result<f64, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let height = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale)
        .height;
    Ok((height - viewport.h).max(0.0))
}

/// Snaps a logical rect inward to the display's pixel grid.
///
/// A view placed on a fractional logical coordinate is rounded when it is drawn,
/// and rounding outward makes it cover more than the rect the page declared: the
/// card's own border sits one line inside that rect, so the view paints over it.
/// Snapping inward leaves up to one device pixel of the card's background along
/// each edge, which is what is behind the view anyway. Wails snaps the same way,
/// through backingAlignedRect.
fn aligned(x: f64, y: f64, w: f64, h: f64, scale: f64) -> (f64, f64, f64, f64) {
    let step = 1.0 / scale;
    let left = (x * scale).ceil() / scale;
    let top = (y * scale).ceil() / scale;
    let right = ((x + w) * scale).floor() / scale;
    let bottom = ((y + h) * scale).floor() / scale;
    (left, top, (right - left).max(step), (bottom - top).max(step))
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
    page: &State<'_, Page>,
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
        let pointing = window.clone();
        let seen = page.0.clone();
        let handle = window.ns_window().map_err(|e| e.to_string())?;
        native::watch_mouse(
            handle,
            move |chain| {
                let Ok(map) = named.lock() else { return };
                let Some(id) = chain.iter().find_map(|view| map.get(view)) else {
                    return;
                };
                let _ = host.emit("surface-pressed", id.clone());
            },
            move |phase, x, y| {
                // The point arrives measured from the content view's top. The
                // page starts below the inset, so the page's y is that much less.
                let Ok(height) = seen.lock() else { return };
                let inset = match pointing.inner_size().and_then(|s| {
                    pointing.scale_factor().map(|f| s.to_logical::<f64>(f).height)
                }) {
                    Ok(window_height) => (window_height - *height).max(0.0),
                    Err(_) => return,
                };
                let _ = pointing.emit("surface-input", InputStep { phase, x, y: y - inset });
            },
        );
    }
    Ok(())
}

/// One step of a drag, as the page receives it. Phase is 0 for a press, 1 for a
/// move and 2 for a release.
#[derive(Clone, serde::Serialize)]
struct InputStep {
    phase: u8,
    x: f64,
    y: f64,
}

/// The height of the page's own viewport, as the page last reported it. The
/// monitor needs it to place a point in the page's coordinates.
#[derive(Default)]
struct Page(std::sync::Arc<std::sync::Mutex<f64>>);

#[tauri::command]
fn sync_surfaces(
    window: Window,
    shells: State<'_, shell::Shells>,
    views: State<'_, Views>,
    watching: State<'_, Watching>,
    page: State<'_, Page>,
    request: SyncRequest,
) -> Result<Vec<String>, String> {
    // The monitor places a point in the page's coordinates, so it needs the
    // page's height. The page reports it on every commit.
    if let Ok(mut height) = page.0.lock() {
        *height = request.viewport.h;
    }
    watch_presses(&window, &views, &watching, &page)?;
    let top = inset(&window, &request.viewport)?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;

    let mut wanted: HashSet<String> = HashSet::new();
    let mut created = Vec::new();

    for s in &request.surfaces {
        let label = label_for(&s.id);
        wanted.insert(label.clone());

        // A zero-sized webview is not something anyone can see, and some
        // platforms reject it, so treat it as hidden.
        let visible = s.visible && s.w >= 1.0 && s.h >= 1.0;
        let (ax, ay, aw, ah) = aligned(s.x, s.y + top, s.w.max(1.0), s.h.max(1.0), scale);
        let position = LogicalPosition::new(ax, ay);
        let size = LogicalSize::new(aw, ah);
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
    background: [f64; 4],
}

#[derive(Debug, Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// What the overlay webview requests after loading.
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
/// Draws one modal element in a window of its own.
///
/// A window, not a webview beside the surfaces. A webview sets the cursor from
/// its own document whenever the pointer moves over its frame, and the only thing
/// it checks is that its window is the one under the pointer, not that it is the
/// view on top. Two webviews stacked in one window both pass, so a covered point
/// gets two cursors and whichever reply lands last wins. A separate window fails
/// that check for the views below it.
///
/// A webview shows white until its document is fetched and painted. The page
/// requests overlay.html once at startup so this fetch is a cache hit.
#[tauri::command]
fn overlay_show(
    app: AppHandle,
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

    let top = inset(&window, &request.viewport)?;
    if let Some(existing) = app.get_webview_window(&label) {
        existing.close().map_err(|e| e.to_string())?;
    }
    // The id is passed in the url so the page can identify itself when it calls
    // back.
    // The page reads which framework holds it from the address it was opened at.
    let url = format!("overlay.html?id={}&framework=tauriv2", request.id);
    let [r, g, b, a] = request.background;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (ax, ay, aw, ah) = aligned(
        request.rect.x, request.rect.y + top,
        request.rect.w.max(1.0), request.rect.h.max(1.0), scale,
    );
    let (sx, sy) = on_screen(&window, ax, ay)?;
    let parent = window.ns_window().map_err(|e| e.to_string())?;
    let modal = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .decorations(false)
        .resizable(false)
        // A borderless window draws no title, but an untitled one is listed as
        // "Tauri App" wherever the system names windows.
        .title("")
        .visible(false)
        .background_color(Color(r as u8, g as u8, b as u8, (a * 255.0) as u8))
        .position(sx, sy)
        .inner_size(aw, ah)
        .parent_raw(parent)
        .build()
        .map_err(|e| e.to_string())?;
    // Tauri provides no non-opaque window without a private interface, so the
    // window is configured directly. The clipped corners would render black.
    let own = modal.ns_window().map_err(|e| e.to_string())?;
    native::panelise(own, parent);
    Ok(())
}

/// Turns a point in the app window's own coordinates into one on the screen.
fn on_screen(window: &Window, x: f64, y: f64) -> Result<(f64, f64), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let at = window
        .inner_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    Ok((at.x + x, at.y + y))
}

/// A rectangle the page draws above the surfaces.
///
/// A shape is a plain layer-backed view rather than a webview, so its fill and
/// its line carry an alpha channel and composite over what the surfaces show.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShapeRequest {
    viewport: Viewport,
    id: String,
    rect: Rect,
    radius: f64,
    line_width: f64,
    fill: [f64; 4],
    line: [f64; 4],
}

/// The shapes now on screen, by id.
#[derive(Default)]
struct Shapes(Mutex<HashMap<String, usize>>);

#[tauri::command]
fn set_shape(window: Window, shapes: State<'_, Shapes>, request: ShapeRequest) -> Result<(), String> {
    // A shape is added to the content view directly, so its frame is in AppKit's
    // coordinates: the origin is the bottom left. A child webview is placed by
    // Tauri, which converts for us; this one is not.
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let content = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale)
        .height;
    let top = (content - request.viewport.h).max(0.0);
    let h = request.rect.h.max(1.0);
    let frame = (
        request.rect.x,
        content - (request.rect.y + top) - h,
        request.rect.w.max(1.0),
        h,
    );
    let mut held = shapes.0.lock().map_err(|e| e.to_string())?;
    let view = match held.get(&request.id) {
        Some(&view) => {
            native::shape_frame(view, frame);
            view
        }
        None => {
            let handle = window.ns_window().map_err(|e| e.to_string())?;
            let view = native::shape_create(handle, frame);
            if view == 0 {
                return Ok(());
            }
            held.insert(request.id.clone(), view);
            view
        }
    };
    native::shape_style(view, request.radius, request.line_width, request.fill, request.line);
    Ok(())
}

#[tauri::command]
fn clear_shape(shapes: State<'_, Shapes>, id: String) -> Result<(), String> {
    let mut held = shapes.0.lock().map_err(|e| e.to_string())?;
    if let Some(view) = held.remove(&id) {
        native::shape_destroy(view);
    }
    Ok(())
}

/// Where an open modal's view goes. The card decides; this is that decision
/// arriving, as a drag on its grip.
#[derive(Debug, Deserialize)]
struct PlaceRequest {
    viewport: Viewport,
    id: String,
    rect: Rect,
}

#[tauri::command]
fn overlay_place(app: AppHandle, window: Window, request: PlaceRequest) -> Result<(), String> {
    let top = inset(&window, &request.viewport)?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if let Some(modal) = app.get_webview_window(&modal_label(&request.id)) {
        let (ax, ay, aw, ah) = aligned(
            request.rect.x, request.rect.y + top,
            request.rect.w.max(1.0), request.rect.h.max(1.0), scale,
        );
        let (sx, sy) = on_screen(&window, ax, ay)?;
        modal.set_position(LogicalPosition::new(sx, sy)).map_err(|e| e.to_string())?;
        modal.set_size(LogicalSize::new(aw, ah)).map_err(|e| e.to_string())?;
    }
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

/// Clips the modal's corners and reveals it.
///
/// The page reports this once its content is on screen; showing it earlier
/// displays an empty window.
///
/// The modal takes the keyboard, because a webview sets the cursor only while its
/// window holds it. The app's window is made the main one again so it keeps its
/// active title bar.
///
/// The size is not set here. The main page measures the element and the window was
/// created at that size, so a second measurement taken inside it would be of the
/// same element under a different constraint and the two would disagree. The clip
/// needs the size, which is read off the window.
#[tauri::command]
fn overlay_ready(
    app: AppHandle,
    window: Window,
    state: State<'_, Overlay>,
    id: String,
) -> Result<(), String> {
    let Some(existing) = app.get_webview_window(&modal_label(&id)) else {
        return Ok(());
    };
    let Some(modal) = state.modals.lock().map_err(|e| e.to_string())?.get(&id).cloned() else {
        return Ok(());
    };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = existing.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let radius = modal.radius;
    let (w, h) = (size.width, size.height);
    existing
        .with_webview(move |platform| native::corners(&platform, radius, w, h, scale))
        .map_err(|e| e.to_string())?;
    existing.show().map_err(|e| e.to_string())?;
    existing.set_focus().map_err(|e| e.to_string())?;
    let parent = window.ns_window().map_err(|e| e.to_string())?;
    let own = existing.ns_window().map_err(|e| e.to_string())?;
    native::panelise(own, parent);
    Ok(())
}

#[tauri::command]
fn overlay_hide(app: AppHandle, window: Window, state: State<'_, Overlay>, id: String) -> Result<(), String> {
    state.modals.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(existing) = app.get_webview_window(&modal_label(&id)) {
        existing.close().map_err(|e| e.to_string())?;
    }
    window.set_focus().map_err(|e| e.to_string())?;
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

/// Replaces an open modal's content without rebuilding its view. A modal whose
/// controls change the page's state is redrawn while it is open, and rebuilding
/// the view would make it blink.
#[tauri::command]
fn overlay_update(
    app: AppHandle,
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
    if let Some(modal) = app.get_webview_window(&modal_label(&request.id)) {
        modal.emit("overlay-content", content).map_err(|e| e.to_string())?;
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

/// Starts the shell for a terminal surface. The page calls this once, when the
/// view loads, so a reopened surface gets its own shell.
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

/// Returns the current theme. A page requests this when it loads.
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
        .manage(Shapes::default())
        .manage(CurrentTheme::default())
        .manage(Views::default())
        .manage(Watching::default())
        .manage(Page::default())
        .manage(shell::Shells::default())
        .invoke_handler(tauri::generate_handler![
            sync_surfaces,
            overlay_show,
            overlay_place,
            set_shape,
            clear_shape,
            overlay_content,
            overlay_update,
            overlay_ready,
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
