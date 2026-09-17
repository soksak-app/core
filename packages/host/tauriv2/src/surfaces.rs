//! 표면 동기화, 표시 확인, 배치, 표면 입력 전달.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{LogicalPosition, LogicalSize, Manager, Runtime, Webview, WebviewBuilder, WebviewUrl, Window};

use crate::exposure;
use crate::log_error;
use crate::platform::{self, Handle};
use crate::sidecars::WindowSidecars;
use crate::windows::{emit_window, native_owner, root_view, window_data};

/// 표면 웹뷰가 문서보다 먼저 실행하는 스크립트.
pub(crate) struct Background(pub &'static str);

/// 페이지가 선언한 표면 하나. 좌표는 페이지 뷰포트 기준 CSS 픽셀이다.
#[derive(Debug, Deserialize)]
pub(crate) struct Surface {
    id: String,
    /// 표면이 표시할 주소.
    url: String,
    /// 주소가 이 앱 밖에 있는지 나타낸다. 이 앱의 주소는 프론트엔드 경로이다. 종류를 여기에
    /// 적으면 페이지가 플러그인을 추가할 때마다 이 파일을 수정해야 한다.
    external: bool,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
    /// 페이지가 이 표면을 흐리게 표시하도록 요청했는지 나타낸다.
    dim: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SyncRequest {
    /// 연속적인 배치 갱신이 종료되었는지 나타낸다.
    settled: bool,
    surfaces: Vec<Surface>,
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
#[derive(Default)]
pub(crate) struct Resizing(pub Mutex<HashSet<String>>);

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
        let _ = tx.send(());
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
    (left, top, (right - left).max(step), (bottom - top).max(step))
}

/// 창의 누름 감시를 한 번 시작한다.
///
/// 표면에 대한 누름은 표면 뷰가 받고 페이지는 받지 못하므로, 창을 감시하고 표면 id 를
/// 페이지에 전달한다.
fn watch_presses(window: &Window, views: &Views, watching: &Watching) -> Result<(), String> {
    if watching.0.lock().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let main = root_view(window).ok_or("the main webview is gone")?;
    isolate_webview(&main)?;
    let platform = platform::current()?;
    let named = views.0.clone();
    let watched = watching.0.clone();
    let host = window.clone();
    let pointing = window.clone();
    let handle = native_owner(window)?;
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
                    let Some(id) = chain.iter().find_map(|view| map.get(view)) else { return false };
                    let _ = emit_window(&host, "surface-pressed", id.clone());
                    true
                });
                let pointed = Box::new(move |phase, x, y| {
                    let _ = emit_window(&pointing, "surface-input", InputStep { phase, x, y });
                });
                *started = Some(platform.watch_input(handle, pressed, pointed)?);
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())??;
    Ok(())
}

/// 웹뷰를 네이티브 포인터 라우팅에 등록한다.
///
/// 명령은 AppKit 스레드 밖에서 실행된다. 겹치는 웹뷰를 사용 가능하다고 알리기 전에 등록
/// 실패를 호출자에게 반환한다.
pub(crate) fn isolate_webview(view: &Webview) -> Result<(), String> {
    let platform = platform::current()?;
    let (tx, rx) = mpsc::channel();
    view.with_webview(move |webview| {
        let _ = tx.send(platform.register_input(&webview));
    })
    .map_err(|e| e.to_string())?;
    if rx.recv().map_err(|e| e.to_string())?? {
        Ok(())
    } else {
        Err("this WebKit cannot install native webview input isolation".into())
    }
}

/// 페이지가 선언한 표면에 창의 자식 웹뷰를 맞추고 표면 배치 트랜잭션을 준비한다.
pub(crate) fn sync(window: &Window, request: SyncRequest) -> Result<PreparedSurfaces, String> {
    let context = window_data(window)?;
    let overlay = &context.overlay;
    let views = &context.views;
    let watching = &context.watching;
    let resizing = &context.resizing;
    let running = &context.running;

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
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let background = window.state::<Background>().0;
    let platform = platform::current()?;

    let main = root_view(window).ok_or("the main webview is gone")?;
    let ticket = running.prepared.fetch_add(1, Ordering::Relaxed) + 1;
    let owner = native_owner(window)?;
    let (tx, rx) = mpsc::channel::<Result<Handle, String>>();
    main.with_webview(move |webview| {
        let failed = tx.clone();
        let begun = platform.view_id(&webview).and_then(|handle| {
            platform.begin_layout(owner, ticket, Box::new(move |allowed| {
                let _ = tx.send(if allowed { Ok(handle) } else { Err("window closed before layout".into()) });
            }))
        });
        if let Err(error) = begun {
            let _ = failed.send(Err(error));
        }
    })
    .map_err(|e| e.to_string())?;
    let main_handle = rx.recv().map_err(|e| e.to_string())??;

    let result = (|| -> Result<PreparedSurfaces, String> {
        let mut wanted: HashSet<String> = HashSet::new();

        for s in &request.surfaces {
            let label = label_for(window, &s.id);
            wanted.insert(label.clone());

            // 크기가 0 인 웹뷰는 보이지 않고 일부 플랫폼은 거부하므로 숨긴 표면으로 처리한다.
            let visible = s.visible && s.w >= 1.0 && s.h >= 1.0;
            let (ax, ay, aw, ah) = aligned(s.x, s.y, s.w.max(1.0), s.h.max(1.0), scale);
            let position = LogicalPosition::new(ax, ay);
            let size = LogicalSize::new(aw, ah);
            let solid = if s.dim { 0.45 } else { 1.0 };

            if let Some(webview) = window.get_webview(&label) {
                set_resizing(resizing, &webview, !request.settled)?;
                if visible {
                    webview.show().map_err(|e| e.to_string())?;
                } else {
                    webview.hide().map_err(|e| e.to_string())?;
                }
                webview
                    .with_webview(move |view| {
                        log_error(platform.set_alpha(&view, solid));
                        log_error(platform.place_webview(&view, ax, ay, aw, ah));
                    })
                    .map_err(|e| e.to_string())?;
                continue;
            }

            let target = if s.external {
                WebviewUrl::External(s.url.parse().map_err(|_| format!("bad url: {}", s.url))?)
            } else {
                WebviewUrl::App(s.url.clone().into())
            };
            let builder = WebviewBuilder::new(&label, target).initialization_script(background);
            window.add_child(builder, position, size).map_err(|e| e.to_string())?;
            if let Some(webview) = window.get_webview(&label) {
                // 자식 웹뷰는 생성 시 표시 여부를 받지 않으므로 표시된 상태로 만들어진다.
                // 숨긴 표면은 첫 프레임에 나타나기 전에 여기서 숨긴다.
                isolate_webview(&webview)?;
                if !visible {
                    webview.hide().map_err(|e| e.to_string())?;
                }
                let named = views.0.clone();
                let id = s.id.clone();
                webview
                    .with_webview(move |view| {
                        let attached = platform
                            .set_alpha(&view, solid)
                            .and_then(|_| platform.attach_surface(&view, main_handle))
                            .and_then(|_| platform.place_webview(&view, ax, ay, aw, ah))
                            .and_then(|_| platform.view_id(&view));
                        match attached {
                            Ok(handle) => {
                                if let Ok(mut map) = named.lock() {
                                    map.insert(handle, id);
                                }
                            }
                            Err(error) => eprintln!("{error}"),
                        }
                    })
                    .map_err(|e| e.to_string())?;
                // add_child 는 기존 뷰 위에 추가한다. 열린 모달을 키보드 포커스를 바꾸지 않고
                // 새 표면 위에 유지한다.
                let modal = overlay.view.lock().map_err(|e| e.to_string())?.clone();
                if let Some(modal) = modal {
                    modal
                        .with_webview(move |view| log_error(platform.raise_webview(&view)))
                        .map_err(|e| e.to_string())?;
                }
            }
        }

        // 표면 목록은 페이지만 작성하므로 목록에 없는 표면은 제거된 표면이다.
        for webview in window.webviews() {
            let label = webview.label().to_string();
            if label.starts_with("surface-") && !wanted.contains(&label) {
                resizing.0.lock().map_err(|e| e.to_string())?.remove(&label);
                // 맵의 키는 뷰 주소이고 시스템은 해제된 뷰의 주소를 재사용한다. 남은 항목은
                // 존재하지 않는 표면을 가리키므로 뷰와 함께 제거한다.
                let id = label.trim_start_matches(&format!("surface-{}-", window.label())).to_string();
                if let Ok(mut named) = views.0.lock() {
                    named.retain(|_, held| *held != id);
                }
                webview.close().map_err(|e| e.to_string())?;
                exposure::surface_closed(window, &id);
            }
        }
        // 제거된 표면을 사이드카에 알린다.
        let alive: Vec<String> = request.surfaces.iter().map(|s| s.id.clone()).collect();
        window.state::<WindowSidecars>().retain(window, &|id: &str| alive.iter().any(|s| s == id))?;

        // 각 표면의 실제 위치를 반환한다. 호스트는 페이지가 선언한 사각형을 디스플레이 픽셀에
        // 맞추므로 두 값의 차이를 페이지에 알린다.
        let mut placed = Vec::with_capacity(request.surfaces.len());
        for s in &request.surfaces {
            let Some(webview) = window.get_webview(&label_for(window, &s.id)) else { continue };
            placed.push(surface_placement(&webview, &s.id)?);
        }
        Ok(PreparedSurfaces { ticket, placements: placed })
    })();
    if result.is_err() {
        main.with_webview(move |_| log_error(platform.commit_layout(owner, ticket).map(|_| ())))
            .map_err(|e| e.to_string())?;
    }
    result
}

/// 표면 웹뷰의 현재 위치를 페이지 좌표로 반환한다.
fn surface_placement(view: &Webview, id: &str) -> Result<Placement, String> {
    let platform = platform::current()?;
    let (tx, rx) = mpsc::channel();
    view.with_webview(move |webview| {
        let _ = tx.send(platform.webview_frame(&webview));
    })
    .map_err(|e| e.to_string())?;
    let [x, y, w, h] = rx.recv().map_err(|e| e.to_string())??;
    Ok(Placement { id: id.into(), x, y, w, h })
}

/// DOM 이 그린 준비의 표시를 확인한다. 이후 준비와 AppKit 이벤트 루프를 막지 않는다.
pub(crate) async fn present(window: Window, request: PresentRequest) -> Result<Vec<Placement>, String> {
    let platform = platform::current()?;
    let main = root_view(&window).ok_or("the main webview is gone")?;
    let ticket = request.ticket;
    let finished = window.clone();
    let context = window_data(&window)?;
    let owner = native_owner(&window)?;
    let settled = request.settled;
    let held: Vec<_> = request
        .placements
        .into_iter()
        .filter_map(|p| window.get_webview(&label_for(&window, &p.id)).map(|view| (view, p)))
        .collect();
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    main.with_webview(move |webview| {
        let failed = tx.clone();
        let waiting = platform.after_presentation(&webview, Box::new(move || {
            let committed = platform.commit_layout(owner, ticket);
            let result = (|| -> Result<Vec<Placement>, String> {
                let committed = committed.clone()?;
                let mut placed = Vec::new();
                for (view, p) in &held {
                    placed.push(surface_placement(view, &p.id)?);
                }
                // 준비 갱신과 종료 판정을 같은 UI 스레드에서 순서대로 실행한다.
                let running = &context.running;
                if committed && settled && running.prepared.load(Ordering::Relaxed) == ticket {
                    announce_run(&finished, running, false)?;
                }
                exposure::window_changed(&finished);
                Ok(placed)
            })();
            let _ = tx.try_send(result);
        }));
        if let Err(error) = waiting {
            let _ = failed.try_send(Err(error));
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv().await.ok_or("the main webview closed before presenting")?
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
                let _ = done.send(());
            }
        }
    }
    let name = if going { "run-began" } else { "run-ended" };
    emit_window(window, name, ()).map_err(|e| e.to_string())
}

/// 뷰의 연속 크기 변경 시작과 종료를 전달한다. 두 호출은 쌍을 이루므로 뷰별 상태를 여기에
/// 기록하고 변경만 전달한다.
fn set_resizing<R: Runtime>(resizing: &Resizing, webview: &tauri::Webview<R>, live: bool) -> Result<(), String> {
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
    let platform = platform::current()?;
    webview
        .with_webview(move |view| log_error(platform.set_live_resize(&view, live)))
        .map_err(|e| e.to_string())
}
