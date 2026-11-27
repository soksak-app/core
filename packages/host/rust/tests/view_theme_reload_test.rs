//! A view that a main page reload creates applies the theme of the window: its start script reads the theme current at its
//! creation, and its page writes that theme as the record page.theme.applied (docs/spec/native-surfaces.md#view-surfaces).
//! The test runs in a real window with the view channel of the application.

use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "support/folder.rs"]
mod folder;
#[path = "support/main_thread.rs"]
mod main_thread;
#[path = "support/records.rs"]
mod records;
#[path = "support/sidecar_recorder.rs"]
mod sidecar_recorder;
#[path = "support/surface_fixture.rs"]
mod surface_fixture;
// The test framework of the library names the framework and the menu of the host through these paths.
mod framework {
    pub use soksak_host::framework::*;
}
mod menu {
    pub use soksak_host::menu::*;
}
#[cfg(target_os = "macos")]
#[path = "support/platform/darwin/surface_drawing.rs"]
mod surface_drawing;
#[path = "support/framework.rs"]
#[allow(dead_code)]
mod test_framework;

fn main() {
    main_thread::run(TESTS);
}

const TESTS: &[main_thread::MainTest] = &[(
    "a_view_created_after_a_main_page_reload_applies_the_current_theme",
    a_view_created_after_a_main_page_reload_applies_the_current_theme,
)];

const SURFACE: &str = "theme-surface";

/// The layout of the theme surface, shown or hidden, on a window of 500 by 400 points.
fn layout_request(visible: bool) -> Result<soksak_host::surfaces::SyncRequest, String> {
    serde_json::from_value(serde_json::json!({
        "settled": true,
        "titlebar": 40.0,
        "viewport": { "width": 500.0, "height": 400.0 },
        "declarations": [{ "commands": [], "element": [] }],
        "overlays": [],
        "surfaces": [{
            "id": SURFACE, "x": 0.0, "y": 0.0, "w": 500.0, "h": 400.0,
            "visible": visible, "dim": false, "plugin": "probe",
            "composition": { "kind": "view", "page": "ui/page.html", "regions": [{ "name": "view", "kind": "image", "sidecar": surface_fixture::ECHO, "present": "copy", "input": "dom" }] },
            "start": {
                "origin": { "directory": null },
                "diagnostics": null, "section": null, "dialog": null,
                "process": "plugin", "declarations": 0,
            },
            "programs": {},
        }],
    }))
    .map_err(|error| error.to_string())
}

/// The page.theme.applied records that the log of the configuration folder holds, after a flush of the writer, once there are count.
fn wait_for_theme_records(
    log: &soksak_host::event_log::EventLog,
    config: &std::path::Path,
    count: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        log.flush()?;
        let records: Vec<serde_json::Value> =
            records::read_events(&records::event_log_path(config))
                .into_iter()
                .filter(|event| event["event"] == "page.theme.applied")
                .collect();
        if records.len() >= count {
            return Ok(records);
        }
        if Instant::now() >= deadline {
            let names: Vec<String> = records::read_events(&records::event_log_path(config))
                .into_iter()
                .map(|event| format!("{}:{}", event["level"], event["event"]))
                .collect();
            let errors: Vec<serde_json::Value> =
                records::read_events(&records::event_log_path(config))
                    .into_iter()
                    .filter(|event| event["event"] == "native.record.error")
                    .collect();
            return Err(format!(
                "{} page.theme.applied records, want {count}: the view wrote no record of the theme; events {names:?}; errors {errors:?}",
                records.len()
            ));
        }
        // The view loads through the main run loop, so the wait runs that loop instead of sleeping on the main thread.
        pump(Duration::from_millis(10));
    }
}

#[cfg(target_os = "macos")]
fn pump(duration: Duration) {
    use core_foundation::runloop::{CFRunLoop, kCFRunLoopDefaultMode};
    CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, duration, false);
}

fn a_view_created_after_a_main_page_reload_applies_the_current_theme() -> Result<(), String> {
    use soksak_host::framework::{Manager, Window};
    use soksak_host::{installed, surfaces, theme, windows};
    let config = folder::Folder::new();
    surface_fixture::install_probe_plugin(config.path());
    // The layout of a view surface reads the configuration directory of the host, which the application arguments name.
    soksak_host::set_arguments_for_tests(config.path());
    // The view configuration runs the view channel script of the application before its page, so the page reads window.sokView.
    soksak_host::documents::set_view_channel(include_str!("../../../plugin-api/view-start.js"))?;
    let log = records::start_writer(config.path());
    // The application serves the pages of installed plugins through the core root resolver of its configuration folder.
    soksak_host::installed::register_core_root(
        soksak_host::platform::current()?,
        config.path().to_path_buf(),
        Arc::new(|_: &str| None),
    )?;
    // The view pages import through the view import map of the staged frontend, which the application sets before any view loads.
    soksak_host::installed::register_view_import_map(
        soksak_host::platform::current()?,
        Arc::new(|name: &str| {
            (name == "view-imports.json").then(|| {
                br#"{"imports":{"soksak":"soksak://core/modules/soksak/dist/index.js"}}"#.to_vec()
            })
        }),
    )?;
    let (native, main) = surface_drawing::create_main_window()?;
    let (app, framework) = test_framework::application_with_queue();
    let frontend = Arc::new(test_framework::FixtureFrontend::with_main_webview(
        native as usize,
        main as usize,
        Ok(1),
    ));
    framework.add_window(frontend.clone());
    let webview = app.webview_of(frontend, "fixture");
    let records = Arc::new(windows::WindowData::default());
    soksak_host::manage_start_state(&app);
    // The view messages of the window write their records through the event log of the application.
    app.manage(log.clone());
    windows::register_records(&app.state::<windows::Windows>(), "fixture", records.clone());
    let sidecars = installed::new_installed_sidecars::<Window>(config.path().to_path_buf());
    let outcome = sidecars.and_then(|sidecars| {
        app.manage(sidecars);
        let window = webview.window();
        (|| -> Result<(), String> {
            // The theme of the window is the theme that the page selected before the reload; the view created after the reload
            // reads it in its start script.
            theme::set(
                &window,
                serde_json::from_value(serde_json::json!({
                    "scheme": "dark",
                    "tokens": { "surface": "#101010" },
                }))
                .map_err(|error| error.to_string())?,
            )?;
            // The page declares its surfaces when it starts, and a reload of the page ends the declarations of the old page.
            let declare_surface = || {
                surfaces::declare(
                &webview,
                serde_json::from_value(serde_json::json!({
                    "surface": SURFACE,
                    "plugin": "probe",
                    "composition": { "kind": "view", "page": "ui/page.html", "regions": [{ "name": "view", "kind": "image", "sidecar": surface_fixture::ECHO, "present": "copy", "input": "dom" }] },
                }))
                .map_err(|error| error.to_string())?,
                )
            };
            declare_surface()?;
            windows::register_view_source_event_stream(
                &webview,
                soksak_host::framework::Channel::new(|_| Ok(())),
            )?;
            // The first layout creates the view and its page, which writes the theme of the window.
            surfaces::sync(&window, layout_request(false)?)?;
            surfaces::sync(&window, layout_request(true)?)?;
            let before = wait_for_theme_records(&log, config.path(), 1)?;
            // The main page reload ends the view documents; the layout that follows creates the view of the reloaded page.
            windows::reload_surface_documents_for_test(&window)?;
            declare_surface()?;
            surfaces::sync(&window, layout_request(false)?)?;
            surfaces::sync(&window, layout_request(true)?)?;
            let after = wait_for_theme_records(&log, config.path(), 2)?;
            let want = serde_json::json!({ "scheme": "dark", "source": "start", "surface": SURFACE });
            let first = &before[0]["fields"];
            if first["scheme"] != "dark" || first["source"] != "start" || first["surface"] != SURFACE {
                return Err(format!("the view before the reload recorded {first}, want {want}"));
            }
            let reloaded = &after[1]["fields"];
            if reloaded["scheme"] != "dark" || reloaded["source"] != "start" || reloaded["surface"] != SURFACE {
                return Err(format!("the view after the reload recorded {reloaded}, want {want}"));
            }
            Ok(())
        })()
    });
    let closed = surface_drawing::close_window(native);
    let store =
        surface_drawing::end_document_store(&config.path().join("document-data").to_string_lossy());
    outcome.and(closed).and(store)
}
