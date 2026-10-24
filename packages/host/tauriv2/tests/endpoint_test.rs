//! Tests of the transport, the frames, the JSON-RPC handling and the watch list of the local endpoint. A fake service
//! replaces the window and the page.

#[path = "support/folder.rs"]
mod folder;

use std::io::Write;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "support/records.rs"]
mod records;

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use soksak_host_tauriv2::endpoint::{
    self, Connection, Endpoint, Failure, Service, UnrecordedEnd, Watch, raw,
};

/// A service that records requests and has only the window w1.
struct Fake {
    calls: Mutex<Vec<(String, String, Value)>>,
    seen: Mutex<Sender<(String, String, Value)>>,
    /// A method of the page that ends with a timeout.
    timing_out: Mutex<Option<String>>,
}

impl Fake {
    fn new() -> (Arc<Fake>, Receiver<(String, String, Value)>) {
        let (tx, rx) = mpsc::channel();
        (
            Arc::new(Fake {
                calls: Mutex::new(Vec::new()),
                seen: Mutex::new(tx),
                timing_out: Mutex::new(None),
            }),
            rx,
        )
    }

    fn calls(&self) -> Vec<(String, String, Value)> {
        self.calls.lock().unwrap().clone()
    }
}

impl Service for Fake {
    fn unwatched(&self, _window: &str, _name: &str) {}

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
    ) -> Result<Box<RawValue>, Failure> {
        let call = (
            window.to_string(),
            method.to_string(),
            Value::Object(params),
        );
        self.calls.lock().unwrap().push(call.clone());
        let _ = self.seen.lock().unwrap().send(call);
        if self.timing_out.lock().unwrap().as_deref() == Some(method) {
            return Err(Failure::new(
                endpoint::TIMED_OUT,
                "the document did not reply within 10000 ms",
            ));
        }
        match method {
            "status.get" => raw(&json!(7)),
            _ => raw(&Value::Null),
        }
    }
}

/// Opens the endpoint in the sockets directory inside config and writes endpoint.json with the window w1. The socket
/// path is within the length limit.
fn start(config: &Path, application: &str, service: Arc<Fake>) -> Endpoint {
    let endpoint = Endpoint::start(&config.join("sockets"), config, application, service).unwrap();
    endpoint.publish("w1").unwrap();
    endpoint
}

// contract: endpoint.lock.single-owner
#[test]
fn a_configuration_directory_has_one_process_owner() {
    let config = folder::Folder::new();
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

// contract: endpoint.process.lock-mode-0600
#[test]
fn the_process_lock_is_owner_only() {
    let config = folder::Folder::new();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-lock-mode", fake);
    assert_eq!(mode(&config.path().join("process.lock")), 0o600);
    endpoint.stop();
}

/// The process identifier of a child process that has ended and been waited for.
fn ended_pid() -> u32 {
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

/// Starts an endpoint in a directory whose lock file has the content `stale`. A second start runs once, at the point where
/// the first start has read the stale content and before it writes its record. It returns the result of the second start,
/// when it ran, and the result of the first start.
#[cfg(feature = "diagnostics")]
fn start_beside_a_stale_lock(
    directory: &Path,
    stale: &str,
) -> (Option<String>, Result<Endpoint, String>) {
    use soksak_host_tauriv2::process_lock_hook::set_process_lock_hook;
    use std::sync::atomic::{AtomicBool, Ordering};

    std::fs::write(directory.join("process.lock"), stale).unwrap();
    let outcome: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let slot = outcome.clone();
    let nested = directory.to_path_buf();
    let fired = Arc::new(AtomicBool::new(false));
    set_process_lock_hook(Some(Arc::new(move |locked: &Path| {
        // The hook is process-wide, so it acts only on the directory of this test and on its first call.
        if locked != nested.as_path() || fired.swap(true, Ordering::SeqCst) {
            return;
        }
        let (second, _) = Fake::new();
        let started = Endpoint::start(&nested.join("sockets"), &nested, "test-race", second);
        *slot.lock().unwrap() = Some(match started {
            Ok(endpoint) => {
                // A started endpoint is kept alive so that its lock file is not removed by this test.
                std::mem::forget(endpoint);
                "started".to_string()
            }
            Err(error) => error,
        });
    })));
    let (first, _) = Fake::new();
    let first_started = Endpoint::start(&directory.join("sockets"), directory, "test-race", first);
    set_process_lock_hook(None);
    let second = outcome.lock().unwrap().take();
    (second, first_started)
}

// contract: endpoint.lock.single-owner
#[cfg(feature = "diagnostics")]
#[test]
fn two_starters_of_a_stale_lock_leave_one_owner() {
    let config = folder::Folder::new();
    let stale = format!("{{\"pid\":{},\"boot\":\"1700000000-4242\"}}", ended_pid());
    let (second, first) = start_beside_a_stale_lock(config.path(), &stale);
    let second = second.expect("the second start did not run at the stale lock");
    assert!(
        second.contains("already owned by process"),
        "the second start was not refused while the first start claims the lock: {second}"
    );
    assert!(first.is_ok(), "the first start failed: {:?}", first.err());
}

// contract: endpoint.lock.single-owner
#[cfg(feature = "diagnostics")]
#[test]
fn a_starter_meets_an_owner_that_has_not_written_its_record() {
    let config = folder::Folder::new();
    let (second, first) = start_beside_a_stale_lock(config.path(), "");
    let second = second.expect("the second start did not run at the lock of the first start");
    assert!(
        second.contains("already owned by a live process"),
        "the second start was not refused while the owner has not written its record: {second}"
    );
    assert!(first.is_ok(), "the first start failed: {:?}", first.err());
}

// contract: endpoint.process.rejects-a-malformed-lock
#[test]
fn a_held_lock_with_another_form_is_refused_and_kept() {
    for contents in [
        "123",
        "abc",
        "0",
        r#"{"pid":0,"boot":"b1"}"#,
        r#"{"pid":5}"#,
    ] {
        let config = folder::Folder::new();
        let lock = config.path().join("process.lock");
        std::fs::write(&lock, contents).unwrap();
        // This test is the live owner: it holds the lock while the content has another form.
        let owner = std::fs::File::open(&lock).unwrap();
        owner.try_lock().unwrap();
        let (fake, _) = Fake::new();
        let refused = Endpoint::start(
            &config.path().join("sockets"),
            config.path(),
            "test-malformed",
            fake,
        )
        .err()
        .unwrap_or_else(|| panic!("lock {contents:?} was accepted while held"));
        assert!(
            refused.starts_with(&format!(
                "configuration directory {} is already owned by a live process",
                config.path().display()
            )),
            "lock {contents:?}: {refused}"
        );
        assert_eq!(std::fs::read_to_string(&lock).unwrap(), contents);
        drop(owner);
    }
}

// contract: endpoint.lock.unrecorded-end
#[test]
fn a_stale_lock_of_another_form_is_taken_over_and_reported() {
    for contents in ["123", "abc"] {
        let config = folder::Folder::new();
        std::fs::write(config.path().join("process.lock"), contents).unwrap();
        let (fake, _) = Fake::new();
        let endpoint = Endpoint::start(
            &config.path().join("sockets"),
            config.path(),
            "test-stale-form",
            fake,
        )
        .unwrap_or_else(|error| panic!("a stale lock {contents:?} was refused: {error}"));
        assert_eq!(
            endpoint.unrecorded_end(),
            Some(&UnrecordedEnd {
                boot: None,
                pid: None,
                previous: Some(contents.into()),
            })
        );
        endpoint.stop();
    }
}

// contract: endpoint.lock.empty-is-no-previous-run
#[test]
fn an_empty_lock_file_is_taken_over_without_a_report() {
    // A starter creates process.lock before it locks the file, so an empty file that is not locked can be the file of a
    // starter that has not locked it yet. No owner wrote a record in it, so no earlier run is reported.
    let config = folder::Folder::new();
    std::fs::write(config.path().join("process.lock"), "").unwrap();
    let (fake, _) = Fake::new();
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-empty",
        fake,
    )
    .unwrap_or_else(|error| panic!("an empty lock file was refused: {error}"));
    assert_eq!(endpoint.unrecorded_end(), None);
    endpoint.stop();
}

// contract: endpoint.lock.unrecorded-end
#[test]
fn a_stale_lock_is_taken_over_and_names_the_previous_run() {
    let config = folder::Folder::new();
    let dead = ended_pid();
    let lock = config.path().join("process.lock");
    std::fs::write(
        &lock,
        format!("{{\"pid\":{dead},\"boot\":\"1700000000-4242\"}}"),
    )
    .unwrap();
    let (fake, _) = Fake::new();
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-stale",
        fake,
    )
    .unwrap_or_else(|error| panic!("a stale lock was refused: {error}"));
    assert_eq!(
        endpoint.unrecorded_end(),
        Some(&UnrecordedEnd {
            boot: Some("1700000000-4242".into()),
            pid: Some(dead),
            previous: None,
        })
    );
    let owner: Value = serde_json::from_str(&std::fs::read_to_string(&lock).unwrap()).unwrap();
    assert_eq!(owner["pid"], std::process::id());
    assert_ne!(owner["boot"], "1700000000-4242");
    endpoint.stop();
    assert!(!lock.exists());
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
    let config = folder::Folder::new();
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
    let config = folder::Folder::new();
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
    let config = folder::Folder::new();
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
    let config = folder::Folder::new();
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

// contract: endpoint.diagnostics.clock, endpoint.diagnostics-clock.real-jsonrpc-returns-monotonic-decimal
#[cfg(feature = "diagnostics")]
#[test]
fn diagnostics_clock_returns_monotonic_nanoseconds() {
    let config = folder::Folder::new();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-diagnostics-clock", fake.clone());
    let mut connection = open(&endpoint);
    let mut previous = 0;
    for id in 1..=2 {
        let reply = request(
            &mut connection,
            id,
            "diagnostics.clock",
            json!({"window": "w1"}),
        );
        assert_eq!(reply["jsonrpc"], "2.0");
        assert_eq!(reply["id"], id);
        assert_eq!(
            reply["result"].as_object().map(serde_json::Map::len),
            Some(1),
            "diagnostics.clock must return only mono_ns"
        );
        let mono_ns = reply["result"]["mono_ns"]
            .as_str()
            .expect("diagnostics.clock must return mono_ns as a string");
        let parsed = mono_ns
            .parse::<u64>()
            .expect("mono_ns must be a uint64 decimal string");
        assert!(parsed > 0, "mono_ns must be positive");
        assert_eq!(parsed.to_string(), mono_ns, "mono_ns must be canonical");
        assert!(parsed >= previous, "mono_ns must not decrease");
        previous = parsed;
    }
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

// contract: endpoint.diagnostics-clock.absent-without-diagnostics
#[cfg(not(feature = "diagnostics"))]
#[test]
fn diagnostics_clock_is_not_declared_without_diagnostics() {
    let config = folder::Folder::new();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "clock-release", fake.clone());
    let mut connection = open(&endpoint);
    send(
        &mut connection,
        json!({"jsonrpc": "2.0", "id": 1, "method": "diagnostics.clock", "params": {"window": "w1"}}),
    );
    assert_eq!(receive(&mut connection), None);
    assert!(fake.calls().is_empty());
    endpoint.stop();
}

// contract: endpoint.diagnostics.methods-exist-only-in-diagnostic-builds
#[test]
fn diagnostic_methods_exist_only_in_diagnostic_builds() {
    let config = folder::Folder::new();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-diagnostics", fake.clone());
    let mut connection = open(&endpoint);
    send(
        &mut connection,
        json!({"jsonrpc": "2.0", "id": 1, "method": "diagnostics.transcript",
        "params": {"window": "w1", "on": false}}),
    );
    let reply = receive(&mut connection);
    if cfg!(feature = "diagnostics") {
        assert_eq!(
            reply,
            Some(json!({"jsonrpc": "2.0", "id": 1, "result": null}))
        );
    } else {
        assert_eq!(reply, None);
        assert!(fake.calls().is_empty());
    }
    endpoint.stop();
}

// contract: endpoint.rpc.unknown-window-1003, endpoint.rpc.missing-window-param-invalid
#[test]
fn declared_method_on_unknown_window_returns_1003() {
    let config = folder::Folder::new();
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
    let config = folder::Folder::new();
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
    let config = folder::Folder::new();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-file", fake);
    let file = config.path().join("endpoint.json");
    let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(written["transport"], "unix");
    assert_eq!(written["address"], endpoint.address());
    assert_eq!(written["pid"], std::process::id());
    assert_eq!(written["application"], "test-file");
    assert_eq!(written["version"], env!("CARGO_PKG_VERSION"));
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
    let config = folder::Folder::new();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-replacement", fake);
    let file = config.path().join("endpoint.json");
    let replacement = json!({
        "transport": "unix", "address": "replacement.sock", "pid": std::process::id() + 1,
        "application": "test-replacement", "version": "0.0.2", "executable": "/replacement",
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
    let config = folder::Folder::new();
    let (fake, _) = Fake::new();
    let endpoint = start(config.path(), "test-modes", fake);
    assert_eq!(mode(&config.path().join("sockets")), 0o700);
    assert_eq!(mode(Path::new(endpoint.address())), 0o600);
    assert_eq!(mode(&config.path().join("endpoint.json")), 0o600);
}

/// The number of an ended process.
fn ended_process() -> u32 {
    let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
    child.wait().unwrap();
    child.id()
}

// contract: endpoint.socket.sweeps-ended-process-sockets
#[test]
fn sockets_of_ended_processes_are_removed() {
    use std::os::unix::fs::DirBuilderExt;
    let config = folder::Folder::new();
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
    let config = folder::Folder::new();
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
    // /usr is owned by root. The check looks at the owner before the permissions.
    let config = folder::Folder::new();
    let (fake, _) = Fake::new();
    let refused = Endpoint::start(Path::new("/usr"), config.path(), "test-owner", fake)
        .err()
        .unwrap();
    assert!(refused.contains("belongs to another user"), "{refused}");
}

// contract: endpoint.socket.refuses-non-directory
#[test]
fn a_socket_path_that_is_not_a_directory_is_refused() {
    let config = folder::Folder::new();
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

// contract: endpoint.socket.path-over-limit
#[test]
fn a_socket_path_over_the_limit_is_refused() {
    use std::os::unix::ffi::OsStrExt;
    let config = folder::Folder::new();
    let sockets = config.path().join("s".repeat(120));
    let address = sockets.join(format!("test-long-{}.sock", std::process::id()));
    let (fake, _) = Fake::new();
    let refused = Endpoint::start(&sockets, config.path(), "test-long", fake)
        .err()
        .unwrap();
    assert_eq!(
        refused,
        format!(
            "endpoint socket path {} is {} bytes, over the limit of 103 bytes of a unix socket address",
            address.display(),
            address.as_os_str().as_bytes().len()
        )
    );
}

// contract: endpoint.watch.notifies-watching-connection, endpoint.watch.non-watching-connection-not-notified, endpoint.watch.unwatch-is-per-connection, endpoint.watch.page-watch-deduplicated, endpoint.watch.no-page-unwatch-while-watched, endpoint.watch.last-watcher-close-unwatches-page, endpoint.watch.registry-reflects-watches
#[test]
fn watchers_belong_to_their_connection() {
    let config = folder::Folder::new();
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

    // The second connection did not watch, so it receives its own response first and not a notification.
    notifier.changed("w1", "core.layout", None, &raw(&json!(1)).unwrap());
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

    // Unwatching by the second connection does not change the watch of the first connection.
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
    notifier.changed("w1", "core.layout", None, &raw(&json!(2)).unwrap());
    assert_eq!(receive(&mut first).unwrap()["params"]["value"], 2);
    // The page receives only the first watch of the watches of the two connections.
    let page_watches = fake
        .calls()
        .iter()
        .filter(|(_, method, _)| method == "status.watch")
        .count();
    assert_eq!(page_watches, 1, "{:?}", fake.calls());
    assert!(
        !fake
            .calls()
            .iter()
            .any(|(_, method, _)| method == "status.unwatch")
    );

    // When the connection of the last watcher closes, the page is asked to unwatch.
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
    let config = folder::Folder::new();
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

    notifier.changed(
        "w1",
        "probe.lines",
        Some("tab-a"),
        &raw(&json!(["a"])).unwrap(),
    );
    assert_eq!(
        receive(&mut connection),
        Some(json!({"jsonrpc": "2.0", "method": "status.changed",
        "params": {"window": "w1", "name": "probe.lines", "surface": "tab-a", "value": ["a"]}}))
    );
    notifier.changed("w1", "probe.lines", None, &raw(&json!(["b"])).unwrap());
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
    let config = folder::Folder::new();
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

/// A page that records watch requests in the order of completion. The first status.unwatch does not finish until gate
/// opens.
struct GatedPage {
    order: Mutex<Vec<String>>,
    gate: Mutex<Option<Receiver<()>>>,
    entered: Mutex<Sender<String>>,
}

impl Service for GatedPage {
    fn unwatched(&self, _window: &str, _name: &str) {}

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
    ) -> Result<Box<RawValue>, Failure> {
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
        raw(&if method == "status.get" {
            json!(0)
        } else {
            Value::Null
        })
    }
}

// contract: endpoint.watch.subscription-arrival-order, endpoint.watch.other-requests-not-blocked-by-pending-subscription
#[test]
fn subscription_changes_reach_the_page_in_arrival_order() {
    let config = folder::Folder::new();
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

    // An unwatch and a watch are sent one after the other. The response to another request is received before the page
    // finishes the unwatch.
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
    notifier.changed("w1", "core.layout", None, &raw(&json!(5)).unwrap());
    assert_eq!(receive(&mut connection).unwrap()["params"]["value"], 5);
    endpoint.stop();
}

/// A service that has the window main only after it was registered.
struct Late(std::sync::atomic::AtomicBool);

impl Service for Late {
    fn unwatched(&self, _window: &str, _name: &str) {}

    fn windows(&self) -> Result<Value, Failure> {
        Ok(json!([]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "main" && self.0.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn call(&self, _: &str, _: &str, _: Map<String, Value>) -> Result<Box<RawValue>, Failure> {
        raw(&json!("answered"))
    }
}

// contract: endpoint.discovery.written-after-first-window
#[test]
fn endpoint_file_is_written_only_after_the_first_window_exists() {
    let config = folder::Folder::new();
    let service = Arc::new(Late(std::sync::atomic::AtomicBool::new(false)));
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-first",
        service.clone(),
    )
    .unwrap();
    let file = config.path().join("endpoint.json");
    assert!(
        !file.exists(),
        "endpoint.json was written before the first window was registered"
    );
    let refused = endpoint
        .publish("main")
        .expect_err("endpoint.json was published for a window that does not exist");
    assert!(refused.contains("window main does not exist"), "{refused}");
    assert!(!file.exists(), "a refused publication wrote endpoint.json");
    service.0.store(true, std::sync::atomic::Ordering::SeqCst);
    endpoint.publish("main").unwrap();
    let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(written["address"], endpoint.address());
    let mut connection = open(&endpoint);
    let reply = request(
        &mut connection,
        1,
        "status.get",
        json!({"window": "main", "name": "host.windows"}),
    );
    assert_eq!(reply["result"], "answered", "{reply}");
    endpoint.stop();
    assert!(!file.exists());
}

// contract: endpoint.transport.closing-a-disconnected-connection-succeeds
#[test]
fn closing_an_already_disconnected_connection_succeeds() {
    let config = folder::Folder::new();
    let (service, _) = Fake::new();
    let endpoint = start(config.path(), "test-close", service);
    let connection = open(&endpoint);
    assert_eq!(connection.close(), Ok(()));
    // Closing an already closed connection again is not a failure. A socket whose shutdown is done returns ENOTCONN.
    assert_eq!(
        connection.close(),
        Ok(()),
        "closing a disconnected connection reported an error"
    );
}

const CLOSE_CHILD: &str = "SOKSAK_ENDPOINT_CLOSE_CHILD";

// contract: endpoint.transport.close-reason-is-recorded
// contract: endpoint.close.reason-of-read-error
#[test]
fn the_endpoint_records_why_a_connection_closes() {
    if let Some(config) = std::env::var_os(CLOSE_CHILD) {
        let config = Path::new(&config);
        soksak_host_tauriv2::application_log::start_standard_error(config, "com.soksak.test")
            .unwrap();
        let writer = records::start_writer(config);
        let (fake, calls) = Fake::new();
        let endpoint = start(config, "test-close-reason", fake);
        let mut connection = open(&endpoint);
        connection.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        assert_eq!(receive(&mut connection), None);
        let mut connection = open(&endpoint);
        let body = b"{not json";
        connection
            .write_all(&(body.len() as u32).to_be_bytes())
            .unwrap();
        connection.write_all(body).unwrap();
        assert_eq!(receive(&mut connection), None);
        let mut connection = open(&endpoint);
        send(&mut connection, json!([1, 2]));
        assert_eq!(receive(&mut connection), None);
        let mut connection = open(&endpoint);
        send(
            &mut connection,
            json!({"jsonrpc": "2.0", "id": 1, "method": "page.eval", "params": {"window": "w1"}}),
        );
        assert_eq!(receive(&mut connection), None);
        // A frame that ends early closes with the reason of the read. The record is written by the serve loop after it
        // reads the end of the connection, and nothing else reports that write, so the event log is read until it appears.
        let mut connection = open(&endpoint);
        connection.write_all(&10u32.to_be_bytes()).unwrap();
        connection.write_all(b"{\"j").unwrap();
        drop(connection);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            writer.flush(Duration::from_secs(5)).unwrap();
            let log = records::text_of(&records::read_events(&records::event_log_path(config)));
            if log.contains("connection closed: connection closed inside a frame body") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "no close record for the frame that ended early in {log:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        // The record of a close by the peer is written before the page is told that the last watcher ended.
        let mut connection = open(&endpoint);
        request(
            &mut connection,
            1,
            "status.watch",
            json!({"window": "w1", "name": "core.layout"}),
        );
        drop(connection);
        loop {
            let (_, method, _) = calls.recv_timeout(Duration::from_secs(5)).unwrap();
            if method == "status.unwatch" {
                break;
            }
        }
        endpoint.stop();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = folder::Folder::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_endpoint_records_why_a_connection_closes",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CLOSE_CHILD, config.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let log = records::text_of(&records::read_events(&records::event_log_path(
        config.path(),
    )));
    for reason in [
        "frame of 1195725856 bytes exceeds the limit of 16777216",
        "frame is not a JSON-RPC 2.0 request: {not json",
        "frame is not a JSON-RPC 2.0 request: [1,2]",
        "method \"page.eval\" is not declared",
        "connection closed inside a frame body",
        "peer closed",
    ] {
        let found = log.lines().any(|line| {
            line.split_once(' ').is_some_and(|(_, rest)| {
                rest == format!("info host endpoint: connection closed: {reason}")
            })
        });
        assert!(found, "no close record {reason:?} in {log:?}");
    }
}

const TIMEOUT_CHILD: &str = "SOKSAK_ENDPOINT_TIMEOUT_CHILD";

// A request that ends with a timeout error writes the method and the reason to the application log before the client
// receives the error.
// contract: endpoint.timeout.is-recorded
#[test]
fn the_endpoint_records_a_timeout_of_a_request() {
    if let Some(config) = std::env::var_os(TIMEOUT_CHILD) {
        let config = Path::new(&config);
        soksak_host_tauriv2::application_log::start_standard_error(config, "com.soksak.test")
            .unwrap();
        let writer = records::start_writer(config);
        let (fake, _calls) = Fake::new();
        *fake.timing_out.lock().unwrap() = Some("status.get".to_string());
        let endpoint = start(config, "test-timeout", fake);
        let mut connection = open(&endpoint);
        let reply = request(
            &mut connection,
            1,
            "status.get",
            json!({"window": "w1", "name": "core.layout"}),
        );
        assert_eq!(reply["error"]["code"], endpoint::TIMED_OUT);
        endpoint.stop();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = folder::Folder::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_endpoint_records_a_timeout_of_a_request",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(TIMEOUT_CHILD, config.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout)
    );
    let log = records::text_of(&records::read_events(&records::event_log_path(
        config.path(),
    )));
    let want =
        " error host endpoint timeout: status.get: the document did not reply within 10000 ms";
    assert!(log.contains(want), "no {want:?} in {log}");
}

// contract: diagnostics.objects.counts-host-objects
#[cfg(feature = "diagnostics")]
#[test]
fn subscriber_count_follows_the_watches_of_a_window() {
    let config = folder::Folder::new();
    let (fake, _seen) = Fake::new();
    let endpoint = start(config.path(), "test-subscribers", fake.clone());
    let notifier = endpoint.notifier();
    assert_eq!(notifier.subscribers("w1"), 0);
    let mut first = open(&endpoint);
    let mut second = open(&endpoint);
    request(
        &mut first,
        1,
        "status.watch",
        json!({"window": "w1", "name": "core.layout"}),
    );
    assert_eq!(notifier.subscribers("w1"), 1);
    request(
        &mut second,
        2,
        "status.watch",
        json!({"window": "w1", "name": "core.layout"}),
    );
    assert_eq!(notifier.subscribers("w1"), 2);
    assert_eq!(notifier.subscribers("w2"), 0);
    request(
        &mut first,
        3,
        "status.unwatch",
        json!({"window": "w1", "name": "core.layout"}),
    );
    assert_eq!(notifier.subscribers("w1"), 1);
}

const ACCEPT_CHILD: &str = "SOKSAK_ENDPOINT_ACCEPT_CHILD";

// An accept that fails while the endpoint serves writes the reason to the application log. The accept error is injected through
// fail_accept_for_test, because no ordinary input makes an accept fail.
// contract: endpoint.accept.error-is-recorded
#[test]
fn the_endpoint_records_an_accept_error() {
    if let Some(config) = std::env::var_os(ACCEPT_CHILD) {
        let config = Path::new(&config);
        soksak_host_tauriv2::application_log::start_standard_error(config, "com.soksak.test")
            .unwrap();
        let writer = records::start_writer(config);
        let (fake, _) = Fake::new();
        endpoint::fail_accept_for_test(&config.join("sockets"), "accept fault");
        let endpoint = start(config, "test-accept-error", fake);
        // The record is written by the accept loop after accept returns, and no event reports that write, so the event log is
        // read until the record appears.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            writer.flush(Duration::from_secs(5)).unwrap();
            let log = records::text_of(&records::read_events(&records::event_log_path(config)));
            if log.contains("error host endpoint accept: accept fault") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "no accept record in {log:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        endpoint.stop();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = folder::Folder::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_endpoint_records_an_accept_error",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ACCEPT_CHILD, config.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}
