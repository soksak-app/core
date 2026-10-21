//! The sidecar requests of a plugin host page (docs/plans/plugin-host-routes.md rules 2 and 3).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::value::RawValue;

use crate::plugin_host_sidecar::{
    close_plugin_host_sessions, is_plugin_session, is_plugin_session_of, is_project_session,
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
            Some("/fixture/root")
        ),
        Ok("/fixture/root".to_string())
    );
    assert_eq!(
        plugin_send_root("probe", "fixture-sidecar", session, true, None),
        Err("plugin host probe: project project-a is not held by this window".to_string())
    );
    assert_eq!(
        plugin_send_root("probe", "fixture-sidecar", session, true, Some("")),
        Err("plugin host probe: project project-a has no folder".to_string())
    );
    assert_eq!(
        plugin_send_root(
            "probe",
            "fixture-sidecar",
            session,
            false,
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
            data: br#"{"executable":"echo","protocol":1,"transport":"persistent"}"#.to_vec(),
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
#[test]
fn a_retain_keeps_a_session_first_sent_during_its_start() {
    const SESSION: &str = "plugin:probe:project-a:fixture-sidecar";
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
    assert_eq!(
        retain["surfaces"],
        serde_json::json!([
            {"surface": "listed", "root": "/project"},
            {"surface": SESSION, "root": ROOT}
        ]),
        "the retain keeps the layout surface and the session first sent during the start"
    );
    // The hook holds the sidecars; clearing it breaks that reference before the stop.
    slot.lock().unwrap().take();
    sidecars.stop();
    thread.join().unwrap();
}

// Releasing a project closes the plugin sessions of that project that the holding window owns, and keeps the sessions of the
// projects that it still holds (docs/plans/plugin-host-routes.md rule 7).
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

    sidecars
        .close_owned(&window, &|surface| is_project_session(surface, "project-a"))
        .unwrap();
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

    sidecars
        .close_owned(&window, &|surface| is_plugin_session(surface))
        .unwrap();
    assert_eq!(
        closing_surfaces(&sidecars),
        [SESSION],
        "the page start closes the plugin session of the window and keeps its surface"
    );
    sidecars.stop();
    thread.join().unwrap();
}
