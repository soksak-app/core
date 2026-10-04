//! 사이드카 지속 전송 테스트. 가짜 창과 서비스 엔드포인트 하네스를 사용한다.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;
use std::time::Duration;

use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixListener;
use std::process::Command;

use serde_json::value::RawValue;
use soksak_host_tauriv2::sidecars::{Failure, Message, Owner, SidecarDeclaration, Sidecars};

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
        // 이 검사들은 실패를 단언하지 않으므로 실패는 검사 출력에 남긴다.
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

/// 사이드카 @fixture/sidecar-echo 하나와 그 sidecar.json 내용.
fn files(sidecar: &str) -> Files {
    vec![("@fixture/sidecar-echo", sidecar.to_string())]
}

/// folder 에 설치된 사이드카들의 선언.
fn declare(files: &Files, folder: &Path) -> Vec<SidecarDeclaration> {
    files
        .iter()
        .map(|(name, data)| SidecarDeclaration {
            name: name.to_string(),
            folder: folder.to_path_buf(),
            data: data.as_bytes().to_vec(),
        })
        .collect()
}

const ECHO: &str = "@fixture/sidecar-echo";

/// 멈춘 검사를 끝내는 상한이다. 성공은 받은 event 로 판정하며 이 시간으로 판정하지 않는다.
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

    // 연결마다 스레드로 담는다 — 실제 서비스처럼 동시에 받아야 한 인사가 다른 연결의
    // 요청 왕복 뒤에 줄서지 않는다. 넉 연결을 받는다: 두 초기 연결과, 검사가 연결을
    // 닫을 때마다 다시 맺는 자동 재시작의 연결(V5-106). 요청을 기다리다 기한이 지나면
    // 조용히 끝난다 — 재시작 연결은 검사가 끝날 때까지 요청을 받지 않는다.
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
        // 이 서비스는 연결을 제멋대로 끊지 않는다(V5-106 의 자동 재시작과 연결 순서가
        // 경합하지 않게). `drop` 요청을 받은 연결만 끊고, 그 외 요청은 되돌린다.
        // close-owner 에는 실패로 답해 stop 이 기한을 기다리지 않게 한다.
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
                    // 페이지 요청의 operation 은 body 안에 있다. drop 은 이 연결을 끊는
                    // 검사 신호다.
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
    // 서비스가 두 연결을 끊게 한다. 끊김은 연결 이벤트로 기다린다(V5-106). 자동 재시작은
    // EOF 에만 반응하므로, 각 인스턴스의 연결 이벤트가 도착했다는 것이 서비스가 그 연결을
    // 끊었다는 증거다.
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

    // 서비스는 close-owner 에 실패로 답한다. 종료는 제한 시간까지 기다리지 않고 바로 끝난다.
    let stopping = std::time::Instant::now();
    first.stop();
    second.stop();
    let elapsed = stopping.elapsed();
    // 실패한 close-owner 답은 stop 의 기한을 기다리지 않고 끝난다. 기한까지 걸렸으면 답을 기다리지 않은 것이다.
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
    // 레이아웃에 표면이 없고 이 프로세스가 보낸 표면도 없으면 빈 배열을 보낸다.
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
    // 멈춘 뒤의 retain 은 서비스에 붙지 않고 멈춤으로 실패한다. 이 host 는 멈춤 확인과 보내기를 한 잠금 안에서 하므로
    // 서비스를 준비한 뒤 보내기 전에 끼어드는 stop 은 없다.
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
                    // 첫 연결은 요청 하나를 되돌린 뒤 스스로 끊는다.
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    stream.write_all(line.as_bytes()).unwrap();
                    stream.shutdown(Shutdown::Both).unwrap();
                    return;
                }
                // 다시 맺은 연결은 요청을 계속 되돌린다.
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

    // 연결이 끊기면 전송 없이 다시 맞아야 한다 — 연결 이벤트가 그 증거다(V5-106).
    let revived = events.recv_timeout(STALL).unwrap();
    assert_eq!(revived.surface, "s1");
    let notice: serde_json::Value = serde_json::from_str(revived.body.get()).unwrap();
    assert_eq!(notice["event"], "connection");
    assert_eq!(notice["connected"], true);

    // 다음 전송은 다시 맺은 연결로 지나간다.
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
    // 이 수신기는 첫 연결만 받고 닫힌다. 엔드포인트의 pid 는 이 검사 프로세스이므로 살아
    // 있고, 재시작은 같은 소켓에 연결을 시도해 거절된다.
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

    // 재시작이 실패하면 연결 끊김과 그 까닭이 표면에 알려진다(V5-106).
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

/// 사이드카 메시지와 실패를 따로 받는 창.
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

/// 연결 하나에 hello 로 답하고 요청 한 줄을 받은 뒤 payload 를 쓰는 서비스. host 가 연결을 닫으면 끝난다.
/// payload 를 다 쓰기 전에 host 가 닫으면 쓰기 오류는 기대한 결과다.
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
        // host 가 연결을 닫으면 읽기가 EOF 로 끝난다.
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

// 영속 사이드카의 시작(service 연결과 hello)은 다른 사이드카로의 전송을 기다리게 하지 않는다. service 는 hello 에
// 500 ms 늦게 답하고, 그동안 이미 실행 중인 다른 사이드카로 보낸다.
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
        // 연결이 끝날 때까지 받은 줄을 버린다.
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

/// sidecar 로 보내고 그 결과를 limit 안에 돌려준다. 돌아오지 않으면 검사가 실패한다.
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

// hello 를 받고 답하지 않는 service 로의 시작은 5초 뒤 정해진 문장으로 실패한다.
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

// 새로 시작한 service 가 endpoint 를 출력하지 않으면 시작은 ready 상한 뒤 정해진 문장으로 실패하고, 호스트는 그
// service 를 끝내고 회수한다. 검사는 기본 30초 대신 1초를 준다. service 는 상한보다 늦게 일을 시작하므로 부하와
// 상관없이 시작하자마자 끝나며, 검사는 그 고유한 경로로 실행 중인 process 가 남지 않았는지 본다.
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

// 새로 시작한 service 의 표준 오류는 설정 디렉터리의 그 실행 파일 이름 로그에 쌓인다.
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

// 서비스 로그를 열 수 없으면 서비스를 시작하지 않고 정해진 문장으로 실패한다.
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
    // logs 가 파일이면 로그 디렉터리를 만들 수 없다.
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

// 새로 시작한 service 가 endpoint 를 출력하기 전에 끝나면 시작은 정해진 문장으로 실패한다.
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
