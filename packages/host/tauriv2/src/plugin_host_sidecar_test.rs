//! The sidecar requests of a plugin host page (docs/plans/plugin-host-routes.md rules 2, 3 and 7, F229-1, F229-8).

// contract: plugin-host.sidecar.page-start-close
#[test]
fn the_page_start_closes_plugin_host_sessions_only() {
    use crate::plugin_host_sidecar::parse_session;
    // The page start closes the sessions of plugin hosts (rule 7). A surface and a state session are not plugin host sessions.
    assert_eq!(
        parse_session("plugin:probe:project-a:fixture-sidecar"),
        Some(("probe", "project-a", "fixture-sidecar"))
    );
    assert_eq!(parse_session("s1"), None);
    assert_eq!(parse_session("state:files:project-a"), None);
    assert_eq!(parse_session("plugin:probe:project-a"), None);
}

use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::value::RawValue;

use crate::plugin_host_sidecar::{
    close_plugin_host_sessions, close_project_plugin_sessions, close_window_plugin_sessions,
    is_plugin_session_of,
};
use crate::sidecars::{Failure, Message, Owner, SidecarDeclaration, Sidecars};
use crate::test_folder::Folder;

// contract: plugin-host.sidecar.send-checks, plugin-host.sidecar.surface-refusal
#[test]
fn a_sidecar_request_of_a_host_is_checked_before_its_send() {
    use crate::plugin_host_sidecar::{parse_session, plugin_send_root, refuse_surface_send};
    let session = "plugin:probe:project-a:fixture-sidecar";
    assert_eq!(
        plugin_send_root(
            "probe",
            "fixture-sidecar",
            session,
            true,
            true,
            Some("/fixture/root")
        ),
        Ok("/fixture/root".to_string())
    );
    assert_eq!(
        plugin_send_root("probe", "fixture-sidecar", session, true, true, None),
        Err("plugin host probe: project project-a is not held by this window".to_string())
    );
    assert_eq!(
        plugin_send_root("probe", "fixture-sidecar", session, true, true, Some("")),
        Err("plugin host probe: project project-a has no folder".to_string())
    );
    assert_eq!(
        plugin_send_root(
            "probe",
            "fixture-sidecar",
            session,
            false,
            true,
            Some("/fixture/root")
        ),
        Err("plugin host probe cannot use sidecar fixture-sidecar".to_string())
    );
    assert_eq!(
        plugin_send_root(
            "probe",
            "fixture-sidecar",
            "plugin:other:project-a:fixture-sidecar",
            true,
            true,
            Some("/r")
        ),
        Err(
            "plugin host probe cannot use sidecar session plugin:other:project-a:fixture-sidecar"
                .to_string()
        )
    );
    assert_eq!(
        parse_session(session),
        Some(("probe", "project-a", "fixture-sidecar"))
    );
    assert_eq!(
        parse_session("plugin:probe:project-a:fixture-sidecar:x"),
        None
    );
    assert_eq!(
        refuse_surface_send(session),
        Err(format!(
            "sidecar session {session} is reserved for a plugin host"
        ))
    );
    assert_eq!(refuse_surface_send("tab-1"), Ok(()));
}

// A window that shows no project refuses a plugin send with a named error, whichever project the session names
// (docs/plans/plugin-host-routes.md F229-1).
// contract: plugin-host.sidecar.release-shown-project
#[test]
fn a_plugin_send_is_refused_while_no_project_is_shown() {
    use crate::plugin_host_sidecar::plugin_send_root;
    let session = "plugin:probe:project-a:fixture-sidecar";
    assert_eq!(
        plugin_send_root(
            "probe",
            "fixture-sidecar",
            session,
            true,
            false,
            Some("/fixture/root")
        ),
        Err("plugin host probe: no project is shown".to_string())
    );
}

// A release clears the shown project of a window only when it is the released project, and a shown project that is still held
// stays (docs/plans/plugin-host-routes.md F229-1).
// contract: plugin-host.sidecar.release-shown-project
#[test]
fn a_release_clears_the_shown_project_only_when_it_is_the_released_one() {
    use crate::windows::clear_released_shown;
    let mut shown = "project-b".to_string();
    assert!(
        !clear_released_shown(&mut shown, "project-a"),
        "a release of a project that is not shown reported a cleared shown project"
    );
    assert_eq!(
        shown, "project-b",
        "a release of another project cleared the shown project"
    );
    assert!(
        clear_released_shown(&mut shown, "project-b"),
        "the release of the shown project did not report the clear"
    );
    assert_eq!(shown, "", "the released shown project is still shown");
}

// The sessions that end with the release of a project are the plugin sessions and the state sessions of that project
// (docs/plans/plugin-host-routes.md rule 7, F229-8).
// contract: plugin-host.sidecar.release-state-session
#[test]
fn a_release_ends_the_plugin_and_state_sessions_of_that_project() {
    use crate::plugin_host_sidecar::{is_project_session, parse_state_session};
    assert_eq!(
        parse_state_session("state:fixture-plugin:project-a"),
        Some(("fixture-plugin", "project-a"))
    );
    assert_eq!(
        parse_state_session("state:fixture-plugin:project-a:x"),
        None
    );
    assert_eq!(parse_state_session("plugin:fixture-plugin:project-a"), None);
    assert!(is_project_session(
        "state:fixture-plugin:project-a",
        "project-a"
    ));
    assert!(!is_project_session(
        "state:fixture-plugin:project-b",
        "project-a"
    ));
    assert!(is_project_session(
        "plugin:probe:project-a:fixture-sidecar",
        "project-a"
    ));
    assert!(!is_project_session(
        "plugin:probe:project-b:fixture-sidecar",
        "project-a"
    ));
    assert!(!is_project_session("tab-1", "project-a"));
}

const SIDECAR: &str = "fixture-sidecar";
const ROOT: &str = "/fixture/root";

#[derive(Clone)]
struct TestOwner(String);

impl Owner for TestOwner {
    fn key(&self) -> String {
        self.0.clone()
    }
    fn root(&self) -> Result<String, String> {
        Ok(ROOT.to_string())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, _failure: Failure) {}
}

fn owner(key: &str) -> TestOwner {
    TestOwner(key.to_string())
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.to_string()).unwrap()
}

/// The persistent sidecar fixture-sidecar that the plugin probe depends on. Its service endpoint is in config.
fn declared(executable: &Path, config: &Path) -> Sidecars<TestOwner> {
    Sidecars::new(
        &[SidecarDeclaration {
            name: SIDECAR.to_string(),
            folder: executable.to_path_buf(),
            data: br#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}"#.to_vec(),
            version: "0.0.1".to_string(),
            dependents: vec!["probe".to_string()],
        }],
        config.to_path_buf(),
    )
    .unwrap()
}

/// The service of fixture-sidecar in config. It answers hello, retain, close-owner and shutdown, and it sends each request
/// line that it reads to the returned receiver. It does not answer a close, so a closed surface stays in the closing list.
fn service(config: &Path) -> (Receiver<serde_json::Value>, JoinHandle<()>) {
    let directory = config.join("services/echo");
    std::fs::create_dir_all(&directory).unwrap();
    let socket = directory.join("fixture.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket,
        "token": "fixture-token"
    });
    std::fs::write(
        directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    let (requests, received) = channel();
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            requests.send(request.clone()).unwrap();
            let reply = match request["operation"].as_str() {
                Some("hello") => {
                    serde_json::json!({"operation": "hello", "protocol": 1, "ok": true})
                }
                Some("retain") => {
                    serde_json::json!({"operation": "retained", "request": request["request"], "ok": true, "closed": 0})
                }
                Some("close-owner") => {
                    serde_json::json!({"operation": "closed-owner", "request": request["request"], "ok": true})
                }
                Some("shutdown") => {
                    let reply = serde_json::json!({"operation": "shutdown", "request": request["request"], "ok": true});
                    writeln!(stream, "{}", reply).unwrap();
                    return;
                }
                _ => continue,
            };
            writeln!(stream, "{}", reply).unwrap();
        }
    });
    (received, thread)
}

/// Sends an open to the surface of the window, which starts the sidecar and records the surface and its root.
fn open_session(sidecars: &Sidecars<TestOwner>, window: &TestOwner, surface: &str, root: &str) {
    sidecars
        .send_plugin_with_cids(
            window,
            SIDECAR,
            surface,
            root,
            &raw(r#"{"operation":"open"}"#),
            &[],
        )
        .unwrap();
}

/// The surfaces that a close is pending for, sorted.
fn closing_surfaces(sidecars: &Sidecars<TestOwner>) -> Vec<String> {
    let mut surfaces: Vec<String> = sidecars
        .closing()
        .into_iter()
        .map(|closing| closing.surface)
        .collect();
    surfaces.sort();
    surfaces
}

// A plugin session first sent while the service of a retain starts is kept by that retain (docs/plans/plugin-host-routes.md
// rule 7, F229-7). The hook runs after the service started, and it sends the session before the sessions to keep are read.
// contract: plugin-host.sidecar.retain-during-start, sidecars.retain.keeps-session-first-sent-during-start
#[test]
fn a_retain_keeps_a_session_first_sent_during_its_start() {
    const SESSION: &str = "plugin:probe:project-a:fixture-sidecar";
    const STATE_SESSION: &str = "state:probe:project-a";
    let executable = Folder::new();
    let config = Folder::new();
    let (received, thread) = service(config.path());
    let slot: Arc<Mutex<Option<Arc<Sidecars<TestOwner>>>>> = Arc::new(Mutex::new(None));
    let hook_slot = slot.clone();
    let sidecars = declared(executable.path(), config.path()).with_retain_sending(move |name| {
        if name != SIDECAR {
            return;
        }
        let guard = hook_slot.lock().unwrap();
        let sidecars = guard
            .as_ref()
            .expect("the sidecars are set before the retain");
        open_session(sidecars, &owner("window-a"), SESSION, ROOT);
        sidecars
            .send_plugin_with_cids(
                &owner("window-a"),
                SIDECAR,
                STATE_SESSION,
                ROOT,
                &raw(r#"{"operation":"open"}"#),
                &[],
            )
            .unwrap();
    });
    let sidecars = Arc::new(sidecars);
    *slot.lock().unwrap() = Some(sidecars.clone());

    let closed = sidecars
        .retain_sessions(&[("listed".to_string(), "/project".to_string())])
        .unwrap();
    assert_eq!(closed, 0, "the service's closed count");
    let requests: Vec<serde_json::Value> = received.try_iter().collect();
    let retain = requests
        .iter()
        .find(|request| request["operation"] == "retain")
        .expect("the retain line reached the service");
    let kept = retain["surfaces"].as_array().unwrap();
    for item in [
        serde_json::json!({"surface": "listed", "root": "/project"}),
        serde_json::json!({"surface": SESSION, "root": ROOT}),
        serde_json::json!({"surface": STATE_SESSION, "root": ROOT}),
    ] {
        assert!(
            kept.contains(&item),
            "retain surfaces {kept:?} omitted {item}"
        );
    }
    // The hook holds the sidecars; clearing it breaks that reference before the stop.
    slot.lock().unwrap().take();
    sidecars.stop();
    thread.join().unwrap();
}

// A surface session first sent while retain starts a persistent service is included in the service's keep list.
// contract: sidecars.retain.keeps-surface-first-sent-during-start
#[test]
fn a_retain_keeps_an_ordinary_surface_first_sent_during_its_start() {
    const SURFACE: &str = "tab-during-retain-start";
    let executable = Folder::new();
    let config = Folder::new();
    let (received, thread) = service(config.path());
    let slot: Arc<Mutex<Option<Arc<Sidecars<TestOwner>>>>> = Arc::new(Mutex::new(None));
    let hook_slot = slot.clone();
    let sidecars = declared(executable.path(), config.path()).with_retain_sending(move |name| {
        if name != SIDECAR {
            return;
        }
        let guard = hook_slot.lock().unwrap();
        let sidecars = guard
            .as_ref()
            .expect("the sidecars are set before the retain");
        sidecars
            .send_with_cids(
                &owner("window-a"),
                SIDECAR,
                SURFACE,
                &raw(r#"{"operation":"open"}"#),
                &[],
            )
            .unwrap();
    });
    let sidecars = Arc::new(sidecars);
    *slot.lock().unwrap() = Some(sidecars.clone());

    let closed = sidecars
        .retain_sessions(&[("listed".to_string(), "/project".to_string())])
        .unwrap();
    assert_eq!(closed, 0, "the service's closed count");
    let requests: Vec<serde_json::Value> = received.try_iter().collect();
    let retain = requests
        .iter()
        .find(|request| request["operation"] == "retain")
        .expect("the retain line reached the service");
    let kept = retain["surfaces"].as_array().unwrap();
    assert!(kept.contains(&serde_json::json!({"surface": "listed", "root": "/project"})));
    assert!(
        kept.contains(&serde_json::json!({"surface": SURFACE, "root": ROOT})),
        "retain surfaces {kept:?} omitted the ordinary session sent during start"
    );
    slot.lock().unwrap().take();
    sidecars.stop();
    thread.join().unwrap();
}

// contract: sidecars.native-view-removal.retains-persistent-layout-session
#[test]
fn native_view_removal_does_not_close_a_persistent_layout_session() {
    use std::collections::HashSet;

    const SURFACE: &str = "tab-retained";
    let executable = Folder::new();
    let config = Folder::new();
    let (received, thread) = service(config.path());
    let sidecars = declared(executable.path(), config.path());
    let window = owner("window-a");
    open_session(&sidecars, &window, SURFACE, ROOT);
    let _hello = received.recv().unwrap();
    let open = received.recv().unwrap();
    assert_eq!(open["surface"], SURFACE);

    sidecars
        .native_views_removed(&window, &HashSet::from([SURFACE.to_string()]))
        .unwrap();
    let closes: Vec<_> = received
        .try_iter()
        .filter(|request| request["closed"] == true)
        .collect();
    sidecars.stop();
    thread.join().unwrap();
    assert!(
        closes.is_empty(),
        "native view removal closed the persistent session: {closes:?}"
    );
}

// contract: sidecars.retain.closes-sessions-absent-from-layout
#[test]
fn logical_retain_closes_a_persistent_session_absent_from_the_layout() {
    const SURFACE: &str = "tab-removed";
    let executable = Folder::new();
    let config = Folder::new();
    let (received, thread) = service(config.path());
    let sidecars = declared(executable.path(), config.path());
    let window = owner("window-a");
    open_session(&sidecars, &window, SURFACE, ROOT);
    let _hello = received.recv().unwrap();
    let _open = received.recv().unwrap();

    sidecars.retain_sessions(&[]).unwrap();
    let requests: Vec<_> = received.try_iter().collect();
    sidecars.stop();
    thread.join().unwrap();
    let retain = requests
        .iter()
        .find(|request| request["operation"] == "retain")
        .expect("the persistent service received retain");
    assert_eq!(
        retain["surfaces"],
        serde_json::json!([]),
        "logical retain included tab-removed after its layout ended"
    );
}

// Releasing a project closes the plugin sessions of that project that the holding window owns, and keeps the sessions of the
// projects that it still holds (docs/plans/plugin-host-routes.md rule 7).
// contract: plugin-host.sidecar.project-release
#[test]
fn a_project_release_closes_only_the_plugin_sessions_of_that_project() {
    const RELEASED: &str = "plugin:probe:project-a:fixture-sidecar";
    const HELD: &str = "plugin:probe:project-b:fixture-sidecar";
    let executable = Folder::new();
    let config = Folder::new();
    let (_received, thread) = service(config.path());
    let sidecars = declared(executable.path(), config.path());
    let window = owner("window-a");
    open_session(&sidecars, &window, RELEASED, ROOT);
    open_session(&sidecars, &window, HELD, "/fixture/other");
    open_session(&sidecars, &window, "fixture-surface", ROOT);

    close_project_plugin_sessions(&sidecars, &window, "project-a").unwrap();
    assert_eq!(
        closing_surfaces(&sidecars),
        [RELEASED],
        "the release closes the session of the released project only"
    );
    // The session of the project that is still held is still owned by the window: a close of that owner reaches it.
    sidecars
        .close_owned(&window, &|surface| surface == HELD)
        .unwrap();
    assert_eq!(
        closing_surfaces(&sidecars),
        [RELEASED, HELD],
        "the session of the project that is still held was not owned by the window"
    );
    sidecars.stop();
    thread.join().unwrap();
}

// The plugin host close closes the plugin sessions of its plugin that the calling window owns, and no other session
// (docs/plans/plugin-host-routes.md rule 7, pluginHostSidecarClose).
// contract: plugin-host.sidecar.close
#[test]
fn a_plugin_host_close_closes_only_the_callers_sessions_of_the_plugin() {
    let executable = Folder::new();
    let config = Folder::new();
    let (_received, thread) = service(config.path());
    let sidecars = declared(executable.path(), config.path());
    let window_a = owner("window-a");
    let window_b = owner("window-b");
    open_session(
        &sidecars,
        &window_a,
        "plugin:probe:project-a:fixture-sidecar",
        ROOT,
    );
    open_session(
        &sidecars,
        &window_a,
        "plugin:other:project-a:fixture-sidecar",
        ROOT,
    );
    open_session(
        &sidecars,
        &window_b,
        "plugin:probe:project-b:fixture-sidecar",
        "/fixture/other",
    );
    open_session(&sidecars, &window_a, "fixture-surface", ROOT);

    sidecars
        .close_owned(&window_a, &|surface| is_plugin_session_of(surface, "probe"))
        .unwrap();
    assert_eq!(
        closing_surfaces(&sidecars),
        ["plugin:probe:project-a:fixture-sidecar"],
        "the close of the plugin host closes the caller's sessions of its plugin only"
    );
    sidecars.stop();
    thread.join().unwrap();
}

// The plugin host close from the main webview of the window closes the owned plugin sessions of that plugin only
// (docs/plans/plugin-host-routes.md rule 7, pluginHostSidecarClose).
// contract: plugin-host.sidecar.close
#[test]
fn a_plugin_host_close_from_the_main_webview_closes_the_owned_sessions_of_the_plugin() {
    let executable = Folder::new();
    let config = Folder::new();
    let (_received, thread) = service(config.path());
    let sidecars = declared(executable.path(), config.path());
    let window = owner("window-a");
    open_session(
        &sidecars,
        &window,
        "plugin:probe:project-a:fixture-sidecar",
        ROOT,
    );
    open_session(
        &sidecars,
        &window,
        "plugin:other:project-a:fixture-sidecar",
        ROOT,
    );
    close_plugin_host_sessions(&sidecars, &window, "window-a", "window-a", "probe").unwrap();
    assert_eq!(
        closing_surfaces(&sidecars),
        ["plugin:probe:project-a:fixture-sidecar"],
        "the close from the main webview closes the sessions of its plugin only"
    );
    sidecars.stop();
    thread.join().unwrap();
}

// A plugin host close from another webview of the window is rejected and closes no session.
// contract: plugin-host.sidecar.close
#[test]
fn a_plugin_host_close_from_another_webview_is_rejected_and_closes_nothing() {
    let executable = Folder::new();
    let config = Folder::new();
    let (_received, thread) = service(config.path());
    let sidecars = declared(executable.path(), config.path());
    let window = owner("window-a");
    open_session(
        &sidecars,
        &window,
        "plugin:probe:project-a:fixture-sidecar",
        ROOT,
    );
    let error =
        close_plugin_host_sessions(&sidecars, &window, "other-webview", "window-a", "probe")
            .unwrap_err();
    assert!(
        error.contains("must come from the main webview of window-a"),
        "the rejection names the main webview: {error}"
    );
    assert_eq!(
        closing_surfaces(&sidecars),
        Vec::<String>::new(),
        "a call from another webview closes no session"
    );
    sidecars.stop();
    thread.join().unwrap();
}

// The page start closes every plugin session of the window and keeps its surfaces (docs/plans/plugin-host-routes.md rule 7).
// contract: plugin-host.sidecar.page-start
#[test]
fn a_page_start_closes_the_plugin_sessions_of_the_window_and_keeps_its_surfaces() {
    const SESSION: &str = "plugin:probe:project-a:fixture-sidecar";
    let executable = Folder::new();
    let config = Folder::new();
    let (_received, thread) = service(config.path());
    let sidecars = declared(executable.path(), config.path());
    let window = owner("window-a");
    open_session(&sidecars, &window, SESSION, ROOT);
    open_session(&sidecars, &window, "fixture-surface", ROOT);

    close_window_plugin_sessions(&sidecars, &window).unwrap();
    assert_eq!(
        closing_surfaces(&sidecars),
        [SESSION],
        "the page start closes the plugin session of the window and keeps its surface"
    );
    sidecars.stop();
    thread.join().unwrap();
}

// The creation of a plugin host keeps the restart stop of each sidecar that its plugin lists: only the open of a surface or the enable of
// the plugin clears a stop (docs/spec/plugin-host.md#restarts, docs/spec/sidecars.md#failure).
// contract: plugin-host.sidecar.stop-kept
#[test]
fn creating_a_plugin_host_keeps_the_restart_stop_of_its_sidecar() {
    use crate::plugin_host::{HostPlugin, HostView, PluginHostRestarts, PluginHosts, create_host};
    let executable = Folder::new();
    let config = Folder::new();
    let sidecars = declared(executable.path(), config.path());
    sidecars.stop_restarts_for_test(SIDECAR);
    let plugins = vec![HostPlugin {
        id: "probe".into(),
        page: "ui/host.html".into(),
        state: None,
        exposes: json!({}),
    }];
    let hosts = PluginHosts::default();
    let restarts = PluginHostRestarts::default();
    let wanted = hosts.missing(&plugins, &restarts);
    assert_eq!(wanted.len(), 1, "the plugin host of probe is not wanted");
    for plugin in &wanted {
        let view = HostView {
            directory: "/config/document-data",
            folder: "/config/plugins/probe",
            plugin: &plugin.id,
            page: &plugin.page,
        };
        let handle = create_host(
            "channel-script",
            view,
            |_channel, _view| Ok(1),
            |_handle, _address| Ok(true),
            |_handle| Ok(()),
        )
        .unwrap();
        hosts.insert(&plugin.id, handle);
    }
    assert!(
        sidecars.restart_stopped_for_test(SIDECAR),
        "the creation of the plugin host cleared the sidecar stop of its plugin"
    );
    sidecars.stop();
}

/// The owner of a test that records each sidecar failure that the window receives.
#[derive(Clone)]
struct RecordingOwner(Arc<Mutex<Vec<Failure>>>);

impl Owner for RecordingOwner {
    fn key(&self) -> String {
        "window-a".to_string()
    }
    fn root(&self) -> Result<String, String> {
        Ok(ROOT.to_string())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, failure: Failure) {
        self.0.lock().unwrap().push(failure);
    }
    fn decide_image_envelope(
        &self,
        _sidecar_name: &str,
        _surface: &str,
        _body: &RawValue,
        _response_sender: &dyn crate::sidecars::ResponseSender,
    ) -> crate::sidecars::ImageEnvelopeDecision {
        crate::sidecars::ImageEnvelopeDecision::NotImage
    }
}

/// A standard input and output declaration of fixture-sidecar that the plugin probe depends on (no persistent transport).
fn declared_stdio(executable: &Path, config: &Path) -> Sidecars<RecordingOwner> {
    Sidecars::new(
        &[SidecarDeclaration {
            name: SIDECAR.to_string(),
            folder: executable.to_path_buf(),
            data: br#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#
                .to_vec(),
            version: "0.0.1".to_string(),
            dependents: vec!["probe".to_string()],
        }],
        config.to_path_buf(),
    )
    .unwrap()
}

// A send of a plugin session while its sidecar is stopped by the restart limit is refused before any start, and the refusal reaches
// the owner window as the failure of the plugin session (docs/spec/sidecars.md#failure, docs/spec/plugin-host.md#restarts).
// contract: plugin-host.sidecar.failure
#[test]
fn a_plugin_send_after_the_restart_stop_fails_to_its_owner() {
    let executable = Folder::new();
    let config = Folder::new();
    let sidecars = declared_stdio(executable.path(), config.path());
    sidecars.stop_restarts_for_test(SIDECAR);
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let owner = RecordingOwner(recorded.clone());
    let session = "plugin:probe:project-a:fixture-sidecar";
    let body = raw(r#"{"operation":"list"}"#);
    assert_eq!(
        sidecars.send_plugin_with_cids(&owner, SIDECAR, session, ROOT, &body, &[]),
        Err("sidecar fixture-sidecar: restart limit".to_string())
    );
    let failures = recorded.lock().unwrap();
    assert_eq!(
        failures.len(),
        1,
        "the owner received {} failures",
        failures.len()
    );
    assert_eq!(failures[0].sidecar, SIDECAR);
    assert_eq!(failures[0].surface, session);
    assert_eq!(failures[0].reason, "restart limit");
}
