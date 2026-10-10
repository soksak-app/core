//! The Tauri v2 native host that runs the soksak workbench.
//!
//! The application passes the Tauri context and the initialization script of the surface webviews to [`run`]. The host
//! provides the project windows, native surfaces, native modals, shapes, the theme, the sidecar channel and the local
//! endpoint. Diagnostic methods are included only by the cargo feature `diagnostics`.
//!
//! At every commit the page declares the area that each surface occupies. The surface synchronization fits the child
//! webviews of the window to those areas. A webview is created for an area that is declared for the first time, an
//! existing webview is moved and resized, and a webview that left the declaration is closed. The child webviews use the
//! `unstable` feature of the tauri crate.

// A large json! expression such as the host.window schema exceeds the default recursion limit (128) of the serde_json
// macro.
#![recursion_limit = "256"]

use tauri::Manager;

pub mod app_events;
pub mod app_update;
pub mod application_log;
pub mod arguments;
pub mod assets;
mod bindings;
pub mod buttons;
pub mod clipboard;
pub mod command_line;
mod composition;
pub mod debug;
pub mod debug_follow;
#[cfg(feature = "diagnostics")]
mod diagnostics;
pub mod documents;
pub mod endpoint;
pub mod event_log;
pub mod event_record;
pub mod event_relay;
pub mod exposure;
pub mod images;
pub mod installed;
pub mod link;
pub mod menu;
mod modals;
pub mod notifications;
pub mod page_process;
pub mod performance;
#[path = "platform/platform.rs"]
pub mod platform;
pub mod plugins;
pub mod project_removal;
pub mod projects;
pub mod quit;
#[cfg(feature = "diagnostics")]
pub mod recording;
mod shapes;
pub mod sidecars;
pub mod start;
pub mod surfaces;
pub mod window_events;
pub use surfaces::surface_owner_id;
pub mod termination;
mod theme;
pub mod webkit_children;
pub mod windows;
pub mod workspace;

use application_log::log_error;
use sidecars::WindowSidecars;

/// The stop of the thread that announces the writes of the event log to the windows.
struct LogNoticeStop(std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>);

/// The application arguments that were read at startup (docs/spec/hosts.md#application-arguments).
static ARGUMENTS: std::sync::OnceLock<command_line::Arguments> = std::sync::OnceLock::new();

/// The application arguments. run sets them before it opens a window.
fn arguments() -> &'static command_line::Arguments {
    ARGUMENTS
        .get()
        .expect("run reads the application arguments before any window opens")
}

/// The configuration directory. Without `--config-dir`, it is the identifier directory of this build under the user
/// configuration directory (docs/spec/projects.md#persistence). It creates the directory and returns the canonical
/// path.
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

/// Requests the main page of the main application window to run a command. Menu events are handled on the main thread.
/// When there is no main window, the frontmost visible window is the target, and it is an error when there is none.
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

/// Creates the application and runs it until it exits.
///
/// context is the `tauri::generate_context!()` of the application. background is the script that the surface webviews
/// run before the document, and the application passes it including the `background.js` of the frontend.
pub fn run(mut context: tauri::Context<tauri::Wry>, _background: &'static str) {
    // The arguments are read before a window opens. An invalid argument ends with status 2
    // (docs/spec/hosts.md#application-arguments).
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
    // Installed plugins are provided from the configuration folder (docs/spec/installation.md). setup decides the
    // configuration folder.
    let installed_directory = std::sync::Arc::new(std::sync::OnceLock::new());
    let frontend = context.set_assets(Box::new(installed::NoAssets));
    let installed_assets = installed::InstalledAssets {
        frontend,
        config_dir: installed_directory.clone(),
        diagnostics: cfg!(feature = "diagnostics"),
    };
    // A page file that neither the application nor an installed plugin holds is an error line (docs/spec/diagnostics.md).
    context.set_assets(Box::new(assets::ReportingAssets::new(
        Box::new(installed_assets),
        Box::new(|path| application_log::log_error("page asset", format!("{path}: not found"))),
    )));
    // The window zoom animation moves only the window frame, and the web document follows it. This shortens its
    // duration before AppKit reads the default. A platform that cannot provide this step ends with status 1 before it
    // opens a window (docs/spec/hosts.md#windows-state).
    if let Err(error) = platform::current().and_then(|platform| platform.instant_window_resize()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    // The plugin setup runs before the window of the settings file is created, so the endpoint is opened here.
    let endpoint = tauri::plugin::Builder::<tauri::Wry>::new("endpoint")
        .setup(|app, _api| {
            // Termination signals are received from before the endpoint opens. The first one requests the normal quit
            // that host.quit requests; the event loop runs it and ends after the ready windows saved and the sidecars
            // stopped. When a save stalls, the next signal ends the process with the default action (docs/spec/hosts.md).
            let quit = app.clone();
            termination::on_termination(Box::new(move || quit.exit(0)))?;
            let directory = config_directory(app)?;
            // Harvests the WebKit children that the previous run left behind into the record, and takes the WebKit that
            // is running now as the baseline so that it does not overwrite another application's children (V5-113). No
            // window exists yet, so this run has no WebKit.
            crate::webkit_children::reap_recorded(&directory);
            crate::webkit_children::snapshot_baseline();
            let foreign = std::process::Command::new("sh")
                .arg("-c")
                .arg("ps -axo command= | grep -c 'com.apple.WebKit.' || true")
                .output()
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                // default: the startup does not stop when the ps of the baseline count report fails. This report is
                // only an observation and is not used for the harvest decision.
                .unwrap_or_else(|_| "unknown".into());
            crate::application_log::log_info(
                "webkit children",
                format!("baseline {foreign} foreign WebKit processes"),
            );
            exposure::start(app, &directory)?;
            // The event log and the stderr file are opened after the endpoint holds the process lock, so no other run writes
            // the same files (docs/spec/hosts.md#application-log). The run record waits in the start buffer until the writer
            // exists.
            let events = std::sync::Arc::new(event_log::EventLog::start_host(&directory)?);
            event_record::use_host_event_log(Some(std::sync::Arc::clone(&events)));
            // The debug view follows the event file of the host: every window learns that the writer wrote.
            let notices_app = app.clone();
            let (observe, stop) = debug_follow::coalesce_log_notices(move |path, size| {
                windows::notify_log_written(&notices_app, path, size)
            });
            events.set_on_write(observe);
            tauri::Manager::manage(app, LogNoticeStop(std::sync::Mutex::new(Some(stop))));
            tauri::Manager::manage(app, events);
            application_log::start_standard_error(&directory, soksak_sok::identity::identity())?;
            Ok(())
        })
        .build();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(windows::Windows::default())
        .manage(exposure::Exposure::default())
        .plugin(endpoint)
        .manage(surfaces::Background)
        // The main page is fetched with a scheme that knows the webview that requested the start document
        // (docs/spec/native-host.md#page-start).
        .register_uri_scheme_protocol(start::SCHEME, |context, request| {
            let app = context.app_handle().clone();
            start::serve(
                // default: a request without a host names no owner, so serve answers it not found.
                request.uri().host().unwrap_or_default(),
                request.uri().path(),
                context.webview_label(),
                &mut |webview| start::start_page(&app, webview),
            )
        })
        // The end of the WebContent process leaves the web view without a page. The host writes the end as an error
        // line (docs/spec/diagnostics.md) and loads the page again, as the Wails host does through its framework.
        .on_web_content_process_terminate(|webview| {
            let quitting = windows::is_quitting(webview.app_handle());
            let Some((place, text)) = page_process::page_process_ended(webview.label(), quitting)
            else {
                return;
            };
            log_error(&place, text);
            if let Err(error) = webview.reload() {
                log_error(&place, format!("{}: reload: {error}", webview.label()));
            }
        })
        .on_page_load(|view, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            let window = view.window();
            // Only the main webview of a window that the application registered is handled.
            if windows::window_data(&window).is_err() {
                return;
            }
            if view.label() == window.label() {
                // The cleanup of the previous page is done by the start document request (start_page) of the new page.
                // Here only the record of the WebKit children of this run is updated (V5-113).
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
            // When the notification center cannot be used, the application does not start (docs/spec/hosts.md).
            notifications::start(app.handle())?;
            // A termination request of the operating system runs the same termination as host.quit and answers after
            // RunEvent::Exit has finished the save (docs/spec/hosts.md#process-lifecycle).
            let quit = app.handle().clone();
            platform::current()?.on_quit_request(Box::new(move || quit.exit(0)))?;
            let dock = app.handle().clone();
            platform::current()?.install_dock_menu(Box::new(move || {
                if let Err(error) = windows::window_new_on_main(dock.clone()) {
                    log_error("window new", error);
                }
            }))?;
            // Before the page sends the setting language, the menu is built in the system language. The language state
            // is shared by set_menu_language and the host.menu report (docs/spec/host-contract.md).
            let language = menu::initial_language()?;
            let menu = menu::build(app.handle(), &language)?;
            app.manage(menu::MenuLanguage(std::sync::Mutex::new(language)));
            app.set_menu(menu)?;
            let directory = config_directory(app.handle())?;
            installed_directory
                .set(directory.clone())
                .map_err(|_| "the configuration directory of installed plugins is already set")?;
            app.manage(workspace::Workspace::new(directory.clone()));
            let handle = app.handle().clone();
            // Applies an operation to the sidecars: a changed sidecar is replaced and a removed one stopped, so a page
            // that reloads uses the installed executables (docs/spec/installation.md#applying-a-change).
            let applying = app.handle().clone();
            let installed = directory.clone();
            app.manage(plugins::Plugins::new(
                directory.clone(),
                Box::new(move || {
                    let declarations = installed::installed_sidecars(&installed)
                        .map_err(|error| format!("installed plugins: {error}"))?;
                    applying.state::<WindowSidecars>().declare(&declarations)
                }),
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
            // host.buttons holds the value of the operating system before endpoint.json is written. When it cannot be
            // watched, the application does not start.
            exposure::watch_buttons(app.handle())?;
            // A client sends a request to the first window as soon as it reads endpoint.json, so the file is written
            // after the window is registered.
            exposure::publish(app.handle(), "main")?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "new-window" {
                if let Err(error) = windows::window_new_on_main(app.clone()) {
                    log_error("window new", error);
                }
            } else if menu::runs_page_command(id) {
                if let Err(error) = run_menu_command(app, id) {
                    log_error(&format!("menu command {id}"), error);
                }
            }
        })
        .invoke_handler(bindings::handler())
        .build(context)
        .expect("failed to build the tauri application")
        .run(|app, event| {
            match &event {
                tauri::RunEvent::Ready => app_events::record_app_event("started"),
                tauri::RunEvent::ExitRequested { .. } => {
                    app_events::record_app_event("exit_requested")
                }
                tauri::RunEvent::Exit => app_events::record_app_event("exit"),
                _ => {}
            }
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
                // An application update keeps the persistent services running for the application that starts next.
                let update = app
                    .state::<windows::Windows>()
                    .update
                    .lock()
                    .expect("pending update")
                    .take();
                if let Some(mut command) = update {
                    // The command waits for the end of this process, so it starts here, before the flush that stores its event
                    // and the error of a start that fails.
                    if let Err(error) = app_update::start_update(&mut command) {
                        log_error("application update", error);
                    }
                    app.state::<WindowSidecars>().detach();
                } else {
                    app.state::<WindowSidecars>().stop();
                }
                exposure::stop(app);
                if let Some(stop) = app
                    .state::<LogNoticeStop>()
                    .0
                    .lock()
                    .expect("the stop of the log notices")
                    .take()
                {
                    stop();
                }
                if let Err(error) = app
                    .state::<std::sync::Arc<event_log::EventLog>>()
                    .flush(std::time::Duration::from_secs(2))
                {
                    log_error("event log flush", error);
                }
                // The save and cleanup are finished, so the termination request of the operating system that was
                // received is answered.
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
