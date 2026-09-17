//! soksak 워크벤치를 실행하는 Tauri v2 네이티브 호스트.
//!
//! 애플리케이션은 [`run`] 에 Tauri 컨텍스트와 표면 웹뷰의 초기화 스크립트를 전달한다.
//! 호스트는 프로젝트 창, 네이티브 표면, 네이티브 모달, 도형, 테마, 사이드카 채널을 제공한다.
//!
//! 페이지는 커밋할 때마다 각 표면이 차지할 영역을 선언한다. 표면 동기화는 창의 자식 웹뷰를
//! 그 영역에 맞춘다. 처음 선언된 영역에는 웹뷰를 만들고, 기존 웹뷰는 이동하고 크기를 바꾸고,
//! 선언에서 빠진 웹뷰는 닫는다. 자식 웹뷰는 tauri 크레이트의 `unstable` 기능을 사용한다.

use std::sync::atomic::Ordering;

use tauri::Manager;

mod bindings;
mod diagnostics;
mod modals;
#[path = "platform/platform.rs"]
mod platform;
pub mod projects;
mod shapes;
pub mod sidecars;
mod surfaces;
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

/// 애플리케이션을 만들고 종료할 때까지 실행한다.
///
/// context 는 애플리케이션의 `tauri::generate_context!()` 이다. background 는 표면 웹뷰가
/// 문서보다 먼저 실행하는 스크립트이며, 애플리케이션이 프론트엔드의 `background.js` 를
/// 포함해 전달한다.
pub fn run(context: tauri::Context<tauri::Wry>, background: &'static str) {
    // 진단 기능은 요청한 경우에만 등록한다. 제품 기능이 아니다.
    let observing = diagnostics::given("observe");
    let mut app = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    if observing {
        app = app.plugin(diagnostics::plugin());
    }
    app.manage(windows::Windows::default())
        .manage(surfaces::Background(background))
        .on_page_load(|view, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            let window = view.window();
            let Ok(context) = windows::window_data(&window) else { return };
            if view.label().starts_with("surface-") {
                let enabled = context.overlay.dialog();
                if let Err(error) = view.eval(format!("window.__soksakBackground = {enabled}")) {
                    eprintln!("{error}");
                }
            }
            if view.label() == window.label() {
                context.ready.store(false, Ordering::Relaxed);
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
            let directory = diagnostics::flag("config-dir")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_config_dir()?);
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
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                windows::quit(app, api);
            }
        });
}
