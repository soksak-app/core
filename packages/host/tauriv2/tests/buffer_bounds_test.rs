//! The bounds of the buffers of the host (docs/spec/logging.md#bounds): each buffer holds at most a stated number of messages
//! and bytes, a message beyond the bound is refused with an error, and the loss is the event `host.buffer.dropped`. The same
//! cases run in the Go host.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use serde_json::value::RawValue;
use soksak_host_tauriv2::event_log::{EventLog, Options};
use soksak_host_tauriv2::event_record::{emit_host, use_host_event_log};
use soksak_host_tauriv2::exposure::Relay;
use soksak_host_tauriv2::sidecars::{Failure, Message, Owner, SidecarDeclaration, Sidecars};

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

const ECHO: &str = "@fixture/sidecar-echo";

#[derive(Clone)]
struct FakeOwner {
    root: String,
}

impl Owner for FakeOwner {
    fn key(&self) -> String {
        "a".into()
    }
    fn root(&self) -> Result<String, String> {
        Ok(self.root.clone())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, failure: Failure) {
        eprintln!("sidecar failure: {failure:?}");
    }
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.into()).unwrap()
}

/// A writer with a queue that holds the records of a flood of messages, attached to the records of the host.
fn roomy_writer(config: &Path) -> Arc<EventLog> {
    use_host_event_log(None);
    let log = Arc::new(
        records::start_every_level(Options {
            directory: config.join("logs"),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 1 << 16,
            queue_bytes: 64 << 20,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    );
    use_host_event_log(Some(Arc::clone(&log)));
    log
}

/// A sidecar that reads nothing until it is released, with a full write queue and the surfaces s1 to s<surfaces> registered.
struct Blocked {
    sidecars: Sidecars<FakeOwner>,
    fifo: std::path::PathBuf,
    released: bool,
    _directory: folder::Folder,
}

impl Blocked {
    fn new(root: &str, surfaces: usize) -> (Blocked, FakeOwner) {
        let directory = folder::Folder::new();
        let fifo = directory.path().join("go");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .output()
            .expect("mkfifo failed");
        assert!(made.status.success());
        let received = directory.path().join("received");
        let script = format!(
            "#!/bin/sh\nread _ < {}\nexec cat > {}\n",
            fifo.display(),
            received.display()
        );
        let program = directory.path().join("echo");
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let declarations = vec![SidecarDeclaration {
            name: ECHO.to_string(),
            folder: directory.path().to_path_buf(),
            data: br#"{"executable":"echo","protocol":1}"#.to_vec(),
            version: "0.0.1".to_string(),
        }];
        let sidecars = Sidecars::new(&declarations, directory.path().to_path_buf()).unwrap();
        let owner = FakeOwner { root: root.into() };
        for index in 1..=surfaces {
            sidecars
                .send(&owner, ECHO, &format!("s{index}"), &raw("{}"))
                .unwrap();
        }
        // A line larger than the pipe of the sidecar (64 KiB at most on macOS) keeps the writer inside its write, so it takes
        // no more lines from the queue; a surface line of a long root does the same. No event reports the start of a write,
        // so the fixture waits on the state of the writer.
        let blocker = raw(&format!(r#"{{"data":"{}"}}"#, "b".repeat(2 << 20)));
        sidecars.send(&owner, ECHO, "s1", &blocker).unwrap();
        let mut wait = 0;
        loop {
            let writing = sidecars.writing(ECHO).unwrap();
            if writing > 64 << 10 {
                break;
            }
            assert!(
                wait < 10_000,
                "the writer did not start a line over 64 KiB within 10 s (writing {writing})"
            );
            wait += 1;
            std::thread::sleep(Duration::from_millis(1));
        }
        let big = raw(&format!(r#"{{"data":"{}"}}"#, "x".repeat(20 * 1024)));
        let mut full = false;
        for _ in 0..4000 {
            if let Err(error) = sidecars.send(&owner, ECHO, "s1", &big) {
                assert!(error.contains("is not keeping up"), "{error}");
                full = true;
                break;
            }
        }
        assert!(full, "the queue never filled");
        (
            Blocked {
                sidecars,
                fifo,
                released: false,
                _directory: directory,
            },
            owner,
        )
    }

    /// Lets the sidecar read and stops it. A test that ends early does this on drop.
    fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&self.fifo)
            .unwrap();
        let _ = file.write_all(b"go\n");
        drop(file);
        self.sidecars.stop();
    }
}

impl Drop for Blocked {
    fn drop(&mut self) {
        self.release();
    }
}

fn response(name: &str, padding: usize) -> Box<RawValue> {
    raw(&format!(
        r#"{{"image":{{"consumed":{{"name":"{name}","pad":"{}"}}}}}}"#,
        "p".repeat(padding)
    ))
}

/// The fields of the events `host.buffer.dropped` that the writer stored.
fn drops(log: &EventLog, config: &Path) -> Vec<Value> {
    log.flush(Duration::from_secs(5)).unwrap();
    records::read_events(&records::event_log_path(config))
        .into_iter()
        .filter(|event| event["event"] == "host.buffer.dropped")
        .map(|event| {
            assert_eq!(event["level"], "warn", "{event}");
            assert_eq!(event["layer"], "host", "{event}");
            event["fields"].clone()
        })
        .collect()
}

// contract: buffers.sidecar-replies.bounded-by-messages
#[test]
fn the_pending_replies_of_a_sidecar_hold_at_most_1024_messages() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = roomy_writer(config.path());
    let (mut blocked, _owner) = Blocked::new("/p", 1);
    let mut refused = Vec::new();
    for _ in 0..1024 + 10 {
        if let Err(error) = blocked
            .sidecars
            .send_response(ECHO, "s1", "a", &response("a", 0))
        {
            refused.push(error.to_string());
        }
    }
    let want = format!(
        "sidecar {ECHO}: the pending replies reached 1024 messages, so a reply of surface s1 is dropped"
    );
    assert!(
        refused.len() == 10 && refused[0] == want,
        "{} replies refused, first {:?}; want 10 and {want:?}",
        refused.len(),
        refused.first()
    );
    let seen = drops(&log, config.path());
    assert_eq!(seen.len(), 10, "{seen:?}");
    for drop in &seen {
        assert_eq!(
            drop["buffer"],
            format!("sidecar {ECHO} pending replies"),
            "{drop}"
        );
        assert_eq!(drop["count"], 1, "{drop}");
        assert_eq!(drop["reason"], "the buffer holds 1024 messages", "{drop}");
        assert!(drop["bytes"].as_u64().unwrap() > 0, "{drop}");
    }
    blocked.release();
    use_host_event_log(None);
}

// contract: buffers.sidecar-replies.bounded-by-bytes
#[test]
fn the_pending_replies_of_a_sidecar_hold_at_most_four_mebibytes() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = roomy_writer(config.path());
    let (mut blocked, _owner) = Blocked::new("/p", 1);
    let mut refused = Vec::new();
    for _ in 0..4 {
        if let Err(error) = blocked
            .sidecars
            .send_response(ECHO, "s1", "a", &response("a", 3 << 19))
        {
            refused.push(error.to_string());
        }
    }
    assert!(
        refused.len() == 2
            && refused[0].ends_with(
                "the pending replies reached 4194304 bytes, so a reply of surface s1 is dropped"
            ),
        "{refused:?}"
    );
    let seen = drops(&log, config.path());
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert_eq!(seen[0]["reason"], "the buffer holds 4194304 bytes");
    assert_eq!(seen[0]["count"], 1);
    assert!(seen[0]["bytes"].as_u64().unwrap() >= 3 << 19);
    blocked.release();
    use_host_event_log(None);
}

// contract: buffers.sidecar-closes.bounded-and-forgotten
#[test]
fn a_pending_close_beyond_the_bound_is_dropped_and_the_surface_is_not_waited_for() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = roomy_writer(config.path());
    // A long project root makes each close message large, so the bound in bytes is reached with few surfaces.
    let root = format!("/{}", "r".repeat(200 << 10));
    let (mut blocked, owner) = Blocked::new(&root, 30);
    blocked.sidecars.retain(&owner, &|_| false).unwrap();
    let seen = drops(&log, config.path());
    assert!(!seen.is_empty(), "no close was dropped");
    for drop in &seen {
        assert_eq!(
            drop["buffer"],
            format!("sidecar {ECHO} pending closes"),
            "{drop}"
        );
        assert_eq!(drop["count"], 1, "{drop}");
        assert_eq!(drop["reason"], "the buffer holds 4194304 bytes", "{drop}");
    }
    let waiting = blocked.sidecars.closing().len();
    assert_eq!(
        waiting,
        30 - seen.len(),
        "{waiting} surfaces wait for a reply and {} closes were dropped; want 30 in all",
        seen.len()
    );
    blocked.release();
    use_host_event_log(None);
}

// contract: buffers.relay-expired.bounded-and-counted
#[test]
fn the_relay_remembers_at_most_256_expired_requests_and_counts_the_ones_it_forgets() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = roomy_writer(config.path());
    let relay = Relay::default();
    for _ in 0..256 + 5 {
        let outcome = relay.request("doc", Some(Duration::from_millis(1)), |_| Ok(()));
        assert!(
            outcome.is_err(),
            "a request without a reply did not time out"
        );
    }
    let seen = drops(&log, config.path());
    assert_eq!(seen.len(), 5, "{seen:?}");
    for drop in &seen {
        assert_eq!(drop["buffer"], "relay expired requests", "{drop}");
        assert_eq!(drop["count"], 1, "{drop}");
        assert_eq!(drop["bytes"], 0, "{drop}");
        assert_eq!(drop["reason"], "the buffer holds 256 requests", "{drop}");
    }
    // The five oldest are forgotten, so a late reply to the first request has no matching request; the newest is remembered.
    let late = |id: u64| relay.reply("doc", &raw(&format!(r#"{{"id":{id},"result":null}}"#)));
    assert_eq!(
        late(1).unwrap_err(),
        "exposure reply 1 has no matching request"
    );
    assert!(
        late(261)
            .unwrap_err()
            .contains("its request timed out after 1 ms"),
        "the newest expired request is forgotten"
    );
    use_host_event_log(None);
}

// contract: log.writer.event-over-size-bound-is-cut
#[test]
fn an_event_over_the_size_bound_is_stored_cut_with_its_original_size() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = roomy_writer(config.path());
    // The text reaches the writer whole, as the fields of a relayed event do; a producer that serializes a value stops at the
    // bound before it (bounds.producer.fields-are-cut-while-serialized).
    let oversize =
        RawValue::from_string(serde_json::json!({"text": "é".repeat(3 << 20)}).to_string())
            .unwrap();
    log.emit_relayed(soksak_host_tauriv2::event_log::RelayedEvent {
        ts_us: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64,
        mono_ns: 1,
        layer: "host".into(),
        page: None,
        level: soksak_host_tauriv2::event_log::Level::Info,
        event: "host.test.oversize".into(),
        cids: Vec::new(),
        fields: soksak_host_tauriv2::bounds::Fields::whole(oversize),
    })
    .unwrap();
    emit_host(
        soksak_host_tauriv2::event_log::Level::Info,
        "host.test.small",
        serde_json::json!({"text": "kept"}),
    );
    log.flush(Duration::from_secs(5)).unwrap();
    let events = records::read_events(&records::event_log_path(config.path()));
    let find = |name: &str| {
        events
            .iter()
            .find(|event| event["event"] == name)
            .unwrap_or_else(|| panic!("no event {name} in {events:?}"))
            .clone()
    };
    let (big, small) = (find("host.test.oversize"), find("host.test.small"));
    let original = r#"{"text":""#.len() + 2 * (3 << 20) + r#""}"#.len();
    let head = big["fields"]["head"].as_str().unwrap();
    assert_eq!(big["truncated"], original, "{big:.200}");
    assert!(
        head.len() <= 4096 && head.len() >= 4093 && head.starts_with(r#"{"text":"é"#),
        "head of {} bytes",
        head.len()
    );
    assert_eq!(big["fields"].as_object().unwrap().len(), 1);
    assert!(small.get("truncated").is_none(), "{small}");
    assert_eq!(small["fields"]["text"], "kept");
    assert_eq!(small["seq"].as_u64(), big["seq"].as_u64().map(|n| n + 1));
    use_host_event_log(None);
}

/// The fields of the events `host.sidecar.write_wait` that the writer stored.
fn write_waits(log: &EventLog, config: &Path) -> Vec<Value> {
    log.flush(Duration::from_secs(5)).unwrap();
    records::read_events(&records::event_log_path(config))
        .into_iter()
        .filter(|event| event["event"] == "host.sidecar.write_wait")
        .map(|event| {
            assert_eq!(event["level"], "info", "{event}");
            assert_eq!(event["layer"], "host", "{event}");
            event["fields"].clone()
        })
        .collect()
}

// contract: sidecars.write.wait-is-recorded
#[test]
fn a_line_that_waits_in_the_write_queue_of_a_sidecar_is_recorded() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = roomy_writer(config.path());
    let (mut blocked, _owner) = Blocked::new("/p", 1);
    // The sidecar reads nothing, so the queued lines wait at least this long before the release lets the writer go on.
    std::thread::sleep(Duration::from_millis(1100));
    blocked.release();
    let waits = write_waits(&log, config.path());
    let mut queued = 0;
    let mut blocked_writes = 0;
    for wait in &waits {
        assert!(
            wait["name"] == ECHO && wait["bytes"].as_u64().unwrap() > 0,
            "write wait {wait} does not name {ECHO} with the bytes of the line"
        );
        if wait["queued_us"].as_u64().unwrap() >= 1_000_000 {
            queued += 1;
        }
        if wait["write_us"].as_u64().unwrap() >= 1_000_000 {
            blocked_writes += 1;
        }
    }
    assert!(
        queued > 0 && blocked_writes == 1,
        "{queued} waits of a second in the queue and {blocked_writes} blocked writes, want some and 1: {waits:?}"
    );
    use_host_event_log(None);
}

// contract: sidecars.write.wait-is-recorded
#[test]
fn a_line_that_is_written_at_once_stores_no_write_wait() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = roomy_writer(config.path());
    let directory = folder::Folder::new();
    let program = directory.path().join("echo");
    std::fs::write(&program, "#!/bin/sh\nexec cat > /dev/null\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let declarations = vec![SidecarDeclaration {
        name: ECHO.to_string(),
        folder: directory.path().to_path_buf(),
        data: br#"{"executable":"echo","protocol":1}"#.to_vec(),
        version: "0.0.1".to_string(),
    }];
    let sidecars = Sidecars::new(&declarations, directory.path().to_path_buf()).unwrap();
    let owner = FakeOwner { root: "/p".into() };
    for _ in 0..10 {
        sidecars.send(&owner, ECHO, "s1", &raw("{}")).unwrap();
    }
    sidecars.stop();
    let waits = write_waits(&log, config.path());
    assert!(
        waits.is_empty(),
        "lines written at once stored write waits: {waits:?}"
    );
    use_host_event_log(None);
}
