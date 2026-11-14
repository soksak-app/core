//! The gate at the producers of the host (docs/spec/logging.md#classes-and-policy): a call that the policy does not store is not built
//! into an event, and the writer counts it; a failed call is a warning and still passes a policy that stores the class from warn on.
//! The same cases run in the Go host.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/platform/platform.rs"]
mod endpoint_client;

#[path = "support/records.rs"]
mod records;
#[path = "support/tier_service.rs"]
mod tier_service;

use tier_service::TierService;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use soksak_host::binding_record::BindingCall;
use soksak_host::endpoint::{self, Endpoint};
use soksak_host::event_log::{self, EventLog};
use soksak_host::event_record::use_host_event_log;
use soksak_host::framework::InvokeBody;
use soksak_host::log_policy::LogPolicy;

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn narrow_calls(log: &EventLog, level: &str) {
    let text = format!(
        r#"{{"schema":1,"classes":{{"lifecycle":"trace","input":"trace","call":"{level}","io":"trace","frame":"trace"}}}}"#
    );
    log.set_policy(LogPolicy::parse("policy", text.as_bytes()).unwrap(), "file");
}

fn payload(value: &Value) -> InvokeBody<'_> {
    InvokeBody::Json(value)
}

fn gated_counts(events: &[Value]) -> BTreeMap<String, u64> {
    let mut counts = BTreeMap::new();
    for event in events.iter().filter(|event| event["event"] == "log.gated") {
        let fields = &event["fields"];
        *counts
            .entry(format!(
                "{}/{}",
                fields["class"].as_str().unwrap(),
                fields["level"].as_str().unwrap()
            ))
            .or_default() += fields["count"].as_u64().unwrap();
    }
    counts
}

// contract: log.policy.binding-call-is-gated
#[test]
fn a_binding_call_that_the_policy_does_not_store_is_counted_and_a_failed_one_is_stored() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = records::start_writer(config.path());
    narrow_calls(&log, "warn");
    for _ in 0..3 {
        BindingCall::begin("echo", &payload(&json!({"value": {"a": 1}})))
            .finish(&["value"], &Ok::<(), String>(()));
    }
    BindingCall::begin("fail", &payload(&json!({"value": 1}))).finish(
        &["value"],
        &Err::<(), String>("the request is refused".into()),
    );
    log.flush().unwrap();
    let events = records::read_events(&records::event_log_path(config.path()));
    use_host_event_log(None);
    let calls: Vec<&Value> = events
        .iter()
        .filter(|event| event["event"] == "host.binding.call")
        .collect();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0]["level"], "warn");
    assert_eq!(calls[0]["fields"]["name"], "fail");
    let counts = gated_counts(&events);
    assert_eq!(counts.len(), 1, "{counts:?}");
    assert_eq!(counts["call/debug"], 3);
}

// contract: log.policy.endpoint-call-is-gated
#[test]
fn an_endpoint_request_that_the_policy_does_not_store_is_counted() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = records::start_writer(config.path());
    narrow_calls(&log, "warn");
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-gate",
        Arc::new(TierService::new(&[("main", "Main")])),
    )
    .unwrap();
    endpoint.publish("main").unwrap();
    let mut connection = endpoint_client::connect(endpoint.address());
    for id in 1..=2u64 {
        endpoint::write_frame(
            &mut connection,
            &json!({"jsonrpc": "2.0", "id": id, "method": "windows.list", "params": null}),
        )
        .unwrap();
        endpoint::read_frame(&mut connection)
            .unwrap()
            .expect("the endpoint closed the connection");
    }
    endpoint.stop();
    log.flush().unwrap();
    let events = records::read_events(&records::event_log_path(config.path()));
    use_host_event_log(None);
    let stored: Vec<&Value> = events
        .iter()
        .filter(|event| event["event"] == "host.endpoint.call")
        .collect();
    assert!(stored.is_empty(), "{stored:?}");
    let counts = gated_counts(&events);
    assert_eq!(counts.len(), 1, "{counts:?}");
    assert_eq!(counts["call/debug"], 2);
}

/// The allocator of this test binary: the system allocator, which counts the allocations of each thread, so a check can ask
/// whether a call allocated.
struct Counting;

thread_local! {
    static ALLOCATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Counts an allocation of the current thread; a thread whose locals ended counts nothing.
fn count_allocation() {
    ALLOCATIONS
        .try_with(|count| count.set(count.get() + 1))
        .ok();
}

// SAFETY: every call passes its arguments to the system allocator unchanged, and the count is a thread-local cell without a
// destructor, which allocates nothing.
unsafe impl std::alloc::GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        count_allocation();
        // SAFETY: the caller holds the contract of alloc, which the system allocator takes.
        unsafe { std::alloc::GlobalAlloc::alloc(&std::alloc::System, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: std::alloc::Layout) -> *mut u8 {
        count_allocation();
        // SAFETY: the caller holds the contract of alloc_zeroed, which the system allocator takes.
        unsafe { std::alloc::GlobalAlloc::alloc_zeroed(&std::alloc::System, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: std::alloc::Layout, size: usize) -> *mut u8 {
        count_allocation();
        // SAFETY: the caller holds the contract of realloc for a block of the system allocator.
        unsafe { std::alloc::GlobalAlloc::realloc(&std::alloc::System, ptr, layout, size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
        // SAFETY: the caller holds the contract of dealloc for a block of the system allocator.
        unsafe { std::alloc::GlobalAlloc::dealloc(&std::alloc::System, ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The allocations of the current thread during `rounds` calls of `call`.
fn allocations(rounds: u32, mut call: impl FnMut()) -> usize {
    let before = ALLOCATIONS.with(std::cell::Cell::get);
    for _ in 0..rounds {
        call();
    }
    ALLOCATIONS.with(std::cell::Cell::get) - before
}

// contract: log.policy.closed-gate-costs-a-branch
#[test]
fn a_closed_gate_allocates_nothing_and_its_times_are_printed() {
    use soksak_host::event_log::{Level as L, Options};
    use soksak_host::log_policy::Class;
    let directory = folder::Folder::new();
    let log = event_log::start(Options {
        directory: directory.path().to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 1 << 16,
        queue_bytes: 1 << 26,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1 << 30,
        pull: None,
        wake: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: 1 << 40,
    })
    .unwrap();
    records::store_every_level(&log);
    const ROUNDS: u32 = 20_000;
    let fields =
        json!({"name": "echo", "args": "[{\"a\":1}]", "micros": 1, "ok": true, "truncated": false});
    let enqueue = || {
        log.emit(L::Debug, "host.binding.call", &fields);
    };
    let question = || assert!(!log.gate(Class::Call, L::Debug), "the gate is open");
    // An enqueue with the gate open builds the owned event; the question of a closed gate is a branch and an atomic add, which
    // allocate nothing.
    let enqueued = allocations(100, enqueue);
    let started = std::time::Instant::now();
    for _ in 0..ROUNDS {
        enqueue();
    }
    let open_each = started.elapsed() / ROUNDS;
    narrow_calls(&log, "warn");
    let asked = allocations(100, question);
    let started = std::time::Instant::now();
    for _ in 0..ROUNDS {
        question();
    }
    let closed_each = started.elapsed() / ROUNDS;
    // The times are a measurement, which the check prints and does not judge (the numbers on a quiet machine are recorded
    // under F160.17).
    println!(
        "an enqueue with the gate open: {open_each:?} and {enqueued} allocations in 100; the question of a closed gate: {closed_each:?} and {asked} allocations in 100 ({ROUNDS} rounds)"
    );
    assert_eq!(
        asked, 0,
        "the allocations of 100 questions of a closed gate"
    );
    assert!(
        enqueued > 0,
        "an enqueue with the gate open allocated nothing, so the allocations tell nothing of the closed gate"
    );
}

// contract: log.policy.producer-builds-nothing-for-a-closed-gate
#[test]
fn a_closed_gate_builds_no_fields_at_the_producers_of_the_host() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = records::start_writer(config.path());
    narrow_calls(&log, "warn");
    // The observation of the trace builds its fields only for a gate that is open.
    soksak_host::performance::command(json!({"action": "on"})).unwrap();
    let built = std::cell::Cell::new(0);
    soksak_host::performance::observe("host", || {
        built.set(built.get() + 1);
        json!({"event": "probe"})
    });
    soksak_host::performance::command(json!({"action": "off"})).unwrap();
    use_host_event_log(None);
    assert_eq!(
        built.get(),
        0,
        "the fields of an observation were built although the policy does not store the class call at debug"
    );
}

// contract: log.policy.counts-each-second
#[test]
fn the_counts_of_a_closed_gate_are_reported_each_second_and_at_a_flush() {
    use soksak_host::event_log::{Level as L, Options};
    let directory = folder::Folder::new();
    let log = event_log::start(Options {
        directory: directory.path().to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 1 << 12,
        queue_bytes: 1 << 22,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1 << 30,
        pull: None,
        wake: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: 1 << 40,
    })
    .unwrap();
    records::store_every_level(&log);
    narrow_calls(&log, "warn");
    // The least time between two reports is an input of the check: an hour, so every batch below comes before it, whatever
    // time the batches take.
    log.set_gated_report_interval(Duration::from_secs(3600));
    let (sleeps, slept) = mpsc::sync_channel::<()>(1);
    log.set_on_sleep(Box::new(move |_count_held| {
        // A full channel already tells of a sleep, and a check that ended hears none.
        sleeps.try_send(()).ok();
    }));
    let fields = json!({"name": "echo", "args": "[]", "micros": 1, "ok": true, "truncated": false});
    let path = log.path().to_path_buf();
    let mut emitted = 0u64;
    // Each round refuses an event and stores a marker, and the round ends when the writer wrote the marker and slept, so the
    // refused events cross 20 written batches.
    for round in 0..20 {
        log.emit(L::Debug, "host.binding.call", &fields);
        emitted += 1;
        let marker = format!("marker-{round}");
        log.emit(
            L::Warn,
            "host.binding.call",
            &json!({"name": marker, "args": "[]", "micros": 1, "ok": false, "truncated": false}),
        );
        await_marker(&path, &slept, &marker);
    }
    let before = records::read_events(&path);
    let reports = before
        .iter()
        .filter(|event| event["event"] == "log.gated")
        .count();
    assert_eq!(
        reports, 0,
        "{reports} log.gated events before the least time between two reports passed"
    );
    log.flush().unwrap();
    let counts = gated_counts(&records::read_events(&path));
    assert_eq!(counts.get("call/debug"), Some(&emitted), "{counts:?}");
}

/// Returns when a writer that slept has written the event whose name field is `marker`: the writer sleeps only when it wrote
/// everything that was queued.
fn await_marker(path: &std::path::Path, slept: &mpsc::Receiver<()>, marker: &str) {
    loop {
        slept
            .recv()
            .unwrap_or_else(|_| panic!("the writer did not sleep after the marker {marker}"));
        if records::read_events(path)
            .iter()
            .any(|event| event["fields"]["name"] == marker)
        {
            return;
        }
    }
}
