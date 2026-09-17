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
        (Arc::new(Fake { calls: Mutex::new(Vec::new()), seen: Mutex::new(tx) }), rx)
    }

    fn calls(&self) -> Vec<(String, String, Value)> {
        self.calls.lock().unwrap().clone()
    }
}

impl Service for Fake {
    fn windows(&self) -> Result<Value, Failure> {
        self.calls.lock().unwrap().push((String::new(), "windows.list".into(), Value::Null));
        Ok(json!([{"window": "w1", "title": "one", "project": null, "key": true}]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "w1"
    }

    fn call(&self, window: &str, method: &str, params: Map<String, Value>) -> Result<Value, Failure> {
        let call = (window.to_string(), method.to_string(), Value::Object(params));
        self.calls.lock().unwrap().push(call.clone());
        let _ = self.seen.lock().unwrap().send(call);
        match method {
            "status.get" => Ok(json!(7)),
            _ => Ok(Value::Null),
        }
    }
}

fn start(config: &Path, application: &str, service: Arc<Fake>) -> Endpoint {
    Endpoint::start(config, application, service).unwrap()
}

fn open(endpoint: &Endpoint) -> Box<dyn Connection> {
    let connection = endpoint::connect(endpoint.address()).unwrap();
    connection.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    connection
}

fn send(connection: &mut Box<dyn Connection>, message: Value) {
    endpoint::write_frame(connection, &message).unwrap();
}

fn receive(connection: &mut Box<dyn Connection>) -> Option<Value> {
    endpoint::read_frame(connection).unwrap()
}

fn request(connection: &mut Box<dyn Connection>, id: u64, method: &str, params: Value) -> Value {
    send(connection, json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
    receive(connection).expect("the endpoint closed the connection")
}

#[test]
fn http_request_line_closes_connection_without_running_a_method() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-http", fake.clone());
    let mut connection = open(&endpoint);
    connection.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
    assert_eq!(receive(&mut connection), None);
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

#[test]
fn invalid_json_closes_connection() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-json", fake.clone());
    let mut connection = open(&endpoint);
    let body = b"{\"jsonrpc\": \"2.0\", \"id\": 1,";
    connection.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
    connection.write_all(body).unwrap();
    assert_eq!(receive(&mut connection), None);
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

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

#[test]
fn undeclared_method_closes_connection() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-undeclared", fake.clone());
    let mut connection = open(&endpoint);
    send(&mut connection, json!({"jsonrpc": "2.0", "id": 1, "method": "page.eval", "params": {"window": "w1"}}));
    assert_eq!(receive(&mut connection), None);
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

#[test]
fn diagnostic_methods_exist_only_in_diagnostic_builds() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-diagnostics", fake.clone());
    let mut connection = open(&endpoint);
    send(&mut connection, json!({"jsonrpc": "2.0", "id": 1, "method": "diagnostics.knob",
        "params": {"window": "w1", "name": "latency", "value": 0}}));
    let reply = receive(&mut connection);
    if cfg!(feature = "diagnostics") {
        assert_eq!(reply, Some(json!({"jsonrpc": "2.0", "id": 1, "result": null})));
        assert_eq!(fake.calls().len(), 1);
    } else {
        assert_eq!(reply, None);
        assert!(fake.calls().is_empty());
    }
    endpoint.stop();
}

#[test]
fn declared_method_on_unknown_window_returns_1003() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-window", fake.clone());
    let mut connection = open(&endpoint);
    let reply = request(&mut connection, 4, "command.run", json!({"window": "gone", "name": "host.window.reload"}));
    assert_eq!(reply["id"], 4);
    assert_eq!(reply["error"]["code"], 1003);
    let reply = request(&mut connection, 5, "status.get", json!({"name": "host.window"}));
    assert_eq!(reply["error"]["code"], -32602);
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

#[test]
fn framing_round_trip_answers_requests_by_id() {
    let config = tempfile::tempdir().unwrap();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-frame", fake.clone());
    let mut connection = open(&endpoint);
    let reply = request(&mut connection, 1, "windows.list", Value::Null);
    assert_eq!(reply, json!({"jsonrpc": "2.0", "id": 1,
        "result": [{"window": "w1", "title": "one", "project": null, "key": true}]}));
    let reply = request(&mut connection, 2, "status.get", json!({"window": "w1", "name": "core.layout"}));
    assert_eq!(reply, json!({"jsonrpc": "2.0", "id": 2, "result": 7}));
    assert_eq!(fake.calls()[1], ("w1".into(), "status.get".into(), json!({"name": "core.layout"})));
    endpoint.stop();
}

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
    let started = written["started"].as_str().unwrap();
    assert_eq!(started.len(), "2026-09-17T09:00:00Z".len());
    assert!(started.ends_with('Z'));
    let address = endpoint.address().to_string();
    assert!(Path::new(&address).exists());
    endpoint.stop();
    assert!(!file.exists());
    assert!(!Path::new(&address).exists());
}

#[test]
fn watchers_belong_to_their_connection() {
    let config = tempfile::tempdir().unwrap();
    let (fake, seen) = Fake::new();
    let endpoint = start(config.path(), "test-watch", fake.clone());
    let notifier = endpoint.notifier();
    let mut first = open(&endpoint);
    let mut second = open(&endpoint);

    assert_eq!(request(&mut first, 1, "status.watch", json!({"window": "w1", "name": "core.layout"}))["result"], Value::Null);
    assert!(notifier.watched("w1", "core.layout"));
    assert!(!notifier.watched("w1", "core.other"));
    assert_eq!(notifier.watches("w1"), [Watch { window: "w1".into(), name: "core.layout".into(), surface: None }]);

    // 두 번째 연결은 감시하지 않았으므로 알림 대신 자신의 응답을 먼저 받는다.
    notifier.changed("w1", "core.layout", None, json!(1));
    assert_eq!(receive(&mut first), Some(json!({"jsonrpc": "2.0", "method": "status.changed",
        "params": {"window": "w1", "name": "core.layout", "value": 1}})));
    assert_eq!(request(&mut second, 2, "status.get", json!({"window": "w1", "name": "core.layout"}))["id"], 2);

    // 두 번째 연결의 감시 해제는 첫 번째 연결의 감시를 바꾸지 않는다.
    request(&mut second, 3, "status.watch", json!({"window": "w1", "name": "core.layout"}));
    request(&mut second, 4, "status.unwatch", json!({"window": "w1", "name": "core.layout"}));
    notifier.changed("w1", "core.layout", None, json!(2));
    assert_eq!(receive(&mut first).unwrap()["params"]["value"], 2);
    assert!(!fake.calls().iter().any(|(_, method, _)| method == "status.unwatch"));

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

#[test]
fn surface_watches_are_separate() {
    let config = tempfile::tempdir().unwrap();
    let (fake, seen) = Fake::new();
    let endpoint = start(config.path(), "test-surface", fake.clone());
    let notifier = endpoint.notifier();
    let mut connection = open(&endpoint);
    let named = json!({"window": "w1", "name": "probe.lines", "surface": "tab-a"});
    assert_eq!(request(&mut connection, 1, "status.watch", named.clone())["result"], Value::Null);
    assert_eq!(request(&mut connection, 2, "status.watch", json!({"window": "w1", "name": "probe.lines"}))["result"], Value::Null);
    let reply = request(&mut connection, 3, "status.watch", json!({"window": "w1", "name": "probe.lines", "surface": ""}));
    assert_eq!(reply["error"]["code"], -32602);
    let watched: Vec<Value> = fake.calls().iter().filter(|(_, method, _)| method == "status.watch").map(|(_, _, params)| params.clone()).collect();
    assert_eq!(watched, [json!({"name": "probe.lines", "surface": "tab-a"}), json!({"name": "probe.lines"})]);
    assert_eq!(notifier.watches("w1").len(), 2);

    notifier.changed("w1", "probe.lines", Some("tab-a"), json!(["a"]));
    assert_eq!(receive(&mut connection), Some(json!({"jsonrpc": "2.0", "method": "status.changed",
        "params": {"window": "w1", "name": "probe.lines", "surface": "tab-a", "value": ["a"]}})));
    notifier.changed("w1", "probe.lines", None, json!(["b"]));
    assert_eq!(receive(&mut connection), Some(json!({"jsonrpc": "2.0", "method": "status.changed",
        "params": {"window": "w1", "name": "probe.lines", "value": ["b"]}})));

    while seen.try_recv().is_ok() {}
    request(&mut connection, 4, "status.unwatch", named);
    let (_, method, params) = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(method, "status.unwatch");
    assert_eq!(params, json!({"name": "probe.lines", "surface": "tab-a"}));
    assert!(notifier.watched("w1", "probe.lines"), "the watch without a surface remains");
    endpoint.stop();
}
