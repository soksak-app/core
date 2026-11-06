//! The Rust language host library that runs the soksak workbench.
//!
//! A framework adapter provides the windows and their web views through the framework port ([`framework`]) and holds
//! `run`. The library provides the project windows, native surfaces, native modals, shapes, the theme, the sidecar channel
//! and the local endpoint. Diagnostic methods are included only by the cargo feature `diagnostics`.
//!
//! At every commit the page declares the area that each surface occupies. The surface synchronization fits the child
//! webviews of the window to those areas. A webview is created for an area that is declared for the first time, an
//! existing webview is moved and resized, and a webview that left the declaration is closed.

// A large json! expression such as the host.window schema exceeds the default recursion limit (128) of the serde_json
// macro.
#![recursion_limit = "256"]

use std::sync::{Arc, PoisonError};

use framework::{AppHandle, Manager, Webview};

#[cfg(test)]
#[path = "../tests/support/folder.rs"]
mod test_folder;

#[cfg(test)]
#[path = "../tests/support/framework.rs"]
mod test_framework;

pub mod app_events;
pub mod app_update;
pub mod application_log;
pub mod arguments;
pub mod assets;
pub mod binding_record;
pub mod bounds;
pub mod buffer_bounds;
pub mod buttons;
pub mod clipboard;
pub mod command_line;
pub mod composition;
pub mod crash_report;
pub mod debug;
pub mod debug_follow;
pub mod deep_link;
#[cfg(feature = "diagnostics")]
pub mod diagnostics;
pub mod documents;
pub mod endpoint;
pub mod endpoint_record;
pub mod event_log;
pub mod framework;
pub use framework::{Framework, Frontend};
pub mod event_record;
pub mod event_relay;
pub mod exposure;
pub mod file_place;
pub mod images;
pub mod installed;
pub mod link;
pub mod log_policy;
#[cfg(feature = "diagnostics")]
pub mod log_policy_watch_hook;
pub mod log_query;
pub mod log_retention;
pub mod memory_pressure;
pub mod menu;
pub mod modals;
pub mod notifications;
#[cfg(feature = "diagnostics")]
pub mod object_counts;
pub mod page_process;
pub mod performance;
#[path = "platform/platform.rs"]
pub mod platform;
pub mod plugins;
pub mod presentation_wait;
#[cfg(feature = "diagnostics")]
pub mod process_lock_hook;
pub mod project_removal;
pub mod projects;
pub mod quit;
#[cfg(feature = "diagnostics")]
pub mod recording;
pub mod responder;
#[path = "routine/routine.rs"]
pub mod routine;
pub mod running_calls;
pub mod shapes;
pub mod sidecar_reply;
pub mod sidecar_routes;
pub mod sidecars;
pub mod source_origins;
#[cfg(feature = "diagnostics")]
pub mod stall_dump;
pub mod stall_watch;
pub mod start;
pub mod surfaces;
#[cfg(feature = "diagnostics")]
pub mod test_mark;
pub mod view_lifecycle;
pub mod window_events;
pub use surfaces::surface_owner_id;
pub mod startup;
pub mod termination;
pub mod theme;
pub mod windows;
#[cfg(test)]
#[path = "windows_front_test.rs"]
mod windows_front_test;
pub mod workspace;

use application_log::{log_error, log_failure};
use sidecars::WindowSidecars;

/// The publisher of the notices of changes of the event log (docs/spec/debug.md#following). It is the value of the host status
/// `host.log`, and the application stops its thread at exit.
pub struct LogNoticeState(pub std::sync::Arc<debug_follow::LogNotices>);

/// The stop of the thread that brings the index of the event files up to date after the writer wrote.
struct LogIndexStop(std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>);

/// The stop of the watch of the main thread, which waits for its running sample (docs/spec/logging.md, stalls).
struct StallWatchStop(std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>);

/// The watch of the policy file of the event log, which ends with the application.
struct LogPolicyStop(std::sync::Mutex<Option<log_policy::LogPolicyWatch>>);

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
pub fn config_directory(app: &AppHandle) -> framework::Result<std::path::PathBuf> {
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
    .map_err(framework::Error::from)
}

/// Requests the main page of the main application window to run a command. Menu events are handled on the main thread.
/// When there is no main window, the frontmost visible window is the target, and it is an error when there is none.
fn run_menu_command(app: &AppHandle, command: &str) -> Result<(), String> {
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

/// Starts the process before the framework runs: the panic hook and the application arguments.
pub fn start_process() {
    // The panic hook is the first action of the process, so a panic before the writer exists is recorded in the start buffer
    // and stored when the writer opens (docs/spec/hosts.md#process-lifecycle).
    application_log::install_panic_hook();
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
}

/// The page files of the application: the bundled frontend under the installed plugins, which report a file that neither
/// holds (docs/spec/diagnostics.md). setup decides the configuration folder of the installed plugins.
pub fn page_assets(
    frontend: std::sync::Arc<dyn assets::Assets>,
    installed_directory: std::sync::Arc<std::sync::OnceLock<std::path::PathBuf>>,
) -> assets::ReportingAssets {
    let installed_assets = installed::InstalledAssets {
        frontend,
        config_dir: installed_directory,
        diagnostics: cfg!(feature = "diagnostics"),
    };
    // A page file that neither the application nor an installed plugin holds is an error line (docs/spec/diagnostics.md).
    assets::ReportingAssets::new(
        Box::new(installed_assets),
        Box::new(|path| application_log::log_error("page asset", format!("{path}: not found"))),
    )
}

/// Prepares the platform before a window opens.
pub fn prepare_platform() {
    // The window zoom animation moves only the window frame, and the web document follows it. This shortens its
    // duration before AppKit reads the default. A platform that cannot provide this step ends with status 1 before it
    // opens a window (docs/spec/hosts.md#windows-state).
    if let Err(error) = platform::current().and_then(|platform| platform.instant_window_resize()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

/// Adds the state values that the start of the endpoint reads to the application.
pub fn manage_start_state(app: &AppHandle) {
    app.manage(windows::Windows::default());
    app.manage(exposure::Exposure::default());
    app.manage(surfaces::Background);
}

/// Opens the endpoint, the event log and the stderr file. The framework adapter calls it before the window of the settings
/// file is created.
pub fn start_endpoint(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Termination signals are received from before the endpoint opens. The first one requests the normal quit
    // that host.quit requests; the event loop runs it and ends after the ready windows saved and the sidecars
    // stopped. When a save stalls, the next signal ends the process with the default action (docs/spec/hosts.md).
    let quit = app.clone();
    let state = std::sync::Arc::clone(&app.state::<windows::Windows>().quit);
    termination::on_termination(state, Box::new(move || quit.quit()))?;
    let directory = config_directory(app)?;
    exposure::start(app, &directory)?;
    // The event log and the stderr file are opened after the endpoint holds the process lock, so no other run writes the same
    // files (docs/spec/hosts.md#application-log). The run record waits in the start buffer until the writer exists.
    let events = std::sync::Arc::new(event_log::start_host(&directory)?);
    event_record::use_host_event_log(Some(std::sync::Arc::clone(&events)));
    // An owner that an earlier run left in process.lock marks an end of that run without its exit path
    // (docs/spec/endpoint.md#discovery). The event is stored once the writer exists.
    if let Some(end) = exposure::unrecorded_end(app) {
        endpoint::report_unrecorded_end(&end);
    }
    // The policy of the event log is the file log-policy.json, which the host and every process watch
    // (docs/spec/logging.md#classes-and-policy).
    let policy_app = app.clone();
    let policy_watch = log_policy::start_log_policy(
        &events,
        Some(log_policy::log_policy_announcer(
            &events,
            move |name, payload| windows::notify_windows(&policy_app, name, payload),
        )),
    )
    .map_err(|error| format!("log policy: {error}"))?;
    app.manage(LogPolicyStop(std::sync::Mutex::new(Some(policy_watch))));
    // The debug view follows the event files: every window and every watcher of host.log learns that a line announced
    // a change (docs/spec/debug.md#following). The index covers the lines before the notice, so the notice follows
    // the indexer and the queries that update an index, and not the writer.
    let notices_app = app.clone();
    let notices = std::sync::Arc::new(debug_follow::LogNotices::start(
        debug_follow::LOG_NOTICE_INTERVAL,
        move |notice| windows::notify_log_notice(&notices_app, &notice),
    ));
    debug_follow::use_log_notices(Some(std::sync::Arc::clone(&notices)));
    // The index of each event file follows the writer (docs/spec/logging.md#index).
    let (index_writes, stop_indexer) = log_query::start_log_indexer(log_query::index_reporter());
    events.set_on_write(Box::new(move |path: &std::path::Path, size: u64| {
        index_writes(path, size);
    }));
    installed::apply_plugin_event_classes(&events, &directory);
    app.manage(LogIndexStop(std::sync::Mutex::new(Some(stop_indexer))));
    app.manage(LogNoticeState(notices));
    app.manage(events);
    application_log::start_standard_error(&directory, soksak_sok::identity::identity())?;
    // The crash reports of the earlier runs are announced once, after the writer exists
    // (docs/spec/logging.md#entrances).
    if let Err(error) = crash_report::announce_crash_reports_at_start(&directory) {
        application_log::log_error("crash reports", error);
    }
    Ok(())
}

/// The values of the setup of the host that the framework adapter passes.
pub struct Setup {
    /// The bundled frontend.
    pub frontend: std::sync::Arc<dyn assets::Assets>,
    /// The configuration folder of the installed plugins, which the setup decides.
    pub installed_directory: std::sync::Arc<std::sync::OnceLock<std::path::PathBuf>>,
    /// Connects the deep links of the framework: a link that arrives while the application runs and the link that launched
    /// the application each go to [`deep_link::open`] (docs/spec/native-host.md#deep-links).
    pub deep_links: Box<dyn FnOnce(&AppHandle)>,
}

/// Sets up the host once the framework created the application and its main window.
pub fn setup(app: &AppHandle, setup: Setup) -> Result<(), Box<dyn std::error::Error>> {
    let Setup {
        frontend: core_frontend,
        installed_directory,
        deep_links,
    } = setup;
    // When the notification center cannot be used, the application does not start (docs/spec/hosts.md).
    notifications::start(app)?;
    deep_links(app);
    // A termination request of the operating system runs the same termination as host.quit and answers after
    // the exit has finished the save (docs/spec/hosts.md#process-lifecycle).
    let quit = app.clone();
    platform::current()?.on_quit_request(Box::new(move || {
        event_record::quit_with_cause("quit-request", || quit.quit())
    }))?;
    // The one memory pressure source of the process starts with the host, and each report goes to every window
    // (docs/spec/hosts.md#memory-pressure).
    let pressure = app.clone();
    memory_pressure::start(
        |report| platform::current()?.on_memory_pressure(report),
        move |name, payload| windows::notify_windows(&pressure, name, payload),
    )?;
    let dock = app.clone();
    app.install_dock(move || {
        if let Err(error) = windows::window_new_on_main(dock.clone()) {
            log_error("window new", error);
        }
    })?;
    // Before the page sends the setting language, the menu is built in the system language. The language state
    // is shared by set_menu_language and the host.menu report (docs/spec/host-contract.md).
    let language = menu::initial_language()?;
    let menu = menu::build(&language)?;
    app.manage(menu::MenuLanguage(std::sync::Mutex::new(language)));
    app.set_menu(menu)?;
    let directory = config_directory(app)?;
    installed_directory
        .set(directory.clone())
        .map_err(|_| "the configuration directory of installed plugins is already set")?;
    // The core root of a view serves the core files from the bundled frontend, which the page reads too
    // (docs/spec/plugin-processes.md, rule 4).
    let core_root_frontend = std::sync::Arc::clone(&core_frontend);
    // Each view configuration runs the view channel script of the bundled frontend before its page
    // (docs/spec/native-surfaces.md#view-surfaces).
    let channel = core_frontend
        .get("modules/@soksak/plugin-api/view-start.js")
        .ok_or("modules/@soksak/plugin-api/view-start.js is missing from the bundled frontend")?;
    let channel = String::from_utf8(channel.into_owned())
        .map_err(|error| format!("view channel script is not UTF-8: {error}"))?;
    documents::set_view_channel(&channel)?;
    installed::register_core_root(
        platform::current()?,
        directory.clone(),
        std::sync::Arc::new(move |name: &str| {
            core_root_frontend.get(name).map(|bytes| bytes.into_owned())
        }),
    )?;
    // The view import map is inserted into each view page, so the application does not start when the platform cannot set it.
    let view_import_frontend = std::sync::Arc::clone(&core_frontend);
    installed::register_view_import_map(
        platform::current()?,
        std::sync::Arc::new(move |name: &str| {
            view_import_frontend
                .get(name)
                .map(|bytes| bytes.into_owned())
        }),
    )?;
    app.manage(workspace::Workspace::new(directory.clone()));
    // A stall of the main thread is recorded without a window check (docs/spec/logging.md, stalls). The exit
    // stops the watch and waits for its running sample.
    let stop_stall_watch = stall_watch::start_stall_watch(stall_watch::StallWatchOptions {
        heartbeat: Box::new(|| {
            let (now, answered) = platform::current()?.stall_heartbeat()?;
            Ok((
                std::time::Duration::from_nanos(now),
                std::time::Duration::from_nanos(answered),
            ))
        }),
        await_awake: Box::new(|| platform::current()?.stall_await_awake()),
        sample: Arc::new(|path| platform::current()?.sample_threads(path)),
        folder: directory.join("logs"),
        emit_host: Arc::new(event_record::emit_host),
        clock: None,
        wait: None,
    });
    app.manage(StallWatchStop(std::sync::Mutex::new(Some(Box::new(
        stop_stall_watch,
    )))));
    let handle = app.clone();
    // Applies an operation to the sidecars: a changed sidecar is replaced and a removed one stopped, so a page
    // that reloads uses the installed executables (docs/spec/installation.md#applying-a-change).
    let applying = app.clone();
    let installed = directory.clone();
    app.manage(plugins::Plugins::new(
        directory.clone(),
        Box::new(move || {
            installed::apply_plugin_event_classes(
                &applying.state::<std::sync::Arc<event_log::EventLog>>(),
                &installed,
            );
            let declarations = installed::installed_sidecars(&installed)
                .map_err(|error| format!("installed plugins: {error}"))?;
            applying.state::<WindowSidecars>().declare(&declarations)
        }),
        Box::new(move |change| windows::notify_plugins(&handle, change)),
    )?);
    let sidecars: WindowSidecars = installed::new_installed_sidecars(directory)?;
    let reporting = app.clone();
    sidecars.on_status_changed(move |value| {
        crate::exposure::sidecars_status_changed(&reporting, value)
    });
    let changed = app.clone();
    sidecars.on_closing_changed(move || crate::exposure::sidecars_changed(&changed));
    app.manage(sidecars);
    let main = app
        .get_window("main")
        .ok_or("the configuration has no main window")?;
    windows::register(main)?;
    // host.buttons holds the value of the operating system before endpoint.json is written. When it cannot be
    // watched, the application does not start.
    exposure::watch_buttons(app)?;
    // A client sends a request to the first window as soon as it reads endpoint.json, so the file is written
    // after the window is registered.
    exposure::publish(app, "main")?;
    Ok(())
}

/// Handles the end of the WebContent process of webview, which leaves the web view without a page. The host writes the end as
/// an error line (docs/spec/diagnostics.md) and loads the page again, as the Wails host does through its framework.
pub fn web_content_process_terminated(webview: &Webview) {
    let quitting = windows::is_quitting(webview.app_handle());
    let Some((place, text)) = page_process::page_process_ended(webview.label(), quitting) else {
        return;
    };
    log_error(&place, text);
    // Only the main webview holds the subscriptions of document streams (docs/spec/native-surfaces.md#document-streams).
    // A window that the application did not register has no streams.
    let window = webview.window();
    if webview.label() == window.label() && windows::window_data(&window).is_ok() {
        log_failure("page process", documents::main_page_process_ended(&window));
    }
    if let Err(error) = webview.reload() {
        log_error(&place, format!("{}: reload: {error}", webview.label()));
    }
}

/// Runs the menu item with id.
pub fn menu_event(app: &AppHandle, id: &str) {
    if id == "new-window" {
        if let Err(error) = windows::window_new_on_main(app.clone()) {
            log_error("window new", error);
        }
    } else if menu::runs_page_command(id)
        && let Err(error) = run_menu_command(app, id)
    {
        log_error(&format!("menu command {id}"), error);
    }
}

/// An event of the run of the application.
pub enum RunEvent {
    /// The event loop runs.
    Ready,
    /// The application is asked to exit, with the code of an exit that the host requested.
    ExitRequested {
        code: Option<i32>,
        api: ExitRequestApi,
    },
    /// The event loop ends.
    Exit,
}

/// The answer to an exit request.
#[derive(Clone, Debug, Default)]
pub struct ExitRequestApi(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl ExitRequestApi {
    /// Keeps the application running.
    pub fn prevent_exit(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// Whether the host kept the application running.
    pub fn prevented(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Handles an event of the run of the application.
pub fn run_event(app: &AppHandle, event: RunEvent) {
    match &event {
        RunEvent::Ready => app_events::record_app_event("started"),
        RunEvent::ExitRequested { .. } => {
            app_events::record_app_event("exit_requested");
            event_record::emit_closed("exit-request", None);
        }
        RunEvent::Exit => {
            app_events::record_app_event("exit");
            event_record::emit_closed("exit", None);
        }
    }
    if let RunEvent::ExitRequested {
        code: None,
        ref api,
    } = event
    {
        let stays = platform::current().is_ok_and(|platform| platform.stays_open_without_windows());
        if stays && app.windows().is_empty() {
            api.prevent_exit();
            return;
        }
    }
    if let RunEvent::Exit = event {
        // The exit ends the watch of the main thread before its own work on the main thread, and the stop waits for
        // the running sample, so its `host.stall.sampled` reaches the flush below and no sample process outlives the
        // host (docs/spec/logging.md, stalls).
        if let Some(stop) = app
            .state::<StallWatchStop>()
            .0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the stop of the watch, which the exit
            // takes; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            stop();
        }
        // An application update or a relaunch keeps the persistent services running for the application that starts
        // next.
        let update = app
            .state::<windows::Windows>()
            .update
            .lock()
            // default: a lock that a panicking thread poisoned still holds the pending update, which the exit
            // takes; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(pending) = update {
            // The command waits for the end of this process, so it starts here, before the flush that stores its event
            // and the error of a start that fails.
            pending.start();
            app.state::<WindowSidecars>().detach();
        } else {
            app.state::<WindowSidecars>().stop();
        }
        exposure::stop(app);
        if let Some(stop) = app
            .state::<LogIndexStop>()
            .0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the stop of the log index, which the
            // exit takes; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            stop();
        }
        debug_follow::use_log_notices(None);
        app.state::<LogNoticeState>().0.stop();
        // Dropping the watch stops it and waits until its thread ended.
        drop(
            app.state::<LogPolicyStop>()
                .0
                .lock()
                // default: a lock that a panicking thread poisoned still holds the stop of the policy watch,
                // which the exit takes; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .take(),
        );
        if let Err(error) = event_log::flush_event_log(
            &app.state::<std::sync::Arc<event_log::EventLog>>(),
            || platform::current()?.flush_native_observers(),
            std::time::Duration::from_secs(2),
        ) {
            log_error("event log flush", error);
        }
        // The save and cleanup are finished, so the termination request of the operating system that was
        // received is answered.
        match platform::current() {
            Ok(platform) => platform.answer_quit_requests(),
            Err(error) => log_error("quit request answer", error),
        }
    }
    if let RunEvent::ExitRequested { api, .. } = event {
        windows::quit(app, api);
    }
}
