//! The GPUI application as the Framework port of the language host library.

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::Arc;

use gpui::{App, AppContext as _};
use gpui_kit as gpui;
use soksak_host::framework::{self as port, AppHandle, BlockingTask, WindowOptions};

use crate::frontend::{self, Frontend, Record};
use crate::service;

/// The GPUI application of the adapter, which `run` holds.
static APPLICATION: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// Binds the application that the Framework reaches.
pub(crate) fn bind(app: &AppHandle) {
    // A second binding of the process keeps the application of the first, which is the only application.
    APPLICATION.get_or_init(|| app.clone());
}

/// The application of the adapter.
pub(crate) fn application() -> AppHandle {
    APPLICATION
        .get()
        .expect("run binds the application before the host calls the framework")
        .clone()
}

/// The item of the dock menu of GPUI, which opens a new window.
#[derive(Clone, Debug, PartialEq, Eq, gpui::Action)]
pub(crate) struct DockNewWindow;

// The new window item of the dock menu, which install_dock holds on the main thread that the
// dock menu of GPUI runs its items on.
thread_local! {
    pub(crate) static DOCK_NEW_WINDOW: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        const { std::cell::RefCell::new(None) };
}

/// The GPUI application as the Framework port.
pub struct Framework;

impl port::Framework for Framework {
    fn application_name(&self) -> &'static str {
        "gpuikit"
    }

    fn display_name(&self) -> &'static str {
        "GPUI"
    }

    /// On the main thread the task runs before post returns, because the library waits there for the result of the
    /// task that it posts; another thread queues it for the main thread.
    fn post(&self, task: Box<dyn FnOnce() + Send>) -> port::Result<()> {
        if service::is_main_thread() {
            task();
            return Ok(());
        }
        service::post(Box::new(move |_| task())).map_err(port::Error::from)
    }

    fn spawn_blocking(&self, task: port::BlockingBody) -> BlockingTask {
        crate::blocking(task)
    }

    fn quit(&self) {
        // default: a quit that the service can no longer reach ends nothing, because the application already ended.
        let _ = service::post(Box::new(|cx: &mut App| cx.quit()));
    }

    fn config_dir(&self) -> port::Result<PathBuf> {
        crate::platform::config_dir().map_err(port::Error::from)
    }

    fn home_dir(&self) -> port::Result<PathBuf> {
        crate::platform::home_dir().map_err(port::Error::from)
    }

    fn choose_folder(&self, window: &port::Window, title: &str) -> port::Result<Option<PathBuf>> {
        let parent = crate::frontend::record(window.label())
            .ok_or_else(|| port::Error::from(format!("window {} is not open", window.label())))?
            .window_handle() as usize;
        let title = title.to_string();
        service::on_main(move || crate::platform::choose_folder(parent as *mut c_void, &title))
            .map_err(port::Error::from)?
            .map_err(port::Error::from)
    }

    fn save_file(
        &self,
        window: &port::Window,
        name: &str,
        directory: Option<&std::path::Path>,
    ) -> port::Result<Option<PathBuf>> {
        let parent = crate::frontend::record(window.label())
            .ok_or_else(|| port::Error::from(format!("window {} is not open", window.label())))?
            .window_handle() as usize;
        let name = name.to_string();
        let directory = directory.map(std::path::Path::to_path_buf);
        service::on_main(move || {
            crate::platform::save_file(parent as *mut c_void, &name, directory)
        })
        .map_err(port::Error::from)?
        .map_err(port::Error::from)
    }

    fn set_menu(&self, menus: Vec<soksak_host::menu::Menu>) -> port::Result<()> {
        let app = application();
        service::on_main(move || crate::menu::set_menu(&app, menus))
            .map_err(port::Error::from)?
            .map_err(port::Error::from)
    }

    fn install_dock(&self, new_window: Box<dyn Fn()>) -> port::Result<()> {
        // The application delegate of GPUI answers the dock menu request, so the menu goes through the
        // dock menu of GPUI and its action runs the new window item.
        DOCK_NEW_WINDOW.with(|item| *item.borrow_mut() = Some(new_window));
        service::post(Box::new(|cx: &mut App| {
            cx.set_dock_menu(vec![gpui::MenuItem::Action {
                name: "새 창".into(),
                action: Box::new(DockNewWindow),
                os_action: None,
                checked: false,
                disabled: false,
            }]);
        }))
        .map_err(port::Error::from)
    }

    fn new_window(&self, options: WindowOptions) -> port::Result<Arc<dyn port::Frontend>> {
        soksak_host::platform::current()?;
        let app = application();
        let (sender, receiver) = std::sync::mpsc::channel();
        service::post(Box::new(move |cx: &mut App| {
            // default: a receiver that ended before the window opened drops its answer.
            let _ = sender.send(open_window(&app, options, cx));
        }))
        .map_err(port::Error::from)?;
        receiver
            .recv()
            .map_err(|_| port::Error::from("the main thread ended before it opened the window"))?
    }

    fn windows(&self) -> Vec<Arc<dyn port::Frontend>> {
        let labels = frontend::labels();
        labels
            .iter()
            .filter_map(|label| frontend::record(label))
            .map(|record| Arc::new(Frontend::new(record)) as Arc<dyn port::Frontend>)
            .collect()
    }

    fn get_webview(&self, label: &str) -> Option<(Arc<dyn port::Frontend>, String)> {
        for window in frontend::labels() {
            if let Some(record) = frontend::record(&window)
                && record
                    .webview_labels()
                    .iter()
                    .any(|webview| webview == label)
            {
                return Some((Arc::new(Frontend::new(record)), label.to_string()));
            }
        }
        None
    }
}

/// Creates the main window of the application on the main thread of the launch, before the setup of the library
/// registers it. A failure ends the process with its error.
pub(crate) fn create_main_window(
    app: &AppHandle,
    cx: &mut App,
) -> Result<Arc<dyn port::Frontend>, String> {
    open_window(
        app,
        WindowOptions {
            label: "main".into(),
            url: String::new(),
            title: "soksak / GPUI".into(),
            width: 1200.0,
            height: 760.0,
            background: port::Color(0x10, 0x11, 0x17, 0xff),
        },
        cx,
    )
    .map_err(|error| error.to_string())
}

/// Opens one window of the host: the GPUI window, its main wry web view and the record of the port.
fn open_window(
    app: &AppHandle,
    options: WindowOptions,
    cx: &mut App,
) -> port::Result<Arc<dyn port::Frontend>> {
    let bounds = gpui::Bounds {
        origin: gpui::Point::new(gpui::px(0.), gpui::px(0.)),
        size: gpui::Size::new(
            gpui::px(options.width as f32),
            gpui::px(options.height as f32),
        ),
    };
    let handle = cx
        .open_window(
            gpui::WindowOptions {
                window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
                titlebar: Some(gpui::TitlebarOptions {
                    title: Some(options.title.clone().into()),
                    // The content extends under the title bar and the page draws its first row there, as the
                    // other hosts place their windows (docs/spec/hosts.md#window-buttons).
                    appears_transparent: true,
                    traffic_light_position: None,
                }),
                // The window is shown after register has prepared the presentation of the first screen.
                show: false,
                kind: gpui::WindowKind::Normal,
                is_movable: true,
                app_owns_titlebar_drag: false,
                is_resizable: true,
                is_minimizable: true,
                window_background: gpui::WindowBackgroundAppearance::Opaque,
                ..Default::default()
            },
            |_, cx| cx.new(|_| crate::Shell),
        )
        .map_err(|error| port::Error::from(format!("open window: {error}")))?;
    let record = Arc::new(Record::new(options.label.clone()));
    let created = handle
        .update(cx, |_shell, window, _cx| {
            let view = crate::platform::main_webview(
                window,
                app.clone(),
                &options.label,
                options.background,
            );
            let window = crate::platform::ns_window_of(window);
            (view, window)
        })
        .map_err(|_| port::Error::from("the window ended before it opened"))?;
    let (view, window) = created;
    let view = view.map_err(|error| {
        soksak_host::application_log::log_error("new window", error.clone());
        port::Error::from("the main web view of the window could not be created")
    })?;
    let window = window.map_err(|error| {
        soksak_host::application_log::log_error("new window", error.clone());
        port::Error::from("the native window of the window could not be read")
    })?;
    record.set_window(window);
    record.add_webview(options.label.clone(), view);
    frontend::register(options.label.clone(), Arc::clone(&record));
    handle
        .update(cx, |_shell, window, cx| {
            window.on_window_should_close(cx, {
                let record = Arc::clone(&record);
                move |_, _| !record.closing_kept()
            });
        })
        .map_err(|_| port::Error::from("the window ended before it opened"))?;
    Ok(Arc::new(Frontend::new(record)))
}
