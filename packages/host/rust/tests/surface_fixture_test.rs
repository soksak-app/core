//! The installed probe plugin of the surface tests reads back through the installation readers, with its page in its folder.

use std::sync::Arc;

#[path = "support/folder.rs"]
mod folder;
#[path = "support/main_thread.rs"]
mod main_thread;
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
#[path = "support/framework.rs"]
#[allow(dead_code)]
mod test_framework;
#[cfg(target_os = "macos")]
#[path = "support/platform/darwin/surface_drawing.rs"]
mod surface_drawing;

fn main() {
    main_thread::run(TESTS);
}

const TESTS: &[main_thread::MainTest] = &[
    (
        "the_probe_plugin_installs_into_a_configuration_folder_with_its_page",
        the_probe_plugin_installs_into_a_configuration_folder_with_its_page,
    ),
    (
        "a_fixture_window_holds_the_native_window_it_was_given",
        a_fixture_window_holds_the_native_window_it_was_given,
    ),
    (
        "an_echo_sidecar_records_each_line_sent_to_it",
        an_echo_sidecar_records_each_line_sent_to_it,
    ),
    (
        "a_shown_surface_sends_the_drawing_state_of_its_region",
        a_shown_surface_sends_the_drawing_state_of_its_region,
    ),
    (
        "a_mounted_page_of_a_shown_surface_sends_the_drawing_state_after_apply",
        a_mounted_page_of_a_shown_surface_sends_the_drawing_state_after_apply,
    ),
    (
        "a_hidden_tab_selected_after_a_restart_sends_its_drawing_state",
        a_hidden_tab_selected_after_a_restart_sends_its_drawing_state,
    ),
];

/// The echo sidecar of the surface tests receives a line sent to it, which the file of its record holds after the stop.
fn an_echo_sidecar_records_each_line_sent_to_it() -> Result<(), String> {
    use sidecar_recorder::SendAsRecorder;
    let directory = folder::Folder::new();
    let sidecars = surface_fixture::echo_sidecars(&directory);
    let (owner, messages) = sidecar_recorder::owner("probe", "/projects/probe");
    let body = serde_json::value::RawValue::from_string(r#"{"operation":"ping"}"#.into())
        .map_err(|error| error.to_string())?;
    sidecars.send_as(&owner, surface_fixture::ECHO, "s1", &body)?;
    // The echo of the line is the event that the sidecar has read the line, so the stop follows its record.
    messages.recv().map_err(|error| error.to_string())?;
    sidecars.stop();
    let requests = surface_fixture::recorded_requests(&directory);
    if !requests.contains(r#""operation":"ping""#) {
        return Err(format!("the echo sidecar received {requests:?}"));
    }
    Ok(())
}

/// The window of a fixture with a real handle answers the handle through the frontend, so a platform call of the window reaches the
/// native window of the test.
fn a_fixture_window_holds_the_native_window_it_was_given() -> Result<(), String> {
    use soksak_host::framework::Frontend;
    let frontend = test_framework::FixtureFrontend::with_native(0xABC, Ok(1));
    let native = frontend.native_window().map_err(|error| format!("{error:?}"))?;
    if native as usize != 0xABC {
        return Err(format!("the window answers {:x}, want abc", native as usize));
    }
    Ok(())
}

fn the_probe_plugin_installs_into_a_configuration_folder_with_its_page() -> Result<(), String> {
    let config = folder::Folder::new();
    surface_fixture::install_probe_plugin(config.path());
    let (state, manifests) = soksak_sok::plugins::read_installed_manifests(config.path())
        .expect("the installed state reads back");
    if !state.plugins.get("probe").is_some_and(|plugin| plugin.enabled) {
        return Err("probe is not enabled".into());
    }
    if !manifests.contains_key("probe") {
        return Err("the manifest of probe does not read back".into());
    }
    let page = config.path().join("plugins/probe").join(&surface_fixture::probe_version()).join("ui/page.html");
    if !page.is_file() {
        return Err("the probe page is not in its installed folder".into());
    }
    let folder = soksak_host::installed::plugin_folder(config.path(), "probe")?;
    if folder != config.path().join("plugins/probe").join(&surface_fixture::probe_version()) {
        return Err(format!("probe resolves to {}", folder.display()));
    }
    Ok(())
}

const SURFACE: &str = "probe-surface";
const REGION: &str = "view";

/// The composition of the probe surface: a view with the image region `view` of the echo sidecar.
fn probe_composition() -> serde_json::Value {
    serde_json::json!({
        "kind": "view",
        "page": "ui/page.html",
        "regions": [{ "name": REGION, "kind": "image", "sidecar": surface_fixture::ECHO, "present": "copy", "input": "dom" }],
    })
}

/// A layout request with the probe surface, shown or hidden, on a window of 500 by 400 points.
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
            "composition": probe_composition(),
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

/// Reports whether a line that the echo sidecar recorded is a drawing state of the region of the probe surface that draws.
fn is_drawing_state(line: &str) -> bool {
    let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    let drawing = &message["body"]["image"]["drawing"];
    drawing["name"] == REGION && drawing["drawing"] == true
}

/// A shown surface sends the drawing state of its image region to the supplier, which is the flush after the layout of the
/// visibility change (surfaces.rs apply_surfaces). The test window and its main webview are real; the echo sidecar is the one
/// that the installed probe plugin declares, and its requests file is the observation.

/// Counts the drawing states that draw in the requests that the echo sidecar recorded.
fn count_drawing_states(requests: &str) -> usize {
    requests
        .lines()
        .filter(|line| is_drawing_state(line))
        .count()
}

/// Waits until the echo sidecar records a drawing state that draws beyond the first `after` of them, which the flush after the
/// layout sends on a routine thread.
fn wait_for_drawing_state(
    config: &std::path::Path,
    after: usize,
    what: &str,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let requests = surface_fixture::installed_echo_requests_so_far(config)?;
        if count_drawing_states(&requests) > after {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "{what} sent its region no drawing state that draws: {requests:?}"
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// The part of the surface scenario that runs after the region is placed while the surface is hidden.
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    /// The layout shows the surface, which sends the drawing state of the region.
    Shown,
    /// The layout shows the surface, then its page mounts again after a failed mount: the document begins a new generation of the
    /// surface, and the layout that follows keeps the surface shown, so it changes no visibility. The region of the new supplier must
    /// still receive the drawing state without a window change or a click.
    Mounted,
    /// The tab is hidden, its view restarts while it is hidden, and the layout that selects the tab shows the surface.
    Hidden,
}

fn a_shown_surface_sends_the_drawing_state_of_its_region() -> Result<(), String> {
    shown_surface_sends_drawing_state(Phase::Shown)
}

fn a_mounted_page_of_a_shown_surface_sends_the_drawing_state_after_apply() -> Result<(), String> {
    shown_surface_sends_drawing_state(Phase::Mounted)
}

fn a_hidden_tab_selected_after_a_restart_sends_its_drawing_state() -> Result<(), String> {
    shown_surface_sends_drawing_state(Phase::Hidden)
}

/// Places the probe surface with its region in a real window, and runs the part of the scenario that `phase` names. Each test is its
/// own process (`--exact`), because the application arguments of the test process are set once.
fn shown_surface_sends_drawing_state(phase: Phase) -> Result<(), String> {
    use soksak_host::framework::{Manager, Window};
    use soksak_host::sidecars::WindowSidecars;
    use soksak_host::{composition, images, installed, surfaces, windows};
    let config = folder::Folder::new();
    surface_fixture::install_probe_plugin(config.path());
    // The layout of a view surface reads the configuration directory of the host, which the application arguments name.
    soksak_host::set_arguments_for_tests(config.path());
    // The view configuration runs the view channel script before its page. The test supplies an empty script, as the Go host test
    // does for the bundled frontend of its start, so the test reads no file of another package.
    soksak_host::documents::set_view_channel("")?;
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
    // The states of the start of a host: the registry of the windows, the exposure and the background of the surfaces.
    soksak_host::manage_start_state(&app);
    windows::register_records(&app.state::<windows::Windows>(), "fixture", records.clone());
    let sidecars = installed::new_installed_sidecars::<Window>(config.path().to_path_buf());
    let outcome = sidecars.and_then(|sidecars| {
        app.manage(sidecars);
        let window = webview.window();
        let checked = (|| -> Result<(), String> {
            surfaces::declare(
                &webview,
                serde_json::from_value(serde_json::json!({
                    "surface": SURFACE,
                    "plugin": "probe",
                    "composition": probe_composition(),
                }))
                .map_err(|error| error.to_string())?,
            )?;
            // The first layout creates the surface and its view and hides the surface, so the region attaches to a hidden surface.
            // The main page registers the channel of the view source events at its start; the layout of a view surface needs it.
            windows::register_view_source_event_stream(&webview, soksak_host::framework::Channel::new(|_| Ok(())))?;

            surfaces::sync(&window, layout_request(false)?)?;
            images::attach(
                &webview,
                serde_json::from_value(serde_json::json!({
                    "surface": SURFACE,
                    "name": REGION,
                    "sidecar": surface_fixture::ECHO,
                }))
                .map_err(|error| error.to_string())?,
            )?;
            // The page places its region while the surface is hidden, which marks the region visible (composition.rs place).
            composition::place(
                &webview,
                serde_json::from_value(serde_json::json!({
                    "surface": SURFACE,
                    "revision": 1,
                    "regions": [{ "name": REGION, "left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0, "visible": true }],
                    "overlays": [],
                }))
                .map_err(|error| error.to_string())?,
            )?;
            // The window of the test is not on the screen of the person: a window behind another application is occluded, and the
            // test does not bring it to the front. The state that the platform reads at attach is replaced by the on-screen state
            // of the scenario, the same as the Go host test does, so the region draws when its surface shows.
            records.images.set_on_screen(true);
            if phase == Phase::Hidden {
                // The view restarts while the tab is hidden, which begins a new generation (documents.rs), and the layout selects the tab.
                records.images.begin_generation(SURFACE);
                surfaces::sync(&window, layout_request(true)?)?;
                wait_for_drawing_state(config.path(), 0, "selecting the hidden tab after its restart")?;
                return Ok(());
            }
            // The layout that shows the surface sends the drawing state of its region. The sends run on a routine thread that
            // reports no event to the test, so the test waits for their lines in the requests of the echo sidecar.
            surfaces::sync(&window, layout_request(true)?)?;
            wait_for_drawing_state(config.path(), 0, "showing the surface")?;
            if phase == Phase::Mounted {
                let before = count_drawing_states(&surface_fixture::installed_echo_requests_so_far(config.path())?);
                // The mounted page opens its document, which begins a new generation of the surface (documents.rs).
                records.images.begin_generation(SURFACE);
                surfaces::sync(&window, layout_request(true)?)?;
                wait_for_drawing_state(config.path(), before, "the mounted page and the layout after it")?;
            }
            Ok(())
        })();
        // The echo sidecar ends with its record, so its requests file is complete when the test reads it.
        window.state::<WindowSidecars>().stop();
        checked
    });
    let closed = surface_drawing::close_window(native);
    // The document data of the configuration folder is written by the web process until its store ends.
    let store = surface_drawing::end_document_store(&config.path().join("document-data").to_string_lossy());
    outcome.and(closed).and(store)
}
