//! 사이드카 채널 테스트. 가짜 창과 셸 스크립트 사이드카를 사용한다.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;
use std::time::Duration;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::process::Command;

use serde_json::value::RawValue;
use soksak_host_tauriv2::sidecars::{Message, Owner, Sidecars};

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

type Files = HashMap<&'static str, String>;

fn files(sidecar: &str) -> Files {
    HashMap::from([
        (
            "environment.json",
            r#"{"plugins":["@fixture/plugin"]}"#.to_string(),
        ),
        (
            "modules/@fixture/plugin/plugin.json",
            r#"{"sidecars":["@fixture/sidecar-echo"]}"#.to_string(),
        ),
        (
            "modules/@fixture/sidecar-echo/sidecar.json",
            sidecar.to_string(),
        ),
    ])
}

fn create(files: &Files, directory: &Path) -> Result<Sidecars<FakeOwner>, String> {
    let read = |path: &str| files.get(path).map(|text| text.as_bytes().to_vec());
    Sidecars::new(&read, directory.to_path_buf(), directory.to_path_buf())
}

const ECHO: &str = "@fixture/sidecar-echo";

/// 받은 줄을 그대로 출력하고 요청 기록 파일에 남기는 fake 사이드카 @fixture/sidecar-echo 를 선언한다.
fn echo_sidecars() -> (Sidecars<FakeOwner>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let record = directory.path().join("requests");
    let program = directory.path().join("echo");
    std::fs::write(&program, format!("#!/bin/sh\ntee {}\n", record.display())).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let sidecars = create(
        &files(r#"{"executable":"build/echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
    (sidecars, directory)
}

#[test]
fn messages_reach_the_owning_window_only() {
    let (sidecars, directory) = echo_sidecars();
    let (first, first_events) = owner("a", "/projects/a");
    let (second, second_events) = owner("b", "/projects/b");
    sidecars
        .send(&first, ECHO, "s1", &raw(r#"{"op":"open"}"#))
        .unwrap();
    sidecars
        .send(&second, ECHO, "s2", &raw(r#"{"op":"open"}"#))
        .unwrap();
    let event = first_events.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(
        (
            event.sidecar.as_str(),
            event.surface.as_str(),
            event.body.get()
        ),
        (ECHO, "s1", r#"{"op":"open"}"#)
    );
    assert_eq!(
        second_events
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .surface,
        "s2"
    );
    let error = sidecars.send(&second, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains("another window"), "{error}");
    sidecars.retain(&first, &|_| false).unwrap();
    sidecars.stop();
    let requests = std::fs::read_to_string(directory.path().join("requests")).unwrap();
    assert_eq!(
        requests,
        concat!(
            r#"{"surface":"s1","root":"/projects/a","body":{"op":"open"}}"#,
            "\n",
            r#"{"surface":"s2","root":"/projects/b","body":{"op":"open"}}"#,
            "\n",
            r#"{"surface":"s1","closed":true}"#,
            "\n",
        )
    );
}

#[test]
fn undeclared_and_stopped_sidecars_are_rejected() {
    let (sidecars, _directory) = echo_sidecars();
    let (window, _events) = owner("a", "/projects/a");
    assert!(sidecars
        .send(&window, "other", "s1", &raw("{}"))
        .unwrap_err()
        .contains("not declared"));
    sidecars.stop();
    assert!(sidecars
        .send(&window, ECHO, "s1", &raw("{}"))
        .unwrap_err()
        .contains("stopped"));
}

#[test]
fn a_missing_executable_fails() {
    let directory = tempfile::tempdir().unwrap();
    let sidecars = create(
        &files(r#"{"executable":"build/echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
    let (window, _events) = owner("a", "/");
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains(&format!("sidecar {ECHO}")), "{error}");
}

#[test]
fn a_sidecar_without_sidecar_json_fails() {
    let directory = tempfile::tempdir().unwrap();
    let mut files = files(r#"{"executable":"build/echo","protocol":1}"#);
    files.insert(
        "modules/@fixture/plugin/plugin.json",
        r#"{"sidecars":["@fixture/sidecar-missing"]}"#.into(),
    );
    let error = create(&files, directory.path()).err().unwrap();
    assert!(
        error.contains("modules/@fixture/sidecar-missing/sidecar.json"),
        "{error}"
    );
}

#[test]
fn an_executable_outside_the_package_fails() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"../escape","protocol":1}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(
        error.contains("modules/@fixture/sidecar-echo/sidecar.json"),
        "{error}"
    );
}

#[test]
fn an_unsupported_protocol_fails() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"build/echo","protocol":2}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(
        error.contains("modules/@fixture/sidecar-echo/sidecar.json"),
        "{error}"
    );
}

#[test]
fn persistent_transport_rejects_unknown_transport() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"build/echo","protocol":1,"transport":"ptyd"}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(error.contains("transport ptyd is not supported"), "{error}");
}

#[test]
fn persistent_transport_canonicalizes_the_config_directory() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let fixture = files(r#"{"executable":"build/echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &|path| fixture.get(path).map(|value| value.as_bytes().to_vec()),
        executable_directory.path().to_path_buf(),
        config_directory.path().join("."),
    )
    .unwrap();
    let (window, _events) = owner("a", "/projects/test");
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}"));
    assert!(error.unwrap_err().contains("sidecar"));
}

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

    let service = std::thread::spawn(move || {
        for stream in listener.incoming().take(2) {
            let mut stream = stream.unwrap();
            let reader_stream = stream.try_clone().unwrap();
            let mut reader = BufReader::new(reader_stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(hello["op"], "hello");
            assert_eq!(hello["protocol"], 1);
            assert_eq!(hello["token"], "test-token");
            stream
                .write_all(
                    br#"{"op":"hello","protocol":1,"ok":true}
"#,
                )
                .unwrap();
            line.clear();
            reader.read_line(&mut line).unwrap();
            stream.write_all(line.as_bytes()).unwrap();
        }
    });

    let fixture = files(r#"{"executable":"build/echo","protocol":1,"transport":"persistent"}"#);
    let read = |path: &str| fixture.get(path).map(|value| value.as_bytes().to_vec());
    let first = Sidecars::new(
        &read,
        executable_directory.path().to_path_buf(),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let second = Sidecars::new(
        &read,
        executable_directory.path().to_path_buf(),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (first_owner, first_events) = owner("first", "/projects/first");
    let (second_owner, second_events) = owner("second", "/projects/second");
    first
        .send(&first_owner, ECHO, "s1", &raw(r#"{"op":"open"}"#))
        .unwrap();
    second
        .send(&second_owner, ECHO, "s2", &raw(r#"{"op":"open"}"#))
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
    let (disconnected_tx, disconnected_rx) = channel();

    let service = thread::spawn(move || {
        let mut workers = Vec::new();
        for connection_index in 0..4 {
            let (mut stream, _) = listener.accept().unwrap();
            let disconnected_tx = disconnected_tx.clone();
            workers.push(thread::spawn(move || {
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
                assert_eq!(hello["op"], "hello");
                assert_eq!(hello["protocol"], 1);
                assert_eq!(hello["token"], "reconnect-token");
                stream
                    .write_all(br#"{"op":"hello","protocol":1,"ok":true}
"#)
                    .unwrap();

                line.clear();
                reader.read_line(&mut line).unwrap();
                let mut request: serde_json::Value = serde_json::from_str(&line).unwrap();
                if connection_index < 2 {
                    stream.write_all(line.as_bytes()).unwrap();
                    disconnected_tx.send(connection_index).unwrap();
                    return;
                }
                loop {
                    if request["op"] == "close-owner" {
                        let reply = serde_json::json!({
                            "op": "closed-owner",
                            "request": request["request"],
                            "ok": false,
                            "error": "test close"
                        });
                        writeln!(stream, "{reply}").unwrap();
                        return;
                    }
                    stream.write_all(line.as_bytes()).unwrap();
                    line.clear();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        return;
                    }
                    request = serde_json::from_str(&line).unwrap();
                }
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });

    let fixture = files(r#"{"executable":"build/echo","protocol":1,"transport":"persistent"}"#);
    let read = |path: &str| fixture.get(path).map(|value| value.as_bytes().to_vec());
    let first = Sidecars::new(
        &read,
        executable_directory.path().to_path_buf(),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let second = Sidecars::new(
        &read,
        executable_directory.path().to_path_buf(),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (first_owner, first_events) = owner("first", "/projects/first");
    let (second_owner, second_events) = owner("second", "/projects/second");

    first
        .send(&first_owner, ECHO, "s1", &raw(r#"{"op":"open"}"#))
        .unwrap();
    second
        .send(&second_owner, ECHO, "s2", &raw(r#"{"op":"open"}"#))
        .unwrap();
    assert_eq!(first_events.recv_timeout(Duration::from_secs(1)).unwrap().surface, "s1");
    assert_eq!(second_events.recv_timeout(Duration::from_secs(1)).unwrap().surface, "s2");
    disconnected_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    disconnected_rx.recv_timeout(Duration::from_secs(1)).unwrap();

    first
        .send(&first_owner, ECHO, "s1", &raw(r#"{"op":"reconnect"}"#))
        .unwrap();
    second
        .send(&second_owner, ECHO, "s2", &raw(r#"{"op":"reconnect"}"#))
        .unwrap();
    assert_eq!(first_events.recv_timeout(Duration::from_secs(1)).unwrap().surface, "s1");
    assert_eq!(second_events.recv_timeout(Duration::from_secs(1)).unwrap().surface, "s2");

    first.stop();
    second.stop();
    service.join().unwrap();
}

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
    let stale_child = Command::new("/bin/sh").arg("-c").arg("exit 0").spawn().unwrap();
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
        format!(
            "#!/bin/sh\nprintf '%s\\n' '{}'\n",
            replacement_endpoint
        ),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let fixture = files(r#"{"executable":"build/echo","protocol":1,"transport":"persistent"}"#);
    let read = |path: &str| fixture.get(path).map(|value| value.as_bytes().to_vec());
    let sidecars = Sidecars::new(
        &read,
        executable_directory.path().to_path_buf(),
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
            .write_all(br#"{"op":"hello","protocol":1,"ok":true}
"#)
            .unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        stream.write_all(line.as_bytes()).unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        let close: serde_json::Value = serde_json::from_str(&line).unwrap();
        let reply = serde_json::json!({
            "op": "closed-owner",
            "request": close["request"],
            "ok": false,
            "error": "test close"
        });
        writeln!(stream, "{reply}").unwrap();
    });

    sidecars
        .send(&owner, ECHO, "surface", &raw(r#"{"op":"open"}"#))
        .unwrap();
    assert_eq!(events.recv_timeout(Duration::from_secs(1)).unwrap().surface, "surface");
    assert!(
        !service_directory.join("endpoint.json").exists(),
        "stale endpoint was not removed before the replacement path"
    );
    sidecars.stop();
    service.join().unwrap();
}

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
    let fixture = files(r#"{"executable":"build/echo","protocol":1,"transport":"persistent"}"#);
    let read = |path: &str| fixture.get(path).map(|value| value.as_bytes().to_vec());
    let sidecars = Sidecars::new(
        &read,
        executable_directory.path().to_path_buf(),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (owner, _events) = owner("unreachable", "/projects/unreachable");
    let error = sidecars
        .send(&owner, ECHO, "surface", &raw(r#"{"op":"open"}"#))
        .unwrap_err();
    assert!(error.contains("connect authenticated service"), "{error}");
    assert_eq!(std::fs::read(&endpoint_path).unwrap(), original);
    sidecars.stop();
}

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
        assert_eq!(hello["op"], "hello");
        assert_eq!(hello["token"], "shutdown-token");
        stream
            .write_all(br#"{"op":"hello","protocol":1,"ok":true}
"#)
            .unwrap();

        line.clear();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["body"]["op"], "open");

        line.clear();
        reader.read_line(&mut line).unwrap();
        let close: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(close["op"], "close-owner");
        let close_reply = serde_json::json!({
            "op": "closed-owner",
            "request": close["request"],
            "ok": true
        });
        writeln!(stream, "{}", close_reply).unwrap();

        line.clear();
        reader.read_line(&mut line).unwrap();
        let shutdown: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(shutdown["op"], "shutdown");
        let shutdown_reply = serde_json::json!({
            "op": "shutdown",
            "request": shutdown["request"],
            "ok": true
        });
        writeln!(stream, "{}", shutdown_reply).unwrap();
    });

    let fixture = files(r#"{"executable":"build/echo","protocol":1,"transport":"persistent"}"#);
    let read = |path: &str| fixture.get(path).map(|value| value.as_bytes().to_vec());
    let sidecars = Sidecars::new(
        &read,
        executable_directory.path().to_path_buf(),
        config_directory.path().to_path_buf(),
    )
    .unwrap();
    let (owner, _events) = owner("shutdown", "/projects/shutdown");
    sidecars
        .send(&owner, ECHO, "surface", &raw(r#"{"op":"open"}"#))
        .unwrap();
    sidecars.stop();
    service.join().unwrap();
}

#[test]
fn plugins_without_sidecars_declare_none() {
    let directory = tempfile::tempdir().unwrap();
    let mut files = files("");
    files.insert("modules/@fixture/plugin/plugin.json", "{}".into());
    files.remove("modules/@fixture/sidecar-echo/sidecar.json");
    let sidecars = create(&files, directory.path()).unwrap();
    let (window, _events) = owner("a", "/");
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains("is not declared by any plugin"), "{error}");
}

#[test]
fn slow_sidecar_does_not_block_other_sends() {
    // 느린 사이드카는 stdin을 읽지 않고, 다른 사이드카는 정상적으로 동작한다.
    // 느린 사이드카에 256번 이상 보내면 언젠가는 "is not keeping up" 오류로 실패한다.
    // 이 테스트는 두 가지 성질을 확인한다:
    // 1. 느린 사이드카 채널이 가득 찼을 때도, 빠른 사이드카로의 send() 는 블로킹되지 않는다.
    // 2. stop() 이 stop_timeout 을 지키고 있다.

    let directory = tempfile::tempdir().unwrap();

    // 느린 사이드카: stdin을 읽지 않지만 stdin EOF에 정상 종료한다.
    let slow_program = directory.path().join("slow");
    std::fs::write(&slow_program, "#!/bin/sh\nexec cat >/dev/null\n").unwrap();
    std::fs::set_permissions(&slow_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    // 빠른 사이드카: 받은 줄을 그대로 출력한다.
    let fast_program = directory.path().join("fast");
    std::fs::write(&fast_program, "#!/bin/sh\ntee /dev/null\n").unwrap();
    std::fs::set_permissions(&fast_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    // 두 사이드카를 선언한 프런트엔드
    let mut files = HashMap::new();
    files.insert(
        "environment.json",
        r#"{"plugins":["@fixture/plugin"]}"#.to_string(),
    );
    files.insert(
        "modules/@fixture/plugin/plugin.json",
        r#"{"sidecars":["@fixture/sidecar-slow","@fixture/sidecar-fast"]}"#.to_string(),
    );
    files.insert(
        "modules/@fixture/sidecar-slow/sidecar.json",
        r#"{"executable":"build/slow","protocol":1}"#.to_string(),
    );
    files.insert(
        "modules/@fixture/sidecar-fast/sidecar.json",
        r#"{"executable":"build/fast","protocol":1}"#.to_string(),
    );

    let mut sidecars = create(&files, directory.path()).unwrap();
    // 테스트를 위해 기한을 100ms로 설정한다.
    sidecars.stop_timeout = Duration::from_millis(100);
    let (owner, _events) = owner("a", "/projects/test");

    // 느린 사이드카에 채널이 가득 찰 때까지 보낸다.
    let large_body = raw(&format!(r#"{{"data":"{}"}}"#, "x".repeat(20 * 1024)));
    let mut last_err = None;
    for i in 0..500 {
        match sidecars.send(&owner, "@fixture/sidecar-slow", "s1", &large_body) {
            Err(e) => {
                last_err = Some(e.clone());
                if e.contains("is not keeping up") {
                    break; // 채널이 가득 찬 것을 확인했다
                }
                panic!("send {}: unexpected error: {}", i, e);
            }
            Ok(()) => {}
        }
    }

    // 마침내 "is not keeping up" 오류를 받았는지 확인한다.
    assert!(
        last_err.is_some() && last_err.as_ref().unwrap().contains("is not keeping up"),
        "want 'is not keeping up', got {:?}",
        last_err
    );

    // 성질 1: 느린 사이드카 채널이 가득 찼을 때도 빠른 사이드카 send() 는 블로킹되지 않는다.
    // send() 는 채널에 넣고 즉시 돌아올 뿐이므로 50ms 미만이어야 한다.
    // (첫 send 는 프로세스 기동을 포함할 수 있으므로, 미리 한 번 보내 프로세스를 띄운 후,
    // 두 번째 send 를 시간 측정한다.)
    let start = std::time::Instant::now();
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-fast",
            "s2",
            &raw(r#"{"data":"test"}"#),
        )
        .unwrap();
    let send_elapsed = start.elapsed();
    assert!(
        send_elapsed < Duration::from_millis(50),
        "fast send took {:?}, want < 50ms",
        send_elapsed
    );

    // 성질 2: stop() 이 stop_timeout(100ms) 을 지키고 있다.
    // 200ms 기한으로 단언하면, 기본 5초와 명확히 구별된다.
    // 이전 코드는 send 와 stop 을 함께 재서 110ms 단언했는데, 이는
    // "OS 가 프로세스를 죽이고 수거하는 데 10ms 이하" 라는 불합리한 주장이었다.
    let start = std::time::Instant::now();
    sidecars.stop();
    let stop_elapsed = start.elapsed();
    assert!(
        stop_elapsed < Duration::from_millis(200),
        "stop() took {:?}, want < 200ms (2 × stop_timeout)",
        stop_elapsed
    );
}

#[test]
fn stop_graceful_shutdown() {
    // 사이드카가 실제로 stdin 을 읽고 있을 때 stop() 이 stdin EOF 에 의해 정상 종료되는지 검증한다.
    // 측정은 사이드카가 send 의 에코를 받은 뒤 시작해서, 기한(1초)까지 기다리지 않고 즉시 종료되는지 확인한다.

    let directory = tempfile::tempdir().unwrap();

    // 사이드카: 받은 줄을 그대로 에코하고 stdin EOF에 정상 종료한다.
    let graceful_program = directory.path().join("graceful");
    std::fs::write(
        &graceful_program,
        "#!/bin/sh\nwhile read line; do echo \"$line\"; done\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&graceful_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    let files = HashMap::from([
        (
            "environment.json",
            r#"{"plugins":["@fixture/plugin"]}"#.to_string(),
        ),
        (
            "modules/@fixture/plugin/plugin.json",
            r#"{"sidecars":["@fixture/sidecar-graceful"]}"#.to_string(),
        ),
        (
            "modules/@fixture/sidecar-graceful/sidecar.json",
            r#"{"executable":"build/graceful","protocol":1}"#.to_string(),
        ),
    ]);

    let mut sidecars = create(&files, directory.path()).unwrap();
    // 테스트를 위해 기한을 1초로 설정한다.
    sidecars.stop_timeout = Duration::from_secs(1);
    let (owner, events) = owner("a", "/projects/test");

    // 사이드카를 시작한다.
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-graceful",
            "s1",
            &raw(r#"{"test":"data"}"#),
        )
        .unwrap();

    // 사이드카가 실제로 stdin 을 읽고 있음을 확인한다: 에코 이벤트를 기다린다.
    // 이렇게 하면 shell 프로세스 기동 시간이 측정에 포함되지 않는다.
    let event = events
        .recv_timeout(Duration::from_secs(5))
        .expect("no echo event within 5s");
    assert_eq!(
        (event.sidecar.as_str(), event.surface.as_str()),
        ("@fixture/sidecar-graceful", "s1")
    );

    // 이제 stop() 호출을 시간 측정한다. stdin EOF에 정상 종료되어야 한다.
    let start = std::time::Instant::now();
    sidecars.stop();
    let elapsed = start.elapsed();

    // 정상 종료는 250ms 안에 일어나야 한다 (기한까지 기다리지 않음).
    assert!(
        elapsed < Duration::from_millis(250),
        "graceful stop took {:?}, want < 250ms",
        elapsed
    );
}

#[test]
fn stop_forced_kill() {
    // 기한을 초과해도 종료하지 않는 사이드카를 kill 하는지 검증한다.

    let directory = tempfile::tempdir().unwrap();

    // 사이드카: stdin EOF를 무시하고 계속 실행한다.
    let stubborn_program = directory.path().join("stubborn");
    std::fs::write(&stubborn_program, "#!/bin/sh\ncat >/dev/null &\nwait\n").unwrap();
    std::fs::set_permissions(&stubborn_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    let files = HashMap::from([
        (
            "environment.json",
            r#"{"plugins":["@fixture/plugin"]}"#.to_string(),
        ),
        (
            "modules/@fixture/plugin/plugin.json",
            r#"{"sidecars":["@fixture/sidecar-stubborn"]}"#.to_string(),
        ),
        (
            "modules/@fixture/sidecar-stubborn/sidecar.json",
            r#"{"executable":"build/stubborn","protocol":1}"#.to_string(),
        ),
    ]);

    let mut sidecars = create(&files, directory.path()).unwrap();
    // 테스트를 위해 기한을 100ms로 설정한다.
    sidecars.stop_timeout = Duration::from_millis(100);
    let (owner, _events) = owner("a", "/projects/test");

    // 사이드카를 시작한다.
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-stubborn",
            "s1",
            &raw(r#"{"test":"data"}"#),
        )
        .unwrap();

    // stop() 호출. 기한 후 kill 되어야 한다.
    let start = std::time::Instant::now();
    sidecars.stop();
    let elapsed = start.elapsed();

    // stop()은 기한만큼 기다렸다가 kill 해야 하므로 약 100ms 정도 걸려야 한다.
    // 범위: 80ms ~ 150ms (정확한 시간 측정에 여유를 둠).
    assert!(
        elapsed >= Duration::from_millis(80) && elapsed <= Duration::from_millis(150),
        "forced kill stop took {:?}, want ~100ms",
        elapsed
    );
}
