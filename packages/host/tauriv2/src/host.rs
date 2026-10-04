//! soksak 워크벤치를 실행하는 Tauri v2 네이티브 호스트.
//!
//! 애플리케이션은 [`run`] 에 Tauri 컨텍스트와 표면 웹뷰의 초기화 스크립트를 전달한다.
//! 호스트는 프로젝트 창, 네이티브 표면, 네이티브 모달, 도형, 테마, 사이드카 채널, 로컬
//! 엔드포인트를 제공한다. 진단 메서드는 cargo 기능 `diagnostics` 로만 포함한다.
//!
//! 페이지는 커밋할 때마다 각 표면이 차지할 영역을 선언한다. 표면 동기화는 창의 자식 웹뷰를
//! 그 영역에 맞춘다. 처음 선언된 영역에는 웹뷰를 만들고, 기존 웹뷰는 이동하고 크기를 바꾸고,
//! 선언에서 빠진 웹뷰는 닫는다. 자식 웹뷰는 tauri 크레이트의 `unstable` 기능을 사용한다.

// host.window 스키마 같은 큰 json! 표현은 serde_json 매크로의 기본 재귀 한도(128)를 넘는다.
#![recursion_limit = "256"]

use tauri::Manager;

pub mod application_log;
pub mod arguments;
mod bindings;
pub mod clipboard;
pub mod command_line;
mod composition;
#[cfg(feature = "diagnostics")]
mod diagnostics;
pub mod documents;
pub mod endpoint;
pub mod exposure;
pub mod images;
pub mod installed;
pub mod link;
pub mod menu;
mod modals;
pub mod notifications;
pub mod performance;
#[path = "platform/platform.rs"]
pub mod platform;
pub mod plugins;
pub mod projects;
#[cfg(feature = "diagnostics")]
pub mod recording;
mod shapes;
pub mod sidecars;
pub mod start;
pub mod surfaces;
pub use surfaces::surface_owner_id;
pub mod termination;
mod theme;
pub mod webkit_children;
pub mod windows;
pub mod workspace;

use application_log::{log_error, log_failure};
use sidecars::WindowSidecars;

/// 시작할 때 읽은 애플리케이션 인자(docs/spec/hosts.md#application-arguments).
static ARGUMENTS: std::sync::OnceLock<command_line::Arguments> = std::sync::OnceLock::new();

/// 애플리케이션 인자. run 이 창을 열기 전에 정한다.
fn arguments() -> &'static command_line::Arguments {
    ARGUMENTS
        .get()
        .expect("run reads the application arguments before any window opens")
}

/// 설정 디렉터리. `--config-dir` 가 없으면 사용자 설정 디렉터리 아래 이 build 의 식별자 디렉터리이다
/// (docs/spec/projects.md#persistence). 디렉터리를 만들고 정규 경로를 반환한다.
pub(crate) fn config_directory(app: &tauri::AppHandle) -> tauri::Result<std::path::PathBuf> {
    let directory = match &arguments().config_dir {
        Some(directory) => std::path::PathBuf::from(directory),
        None => app
            .path()
            .config_dir()?
            .join(soksak_sok::identity::identity()),
    };
    workspace::prepare_config_directory(&directory, |path| {
        platform::current()?.create_private_directories(path)
    })
    .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))
}

/// 애플리케이션 주 창의 메인 페이지에 명령 실행을 요청한다. 메뉴 이벤트는 메인 스레드에서 처리된다.
/// 주 창이 없으면 가장 앞의 보이는 창이 대상이고, 그것도 없으면 오류다.
fn run_menu_command(app: &tauri::AppHandle, command: &str) -> Result<(), String> {
    let platform = platform::current()?;
    let main = platform.main_window()?;
    for window in app.windows().into_values() {
        if main != 0 && platform.window_handle(&window)? == main {
            return windows::emit_window(
                &window,
                "menu-command",
                serde_json::json!({ "name": command }),
            )
            .map_err(|e| e.to_string());
        }
    }
    Err("no main window".into())
}

/// 애플리케이션을 만들고 종료할 때까지 실행한다.
///
/// context 는 애플리케이션의 `tauri::generate_context!()` 이다. background 는 표면 웹뷰가
/// 문서보다 먼저 실행하는 스크립트이며, 애플리케이션이 프론트엔드의 `background.js` 를
/// 포함해 전달한다.
pub fn run(mut context: tauri::Context<tauri::Wry>, _background: &'static str) {
    // 인자는 창을 열기 전에 읽는다. 잘못된 인자는 상태 2 로 끝낸다(docs/spec/hosts.md#application-arguments).
    match command_line::parse_arguments(std::env::args().skip(1))
        .and_then(|parsed| command_line::apply_arguments(&parsed).map(|()| parsed))
    {
        Ok(parsed) => {
            ARGUMENTS
                .set(parsed)
                .expect("run reads the application arguments once");
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
    // 설치된 plugin 은 설정 폴더에서 제공한다(docs/spec/installation.md). 설정 폴더는 setup 이 정한다.
    let installed_directory = std::sync::Arc::new(std::sync::OnceLock::new());
    let frontend = context.set_assets(Box::new(installed::NoAssets));
    context.set_assets(Box::new(installed::InstalledAssets {
        frontend,
        config_dir: installed_directory.clone(),
        diagnostics: cfg!(feature = "diagnostics"),
    }));
    // 창 확대 애니메이션은 창 프레임만 움직이고 웹 문서는 그 뒤에 따라온다. AppKit 이 기본값을
    // 읽기 전에 그 길이를 줄인다.
    if let Ok(platform) = platform::current() {
        log_failure("window resize", platform.instant_window_resize());
    }
    // 플러그인 설정은 설정 파일의 창을 만들기 전에 실행되므로 엔드포인트를 여기서 연다.
    let endpoint = tauri::plugin::Builder::<tauri::Wry>::new("endpoint")
        .setup(|app, _api| {
            // 종료 신호는 엔드포인트를 열기 전부터 받는다. host.quit 과 같은 일반 종료 요청이며,
            // 이벤트 루프가 시작한 뒤 처리되어 준비된 창의 저장을 마친 뒤 끝난다.
            let quit = app.clone();
            termination::on_termination(Box::new(move || {
                // 종료 전에 모든 웹뷰의 웹 프로세스를 죽인다. AppKit 은 XPC 서비스를
                // 클라이언트보다 오래 살려두므로(V5-105), 죽이지 않으면 WebContent·GPU·
                // Networking 프로세스가 앱 종료 후에도 남아 메모리를 차지한다.
                for (label, _) in quit.webview_windows() {
                    if let Some(window) = quit.get_window(&label) {
                        if let Some(view) = crate::windows::root_view(&window) {
                            if let Err(error) = crate::exposure::with_view(&view, |native| {
                                platform::current()?.kill_web_content_process(native)
                            }) {
                                log_error("web content kill", error);
                            }
                        }
                    }
                }
                // 종료 신호는 강제 종료다. quit.exit(0) 은 ExitRequested 를 거쳐 준비된 창의
                // 저장을 기다리므로 페이지가 응답하지 않으면 영원히 대기한다. 종료 신호에서는
                // 프로세스를 즉시 끝낸다 — 저장 없이 끝나는 것은 이미 두 번째 신호의 설계다.
                std::process::exit(0);
            }))?;
            let directory = config_directory(app)?;
            // 지난 실행이 남긴 WebKit 자식을 기록으로 수확하고, 남의 것을 덮지 않게 지금
            // 떠 있는 WebKit 을 기준선으로 찍는다(V5-113). 아직 창이 없으므로 이 실행의
            // WebKit 은 하나도 없다.
            crate::webkit_children::reap_recorded(&directory);
            crate::webkit_children::snapshot_baseline();
            let foreign = std::process::Command::new("sh")
                .arg("-c")
                .arg("ps -axo command= | grep -c 'com.apple.WebKit.' || true")
                .output()
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                // 기본값: 기준선 개수 보고의 ps 가 실패해도 시작은 멈추지 않는다 — 이 보고는
                // 관측일 뿐 수확 판정에 쓰이지 않는다.
                .unwrap_or_else(|_| "unknown".into());
            eprintln!("webkit children: baseline {foreign} foreign WebKit processes");
            exposure::start(app, &directory)?;
            // 애플리케이션 로그는 엔드포인트가 process lock 을 잡은 뒤에 연다. 그래서 같은 파일에 쓰는
            // 다른 실행이 없다(docs/spec/hosts.md#application-log).
            application_log::start_application_log(&directory, soksak_sok::identity::identity())?;
            Ok(())
        })
        .build();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(windows::Windows::default())
        .manage(exposure::Exposure::default())
        .plugin(endpoint)
        .manage(surfaces::Background)
        // main page 는 시작 문서를 요청한 webview 를 아는 scheme 으로 가져온다(docs/spec/native-host.md#page-start).
        .register_uri_scheme_protocol(start::SCHEME, |context, request| {
            let app = context.app_handle().clone();
            start::serve(
                request.uri().path(),
                context.webview_label(),
                &mut |webview| start::start_page(&app, webview),
            )
        })
        .on_page_load(|view, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            let window = view.window();
            // 애플리케이션이 등록한 창의 메인 웹뷰만 처리한다.
            if windows::window_data(&window).is_err() {
                return;
            }
            if view.label() == window.label() {
                // 이전 페이지의 정리는 새 페이지의 시작 문서 요청(start_page)이 한다. 여기서는 이 실행의
                // WebKit 자식 기록만 갱신한다(V5-113).
                let started = || {
                    if let Some(workspace) = window
                        .app_handle()
                        .try_state::<crate::workspace::Workspace>()
                    {
                        crate::webkit_children::refresh(workspace.directory());
                    }
                };
                #[cfg(feature = "diagnostics")]
                crate::diagnostics::handle_navigation(&window, started);
                #[cfg(not(feature = "diagnostics"))]
                started();
            }
        })
        .setup(move |app| {
            // 알림 센터를 쓸 수 없으면 애플리케이션을 시작하지 않는다(docs/spec/hosts.md).
            notifications::start(app.handle())?;
            // 운영체제의 종료 요청은 host.quit 과 같은 종료를 실행하고, RunEvent::Exit 이 저장을 마친 뒤
            // 답한다(docs/spec/hosts.md#process-lifecycle).
            let quit = app.handle().clone();
            platform::current()?.on_quit_request(Box::new(move || quit.exit(0)))?;
            let dock = app.handle().clone();
            platform::current()?.install_dock_menu(Box::new(move || {
                if let Err(error) = windows::window_new_on_main(dock.clone()) {
                    log_error("window new", error);
                }
            }))?;
            // 페이지가 설정 언어를 보내기 전에는 시스템 언어로 메뉴를 만든다. 언어 상태는
            // set_menu_language 와 host.menu 보고가 같이 쓴다(docs/spec/host-contract.md).
            let language = menu::initial_language();
            let menu = menu::build(app.handle(), &language)?;
            app.manage(menu::MenuLanguage(std::sync::Mutex::new(language)));
            app.set_menu(menu)?;
            let directory = config_directory(app.handle())?;
            installed_directory
                .set(directory.clone())
                .map_err(|_| "the configuration directory of installed plugins is already set")?;
            crate::performance::disable(&directory)?;
            app.manage(workspace::Workspace::new(directory.clone()));
            let handle = app.handle().clone();
            app.manage(plugins::Plugins::new(
                directory.clone(),
                Box::new(move |change| windows::notify_plugins(&handle, change)),
            )?);
            let declarations = installed::installed_sidecars(&directory)
                .map_err(|error| format!("installed plugins: {error}"))?;
            let sidecars = WindowSidecars::new(&declarations, directory)?;
            let changed = app.handle().clone();
            sidecars.on_closing_changed(move || crate::exposure::sidecars_changed(&changed));
            app.manage(sidecars);
            let main = app
                .get_webview_window("main")
                .ok_or("the configuration has no main window")?;
            windows::register(main.as_ref().window())?;
            // 클라이언트는 endpoint.json 을 읽자마자 첫 창에 요청하므로 창을 등록한 뒤 쓴다.
            exposure::publish(app.handle(), "main")?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "new-window" {
                if let Err(error) = windows::window_new_on_main(app.clone()) {
                    log_error("window new", error);
                }
            } else if menu::text_command(id) {
                if let Err(error) = run_menu_command(app, id) {
                    log_error(&format!("menu command {id}"), error);
                }
            }
        })
        .invoke_handler(bindings::handler())
        .build(context)
        .expect("failed to build the tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None,
                ref api,
                ..
            } = event
            {
                let stays =
                    platform::current().is_ok_and(|platform| platform.stays_open_without_windows());
                if stays && app.windows().is_empty() {
                    api.prevent_exit();
                    return;
                }
            }
            if let tauri::RunEvent::Exit = event {
                app.state::<WindowSidecars>().stop();
                exposure::stop(app);
                // 저장과 정리를 마쳤으므로 받은 운영체제의 종료 요청에 답한다.
                match platform::current() {
                    Ok(platform) => platform.answer_quit_requests(),
                    Err(error) => log_error("quit request answer", error),
                }
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                windows::quit(app, api);
            }
        });
}
