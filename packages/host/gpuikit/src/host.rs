//! The GPUI framework adapter of the Rust language host library: `run`, and the Framework and Frontend of the
//! library port on GPUI (docs/spec/hosts.md).

mod bindings;
mod framework;
mod frontend;
mod menu;
#[path = "platform/platform.rs"]
mod platform;
mod service;

use std::sync::Arc;

pub use framework::Framework;
pub use frontend::Frontend;
use gpui::{App, Styled as _};
use gpui_kit as gpui;
pub use menu::key_equivalent;
use soksak_host::assets::Assets;
use soksak_host::framework::{AppHandle, BlockingBody, BlockingTask};
use soksak_host::{RunEvent, Setup};

/// The application of the adapter.
pub(crate) fn app() -> AppHandle {
    framework::application()
}

/// The origin that serves the page files of the host, as tauriv2 serves its pages from tauri://localhost. The
/// start documents of the soksak scheme answer their CORS header with it.
pub(crate) const PAGE_APP_ORIGIN: &str = "app://localhost";

/// The page assets of the host, which run holds and the app scheme serves.
static PAGE_ASSETS: std::sync::OnceLock<soksak_host::assets::ReportingAssets> =
    std::sync::OnceLock::new();

/// The page assets of the app scheme.
pub(crate) fn page_assets() -> &'static soksak_host::assets::ReportingAssets {
    PAGE_ASSETS
        .get()
        .expect("run holds the page assets before a page loads")
}

/// The asynchronous runtime of the library, which run starts once and the blocking tasks of the port use.
static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();

/// Runs a blocking task of the library on the asynchronous runtime of the library.
pub(crate) fn blocking(task: BlockingBody) -> BlockingTask {
    let running = RUNTIME
        .get()
        .expect("run starts the asynchronous runtime before the framework blocks work")
        .spawn_blocking(task);
    Box::pin(async move {
        running
            .await
            .map_err(|error| soksak_host::framework::Error::from(format!("blocking task: {error}")))
    })
}

/// The asynchronous runtime of the library, which run started.
pub(crate) fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME
        .get()
        .expect("run starts the asynchronous runtime before the framework blocks work")
}

/// The script that runs when each document starts: the call channel of the page runtime over the ipc entry of wry.
pub(crate) const BOOTSTRAP: &str = r#"
(() => {
  const epoch = `${Date.now()}-${Math.random()}`;
  const pending = new Map();
  const listeners = new Map();
  let stream = null;
  let serial = 0;
  window.__soksak = {
    call(method, args) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        try {
          window.ipc.postMessage(JSON.stringify({ epoch, id, method, args }));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return Promise.resolve(() => listeners.get(name)?.delete(fn));
    },
    event(name, data) {
      // default: no listener is registered for that event, so there is nobody to notify.
      for (const fn of listeners.get(name) ?? []) fn(data);
    },
    onStream(fn) {
      stream = fn;
    },
    stream(text) {
      stream?.(JSON.parse(text));
    },
    receive(message) {
      if (message.event) {
        // default: no listener is registered for that event, so there is nobody to notify.
        for (const fn of listeners.get(message.event) ?? []) fn(message.data);
        return;
      }
      if (message.epoch !== epoch) return;
      const reply = pending.get(message.id);
      if (!reply) return;
      pending.delete(message.id);
      if (message.error) reply.reject(new Error(message.error));
      else reply.resolve(message.result);
    },
  };
})();
"#;

/// The root view of a GPUI window of the host: the wry web view of the record covers the window, and GPUI draws
/// the background of the window behind it.
pub(crate) struct Shell;

impl gpui::Render for Shell {
    fn render(
        &mut self,
        _window: &mut gpui::Window,
        _cx: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        gpui::div().size_full()
    }
}

/// Creates the application and runs it until it exits.
///
/// frontend is the staged workbench page, which the app scheme serves. The wry web views of the host carry the
/// soksak scheme of the start documents and the app scheme of the page files.
pub fn run(frontend: Arc<dyn Assets>) {
    soksak_host::start_process();
    soksak_host::prepare_platform();
    RUNTIME.get_or_init(|| {
        soksak_host::routine::async_runtime().expect(
            "the asynchronous runtime of the library starts before the framework blocks work",
        )
    });
    let app = AppHandle::new(Arc::new(Framework));
    framework::bind(&app);
    soksak_host::manage_start_state(&app);
    let installed_directory = Arc::new(std::sync::OnceLock::new());
    let page = soksak_host::page_assets(Arc::clone(&frontend), installed_directory.clone());
    PAGE_ASSETS.get_or_init(|| page);
    let startup_app = app.clone();
    gpui::application().run(move |cx: &mut App| {
        service::start(cx);
        cx.on_action::<crate::framework::DockNewWindow>(|_action, _cx| {
            crate::framework::DOCK_NEW_WINDOW.with(|item| {
                if let Some(new_window) = item.borrow().as_ref() {
                    new_window();
                }
            });
        });
        platform::register_deep_links(startup_app.clone());
        // A platform that cannot provide this step ends with status 1 before it opens a window.
        // default: a failed step ended the process inside exit_on_failure, so the answer states its success.
        let _ = soksak_host::startup::exit_on_failure(soksak_host::start_endpoint(&startup_app));
        // The main window of the configuration comes from the framework: the application of GPUI has no
        // configuration that declares it, so the adapter creates it before the setup of the library.
        let _ = soksak_host::startup::exit_on_failure(
            framework::create_main_window(&startup_app, cx)
                .map(|_| ())
                .map_err(|error| Box::<dyn std::error::Error>::from(error)),
        );
        // default: a failed step ended the process inside exit_on_failure, so the answer states its success.
        let _ = soksak_host::startup::exit_on_failure(soksak_host::setup(
            &startup_app,
            Setup {
                frontend,
                installed_directory,
                // The Apple event handler of register_deep_links receives the link that launched the application
                // and every link that arrives while it runs.
                deep_links: Box::new(|_host| {}),
            },
        ));
        soksak_host::run_event(&startup_app, RunEvent::Ready);
    });
}
