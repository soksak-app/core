use serde_json::value::RawValue;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc::{Receiver, TryRecvError, channel, sync_channel};
use std::thread::JoinHandle;

use crate::sidecars::{RetainedSurface, SidecarDeclaration};
use crate::test_folder::Folder;
use std::sync::{Arc, Mutex};

use super::{
    Failure, ImageEnvelopeDecision, Message, Outgoing, Owner, Process, ResponseError,
    ResponseSender, Sidecars, try_handle_image_envelope,
};

#[derive(Clone)]
struct TestOwner;

impl Owner for TestOwner {
    fn key(&self) -> String {
        "window-a".into()
    }

    fn root(&self) -> Result<String, String> {
        Ok("/project".into())
    }

    fn deliver(&self, _message: Message) {}

    fn deliver_failure(&self, _failure: Failure) {}
}
// contract: sidecars.native-view-removal.closes-stdio-session
#[test]
fn native_view_removal_still_closes_a_standard_io_session() {
    let folder = crate::test_folder::Folder::new();
    let sidecars = Sidecars::<TestOwner>::new(&[], folder.path().to_path_buf()).unwrap();
    let owner = TestOwner;
    let surface = "tab-standard";
    let (sender, receiver) = sync_channel(2);
    {
        let mut state = sidecars.core.state.lock().unwrap();
        state.owners.insert(surface.into(), owner.clone());
        state.roots.insert(surface.into(), "/project".into());
        state.running.insert(
            "fixture-standard".into(),
            Process {
                child: None,
                outbox: sender,
                writing: Arc::new(AtomicUsize::new(0)),
                persistent: None,
                surfaces: HashSet::from([surface.into()]),
                closed_surfaces: HashSet::new(),
            },
        );
    }

    sidecars
        .native_views_removed(&owner, &HashSet::from([surface.to_string()]))
        .unwrap();

    let Outgoing::Line(line) = receiver.try_recv().unwrap() else {
        panic!("native view removal sent a non-line message")
    };
    let request: serde_json::Value = serde_json::from_slice(&line.bytes).unwrap();
    assert_eq!(request["surface"], surface);
    assert_eq!(request["closed"], true);
    assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
}

#[derive(Clone)]
struct FixtureOwner {
    registered_surfaces: Arc<Mutex<HashSet<String>>>,
    registered_decision: ImageEnvelopeDecision,
}

impl Owner for FixtureOwner {
    fn key(&self) -> String {
        "fixture-window".into()
    }

    fn root(&self) -> Result<String, String> {
        Ok("fixture-project".into())
    }

    fn deliver(&self, _message: Message) {}

    fn deliver_failure(&self, failure: Failure) {
        panic!("unexpected sidecar failure: {failure:?}");
    }

    fn decide_image_envelope(
        &self,
        _sidecar_name: &str,
        _surface: &str,
        _body: &RawValue,
        _response_sender: &dyn ResponseSender,
    ) -> ImageEnvelopeDecision {
        if self.registered_surfaces.lock().unwrap().contains(_surface) {
            self.registered_decision
        } else {
            ImageEnvelopeDecision::OwnerRetired
        }
    }
}

#[derive(Default)]
struct Responses(Mutex<Vec<(String, String, String)>>);

impl ResponseSender for Responses {
    fn send(&self, surface: &str, image: &str, body: &RawValue) -> Result<(), ResponseError> {
        self.0
            .lock()
            .unwrap()
            .push((surface.into(), image.into(), body.get().into()));
        Ok(())
    }
}

// contract: sidecars.image.closed-surface-is-answered, sidecars.image.retired-owner-dispositions
#[test]
fn an_image_routed_to_an_owner_retired_after_lookup_receives_the_closed_answer() {
    let registered_surfaces = Arc::new(Mutex::new(HashSet::from(["surface-1".to_string()])));
    let owner = FixtureOwner {
        registered_surfaces: Arc::clone(&registered_surfaces),
        registered_decision: ImageEnvelopeDecision::NotImage,
    };
    let mut owners = HashMap::from([("surface-1".to_string(), owner)]);

    // The sidecar reader has already resolved the owner when window destruction removes its record.
    let routed_owner = owners.get("surface-1").unwrap().clone();
    owners.remove("surface-1");
    registered_surfaces.lock().unwrap().remove("surface-1");

    let body = RawValue::from_string(
        serde_json::json!({"image": {
            "name": "view",
            "token": {"kind": "iosurface-global", "id": 1, "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="},
            "width": 1,
            "height": 1,
            "scale": 1.0,
            "format": "bgra8",
            "generation": 1,
            "raster": 1,
            "sequence": 1
        }})
        .to_string(),
    )
    .unwrap();
    let responses = Responses::default();

    let handled = try_handle_image_envelope(
        &routed_owner,
        "@fixture/sidecar-image",
        "surface-1",
        &body,
        &responses,
    );

    assert!(handled, "a retired owner must consume its transfer image");
    assert_eq!(
        *responses.0.lock().unwrap(),
        vec![(
            "surface-1".into(),
            "view".into(),
            r#"{"image":{"error":"closed","generation":1,"name":"view","raster":1,"sequence":1}}"#
                .into(),
        )],
    );
}

// contract: sidecars.image.retired-owner-dispositions
#[test]
fn current_and_retired_owner_paths_keep_their_existing_dispositions() {
    let registered_surfaces = Arc::new(Mutex::new(HashSet::from(["surface-1".to_string()])));
    let responses = Responses::default();
    let non_image = RawValue::from_string(r#"{"event":"fixture"}"#.into()).unwrap();
    let live_owner = FixtureOwner {
        registered_surfaces: Arc::clone(&registered_surfaces),
        registered_decision: ImageEnvelopeDecision::NotImage,
    };

    assert!(!try_handle_image_envelope(
        &live_owner,
        "@fixture/sidecar-image",
        "surface-1",
        &non_image,
        &responses,
    ));
    assert!(responses.0.lock().unwrap().is_empty());

    let live_handled_owner = FixtureOwner {
        registered_surfaces: Arc::clone(&registered_surfaces),
        registered_decision: ImageEnvelopeDecision::Handled,
    };
    let image = RawValue::from_string(
        serde_json::json!({"image": {
            "name": "view",
            "token": {"kind": "iosurface-global", "id": 1, "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="},
            "width": 1,
            "height": 1,
            "scale": 1.0,
            "format": "bgra8",
            "generation": 1,
            "raster": 1,
            "sequence": 1
        }})
        .to_string(),
    )
    .unwrap();
    assert!(try_handle_image_envelope(
        &live_handled_owner,
        "@fixture/sidecar-image",
        "surface-1",
        &image,
        &responses,
    ));
    assert!(responses.0.lock().unwrap().is_empty());

    registered_surfaces.lock().unwrap().remove("surface-1");
    assert!(try_handle_image_envelope(
        &live_owner,
        "@fixture/sidecar-image",
        "surface-1",
        &non_image,
        &responses,
    ));
    let malformed_image = RawValue::from_string(r#"{"image":{"name":17}}"#.into()).unwrap();
    assert!(try_handle_image_envelope(
        &live_owner,
        "@fixture/sidecar-image",
        "surface-1",
        &malformed_image,
        &responses,
    ));
    assert!(responses.0.lock().unwrap().is_empty());
}

const SIDECAR: &str = "fixture-sidecar";
const ROOT: &str = "/fixture/root";

#[derive(Clone)]
struct SessionOwner(String);

impl Owner for SessionOwner {
    fn key(&self) -> String {
        self.0.clone()
    }
    fn root(&self) -> Result<String, String> {
        Ok(ROOT.to_string())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, _failure: Failure) {}
}

fn owner(key: &str) -> SessionOwner {
    SessionOwner(key.to_string())
}

/// A window whose shown project changes during a test.
#[derive(Clone)]
struct ShownOwner(Arc<Mutex<String>>);

impl Owner for ShownOwner {
    fn key(&self) -> String {
        "window-a".to_string()
    }
    fn root(&self) -> Result<String, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, _failure: Failure) {}
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.to_string()).unwrap()
}

/// The persistent sidecar fixture-sidecar that the plugin probe depends on. Its service endpoint is in config.
fn declared<O: Owner>(executable: &Path, config: &Path) -> Sidecars<O> {
    Sidecars::new(
        &[SidecarDeclaration {
            name: SIDECAR.to_string(),
            folder: executable.to_path_buf(),
            data: br#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}"#.to_vec(),
            error: None,
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
                    // The service is of the installed version, so a retain replaces nothing.
                    serde_json::json!({"operation": "hello", "protocol": 1, "ok": true, "version": "0.0.1"})
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
fn open_session(sidecars: &Sidecars<SessionOwner>, window: &SessionOwner, surface: &str) {
    sidecars
        .send(window, SIDECAR, surface, &raw(r#"{"operation":"open"}"#))
        .unwrap();
}

// contract: sidecars.retain.keeps-surface-first-sent-during-start
#[test]
fn a_retain_keeps_an_ordinary_surface_first_sent_during_its_start() {
    const SURFACE: &str = "tab-during-retain-start";
    let executable = Folder::new();
    let config = Folder::new();
    let (received, thread) = service(config.path());
    let slot: Arc<Mutex<Option<Arc<Sidecars<SessionOwner>>>>> = Arc::new(Mutex::new(None));
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
        .retain_sessions(&[RetainedSurface {
            surface: "listed".to_string(),
            root: "/project".to_string(),
            plugin: "probe".to_string(),
        }])
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

/// Runs a retain with listed as its list, makes send while it prepares its service, and returns the lines that reached the service.
fn lines_of_a_retain(
    config: &Path,
    executable: &Path,
    window: &ShownOwner,
    send: impl Fn(&Sidecars<ShownOwner>, &ShownOwner, &str) + Send + Sync + 'static,
) -> Vec<serde_json::Value> {
    let (received, thread) = service(config);
    let slot: Arc<Mutex<Option<Arc<Sidecars<ShownOwner>>>>> = Arc::new(Mutex::new(None));
    let hook_slot = slot.clone();
    let hook_window = window.clone();
    let sidecars = declared(executable, config).with_retain_sending(move |name| {
        if name != SIDECAR {
            return;
        }
        let guard = hook_slot.lock().unwrap();
        let sidecars = guard
            .as_ref()
            .expect("the sidecars are set before the retain");
        send(sidecars, &hook_window, name);
    });
    let sidecars = Arc::new(sidecars);
    *slot.lock().unwrap() = Some(sidecars.clone());
    sidecars
        .retain_sessions(&[RetainedSurface {
            surface: "listed".to_string(),
            root: "/project".to_string(),
            plugin: "probe".to_string(),
        }])
        .unwrap();
    let lines = received.try_iter().collect();
    slot.lock().unwrap().take();
    sidecars.stop();
    thread.join().unwrap();
    lines
}

fn kept_surfaces(lines: &[serde_json::Value]) -> serde_json::Value {
    lines
        .iter()
        .find(|line| line["operation"] == "retain")
        .expect("the retain line reached the service")["surfaces"]
        .clone()
}

// contract: sidecars.send.page-needs-a-project-root
#[test]
fn a_request_of_a_page_in_a_window_with_no_project_is_refused_during_a_retain() {
    const SURFACE: &str = "tab-of-a-closed-project";
    let executable = Folder::new();
    let config = Folder::new();
    let window = ShownOwner(Arc::new(Mutex::new(String::new())));
    let lines = lines_of_a_retain(
        config.path(),
        executable.path(),
        &window,
        |sidecars, window, name| {
            let refused = sidecars
                .send_from_page(window, name, SURFACE, &raw(r#"{"operation":"open"}"#), &[])
                .unwrap_err();
            assert!(
                refused.contains("has no project"),
                "the request of a page: {refused}"
            );
        },
    );
    assert!(
        !lines.iter().any(|line| line["surface"] == SURFACE),
        "the refused request reached the service: {lines:?}"
    );
    assert_eq!(
        kept_surfaces(&lines),
        serde_json::json!([{"surface": "listed", "root": "/project"}])
    );
}

// contract: sidecars.send.page-needs-a-project-root
#[test]
fn a_request_of_a_page_with_a_recorded_root_goes_on_with_no_project() {
    const SURFACE: &str = "tab-known";
    let executable = Folder::new();
    let config = Folder::new();
    let (received, thread) = service(config.path());
    let shown = Arc::new(Mutex::new(ROOT.to_string()));
    let window = ShownOwner(shown.clone());
    let sidecars: Sidecars<ShownOwner> = declared(executable.path(), config.path());
    sidecars
        .send_from_page(&window, SIDECAR, SURFACE, &raw(r#"{"operation":"open"}"#), &[])
        .unwrap();
    *shown.lock().unwrap() = String::new();
    sidecars
        .send_from_page(&window, SIDECAR, SURFACE, &raw(r#"{"operation":"input"}"#), &[])
        .unwrap();
    sidecars.stop();
    thread.join().unwrap();
    let lines: Vec<serde_json::Value> = received.try_iter().collect();
    let input = lines
        .iter()
        .find(|line| line["surface"] == SURFACE && line["body"]["operation"] == "input")
        .expect("the request reached the service");
    assert_eq!(input["root"], ROOT);
}

// contract: sidecars.send.host-send-leaves-no-session-without-a-root
#[test]
fn a_send_of_the_host_in_a_window_with_no_project_leaves_no_session() {
    const SURFACE: &str = "tab-of-a-closed-project";
    let executable = Folder::new();
    let config = Folder::new();
    let window = ShownOwner(Arc::new(Mutex::new(String::new())));
    let lines = lines_of_a_retain(
        config.path(),
        executable.path(),
        &window,
        |sidecars, window, name| {
            sidecars
                .send(window, name, SURFACE, &raw(r#"{"operation":"open"}"#))
                .unwrap();
        },
    );
    assert!(
        lines.iter().any(|line| line["surface"] == SURFACE),
        "the send of the host did not reach the service: {lines:?}"
    );
    assert_eq!(
        kept_surfaces(&lines),
        serde_json::json!([{"surface": "listed", "root": "/project"}])
    );
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
    open_session(&sidecars, &window, SURFACE);
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
    open_session(&sidecars, &window, SURFACE);
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
