//! Flush tests of the Tauri sidecar.
//!
//! These tests verify that the buffering mechanism works when the write queue is full. The write thread correctly
//! flushes the buffered messages before it blocks in recv().

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

#[path = "support/records.rs"]
mod records;

use serde_json::value::RawValue;
use serde_json::Value;
use soksak_host_tauriv2::sidecars::{Failure, Message, Owner, SidecarDeclaration, Sidecars};

#[derive(Clone)]
struct FakeOwner {
    key: String,
    root: String,
    sent: std::sync::mpsc::Sender<Message>,
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

fn owner(key: &str, root: &str) -> (FakeOwner, std::sync::mpsc::Receiver<Message>) {
    let (sent, received) = std::sync::mpsc::channel();
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

fn create(files: &Files, directory: &std::path::Path) -> Result<Sidecars<FakeOwner>, String> {
    Sidecars::new(&declare(files, directory), directory.to_path_buf())
}

const ECHO: &str = "@fixture/sidecar-echo";

// contract: flush.queue.rejects-send-when-full, flush.queue.full-error-says-not-keeping-up, flush.buffer.replies-delivered-after-drain, flush.buffer.closes-delivered-after-drain, flush.buffer.consumed-acks-not-coalesced, flush.buffer.delivered-after-queued-bodies
#[test]
fn every_pending_reply_is_flushed_after_the_queue_drains() {
    every_pending_reply_scenario();
}

const FLUSH_LOG_CHILD: &str = "SOKSAK_FLUSH_LOG_CHILD";

// A close that waits for the full queue is recorded with its surface.
// contract: sidecars.close.buffered-close-is-recorded
#[test]
fn a_buffered_close_is_recorded() {
    if let Some(config) = std::env::var_os(FLUSH_LOG_CHILD) {
        soksak_host_tauriv2::application_log::start_standard_error(
            Path::new(&config),
            "com.soksak.test",
        )
        .unwrap();
        let writer = records::start_writer(Path::new(&config));
        every_pending_reply_scenario();
        writer.flush(std::time::Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_buffered_close_is_recorded",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(FLUSH_LOG_CHILD, config.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}, output {:?}",
        output.status,
        String::from_utf8_lossy(&output.stdout)
    );
    let log = records::text_of(&records::read_events(&records::event_log_path(
        config.path(),
    )));
    for surface in ["s2", "s3"] {
        let want = format!(" info host sidecar {ECHO}: close {surface}: outbox full, buffered");
        assert!(log.contains(&want), "no {want:?} in {log}");
    }
}

/// The scenario of the queue that fills, the replies and closes that wait for it, and the drain.
fn every_pending_reply_scenario() {
    let directory = tempfile::tempdir().unwrap();
    let fifo_path = directory.path().join("go");
    let fifo_str = fifo_path.display().to_string();

    // Creates a FIFO by calling mkfifo.
    let output = std::process::Command::new("mkfifo")
        .arg(&fifo_str)
        .output()
        .expect("mkfifo failed");
    if !output.status.success() {
        panic!("mkfifo failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    let received = directory.path().join("received");
    let script = format!(
        "#!/bin/sh\nread _ < {}\nexec cat > {}\n",
        fifo_str,
        received.display()
    );
    let echo_program = directory.path().join("echo");
    std::fs::write(&echo_program, script).unwrap();
    std::fs::set_permissions(&echo_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    let sidecars = create(
        &files(r#"{"executable":"echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();

    let (owner, _events) = owner("a", "/p");

    // First register the surface.
    for s in &["s1", "s2", "s3"] {
        sidecars.send(&owner, ECHO, s, &raw(r#"{}"#)).unwrap();
    }

    // Put a large message in the queue to fill the queue.
    let big = raw(&format!(r#"{{"data":"{}"}}"#, "x".repeat(20 * 1024)));
    let mut full = false;
    for _i in 0..4000 {
        if let Err(error) = sidecars.send(&owner, ECHO, "s1", &big) {
            assert!(error.contains("is not keeping up"), "{error}");
            full = true;
            break;
        }
    }
    assert!(full, "the queue never filled");

    // Send a response when the queue is full.
    for (i, name) in ["a", "b", "c"].iter().enumerate() {
        let response_json = serde_json::json!({
            "image": {
                    "consumed": {
                    "generation": 1,
                    "name": name,
                    "raster": 1,
                    "sequence": i + 1
                }
            }
        });
        let response_str = serde_json::to_string(&response_json).unwrap();
        let response_body = RawValue::from_string(response_str).unwrap();
        sidecars
            .send_response(ECHO, "s1", name, &response_body)
            .unwrap();
    }

    // Send the same image "a" again with a new immutable sequence.
    let response_json = serde_json::json!({
        "image": {
            "consumed": {
                "generation": 1,
                "name": "a",
                "raster": 1,
                "sequence": 4
            }
        }
    });
    let response_str = serde_json::to_string(&response_json).unwrap();
    let response_body = RawValue::from_string(response_str).unwrap();
    sidecars
        .send_response(ECHO, "s1", "a", &response_body)
        .unwrap();

    // Close the surface.
    sidecars
        .retain(&owner, &|s| !matches!(s, "s2" | "s3"))
        .expect("retain");

    // Release the sidecar from the FIFO.
    let fifo_file = std::fs::OpenOptions::new()
        .write(true)
        .open(&fifo_path)
        .unwrap();
    let mut fifo_file = fifo_file;
    let _ = fifo_file.write_all(b"go\n");
    drop(fifo_file);

    sidecars.stop();

    let data = std::fs::read_to_string(received).unwrap();

    // Verify that all three responses were sent.
    for want in &[r#""name":"a""#, r#""name":"b""#, r#""name":"c""#] {
        assert!(
            data.contains(want),
            "reply {} never reached the sidecar",
            want
        );
    }

    // Verify that the close was sent.
    for s in &[
        r#""surface":"s2","root":"/p","closed":true"#,
        r#""surface":"s3","root":"/p","closed":true"#,
    ] {
        assert!(data.contains(s), "close {} never reached the sidecar", s);
    }

    // Every immutable consumed ack must arrive exactly once. In particular, the new sequence of image a must not
    // replace the previous frame.
    let consumed: Vec<Value> = data
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|line| line.get("body")?.get("image")?.get("consumed").cloned())
        .collect();
    for expected in [
        serde_json::json!({"generation": 1, "name": "a", "raster": 1, "sequence": 1}),
        serde_json::json!({"generation": 1, "name": "b", "raster": 1, "sequence": 2}),
        serde_json::json!({"generation": 1, "name": "c", "raster": 1, "sequence": 3}),
        serde_json::json!({"generation": 1, "name": "a", "raster": 1, "sequence": 4}),
    ] {
        assert_eq!(
            consumed
                .iter()
                .filter(|actual| **actual == expected)
                .count(),
            1,
            "immutable consumed ack {:?} was not preserved exactly once",
            expected
        );
    }

    // Verify the order: the close and the reply came after the body that was put in the queue.
    let last_body = data.rfind(r#""data":""#).expect("no queued body arrived");
    for want in &[
        r#""name":"a""#,
        r#""surface":"s2","root":"/p","closed":true"#,
    ] {
        let idx = data
            .find(want)
            .unwrap_or_else(|| panic!("{want} did not arrive"));
        assert!(idx > last_body, "{} arrived before the queued bodies", want);
    }
}

// contract: flush.queue.rejects-send-when-full, flush.queue.full-error-says-not-keeping-up, flush.buffer.replies-delivered-after-drain, flush.buffer.closes-delivered-after-drain
#[test]
fn order_is_correct_when_stop_flushes_buffered_messages() {
    let directory = tempfile::tempdir().unwrap();
    let fifo_path = directory.path().join("go");
    let fifo_str = fifo_path.display().to_string();

    // Creates a FIFO by calling mkfifo.
    let output = std::process::Command::new("mkfifo")
        .arg(&fifo_str)
        .output()
        .expect("mkfifo failed");
    if !output.status.success() {
        panic!("mkfifo failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    let received = directory.path().join("received");
    let script = format!(
        "#!/bin/sh\nread _ < {}\nexec cat > {}\n",
        fifo_str,
        received.display()
    );
    let echo_program = directory.path().join("echo");
    std::fs::write(&echo_program, script).unwrap();
    std::fs::set_permissions(&echo_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    let sidecars = create(
        &files(r#"{"executable":"echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();

    let (owner, _events) = owner("a", "/p");

    // Register the surface.
    for s in &["s1", "s2"] {
        sidecars.send(&owner, ECHO, s, &raw(r#"{}"#)).unwrap();
    }

    // Put a large message in the queue to fill the queue.
    let big = raw(&format!(r#"{{"data":"{}"}}"#, "x".repeat(20 * 1024)));
    let mut full = false;
    for _i in 0..4000 {
        if let Err(error) = sidecars.send(&owner, ECHO, "s1", &big) {
            assert!(error.contains("is not keeping up"), "{error}");
            full = true;
            break;
        }
    }
    assert!(full, "the queue never filled");

    // Put the buffered response in the queue.
    for (i, name) in ["x", "y", "z"].iter().enumerate() {
        let response_json = serde_json::json!({
            "image": {
                "consumed": {
                    "generation": 1,
                    "name": name,
                    "raster": 1,
                    "sequence": i + 1
                }
            }
        });
        let response_str = serde_json::to_string(&response_json).unwrap();
        let response_body = RawValue::from_string(response_str).unwrap();
        sidecars
            .send_response(ECHO, "s1", name, &response_body)
            .unwrap();
    }

    sidecars.retain(&owner, &|s| s != "s2").expect("retain");

    // Release the sidecar from the FIFO.
    let fifo_file = std::fs::OpenOptions::new()
        .write(true)
        .open(&fifo_path)
        .unwrap();
    let mut fifo_file = fifo_file;
    let _ = fifo_file.write_all(b"go\n");
    drop(fifo_file);

    sidecars.stop();

    let data = std::fs::read_to_string(received).unwrap();

    // Verify that all buffered messages were sent.
    for want in &[
        r#""name":"x""#,
        r#""name":"y""#,
        r#""name":"z""#,
        r#""surface":"s2","root":"/p","closed":true"#,
    ] {
        assert!(data.contains(want), "buffered message {} was lost", want);
    }
}
