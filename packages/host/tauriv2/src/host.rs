//! soksak 워크벤치를 실행하는 Tauri v2 네이티브 호스트.
//!
//! 애플리케이션은 [`run`] 에 Tauri 컨텍스트와 표면 웹뷰의 초기화 스크립트를 전달한다.
//! 호스트는 프로젝트 창, 네이티브 표면, 네이티브 모달, 도형, 테마, 사이드카 채널, 로컬
//! 엔드포인트를 제공한다. 진단 메서드는 cargo 기능 `diagnostics` 로만 포함한다.
//!
//! 페이지는 커밋할 때마다 각 표면이 차지할 영역을 선언한다. 표면 동기화는 창의 자식 웹뷰를
//! 그 영역에 맞춘다. 처음 선언된 영역에는 웹뷰를 만들고, 기존 웹뷰는 이동하고 크기를 바꾸고,
//! 선언에서 빠진 웹뷰는 닫는다. 자식 웹뷰는 tauri 크레이트의 `unstable` 기능을 사용한다.

use std::sync::atomic::Ordering;

use tauri::Manager;

mod bindings;
#[cfg(feature = "diagnostics")]
mod diagnostics;
pub mod documents;
pub mod endpoint;
pub mod exposure;
mod modals;
#[path = "platform/platform.rs"]
mod platform;
pub mod projects;
#[cfg(feature = "diagnostics")]
pub mod recording;
mod shapes;
pub mod sidecars;
mod surfaces;
pub mod termination;
mod theme;
mod windows;
pub mod workspace;

use sidecars::WindowSidecars;

/// 실패한 네이티브 호출의 오류를 표준 오류에 기록한다. 결과를 호출자에게 돌려줄 수 없는
/// 메인 스레드 작업에서 사용한다.
pub(crate) fn log_error(result: Result<(), String>) {
    if let Err(error) = result {
        eprintln!("{error}");
    }
}

/// 명령줄 플래그 값을 반환한다. `--flag value` 와 `--flag=value` 형식을 받는다. Go 의 flag 패키지도
/// 두 형식을 받으므로 두 애플리케이션에 같은 인자를 전달할 수 있다.
fn flag(name: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    let long = format!("--{name}");
    let short = format!("-{name}");
    while let Some(arg) = args.next() {
        if arg == long || arg == short {
            return args.next();
        }
        for prefix in [format!("{long}="), format!("{short}=")] {
            if let Some(value) = arg.strip_prefix(&prefix) {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// 설정 디렉터리. `--config-dir` 가 없으면 애플리케이션 설정 디렉터리이다.
fn config_directory(app: &tauri::AppHandle) -> tauri::Result<std::path::PathBuf> {
    match flag("config-dir") {
        Some(directory) => Ok(directory.into()),
        None => app.path().app_config_dir(),
    }
}

/// 애플리케이션을 만들고 종료할 때까지 실행한다.
///
/// context 는 애플리케이션의 `tauri::generate_context!()` 이다. background 는 표면 웹뷰가
/// 문서보다 먼저 실행하는 스크립트이며, 애플리케이션이 프론트엔드의 `background.js` 를
/// 포함해 전달한다.
pub fn run(context: tauri::Context<tauri::Wry>, background: &'static str) {
    // 창 확대 애니메이션은 창 프레임만 움직이고 웹 문서는 그 뒤에 따라온다. AppKit 이 기본값을
    // 읽기 전에 그 길이를 줄인다.
    if let Ok(platform) = platform::current() {
        log_error(platform.instant_window_resize());
    }
    // 플러그인 설정은 설정 파일의 창을 만들기 전에 실행되므로 엔드포인트를 여기서 연다.
    let endpoint = tauri::plugin::Builder::<tauri::Wry>::new("endpoint")
        .setup(|app, _api| {
            // 종료 신호는 엔드포인트를 열기 전부터 받는다. host.quit 과 같은 일반 종료 요청이며,
            // 이벤트 루프가 시작한 뒤 처리되어 준비된 창의 저장을 마친 뒤 끝난다.
            let quit = app.clone();
            termination::on_termination(Box::new(move || quit.exit(0)))?;
            let directory = config_directory(app)?;
            exposure::start(app, &directory)?;
            Ok(())
        })
        .build();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(windows::Windows::default())
        .manage(exposure::Exposure::default())
        .plugin(endpoint)
        .manage(surfaces::Background(background))
        .on_page_load(|view, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            let window = view.window();
            let Ok(context) = windows::window_data(&window) else { return };
            let surface = format!("surface-{}-", window.label());
            if let Some(id) = view.label().strip_prefix(&surface) {
                documents::close_surface(&window, id);
                exposure::surface_closed(&window, id);
            }
            if view.label().starts_with("surface-") {
                let enabled = context.overlay.dialog();
                if let Err(error) = view.eval(format!("window.__soksakBackground = {enabled}")) {
                    eprintln!("{error}");
                }
            }
            if view.label() == window.label() {
                context.ready.store(false, Ordering::Relaxed);
                exposure::page_reloaded(&window);
                if let Ok(owner) = windows::native_owner(&window) {
                    if let Ok(platform) = platform::current() {
                        log_error(platform.cancel_layout(owner));
                    }
                }
                log_error(context.overlay.discard());
            }
        })
        .setup(|app| {
            let dock = app.handle().clone();
            platform::current()?.install_dock_menu(Box::new(move || {
                let app = dock.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = windows::window_new(app) {
                        eprintln!("{error}");
                    }
                });
            }))?;
            let menu = tauri::menu::Menu::default(app.handle())?;
            let Some(tauri::menu::MenuItemKind::Submenu(submenu)) = menu.get(tauri::menu::WINDOW_SUBMENU_ID) else {
                return Err("default window menu is missing".into());
            };
            submenu.prepend(&tauri::menu::MenuItem::with_id(app, "new-window", "새 창", true, Some("CmdOrCtrl+Shift+N"))?)?;
            app.set_menu(menu)?;
            let directory = config_directory(app.handle())?;
            app.manage(workspace::Workspace::new(directory));
            let executable = std::env::current_exe()?;
            let sidecar_directory = executable.parent().ok_or("executable has no directory")?.to_path_buf();
            let resolver = app.asset_resolver();
            let read = |path: &str| resolver.get(path.into()).map(|asset| asset.bytes);
            let sidecars = WindowSidecars::new(&read, sidecar_directory)?;
            app.manage(sidecars);
            if let Some(window) = app.get_webview_window("main") {
                windows::register(window.as_ref().window())?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "new-window" {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = windows::window_new(app) {
                        eprintln!("{error}");
                    }
                });
            }
        })
        .invoke_handler(bindings::handler())
        .build(context)
        .expect("failed to build the tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code: None, ref api, .. } = event {
                let stays = platform::current().is_ok_and(|platform| platform.stays_open_without_windows());
                if stays && app.windows().is_empty() {
                    api.prevent_exit();
                    return;
                }
            }
            if let tauri::RunEvent::Exit = event {
                app.state::<WindowSidecars>().stop();
                exposure::stop(app);
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                windows::quit(app, api);
            }
        });
}
