//! 표면 동기화, 표시 확인, 배치, 표면 입력 전달.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Manager, Webview, Window};

use crate::documents;
use crate::exposure;
use crate::images;
use crate::log_error;
use crate::platform::{self, Handle};
use crate::sidecars::WindowSidecars;
use crate::windows::{emit_window, native_owner_on_main, window_data};

/// 표면 웹뷰가 문서보다 먼저 실행하는 스크립트.
pub(crate) struct Background;

/// 페이지가 선언한 표면 하나. 좌표는 페이지 뷰포트 기준 CSS 픽셀이다.
#[derive(Debug, Deserialize)]
pub(crate) struct Surface {
    id: String,
    /// 이 애플리케이션이 서비스하는 표면 페이지의 경로.
    #[serde(rename = "module")]
    _module: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
    /// 페이지가 이 표면을 흐리게 표시하도록 요청했는지 나타낸다.
    dim: bool,
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

/// surface가 첫 frame을 배치하기 전에 불변 composition contract를 등록한다.
pub(crate) fn declare(webview: &Webview, request: CompositionDeclareRequest) -> Result<(), String> {
    if request.surface.is_empty() {
        return Err("composition declaration requires a surface".into());
    }
    validate_composition(&request.composition)?;
    let data = window_data(&webview.window())?;
    let mut all = data.compositions.lock().map_err(|e| e.to_string())?;
    if let Some(previous) = all.get(&request.surface) {
        if previous != &request.composition {
            return Err(format!(
                "surface {:?} changed its composition declaration",
                request.surface
            ));
        }
        return Ok(());
    }
    all.insert(request.surface, request.composition);
    Ok(())
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

/// press를 받은 native view에 해당하는 logical surface를 찾는다.
/// 알 수 없는 view는 workbench card를 활성화하지 않는다.
pub fn surface_owner_id(named: &HashMap<Handle, String>, view: Handle) -> Option<&str> {
    named
        .get(&view)
        .filter(|id| !id.is_empty())
        .map(String::as_str)
}

/// 직접 주입한 누름의 좌표가 표면 또는 그 문서에 있는 경우 페이지에 표면 누름을 전달한다.
/// 직접 주입은 AppKit 로컬 이벤트 감시기를 거치지 않으므로 감시기와 별도로 호출한다.
pub(crate) fn press_at(window: &Window, x: f64, y: f64) -> Result<(), String> {
    let data = window_data(window)?;
    let handle = native_owner_on_main(window)?;
    let hit = platform::current()?.hit(handle, x, y)?;
    let named = data.views.0.lock().map_err(|e| e.to_string())?;
    let documents = data.documents.names();
    let id = hit.chain.iter().find_map(|view| {
        surface_owner_id(&named, *view)
            .map(str::to_owned)
            .or_else(|| documents.get(view).map(|(surface, _)| surface.clone()))
    });
    if let Some(id) = id {
        emit_window(window, "surface-pressed", id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SyncRequest {
    /// 연속적인 배치 갱신이 종료되었는지 나타낸다.
    settled: bool,
    #[serde(default)]
    overlays: Vec<WindowOverlayRequest>,
    surfaces: Vec<Surface>,
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

/// 페이지 좌표의 사각형.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 표면 하나가 실제로 놓인 위치. 페이지 좌표이다.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Placement {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
}

#[derive(Serialize)]
pub(crate) struct PreparedSurfaces {
    ticket: u64,
    placements: Vec<Placement>,
}

#[derive(Deserialize)]
pub(crate) struct PresentRequest {
    ticket: u64,
    placements: Vec<Placement>,
    settled: bool,
    #[serde(default, rename = "waitForPresentation")]
    wait_for_presentation: bool,
}

/// 드래그의 한 단계. phase 는 누름 0, 이동 1, 놓음 2 이다.
#[derive(Clone, Serialize)]
struct InputStep {
    phase: u8,
    x: f64,
    y: f64,
}

/// 각 표면이 그리는 뷰. 누름을 받은 뷰를 표면과 대응시킨다.
#[derive(Default)]
pub(crate) struct Views(pub Arc<Mutex<HashMap<Handle, String>>>);

/// 창의 입력 감시기. 감시를 시작하지 않았으면 None 이다.
#[derive(Default)]
pub(crate) struct Watching(pub Arc<Mutex<Option<Handle>>>);

/// 연속 크기 변경 중인 표면. 표면은 프레임마다가 아니라 연속 변경의 시작과 끝을 받는다.
/// 연속 갱신이 진행 중인지와 페이지가 커밋했는지 나타낸다.
///
/// 페이지는 커밋마다 두 값을 보고한다. run-began, run-ended, page-ready 는 프레임마다가 아니라
/// 이 상태가 바뀔 때만 발생한다.
#[derive(Default)]
pub(crate) struct Running {
    pub prepared: AtomicU64,
    going: Mutex<bool>,
    first: Mutex<bool>,
    settled: Mutex<Vec<std::sync::mpsc::Sender<()>>>,
}

/// 연속 갱신이 끝나면 값을 받는 수신자를 반환한다. 진행 중인 갱신이 없으면 이미 값이 있다.
/// 진단 메서드 diagnostics.drag 만 사용한다.
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

/// 논리 좌표 사각형을 디스플레이 픽셀 격자의 안쪽으로 맞춘다.
///
/// 소수 논리 좌표에 놓인 뷰는 그릴 때 반올림된다. 바깥쪽으로 반올림하면 페이지가 선언한
/// 영역보다 넓게 덮고, 카드 테두리는 그 영역 안쪽 한 줄에 있으므로 뷰가 테두리를 가린다.
/// 안쪽으로 맞추면 각 가장자리에 최대 1 장치 픽셀의 카드 배경이 남고, 그 위치에는 원래 카드
/// 배경이 있다. Wails 호스트도 backingAlignedRect 로 같은 방향으로 맞춘다.
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

/// 창의 누름 감시를 한 번 시작한다.
///
/// 표면에 대한 누름은 표면 뷰가 받고 페이지는 받지 못하므로, 창을 감시하고 표면 id 를
/// 페이지에 전달한다.
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
    let handle = native_owner_on_main(window)?;
    let (tx, rx) = mpsc::channel();
    window
        .run_on_main_thread(move || {
            let result = (move || -> Result<(), String> {
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
                        eprintln!("surface-pressed event failed: {error}");
                    }
                    true
                });
                let pointed = Box::new(move |phase, x, y| {
                    if let Err(error) =
                        emit_window(&pointing, "surface-input", InputStep { phase, x, y })
                    {
                        eprintln!("surface-input event failed: {error}");
                    }
                });
                *started = Some(platform.watch_input(handle, pressed, pointed)?);
                Ok(())
            })();
            if tx.send(result).is_err() {
                eprintln!("surface input setup had no pending receiver");
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())??;
    Ok(())
}

/// 웹뷰를 네이티브 포인터 라우팅에 등록한다.
///
/// 명령은 AppKit 스레드 밖에서 실행된다. 겹치는 웹뷰를 사용 가능하다고 알리기 전에 등록
/// 실패를 호출자에게 반환한다.
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
        if tx.send(isolated).is_err() {
            eprintln!("surface focus result had no pending receiver");
        }
    })
    .map_err(|e| e.to_string())?;
    if rx.recv().map_err(|e| e.to_string())?? {
        Ok(())
    } else {
        Err("this WebKit cannot install native webview input isolation".into())
    }
}

/// 웹뷰의 페이지가 요소에 초점을 줄 때 창의 키보드 초점도 옮기는지 나타낸다. 메인 페이지만 옮긴다.
/// 표면과 모달은 사용자의 클릭이나 호스트를 통해서만 초점을 받는다.
#[derive(Clone, Copy)]
pub(crate) enum PageFocus {
    Allowed,
    Ignored,
}

/// 배치를 시작하기 전에 동기화 요청 전체를 검사하고 창 오버레이를 반환한다. `held` 는
/// 창이 이미 받은 표면의 composition 선언이다.
pub fn check_sync_request(
    request: &SyncRequest,
    held: &HashMap<String, SurfaceComposition>,
) -> Result<Vec<platform::WindowOverlay>, String> {
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
        if held
            .get(&surface.id)
            .is_some_and(|value| value != &surface.composition)
        {
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

/// 창 덮개를 놓고 표면 배치 트랜잭션을 시작한 뒤 표면을 맞춘다. 창 덮개는 배치를 시작하기 전에 놓으므로 덮개가
/// 거부되면 시작한 배치가 없고, 표면을 맞추다 실패하면 시작한 배치를 취소한다.
pub fn run_layout<T>(
    overlays: impl FnOnce() -> Result<(), String>,
    begin: impl FnOnce() -> Result<(), String>,
    steps: impl FnOnce() -> Result<T, String>,
    cancel: impl FnOnce(),
) -> Result<T, String> {
    overlays()?;
    begin()?;
    let result = steps();
    if result.is_err() {
        cancel();
    }
    result
}

/// 페이지가 선언한 표면에 창의 자식 웹뷰를 맞추고 표면 배치 트랜잭션을 준비한다.
pub(crate) fn sync(window: &Window, request: SyncRequest) -> Result<PreparedSurfaces, String> {
    let context = window_data(window)?;
    let views = &context.views;
    let watching = &context.watching;
    let running = &context.running;
    let surface_hosts = &context.surface_hosts;

    let overlays = check_sync_request(
        &request,
        &*context.compositions.lock().map_err(|e| e.to_string())?,
    )?;

    if !request.settled {
        announce_run(window, running, true)?;
    }
    // 페이지가 커밋했으므로 창이 화면에 있고 표면이 존재한다. 앱이 그려진 뒤 실행할 작업은
    // 여기서 시작한다.
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
    let owner = native_owner_on_main(window)?;
    let main_handle = {
        let (tx, rx) = mpsc::channel::<Result<Handle, String>>();
        main.with_webview(move |webview| {
            if tx.send(platform.view_id(&webview)).is_err() {
                eprintln!("main webview handle had no pending receiver");
            }
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())??
    };
    let begin = || -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<bool>();
        exposure::on_main(window, move || {
            platform.begin_layout(
                owner,
                ticket,
                Box::new(move |allowed| {
                    if tx.send(allowed).is_err() {
                        eprintln!("surface preparation result had no pending receiver");
                    }
                }),
            )
        })?;
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
    let steps = || -> Result<PreparedSurfaces, String> {
        for s in &request.surfaces {
            context
                .compositions
                .lock()
                .map_err(|e| e.to_string())?
                .insert(s.id.clone(), s.composition.clone());
            // 크기가 0 인 웹뷰는 보이지 않고 일부 플랫폼은 거부하므로 숨긴 표면으로 처리한다.
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
                handle
            };
            exposure::on_main(window, move || {
                // 준비 단계에서는 DOM이 아직 표시되지 않았을 수 있다. 표면은
                // present에서 같은 티켓이 확정될 때까지 항상 숨긴다.
                platform.set_surface_hidden_handle(handle, true)?;
                platform.set_surface_alpha_handle(handle, solid)?;
                if visible {
                    platform.place_surface(handle, ax, ay, aw, ah)?;
                }
                Ok(())
            })?;
        }

        // 표면 목록은 페이지만 작성하므로 목록에 없는 표면은 제거된 표면이다.
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
            // 표면 생명주기의 계기(V5-104): 목록에서 사라진 표면은 이 자리에서 파괴된다.
            {
                let directory = window
                    .state::<crate::workspace::Workspace>()
                    .directory()
                    .to_path_buf();
                crate::performance::observe(
                    &directory,
                    "host",
                    || serde_json::json!({"event": "surface", "phase": "destroyed", "surface": id}),
                );
            }
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
                .composition_revisions
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&id);
            exposure::surface_closed(window, &id);
        }
        // 제거된 표면만 사이드카에 알린다. 표면이 아닌 사이드카 세션(플러그인 상태 모듈의 세션)은 표면 목록에 없으므로,
        // 목록에 없다는 이유로 닫으면 그 세션의 root 와 감시가 사라진다.
        window
            .state::<WindowSidecars>()
            .retain(window, &|id: &str| !removed_ids.contains(id))?;

        // 각 표면의 실제 위치를 반환한다. 호스트는 페이지가 선언한 사각형을 디스플레이 픽셀에
        // 맞추므로 두 값의 차이를 페이지에 알린다.
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
        // DOM 표시를 기다리기 전에 적용한 크기의 이미지 준비를 시작한다.
        Ok(PreparedSurfaces {
            ticket,
            placements: placed,
        })
    };
    let cancel = || {
        if let Err(error) = platform.enqueue_ui(Box::new(move || {
            log_error(platform.cancel_layout(owner));
        })) {
            log_error(Err(error));
        }
    };
    let prepared = run_layout(place_overlays, begin, steps, cancel)?;
    // 배치를 맞춘 뒤 이미지 raster 갱신이 실패해도 시작한 배치를 남기지 않는다.
    if let Err(error) = crate::composition::refresh_image_rasters(window) {
        cancel();
        return Err(error);
    }
    Ok(prepared)
}

/// 표면 웹뷰의 현재 위치를 페이지 좌표로 반환한다.
fn surface_handle_placement(
    window: &Window,
    handle: Handle,
    id: &str,
    visible: bool,
) -> Result<Placement, String> {
    let platform = platform::current()?;
    let [x, y, w, h] = exposure::on_main(window, move || platform.surface_frame(handle))?;
    Ok(Placement {
        id: id.into(),
        x,
        y,
        w,
        h,
        visible,
    })
}

/// DOM 이 그린 준비의 표시를 확인한다. 이후 준비와 AppKit 이벤트 루프를 막지 않는다.
pub(crate) async fn present(
    window: Window,
    request: PresentRequest,
) -> Result<Vec<Placement>, String> {
    let main = exposure::root_view_on_main(&window)?;
    let ticket = request.ticket;
    let finished = window.clone();
    let context = window_data(&window)?;
    let owner = native_owner_on_main(&window)?;
    let images = context.images.clone();
    let presentation_window = finished.clone();
    let placements = request.placements;
    let presentation_settled = request.settled;
    let wait_for_presentation = presentation_settled || request.wait_for_presentation;
    // 연속 divider gesture 동안 native surface frame과 DOM은
    // display cycle마다 commit된다. frame마다 application presentation을 기다리면
    // 다음 transaction이 WebKit refresh 뒤로 직렬화된다.
    // 정착된 frame은 DOM 및 raster barrier를 유지한다.
    let ready = if wait_for_presentation {
        let (dom_tx, dom_rx) = mpsc::channel();
        main.with_webview(move |view| {
            let outcome = platform::current().and_then(|platform| {
                let ready = dom_tx.clone();
                platform.after_presentation(
                    &view,
                    Box::new(move || {
                        if ready.send(Ok(())).is_err() {
                            eprintln!("surface readiness had no pending receiver");
                        }
                    }),
                )
            });
            if let Err(error) = outcome {
                if dom_tx.send(Err(error)).is_err() {
                    eprintln!("DOM presentation failure had no pending receiver");
                }
            }
        })
        .map_err(|error| error.to_string())?;
        let raster_window = window.clone();
        Some(
            tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
                dom_rx
                    .recv_timeout(exposure::TIMEOUT)
                    .map_err(|error| format!("application documents did not present: {error}"))??;
                if presentation_settled {
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
                }
                Ok(())
            })
            .await
            .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    if let Some(Err(error)) = ready {
        // presentation 실패는 sync가 native transaction을 연 뒤에 발생한다.
        // 반환하기 전에 그 transaction을 해제하여
        // 다음 split이 실패한 owner 뒤에서 무한히 기다리지 않게 한다.
        let cancel_error = platform::current()?.enqueue_ui(Box::new(move || {
            if let Err(cancel) = platform::current().and_then(|p| p.cancel_layout(owner)) {
                eprintln!("surface presentation failure could not cancel layout: {cancel}");
            }
        }));
        if let Err(cancel) = cancel_error {
            return Err(format!("{error}; cancelling layout: {cancel}"));
        }
        return Err(error);
    }
    let (ui_tx, mut ui_rx) = tauri::async_runtime::channel(1);
    // 커밋은 AppKit 다시 그리기를 호출할 수 있으므로 Tao 이벤트 잠금 밖에서 실행한다.
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
                    platform
                        .cancel_layout(owner)
                        .map_err(|cancel| format!("{error}; cancelling layout: {cancel}"))?;
                    return Err(error);
                }
            };
            let committed = platform.commit_layout(owner, ticket)?;
            if !committed {
                return Err(format!("surface preparation {ticket} is no longer current"));
            }
            // 준비 갱신과 종료 판정을 같은 UI 스레드에서 순서대로 실행한다.
            if committed
                && presentation_settled
                && context.running.prepared.load(Ordering::Relaxed) == ticket
            {
                announce_run(&presentation_window, &context.running, false)?;
            }
            exposure::window_changed(&presentation_window);
            Ok(placed)
        })();
        if let Err(error) = ui_tx.try_send(result) {
            eprintln!("surface placement result had no pending receiver: {error}");
        }
    }))?;
    ui_rx
        .recv()
        .await
        .ok_or("the main webview closed before presenting")?
}

/// run-began 과 run-ended 를 발생시킨다. 페이지는 후속 갱신이 있는지 보고하고, 이 함수는 그
/// 값이 바뀔 때만 이벤트를 발생시킨다.
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
                    eprintln!("surface settled notification had no pending receiver");
                }
            }
        }
    }
    let name = if going { "run-began" } else { "run-ended" };
    emit_window(window, name, ()).map_err(|e| e.to_string())
}

/// 논리 표면의 네이티브 핸들을 만든다. 실패와 0 핸들은 표면 id 를 담은 오류다.
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

/// 창이 닫힐 때 닫는 네이티브 객체.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowNative {
    Document(Handle),
    Image(Handle),
    Surface(Handle),
}

/// 닫히는 창의 논리 표면마다 문서 영역과 그림 영역을 닫은 뒤 표면을 닫는다. 표면은 id 순서로 닫는다.
///
/// 논리 표면은 메인 웹뷰를 보유하고 문서 영역은 자기 웹 콘텐츠 프로세스를 가지므로, 닫지 않은 표면과 영역은 창이
/// 닫힌 뒤에도 웹뷰와 그 웹 콘텐츠 프로세스를 남긴다. 한 객체를 닫지 못해도 나머지를 닫고 모든 실패를 반환한다.
/// close 는 네이티브 객체 하나를 닫으며 메인 스레드에서 호출된다.
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
