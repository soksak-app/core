//! 로컬 엔드포인트의 전송, 프레임, JSON-RPC 처리, 감시 목록 테스트. 창과 페이지는 가짜 서비스가 대신한다.

use std::io::Write;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use soksak_host_tauriv2::endpoint::{self, Connection, Endpoint, Failure, Service, Watch};

/// 요청을 기록하고 창 w1 만 가진 서비스.
struct Fake {
    calls: Mutex<Vec<(String, String, Value)>>,
    seen: Mutex<Sender<(String, String, Value)>>,
}

impl Fake {
    fn new() -> (Arc<Fake>, Receiver<(String, String, Value)>) {
        let (tx, rx) = mpsc::channel();
        (
            Arc::new(Fake {
                calls: Mutex::new(Vec::new()),
                seen: Mutex::new(tx),
            }),
            rx,
        )
    }

    fn calls(&self) -> Vec<(String, String, Value)> {
        self.calls.lock().unwrap().clone()
    }
}

impl Service for Fake {
    fn windows(&self) -> Result<Value, Failure> {
        self.calls
            .lock()
            .unwrap()
            .push((String::new(), "windows.list".into(), Value::Null));
        Ok(json!([{"window": "w1", "title": "one", "project": null, "key": true}]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "w1"
    }

    fn call(
        &self,
        window: &str,
        method: &str,
        params: Map<String, Value>,
    ) -> Result<Value, Failure> {
        let call = (
            window.to_string(),
            method.to_string(),
            Value::Object(params),
        );
        self.calls.lock().unwrap().push(call.clone());
        let _ = self.seen.lock().unwrap().send(call);
        match method {
            "status.get" => Ok(json!(7)),
            _ => Ok(Value::Null),
        }
    }
}

/// config 안의 sockets 디렉터리에 엔드포인트를 연다. 소켓 경로 길이 제한 안에 든다.
fn start(config: &Path, application: &str, service: Arc<Fake>) -> Endpoint {
    Endpoint::start(&config.join("sockets"), config, application, service).unwrap()
}

// contract: endpoint.process.one-owner-per-config-dir
#[test]
fn a_configuration_directory_has_one_process_owner() {
    let config = tempfile::tempdir().unwrap();
    let (first, _) = Fake::new();
    let endpoint = start(config.path(), "test-owner", first);
    let (second, _) = Fake::new();
    let refused = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-owner",
        second,
    )
    .err()
    .unwrap();
    assert!(refused.contains("already owned by process"), "{refused}");
    assert!(config.path().join("process.lock").exists());
    endpoint.stop();
    assert!(!config.path().join("process.lock").exists());
}

fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn open(endpoint: &Endpoint) -> Box<dyn Connection> {
    let connection = endpoint::connect(endpoint.address()).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    connection
}

fn send(connection: &mut Box<dyn Connection>, message: Value) {
    endpoint::write_frame(connection, &message).unwrap();
}

fn receive(connection: &mut Box<dyn Connection>) -> Option<Value> {
    endpoint::read_frame(connection).unwrap()
}

fn request(connection: &mut Box<dyn Connection>, id: u64, method: &str, params: Value) -> Value {
    send(
        connection,
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    );
    receive(connection).expect("the endpoint closed the connection")
}

// contract: endpoint.transport.http-request-line-closes
#[test]
fn http_request_line_closes_connection_without_running_a_method() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-http", fake.clone());
    let mut connection = open(&endpoint);
    connection
        .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    assert_eq!(receive(&mut connection), None);
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

// contract: endpoint.transport.invalid-json-closes
#[test]
fn invalid_json_closes_connection() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-json", fake.clone());
    let mut connection = open(&endpoint);
    let body = b"{\"jsonrpc\": \"2.0\", \"id\": 1,";
    connection
        .write_all(&(body.len() as u32).to_be_bytes())
        .unwrap();
    connection.write_all(body).unwrap();
    assert_eq!(receive(&mut connection), None);
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

// contract: endpoint.transport.non-jsonrpc-object-closes
#[test]
fn non_jsonrpc_object_closes_connection() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-object", fake.clone());
    let mut connection = open(&endpoint);
    send(&mut connection, json!({"id": 1, "method": "windows.list"}));
    assert_eq!(receive(&mut connection), None);
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

// contract: endpoint.transport.undeclared-method-closes
#[test]
fn undeclared_method_closes_connection() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-undeclared", fake.clone());
    let mut connection = open(&endpoint);
    send(
        &mut connection,
        json!({"jsonrpc": "2.0", "id": 1, "method": "page.eval", "params": {"window": "w1"}}),
    );
    assert_eq!(receive(&mut connection), None);
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

// contract: endpoint.diagnostics.methods-exist-only-in-diagnostic-builds
#[test]
fn diagnostic_methods_exist_only_in_diagnostic_builds() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-diagnostics", fake.clone());
    let mut connection = open(&endpoint);
    send(
        &mut connection,
        json!({"jsonrpc": "2.0", "id": 1, "method": "diagnostics.knob",
        "params": {"window": "w1", "name": "latency", "value": 0}}),
    );
    let reply = receive(&mut connection);
    if cfg!(feature = "diagnostics") {
        assert_eq!(
            reply,
            Some(json!({"jsonrpc": "2.0", "id": 1, "result": null}))
        );
        assert_eq!(fake.calls().len(), 1);
    } else {
        assert_eq!(reply, None);
        assert!(fake.calls().is_empty());
    }
    endpoint.stop();
}

// contract: endpoint.rpc.unknown-window-1003, endpoint.rpc.missing-window-param-invalid
#[test]
fn declared_method_on_unknown_window_returns_1003() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-window", fake.clone());
    let mut connection = open(&endpoint);
    let reply = request(
        &mut connection,
        4,
        "command.run",
        json!({"window": "gone", "name": "host.window.reload"}),
    );
    assert_eq!(reply["id"], 4);
    assert_eq!(reply["error"]["code"], 1003);
    let reply = request(
        &mut connection,
        5,
        "status.get",
        json!({"name": "host.window"}),
    );
    assert_eq!(reply["error"]["code"], -32602);
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

// contract: endpoint.rpc.round-trip-by-id, endpoint.rpc.page-params-omit-window
#[test]
fn framing_round_trip_answers_requests_by_id() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-frame", fake.clone());
    let mut connection = open(&endpoint);
    let reply = request(&mut connection, 1, "windows.list", Value::Null);
    assert_eq!(
        reply,
        json!({"jsonrpc": "2.0", "id": 1,
        "result": [{"window": "w1", "title": "one", "project": null, "key": true}]})
    );
    let reply = request(
        &mut connection,
        2,
        "status.get",
        json!({"window": "w1", "name": "core.layout"}),
    );
    assert_eq!(reply, json!({"jsonrpc": "2.0", "id": 2, "result": 7}));
    assert_eq!(
        fake.calls()[1],
        (
            "w1".into(),
            "status.get".into(),
            json!({"name": "core.layout"})
        )
    );
    endpoint.stop();
}

// contract: endpoint.discovery.writes-endpoint-json, endpoint.discovery.removes-endpoint-json-on-close, endpoint.discovery.removes-socket-on-close
#[test]
fn endpoint_file_is_written_and_removed() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-file", fake);
    let file = config.path().join("endpoint.json");
    let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(written["transport"], "unix");
    assert_eq!(written["address"], endpoint.address());
    assert_eq!(written["pid"], std::process::id());
    assert_eq!(written["application"], "test-file");
    assert_eq!(written["version"], "0.0.1");
    let executable = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    assert_eq!(written["executable"], executable.to_string_lossy().as_ref());
    let started = written["started"].as_str().unwrap();
    assert_eq!(started.len(), "2026-09-17T09:00:00Z".len());
    assert!(started.ends_with('Z'));
    let address = endpoint.address().to_string();
    assert!(Path::new(&address).exists());
    endpoint.stop();
    assert!(!file.exists());
    assert!(!Path::new(&address).exists());
}

// contract: endpoint.discovery.close-keeps-replacement
#[test]
fn stop_keeps_an_endpoint_file_that_another_process_wrote() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-replacement", fake);
    let file = config.path().join("endpoint.json");
    let replacement = json!({
        "transport": "unix", "address": "replacement.sock", "pid": std::process::id() + 1,
        "application": "test-replacement", "version": "0.0.1", "executable": "/replacement",
        "started": "2026-09-23T00:00:00Z",
    });
    std::fs::write(&file, serde_json::to_vec(&replacement).unwrap()).unwrap();
    endpoint.stop();
    let kept: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(
        kept, replacement,
        "stop removed or changed the replacement endpoint file"
    );
}

// contract: endpoint.discovery.endpoint-json-mode-0600, endpoint.socket.private-modes
#[test]
fn endpoint_files_are_private_to_the_user() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-modes", fake);
    assert_eq!(mode(&config.path().join("sockets")), 0o700);
    assert_eq!(mode(Path::new(endpoint.address())), 0o600);
    assert_eq!(mode(&config.path().join("endpoint.json")), 0o600);
}

/// 끝난 프로세스의 번호.
fn ended_process() -> u32 {
    let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    child.wait().unwrap();
    child.id()
}

// contract: endpoint.socket.sweeps-ended-process-sockets
#[test]
fn sockets_of_ended_processes_are_removed() {
    use std::os::unix::fs::DirBuilderExt;
    let config = tempfile::tempdir().unwrap();
    let sockets = config.path().join("sockets");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&sockets)
        .unwrap();
    let ended = sockets.join(format!("test-sweep-{}.sock", ended_process()));
    let running = sockets.join(format!(
        "test-sweep-{}.sock",
        std::os::unix::process::parent_id()
    ));
    let other = sockets.join(format!("test-other-{}.sock", ended_process()));
    for path in [&ended, &running, &other] {
        std::fs::write(path, "").unwrap();
    }
    let (fake, _) = Fake::new();
    let endpoint = Endpoint::start(&sockets, config.path(), "test-sweep", fake).unwrap();
    let found = (ended.exists(), running.exists(), other.exists());
    endpoint.stop();
    assert_eq!(
        found,
        (false, true, true),
        "ended, running, other application"
    );
}

// contract: endpoint.socket.refuses-open-directory
#[test]
fn a_socket_directory_open_to_others_is_refused() {
    use std::os::unix::fs::PermissionsExt;
    let config = tempfile::tempdir().unwrap();
    let sockets = config.path().join("sockets");
    std::fs::create_dir(&sockets).unwrap();
    std::fs::set_permissions(&sockets, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (fake, _) = Fake::new();
    let refused = Endpoint::start(&sockets, config.path(), "test-open", fake)
        .err()
        .unwrap();
    assert!(refused.contains("mode 755"), "{refused}");
    assert!(!config.path().join("endpoint.json").exists());
}

// contract: endpoint.socket.refuses-foreign-owner
#[test]
fn a_socket_directory_of_another_user_is_refused() {
    // /usr 는 root 소유다. 검사는 권한보다 소유자를 먼저 본다.
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let refused = Endpoint::start(Path::new("/usr"), config.path(), "test-owner", fake)
        .err()
        .unwrap();
    assert!(refused.contains("belongs to another user"), "{refused}");
}

// contract: endpoint.socket.refuses-non-directory
#[test]
fn a_socket_path_that_is_not_a_directory_is_refused() {
    let config = tempfile::tempdir().unwrap();
    let target = config.path().join("target");
    std::fs::create_dir(&target).unwrap();
    let sockets = config.path().join("sockets");
    std::os::unix::fs::symlink(&target, &sockets).unwrap();
    let (fake, _) = Fake::new();
    let refused = Endpoint::start(&sockets, config.path(), "test-link", fake)
        .err()
        .unwrap();
    assert!(refused.contains("is not a directory"), "{refused}");
}

// contract: endpoint.watch.notifies-watching-connection, endpoint.watch.non-watching-connection-not-notified, endpoint.watch.unwatch-is-per-connection, endpoint.watch.page-watch-deduplicated, endpoint.watch.no-page-unwatch-while-watched, endpoint.watch.last-watcher-close-unwatches-page, endpoint.watch.registry-reflects-watches
#[test]
fn watchers_belong_to_their_connection() {
    let config = tempfile::tempdir().unwrap();
    let (fake, seen) = Fake::new();
    let endpoint = start(config.path(), "test-watch", fake.clone());
    let notifier = endpoint.notifier();
    let mut first = open(&endpoint);
    let mut second = open(&endpoint);

    assert_eq!(
        request(
            &mut first,
            1,
            "status.watch",
            json!({"window": "w1", "name": "core.layout"})
        )["result"],
        Value::Null
    );
    assert!(notifier.watched("w1", "core.layout"));
    assert!(!notifier.watched("w1", "core.other"));
    assert_eq!(
        notifier.watches("w1"),
        [Watch {
            window: "w1".into(),
            name: "core.layout".into(),
            surface: None
        }]
    );

    // 두 번째 연결은 감시하지 않았으므로 알림 대신 자신의 응답을 먼저 받는다.
    notifier.changed("w1", "core.layout", None, json!(1));
    assert_eq!(
        receive(&mut first),
        Some(json!({"jsonrpc": "2.0", "method": "status.changed",
        "params": {"window": "w1", "name": "core.layout", "value": 1}}))
    );
    assert_eq!(
        request(
            &mut second,
            2,
            "status.get",
            json!({"window": "w1", "name": "core.layout"})
        )["id"],
        2
    );

    // 두 번째 연결의 감시 해제는 첫 번째 연결의 감시를 바꾸지 않는다.
    request(
        &mut second,
        3,
        "status.watch",
        json!({"window": "w1", "name": "core.layout"}),
    );
    request(
        &mut second,
        4,
        "status.unwatch",
        json!({"window": "w1", "name": "core.layout"}),
    );
    notifier.changed("w1", "core.layout", None, json!(2));
    assert_eq!(receive(&mut first).unwrap()["params"]["value"], 2);
    // 페이지는 두 연결의 감시 가운데 첫 감시만 받는다.
    let page_watches = fake
        .calls()
        .iter()
        .filter(|(_, method, _)| method == "status.watch")
        .count();
    assert_eq!(page_watches, 1, "{:?}", fake.calls());
    assert!(!fake
        .calls()
        .iter()
        .any(|(_, method, _)| method == "status.unwatch"));

    // 마지막 감시자의 연결이 닫히면 페이지에 감시 해제를 요청한다.
    while seen.try_recv().is_ok() {}
    drop(first);
    let (window, method, params) = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!((window.as_str(), method.as_str()), ("w1", "status.unwatch"));
    assert_eq!(params, json!({"name": "core.layout"}));
    assert!(!notifier.watched("w1", "core.layout"));
    assert!(notifier.watches("w1").is_empty());
    endpoint.stop();
}

// contract: endpoint.watch.surface-and-plain-forwarded-separately, endpoint.watch.empty-surface-invalid, endpoint.watch.surface-change-names-surface, endpoint.watch.surface-unwatch-forwarded-with-surface, endpoint.watch.surface-unwatch-keeps-plain-watch
#[test]
fn surface_watches_are_separate() {
    let config = tempfile::tempdir().unwrap();
    let (fake, seen) = Fake::new();
    let endpoint = start(config.path(), "test-surface", fake.clone());
    let notifier = endpoint.notifier();
    let mut connection = open(&endpoint);
    let named = json!({"window": "w1", "name": "probe.lines", "surface": "tab-a"});
    assert_eq!(
        request(&mut connection, 1, "status.watch", named.clone())["result"],
        Value::Null
    );
    assert_eq!(
        request(
            &mut connection,
            2,
            "status.watch",
            json!({"window": "w1", "name": "probe.lines"})
        )["result"],
        Value::Null
    );
    let reply = request(
        &mut connection,
        3,
        "status.watch",
        json!({"window": "w1", "name": "probe.lines", "surface": ""}),
    );
    assert_eq!(reply["error"]["code"], -32602);
    let watched: Vec<Value> = fake
        .calls()
        .iter()
        .filter(|(_, method, _)| method == "status.watch")
        .map(|(_, _, params)| params.clone())
        .collect();
    assert_eq!(
        watched,
        [
            json!({"name": "probe.lines", "surface": "tab-a"}),
            json!({"name": "probe.lines"})
        ]
    );
    assert_eq!(notifier.watches("w1").len(), 2);

    notifier.changed("w1", "probe.lines", Some("tab-a"), json!(["a"]));
    assert_eq!(
        receive(&mut connection),
        Some(json!({"jsonrpc": "2.0", "method": "status.changed",
        "params": {"window": "w1", "name": "probe.lines", "surface": "tab-a", "value": ["a"]}}))
    );
    notifier.changed("w1", "probe.lines", None, json!(["b"]));
    assert_eq!(
        receive(&mut connection),
        Some(json!({"jsonrpc": "2.0", "method": "status.changed",
        "params": {"window": "w1", "name": "probe.lines", "value": ["b"]}}))
    );

    while seen.try_recv().is_ok() {}
    request(&mut connection, 4, "status.unwatch", named);
    let (_, method, params) = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(method, "status.unwatch");
    assert_eq!(params, json!({"name": "probe.lines", "surface": "tab-a"}));
    assert!(
        notifier.watched("w1", "probe.lines"),
        "the watch without a surface remains"
    );
    endpoint.stop();
}

// contract: endpoint.names.missing-name-invalid, endpoint.names.owner-form-required, endpoint.names.valid-name-examples
#[test]
fn names_must_have_the_owner_form() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-names", fake.clone());
    let mut connection = open(&endpoint);
    let reply = request(&mut connection, 9, "status.get", json!({"window": "w1"}));
    assert_eq!(reply["error"]["code"], -32602, "missing name: {reply}");
    for (id, name) in [
        (1, json!("layout")),
        (2, json!("Core.layout")),
        (3, json!("core.")),
        (4, json!(3)),
    ] {
        let reply = request(
            &mut connection,
            id,
            "status.get",
            json!({"window": "w1", "name": name}),
        );
        assert_eq!(reply["error"]["code"], -32602, "{name}");
    }
    assert!(fake.calls().is_empty());
    assert!(endpoint::valid_name("core.surface.document") && endpoint::valid_name("plugin-x.a-1"));
    endpoint.stop();
}

/// 감시 요청을 처리 완료 순서로 기록하는 페이지. 첫 status.unwatch 는 gate 가 열릴 때까지 끝나지 않는다.
struct GatedPage {
    order: Mutex<Vec<String>>,
    gate: Mutex<Option<Receiver<()>>>,
    entered: Mutex<Sender<String>>,
}

impl Service for GatedPage {
    fn windows(&self) -> Result<Value, Failure> {
        Ok(json!([]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "w1"
    }

    fn call(
        &self,
        _window: &str,
        method: &str,
        _params: Map<String, Value>,
    ) -> Result<Value, Failure> {
        let _ = self.entered.lock().unwrap().send(method.to_string());
        if method == "status.unwatch" {
            let gate = self.gate.lock().unwrap().take();
            if let Some(gate) = gate {
                gate.recv().unwrap();
            }
        }
        if method.starts_with("status.") && method != "status.get" {
            self.order.lock().unwrap().push(method.to_string());
        }
        Ok(if method == "status.get" {
            json!(0)
        } else {
            Value::Null
        })
    }
}

// contract: endpoint.watch.subscription-arrival-order, endpoint.watch.other-requests-not-blocked-by-pending-subscription
#[test]
fn subscription_changes_reach_the_page_in_arrival_order() {
    let config = tempfile::tempdir().unwrap();
    let (open_gate, gate) = mpsc::channel();
    let (entered, calls) = mpsc::channel();
    let page = Arc::new(GatedPage {
        order: Mutex::new(Vec::new()),
        gate: Mutex::new(Some(gate)),
        entered: Mutex::new(entered),
    });
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-order",
        page.clone(),
    )
    .unwrap();
    let notifier = endpoint.notifier();
    let mut connection = open(&endpoint);
    let topic = json!({"window": "w1", "name": "core.layout"});
    assert_eq!(
        request(&mut connection, 1, "status.watch", topic.clone())["result"],
        Value::Null
    );
    assert_eq!(calls.recv().unwrap(), "status.watch");

    // 감시 해제와 감시를 연달아 보낸다. 페이지가 감시 해제를 끝내기 전에 다른 요청의 응답을 받는다.
    send(
        &mut connection,
        json!({"jsonrpc": "2.0", "id": 2, "method": "status.unwatch", "params": topic}),
    );
    send(
        &mut connection,
        json!({"jsonrpc": "2.0", "id": 3, "method": "status.watch", "params": topic}),
    );
    assert_eq!(calls.recv().unwrap(), "status.unwatch");
    send(
        &mut connection,
        json!({"jsonrpc": "2.0", "id": 4, "method": "status.get", "params": topic}),
    );
    let mut replies = Vec::new();
    let first = receive(&mut connection).unwrap();
    replies.push(first["id"].clone());
    assert!(notifier.watched("w1", "core.layout"));
    open_gate.send(()).unwrap();
    while replies.len() < 3 {
        replies.push(receive(&mut connection).unwrap()["id"].clone());
    }
    assert_eq!(replies, [json!(4), json!(2), json!(3)]);
    assert_eq!(
        *page.order.lock().unwrap(),
        ["status.watch", "status.unwatch", "status.watch"]
    );
    assert!(notifier.watched("w1", "core.layout"));
    notifier.changed("w1", "core.layout", None, json!(5));
    assert_eq!(receive(&mut connection).unwrap()["params"]["value"], 5);
    endpoint.stop();
}
