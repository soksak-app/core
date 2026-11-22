//! Owned session queries of a persistent service: the `sessions` operation and the `sidecarSessions` bridge request
//! (docs/spec/persistent-services.md#owned-sessions). The service harness answers hello and sessions as the protocol states.

#[path = "../tests/support/folder.rs"]
mod folder;
#[path = "../tests/support/sidecar_recorder.rs"]
mod sidecar_recorder;
use sidecar_recorder::SidecarRecorder;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::mpsc::{Receiver, channel};

use crate::sidecars::{SidecarDeclaration, SidecarSendRequest, SidecarSessionsRequest, Sidecars};
use serde_json::value::RawValue;
use sidecar_recorder::SendAsRecorder;

const ECHO: &str = "@fixture/sidecar-echo";

/// The declarations of one persistent sidecar installed in folder.
fn declare(folder: &Path) -> Vec<SidecarDeclaration> {
    let data = r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}"#;
    vec![SidecarDeclaration {
        name: ECHO.to_string(),
        folder: folder.to_path_buf(),
        data: data.as_bytes().to_vec(),
        error: None,
        version: "0.0.1".to_string(),
        dependents: Vec::new(),
    }]
}

/// Writes the endpoint of a service of ECHO in config and returns the listener of its socket.
fn service_endpoint(config: &Path) -> UnixListener {
    let directory = config.join("services/echo");
    std::fs::create_dir_all(&directory).unwrap();
    let socket = directory.join("sessions.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket,
        "token": "sessions-token"
    });
    std::fs::write(
        directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    listener
}

/// A service that answers hello and then each sessions request with the reply that `answer` returns for its request. A
/// `None` answer ends the connection without a reply. Each request line reaches the returned receiver.
fn sessions_service(
    listener: UnixListener,
    answer: impl Fn(&serde_json::Value) -> Option<serde_json::Value> + Send + 'static,
) -> (Receiver<serde_json::Value>, std::thread::JoinHandle<()>) {
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
                    // The service is of the installed version, so the query replaces nothing.
                    serde_json::json!({"operation": "hello", "protocol": 1, "ok": true, "version": "0.0.1"})
                }
                Some("sessions") => match answer(&request) {
                    Some(reply) => reply,
                    None => return,
                },
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

fn session_entry(session: &str, surface: &str, width: f64, height: f64) -> serde_json::Value {
    serde_json::json!({
        "session": session,
        "surface": surface,
        "root": "/project",
        "creation": format!("creation-{session}"),
        "size": {"width": width, "height": height, "scale": 2.0}
    })
}

// contract: sidecars-transport.sessions.returns-service-sessions
#[test]
fn service_sessions_returns_the_sessions_the_service_answers() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let entries = vec![
        session_entry("session-1", "tab-a", 800.0, 240.0),
        session_entry("session-2", "tab-b", 1200.0, 400.0),
    ];
    let answered = entries.clone();
    let (received, thread) = sessions_service(listener, move |request| {
        Some(serde_json::json!({
            "operation": "sessions",
            "request": request["request"],
            "ok": true,
            "sessions": answered
        }))
    });
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();

    let sessions = sidecars.service_sessions(ECHO).unwrap();
    sidecars.stop();
    thread.join().unwrap();
    let query: Vec<_> = received.try_iter().collect();
    let sent = query
        .iter()
        .find(|request| request["operation"] == "sessions")
        .expect("the persistent service received the sessions query");
    assert_eq!(
        sent.as_object().unwrap().keys().collect::<Vec<_>>().len(),
        2,
        "the query carries only operation and request: {sent}"
    );
    assert!(sent["request"].as_str().is_some_and(|id| !id.is_empty()));
    let values: Vec<serde_json::Value> = sessions
        .iter()
        .map(|session| serde_json::to_value(session).unwrap())
        .collect();
    assert_eq!(values, entries, "the sessions of the service reply");
}

// contract: sidecars-transport.sessions.fails-with-service-error
#[test]
fn service_sessions_fails_with_the_error_of_the_service() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let (_received, thread) = sessions_service(listener, |request| {
        Some(serde_json::json!({
            "operation": "sessions",
            "request": request["request"],
            "ok": false,
            "error": "sessions failed in the service"
        }))
    });
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();

    let error = sidecars.service_sessions(ECHO).unwrap_err();
    sidecars.stop();
    thread.join().unwrap();
    assert!(error.contains("sessions failed in the service"), "{error}");
}

// contract: sidecars-transport.sessions.ends-with-connection
#[test]
fn an_unanswered_sessions_query_ends_with_its_connection() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let (_received, thread) = sessions_service(listener, |_| None);
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();

    let error = sidecars.service_sessions(ECHO).unwrap_err();
    sidecars.stop();
    thread.join().unwrap();
    assert!(
        error.contains("the service connection ended before the answer"),
        "{error}"
    );
}

// contract: sidecars-transport.sessions.refuses-invalid-member
#[test]
fn service_sessions_refuses_a_session_without_a_positive_size() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let (_received, thread) = sessions_service(listener, |request| {
        Some(serde_json::json!({
            "operation": "sessions",
            "request": request["request"],
            "ok": true,
            "sessions": [session_entry("session-1", "tab-a", 0.0, 240.0)]
        }))
    });
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();

    let error = sidecars.service_sessions(ECHO).unwrap_err();
    sidecars.stop();
    thread.join().unwrap();
    assert!(
        error.contains("invalid message: sessions size.width is not a positive number"),
        "{error}"
    );
}

// contract: sidecars-transport.sessions.empty-without-endpoint
#[test]
fn service_sessions_is_empty_without_a_service_endpoint() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();

    assert_eq!(sidecars.service_sessions(ECHO), Ok(Vec::new()));
    sidecars.stop();
}

// contract: sidecars-transport.sessions.refuses-empty-sidecar
#[test]
fn the_sidecar_sessions_request_refuses_an_empty_sidecar() {
    let request: SidecarSessionsRequest =
        serde_json::from_value(serde_json::json!({"sidecar": ""})).unwrap();
    assert_eq!(
        request.check().err().as_deref(),
        Some("sidecarSessions requires a non-empty sidecar")
    );
}

// contract: sidecars-transport.sessions.refuses-standard-io-sidecar
// A sessions query for a sidecar that is not a persistent service is refused and connects to no service endpoint.
#[test]
fn service_sessions_refuses_a_standard_io_sidecar_and_sends_no_line() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let data = r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#;
    let declarations = vec![SidecarDeclaration {
        name: ECHO.to_string(),
        folder: executable.path().to_path_buf(),
        data: data.as_bytes().to_vec(),
        error: None,
        version: "0.0.1".to_string(),
        dependents: Vec::new(),
    }];
    // An endpoint of the service is present, so only the transport of the sidecar can refuse the query.
    let listener = service_endpoint(config.path());
    listener.set_nonblocking(true).unwrap();
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declarations, config.path().to_path_buf()).unwrap();

    let refused = sidecars.service_sessions(ECHO).err();
    sidecars.stop();
    assert_eq!(
        refused,
        Some(format!("sidecar {ECHO} is not a persistent service"))
    );
    assert!(
        listener.accept().is_err(),
        "a refused sessions query connected to the service"
    );
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.into()).unwrap()
}

/// A service that answers hello, close-owner and shutdown, and each request line of a surface with the reply that `answer`
/// returns for its request, or with no reply for `None`. Each request line reaches the returned receiver.
fn surface_service(
    listener: UnixListener,
    answer: impl Fn(&serde_json::Value) -> Option<serde_json::Value> + Send + 'static,
) -> (Receiver<serde_json::Value>, std::thread::JoinHandle<()>) {
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

/// The reply line of a surface: the body, with the correlation identifiers of the request.
fn surface_reply(request: &serde_json::Value, body: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"surface": request["surface"], "cids": request["cids"], "body": body})
}

// contract: sidecars-transport.answer.resolves-with-matching-reply
// A `sidecarSend` with answer true resolves with the body of the reply whose surface and cids equal the request's.
#[test]
fn an_answered_send_resolves_with_the_matching_reply_body() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let (received, thread) = surface_service(listener, |request| {
        Some(surface_reply(
            request,
            serde_json::json!({"session": "session-1", "creation": "creation-1"}),
        ))
    });
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();
    let (owner, _events) = sidecar_recorder::owner("window-a", "/project");

    let waiter = sidecars
        .send_with_answer(
            &owner,
            ECHO,
            "tab-answer",
            &raw(r#"{"op":"open","session":{"creation":"creation-1"},"cols":80,"rows":24,"params":{}}"#),
            &["p1.1".to_string()],
        )
        .unwrap();
    let body = waiter.wait().unwrap();
    sidecars.stop();
    thread.join().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(body.get()).unwrap(),
        serde_json::json!({"session": "session-1", "creation": "creation-1"})
    );
    let sent: Vec<_> = received.try_iter().collect();
    assert!(
        sent.iter().any(|request| request["surface"] == "tab-answer"
            && request["cids"] == serde_json::json!(["p1.1"])),
        "the request line with its cids reached the service: {sent:?}"
    );
}

// contract: sidecars-transport.answer.rejects-with-error-body
// A reply body with the member error rejects the answered send with that error.
#[test]
fn an_answered_send_rejects_with_the_error_of_the_reply_body() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let (_received, thread) = surface_service(listener, |request| {
        Some(surface_reply(
            request,
            serde_json::json!({"error": "session session-9 is not open"}),
        ))
    });
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();
    let (owner, _events) = sidecar_recorder::owner("window-a", "/project");

    let waiter = sidecars
        .send_with_answer(
            &owner,
            ECHO,
            "tab-error",
            &raw(r#"{"op":"resize","session":"session-9","cols":80,"rows":24}"#),
            &["p1.2".to_string()],
        )
        .unwrap();
    let error = waiter.wait().unwrap_err();
    sidecars.stop();
    thread.join().unwrap();
    assert_eq!(error, "session session-9 is not open");
}

// contract: sidecars-transport.answer.refuses-without-cids-or-persistent
// An answered send without cids is refused, and sends no request line.
#[test]
fn an_answered_send_without_cids_is_refused() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let (received, thread) = surface_service(listener, |_| None);
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();
    let (owner, _events) = sidecar_recorder::owner("window-a", "/project");

    let refused = sidecars
        .send_with_answer(
            &owner,
            ECHO,
            "tab-nocids",
            &raw(r#"{"op":"end","session":"session-1"}"#),
            &[],
        )
        .err();
    // No process was started, so the service never accepts a connection and its thread is not joined.
    sidecars.stop();
    drop(thread);
    assert_eq!(refused.as_deref(), Some("sidecarSend answer requires cids"));
    let sent: Vec<_> = received
        .try_iter()
        .filter(|request| request["surface"] == "tab-nocids")
        .collect();
    assert!(
        sent.is_empty(),
        "a refused send reached the service: {sent:?}"
    );
}

// contract: sidecars-transport.answer.refuses-without-cids-or-persistent
// An answered send to a sidecar that is not persistent is refused, and sends no request line.
#[test]
fn an_answered_send_to_a_stdio_sidecar_is_refused() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let data = r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#;
    let declarations = vec![SidecarDeclaration {
        name: ECHO.to_string(),
        folder: executable.path().to_path_buf(),
        data: data.as_bytes().to_vec(),
        error: None,
        version: "0.0.1".to_string(),
        dependents: Vec::new(),
    }];
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declarations, config.path().to_path_buf()).unwrap();
    let (owner, _events) = sidecar_recorder::owner("window-a", "/project");

    let refused = sidecars
        .send_with_answer(
            &owner,
            ECHO,
            "tab-stdio",
            &raw(r#"{"op":"end"}"#),
            &["p1.3".to_string()],
        )
        .err();
    sidecars.stop();
    assert_eq!(
        refused.as_deref(),
        Some("sidecarSend answer requires a persistent sidecar")
    );
}

// contract: sidecars-transport.answer.refuses-waiting-duplicate-cids, sidecars-transport.answer.ends-with-connection
// A second answered send whose cids equal a waiting request of its surface is refused; the waiting request ends with its
// connection.
#[test]
fn an_answered_send_with_waiting_cids_is_refused_and_the_waiter_ends_with_its_connection() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let (received, thread) = surface_service(listener, |_| None);
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();
    let (owner, _events) = sidecar_recorder::owner("window-a", "/project");
    let body = raw(r#"{"op":"end","session":"session-1"}"#);

    let first = sidecars
        .send_with_answer(&owner, ECHO, "tab-dup", &body, &["p1.4".to_string()])
        .unwrap();
    let second = sidecars
        .send_with_answer(&owner, ECHO, "tab-dup", &body, &["p1.4".to_string()])
        .err();
    sidecars.stop();
    thread.join().unwrap();
    assert_eq!(
        second.as_deref(),
        Some("sidecarSend answer cids already wait for surface tab-dup")
    );
    assert_eq!(
        first.wait().unwrap_err(),
        "the service connection ended before the answer"
    );
    let sent: Vec<_> = received
        .try_iter()
        .filter(|request| request["surface"] == "tab-dup")
        .collect();
    assert_eq!(
        sent.len(),
        1,
        "the refused duplicate reached the service: {sent:?}"
    );
}

// contract: sidecars-transport.answer.refuses-invalid-cids
// The request envelope refuses a cids entry that a line cannot hold, and names it.
#[test]
fn the_send_request_refuses_a_cid_that_a_line_cannot_hold() {
    let request: SidecarSendRequest = serde_json::from_value(serde_json::json!({
        "sidecar": ECHO,
        "surface": "tab-bad",
        "body": {"op": "end"},
        "cids": ["p1.5", "bad\"cid"],
        "answer": true
    }))
    .unwrap();
    let error = request.check().err().unwrap();
    assert!(
        error.starts_with("sidecarSend cids are refused: bad\"cid is empty"),
        "{error}"
    );
}

// contract: sidecars-transport.owned-messages.forwarded-unchanged
// The host forwards an owned-session body unchanged: an invalid size is not read by the host, so the service receives it as
// it was sent.
#[test]
fn the_host_forwards_an_owned_session_body_unchanged() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let (received, thread) = surface_service(listener, |_| None);
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();
    let (owner, _events) = sidecar_recorder::owner("window-a", "/project");
    let body = r#"{"op":"resize","session":"session-1","cols":0,"rows":-3}"#;

    sidecars
        .send_as(&owner, ECHO, "tab-forward", &raw(body))
        .unwrap();
    let sent = loop {
        let request = received.recv().unwrap();
        if request["surface"] == "tab-forward" {
            break request;
        }
    };
    sidecars.stop();
    thread.join().unwrap();
    assert_eq!(
        sent["body"],
        serde_json::from_str::<serde_json::Value>(body).unwrap()
    );
}

// The sidecarSessions call resolves with {sessions} that the service answers, and refuses an empty sidecar.
// contract: sidecars-transport.sessions.returns-service-sessions, sidecars-transport.sessions.refuses-empty-sidecar
#[test]
fn the_sidecar_sessions_call_resolves_with_the_service_sessions() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let entries = vec![session_entry("session-1", "tab-a", 800.0, 240.0)];
    let answered = entries.clone();
    let (_received, thread) = sessions_service(listener, move |request| {
        Some(serde_json::json!({
            "operation": "sessions",
            "request": request["request"],
            "ok": true,
            "sessions": answered
        }))
    });
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();

    let reply = sidecars
        .sessions_of(SidecarSessionsRequest {
            sidecar: ECHO.to_string(),
        })
        .unwrap();
    let refused = sidecars
        .sessions_of(SidecarSessionsRequest {
            sidecar: String::new(),
        })
        .err();
    sidecars.stop();
    thread.join().unwrap();
    assert_eq!(reply, serde_json::json!({"sessions": entries}));
    assert_eq!(
        refused.as_deref(),
        Some("sidecarSessions requires a non-empty sidecar")
    );
}

// contract: sidecars-transport.sessions.refuses-a-size-that-is-not-an-object
#[test]
fn service_sessions_refuses_a_size_that_is_not_an_object() {
    let executable = folder::Folder::new();
    let config = folder::Folder::new();
    let listener = service_endpoint(config.path());
    let (_received, thread) = sessions_service(listener, |request| {
        Some(serde_json::json!({
            "operation": "sessions",
            "request": request["request"],
            "ok": true,
            "sessions": [{
                "session": "session-1",
                "surface": "tab-a",
                "root": "/project",
                "creation": "creation-session-1",
                "size": 80
            }]
        }))
    });
    let sidecars =
        Sidecars::<SidecarRecorder>::new(&declare(executable.path()), config.path().to_path_buf())
            .unwrap();

    let error = sidecars.service_sessions(ECHO).unwrap_err();
    sidecars.stop();
    thread.join().unwrap();
    assert_eq!(error, "invalid message: sessions size is not an object");
}
