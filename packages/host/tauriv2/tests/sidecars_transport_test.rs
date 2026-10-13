//! Sidecar persistent transport tests. They use a fake window and a service endpoint harness.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixListener;
use std::process::Command;

#[path = "support/records.rs"]
mod records;

use serde_json::value::RawValue;
use soksak_host_tauriv2::sidecars::{
    Failure, Message, OutdatedSidecar, Owner, SidecarDeclaration, Sidecars,
};

#[derive(Clone)]
struct FakeOwner {
    key: String,
    root: String,
    sent: Sender<Message>,
}

impl Owner for FakeOwner {
    fn key(&self) -> String {
        self.key.clone()
    }
    fn root(&self) -> Result<String, String> {
        Ok(self.root.clone())
    }
    fn deliver(&self, message: Message) {
        let _ = self.sent.send(message);
    }
    fn deliver_failure(&self, failure: Failure) {
        // These checks do not assert failures, so failures are left in the check output.
        eprintln!("sidecar failure: {failure:?}");
    }
}

fn owner(key: &str, root: &str) -> (FakeOwner, Receiver<Message>) {
    let (sent, received) = channel();
    (
        FakeOwner {
            key: key.into(),
            root: root.into(),
            sent,
        },
        received,
    )
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.into()).unwrap()
}

type Files = Vec<(&'static str, String)>;

/// One sidecar @fixture/sidecar-echo and the content of its sidecar.json.
fn files(sidecar: &str) -> Files {
    vec![("@fixture/sidecar-echo", sidecar.to_string())]
}

/// The declarations of the sidecars installed in folder.
fn declare(files: &Files, folder: &Path) -> Vec<SidecarDeclaration> {
    files
        .iter()
        .map(|(name, data)| SidecarDeclaration {
            name: name.to_string(),
            folder: folder.to_path_buf(),
            data: data.as_bytes().to_vec(),
            version: "0.0.1".to_string(),
        })
        .collect()
}

const ECHO: &str = "@fixture/sidecar-echo";

/// The upper limit that ends a stalled check. Success is decided by the received event and not by this time.
const STALL: Duration = Duration::from_secs(120);

// contract: sidecars-transport.endpoint.concurrent-hosts-share-authenticated-service, sidecars-transport.hello.declares-protocol-one
#[test]
fn concurrent_hosts_share_an_authenticated_service_endpoint() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("s.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "test-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();

    // Each connection is handled by a thread, so that, as in a real service, a hello is not queued behind the request
    // round trip of another connection. Four connections are accepted: the two initial connections and the connections
    // of the automatic restart that connects again whenever the check closes a connection (V5-106). If the deadline
    // passes while waiting for a request, it ends quietly: the restart connection does not receive a request until the
    // check ends.
    let service = std::thread::spawn(move || {
        let mut workers = Vec::new();
        for stream in listener.incoming().take(4) {
            let mut stream = stream.unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            workers.push(std::thread::spawn(move || {
                let reader_stream = stream.try_clone().unwrap();
                let mut reader = BufReader::new(reader_stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
                assert_eq!(hello["operation"], "hello");
                assert_eq!(hello["protocol"], 1);
                assert_eq!(hello["token"], "test-token");
                stream
                    .write_all(
                        br#"{"operation":"hello","protocol":1,"ok":true}
"#,
                    )
                    .unwrap();
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
                stream.write_all(line.as_bytes()).unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });

    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let first = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let second = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (first_owner, first_events) = owner("first", "/projects/first");
    let (second_owner, second_events) = owner("second", "/projects/second");
    first
        .send(&first_owner, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    second
        .send(&second_owner, ECHO, "s2", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    assert_eq!(first_events.recv_timeout(STALL).unwrap().surface, "s1");
    assert_eq!(second_events.recv_timeout(STALL).unwrap().surface, "s2");
    service.join().unwrap();
}

// contract: sidecars-transport.endpoint.concurrent-hosts-share-authenticated-service, sidecars-transport.hello.declares-protocol-one, sidecars-transport.reconnect.after-connection-loss-preserves-owner, sidecars-transport.stop.close-owner-failure-returns-promptly
#[test]
fn persistent_transport_reconnects_after_connection_loss_and_preserves_owner() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("reconnect.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "reconnect-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    let service = thread::spawn(move || {
        let mut workers = Vec::new();
        // This service does not cut a connection arbitrarily (so that the automatic restart of V5-106 does not race
        // with the connection order). It cuts only the connection that received a `drop` request and returns the other
        // requests. It answers close-owner with a failure so that stop does not wait for the deadline.
        for _ in 0..4 {
            let (mut stream, _) = match listener.accept() {
                Ok((stream, _)) => (stream, ()),
                Err(_) => break,
            };
            workers.push(thread::spawn(move || {
                stream
                    .set_read_timeout(Some(Duration::from_secs(30)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
                assert_eq!(hello["operation"], "hello");
                assert_eq!(hello["protocol"], 1);
                assert_eq!(hello["token"], "reconnect-token");
                stream
                    .write_all(
                        br#"{"operation":"hello","protocol":1,"ok":true}
"#,
                    )
                    .unwrap();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => return,
                        Ok(_) => {}
                    }
                    let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                    if request["operation"] == "close-owner" {
                        let reply = serde_json::json!({
                            "operation": "closed-owner",
                            "request": request["request"],
                            "ok": false,
                            "error": "test close"
                        });
                        writeln!(stream, "{reply}").unwrap();
                        return;
                    }
                    // The operation of a page request is inside the body. drop is the check signal that cuts this
                    // connection.
                    if request["body"]["operation"] == "drop" {
                        stream.shutdown(Shutdown::Both).unwrap();
                        return;
                    }
                    stream.write_all(line.as_bytes()).unwrap();
                }
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });

    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let first = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let second = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (first_owner, first_events) = owner("first", "/projects/first");
    let (second_owner, second_events) = owner("second", "/projects/second");

    first
        .send(&first_owner, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    second
        .send(&second_owner, ECHO, "s2", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    assert_eq!(first_events.recv_timeout(STALL).unwrap().surface, "s1");
    assert_eq!(second_events.recv_timeout(STALL).unwrap().surface, "s2");
    // Make the service cut the two connections. The cut is awaited as a connection event (V5-106). The automatic
    // restart reacts only to EOF, so the arrival of the connection event of each instance is the evidence that the
    // service cut that connection.
    first
        .send(&first_owner, ECHO, "s1", &raw(r#"{"operation":"drop"}"#))
        .unwrap();
    second
        .send(&second_owner, ECHO, "s2", &raw(r#"{"operation":"drop"}"#))
        .unwrap();
    let await_revived = |label: &str, events: &Receiver<Message>| loop {
        let message = events
            .recv_timeout(STALL)
            .unwrap_or_else(|error| panic!("{label} connection event: {error}"));
        let body = message.body.get();
        if body.contains(r#""event":"connection""#) {
            assert!(
                body.contains(r#""connected":true"#),
                "unexpected connection failure notice: {body}"
            );
            return;
        }
    };
    await_revived("first", &first_events);
    await_revived("second", &second_events);

    first
        .send(
            &first_owner,
            ECHO,
            "s1",
            &raw(r#"{"operation":"reconnect"}"#),
        )
        .unwrap();
    second
        .send(
            &second_owner,
            ECHO,
            "s2",
            &raw(r#"{"operation":"reconnect"}"#),
        )
        .unwrap();
    assert_eq!(first_events.recv_timeout(STALL).unwrap().surface, "s1");
    assert_eq!(second_events.recv_timeout(STALL).unwrap().surface, "s2");

    // The service answers close-owner with a failure. The stop ends at once without waiting for the time limit.
    let stopping = std::time::Instant::now();
    first.stop();
    second.stop();
    let elapsed = stopping.elapsed();
    // The failed close-owner answer ends without waiting for the deadline of stop. If it took until the deadline, it
    // did not wait for the answer.
    assert!(
        elapsed < first.stop_timeout,
        "close-owner failure was not reported before the {:?} stop deadline: {elapsed:?}",
        first.stop_timeout
    );
    service.join().unwrap();
}

// contract: sidecars-transport.hello.rejects-unsupported-protocol-without-replacing-endpoint
#[test]
fn persistent_transport_rejects_unsupported_hello_protocol_without_replacing_endpoint() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("protocol-mismatch.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "protocol-mismatch-token"
    });
    let endpoint_bytes = serde_json::to_vec(&endpoint).unwrap();
    let endpoint_path = service_directory.join("endpoint.json");
    std::fs::write(&endpoint_path, &endpoint_bytes).unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut hello = String::new();
        reader.read_line(&mut hello).unwrap();
        let hello: serde_json::Value = serde_json::from_str(&hello).unwrap();
        assert_eq!(hello["operation"], "hello");
        writeln!(
            stream,
            "{{\"operation\":\"hello\",\"protocol\":2,\"ok\":true}}"
        )
        .unwrap();
    });

    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (window, _events) = owner("protocol", "/projects/protocol");
    let error = sidecars
        .send(&window, ECHO, "surface", &raw(r#"{"operation":"open"}"#))
        .unwrap_err();
    assert!(
        error.contains("protocol mismatch in hello response"),
        "{error}"
    );
    assert_eq!(std::fs::read(&endpoint_path).unwrap(), endpoint_bytes);
    server.join().unwrap();
}

// contract: sidecars-transport.hello.rejects-auth-failure
#[test]
fn persistent_transport_rejects_a_failed_hello() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("auth.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "auth-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut hello = String::new();
        reader.read_line(&mut hello).unwrap();
        writeln!(
            stream,
            "{{\"operation\":\"hello\",\"ok\":false,\"error\":\"authentication or protocol mismatch\"}}"
        )
        .unwrap();
    });

    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (window, _events) = owner("auth", "/projects/auth");
    let error = sidecars
        .send(&window, ECHO, "surface", &raw(r#"{"operation":"open"}"#))
        .unwrap_err();
    assert!(error.contains("authentication handshake failed"), "{error}");
    server.join().unwrap();
}

// contract: sidecars-transport.endpoint.replaces-dead-service-endpoint
#[test]
fn persistent_transport_replaces_endpoint_left_by_a_dead_service() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("replacement.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let token = "replacement-token";
    let replacement_endpoint = serde_json::json!({
        "protocol": 1,
        "pid": 1,
        "socket": socket_path,
        "token": token
    });
    let stale_child = Command::new("/bin/sh")
        .arg("-c")
        .arg("exit 0")
        .spawn()
        .unwrap();
    let stale_pid = stale_child.id();
    let _ = stale_child.wait_with_output().unwrap();
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&serde_json::json!({
            "protocol": 1,
            "pid": stale_pid,
            "socket": socket_path,
            "token": "stale-token"
        }))
        .unwrap(),
    )
    .unwrap();

    let program = executable_directory.path().join("echo");
    std::fs::write(
        &program,
        format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", replacement_endpoint),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (owner, events) = owner("replacement", "/projects/replacement");
    let service = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(hello["token"], token);
        stream
            .write_all(
                br#"{"operation":"hello","protocol":1,"ok":true}
"#,
            )
            .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        stream.write_all(line.as_bytes()).unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        let close: serde_json::Value = serde_json::from_str(&line).unwrap();
        let reply = serde_json::json!({
            "operation": "closed-owner",
            "request": close["request"],
            "ok": false,
            "error": "test close"
        });
        writeln!(stream, "{reply}").unwrap();
    });

    sidecars
        .send(&owner, ECHO, "surface", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    assert_eq!(events.recv_timeout(STALL).unwrap().surface, "surface");
    assert!(
        !service_directory.join("endpoint.json").exists(),
        "stale endpoint was not removed before the replacement path"
    );
    sidecars.stop();
    service.join().unwrap();
}

// contract: sidecars-transport.endpoint.live-unreachable-reported-without-replacement
#[test]
fn persistent_transport_reports_live_but_unreachable_endpoint_without_replacement() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let endpoint_path = service_directory.join("endpoint.json");
    let missing_socket = service_directory.join("missing.sock");
    std::fs::write(
        &endpoint_path,
        serde_json::to_vec(&serde_json::json!({
            "protocol": 1,
            "pid": std::process::id(),
            "socket": missing_socket,
            "token": "live-token"
        }))
        .unwrap(),
    )
    .unwrap();
    let original = std::fs::read(&endpoint_path).unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (owner, _events) = owner("unreachable", "/projects/unreachable");
    let error = sidecars
        .send(&owner, ECHO, "surface", &raw(r#"{"operation":"open"}"#))
        .unwrap_err();
    assert!(error.contains("connect authenticated service"), "{error}");
    assert_eq!(std::fs::read(&endpoint_path).unwrap(), original);
    sidecars.stop();
}

// contract: sidecars-transport.stop.close-owner-then-shutdown
#[test]
fn persistent_stop_closes_owner_then_requests_service_shutdown() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("shutdown.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "shutdown-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();

    let service = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(hello["operation"], "hello");
        assert_eq!(hello["token"], "shutdown-token");
        stream
            .write_all(
                br#"{"operation":"hello","protocol":1,"ok":true}
"#,
            )
            .unwrap();

        line.clear();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["body"]["operation"], "open");

        line.clear();
        reader.read_line(&mut line).unwrap();
        let close: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(close["operation"], "close-owner");
        let close_reply = serde_json::json!({
            "operation": "closed-owner",
            "request": close["request"],
            "ok": true
        });
        writeln!(stream, "{}", close_reply).unwrap();

        line.clear();
        reader.read_line(&mut line).unwrap();
        let shutdown: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(shutdown["operation"], "shutdown");
        let shutdown_reply = serde_json::json!({
            "operation": "shutdown",
            "request": shutdown["request"],
            "ok": true
        });
        writeln!(stream, "{}", shutdown_reply).unwrap();
    });

    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (owner, _events) = owner("shutdown", "/projects/shutdown");
    sidecars
        .send(&owner, ECHO, "surface", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    sidecars.stop();
    service.join().unwrap();
}

// contract: sidecars-transport.stop.own-close-is-not-a-read-error
#[test]
fn persistent_stop_does_not_log_its_own_close_as_a_read_error() {
    // The log is the standard error, so the same check runs as a child process and its output is read.
    if std::env::var_os("SOKSAK_OWN_CLOSE_CHILD").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "persistent_stop_does_not_log_its_own_close_as_a_read_error",
                "--nocapture",
            ])
            .env("SOKSAK_OWN_CLOSE_CHILD", "1")
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "the child check failed: {stderr}");
        assert!(
            !stderr.contains("persistent read"),
            "the stop logged its own close of the connection: {stderr}"
        );
        return;
    }
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("own.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "own-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    // The service does not close the connection even after it answered shutdown. The host closes the connection.
    let (release, released) = std::sync::mpsc::channel::<()>();
    let service = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let reply = match request["operation"].as_str() {
                Some("hello") => {
                    serde_json::json!({"operation": "hello", "protocol": 1, "ok": true})
                }
                Some("close-owner") => {
                    serde_json::json!({"operation": "closed-owner", "request": request["request"], "ok": true})
                }
                Some("shutdown") => {
                    serde_json::json!({"operation": "shutdown", "request": request["request"], "ok": true})
                }
                _ => continue,
            };
            writeln!(stream, "{}", reply).unwrap();
        }
        released.recv().unwrap();
    });
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (owner, _events) = owner("own", "/projects/own");
    sidecars
        .send(&owner, ECHO, "surface", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    sidecars.stop();
    release.send(()).unwrap();
    service.join().unwrap();
}

// contract: sidecars-transport.stop.accepts-close-answers-sent-before-stop
#[test]
fn persistent_stop_accepts_the_answer_to_a_close_sent_before_the_stop() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("late.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "late-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();

    // The service does not answer closed at once and answers after it received close-owner. That answer comes after the
    // stop started.
    let service = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut seen = Vec::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return seen;
            }
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let operation = if request["closed"] == true {
                "closed".to_string()
            } else if let Some(operation) = request["body"]["operation"].as_str() {
                operation.to_string()
            } else {
                request["operation"].as_str().unwrap_or("").to_string()
            };
            seen.push(operation.clone());
            match operation.as_str() {
                "hello" => {
                    writeln!(stream, r#"{{"operation":"hello","protocol":1,"ok":true}}"#).unwrap()
                }
                "close-owner" => {
                    writeln!(stream, r#"{{"surface":"surface","closed":true}}"#).unwrap();
                    let reply = serde_json::json!({
                        "operation": "closed-owner",
                        "request": request["request"],
                        "ok": true
                    });
                    writeln!(stream, "{reply}").unwrap();
                }
                "shutdown" => {
                    let reply = serde_json::json!({
                        "operation": "shutdown",
                        "request": request["request"],
                        "ok": true
                    });
                    writeln!(stream, "{reply}").unwrap();
                    return seen;
                }
                _ => {}
            }
        }
    });

    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (owner, _events) = owner("late", "/projects/late");
    sidecars
        .send(&owner, ECHO, "surface", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    sidecars.retain(&owner, &|_| false).unwrap();
    sidecars.stop();
    assert_eq!(
        service.join().unwrap(),
        ["hello", "open", "closed", "close-owner", "shutdown"]
    );
    assert!(
        sidecars.closing().is_empty(),
        "{:?}",
        sidecars.closing().len()
    );
}

// contract: sidecars.retain.sends-layout-and-known-surfaces, sidecars.retain.reports-service-failure
#[test]
fn persistent_retain_sends_layout_and_known_surfaces() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("retain.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "retain-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();

    let (requests, received) = channel::<serde_json::Value>();
    let service = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut answered = 0;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let reply = match request["operation"].as_str() {
                Some("hello") => {
                    serde_json::json!({"operation": "hello", "protocol": 1, "ok": true})
                }
                Some("retain") => {
                    answered += 1;
                    requests.send(request.clone()).unwrap();
                    if answered <= 2 {
                        serde_json::json!({"operation": "retained", "request": request["request"], "ok": true, "closed": 2})
                    } else {
                        serde_json::json!({"operation": "retained", "request": request["request"], "ok": false, "error": "retain failed in the service"})
                    }
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

    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    // If the layout has no surface and this process sent no surface either, an empty array is sent.
    assert_eq!(
        sidecars.retain_sessions(&[]).unwrap(),
        2,
        "the service's closed count"
    );
    let empty = received.recv_timeout(STALL).unwrap();
    assert_eq!(empty["surfaces"], serde_json::json!([]), "no kept surface");
    let (owner, _events) = owner("retain", "/live");
    sidecars
        .send(&owner, ECHO, "sent", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let closed = sidecars
        .retain_sessions(&[("listed".to_string(), "/project".to_string())])
        .unwrap();
    assert_eq!(closed, 2, "the service's closed count");
    let request = received.recv_timeout(STALL).unwrap();
    assert_eq!(
        request["surfaces"],
        serde_json::json!([
            {"surface": "listed", "root": "/project"},
            {"surface": "sent", "root": "/live"}
        ]),
        "the layout surfaces and the surfaces this process sent"
    );
    let error = sidecars.retain_sessions(&[]).unwrap_err();
    assert!(error.contains("retain failed in the service"), "{error}");
    sidecars.stop();
    service.join().unwrap();
}

// contract: sidecars.retain.rejects-after-stop
#[test]
fn persistent_retain_after_stop_sends_nothing() {
    // A retain after the stop does not attach to the service and fails with the stop. This host checks the stop and
    // sends inside one lock, so no stop intervenes between preparing the service and sending.
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("retain.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "retain-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::<FakeOwner>::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    sidecars.stop();
    assert_eq!(
        sidecars.retain_sessions(&[]),
        Err("sidecars are stopped".to_string())
    );
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "the stopped host connected to the service"
    );
}

// contract: sidecars.retain.skips-service-without-endpoint
#[test]
fn persistent_retain_skips_a_service_without_endpoint() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::<FakeOwner>::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    assert_eq!(sidecars.retain_sessions(&[]), Ok(0));
    sidecars.stop();
}

// contract: sidecars-transport.persistent.revives-a-lost-connection
#[test]
fn persistent_transport_revives_a_lost_connection_without_a_send() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("revive.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "revive-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();

    let service = thread::spawn(move || {
        let mut workers = Vec::new();
        for connection_index in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            workers.push(thread::spawn(move || {
                stream
                    .set_read_timeout(Some(Duration::from_secs(30)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
                assert_eq!(hello["operation"], "hello");
                stream
                    .write_all(
                        br#"{"operation":"hello","protocol":1,"ok":true}
"#,
                    )
                    .unwrap();
                if connection_index == 0 {
                    // The first connection returns one request and then cuts itself.
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    stream.write_all(line.as_bytes()).unwrap();
                    stream.shutdown(Shutdown::Both).unwrap();
                    return;
                }
                // The connection that was established again keeps returning requests.
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        return;
                    }
                    stream.write_all(line.as_bytes()).unwrap();
                }
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });

    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (owner, events) = owner("only", "/projects/only");
    sidecars
        .send(&owner, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    assert_eq!(events.recv_timeout(STALL).unwrap().surface, "s1");

    // When the connection is cut, it must be matched again without a send: the connection event is the evidence
    // (V5-106).
    let revived = events.recv_timeout(STALL).unwrap();
    assert_eq!(revived.surface, "s1");
    let notice: serde_json::Value = serde_json::from_str(revived.body.get()).unwrap();
    assert_eq!(notice["event"], "connection");
    assert_eq!(notice["connected"], true);

    // The next send passes through the connection that was established again.
    sidecars
        .send(&owner, ECHO, "s1", &raw(r#"{"operation":"input"}"#))
        .unwrap();
    let echoed = events.recv_timeout(STALL).unwrap();
    assert_eq!(echoed.surface, "s1");
    assert!(echoed.body.get().contains(r#""operation":"input""#));

    sidecars.stop();
    service.join().unwrap();
}

// contract: sidecars-transport.persistent.revive-failure-is-reported
#[test]
fn persistent_transport_reports_a_failed_revive_to_the_owner() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("failed-revive.sock");
    // This receiver accepts only the first connection and closes. The pid of the endpoint is this check process, so it
    // is alive, and the restart tries to connect to the same socket and is refused.
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "failed-revive-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    let service = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(hello["operation"], "hello");
        stream
            .write_all(
                br#"{"operation":"hello","protocol":1,"ok":true}
"#,
            )
            .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        stream.write_all(line.as_bytes()).unwrap();
        stream.shutdown(Shutdown::Both).unwrap();
        drop(listener);
    });

    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (owner, events) = owner("only", "/projects/only");
    sidecars
        .send(&owner, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    assert_eq!(events.recv_timeout(STALL).unwrap().surface, "s1");
    service.join().unwrap();

    // When the restart fails, the connection loss and its reason are reported to the surface (V5-106).
    let failure = events.recv_timeout(STALL).unwrap();
    assert_eq!(failure.surface, "s1");
    let notice: serde_json::Value = serde_json::from_str(failure.body.get()).unwrap();
    assert_eq!(notice["event"], "connection");
    assert_eq!(notice["connected"], false);
    assert!(
        notice["reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty()),
        "the failure notice carries the restart reason"
    );
    sidecars.stop();
}

/// A window that receives sidecar messages and failures separately.
#[derive(Clone)]
struct FailureOwner {
    sent: Sender<Message>,
    failed: Sender<Failure>,
}

impl Owner for FailureOwner {
    fn key(&self) -> String {
        "only".into()
    }
    fn root(&self) -> Result<String, String> {
        Ok("/projects/only".into())
    }
    fn deliver(&self, message: Message) {
        let _ = self.sent.send(message);
    }
    fn deliver_failure(&self, failure: Failure) {
        let _ = self.failed.send(failure);
    }
}

/// A service that answers a connection with hello, receives one request line and then writes payload. It ends when the
/// host closes the connection. If the host closes before payload is written completely, the write error is an expected
/// result.
fn expect_connection_failure(payload: Vec<u8>, reason: &str) {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("bad-line.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1, "pid": std::process::id(), "socket": socket_path, "token": "bad-line-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    let service = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        stream
            .write_all(b"{\"operation\":\"hello\",\"protocol\":1,\"ok\":true}\n")
            .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        let mut writer = stream.try_clone().unwrap();
        thread::spawn(move || {
            let _ = writer.write_all(&payload);
        });
        // When the host closes the connection, the read ends with EOF.
        std::io::copy(&mut reader, &mut std::io::sink()).unwrap();
    });
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (sent, messages) = channel();
    let (failed, failures) = channel();
    let owner = FailureOwner { sent, failed };
    sidecars
        .send(&owner, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let failure = failures
        .recv_timeout(STALL)
        .expect("no sidecar failure; the test stalled");
    assert_eq!(
        (failure.sidecar.as_str(), failure.surface.as_str()),
        (ECHO, "s1")
    );
    assert!(
        failure.reason.starts_with(reason),
        "{failure:?}, want {reason}"
    );
    assert!(
        messages.try_recv().is_err(),
        "the bad line was delivered as a message"
    );
    service.join().unwrap();
    sidecars.stop();
}

// contract: sidecars-transport.persistent.invalid-event-fails-the-connection
#[test]
fn persistent_transport_fails_the_connection_on_an_invalid_event() {
    expect_connection_failure(
        b"{\"surface\":5,\"body\":{}}\n".to_vec(),
        "invalid message: ",
    );
    expect_connection_failure(b"not json\n".to_vec(), "invalid message: ");
}

// contract: sidecars-transport.persistent.oversize-line-fails-the-connection
#[test]
fn persistent_transport_fails_the_connection_on_an_oversize_line() {
    expect_connection_failure(
        vec![b'x'; (64 << 20) + 2],
        &format!("message exceeds {} bytes", 64 << 20),
    );
}

// The start of a persistent sidecar (the service connection and hello) does not make sends to other sidecars wait. The
// service answers hello 500 ms late, and meanwhile sends go to another sidecar that is already running.
// contract: sidecars.send.start-does-not-block-other-sidecars
#[test]
fn persistent_start_does_not_delay_other_sidecars() {
    let executable_directory = tempfile::tempdir().unwrap();
    let fast = executable_directory.path().join("fast");
    std::fs::write(&fast, "#!/bin/sh\ntee /dev/null\n").unwrap();
    std::fs::set_permissions(&fast, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("start.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "start-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    let (hello_seen, hello_received) = channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut hello = String::new();
        reader.read_line(&mut hello).unwrap();
        hello_seen.send(()).unwrap();
        thread::sleep(Duration::from_millis(500));
        writeln!(
            stream,
            "{{\"operation\":\"hello\",\"protocol\":1,\"ok\":true}}"
        )
        .unwrap();
        // Discard the received lines until the connection ends.
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            line.clear();
        }
    });

    let fixture: Files = vec![
        (
            ECHO,
            r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#.to_string(),
        ),
        (
            "@fixture/sidecar-fast",
            r#"{"executable":"fast","protocol":1}"#.to_string(),
        ),
    ];
    let mut sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    sidecars.stop_timeout = Duration::from_millis(100);
    let (window, _events) = owner("start", "/projects/start");
    sidecars
        .send(
            &window,
            "@fixture/sidecar-fast",
            "fast-surface",
            &raw(r#"{"data":"start"}"#),
        )
        .unwrap();
    let waited = thread::scope(|scope| {
        let service = scope.spawn(|| {
            sidecars.send(
                &window,
                ECHO,
                "service-surface",
                &raw(r#"{"operation":"open"}"#),
            )
        });
        hello_received.recv_timeout(STALL).unwrap();
        let begin = std::time::Instant::now();
        sidecars
            .send(
                &window,
                "@fixture/sidecar-fast",
                "fast-surface",
                &raw(r#"{"data":"during"}"#),
            )
            .unwrap();
        let waited = begin.elapsed();
        service.join().unwrap().unwrap();
        waited
    });
    assert!(
        waited < Duration::from_millis(50),
        "a send to another sidecar waited {waited:?} for the service start, want < 50ms"
    );
    sidecars.stop();
    server.join().unwrap();
}

/// Sends to the sidecar and returns the result within limit. If it does not return, the check fails.
fn send_within(
    sidecars: Sidecars<FakeOwner>,
    window: FakeOwner,
    limit: Duration,
) -> Result<(), String> {
    let (result, answer) = channel();
    thread::spawn(move || {
        let sent = sidecars.send(&window, ECHO, "surface", &raw(r#"{"operation":"open"}"#));
        let _ = result.send(sent);
    });
    answer
        .recv_timeout(limit)
        .unwrap_or_else(|_| panic!("the send did not return within {limit:?}"))
}

// A start with a service that receives hello and does not answer fails after 5 seconds with the defined text.
// contract: sidecars-transport.hello.times-out
#[test]
fn persistent_start_fails_when_hello_is_not_answered() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("hello.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "hello-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    let (release, released) = channel::<()>();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream);
        let mut hello = String::new();
        reader.read_line(&mut hello).unwrap();
        let _ = released.recv();
    });
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (window, _events) = owner("hello", "/projects/hello");
    let error = send_within(sidecars, window, Duration::from_secs(30)).unwrap_err();
    assert_eq!(
        error,
        "sidecar @fixture/sidecar-echo: the service did not answer hello within 5s"
    );
    release.send(()).unwrap();
    server.join().unwrap();
}

// If a newly started service does not print an endpoint, the start fails with the defined text after the ready upper
// limit, and the host ends and reaps that service. The check gives 1 second instead of the default 30 seconds. The
// service starts its work later than the upper limit, so it ends as soon as it starts regardless of the load, and the
// check looks at whether a running process remains on its unique path.
// contract: sidecars-transport.startup.times-out
#[test]
fn persistent_start_fails_when_the_service_prints_no_endpoint() {
    let executable_directory = tempfile::tempdir().unwrap();
    let service = executable_directory.path().join("echo");
    std::fs::write(&service, "#!/bin/sh\nsleep 2\nwhile :; do sleep 1; done\n").unwrap();
    std::fs::set_permissions(&service, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap()
    .with_ready_timeout(Duration::from_secs(1));
    let (window, _events) = owner("startup", "/projects/startup");
    let error = send_within(sidecars, window, Duration::from_secs(30)).unwrap_err();
    assert_eq!(
        error,
        "sidecar @fixture/sidecar-echo: the service did not print its endpoint within 1s"
    );
    let running = Command::new("pgrep")
        .args(["-f", service.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        !running.status.success(),
        "the silent service still runs: {}",
        String::from_utf8_lossy(&running.stdout)
    );
}

// The standard error of a newly started service accumulates in the log of the executable name in the configuration
// directory.
// contract: log.service.standard-error-goes-to-service-log
#[test]
fn persistent_service_writes_its_standard_error_to_its_log() {
    let executable_directory = tempfile::tempdir().unwrap();
    let service = executable_directory.path().join("echo");
    std::fs::write(&service, "#!/bin/sh\necho service line >&2\nexit 0\n").unwrap();
    std::fs::set_permissions(&service, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (window, _events) = owner("exit", "/projects/exit");
    send_within(sidecars, window, Duration::from_secs(30)).unwrap_err();
    assert_eq!(
        std::fs::read_to_string(config_directory.path().join("logs").join("echo.log")).unwrap(),
        "service line\n"
    );
}

/// Ends the service that the check made start when the check ends.
struct EndService(i32);

impl Drop for EndService {
    fn drop(&mut self) {
        if unsafe { libc::kill(self.0, libc::SIGKILL) } != 0 {
            eprintln!(
                "end the service {}: {}",
                self.0,
                std::io::Error::last_os_error()
            );
        }
    }
}

// A service that the host started is the leader of a new session. It therefore does not receive the signals of the
// process group of the application and of the terminal. The service writes its number to a file, prints an endpoint,
// and remains until the check ends it.
// contract: sidecars-transport.persistent.starts-in-new-session
#[test]
fn persistent_service_starts_in_a_new_session() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let socket_directory = tempfile::tempdir().unwrap();
    let socket_path = socket_directory.path().join("service.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let pid_path = executable_directory.path().join("pid");
    let service = executable_directory.path().join("echo");
    std::fs::write(
        &service,
        format!(
            "#!/bin/sh\necho $$ > '{}'\nprintf '{{\"protocol\":1,\"pid\":%d,\"socket\":\"{}\",\"token\":\"session-token\"}}\\n' $$\nexec sleep 600\n",
            pid_path.display(),
            socket_path.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&service, std::fs::Permissions::from_mode(0o755)).unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (owner, events) = owner("session", "/projects/session");
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(hello["token"], "session-token");
        stream
            .write_all(
                br#"{"operation":"hello","protocol":1,"ok":true}
"#,
            )
            .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        stream.write_all(line.as_bytes()).unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        let close: serde_json::Value = serde_json::from_str(&line).unwrap();
        let reply = serde_json::json!({
            "operation": "closed-owner",
            "request": close["request"],
            "ok": false,
            "error": "test close"
        });
        writeln!(stream, "{reply}").unwrap();
    });

    sidecars
        .send(&owner, ECHO, "surface", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    assert_eq!(events.recv_timeout(STALL).unwrap().surface, "surface");
    // The service wrote its number before it printed the endpoint.
    let pid: i32 = std::fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let _end = EndService(pid);
    let session = unsafe { libc::getsid(pid) };
    assert!(
        session != -1,
        "session of the service {pid}: {}",
        std::io::Error::last_os_error()
    );
    assert_eq!(
        session,
        pid,
        "the service {pid} is in session {session} (the test is in session {}), want its own session",
        unsafe { libc::getsid(0) }
    );
    sidecars.stop();
    server.join().unwrap();
}

// If the service log cannot be opened, the service is not started and the start fails with the defined text.
// contract: log.service.open-failure-fails-start
#[test]
fn persistent_start_fails_when_the_service_log_cannot_open() {
    let executable_directory = tempfile::tempdir().unwrap();
    let started = executable_directory.path().join("started");
    let service = executable_directory.path().join("echo");
    std::fs::write(
        &service,
        format!("#!/bin/sh\ntouch {}\n", started.display()),
    )
    .unwrap();
    std::fs::set_permissions(&service, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    // If logs is a file, the log directory cannot be created.
    std::fs::write(config_directory.path().join("logs"), "").unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (window, _events) = owner("exit", "/projects/exit");
    let error = send_within(sidecars, window, Duration::from_secs(30)).unwrap_err();
    let want = "sidecar @fixture/sidecar-echo: service log: create logs directory: ";
    assert!(
        error.starts_with(want),
        "service log failure = {error}, want prefix {want:?}"
    );
    assert!(!started.exists(), "the service started");
}

// If a newly started service ends before it prints an endpoint, the start fails with the defined text.
// contract: sidecars-transport.startup.exits-before-endpoint
#[test]
fn persistent_start_fails_when_the_service_exits_before_its_endpoint() {
    let executable_directory = tempfile::tempdir().unwrap();
    let service = executable_directory.path().join("echo");
    std::fs::write(&service, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&service, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (window, _events) = owner("exit", "/projects/exit");
    let error = send_within(sidecars, window, Duration::from_secs(30)).unwrap_err();
    assert_eq!(
        error,
        "sidecar @fixture/sidecar-echo: service exited before endpoint"
    );
}

// contract: sidecars-transport.hello.reports-a-service-of-another-version
#[test]
fn a_persistent_service_of_another_version_is_reported_outdated() {
    let cases: [(Option<&str>, Vec<OutdatedSidecar>); 3] = [
        (
            Some("0.0.6"),
            vec![OutdatedSidecar {
                sidecar: ECHO.to_string(),
                running: Some("0.0.6".to_string()),
                installed: "0.0.7".to_string(),
                sessions: 1,
            }],
        ),
        (
            None,
            vec![OutdatedSidecar {
                sidecar: ECHO.to_string(),
                running: None,
                installed: "0.0.7".to_string(),
                sessions: 1,
            }],
        ),
        (Some("0.0.7"), vec![]),
    ];
    for (version, want) in cases {
        let executable_directory = tempfile::tempdir().unwrap();
        let config_directory = tempfile::tempdir().unwrap();
        let service_directory = config_directory.path().join("services/echo");
        std::fs::create_dir_all(&service_directory).unwrap();
        let socket_path = service_directory.join("version.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let endpoint = serde_json::json!({
            "protocol": 1,
            "pid": std::process::id(),
            "socket": socket_path,
            "token": "version-token"
        });
        std::fs::write(
            service_directory.join("endpoint.json"),
            serde_json::to_vec(&endpoint).unwrap(),
        )
        .unwrap();
        // The service answers hello with the version of the case and echoes each surface request.
        let reply_version = version.map(str::to_string);
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 {
                let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                let reply = if request["operation"] == "hello" {
                    let mut answer =
                        serde_json::json!({"operation": "hello", "protocol": 1, "ok": true});
                    if let Some(version) = &reply_version {
                        answer["version"] = serde_json::json!(version);
                    }
                    answer.to_string()
                } else {
                    line.trim_end().to_string()
                };
                if writeln!(stream, "{reply}").is_err() {
                    return;
                }
                line.clear();
            }
        });
        let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
        let mut declarations = declare(&fixture, executable_directory.path());
        declarations[0].version = "0.0.7".to_string();
        let sidecars = Sidecars::new(&declarations, config_directory.path().to_path_buf()).unwrap();
        let (owner, events) = owner("version", "/projects/version");
        sidecars
            .send(&owner, ECHO, "surface", &raw(r#"{"operation":"open"}"#))
            .unwrap();
        events.recv_timeout(STALL).unwrap();
        assert_eq!(sidecars.outdated(), want, "hello version {version:?}");
        sidecars.stop();
    }
}

// contract: sidecars-transport.persistent.lost-connection-writes-an-error-line
#[test]
fn a_lost_connection_is_reported_as_an_error_line() {
    use soksak_host_tauriv2::sidecars::connection_loss_report;
    assert_eq!(
        connection_loss_report("fixture-service", &Ok(true)),
        Some((
            "sidecar fixture-service".to_string(),
            "connection lost; restarted".to_string()
        ))
    );
    assert_eq!(connection_loss_report("fixture-service", &Ok(false)), None);
    assert_eq!(
        connection_loss_report("fixture-service", &Err("refused".to_string())),
        Some((
            "sidecar fixture-service".to_string(),
            "connection lost; restart failed: refused".to_string()
        ))
    );
}

/// A fake persistent service that the host replaces: its first connection reports the old version, acknowledges
/// close-owner and shutdown and then ends; its second connection reports the installed version.
struct ReplaceService {
    /// The top-level operations that the first connection received (a message of a surface has none).
    operations: Arc<Mutex<Vec<String>>>,
    /// Receives the time of the second connection when it is accepted.
    second: Receiver<std::time::Instant>,
    /// The time at which the process of the service was ended after the shutdown answer.
    ended: Receiver<std::time::Instant>,
    /// Receives when the first connection ends, whichever side ends it.
    first_ended: Receiver<()>,
}

fn serve_replace_service(
    config_directory: &Path,
    executable_directory: &Path,
    old: &str,
    installed: &str,
    ends_after: Duration,
) -> ReplaceService {
    let service_directory = config_directory.join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("replace.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    // The endpoint names a process that stands for the service and ends after the shutdown answer.
    let process = std::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .expect("spawn sleep");
    let process_id = process.id();
    let process = Arc::new(Mutex::new(process));
    // The executable that the host starts for the installed service announces the endpoint of this fake service.
    let script = format!(
        "#!/bin/sh\nprintf '{{\"protocol\":1,\"pid\":%s,\"socket\":\"{}\",\"token\":\"replace-token\"}}\\n' \"$$\"\nexec sleep 20\n",
        socket_path.display()
    );
    let executable = executable_directory.join("echo");
    std::fs::write(&executable, script).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": process_id,
        "socket": socket_path,
        "token": "replace-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    let operations = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&operations);
    let (second_sender, second) = channel();
    let (first_ended_sender, first_ended) = channel();
    let (ended_sender, ended) = channel();
    let ending = Arc::clone(&process);
    let (old, installed) = (old.to_string(), installed.to_string());
    thread::spawn(move || {
        for index in 0.. {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let first = index == 0;
            let version = if first {
                old.clone()
            } else {
                installed.clone()
            };
            if !first {
                let _ = second_sender.send(std::time::Instant::now());
            }
            let recorded = Arc::clone(&recorded);
            let ending = Arc::clone(&ending);
            let ended_sender = ended_sender.clone();
            let first_ended_sender = first.then(|| first_ended_sender.clone());
            thread::spawn(move || {
                // The first connection reports its end whichever way the loop below returns.
                struct Ended(Option<Sender<()>>);
                impl Drop for Ended {
                    fn drop(&mut self) {
                        if let Some(sender) = &self.0 {
                            // The check stopped waiting for the end, so no one receives it.
                            let _ = sender.send(());
                        }
                    }
                }
                let _ended = Ended(first_ended_sender);
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                    let operation = request["operation"].as_str().unwrap_or("").to_string();
                    if first {
                        recorded.lock().unwrap().push(operation.clone());
                    }
                    let reply = match operation.as_str() {
                        "hello" => serde_json::json!({"operation": "hello", "protocol": 1, "ok": true, "version": version}).to_string(),
                        "close-owner" => serde_json::json!({"operation": "closed-owner", "request": request["request"], "ok": true}).to_string(),
                        "shutdown" => serde_json::json!({"operation": "shutdown", "request": request["request"], "ok": true}).to_string(),
                        _ => line.trim_end().to_string(),
                    };
                    if writeln!(stream, "{reply}").is_err() {
                        return;
                    }
                    if operation == "shutdown" {
                        let (ending, ended_sender) = (Arc::clone(&ending), ended_sender.clone());
                        std::thread::spawn(move || {
                            std::thread::sleep(ends_after);
                            let mut process = ending.lock().unwrap();
                            let _ = process.kill();
                            let _ = process.wait();
                            let _ = ended_sender.send(std::time::Instant::now());
                        });
                        return;
                    }
                    line.clear();
                }
            });
        }
    });
    ReplaceService {
        operations,
        second,
        ended,
        first_ended,
    }
}

fn replace_sidecars(config_directory: &Path, executable_directory: &Path) -> Sidecars<FakeOwner> {
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let mut declarations = declare(&fixture, executable_directory);
    declarations[0].version = "0.0.7".to_string();
    Sidecars::new(&declarations, config_directory.to_path_buf()).unwrap()
}

// contract: sidecars-transport.replace.replaces-an-outdated-service
#[test]
fn an_outdated_service_is_replaced() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service = serve_replace_service(
        config_directory.path(),
        executable_directory.path(),
        "0.0.6",
        "0.0.7",
        Duration::ZERO,
    );
    let sidecars = replace_sidecars(config_directory.path(), executable_directory.path());
    let (owner, events) = owner("replace", "/projects/replace");
    sidecars
        .send(&owner, ECHO, "surface-1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    events.recv_timeout(STALL).unwrap();
    assert_eq!(
        sidecars.outdated(),
        vec![OutdatedSidecar {
            sidecar: ECHO.to_string(),
            running: Some("0.0.6".to_string()),
            installed: "0.0.7".to_string(),
            sessions: 1,
        }]
    );
    sidecars.replace(ECHO).unwrap();
    // The surface that sent to the sidecar receives the connection notice of the new service.
    let notice = events.recv_timeout(STALL).unwrap();
    assert_eq!(notice.surface, "surface-1");
    let event: serde_json::Value = serde_json::from_str(notice.body.get()).unwrap();
    assert_eq!(
        (event["event"].as_str(), event["connected"].as_bool()),
        (Some("connection"), Some(true))
    );
    service.second.recv_timeout(STALL).unwrap();
    assert!(sidecars.outdated().is_empty());
    assert_eq!(
        *service.operations.lock().unwrap(),
        ["hello", "", "close-owner", "shutdown"]
    );
    sidecars.stop();
}

// contract: sidecars-transport.replace.refuses-a-service-that-is-not-outdated
#[test]
fn a_service_that_is_not_outdated_is_not_replaced() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service = serve_replace_service(
        config_directory.path(),
        executable_directory.path(),
        "0.0.7",
        "0.0.7",
        Duration::ZERO,
    );
    let sidecars = replace_sidecars(config_directory.path(), executable_directory.path());
    let error = sidecars.replace(ECHO).unwrap_err();
    assert!(error.contains(ECHO), "{error}");
    let (owner, events) = owner("replace", "/projects/replace");
    sidecars
        .send(&owner, ECHO, "surface-1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    events.recv_timeout(STALL).unwrap();
    let error = sidecars.replace(ECHO).unwrap_err();
    assert!(error.contains(ECHO), "{error}");
    assert_eq!(*service.operations.lock().unwrap(), ["hello", ""]);
    sidecars.stop();
}

// contract: sidecars-transport.replace.runs-when-sessions-reach-zero
#[test]
fn an_outdated_service_is_replaced_when_its_sessions_end() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service = serve_replace_service(
        config_directory.path(),
        executable_directory.path(),
        "0.0.6",
        "0.0.7",
        Duration::ZERO,
    );
    let sidecars = replace_sidecars(config_directory.path(), executable_directory.path());
    let (owner, events) = owner("replace", "/projects/replace");
    sidecars
        .send(&owner, ECHO, "surface-1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    events.recv_timeout(STALL).unwrap();
    sidecars.retain(&owner, &|_| false).unwrap();
    service.second.recv_timeout(STALL).unwrap();
    let operations = service.operations.lock().unwrap().clone();
    assert_eq!(
        &operations[operations.len() - 2..],
        ["close-owner", "shutdown"]
    );
    sidecars.stop();
}

// contract: sidecars-transport.replace.waits-for-the-end-of-the-service-process
#[test]
fn a_replaced_service_starts_after_the_end_of_its_process() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service = serve_replace_service(
        config_directory.path(),
        executable_directory.path(),
        "0.0.6",
        "0.0.7",
        Duration::from_millis(300),
    );
    let sidecars = replace_sidecars(config_directory.path(), executable_directory.path());
    let (owner, events) = owner("replace", "/projects/replace");
    sidecars
        .send(&owner, ECHO, "surface-1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    events.recv_timeout(STALL).unwrap();
    sidecars.replace(ECHO).unwrap();
    let second = service.second.recv_timeout(STALL).unwrap();
    let ended = service.ended.recv_timeout(STALL).unwrap();
    assert!(
        second > ended,
        "the installed service started {:?} before its predecessor ended",
        ended.saturating_duration_since(second)
    );
    sidecars.stop();
}

// contract: sidecars-transport.hello.client-is-the-configuration-directory
#[test]
fn the_hello_carries_the_configuration_directory_as_client() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("client.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let endpoint = serde_json::json!({
        "protocol": 1,
        "pid": std::process::id(),
        "socket": socket_path,
        "token": "client-token"
    });
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&endpoint).unwrap(),
    )
    .unwrap();
    let (hello_sender, hello) = channel();
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let reply = if request["operation"] == "hello" {
                let _ = hello_sender.send(request.clone());
                serde_json::json!({"operation": "hello", "protocol": 1, "ok": true}).to_string()
            } else {
                line.trim_end().to_string()
            };
            if writeln!(stream, "{reply}").is_err() {
                return;
            }
            line.clear();
        }
    });
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let declarations = declare(&fixture, executable_directory.path());
    let sidecars = Sidecars::new(&declarations, config_directory.path().to_path_buf()).unwrap();
    let (owner, events) = owner("client", "/projects/client");
    sidecars
        .send(&owner, ECHO, "surface-1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    events.recv_timeout(STALL).unwrap();
    let request = hello.recv_timeout(STALL).unwrap();
    // The configuration directory is the host-resolved one, with symlinks resolved (docs/spec/performance-trace.md).
    let resolved = std::fs::canonicalize(config_directory.path()).unwrap();
    assert_eq!(
        request["client"].as_str(),
        resolved.to_str(),
        "the hello names the configuration directory of the application"
    );
    sidecars.stop();
}

// contract: sidecars-transport.stop.leaves-the-close-of-a-replacement-to-the-replacement
#[test]
fn stop_does_not_close_the_owner_again_while_a_replacement_closes_it() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service_directory = config_directory.path().join("services/echo");
    std::fs::create_dir_all(&service_directory).unwrap();
    let socket_path = service_directory.join("replacing.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    std::fs::write(
        service_directory.join("endpoint.json"),
        serde_json::to_vec(&serde_json::json!({
            "protocol": 1,
            "pid": std::process::id(),
            "socket": socket_path,
            "token": "replacing-token"
        }))
        .unwrap(),
    )
    .unwrap();

    // The service reads every line at once and answers close-owner and shutdown only when the check releases the
    // answers, so a replacement is in progress while the application stops.
    let (seen_sender, seen) = channel::<String>();
    let (release, released) = channel::<()>();
    let service = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let (requests_sender, requests) = channel::<serde_json::Value>();
        let writer = thread::spawn(move || {
            released.recv().unwrap();
            while let Ok(request) = requests.recv() {
                let operation = request["operation"].as_str().unwrap_or("");
                let reply = match operation {
                    "close-owner" => {
                        serde_json::json!({"operation": "closed-owner", "request": request["request"], "ok": true})
                    }
                    "shutdown" => {
                        serde_json::json!({"operation": "shutdown", "request": request["request"], "ok": true})
                    }
                    _ => continue,
                };
                if writeln!(stream, "{reply}").is_err() {
                    return;
                }
                if operation == "shutdown" {
                    return;
                }
            }
        });
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let operation = request["operation"].as_str().unwrap_or("").to_string();
            if operation == "hello" {
                // The version differs from the installed one, so the service is outdated.
                let reply = serde_json::json!({"operation": "hello", "protocol": 1, "ok": true, "version": "0.0.6"});
                writeln!(reader.get_mut(), "{reply}").unwrap();
            }
            seen_sender.send(operation.clone()).unwrap();
            if operation == "close-owner" || operation == "shutdown" {
                requests_sender.send(request).unwrap();
            }
            line.clear();
        }
        drop(requests_sender);
        writer.join().unwrap();
    });
    let sidecars = Arc::new(replace_sidecars(
        config_directory.path(),
        executable_directory.path(),
    ));
    let (owner, _events) = owner("replacing", "/projects/replacing");
    sidecars
        .send(&owner, ECHO, "surface-1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    // The service sends no message to the owner, so the check does not wait for one: the loop below waits until the
    // service has read the close-owner of the replacement.
    let replacing = {
        let sidecars = Arc::clone(&sidecars);
        thread::spawn(move || sidecars.replace(ECHO))
    };
    // The replacement has sent its close-owner when the service has read it.
    loop {
        if seen.recv_timeout(STALL).unwrap() == "close-owner" {
            break;
        }
    }
    let stopping = {
        let sidecars = Arc::clone(&sidecars);
        thread::spawn(move || sidecars.stop())
    };
    // The stop leaves the close of the owner to the replacement: the service reads no second close-owner while it
    // holds the first answer.
    if let Ok(operation) = seen.recv_timeout(Duration::from_millis(300)) {
        panic!("the stop sent {operation} while the replacement closed the owner");
    }
    release.send(()).unwrap();
    stopping.join().unwrap();
    replacing.join().unwrap().unwrap();
    service.join().unwrap();
}

// contract: sidecars-transport.detach.closes-the-connection-without-closing-the-owner
#[test]
fn detach_closes_the_connection_of_a_persistent_service_without_closing_the_owner() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let service = serve_replace_service(
        config_directory.path(),
        executable_directory.path(),
        "0.0.7",
        "0.0.7",
        Duration::ZERO,
    );
    let sidecars = replace_sidecars(config_directory.path(), executable_directory.path());
    let (owner, events) = owner("detach", "/projects/detach");
    sidecars
        .send(&owner, ECHO, "surface-1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    events.recv_timeout(STALL).unwrap();
    sidecars.detach();
    // The connection ends, which is the only thing that the service learns, and the sessions of the service stay.
    service.first_ended.recv_timeout(STALL).unwrap();
    let operations = service.operations.lock().unwrap().clone();
    assert!(
        !operations
            .iter()
            .any(|operation| operation == "close-owner" || operation == "shutdown"),
        "the service received {operations:?}"
    );
    // Stopping after a detach does nothing more to the service.
    sidecars.stop();
    let operations = service.operations.lock().unwrap().clone();
    assert!(
        !operations
            .iter()
            .any(|operation| operation == "close-owner" || operation == "shutdown"),
        "the stop after the detach sent to the service: {operations:?}"
    );
}

// contract: sidecars-transport.persistent.connection-events
#[test]
fn persistent_connections_are_recorded_as_events() {
    // The writer of the records is shared by the process, so the scenario runs in a child process that nothing else writes in.
    if let Some(config) = std::env::var_os("SOKSAK_CONNECTION_EVENTS_CHILD") {
        let executable_directory = tempfile::tempdir().unwrap();
        let config_directory = tempfile::tempdir().unwrap();
        let service_directory = config_directory.path().join("services/echo");
        std::fs::create_dir_all(&service_directory).unwrap();
        let socket_path = service_directory.join("events.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        std::fs::write(
            service_directory.join("endpoint.json"),
            serde_json::to_vec(&serde_json::json!({
                "protocol": 1, "pid": std::process::id(), "socket": socket_path, "token": "events-token"
            }))
            .unwrap(),
        )
        .unwrap();
        // The first connection answers one request and closes; the second stays open.
        let service = thread::spawn(move || {
            let mut workers = Vec::new();
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                workers.push(thread::spawn(move || {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(30)))
                        .unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    stream
                        .write_all(b"{\"operation\":\"hello\",\"protocol\":1,\"ok\":true}\n")
                        .unwrap();
                    loop {
                        line.clear();
                        if reader.read_line(&mut line).unwrap() == 0 {
                            return;
                        }
                        stream.write_all(line.as_bytes()).unwrap();
                        if index == 0 {
                            stream.shutdown(Shutdown::Both).unwrap();
                            return;
                        }
                    }
                }));
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        let writer = records::start_writer(Path::new(&config));
        soksak_host_tauriv2::performance::command(serde_json::json!({"action": "on"})).unwrap();
        records::wait_for_first_sample(Path::new(&config), &writer);
        let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
        let sidecars = Sidecars::new(
            &declare(&fixture, executable_directory.path()),
            config_directory.path().to_path_buf(),
        )
        .unwrap();
        let (owner, events) = owner("only", "/projects/only");
        sidecars
            .send(&owner, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
            .unwrap();
        events.recv_timeout(STALL).unwrap(); // the echo
        events.recv_timeout(STALL).unwrap(); // the notice of the reconnection
        // The sampler names the service while it is connected and not after the connection ended.
        soksak_host_tauriv2::performance::sample();
        sidecars.stop();
        soksak_host_tauriv2::performance::sample();
        service.join().unwrap();
        soksak_host_tauriv2::performance::command(serde_json::json!({"action": "off"})).unwrap();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "persistent_connections_are_recorded_as_events",
            "--nocapture",
        ])
        .env("SOKSAK_CONNECTION_EVENTS_CHILD", config.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the child check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let seen: Vec<String> = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| {
            matches!(
                event["event"].as_str(),
                Some("host.sidecar.connect" | "host.sidecar.disconnect")
            )
        })
        .map(|event| {
            assert_eq!(event["fields"]["name"], ECHO);
            format!(
                "{} {}",
                event["event"].as_str().unwrap(),
                event["fields"]["stopping"]
            )
        })
        .collect();
    assert_eq!(
        seen,
        vec![
            "host.sidecar.connect null",
            "host.sidecar.disconnect false",
            "host.sidecar.connect null",
            "host.sidecar.disconnect true"
        ]
    );
    // One sample while the service is connected names it; the sample after the connection ended does not.
    let sampled = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| event["event"] == "host.sampler.memory" && event["fields"]["name"] == ECHO)
        .count();
    assert_eq!(sampled, 1, "samples that name the service");
}
