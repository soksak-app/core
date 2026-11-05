//! The Tauri v2 framework adapter of the Rust language host library: `run`, and the Framework and Frontend of the
//! library port on Tauri (docs/spec/hosts.md#mygo-host).

mod bindings;
mod framework;
mod frontend;
mod menu;
#[path = "platform/platform.rs"]
mod platform;

use std::borrow::Cow;
use std::cell::RefCell;
use std::sync::{Arc, OnceLock};

use soksak_host::application_log::log_error;
use soksak_host::framework::AppHandle;
use soksak_host::{ExitRequestApi, RunEvent};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri_plugin_deep_link::DeepLinkExt;

pub use framework::Framework;
pub use frontend::{Frontend, window_event};
pub use menu::accelerator;

/// The origin of the main page, which the start document answers with CORS.
pub const PAGE_ORIGIN: &str = "tauri://localhost";

/// The frontend of the context while run replaces it: no page file.
struct NoAssets;

impl tauri::Assets<tauri::Wry> for NoAssets {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// The bundled frontend as the page files of the library.
struct BundledAssets(Arc<dyn tauri::Assets<tauri::Wry>>);

impl soksak_host::assets::Assets for BundledAssets {
    fn get(&self, key: &str) -> Option<Cow<'_, [u8]>> {
        self.0.get(&AssetKey::from(key))
    }
}

/// The key of the start document, which the asset resolver of Tauri serves for a path that names no file.
const START: &str = "/index.html";

thread_local! {
    /// The path that the page files did not hold in the lookup that the current thread runs, and whether it names a file,
    /// which a file extension shows.
    static MISSING: RefCell<Option<(String, bool)>> = const { RefCell::new(None) };
}

/// What a lookup of the asset resolver of Tauri is.
enum Lookup {
    /// The lookup of a path of the page.
    Request,
    /// `<path>.html` or `<path>/index.html` after a missing path.
    Candidate,
    /// The fallback to the start document after a missing path.
    Start,
}

/// The page files of the library behind the asset resolver of Tauri, which looks up `<path>`, `<path>.html` and
/// `<path>/index.html` of a request and then falls back to the start document. Only the first lookup is a request of the
/// page, and the start document does not answer a missing path with a file extension, so Tauri answers its asset error.
pub struct PageLookups {
    page: soksak_host::assets::ReportingAssets,
}

impl PageLookups {
    pub fn new(page: soksak_host::assets::ReportingAssets) -> Self {
        Self { page }
    }

    /// The bytes of the file of a lookup of the asset resolver.
    pub fn get(&self, key: &str) -> Option<Cow<'_, [u8]>> {
        let lookup = MISSING.with(|missing| {
            let mut missing = missing.borrow_mut();
            let lookup = match missing.as_ref() {
                Some((base, _))
                    if key == format!("{base}.html") || key == format!("{base}/index.html") =>
                {
                    Lookup::Candidate
                }
                Some((_, true)) if key == START => Lookup::Start,
                _ => Lookup::Request,
            };
            if !matches!(lookup, Lookup::Candidate) {
                *missing = None;
            }
            lookup
        });
        match lookup {
            Lookup::Start => None,
            Lookup::Candidate => self.page.held(key),
            Lookup::Request => {
                let found = soksak_host::assets::Assets::get(&self.page, key);
                if found.is_none() {
                    let file = std::path::Path::new(key).extension().is_some();
                    MISSING.with(|missing| *missing.borrow_mut() = Some((key.to_string(), file)));
                }
                found
            }
        }
    }
}

/// The page files of the library as the assets of the context. The bundled frontend lists the files and their hashes.
struct PageAssets {
    page: PageLookups,
    frontend: Arc<dyn tauri::Assets<tauri::Wry>>,
}

impl tauri::Assets<tauri::Wry> for PageAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.page.get(key.as_ref())
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.frontend.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.frontend.csp_hashes(html_path)
    }
}

/// The web view handle of a Tauri web view.
#[cfg(any(target_os = "macos", windows))]
fn webview_of(app: &AppHandle, webview: &tauri::Webview) -> soksak_host::framework::Webview {
    app.webview_of(Arc::new(Frontend::new(webview.window())), webview.label())
}

/// Whether the application activates itself at launch while another application is active. Launch Services activates an
/// application that it launches unless the launch requested no activation (`open -g`, kLSLaunchDontSwitch,
/// NSWorkspaceOpenConfiguration.activates false), so the application leaves that decision to the system; Tauri activates
/// regardless by default, which brings a background launch to the front (docs/spec/hosts.md#launch-activation).
pub fn launch_activates_ignoring_other_apps() -> bool {
    false
}

/// Activates the application at launch as the host decides (docs/spec/hosts.md#launch-activation).
fn launch_activation(
    builder: tauri::Builder<tauri::Wry>,
) -> Result<tauri::Builder<tauri::Wry>, String> {
    soksak_host::platform::current()?;
    platform::launch_activation(builder, launch_activates_ignoring_other_apps())
}

/// Gives Tauri the asynchronous runtime of the host, before anything asks for the default runtime of Tauri, which holds one worker
/// for each processor. A runtime that cannot start ends the process with status 1 before it opens a window. The runtime lives
/// until the process ends, as Tauri requires of a runtime that it is given.
fn set_async_runtime() {
    let runtime = match soksak_host::routine::async_runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("asynchronous runtime: {error}");
            std::process::exit(1);
        }
    };
    tauri::async_runtime::set(Box::leak(Box::new(runtime)).handle().clone());
}

/// Creates the application and runs it until it exits.
///
/// context is the `tauri::generate_context!()` of the application. background is the script that the surface webviews
/// run before the document, and the application passes it including the `background.js` of the frontend.
pub fn run(mut context: tauri::Context<tauri::Wry>, _background: &'static str) {
    soksak_host::start_process();
    set_async_runtime();
    // Installed plugins are provided from the configuration folder (docs/spec/installation.md). setup decides the
    // configuration folder.
    let installed_directory = Arc::new(OnceLock::new());
    let frontend: Arc<dyn tauri::Assets<tauri::Wry>> =
        Arc::from(context.set_assets(Box::new(NoAssets)));
    let bundled: Arc<dyn soksak_host::assets::Assets> =
        Arc::new(BundledAssets(Arc::clone(&frontend)));
    context.set_assets(Box::new(PageAssets {
        page: PageLookups::new(soksak_host::page_assets(
            Arc::clone(&bundled),
            installed_directory.clone(),
        )),
        frontend,
    }));
    soksak_host::prepare_platform();
    let app = AppHandle::new(Arc::new(Framework));
    soksak_host::manage_start_state(&app);
    // The plugin setup runs before the window of the settings file is created, so the endpoint is opened here.
    let endpoint_app = app.clone();
    let endpoint = tauri::plugin::Builder::<tauri::Wry>::new("endpoint")
        .setup(move |tauri_app, _api| {
            framework::bind(tauri_app);
            soksak_host::startup::exit_on_failure(soksak_host::start_endpoint(&endpoint_app))
        })
        .build();
    // A platform that cannot provide this step ends with status 1 before it opens a window.
    let builder = match launch_activation(tauri::Builder::default()) {
        Ok(builder) => builder,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let scheme_app = app.clone();
    #[cfg(any(target_os = "macos", windows))]
    let terminated_app = app.clone();
    let setup_app = app.clone();
    let menu_app = app.clone();
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(app.clone())
        .plugin(endpoint)
        // The main page is fetched with a scheme that knows the webview that requested the start document
        // (docs/spec/native-host.md#page-start).
        .register_uri_scheme_protocol(soksak_host::start::SCHEME, move |context, request| {
            soksak_host::start::serve(
                PAGE_ORIGIN,
                // default: a request without a host names no owner, so serve answers it not found.
                request.uri().host().unwrap_or_default(),
                request.uri().path(),
                context.webview_label(),
                &mut |webview| soksak_host::start::start_page(&scheme_app, webview),
            )
        });
    // Tauri offers this hook only on macOS and iOS.
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(move |webview| {
        soksak_host::web_content_process_terminated(&webview_of(&terminated_app, webview))
    });
    #[cfg(windows)]
    let builder = builder.plugin(crate::platform::process_failure_plugin(move |webview| {
        soksak_host::web_content_process_terminated(&webview_of(&terminated_app, webview))
    }));
    builder
        .setup(move |tauri_app| {
            let deep = tauri_app.handle().clone();
            soksak_host::startup::exit_on_failure(soksak_host::setup(
                &setup_app,
                soksak_host::Setup {
                    frontend: bundled,
                    installed_directory,
                    deep_links: Box::new(move |host| {
                        let opened = host.clone();
                        deep.deep_link().on_open_url(move |event| {
                            for url in event.urls() {
                                soksak_host::deep_link::open(&opened, url.to_string());
                            }
                        });
                        match deep.deep_link().get_current() {
                            Ok(Some(urls)) => {
                                for url in urls {
                                    soksak_host::deep_link::open(host, url.to_string());
                                }
                            }
                            Ok(None) => {}
                            Err(error) => log_error("deep link", format!("launch URL: {error}")),
                        }
                    }),
                },
            ))
        })
        .on_menu_event(move |_tauri_app, event| {
            soksak_host::menu_event(&menu_app, event.id().as_ref())
        })
        .invoke_handler(bindings::handler())
        .build(context)
        .expect("failed to build the tauri application")
        .run(move |_tauri_app, event| {
            let (host_event, exit) = match &event {
                tauri::RunEvent::Ready => (RunEvent::Ready, None),
                tauri::RunEvent::ExitRequested { code, api, .. } => {
                    let answer = ExitRequestApi::default();
                    (
                        RunEvent::ExitRequested {
                            code: *code,
                            api: answer.clone(),
                        },
                        Some((api, answer)),
                    )
                }
                tauri::RunEvent::Exit => (RunEvent::Exit, None),
                _ => return,
            };
            soksak_host::run_event(&app, host_event);
            if let Some((api, answer)) = exit
                && answer.prevented()
            {
                api.prevent_exit();
            }
        });
}
