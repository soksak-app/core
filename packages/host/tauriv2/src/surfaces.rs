//! Surface synchronization, presentation check, placement and surface input delivery.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Manager, Webview, Window};

use crate::application_log::{log_error, log_failure};
use crate::documents;
use crate::exposure;
use crate::images;
use crate::platform::{self, Handle};
use crate::sidecars::WindowSidecars;
use crate::windows::{
    cancel_window_layout, emit_window, restore_titlebar, titlebar_chrome, validate_titlebar_height,
    window_data, with_native_owner, Chrome, NativeFailure, TitlebarChange,
};

/// The script that the surface webviews run before the document.
pub(crate) struct Background;

/// One surface that the page declared. The coordinates are CSS pixels relative to the page viewport.
#[derive(Debug, Deserialize)]
pub(crate) struct Surface {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
    /// Shows whether the page requested to dim this surface.
    dim: bool,
    /// The id of the plugin that owns the surface. A document region opens the plugin document of that plugin.
    plugin: String,
    composition: SurfaceComposition,
}

pub fn validate_rect(name: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() || !w.is_finite() || !h.is_finite() {
        return Err(format!("{name} geometry must contain finite numbers"));
    }
    if w < 0.0 || h < 0.0 {
        return Err(format!("{name} geometry must not have a negative size"));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub(crate) struct SurfaceRegion {
    pub(crate) name: String,
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) sidecar: String,
    pub(crate) input: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct SurfaceComposition {
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) regions: Vec<SurfaceRegion>,
    pub(crate) overlays: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CompositionDeclareRequest {
    pub(crate) surface: String,
    /// The id of the plugin whose page the surface shows.
    pub(crate) plugin: String,
    pub(crate) composition: SurfaceComposition,
}

fn valid_composition_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .enumerate()
            .all(|(i, ch)| ch.is_ascii_lowercase() || ch.is_ascii_digit() || (i > 0 && ch == '-'))
}

fn validate_composition(composition: &SurfaceComposition) -> Result<(), String> {
    if composition.kind == "dom" {
        if !composition.regions.is_empty()
            || composition.overlays.as_ref().is_some_and(|v| !v.is_empty())
        {
            return Err("dom composition cannot declare regions or overlays".into());
        }
        return Ok(());
    }
    if composition.kind != "hybrid"
        || composition.regions.is_empty()
        || composition.overlays.is_none()
    {
        return Err("surface composition must be dom or a complete hybrid composition".into());
    }
    let mut seen = HashSet::new();
    for region in &composition.regions {
        if !valid_composition_name(&region.name) || !seen.insert(region.name.clone()) {
            return Err(format!(
                "invalid or duplicate composition name {:?}",
                region.name
            ));
        }
        match region.kind.as_str() {
            "document" if region.input == "native" && region.sidecar.is_empty() => {}
            "document" => {
                return Err(format!(
                    "document region {:?} must own native input",
                    region.name
                ))
            }
            "image" if region.input == "dom" && !region.sidecar.is_empty() => {}
            "image" => {
                return Err(format!(
                    "image region {:?} requires DOM input and a sidecar",
                    region.name
                ))
            }
            _ => return Err(format!("unknown region kind {:?}", region.kind)),
        }
    }
    for overlay in composition.overlays.as_ref().expect("checked above") {
        if !valid_composition_name(overlay) || !seen.insert(overlay.clone()) {
            return Err(format!("invalid or duplicate composition name {overlay:?}"));
        }
    }
    Ok(())
}

pub(crate) fn require_region(
    compositions: &Mutex<HashMap<String, SurfaceComposition>>,
    surface: &str,
    name: &str,
    kind: &str,
    sidecar: Option<&str>,
) -> Result<(), String> {
    let all = compositions.lock().map_err(|e| e.to_string())?;
    let composition = all
        .get(surface)
        .ok_or_else(|| format!("surface {surface:?} has no composition declaration"))?;
    let region = composition
        .regions
        .iter()
        .find(|region| region.name == name)
        .ok_or_else(|| format!("region {name:?} is not declared by surface {surface:?}"))?;
    if region.kind != kind {
        return Err(format!(
            "region {name:?} is declared as {}, not {kind}",
            region.kind
        ));
    }
    if let Some(sidecar) = sidecar {
        if region.sidecar != sidecar {
            return Err(format!(
                "image {name:?} is not declared for sidecar {sidecar:?}"
            ));
        }
    }
    Ok(())
}

/// Registers the immutable composition contract before the surface places its first frame.
pub(crate) fn declare(webview: &Webview, request: CompositionDeclareRequest) -> Result<(), String> {
    if request.surface.is_empty() {
        return Err("composition declaration requires a surface".into());
    }
    if request.plugin.is_empty() {
        return Err(format!(
            "composition declaration of surface {:?} requires its plugin",
            request.surface
        ));
    }
    validate_composition(&request.composition)?;
    let data = window_data(&webview.window())?;
    let mut all = data.compositions.lock().map_err(|e| e.to_string())?;
    let mut plugins = data.surface_plugins.lock().map_err(|e| e.to_string())?;
    if let Some(previous) = all.get(&request.surface) {
        if previous != &request.composition
            || plugins.get(&request.surface) != Some(&request.plugin)
        {
            return Err(format!(
                "surface {:?} changed its composition declaration",
                request.surface
            ));
        }
        return Ok(());
    }
    plugins.insert(request.surface.clone(), request.plugin);
    all.insert(request.surface, request.composition);
    Ok(())
}

/// Whether the surface is attached to this window. It is an error when the state of the window cannot be read.
pub(crate) fn surface_attached(window: &Window, surface: &str) -> Result<bool, String> {
    Ok(window_data(window)?
        .surface_hosts
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(surface))
}

pub(crate) fn surface_handle(window: &Window, surface: &str) -> Result<Handle, String> {
    window_data(window)?
        .surface_hosts
        .lock()
        .map_err(|e| e.to_string())?
        .get(surface)
        .copied()
        .ok_or_else(|| format!("surface {surface:?} is not attached"))
}

/// Finds the logical surface that corresponds to the native view that received the press. An unknown view does not
/// activate a workbench card.
pub fn surface_owner_id(named: &HashMap<Handle, String>, view: Handle) -> Option<&str> {
    named
        .get(&view)
        .filter(|id| !id.is_empty())
        .map(String::as_str)
}

/// When the coordinates of a directly injected press are in a surface or its document, delivers the surface press to
/// the page. A direct injection does not pass through the AppKit local event monitor, so this is called separately from
/// the monitor.
pub(crate) fn press_at(window: &Window, x: f64, y: f64) -> Result<(), NativeFailure> {
    let platform = platform::current().map_err(NativeFailure::Failed)?;
    let target = window.clone();
    let id = with_native_owner(window, move |handle| {
        let hit = platform.hit(handle, x, y)?;
        // Destroyed deletes the registration, so it is read in this step, while the window is open.
        let data = window_data(&target)?;
        let named = data.views.0.lock().map_err(|e| e.to_string())?;
        let documents = data.documents.names();
        Ok(hit.chain.iter().find_map(|view| {
            surface_owner_id(&named, *view)
                .map(str::to_owned)
                .or_else(|| documents.get(view).map(|(surface, _)| surface.clone()))
        }))
    })?;
    if let Some(id) = id {
        emit_window(window, "surface-pressed", id)
            .map_err(|e| NativeFailure::Failed(e.to_string()))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SyncRequest {
    /// Shows whether a continuous placement update ended.
    settled: bool,
    #[serde(default)]
    overlays: Vec<WindowOverlayRequest>,
    surfaces: Vec<Surface>,
    /// The height (pt) of the first row that the next draw will show. The window title bar is set to this height inside
    /// the placement transaction.
    /// (docs/spec/native-surfaces.md#title-bar-height).
    titlebar: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowOverlayRequest {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[serde(default = "visible_overlay")]
    visible: bool,
}

fn visible_overlay() -> bool {
    true
}

/// A rectangle in page coordinates.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The position where a surface was actually placed. It is in page coordinates.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Placement {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
}

/// The answer of a preparation. chrome is the window button area and the title bar height after the host set the title
/// bar in this transaction, and the page reads it as committed state after it checks the presentation of this
/// preparation.
#[derive(Serialize)]
pub(crate) struct PreparedSurfaces {
    ticket: u64,
    placements: Vec<Placement>,
    chrome: Chrome,
}

#[derive(Deserialize)]
pub(crate) struct PresentRequest {
    ticket: u64,
    placements: Vec<Placement>,
    settled: bool,
    #[serde(default, rename = "waitForPresentation")]
    wait_for_presentation: bool,
}

/// One step of a drag. phase is 0 for press, 1 for move and 2 for release.
#[derive(Clone, Serialize)]
struct InputStep {
    phase: u8,
    x: f64,
    y: f64,
}

/// The view that each surface draws. It maps the view that received a press to a surface.
#[derive(Default)]
pub(crate) struct Views(pub Arc<Mutex<HashMap<Handle, String>>>);

/// The input monitor of a window. It is None when the watch was not started.
#[derive(Default)]
pub(crate) struct Watching(pub Arc<Mutex<Option<Handle>>>);

/// The surface in a continuous resize. A surface receives the start and the end of a continuous resize and not every
/// frame. It shows whether a continuous update is in progress and whether the page committed.
///
/// The page reports two values at every commit. run-began, run-ended and page-ready occur only when this state changes
/// and not at every frame.
#[derive(Default)]
pub(crate) struct Running {
    pub prepared: AtomicU64,
    going: Mutex<bool>,
    first: Mutex<bool>,
    settled: Mutex<Vec<std::sync::mpsc::Sender<()>>>,
}

/// Returns the receiver that gets a value when the continuous update ends. When no update is in progress, it already
/// has a value. Only the diagnostic method diagnostics.drag uses it.
#[cfg(feature = "diagnostics")]
pub(crate) fn when_settled(running: &Running) -> Result<std::sync::mpsc::Receiver<()>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let going = running.going.lock().map_err(|e| e.to_string())?;
    if *going {
        running.settled.lock().map_err(|e| e.to_string())?.push(tx);
    } else {
        tx.send(())
            .map_err(|error| format!("settled notification had no receiver: {error}"))?;
    }
    Ok(rx)
}

pub(crate) fn label_for(window: &Window, id: &str) -> String {
    format!("surface-{}-{id}", window.label())
}

/// Fits a logical coordinate rectangle inward to the display pixel grid.
///
/// A view placed at fractional logical coordinates is rounded when it is drawn. Rounding outward covers more than the
/// area that the page declared, and the card border is one line inside that area, so the view would hide the border.
/// Fitting inward leaves at most 1 device pixel of the card background at each edge, and the card background was at
/// that position originally. The Wails host also fits in the same direction with backingAlignedRect.
pub(crate) fn aligned(x: f64, y: f64, w: f64, h: f64, scale: f64) -> (f64, f64, f64, f64) {
    let step = 1.0 / scale;
    let left = (x * scale).ceil() / scale;
    let top = (y * scale).ceil() / scale;
    let right = ((x + w) * scale).floor() / scale;
    let bottom = ((y + h) * scale).floor() / scale;
    (
        left,
        top,
        (right - left).max(step),
        (bottom - top).max(step),
    )
}

/// Starts the press watch of the window once.
///
/// A press on a surface is received by the surface view and not by the page, so the window is watched and the surface
/// id is passed to the page.
fn watch_presses(window: &Window, views: &Views, watching: &Watching) -> Result<(), String> {
    if watching.0.lock().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let main = exposure::root_view_on_main(window)?;
    isolate_webview(&main, PageFocus::Allowed)?;
    let platform = platform::current()?;
    let named = views.0.clone();
    let data = window_data(window)?;
    let watched = watching.0.clone();
    let host = window.clone();
    let pointing = window.clone();
    with_native_owner(window, move |handle| {
        let mut started = watched.lock().map_err(|e| e.to_string())?;
        if started.is_some() {
            return Ok(());
        }
        let pressed = Box::new(move |chain: Vec<Handle>| {
            let Ok(map) = named.lock() else { return false };
            let Some(id) = chain.iter().find_map(|view| {
                surface_owner_id(&map, *view)
                    .map(str::to_owned)
                    .or_else(|| {
                        data.documents
                            .names()
                            .get(view)
                            .map(|(surface, _)| surface.clone())
                    })
            }) else {
                return false;
            };
            if let Err(error) = emit_window(&host, "surface-pressed", id.clone()) {
                log_error("surface-pressed", error);
            }
            true
        });
        let pointed = Box::new(move |phase, x, y| {
            if let Err(error) = emit_window(&pointing, "surface-input", InputStep { phase, x, y }) {
                log_error("surface-input", error);
            }
        });
        *started = Some(platform.watch_input(handle, pressed, pointed)?);
        Ok(())
    })
    .map_err(|e| e.to_string())
}

/// Registers a webview in the native pointer routing.
///
/// Commands run outside the AppKit thread. Before it announces that an overlapping webview is usable, it returns a
/// registration failure to the caller.
pub(crate) fn isolate_webview(view: &Webview, page_focus: PageFocus) -> Result<(), String> {
    let platform = platform::current()?;
    let (tx, rx) = mpsc::channel();
    view.with_webview(move |webview| {
        let isolated = platform
            .register_input(&webview)
            .and_then(|registered| match page_focus {
                PageFocus::Allowed => Ok(registered),
                PageFocus::Ignored => Ok(registered && platform.ignore_page_focus(&webview)?),
            });
        match tx.send(isolated) {
            Ok(()) => {}
            // A failure after the request ended was not reported by that request, so it is left as an error line.
            Err(mpsc::SendError(Err(error))) => log_error("surface focus", error),
            Err(mpsc::SendError(Ok(_))) => crate::application_log::log_info(
                "surface",
                "surface focus result arrived after its request ended",
            ),
        }
    })
    .map_err(|e| e.to_string())?;
    if rx.recv().map_err(|e| e.to_string())?? {
        Ok(())
    } else {
        Err("this WebKit cannot install native webview input isolation".into())
    }
}

/// Shows whether the window keyboard focus also moves when the page of a webview focuses an element. Only the main page
/// moves it. Surfaces and modals receive the focus only through a click of the user or through the host.
#[derive(Clone, Copy)]
pub(crate) enum PageFocus {
    Allowed,
    Ignored,
}

/// Checks the whole synchronization request before the placement starts and returns the window overlays. `held` and
/// `plugins` are the composition declarations and the plugins of the surfaces that the window has already received.
pub fn check_sync_request(
    request: &SyncRequest,
    held: &HashMap<String, SurfaceComposition>,
    plugins: &HashMap<String, String>,
) -> Result<Vec<platform::WindowOverlay>, String> {
    validate_titlebar_height(request.titlebar)?;
    let mut ids = HashSet::new();
    for surface in &request.surfaces {
        if surface.id.is_empty() || !ids.insert(surface.id.clone()) {
            return Err(format!("invalid or duplicate surface {:?}", surface.id));
        }
        validate_rect(
            &format!("surface {:?}", surface.id),
            surface.x,
            surface.y,
            surface.w,
            surface.h,
        )?;
        validate_composition(&surface.composition)
            .map_err(|e| format!("surface {:?}: {e}", surface.id))?;
        if surface.plugin.is_empty() {
            return Err(format!("surface {:?} requires its plugin", surface.id));
        }
        if held.get(&surface.id).is_some_and(|value| {
            value != &surface.composition || plugins.get(&surface.id) != Some(&surface.plugin)
        }) {
            return Err(format!(
                "surface {:?} changed its composition declaration",
                surface.id
            ));
        }
    }
    request
        .overlays
        .iter()
        .map(|overlay| {
            validate_rect("window overlay", overlay.x, overlay.y, overlay.w, overlay.h)?;
            Ok(platform::WindowOverlay {
                x: overlay.x,
                y: overlay.y,
                w: overlay.w,
                h: overlay.h,
                visible: overlay.visible,
            })
        })
        .collect()
}

/// Places the window covers, starts the surface placement transaction, then sets the window title bar and fits the
/// surfaces. The window covers are placed before the placement starts, so no placement has started when a cover is
/// rejected. If the title bar cannot be set, the surfaces are not fitted and the placement is canceled. If the surfaces
/// cannot be fitted, the previous title bar is restored with restore and then the placement is canceled. A cancel
/// commits the transaction, so without the restore the new title bar would be shown together with the previous rows.
/// steps reads the answer of titlebar and returns that answer together when it succeeds.
pub fn run_layout<C, T>(
    overlays: impl FnOnce() -> Result<(), String>,
    begin: impl FnOnce() -> Result<(), String>,
    titlebar: impl FnOnce() -> Result<C, String>,
    steps: impl FnOnce(&C) -> Result<T, String>,
    restore: impl FnOnce(C) -> Result<(), String>,
    cancel: impl FnOnce(),
) -> Result<(T, C), String> {
    overlays()?;
    begin()?;
    let change = match titlebar() {
        Ok(change) => change,
        Err(error) => {
            cancel();
            return Err(error);
        }
    };
    match steps(&change) {
        Ok(value) => Ok((value, change)),
        Err(error) => {
            let error = match restore(change) {
                Ok(()) => error,
                Err(restoring) => format!("{error}; restoring the title bar: {restoring}"),
            };
            cancel();
            Err(error)
        }
    }
}

/// Fits the child webviews of the window to the surfaces that the page declared, and prepares the surface placement
/// transaction.
pub(crate) fn sync(window: &Window, request: SyncRequest) -> Result<PreparedSurfaces, String> {
    let context = window_data(window)?;
    let views = &context.views;
    let watching = &context.watching;
    let running = &context.running;
    let surface_hosts = &context.surface_hosts;

    let overlays = check_sync_request(
        &request,
        &*context.compositions.lock().map_err(|e| e.to_string())?,
        &*context.surface_plugins.lock().map_err(|e| e.to_string())?,
    )?;

    if !request.settled {
        announce_run(window, running, true)?;
    }
    // The page committed, so the window is on the screen and the surfaces exist. The work to run after the app is drawn
    // starts here.
    if let Ok(mut first) = running.first.lock() {
        if !*first {
            *first = true;
            emit_window(window, "page-ready", ()).map_err(|e| e.to_string())?;
        }
    }
    watch_presses(window, views, watching)?;
    let scale_window = window.clone();
    let scale = exposure::on_main(window, move || {
        scale_window.scale_factor().map_err(|e| e.to_string())
    })?;
    let platform = platform::current()?;

    let main = exposure::root_view_on_main(window)?;
    let ticket = running.prepared.fetch_add(1, Ordering::Relaxed) + 1;
    let main_handle = {
        let (tx, rx) = mpsc::channel::<Result<Handle, String>>();
        main.with_webview(move |webview| {
            match tx.send(platform.view_id(&webview)) {
                Ok(()) => {}
                // A failure after the request ended was not reported by that request, so it is left as an error line.
                Err(mpsc::SendError(Err(error))) => log_error("main webview handle", error),
                Err(mpsc::SendError(Ok(_))) => crate::application_log::log_info(
                    "surface",
                    "main webview handle arrived after its request ended",
                ),
            }
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())??
    };
    let begin = || -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<bool>();
        with_native_owner(window, move |owner| {
            platform.begin_layout(
                owner,
                ticket,
                Box::new(move |allowed| {
                    if tx.send(allowed).is_err() {
                        crate::application_log::log_info(
                            "surface",
                            "surface preparation result arrived after its request ended",
                        );
                    }
                }),
            )
        })
        .map_err(|e| e.to_string())?;
        if !rx.recv().map_err(|e| e.to_string())? {
            return Err("window closed before layout".into());
        }
        Ok(())
    };
    let place_overlays = || {
        exposure::on_main(window, move || {
            platform.set_window_overlays(main_handle, &overlays)
        })
    };
    let titlebar = request.titlebar;
    let set_titlebar = || {
        with_native_owner(window, move |owner| titlebar_chrome(owner, titlebar))
            .map_err(|e| e.to_string())
    };
    let restore = |change: TitlebarChange| {
        with_native_owner(window, move |owner| {
            restore_titlebar(owner, change.previous)
        })
        .map_err(|e| e.to_string())
    };
    let steps = |change: &TitlebarChange| -> Result<PreparedSurfaces, String> {
        for s in &request.surfaces {
            context
                .compositions
                .lock()
                .map_err(|e| e.to_string())?
                .insert(s.id.clone(), s.composition.clone());
            context
                .surface_plugins
                .lock()
                .map_err(|e| e.to_string())?
                .insert(s.id.clone(), s.plugin.clone());
            // A webview of size 0 is not visible and some platforms reject it, so it is handled as a hidden surface.
            let visible = s.visible && s.w >= 1.0 && s.h >= 1.0;
            context.images.set_surface_visible(&s.id, visible);
            let (ax, ay, aw, ah) = aligned(s.x, s.y, s.w.max(1.0), s.h.max(1.0), scale);
            let solid = if s.dim { 0.45 } else { 1.0 };
            let existing = surface_hosts
                .lock()
                .map_err(|e| e.to_string())?
                .get(&s.id)
                .copied();
            let handle = if let Some(handle) = existing {
                handle
            } else {
                let handle = create_logical_surface_handle(
                    || exposure::on_main(window, move || platform.create_surface(main_handle)),
                    &s.id,
                )?;
                surface_hosts
                    .lock()
                    .map_err(|e| e.to_string())?
                    .insert(s.id.clone(), handle);
                if let Ok(mut map) = views.0.lock() {
                    map.insert(handle, s.id.clone());
                }
                crate::performance::surface("created", &s.id, None);
                handle
            };
            exposure::on_main(window, move || {
                // In the preparation step the DOM may not be presented yet. The surface always stays hidden until the
                // same ticket is settled in present.
                platform.set_surface_hidden_handle(handle, true)?;
                platform.set_surface_alpha_handle(handle, solid)?;
                if visible {
                    platform.place_surface(handle, ax, ay, aw, ah)?;
                }
                Ok(())
            })?;
        }

        // Only the page writes the surface list, so a surface that is not in the list is a removed surface.
        let alive: HashSet<String> = request.surfaces.iter().map(|s| s.id.clone()).collect();
        let removed: Vec<(String, Handle)> = surface_hosts
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .filter(|(id, _)| !alive.contains(*id))
            .map(|(id, handle)| (id.clone(), *handle))
            .collect();
        let removed_ids: HashSet<String> = removed.iter().map(|(id, _)| id.clone()).collect();
        for (id, handle) in removed {
            // The trigger of the surface lifecycle (V5-104): a surface that disappeared from the list is destroyed at
            // this point.
            crate::performance::surface("destroyed", &id, None);
            if let Ok(mut named) = views.0.lock() {
                named.remove(&handle);
            }
            documents::close_surface(window, &id);
            images::close_surface(window, &id);
            context.images.end_generation(&id);
            exposure::on_main(window, move || platform.close_surface(handle))?;
            surface_hosts.lock().map_err(|e| e.to_string())?.remove(&id);
            context
                .compositions
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&id);
            context
                .surface_plugins
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&id);
            context
                .composition_revisions
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&id);
            exposure::surface_closed(window, &id);
        }
        // Only removed surfaces are announced to the sidecars. A sidecar session that is not a surface (the session of
        // a plugin state module) is not in the surface list, so closing it because it is not in the list would lose the
        // root and the watch of that session.
        window
            .state::<WindowSidecars>()
            .retain(window, &|id: &str| !removed_ids.contains(id))?;

        // Returns the actual position of each surface. The host fits the rectangles that the page declared to display
        // pixels, so the difference between the two values is reported to the page.
        let mut placed = Vec::with_capacity(request.surfaces.len());
        for s in &request.surfaces {
            let Some(handle) = surface_hosts
                .lock()
                .map_err(|e| e.to_string())?
                .get(&s.id)
                .copied()
            else {
                continue;
            };
            let visible = s.visible && s.w >= 1.0 && s.h >= 1.0;
            placed.push(surface_handle_placement(window, handle, &s.id, visible)?);
        }
        // Before it waits for the DOM presentation, it starts the image preparation of the size that was applied.
        Ok(PreparedSurfaces {
            ticket,
            placements: placed,
            chrome: change.chrome.clone(),
        })
    };
    let cancel = || {
        let target = window.clone();
        if let Err(error) = platform.enqueue_ui(Box::new(move || {
            log_failure("surface layout cancel", cancel_window_layout(&target));
        })) {
            log_error("surface layout cancel", error);
        }
    };
    let (prepared, change) =
        run_layout(place_overlays, begin, set_titlebar, steps, restore, cancel)?;
    // Even if the image raster update fails after the placement was fitted, no started placement remains. A cancel
    // commits the transaction, so the title bar is restored first.
    if let Err(error) = crate::composition::refresh_image_rasters(window) {
        log_failure("surface layout title bar restore", restore(change));
        cancel();
        return Err(error);
    }
    Ok(prepared)
}

/// Returns the current position of the surface webview in page coordinates.
fn surface_handle_placement(
    window: &Window,
    handle: Handle,
    id: &str,
    visible: bool,
) -> Result<Placement, String> {
    let platform = platform::current()?;
    let [x, y, w, h] = exposure::on_main(window, move || platform.surface_frame(handle))?;
    crate::performance::surface("placed", id, Some(([x, y, w, h], visible)));
    Ok(Placement {
        id: id.into(),
        x,
        y,
        w,
        h,
        visible,
    })
}

/// Checks the presentation mark of the preparation that the DOM drew. It does not block later preparations or the
/// AppKit event loop.
pub(crate) async fn present(
    window: Window,
    request: PresentRequest,
) -> Result<Vec<Placement>, String> {
    let main = exposure::root_view_on_main(&window)?;
    let ticket = request.ticket;
    let finished = window.clone();
    let context = window_data(&window)?;
    let images = context.images.clone();
    let presentation_window = finished.clone();
    let placements = request.placements;
    let presentation_settled = request.settled;
    let wait_for_presentation = presentation_settled || request.wait_for_presentation;
    // During a continuous divider gesture, the native surface frame and the DOM are committed at every display cycle.
    // Waiting for the application presentation at every frame would serialize the next transaction behind the WebKit
    // refresh, so the DOM barrier keeps only the settled frames. The raster barrier is kept for every frame. Even a
    // continuous placement does not commit the new region size together with the previous raster
    // (docs/spec/surface-composition.md).
    let dom = if wait_for_presentation {
        let (dom_tx, dom_rx) = mpsc::channel();
        main.with_webview(move |view| {
            let outcome = platform::current().and_then(|platform| {
                let ready = dom_tx.clone();
                platform.after_presentation(
                    &view,
                    Box::new(move || {
                        if ready.send(Ok(())).is_err() {
                            crate::application_log::log_info(
                                "surface",
                                "surface readiness arrived after its request ended",
                            );
                        }
                    }),
                )
            });
            if let Err(error) = outcome {
                // A failure after the request ended was not reported by that request, so it is left as an error line.
                if let Err(mpsc::SendError(Err(error))) = dom_tx.send(Err(error)) {
                    log_error("DOM presentation", error);
                }
            }
        })
        .map_err(|error| error.to_string())?;
        Some(dom_rx)
    } else {
        None
    };
    let raster_window = window.clone();
    let ready = Some(
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            if let Some(dom_rx) = dom {
                dom_rx
                    .recv_timeout(exposure::TIMEOUT)
                    .map_err(|error| format!("application documents did not present: {error}"))??;
            }
            crate::composition::refresh_image_rasters(&raster_window)?;
            images.wait_current(exposure::TIMEOUT).map_err(|reason| {
                if reason == "presentationTimeout" {
                    format!(
                        "the current image raster did not present within {:?}; pending {}",
                        exposure::TIMEOUT,
                        images.pending_rasters()
                    )
                } else {
                    format!("the current image raster failed to present: {reason}")
                }
            })?;
            Ok(())
        })
        .await
        .map_err(|error| error.to_string())?,
    );
    if let Some(Err(error)) = ready {
        // A presentation failure occurs after sync opened the native transaction. The transaction is released before
        // returning so that the next split does not wait forever behind the failed owner.
        let target = window.clone();
        let cancel_error = platform::current()?.enqueue_ui(Box::new(move || {
            log_failure("surface layout cancel", cancel_window_layout(&target));
        }));
        if let Err(cancel) = cancel_error {
            return Err(format!("{error}; cancelling layout: {cancel}"));
        }
        return Err(error);
    }
    let (ui_tx, mut ui_rx) = tauri::async_runtime::channel(1);
    // A commit can call an AppKit redraw, so it runs outside the Tao event lock.
    platform::current()?.enqueue_ui(Box::new(move || {
        let result = (|| -> Result<Vec<Placement>, String> {
            let platform = platform::current()?;
            let prepared = ready
                .as_ref()
                .map_or(Ok(()), |result| result.clone())
                .and_then(|_| {
                    placements
                        .iter()
                        .map(|p| {
                            let handle = context
                                .surface_hosts
                                .lock()
                                .map_err(|e| e.to_string())?
                                .get(&p.id)
                                .copied()
                                .ok_or_else(|| {
                                    format!("surface {:?} closed before presentation", p.id)
                                })?;
                            platform.set_surface_hidden_handle(handle, !p.visible)?;
                            let [x, y, w, h] = platform.surface_frame(handle)?;
                            Ok(Placement {
                                id: p.id.clone(),
                                x,
                                y,
                                w,
                                h,
                                visible: p.visible,
                            })
                        })
                        .collect::<Result<Vec<_>, String>>()
                });
            let placed = match prepared {
                Ok(placed) => placed,
                Err(error) => {
                    cancel_window_layout(&presentation_window)
                        .map_err(|cancel| format!("{error}; cancelling layout: {cancel}"))?;
                    return Err(error);
                }
            };
            let committed = with_native_owner(&presentation_window, move |owner| {
                platform.commit_layout(owner, ticket)
            })
            .map_err(|e| e.to_string())?;
            if !committed {
                return Err(format!("surface preparation {ticket} is no longer current"));
            }
            // The preparation update and the end decision run in order on the same UI thread.
            if committed
                && presentation_settled
                && context.running.prepared.load(Ordering::Relaxed) == ticket
            {
                announce_run(&presentation_window, &context.running, false)?;
            }
            exposure::window_changed(&presentation_window);
            Ok(placed)
        })();
        if let Err(failure) = ui_tx.try_send(result) {
            // Only the receiving side can close the channel, so if it is not closed now, the channel was full when the
            // result was sent. The channel receives only this one result, so a full channel is a failure that discarded
            // the result.
            let closed = ui_tx.is_closed();
            match (closed, failure.into_inner()) {
                (false, _) => log_error(
                    "surface placement",
                    "the result channel is full and the result was dropped",
                ),
                // A failure after the request ended was not reported by that request, so it is left as an error line.
                (true, Err(error)) => log_error("surface placement", error),
                (true, Ok(_)) => crate::application_log::log_info(
                    "surface",
                    "surface placement result arrived after its request ended",
                ),
            }
        }
    }))?;
    ui_rx
        .recv()
        .await
        .ok_or("the main webview closed before presenting")?
}

/// Raises run-began and run-ended. The page reports whether a later update follows, and this function raises an event
/// only when that value changes.
fn announce_run(window: &Window, running: &Running, going: bool) -> Result<(), String> {
    {
        let mut held = running.going.lock().map_err(|e| e.to_string())?;
        if *held == going {
            return Ok(());
        }
        *held = going;
        if !going {
            for done in running.settled.lock().map_err(|e| e.to_string())?.drain(..) {
                if done.send(()).is_err() {
                    crate::application_log::log_info(
                        "surface",
                        "surface settled notification arrived after its request ended",
                    );
                }
            }
        }
    }
    let name = if going { "run-began" } else { "run-ended" };
    emit_window(window, name, ()).map_err(|e| e.to_string())
}

/// Creates the native handle of a logical surface. A failure and a 0 handle are an error that holds the surface id.
pub fn create_logical_surface_handle(
    create: impl FnOnce() -> Result<crate::platform::Handle, String>,
    id: &str,
) -> Result<crate::platform::Handle, String> {
    let handle = create().map_err(|error| format!("surface {id}: create: {error}"))?;
    if handle == 0 {
        return Err(format!("surface {id}: create returned a nil handle"));
    }
    Ok(handle)
}

/// The native objects that are closed when the window closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowNative {
    Document(Handle),
    Image(Handle),
    Surface(Handle),
}

/// For each logical surface of a closing window, closes the document regions and the image regions and then closes the
/// surface. Surfaces are closed in id order.
///
/// A logical surface holds a main webview and a document region has its own web content process, so a surface and a
/// region that are not closed leave the webview and its web content process behind even after the window closed. If one
/// object cannot be closed, the others are still closed and all failures are returned. close closes one native object
/// and is called on the main thread.
pub fn close_window_surfaces(
    surfaces: HashMap<String, Handle>,
    documents: &documents::Documents,
    images: &images::Images,
    close: &mut dyn FnMut(WindowNative) -> Result<(), String>,
) -> Result<(), String> {
    let mut surfaces: Vec<_> = surfaces.into_iter().collect();
    surfaces.sort();
    let mut failures = Vec::new();
    for (surface, handle) in surfaces {
        let natives = documents
            .remove_surface(&surface)
            .into_iter()
            .map(WindowNative::Document)
            .chain(
                images
                    .remove_surface(&surface)
                    .into_iter()
                    .map(WindowNative::Image),
            )
            .chain(std::iter::once(WindowNative::Surface(handle)));
        for native in natives {
            if let Err(error) = close(native) {
                let kind = match native {
                    WindowNative::Document(_) => "document region",
                    WindowNative::Image(_) => "image region",
                    WindowNative::Surface(_) => "surface",
                };
                failures.push(format!("surface {surface:?}: closing the {kind}: {error}"));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}
