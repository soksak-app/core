// Runs the soksak example as a real Tauri v2 application, with real native
// surfaces for the browser panes.
//
// The frontend is built by the example-frontend make target from the repository
// example and is loaded from disk as frontendDist, so no bundler is involved.
//
// On every commit the example declares the frame each surface should occupy.
// sync_surfaces makes the window's child webviews match those frames: it
// creates a webview for a frame it has not seen, moves and resizes the ones it
// has, and closes the ones that are gone. Child webviews need the `unstable`
// feature of the tauri crate.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native;
mod capture;
mod observe;
mod shell;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::Mutex;

use serde::Deserialize;
use serde::Serialize;
use tauri::{
    webview::Color, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State,
    WebviewBuilder, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
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

#[derive(Debug, Deserialize)]
struct SyncRequest {
    /// Whether this is the page's final say, or one of a run still going. A run
    /// is a live resize: WebKit holds what it has drawn until the run ends,
    /// rather than showing the white it has not drawn yet.
    settled: bool,
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

/// The frame a modal's window is placed at: the page's rect snapped to the
/// display's pixels, with the size rounded up to whole points. A window is sized
/// in whole points, and rounding down would cut the card the page measured.
fn aligned_window(x: f64, y: f64, w: f64, h: f64, scale: f64) -> (f64, f64, f64, f64) {
    let (ax, ay, aw, ah) = aligned(x, y, w, h, scale);
    (ax, ay, aw.ceil(), ah.ceil())
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

    #[cfg(target_os = "macos")]
    {
        let named = views.0.clone();
        let host = window.clone();
        let pointing = window.clone();
        let handle = window.ns_window().map_err(|e| e.to_string())?;
        native::watch_mouse(
            handle,
            move |chain| {
                let Ok(map) = named.lock() else { return false };
                let Some(id) = chain.iter().find_map(|view| map.get(view)) else {
                    return false;
                };
                let _ = host.emit("surface-pressed", id.clone());
                true
            },
            move |phase, x, y| {
                // The window has no frame, so the page is the content view and
                // the point is already in the page's coordinates.
                let _ = pointing.emit("surface-input", InputStep { phase, x, y });
            },
        );
    }
    // Recorded only once the monitor is installed. Recording it first would
    // leave a failed call reporting success from then on, and no press, key or
    // drag would ever reach the page again.
    *started = true;
    Ok(())
}

/// One step of a drag, as the page receives it. Phase is 0 for a press, 1 for a
/// move and 2 for a release.
#[derive(Clone, serde::Serialize)]
pub struct InputStep {
    pub phase: u8,
    pub x: f64,
    pub y: f64,
}

#[tauri::command]
fn sync_surfaces(
    window: Window,
    shells: State<'_, shell::Shells>,
    views: State<'_, Views>,
    watching: State<'_, Watching>,
    resizing: State<'_, Resizing>,
    running: State<'_, Running>,
    request: SyncRequest,
) -> Result<Vec<Placement>, String> {
    announce_run(&window, &running, !request.settled)?;
    // The page has committed, so its window is on screen and its surfaces exist.
    // Anything that has to run once the application is drawn starts from here.
    if let Ok(mut first) = running.first.lock() {
        if !*first {
            *first = true;
            window.emit("page-ready", ()).map_err(|e| e.to_string())?;
        }
    }
    watch_presses(&window, &views, &watching)?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;

    let mut wanted: HashSet<String> = HashSet::new();

    for s in &request.surfaces {
        let label = label_for(&s.id);
        wanted.insert(label.clone());

        // A zero-sized webview is not something anyone can see, and some
        // platforms reject it, so treat it as hidden.
        let visible = s.visible && s.w >= 1.0 && s.h >= 1.0;
        let (ax, ay, aw, ah) = aligned(s.x, s.y, s.w.max(1.0), s.h.max(1.0), scale);
        let position = LogicalPosition::new(ax, ay);
        let size = LogicalSize::new(aw, ah);
        let solid = if s.dim { 0.45 } else { 1.0 };

        if let Some(webview) = window.get_webview(&label) {
            set_resizing(&resizing, &webview, !request.settled)?;
            webview.set_position(position).map_err(|e| e.to_string())?;
            webview.set_size(size).map_err(|e| e.to_string())?;
            if visible {
                webview.show().map_err(|e| e.to_string())?;
            } else {
                webview.hide().map_err(|e| e.to_string())?;
            }
            // The frame is set on the view itself as well: the two calls above
            // round to whole points and the page's rect is aligned to the
            // display's pixels.
            webview
                .with_webview(move |platform| {
                    native::alpha(&platform, solid);
                    native::place_surface(&platform, ax, ay, aw, ah);
                })
                .map_err(|e| e.to_string())?;
            continue;
        }

        let target = if s.external {
            WebviewUrl::External(s.url.parse().map_err(|_| format!("bad url: {}", s.url))?)
        } else {
            WebviewUrl::App(s.url.clone().into())
        };
        let [r, g, b] = s.background;
        // wry turns the webview's own background off when a background colour is
        // given, so the area a surface has not laid out yet is clear rather than
        // white. The Wails side asks for the same through WebviewOptions.
        let builder = WebviewBuilder::new(&label, target).background_color(Color(r, g, b, 255));
        window
            .add_child(builder, position, size)
            .map_err(|e| e.to_string())?;
        if let Some(webview) = window.get_webview(&label) {
            // A surface the page declared invisible is created shown, because a
            // child webview takes no visibility at creation. It is hidden here,
            // before the first frame it would appear in.
            if !visible {
                webview.hide().map_err(|e| e.to_string())?;
            }
            let named = views.0.clone();
            let id = s.id.clone();
            webview
                .with_webview(move |platform| {
                    native::alpha(&platform, solid);
                    // The frame is set on the view itself here too: creating a
                    // child webview rounds the size to whole points, which puts an
                    // edge outside the rect the page declared.
                    native::place_surface(&platform, ax, ay, aw, ah);
                    if let Ok(mut map) = named.lock() {
                        map.insert(native::view_id(&platform), id);
                    }
                })
                .map_err(|e| e.to_string())?;
        }
    }

    // The page is the only writer of this list, so a surface missing from it is
    // a surface that is gone.
    for webview in window.webviews() {
        let label = webview.label().to_string();
        if label.starts_with("surface-") && !wanted.contains(&label) {
            resizing.0.lock().map_err(|e| e.to_string())?.remove(&label);
            // The map is keyed by the view's address, and the system reuses an
            // address once the view is gone. A stale entry names a surface that
            // no longer exists, so it is removed with the view.
            if let Ok(mut named) = views.0.lock() {
                let id = label.trim_start_matches("surface-").to_string();
                named.retain(|_, held| *held != id);
            }
            webview.close().map_err(|e| e.to_string())?;
        }
    }
    // A shell whose surface is gone has nothing left to write to.
    let alive: Vec<String> = request.surfaces.iter().map(|s| s.id.clone()).collect();
    shells.retain(&|id: &str| alive.iter().any(|s| s == id))?;

    // Where each surface actually sits. The page declares a rect and this host
    // aligns it to the display's pixels, so the two differ and the page is told
    // by how much.
    let mut placed = Vec::with_capacity(request.surfaces.len());
    for s in &request.surfaces {
        let Some(webview) = window.get_webview(&label_for(&s.id)) else { continue };
        let at = webview
            .position()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale);
        let size = webview
            .size()
            .map_err(|e| e.to_string())?
            .to_logical::<f64>(scale);
        placed.push(Placement {
            id: s.id.clone(),
            x: at.x,
            y: at.y,
            w: size.width,
            h: size.height,
        });
    }
    Ok(placed)
}

/// Converts the page's 0-255 channels to the 0-1 range AppKit takes. The alpha
/// arrives already in that range.
fn srgba(c: [f64; 4]) -> [f64; 4] {
    [c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, c[3]]
}

/// Where one surface actually sits, in the page's coordinates.
#[derive(Clone, serde::Serialize)]
struct Placement {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Emits run-began and run-ended. The page reports whether more updates follow;
/// this emits an event only when that changes.
fn announce_run<R: Runtime>(
    window: &Window<R>,
    running: &State<'_, Running>,
    going: bool,
) -> Result<(), String> {
    {
        let mut held = running.going.lock().map_err(|e| e.to_string())?;
        if *held == going {
            return Ok(());
        }
        *held = going;
    }
    let name = if going { "run-began" } else { "run-ended" };
    window.emit(name, ()).map_err(|e| e.to_string())
}

/// Brackets a view's live resize. The calls are paired, so the state each view is
/// in is kept here and only the changes are passed on.
fn set_resizing<R: Runtime>(
    resizing: &State<'_, Resizing>,
    webview: &tauri::Webview<R>,
    live: bool,
) -> Result<(), String> {
    {
        let mut held = resizing.0.lock().map_err(|e| e.to_string())?;
        let label = webview.label().to_string();
        if held.contains(&label) == live {
            return Ok(());
        }
        if live {
            held.insert(label);
        } else {
            held.remove(&label);
        }
    }
    webview
        .with_webview(move |platform| native::resizing(&platform, live))
        .map_err(|e| e.to_string())
}

/// What a [data-native-modal] element needs in order to be drawn elsewhere.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayRequest {
    /// The element's id, which names the view that draws it.
    id: String,
    /// The element's own name, which names the window that draws it.
    title: String,
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

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// What the overlay webview requests after loading.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayContent {
    css: String,
    class_name: String,
    html: String,
    border: String,
}

/// What the one modal window is drawing now.
///
/// The page shows one [data-native-modal] element at a time and closes it before
/// it shows the next, so one record is enough and it names which modal it holds.
#[derive(Debug, Clone, Default)]
struct Modal {
    /// The element's id. The modal's own page names it in every call it makes,
    /// and a call naming another modal is one the closed modal sent last.
    id: String,
    content: OverlayContent,
    radius: f64,
    /// The page rect it was last placed at. A child window keeps its place on
    /// screen when its parent is resized, so it is placed again from this.
    at: Rect,
    /// Whether the window has been shown for this showing. The modal's document
    /// reports itself ready on every render, and showing it again takes the
    /// keyboard back.
    shown: bool,
}

/// The one modal window, and what it is drawing.
///
/// The window is built on the first showing and kept: one window for the
/// application's life, not one per showing. A window this application closes is
/// taken off the screen but is not destroyed, so a window built per showing
/// leaves one behind per showing.
#[derive(Default)]
struct Overlay {
    window: Mutex<Option<WebviewWindow>>,
    /// What that window is drawing now. None when no modal is open.
    open: Mutex<Option<Modal>>,
}

/// The label of the window every modal is drawn in.
const MODAL: &str = "modal";

/// Places the open modal at the page rect it was last given.
///
/// A child window follows its parent when the parent moves and keeps its place
/// on screen when the parent is resized, so the modal is placed again here. The
/// Wails host does this through the window it attaches to.
fn replace_modals(app: &AppHandle) {
    // The app's window holds a webview per surface, so get_webview_window does
    // not answer for it.
    let Some(window) = app.get_window("main") else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let overlay = app.state::<Overlay>();
    let at = match overlay.open.lock() {
        Ok(held) => match held.as_ref() {
            Some(modal) if modal.at.w > 0.0 => modal.at,
            _ => return,
        },
        Err(_) => return,
    };
    let modal = match overlay.window.lock() {
        Ok(held) => match held.as_ref() {
            Some(modal) => modal.clone(),
            None => return,
        },
        Err(_) => return,
    };
    let (ax, ay, aw, ah) = aligned_window(at.x, at.y, at.w.max(1.0), at.h.max(1.0), scale);
    let Ok((sx, sy)) = on_screen(&window, ax, ay) else {
        return;
    };
    let _ = modal.set_size(LogicalSize::new(aw, ah));
    let _ = modal.set_position(LogicalPosition::new(sx, sy));
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

/// The surfaces in a live resize. A surface receives the start and the end of a
/// run, not one call per frame.
#[derive(Default)]
struct Resizing(Mutex<HashSet<String>>);

/// Whether a run of updates is going, and whether the page has committed.
///
/// The page reports both on every commit. These are what make run-began,
/// run-ended and page-ready the edges of those states rather than one message
/// per frame.
#[derive(Default)]
struct Running {
    going: Mutex<bool>,
    first: Mutex<bool>,
}

/// Draws one modal element in a window of its own.
///
/// A window, not a webview beside the surfaces. A webview sets the cursor from
/// its own document whenever the pointer moves over its frame, and the only thing
/// it checks is that its window is the one under the pointer, not that it is the
/// view on top. Two webviews stacked in one window both pass, so a covered point
/// gets two cursors and whichever reply lands last wins. A separate window fails
/// that check for the views below it.
///
/// The window is created hidden and stays hidden until the page reports that its
/// content is drawn; showing it earlier displays an empty window. The frame the
/// window was created at is reported, snapped to the display's pixels.
#[tauri::command]
fn overlay_show(
    app: AppHandle,
    window: Window,
    state: State<'_, Overlay>,
    request: OverlayRequest,
) -> Result<Rect, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (ax, ay, aw, ah) = aligned_window(
        request.rect.x, request.rect.y,
        request.rect.w.max(1.0), request.rect.h.max(1.0), scale,
    );
    let (sx, sy) = on_screen(&window, ax, ay)?;
    let at = Rect { x: ax, y: ay, w: aw, h: ah };
    let [r, g, b, a] = request.background;
    let colour = Color(r as u8, g as u8, b as u8, (a * 255.0) as u8);
    // The id is passed in the url so the page can identify itself when it calls
    // back.
    let url = format!("overlay.html?id={}", request.id);

    // Written before the window is touched: the page this loads calls back with
    // its id, and it is answered from here.
    *state.open.lock().map_err(|e| e.to_string())? = Some(Modal {
        id: request.id.clone(),
        content: OverlayContent {
            css: request.css,
            class_name: request.class_name,
            html: request.html,
            border: request.border,
        },
        radius: request.radius,
        at,
        shown: false,
    });

    let mut kept = state.window.lock().map_err(|e| e.to_string())?;
    match kept.as_ref() {
        Some(modal) => {
            // Taken off the screen before its page is replaced. A webview keeps
            // what it drew until the next document paints, and what it drew is
            // the modal that was just closed.
            let own = modal.ns_window().map_err(|e| e.to_string())?;
            native::detach(own);
            // Off the screen now, not at the end of this turn: the calls below
            // move, resize and reload it, and a window still on screen shows all
            // of that happening to the modal that was closed.
            native::order_out(own);
            modal.hide().map_err(|e| e.to_string())?;
            // A borderless window draws no title, but the system and assistive
            // software name the window by it, and the name is this modal's.
            modal.set_title(&request.title).map_err(|e| e.to_string())?;
            modal.set_background_color(Some(colour)).map_err(|e| e.to_string())?;
            modal.set_size(LogicalSize::new(aw, ah)).map_err(|e| e.to_string())?;
            modal.set_position(LogicalPosition::new(sx, sy)).map_err(|e| e.to_string())?;
            // The address this window already holds names the scheme this app
            // serves, so the page is asked for by changing the id on it.
            let mut target = modal.url().map_err(|e| e.to_string())?;
            target.set_path("/overlay.html");
            target.set_query(Some(&format!("id={}", request.id)));
            modal.navigate(target).map_err(|e| e.to_string())?;
        }
        None => {
            let parent = window.ns_window().map_err(|e| e.to_string())?;
            let built = WebviewWindowBuilder::new(&app, MODAL, WebviewUrl::App(url.into()))
                .decorations(false)
                .resizable(false)
                // A borderless window draws no title, but the system and assistive
                // software name the window by it.
                .title(&request.title)
                .visible(false)
                .background_color(colour)
                // Whole points: tao converts the position through the window's
                // height, and a fractional screen position makes the window one
                // point taller than the size asked for.
                .position(sx.round(), sy.round())
                .inner_size(aw, ah)
                .build()
                .map_err(|e| e.to_string())?;
            // Tauri provides no non-opaque window without a private interface, so
            // the window is configured directly. The clipped corners would render
            // black.
            let own = built.ns_window().map_err(|e| e.to_string())?;
            native::panelise(own, parent);
            *kept = Some(built);
        }
    }
    Ok(at)
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
    let h = request.rect.h.max(1.0);
    let frame = (
        request.rect.x,
        content - request.rect.y - h,
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
            native::shape_frame(view, frame);
            view
        }
    };
    // The page sends colour channels as 0-255 and alpha as 0-1; AppKit takes all
    // four as 0-1.
    native::shape_style(view, request.radius, request.line_width,
        srgba(request.fill), srgba(request.line));
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
    id: String,
    rect: Rect,
}

/// Moves and resizes an open modal's window and reports where it ended up.
///
/// The frame reported is the one applied, which is the page's rect snapped to the
/// display's pixels. The page declares a rect and the host places the window on
/// whole pixels, so the two differ and the page is told by how much.
#[tauri::command]
fn overlay_place(
    window: Window,
    state: State<'_, Overlay>,
    request: PlaceRequest,
) -> Result<Rect, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let open = matches!(
        state.open.lock().map_err(|e| e.to_string())?.as_ref(),
        Some(modal) if modal.id == request.id
    );
    let held = state.window.lock().map_err(|e| e.to_string())?.clone();
    let Some(modal) = held.filter(|_| open) else {
        return Ok(Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 });
    };
    let (ax, ay, aw, ah) = aligned_window(
        request.rect.x, request.rect.y,
        request.rect.w.max(1.0), request.rect.h.max(1.0), scale,
    );
    let (sx, sy) = on_screen(&window, ax, ay)?;
    modal.set_size(LogicalSize::new(aw, ah)).map_err(|e| e.to_string())?;
    modal.set_position(LogicalPosition::new(sx, sy)).map_err(|e| e.to_string())?;
    let applied = Rect { x: ax, y: ay, w: aw, h: ah };
    if let Ok(mut held) = state.open.lock() {
        if let Some(open) = held.as_mut().filter(|m| m.id == request.id) {
            open.at = applied;
        }
    }
    Ok(applied)
}

#[tauri::command]
fn overlay_content(state: State<'_, Overlay>, id: String) -> Result<OverlayContent, String> {
    Ok(state
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .filter(|modal| modal.id == id)
        .map(|modal| modal.content.clone())
        .unwrap_or_default())
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
    // The modal's document calls this from every render, and the window is shown
    // on the first one. The rest are announced: whether a content update reached
    // that document is a fact only the document has, and this call carries it.
    app.emit("modal-rendered", &id).map_err(|e| e.to_string())?;
    let Some(existing) = state.window.lock().map_err(|e| e.to_string())?.clone() else {
        return Ok(());
    };
    // The modal's document reports itself ready from its render, and it renders
    // again on every content change. The window is shown once per showing, and a
    // report naming another modal is one the modal that was closed sent last.
    let first = {
        let mut held = state.open.lock().map_err(|e| e.to_string())?;
        match held.as_mut() {
            Some(modal) if modal.id == id && !modal.shown => {
                modal.shown = true;
                Some(modal.clone())
            }
            _ => None,
        }
    };
    let Some(modal) = first else {
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
    // The modal's own document calls this command, so the window injected into
    // it is the modal. The application's window is found by name and made main
    // again. get_webview_window does not answer for it: it holds a webview per
    // surface.
    if let Some(main) = app.get_window("main") {
        let parent = main.ns_window().map_err(|e| e.to_string())?;
        // Made a child of the app's window here rather than at build: AppKit
        // puts a window on screen the moment it is added as a child, whatever
        // visible(false) asked for, and until now it held nothing drawn.
        native::attach(existing.ns_window().map_err(|e| e.to_string())?, parent);
        native::make_main(parent);
    }
    // A modal is a window of its own, so this app now holds one more. AppKit gives
    // no notification when a child window is attached, and attaching it is done
    // here, so it is announced here.
    app.emit("windows-changed", ()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn overlay_hide(app: AppHandle, window: Window, state: State<'_, Overlay>, id: String) -> Result<(), String> {
    {
        let mut held = state.open.lock().map_err(|e| e.to_string())?;
        if !matches!(held.as_ref(), Some(modal) if modal.id == id) {
            return Ok(());
        }
        *held = None;
    }
    // A modal is open only once the window has been built, so it is here.
    if let Some(existing) = state.window.lock().map_err(|e| e.to_string())?.as_ref() {
        // Taken off the screen and off the app's window, not closed: this is the
        // one window every modal is drawn in and the next showing draws in it.
        let own = existing.ns_window().map_err(|e| e.to_string())?;
        native::detach(own);
        native::order_out(own);
        existing.hide().map_err(|e| e.to_string())?;
    }
    window.set_focus().map_err(|e| e.to_string())?;
    app.emit("windows-changed", ()).map_err(|e| e.to_string())?;
    Ok(())
}

/// The overlay reports what was clicked; the main page decides what it means.
#[tauri::command]
fn overlay_pick(window: Window, id: String, key: String, value: String) -> Result<(), String> {
    if let Some(main) = window.get_webview("main") {
        main.emit("overlay-pick", Picked { id, key, value })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Replaces an open modal's content without rebuilding its view. A modal whose
/// controls change the page's state is redrawn while it is open, and rebuilding
/// the view would make it blink.
#[tauri::command]
fn overlay_update(app: AppHandle, overlay: State<'_, Overlay>, request: UpdateRequest) -> Result<(), String> {
    let content = request.content;
    {
        let mut held = overlay.open.lock().map_err(|e| e.to_string())?;
        let Some(modal) = held.as_mut().filter(|m| m.id == request.id) else { return Ok(()) };
        modal.content = content.clone();
    }
    // Every page receives the event, so it carries the id and each modal's page
    // keeps the one addressed to it.
    app.emit("modal-content", ModalContentEvent { id: request.id, content })
        .map_err(|e| e.to_string())
}

/// New content for an open modal. It carries what the page measured of the
/// element and nothing else: a modal that is already open keeps its position and
/// size.
#[derive(Debug, Deserialize)]
struct UpdateRequest {
    id: String,
    #[serde(flatten)]
    content: OverlayContent,
}

/// New content for one modal, as its page receives it.
#[derive(Clone, serde::Serialize)]
struct ModalContentEvent {
    id: String,
    content: OverlayContent,
}

/// What a modal's page reports: which control, and what it now holds. Named
/// fields, not a pair — reading a pair by index is how the page once took the
/// first character of a string for the whole answer.
#[derive(Debug, Clone, Serialize)]
struct Picked {
    id: String,
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
    eprintln!("{line}");
}

/// Places the window's own buttons so they sit inside the page's first row.
///
/// The platform lays them out for a standard title bar, which is shorter than
/// that row, so they would sit above it.
fn place_window_controls(window: &Window) -> Result<(), String> {
    let handle = window.ns_window().map_err(|e| e.to_string())? as usize;
    // AppKit lays views out on the main thread, and a command is answered on
    // another one.
    window
        .run_on_main_thread(move || {
            native::place_window_controls(
                handle as *mut std::ffi::c_void,
                CONTROLS_AT.0,
                CONTROLS_AT.1,
            );
        })
        .map_err(|e| e.to_string())
}

/// Where the window's own buttons are placed, in points from the window's top
/// left, measured to the leftmost button's frame. The Wails host places them at
/// the same point, and `examples/test/controls.test.mjs` measures the result in
/// both.
const CONTROLS_AT: (f64, f64) = (12.0, 14.5);

/// Reports the area the window's own buttons occupy, in the page's coordinates.
/// The page leaves that much of its first row empty.
#[tauri::command]
fn window_controls(window: Window) -> Result<Rect, String> {
    let handle = window.ns_window().map_err(|e| e.to_string())?;
    let (x, y, w, h) = native::window_controls(handle);
    Ok(Rect { x, y, w, h })
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
    // Observation is registered only when it is asked for. It is not part of
    // the product.
    let observing = observe::given("observe");
    let mut app = tauri::Builder::default();
    if observing {
        app = app.plugin(observe::plugin());
    }
    app.setup(|app| {
        // The window's own buttons are placed before the page loads, so the page
        // reads where they are once and never sees them move.
        if let Some(window) = app.get_webview_window("main") {
            place_window_controls(&window.as_ref().window())?;
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Resized(_)) {
                    replace_modals(&handle);
                }
            });
        }
        Ok(())
    })
    .manage(Overlay::default())
        .manage(Shapes::default())
        .manage(CurrentTheme::default())
        .manage(Views::default())
        .manage(Watching::default())
        .manage(Resizing::default())
        .manage(Running::default())
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
            window_controls,
            terminal_open,
            terminal_write,
            theme,
            set_theme,
            report
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the tauri application");
}
