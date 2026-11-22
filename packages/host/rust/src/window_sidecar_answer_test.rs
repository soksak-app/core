//! The window path of an answered sidecarSend: the window authority admits the request, the reply of the service resolves
//! the wait, and a request without correlation identifiers sends no request line.
use super::view_sidecar_project_test::{MountedOwner, mount};
use crate::framework::Channel;
use crate::windows::WindowData;
use serde_json::value::RawValue;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};

const SIDECAR: &str = "fixture-sidecar";
const SURFACE: &str = "probe-surface";

/// A persistent service of the sidecar in config that answers hello, close-owner and shutdown, and each surface request with
/// the reply that `answer` returns, or with no reply. Each request line reaches the returned receiver.
pub(super) fn answer_service(
    config: &Path,
    answer: impl Fn(&serde_json::Value) -> Option<serde_json::Value> + Send + 'static,
) -> (Receiver<serde_json::Value>, std::thread::JoinHandle<()>) {
    let directory = config.join("services/echo");
    std::fs::create_dir_all(&directory).unwrap();
    let socket = directory.join("answer.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket,
        "token": "answer-token"
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
                    serde_json::json!({"operation": "hello", "protocol": 1, "ok": true, "version": "0.0.1"})
                }
                Some("close-owner") => {
                    serde_json::json!({"operation": "closed-owner", "request": request["request"], "ok": true})
                }
                Some("shutdown") => {
                    let reply = serde_json::json!({"operation": "shutdown", "request": request["request"], "ok": true});
                    writeln!(stream, "{}", reply).unwrap();
                    return;
                }
                _ => match answer(&request) {
                    Some(reply) => reply,
                    None => continue,
                },
            };
            writeln!(stream, "{}", reply).unwrap();
        }
    });
    (received, thread)
}

// A window answered send resolves with the body of the reply whose surface and cids equal the request's.
// contract: sidecars-transport.answer.resolves-with-matching-reply
#[test]
fn a_window_answered_send_resolves_with_the_reply_body() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let (received, service) = answer_service(config.path(), |request| {
        Some(serde_json::json!({
            "surface": request["surface"],
            "cids": request["cids"],
            "body": {"session": "session-1", "creation": "creation-1"}
        }))
    });
    let sidecars = Arc::new(crate::sidecars::session_retention_test::declared::<
        MountedOwner,
    >(executable.path(), config.path()));
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let body = RawValue::from_string(
        r#"{"op":"open","session":{"creation":"creation-1"},"cols":80,"rows":24,"params":{}}"#
            .into(),
    )
    .unwrap();

    let waiter = super::window_sidecar_send_answered(
        &data,
        &sidecars,
        &MountedOwner(data.clone()),
        SIDECAR,
        SURFACE,
        &body,
        &["p1.1".to_string()],
    )
    .unwrap();
    let reply = waiter.wait().unwrap();
    sidecars.stop();
    service.join().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(reply.get()).unwrap(),
        serde_json::json!({"session": "session-1", "creation": "creation-1"})
    );
    let sent: Vec<_> = received
        .try_iter()
        .filter(|request| request["surface"] == SURFACE)
        .collect();
    assert_eq!(
        sent.len(),
        1,
        "the request line of the window send: {sent:?}"
    );
    assert_eq!(sent[0]["cids"], serde_json::json!(["p1.1"]));
}

// A window answered send without cids is refused before the process starts, and sends no request line.
// contract: sidecars-transport.answer.refuses-without-cids-or-persistent
#[test]
fn a_window_answered_send_without_cids_is_refused_and_sends_nothing() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let sidecars = Arc::new(crate::sidecars::session_retention_test::declared::<
        MountedOwner,
    >(executable.path(), config.path()));
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let body = RawValue::from_string(r#"{"op":"end","session":"session-1"}"#.into()).unwrap();

    let refused = super::window_sidecar_send_answered(
        &data,
        &sidecars,
        &MountedOwner(data.clone()),
        SIDECAR,
        SURFACE,
        &body,
        &[],
    )
    .err();
    sidecars.stop();
    assert_eq!(refused.as_deref(), Some("sidecarSend answer requires cids"));
    assert!(
        !crate::sidecars::session_retention_test::has_surface_session(&sidecars, SURFACE),
        "a refused answered send recorded a session of the surface"
    );
}

/// The view request of the answered view send: the source generation of the mount of `probe-surface`.
fn view_request(
    generation: u64,
    cids: serde_json::Value,
    answer: bool,
) -> super::ViewSidecarSendRequest {
    serde_json::from_value(serde_json::json!({
        "source": SURFACE,
        "generation": generation,
        "sidecar": SIDECAR,
        "surface": SURFACE,
        "body": {"op": "open", "session": {"creation": "creation-2"}, "cols": 80, "rows": 24, "params": {}},
        "cids": cids,
        "answer": answer
    }))
    .unwrap()
}

// A view answered send resolves with the body of the reply whose surface and cids equal the request's.
// contract: sidecars.view-answer.resolves-with-the-matching-reply
#[test]
fn a_view_answered_send_resolves_with_the_matching_reply() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let (received, service) = answer_service(config.path(), |request| {
        Some(serde_json::json!({
            "surface": request["surface"],
            "cids": request["cids"],
            "body": {"session": "session-2", "creation": "creation-2"}
        }))
    });
    let sidecars = Arc::new(crate::sidecars::session_retention_test::declared::<
        MountedOwner,
    >(executable.path(), config.path()));
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let origin = mount(&data, "/fixture/project-a");

    let waiter = super::view_sidecar_send_answered(
        &data,
        &sidecars,
        &MountedOwner(data.clone()),
        view_request(origin.generation, serde_json::json!(["p1.6"]), true),
    )
    .unwrap();
    let reply = waiter.wait().unwrap();
    sidecars.stop();
    service.join().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(reply.get()).unwrap(),
        serde_json::json!({"session": "session-2", "creation": "creation-2"})
    );
    let sent: Vec<_> = received
        .try_iter()
        .filter(|request| request["surface"] == SURFACE)
        .collect();
    assert_eq!(sent.len(), 1, "the view request line: {sent:?}");
    assert_eq!(sent[0]["cids"], serde_json::json!(["p1.6"]));
}

// A view answered send without cids is refused with the answer text, and queues no request line.
// contract: sidecars.view-answer.requires-cids
#[test]
fn a_view_answered_send_without_cids_is_refused_and_queues_nothing() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let sidecars = Arc::new(crate::sidecars::session_retention_test::declared::<
        MountedOwner,
    >(executable.path(), config.path()));
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    let origin = mount(&data, "/fixture/project-a");

    let refused = super::view_sidecar_send_answered(
        &data,
        &sidecars,
        &MountedOwner(data.clone()),
        view_request(origin.generation, serde_json::json!([]), true),
    )
    .err();
    sidecars.stop();
    assert_eq!(refused.as_deref(), Some("sidecarSend answer requires cids"));
    assert!(
        !crate::sidecars::session_retention_test::has_surface_session(&sidecars, SURFACE),
        "a refused view answered send recorded a session of the surface"
    );
}

// A window send to a mounted surface is refused with the text that names viewSidecarSend and its source generation.
// contract: sidecars.window-send.mounted-view-surface-is-refused
#[test]
fn a_window_send_to_a_mounted_surface_names_the_view_send() {
    let executable = crate::test_folder::Folder::new();
    let config = crate::test_folder::Folder::new();
    let sidecars = Arc::new(crate::sidecars::session_retention_test::declared::<
        MountedOwner,
    >(executable.path(), config.path()));
    let data = Arc::new(WindowData::default());
    data.view_source_events.install(Channel::new(|_| Ok(())));
    *data.root.lock().unwrap() = "/fixture/project-a".into();
    mount(&data, "/fixture/project-a");
    let body = RawValue::from_string(r#"{"op":"end","session":"session-1"}"#.into()).unwrap();

    let refused = super::window_sidecar_send(
        &data,
        &sidecars,
        &MountedOwner(data.clone()),
        SIDECAR,
        SURFACE,
        &body,
        &["p1.7".to_string()],
    )
    .err();
    sidecars.stop();
    assert_eq!(
        refused.as_deref(),
        Some(
            "mounted surface probe-surface requires viewSidecarSend with its original source generation"
        )
    );
}
