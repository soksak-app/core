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
    assert_eq!(
        first_events
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .surface,
        "s1"
    );
    assert_eq!(
        second_events
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .surface,
        "s2"
    );
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
    assert_eq!(
        first_events
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .surface,
        "s1"
    );
    assert_eq!(
        second_events
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .surface,
        "s2"
    );
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
            .recv_timeout(Duration::from_secs(10))
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
    // package suite는 여러 test binary를 동시에 실행한다. case timeout은 제한된 값으로 유지하되,
    // reconnect contract가 1초 scheduler slice에 의존하게 만들지 않는다.
    let reconnect_timeout = Duration::from_secs(10);
    assert_eq!(
        first_events
            .recv_timeout(reconnect_timeout)
            .unwrap()
            .surface,
        "s1"
    );
    assert_eq!(
        second_events
            .recv_timeout(reconnect_timeout)
            .unwrap()
            .surface,
        "s2"
    );

    // 서비스는 close-owner 에 실패로 답한다. 종료는 제한 시간까지 기다리지 않고 바로 끝난다.
    let stopping = std::time::Instant::now();
    first.stop();
    second.stop();
    let elapsed = stopping.elapsed();
    assert!(
        elapsed <= Duration::from_secs(1),
        "close-owner failure was not reported promptly: {elapsed:?}"
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
            "{}",
            r#"{"operation":"hello","protocol":2,"ok":true}"#
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
            "{}",
            r#"{"operation":"hello","ok":false,"error":"authentication or protocol mismatch"}"#
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
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap().surface,
        "surface"
    );
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
    let empty = received.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(empty["surfaces"], serde_json::json!([]), "no kept surface");
    let (owner, _events) = owner("retain", "/live");
    sidecars
        .send(&owner, ECHO, "sent", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let closed = sidecars
        .retain_sessions(&[("listed".to_string(), "/project".to_string())])
        .unwrap();
    assert_eq!(closed, 2, "the service's closed count");
    let request = received.recv_timeout(Duration::from_secs(5)).unwrap();
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
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap().surface,
        "s1"
    );

    // 연결이 끊기면 전송 없이 다시 맞아야 한다 — 연결 이벤트가 그 증거다(V5-106).
    let revived = events.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(revived.surface, "s1");
    let notice: serde_json::Value = serde_json::from_str(revived.body.get()).unwrap();
    assert_eq!(notice["event"], "connection");
    assert_eq!(notice["connected"], true);

    // 다음 전송은 다시 맺은 연결로 지나간다.
    sidecars
        .send(&owner, ECHO, "s1", &raw(r#"{"operation":"input"}"#))
        .unwrap();
    let echoed = events.recv_timeout(Duration::from_secs(10)).unwrap();
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
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap().surface,
        "s1"
    );
    service.join().unwrap();

    // 재시작이 실패하면 연결 끊김과 그 까닭이 표면에 알려진다(V5-106).
    let failure = events.recv_timeout(Duration::from_secs(10)).unwrap();
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
