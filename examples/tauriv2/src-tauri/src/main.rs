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
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use serde::Serialize;
use tauri::{
    webview::Color, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State,
    Webview, WebviewBuilder, WebviewUrl, Window,
};

/// One surface the page declares, in CSS pixels relative to the page viewport.
#[derive(Debug, Deserialize)]
struct Surface {
    id: String,
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
    /// 연속적인 배치 갱신이 종료되었는지 나타낸다.
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
) -> Result<(), String> {
    let mut started = watching.0.lock().map_err(|e| e.to_string())?;
    if *started {
        return Ok(());
    }
    let main = window.get_webview("main").ok_or("the main webview is gone")?;
    isolate_webview(&main)?;

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
                // The page fills the window's content view, so the point is
                // already in the page's coordinates.
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
    overlay: State<'_, Overlay>,
    shells: State<'_, shell::Shells>,
    views: State<'_, Views>,
    watching: State<'_, Watching>,
    resizing: State<'_, Resizing>,
    running: State<'_, Running>,
    request: SyncRequest,
) -> Result<PreparedSurfaces, String> {
    if !request.settled { announce_run(&window, &running, true)?; }
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

    let main = window.get_webview("main").ok_or("the main webview is gone")?;
    let ticket = running.prepared.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = std::sync::mpsc::channel();
    main.with_webview(move |_| {
        native::begin_surface_layout(ticket);
        let _ = tx.send(());
    }).map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?;

    let result = (|| -> Result<PreparedSurfaces, String> {
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
            #[cfg(not(target_os = "macos"))]
            {
                webview.set_bounds(tauri::Rect { position: position.into(), size: size.into() })
                    .map_err(|e| e.to_string())?;
            }
            if visible {
                webview.show().map_err(|e| e.to_string())?;
            } else {
                webview.hide().map_err(|e| e.to_string())?;
            }
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
        let builder = WebviewBuilder::new(&label, target)
            .initialization_script(include_str!("../../../browser/background.js"));
        window
            .add_child(builder, position, size)
            .map_err(|e| e.to_string())?;
        if let Some(webview) = window.get_webview(&label) {
            // A surface the page declared invisible is created shown, because a
            // child webview takes no visibility at creation. It is hidden here,
            // before the first frame it would appear in.
            isolate_webview(&webview)?;
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
            // add_child appends above existing views. Keep an open modal above
            // the surface just added, without changing keyboard focus.
            let modal = overlay.view.lock().map_err(|e| e.to_string())?.clone();
            if let Some(modal) = modal {
                modal.with_webview(|platform| native::raise_webview(&platform))
                    .map_err(|e| e.to_string())?;
            }
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
    Ok(PreparedSurfaces { ticket, placements: placed })
    })();
    if result.is_err() {
        main.with_webview(move |_| { native::commit_surface_layout(ticket); })
            .map_err(|e| e.to_string())?;
    }
    result
}

/// Converts the page's 0-255 channels to the 0-1 range AppKit takes. The alpha
/// arrives already in that range.
fn srgba(c: [f64; 4]) -> [f64; 4] {
    [c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, c[3]]
}

/// Where one surface actually sits, in the page's coordinates.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Placement {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(serde::Serialize)]
struct PreparedSurfaces {
    ticket: u64,
    placements: Vec<Placement>,
}

#[derive(Deserialize)]
struct PresentRequest {
    ticket: u64,
    placements: Vec<Placement>,
    settled: bool,
}

/// The DOM has drawn these preparations. Confirm its presentation without
/// blocking subsequent preparations or the AppKit event loop.
#[tauri::command]
async fn present_surfaces(window: Window, request: PresentRequest) -> Result<Vec<Placement>, String> {
    #[cfg(target_os = "macos")]
    {
        let main = window.get_webview("main").ok_or("the main webview is gone")?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let ticket = request.ticket;
        let finished = window.clone();
        let settled = request.settled;
        let held: Vec<_> = request.placements.into_iter().filter_map(|p| {
            window.get_webview(&label_for(&p.id)).map(|view| (view, p))
        }).collect();
        let (tx, mut rx) = tauri::async_runtime::channel(1);
        main.with_webview(move |platform| native::after_presentation(&platform, move || {
            let committed = native::commit_surface_layout(ticket);
            let result = (|| -> Result<Vec<Placement>, String> {
                let mut placed = Vec::new();
                for (view, p) in &held {
                    let at = view.position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
                    let size = view.size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
                    placed.push(Placement { id: p.id.clone(), x: at.x, y: at.y, w: size.width, h: size.height });
                }
                // 준비 갱신과 종료 판정을 같은 UI 스레드에서 순서대로 실행한다.
                let running = finished.state::<Running>();
                if committed && settled && running.prepared.load(Ordering::Relaxed) == ticket {
                    announce_run(&finished, &running, false)?;
                }
                Ok(placed)
            })();
            let _ = tx.try_send(result);
        })).map_err(|e| e.to_string())?;
        let placed = rx.recv().await.ok_or("the main webview closed before presenting")??;
        Ok(placed)
    }
    #[cfg(not(target_os = "macos"))]
    {
        if request.settled { announce_run(&window, &window.state::<Running>(), false)?; }
        Ok(request.placements)
    }
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
    mode: String,
    card: Rect,
    /// The element's id, which names the view that draws it.
    id: String,
    /// The accessible name of the overlay document.
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
    mode: String,
    card: Rect,
    title: String,
    css: String,
    class_name: String,
    html: String,
    border: String,
}

/// What the overlay webview is drawing now.
///
/// The page shows one [data-native-modal] element at a time and closes it before
/// it shows the next, so one record is enough and it names which modal it holds.
#[derive(Debug, Clone, Default)]
struct Modal {
    instance: u64,
    /// The element's id. The modal's own page names it in every call it makes,
    /// and a call naming another modal is one the closed modal sent last.
    id: String,
    content: OverlayContent,
    radius: f64,
    /// The page rect, also used when configuring the view's rounded corners.
    at: Rect,
    /// Whether the window has been shown for this showing. The modal's document
    /// reports itself ready on every render, and showing it again takes the
    /// keyboard back.
    shown: bool,
}

/// A child webview inside main and the document it currently presents.
#[derive(Default)]
struct Overlay {
    view: Mutex<Option<Webview>>,
    open: Mutex<Option<Modal>>,
    next: AtomicU64,
}

impl Overlay {
    fn dialog(&self) -> bool {
        self.open.lock().is_ok_and(|open| open.as_ref().is_some_and(|m| m.content.mode == "dialog"))
    }

    fn discard(&self) -> Result<(), String> {
        *self.open.lock().map_err(|e| e.to_string())? = None;
        let view = self.view.lock().map_err(|e| e.to_string())?.take();
        if let Some(view) = view {
            set_background(&view.window(), false)?;
            view.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn set_background(window: &Window, enabled: bool) -> Result<(), String> {
    for view in window.webviews() {
        if view.label() == "main" || view.label().starts_with("surface-") {
            view.eval(format!("window.__soksakBackground = {enabled}"))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// Commands run off the AppKit thread. Report installation failure to the caller
// before it publishes an overlapping webview as usable.
fn isolate_webview(view: &Webview) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    view.with_webview(move |platform| { let _ = tx.send(native::register_input(&platform)); })
        .map_err(|e| e.to_string())?;
    if rx.recv().map_err(|e| e.to_string())? { Ok(()) }
    else { Err("this WebKit cannot install native webview input isolation".into()) }
}

/// Places an overlay in content coordinates without rounding fractional pixels.
fn place_overlay(view: &Webview, at: Rect) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return view.with_webview(move |platform| {
        native::place_surface(&platform, at.x, at.y, at.w, at.h);
    }).map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    view.set_bounds(tauri::Rect {
        position: LogicalPosition::new(at.x, at.y).into(),
        size: LogicalSize::new(at.w, at.h).into(),
    }).map_err(|e| e.to_string())
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
    prepared: AtomicU64,
    going: Mutex<bool>,
    first: Mutex<bool>,
}

/// Draws one modal element in a webview inside the main window.
/// The view stays hidden until its document reports that the content is drawn.
#[tauri::command]
fn overlay_show(window: Window, state: State<'_, Overlay>, request: OverlayRequest) -> Result<Rect, String> {
    // Destroy the previous native view. A showing has its own identity so late
    // messages from its document cannot affect the next one with the same id.
    state.discard()?;
    let instance = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (x, y, w, h) = aligned(request.rect.x, request.rect.y, request.rect.w.max(1.0), request.rect.h.max(1.0), scale);
    let at = Rect { x, y, w, h };
    let mut target = window.get_webview("main").ok_or("the main webview is gone")?.url().map_err(|e| e.to_string())?;
    target.set_path("/overlay.html");
    target.set_query(None);
    target.query_pairs_mut().append_pair("id", &request.id).append_pair("instance", &instance.to_string());
    *state.open.lock().map_err(|e| e.to_string())? = Some(Modal {
        id: request.id.clone(), instance,
        content: OverlayContent { mode: request.mode.clone(), card: request.card, title: request.title, css: request.css, class_name: request.class_name, html: request.html, border: request.border },
        radius: request.radius, at, shown: false,
    });
    // Start blank with no drawable area, hide it, then publish the view before
    // navigating to a document that calls overlay_ready. This avoids both an
    // empty frame on screen and a creation/ready race.
    let built = window.add_child(
        WebviewBuilder::new(format!("modal-{instance}"), WebviewUrl::External("about:blank".parse().unwrap()))
            .background_color(Color(0, 0, 0, 0)),
        LogicalPosition::new(x, y), LogicalSize::new(0.0, 0.0),
    );
    let view = match built {
        Ok(view) => view,
        Err(error) => { *state.open.lock().map_err(|e| e.to_string())? = None; return Err(error.to_string()); }
    };
    isolate_webview(&view)?;
    view.hide().map_err(|e| e.to_string())?;
    place_overlay(&view, at)?;
    view.set_auto_resize(request.mode == "dialog").map_err(|e| e.to_string())?;
    *state.view.lock().map_err(|e| e.to_string())? = Some(view.clone());
    if let Err(error) = view.navigate(target) {
        let _ = view.close();
        *state.view.lock().map_err(|e| e.to_string())? = None;
        *state.open.lock().map_err(|e| e.to_string())? = None;
        return Err(error.to_string());
    }
    Ok(at)
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
    card: Rect,
}

#[derive(Clone, Serialize)]
struct ModalPosition {
    id: String,
    instance: u64,
    card: Rect,
}

/// Moves and resizes an open modal's window and reports where it ended up.
///
/// The frame reported is the one applied, which is the page's rect snapped to the
/// display's pixels. The page declares a rect and the host places the window on
/// whole pixels, so the two differ and the page is told by how much.
#[tauri::command]
fn overlay_place(window: Window, state: State<'_, Overlay>, request: PlaceRequest) -> Result<Rect, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let current = state.open.lock().map_err(|e| e.to_string())?.as_ref().is_some_and(|m| m.id == request.id);
    let Some(view) = state.view.lock().map_err(|e| e.to_string())?.clone().filter(|_| current) else {
        return Ok(Rect::default());
    };
    let (x, y, w, h) = aligned(request.rect.x, request.rect.y, request.rect.w.max(1.0), request.rect.h.max(1.0), scale);
    let at = Rect { x, y, w, h };
    place_overlay(&view, at)?;
    if let Some(modal) = state.open.lock().map_err(|e| e.to_string())?.as_mut().filter(|m| m.id == request.id) {
        modal.at = at;
        modal.content.card = request.card;
        view.emit("modal-position", ModalPosition { id: modal.id.clone(), instance: modal.instance, card: request.card })
            .map_err(|e| e.to_string())?;
    }
    Ok(at)
}

#[tauri::command]
fn overlay_content(state: State<'_, Overlay>, id: String, instance: u64) -> Result<OverlayContent, String> {
    Ok(state
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .filter(|modal| modal.id == id && modal.instance == instance)
        .map(|modal| modal.content.clone())
        .unwrap_or_default())
}

/// Reveals the child webview once this showing has rendered.
#[tauri::command]
fn overlay_ready(app: AppHandle, window: Window, state: State<'_, Overlay>, id: String, instance: u64) -> Result<(), String> {
    let Some(view) = state.view.lock().map_err(|e| e.to_string())?.clone() else { return Ok(()) };
    let first = {
        let mut held = state.open.lock().map_err(|e| e.to_string())?;
        let Some(modal) = held.as_mut().filter(|m| m.id == id && m.instance == instance) else { return Ok(()) };
        if modal.shown {
            app.emit("modal-rendered", &id).map_err(|e| e.to_string())?;
            return Ok(())
        }
        modal.shown = true;
        modal.clone()
    };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    set_background(&window, first.content.mode == "dialog")?;
    view.with_webview(move |platform| {
        native::corners(&platform, first.radius, first.at.w, first.at.h, scale);
        native::raise_webview(&platform);
    }).map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())?;
    view.set_focus().map_err(|e| e.to_string())?;
    app.emit("modal-rendered", &id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn overlay_hide(window: Window, state: State<'_, Overlay>, id: String) -> Result<(), String> {
    {
        let mut held = state.open.lock().map_err(|e| e.to_string())?;
        if !matches!(held.as_ref(), Some(modal) if modal.id == id) { return Ok(()) }
        *held = None;
    }
    state.discard()?;
    if let Some(main) = window.get_webview("main") { main.set_focus().map_err(|e| e.to_string())?; }
    Ok(())
}

/// An old document may finish sending an answer after its view was destroyed.
#[tauri::command]
fn overlay_pick(window: Window, state: State<'_, Overlay>, id: String, instance: u64, key: String, value: String) -> Result<(), String> {
    let current = state.open.lock().map_err(|e| e.to_string())?.as_ref().is_some_and(|m| m.id == id && m.instance == instance);
    if current {
        if let Some(main) = window.get_webview("main") {
            main.emit("overlay-pick", Picked { id, key, value }).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Replaces an open modal's content without rebuilding its view. A modal whose
/// controls change the page's state is redrawn while it is open, and rebuilding
/// the view would make it blink.
#[tauri::command]
fn overlay_update(app: AppHandle, overlay: State<'_, Overlay>, request: UpdateRequest) -> Result<(), String> {
    let content = request.content;
    let instance = {
        let mut held = overlay.open.lock().map_err(|e| e.to_string())?;
        let Some(modal) = held.as_mut().filter(|m| m.id == request.id) else { return Ok(()) };
        modal.content = content.clone();
        modal.instance
    };
    // Every page receives the event, so it carries the id and each modal's page
    // keeps the one addressed to it.
    app.emit("modal-content", ModalContentEvent { instance, id: request.id, content })
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
    instance: u64,
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
    observe::say(&line);
}

/// Places the window's own buttons so they sit inside the page's first row.
///
/// The platform lays them out for a standard title bar, which is shorter than
/// that row, so they would sit above it.
fn place_window_controls(window: &Window) -> Result<(), String> {
    let handle = window.ns_window().map_err(|e| e.to_string())? as usize;
    // AppKit lays views out on the main thread. This is called from setup, which
    // is already there, so the closure runs inline; the wrapper says which thread
    // the work belongs on rather than moving it to one.
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
    app.on_page_load(|webview, payload| {
        if webview.label().starts_with("surface-") && payload.event() == tauri::webview::PageLoadEvent::Started {
            let enabled = webview.state::<Overlay>().dialog();
            if let Err(error) = webview.eval(format!("window.__soksakBackground = {enabled}")) {
                eprintln!("cannot apply the surface background effect: {error}");
            }
        }
        if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
            if let Err(error) = webview.with_webview(|_| native::cancel_surface_layout()) {
                eprintln!("cannot cancel the previous document's layout: {error}");
            }
            // The previous main document's DOM and answer callback are gone.
            if let Err(error) = webview.state::<Overlay>().discard() {
                eprintln!("cannot discard the previous document's overlay: {error}");
            }
        }
    }).setup(|app| {
        // The window's own buttons are placed before the page loads, so the page
        // reads where they are once and never sees them move.
        if let Some(window) = app.get_webview_window("main") {
            place_window_controls(&window.as_ref().window())?;
            let placed = window.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Resized(_)) {
                    // The buttons are laid out from the window's top left, and
                    // the view holding them keeps the frame it was given, which
                    // is measured from the bottom. A window that changes height
                    // leaves them somewhere else in the page's first row, so
                    // they are placed again for the size the window now has.
                    let _ = place_window_controls(&placed.as_ref().window());
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
            present_surfaces,
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
