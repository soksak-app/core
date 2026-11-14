//! Tests of the transport, the frames, the JSON-RPC handling and the watch list of the local endpoint. The page of the window is
//! the page of an endpoint case (support/endpoint_case.rs): it answers the requests of the endpoint as the `page` steps of a
//! case state, and a request that the case has no step for fails the test. The cases of docs/spec/cases/endpoint that the
//! endpoint answers with such a page are played here, as the Go host plays them.

#[path = "support/child.rs"]
mod child;
#[path = "support/folder.rs"]
mod folder;

#[path = "support/platform/platform.rs"]
mod endpoint_client;

use endpoint_client::Connection;

#[path = "support/endpoint_case.rs"]
mod endpoint_case;

use endpoint_case::{CasePage, exchange, refused_exchange, serve_page};

use std::io::Write;
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

#[path = "support/records.rs"]
mod records;

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use soksak_host::endpoint::{self, Endpoint, Failure, Service, UnrecordedEnd, raw};

/// Opens the endpoint in the sockets directory inside config and writes endpoint.json with the window main. The socket
/// path is within the length limit.
fn start(config: &Path, application: &str, page: Arc<CasePage>) -> Endpoint {
    let endpoint = Endpoint::start(&config.join("sockets"), config, application, page).unwrap();
    endpoint.publish("main").unwrap();
    endpoint
}

// contract: endpoint.lock.single-owner
#[test]
fn a_configuration_directory_has_one_process_owner() {
    let config = folder::Folder::new();
    let first = CasePage::without_steps(&["main"]);
    let endpoint = start(config.path(), "test-owner", first);
    let second = CasePage::without_steps(&["main"]);
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
    let page = CasePage::without_steps(&["main"]);
    let endpoint = start(config.path(), "test-lock-mode", page);
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
    use soksak_host::process_lock_hook::set_process_lock_hook;
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
        let second = CasePage::without_steps(&["main"]);
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
    let first = CasePage::without_steps(&["main"]);
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
        let page = CasePage::without_steps(&["main"]);
        let refused = Endpoint::start(
            &config.path().join("sockets"),
            config.path(),
            "test-malformed",
            page,
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
        let page = CasePage::without_steps(&["main"]);
        let endpoint = Endpoint::start(
            &config.path().join("sockets"),
            config.path(),
            "test-stale-form",
            page,
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
    let page = CasePage::without_steps(&["main"]);
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-empty",
        page,
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
    let page = CasePage::without_steps(&["main"]);
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-stale",
        page,
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

fn open(endpoint: &Endpoint) -> Connection {
    endpoint_client::connect(endpoint.address())
}

fn send(connection: &mut Connection, message: Value) {
    endpoint::write_frame(connection, &message).unwrap();
}

fn receive(connection: &mut Connection) -> Option<Value> {
    endpoint::read_frame(connection).unwrap()
}

fn request(connection: &mut Connection, id: u64, method: &str, params: Value) -> Value {
    send(
        connection,
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    );
    receive(connection).expect("the endpoint closed the connection")
}

// The cases with a scripted page. The cases that the endpoint answers without a page are played by endpoint_cases_test.rs.

// contract: endpoint.transport.close-reason-is-recorded
#[test]
fn scripted_close_reason_recorded() {
    endpoint_case::play("scripted_close_reason_recorded", "close-reason-recorded");
}

// contract: exposure.command.ends-by-reply-or-peer-end, exposure.relay.connection-end-ends-its-requests
#[test]
fn scripted_connection_end_ends_page_request() {
    endpoint_case::play(
        "scripted_connection_end_ends_page_request",
        "connection-end-ends-page-request",
    );
}

// contract: endpoint.rpc.element-rect-role
#[test]
fn scripted_element_rect_role() {
    endpoint_case::play("scripted_element_rect_role", "element-rect-role");
}

// contract: exposure.list.host-owner-without-page
#[test]
fn scripted_exposure_list_host_entries() {
    endpoint_case::play(
        "scripted_exposure_list_host_entries",
        "exposure-list-host-entries",
    );
}

// contract: endpoint.no-result.is-recorded
#[test]
fn scripted_no_result_recorded() {
    endpoint_case::play("scripted_no_result_recorded", "no-result-recorded");
}

// contract: endpoint.close.reply-after-peer-close
#[test]
fn scripted_reply_after_peer_close() {
    endpoint_case::play("scripted_reply_after_peer_close", "reply-after-peer-close");
}

// contract: endpoint.rpc.round-trip-by-id, endpoint.rpc.page-params-omit-window
#[test]
fn scripted_round_trip_page_params() {
    endpoint_case::play("scripted_round_trip_page_params", "round-trip-page-params");
}

// contract: endpoint.rpc.target-params-are-checked-in-order
#[test]
fn scripted_target_params_order() {
    endpoint_case::play("scripted_target_params_order", "target-params-order");
}

// contract: endpoint.transport.undeclared-method-closes
#[test]
fn scripted_undeclared_methods_removed() {
    endpoint_case::play(
        "scripted_undeclared_methods_removed",
        "undeclared-methods-removed",
    );
}

// contract: endpoint.watch.unwatch-enters-the-queue-only-after-a-watch
#[test]
fn scripted_unwatch_without_watch() {
    endpoint_case::play("scripted_unwatch_without_watch", "unwatch-without-watch");
}

// contract: endpoint.watch.subscription-arrival-order
#[test]
fn scripted_watch_arrival_order() {
    endpoint_case::play("scripted_watch_arrival_order", "watch-arrival-order");
}

// contract: endpoint.watch.other-requests-not-blocked-by-pending-subscription
#[test]
fn scripted_watch_pending_subscription() {
    endpoint_case::play(
        "scripted_watch_pending_subscription",
        "watch-pending-subscription",
    );
}

// contract: endpoint.watch.notifies-watching-connection, endpoint.watch.non-watching-connection-not-notified, endpoint.watch.unwatch-is-per-connection, endpoint.watch.page-watch-deduplicated, endpoint.watch.no-page-unwatch-while-watched, endpoint.watch.last-watcher-close-unwatches-page, endpoint.watch.registry-reflects-watches
#[test]
fn scripted_watch_per_connection() {
    endpoint_case::play("scripted_watch_per_connection", "watch-per-connection");
}

// contract: endpoint.rpc.missing-window-param-invalid
#[test]
fn scripted_window_param_missing() {
    endpoint_case::play("scripted_window_param_missing", "window-param-missing");
}

// contract: exposure.list.host-owner-without-page
#[test]
fn scripted_exposure_list_host_owner() {
    endpoint_case::play(
        "scripted_exposure_list_host_owner",
        "exposure-list-host-owner",
    );
}

// contract: exposure.list.non-object-list-rejected
#[test]
fn scripted_exposure_list_not_object() {
    endpoint_case::play(
        "scripted_exposure_list_not_object",
        "exposure-list-not-object",
    );
}

// contract: endpoint.input.dialog-answer
#[test]
fn scripted_input_delivered() {
    endpoint_case::play("scripted_input_delivered", "input-delivered");
}

// contract: endpoint.names.unknown-host-name-1001, endpoint.errors.unknown-name-text, endpoint.names.missing-name-invalid, endpoint.names.owner-form-required, endpoint.names.valid-name-examples, endpoint.input.pointer-invalid-phase
#[test]
fn scripted_name_errors() {
    endpoint_case::play("scripted_name_errors", "name-errors");
}

// contract: endpoint.dialog.watch-reaches-the-host
#[test]
fn scripted_watch_host_dialog() {
    endpoint_case::play("scripted_watch_host_dialog", "watch-host-dialog");
}

// contract: endpoint.watch.empty-surface-invalid, endpoint.watch.surface-and-plain-forwarded-separately
#[test]
fn scripted_watch_surface_separate() {
    endpoint_case::play("scripted_watch_surface_separate", "watch-surface-separate");
}

/// The scripted cases that this file plays.
const SCRIPTED: &[&str] = &[
    "close-reason-recorded",
    "connection-end-ends-page-request",
    "element-rect-role",
    "exposure-list-host-entries",
    "exposure-list-host-owner",
    "exposure-list-not-object",
    "input-delivered",
    "name-errors",
    "no-result-recorded",
    "reply-after-peer-close",
    "round-trip-page-params",
    "target-params-order",
    "undeclared-methods-removed",
    "unwatch-without-watch",
    "watch-arrival-order",
    "watch-host-dialog",
    "watch-pending-subscription",
    "watch-per-connection",
    "watch-surface-separate",
    "window-param-missing",
];

// contract: endpoint.cases.replayed-cases-are-covered
#[test]
fn every_scripted_case_is_played() {
    let mut problems = Vec::new();
    let cases = endpoint_case::read_cases().unwrap_or_else(|error| panic!("{error}"));
    for case in &cases {
        let listed = SCRIPTED.contains(&case.name.as_str());
        if case.scripted && !listed {
            problems.push(format!(
                "{} has a scripted page but is not played here",
                case.name
            ));
        }
        if case.scripted && case.replay {
            problems.push(format!(
                "{} has a scripted page but its case has replay true: a running application has a page of its own",
                case.name
            ));
        }
    }
    for name in SCRIPTED.iter().copied() {
        if !cases.iter().any(|case| case.name == name && case.scripted) {
            problems.push(format!("{name} is listed here but is no scripted case"));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

// contract: endpoint.names.missing-name-invalid, endpoint.names.owner-form-required, endpoint.names.valid-name-examples
#[test]
fn names_must_have_the_owner_form() {
    let served = serve_page("test-names", Vec::new());
    let mut connection = served.open();
    let reply = request(&mut connection, 9, "status.get", json!({"window": "main"}));
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
            json!({"window": "main", "name": name}),
        );
        assert_eq!(reply["error"]["code"], -32602, "{name}");
    }
    assert!(endpoint::valid_name("core.surface.document") && endpoint::valid_name("plugin-x.a-1"));
    served.finish();
}

// contract: endpoint.watch.surface-and-plain-forwarded-separately, endpoint.watch.empty-surface-invalid, endpoint.watch.surface-change-names-surface, endpoint.watch.surface-unwatch-forwarded-with-surface, endpoint.watch.surface-unwatch-keeps-plain-watch
#[test]
fn surface_watches_are_separate() {
    let served = serve_page(
        "test-surface",
        vec![
            exchange(
                "status.watch",
                json!({"name": "probe.lines", "surface": "tab-a"}),
                Value::Null,
            ),
            exchange("status.watch", json!({"name": "probe.lines"}), Value::Null),
            exchange(
                "status.unwatch",
                json!({"name": "probe.lines", "surface": "tab-a"}),
                Value::Null,
            ),
        ],
    );
    let notifier = served.endpoint.notifier();
    let mut connection = served.open();
    let named = json!({"window": "main", "name": "probe.lines", "surface": "tab-a"});
    assert_eq!(
        request(&mut connection, 1, "status.watch", named.clone())["result"],
        Value::Null
    );
    assert_eq!(
        request(
            &mut connection,
            2,
            "status.watch",
            json!({"window": "main", "name": "probe.lines"})
        )["result"],
        Value::Null
    );
    let reply = request(
        &mut connection,
        3,
        "status.watch",
        json!({"window": "main", "name": "probe.lines", "surface": ""}),
    );
    assert_eq!(reply["error"]["code"], -32602);
    assert_eq!(notifier.watches("main").len(), 2);

    notifier.changed(
        "main",
        "probe.lines",
        Some("tab-a"),
        &raw(&json!(["a"])).unwrap(),
    );
    assert_eq!(
        receive(&mut connection),
        Some(json!({"jsonrpc": "2.0", "method": "status.changed",
        "params": {"window": "main", "name": "probe.lines", "surface": "tab-a", "value": ["a"]}}))
    );
    notifier.changed("main", "probe.lines", None, &raw(&json!(["b"])).unwrap());
    assert_eq!(
        receive(&mut connection),
        Some(json!({"jsonrpc": "2.0", "method": "status.changed",
        "params": {"window": "main", "name": "probe.lines", "value": ["b"]}}))
    );

    request(&mut connection, 4, "status.unwatch", named);
    assert!(
        notifier.watched("main", "probe.lines"),
        "the watch without a surface remains"
    );
    served.finish();
}

// contract: endpoint.diagnostics-clock.real-jsonrpc-returns-monotonic-decimal
#[cfg(feature = "diagnostics")]
#[test]
fn diagnostics_clock_returns_monotonic_nanoseconds() {
    let config = folder::Folder::new();
    let page = CasePage::without_steps(&["main"]);
    let endpoint = start(config.path(), "test-diagnostics-clock", page.clone());
    let mut connection = open(&endpoint);
    let mut previous = 0;
    for id in 1..=2 {
        let reply = request(
            &mut connection,
            id,
            "diagnostics.clock",
            json!({"window": "main"}),
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
    assert_eq!(page.finish(), Vec::<String>::new());
    endpoint.stop();
}

// contract: endpoint.diagnostics-clock.absent-without-diagnostics
#[cfg(not(feature = "diagnostics"))]
#[test]
fn diagnostics_clock_is_not_declared_without_diagnostics() {
    let config = folder::Folder::new();
    let page = CasePage::without_steps(&["main"]);
    let endpoint = start(config.path(), "clock-release", page.clone());
    let mut connection = open(&endpoint);
    send(
        &mut connection,
        json!({"jsonrpc": "2.0", "id": 1, "method": "diagnostics.clock", "params": {"window": "main"}}),
    );
    assert_eq!(receive(&mut connection), None);
    assert_eq!(page.finish(), Vec::<String>::new());
    endpoint.stop();
}

// contract: endpoint.diagnostics.methods-exist-only-in-diagnostic-builds
#[test]
fn diagnostic_methods_exist_only_in_diagnostic_builds() {
    // The endpoint answers the record of a diagnostic build itself, and any request that reaches the page fails the test.
    let served = serve_page("test-diagnostics", Vec::new());
    let mut connection = served.open();
    send(
        &mut connection,
        json!({"jsonrpc": "2.0", "id": 1, "method": "diagnostics.transcript",
        "params": {"window": "main", "on": false}}),
    );
    let reply = receive(&mut connection);
    if cfg!(feature = "diagnostics") {
        assert_eq!(
            reply,
            Some(json!({"jsonrpc": "2.0", "id": 1, "result": null}))
        );
    } else {
        assert_eq!(reply, None);
    }
    served.finish();
}

// contract: endpoint.discovery.writes-endpoint-json, endpoint.discovery.removes-endpoint-json-on-close, endpoint.discovery.removes-socket-on-close
#[test]
fn endpoint_file_is_written_and_removed() {
    let config = folder::Folder::new();
    let page = CasePage::without_steps(&["main"]);
    let endpoint = start(config.path(), "test-file", page);
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
    let page = CasePage::without_steps(&["main"]);
    let endpoint = start(config.path(), "test-replacement", page);
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
    let page = CasePage::without_steps(&["main"]);
    let endpoint = start(config.path(), "test-modes", page);
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
    let page = CasePage::without_steps(&["main"]);
    let endpoint = Endpoint::start(&sockets, config.path(), "test-sweep", page).unwrap();
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
    let page = CasePage::without_steps(&["main"]);
    let refused = Endpoint::start(&sockets, config.path(), "test-open", page)
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
    let page = CasePage::without_steps(&["main"]);
    let refused = Endpoint::start(Path::new("/usr"), config.path(), "test-owner", page)
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
    let page = CasePage::without_steps(&["main"]);
    let refused = Endpoint::start(&sockets, config.path(), "test-link", page)
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
    let page = CasePage::without_steps(&["main"]);
    let refused = Endpoint::start(&sockets, config.path(), "test-long", page)
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

// contract: endpoint.discovery.written-after-first-window
#[test]
fn endpoint_file_is_written_only_after_the_first_window_exists() {
    let config = folder::Folder::new();
    let page = CasePage::new(
        &[],
        vec![exchange(
            "status.get",
            json!({"name": "host.windows"}),
            json!("answered"),
        )],
    );
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-first",
        page.clone(),
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
    page.add_window("main");
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
    assert_eq!(page.finish(), Vec::<String>::new());
    endpoint.stop();
    assert!(!file.exists());
}

// contract: diagnostics.objects.counts-host-objects
#[cfg(feature = "diagnostics")]
#[test]
fn subscriber_count_follows_the_watches_of_a_window() {
    // The page receives the first watch only: the second connection joins the watch, and the first connection leaves it.
    let served = serve_page(
        "test-subscribers",
        vec![exchange(
            "status.watch",
            json!({"name": "core.layout"}),
            Value::Null,
        )],
    );
    let notifier = served.endpoint.notifier();
    assert_eq!(notifier.subscribers("main"), 0);
    let mut first = served.open();
    let mut second = served.open();
    request(
        &mut first,
        1,
        "status.watch",
        json!({"window": "main", "name": "core.layout"}),
    );
    assert_eq!(notifier.subscribers("main"), 1);
    request(
        &mut second,
        2,
        "status.watch",
        json!({"window": "main", "name": "core.layout"}),
    );
    assert_eq!(notifier.subscribers("main"), 2);
    assert_eq!(notifier.subscribers("w2"), 0);
    request(
        &mut first,
        3,
        "status.unwatch",
        json!({"window": "main", "name": "core.layout"}),
    );
    assert_eq!(notifier.subscribers("main"), 1);
    served.finish();
}

const READ_ERROR_CHILD: &str = "SOKSAK_ENDPOINT_READ_ERROR_CHILD";

// A connection that ends inside a frame closes with the reason of the read, not with peer closed. The record is written by the
// serve loop after it reads the end of the connection, and the wait ends at the batch that holds it.
// contract: endpoint.close.reason-of-read-error
#[test]
fn the_endpoint_records_a_read_error_inside_a_frame() {
    if let Some(config) = std::env::var_os(READ_ERROR_CHILD) {
        let config = Path::new(&config);
        soksak_host::application_log::start_standard_error(config, "com.soksak.test").unwrap();
        let writer = records::start_writer(config);
        let page = CasePage::without_steps(&["main"]);
        let endpoint = start(config, "test-read-error", page.clone());
        let mut connection = open(&endpoint);
        connection.write_all(&10u32.to_be_bytes()).unwrap();
        connection.write_all(b"{\"j").unwrap();
        drop(connection);
        records::await_text(
            &writer,
            config,
            "info host endpoint: connection closed: connection closed inside a frame body",
        );
        assert_eq!(page.finish(), Vec::<String>::new());
        endpoint.stop();
        writer.flush().unwrap();
        return;
    }
    let config = folder::Folder::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_endpoint_records_a_read_error_inside_a_frame",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(READ_ERROR_CHILD, config.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    child::require_success(&output, config.path());
}

const ACCEPT_CHILD: &str = "SOKSAK_ENDPOINT_ACCEPT_CHILD";

// An accept that fails while the endpoint serves writes the reason to the application log. The accept error is injected through
// fail_accept_for_test, because no ordinary input makes an accept fail.
// contract: endpoint.accept.error-is-recorded
#[test]
fn the_endpoint_records_an_accept_error() {
    if let Some(config) = std::env::var_os(ACCEPT_CHILD) {
        let config = Path::new(&config);
        soksak_host::application_log::start_standard_error(config, "com.soksak.test").unwrap();
        let writer = records::start_writer(config);
        let page = CasePage::without_steps(&["main"]);
        endpoint::fail_accept_for_test(&config.join("sockets"), "accept fault");
        let endpoint = start(config, "test-accept-error", page);
        // The record is written by the accept loop after accept returns, and the wait ends at the batch that holds it.
        records::await_text(&writer, config, "error host endpoint accept: accept fault");
        endpoint.stop();
        writer.flush().unwrap();
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
    child::require_success(&output, config.path());
}

/// The window owner that stops the endpoint after the response of its request, as the quit of a host that has no ready window to
/// close does: it registers the stop with the reply scope of the request and gives the request to the page.
struct QuitOwner {
    page: Arc<CasePage>,
    endpoint: Mutex<std::sync::Weak<Endpoint>>,
    completed: Mutex<mpsc::Sender<endpoint::ReplyOutcome>>,
}

impl Service for QuitOwner {
    fn windows(&self) -> Result<Value, Failure> {
        self.page.windows()
    }

    fn exists(&self, window: &str) -> bool {
        self.page.exists(window)
    }

    fn unwatched(&self, window: &str, name: &str) {
        self.page.unwatched(window, name)
    }

    fn call(
        &self,
        window: &str,
        method: &str,
        params: Map<String, Value>,
        reply: Option<endpoint::ReplyScope>,
    ) -> Result<Box<RawValue>, Failure> {
        let endpoint = self.endpoint.lock().unwrap().clone();
        let completed = self.completed.lock().unwrap().clone();
        reply
            .clone()
            .expect("external request owns its response")
            .after_response(move |outcome| {
                // stop closes the real peer and takes its writer lock. It must run
                // after response flush AND after the writer lock has been released.
                endpoint.upgrade().unwrap().stop();
                completed.send(outcome).unwrap();
            });
        self.page.call(window, method, params, reply)
    }
}

/// A request whose work ends the endpoint after its response receives that response before the connection closes.
// contract: endpoint.response.follows-the-socket-write
#[test]
fn a_zero_ready_termination_intent_replies_before_the_actual_socket_closes() {
    let config = folder::Folder::new();
    let (tx, rx) = mpsc::channel();
    let page = CasePage::new(
        &["main"],
        vec![exchange(
            "command.run",
            json!({"name": "probe.terminate"}),
            Value::Null,
        )],
    );
    let service = Arc::new(QuitOwner {
        page: page.clone(),
        endpoint: Mutex::new(std::sync::Weak::new()),
        completed: Mutex::new(tx),
    });
    let endpoint = Arc::new(
        Endpoint::start(
            &config.path().join("sockets"),
            config.path(),
            "reply-scope",
            service.clone(),
        )
        .unwrap(),
    );
    *service.endpoint.lock().unwrap() = Arc::downgrade(&endpoint);
    endpoint.publish("main").unwrap();
    let mut client = endpoint_client::connect(endpoint.address());
    let body = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":71,"method":"command.run","params":{"window":"main","name":"probe.terminate"}})).unwrap();
    client
        .write_all(&(body.len() as u32).to_be_bytes())
        .unwrap();
    client.write_all(&body).unwrap();
    let response = endpoint::read_frame(&mut client)
        .unwrap()
        .expect("normal result must precede terminal EOF");
    assert_eq!(response, json!({"jsonrpc":"2.0","id":71,"result":null}));
    assert_eq!(rx.recv().unwrap(), endpoint::ReplyOutcome::Written);
    assert_eq!(endpoint::read_frame(&mut client).unwrap(), None);
    assert_eq!(page.finish(), Vec::<String>::new());
}

/// The params of an `input.pointer` of the main pointer.
fn main_pointer(phase: &str, x: Value, y: Value) -> Value {
    json!({"x": x, "y": y, "phase": phase})
}

/// The params of the release that the endpoint delivers for the press of the main pointer at (x, y).
fn main_release(x: f64, y: f64) -> Value {
    json!({"pointer": "main", "x": x, "y": y, "phase": "up", "button": "left", "clicks": 1})
}

// The close of a connection releases the press that its down opened, at the point of its last delivered drag, and a press
// that an up of any connection ended is not released again.
// contract: endpoint.input.close-releases-presses
#[test]
fn the_close_of_a_connection_releases_its_presses() {
    let second = |phase: &str, x: i64, y: i64| json!({"pointer": "second", "x": x, "y": y, "phase": phase, "button": "right"});
    let served = serve_page(
        "test-press",
        vec![
            exchange("input.pointer", second("down", 10, 20), Value::Null),
            exchange("input.pointer", second("drag", 30, 40), Value::Null),
            exchange(
                "input.pointer",
                main_pointer("down", json!(1), json!(2)),
                Value::Null,
            ),
            exchange(
                "input.pointer",
                main_pointer("up", json!(1), json!(2)),
                Value::Null,
            ),
            // The release of the press of the first connection: the point of its last delivered drag.
            exchange(
                "input.pointer",
                json!({"pointer": "second", "x": 30.0, "y": 40.0, "phase": "up", "button": "right", "clicks": 1}),
                Value::Null,
            ),
            // The close found no other press: the next call of the page is the one of the second connection.
            exchange(
                "input.pointer",
                main_pointer("move", json!(1), json!(2)),
                Value::Null,
            ),
        ],
    );
    let mut first = served.open();
    let pointer = |phase: &str, x: i64, y: i64| json!({"window": "main", "pointer": "second", "x": x, "y": y, "phase": phase, "button": "right"});
    assert_eq!(
        request(&mut first, 1, "input.pointer", pointer("down", 10, 20))["result"],
        Value::Null
    );
    assert_eq!(
        request(&mut first, 2, "input.pointer", pointer("drag", 30, 40))["result"],
        Value::Null
    );
    // A press of the main pointer that an up of another connection ended is no press of this connection any more.
    let main = |phase: &str| json!({"window": "main", "x": 1, "y": 2, "phase": phase});
    request(&mut first, 3, "input.pointer", main("down"));
    let mut other = served.open();
    request(&mut other, 1, "input.pointer", main("up"));
    drop(first);
    // The release of a closed connection runs in the serve thread of that connection, which no call of the test is ordered
    // after, so the test waits for the call of the page.
    assert!(served.page.await_total(5), "the close released no press");
    request(&mut other, 2, "input.pointer", main("move"));
    served.finish();
}

// A release refused with 1007 is delivered at the next host.buttons mask 0, and not at a mask that is not 0.
// contract: endpoint.input.close-releases-presses
#[test]
fn a_release_refused_while_a_button_is_held_waits_for_mask_zero() {
    let served = serve_page(
        "test-press-held",
        vec![
            exchange(
                "input.pointer",
                main_pointer("down", json!(5), json!(6)),
                Value::Null,
            ),
            refused_exchange(
                "input.pointer",
                main_release(5.0, 6.0),
                endpoint::BUTTON_HELD,
                "a button is held",
            ),
            exchange("input.pointer", main_release(5.0, 6.0), Value::Null),
        ],
    );
    let notifier = served.endpoint.notifier();
    let mut connection = served.open();
    request(
        &mut connection,
        1,
        "input.pointer",
        json!({"window": "main", "x": 5, "y": 6, "phase": "down"}),
    );
    drop(connection);
    assert!(served.page.await_total(2), "the close released no press");
    notifier.notify_watchers("host.buttons", &raw(&json!({"mask": 1})).unwrap());
    notifier.notify_watchers("host.buttons", &raw(&json!({"mask": 0})).unwrap());
    assert!(
        served.page.await_total(3),
        "the release was not delivered after mask 0"
    );
    served.finish();
}

// A release refused with 1011 is delivered at the next end of a press, and not at an input that ends no press.
// contract: endpoint.input.close-releases-presses
#[test]
fn a_release_refused_for_another_pointer_is_delivered_at_the_end_of_a_press() {
    let second = |phase: &str| json!({"pointer": "second", "x": 0, "y": 0, "phase": phase});
    let served = serve_page(
        "test-press-pointer-held",
        vec![
            exchange(
                "input.pointer",
                main_pointer("down", json!(7), json!(8)),
                Value::Null,
            ),
            refused_exchange(
                "input.pointer",
                main_release(7.0, 8.0),
                endpoint::POINTER_HELD,
                "another pointer holds its press",
            ),
            // A move of the other pointer ends no press, so the refused release is not delivered before it.
            exchange("input.pointer", second("move"), Value::Null),
            // The up of the other pointer ends a press, which lifts the refusal.
            exchange("input.pointer", second("up"), Value::Null),
            exchange("input.pointer", main_release(7.0, 8.0), Value::Null),
        ],
    );
    let mut owner = served.open();
    let mut other = served.open();
    request(
        &mut owner,
        1,
        "input.pointer",
        json!({"window": "main", "x": 7, "y": 8, "phase": "down"}),
    );
    drop(owner);
    assert!(served.page.await_total(2), "the close released no press");
    let second = |phase: &str| json!({"window": "main", "pointer": "second", "x": 0, "y": 0, "phase": phase});
    request(&mut other, 1, "input.pointer", second("move"));
    request(&mut other, 2, "input.pointer", second("up"));
    served.finish();
}
