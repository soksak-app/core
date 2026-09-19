//! Flush Tests for Tauri Sidecars
//!
//! These tests verify that the buffering mechanism works when the write queue is full.
//! The write thread properly flushes buffered messages before blocking on recv().

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;

use serde_json::value::RawValue;
use soksak_host_tauriv2::sidecars::{Message, Owner, Sidecars};

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

fn create(files: &Files, directory: &std::path::Path) -> Result<Sidecars<FakeOwner>, String> {
    let read = |path: &str| files.get(path).map(|text| text.as_bytes().to_vec());
    Sidecars::new(&read, directory.to_path_buf())
}

const ECHO: &str = "@fixture/sidecar-echo";

#[test]
fn every_pending_reply_is_flushed_after_the_queue_drains() {
    let directory = tempfile::tempdir().unwrap();
    let fifo_path = directory.path().join("go");
    let fifo_str = fifo_path.display().to_string();

    // mkfifo를 호출하여 FIFO 생성
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
        &files(r#"{"executable":"build/echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();

    let (owner, _events) = owner("a", "/p");

    // Register surfaces first
    for s in &["s1", "s2", "s3"] {
        sidecars.send(&owner, ECHO, s, &raw(r#"{}"#)).unwrap();
    }

    // Queue large messages to fill the queue
    let big = raw(&format!(r#"{{"data":"{}"}}"#, "x".repeat(20 * 1024)));
    let mut full = false;
    for _i in 0..4000 {
        if sidecars.send(&owner, ECHO, "s1", &big).is_err() {
            full = true;
            break;
        }
    }
    assert!(full, "the queue never filled");

    // Send responses when queue is full
    for (i, name) in ["a", "b", "c"].iter().enumerate() {
        let response_json = serde_json::json!({
            "image": {
                "consumed": {
                    "name": name,
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

    // Send same image "a" again with sequence 4 (should replace seq 2)
    let response_json = serde_json::json!({
        "image": {
            "consumed": {
                "name": "a",
                "sequence": 4
            }
        }
    });
    let response_str = serde_json::to_string(&response_json).unwrap();
    let response_body = RawValue::from_string(response_str).unwrap();
    sidecars
        .send_response(ECHO, "s1", "a", &response_body)
        .unwrap();

    // Close surfaces
    sidecars
        .retain(&owner, &|s| !matches!(s, "s2" | "s3"))
        .expect("retain");

    // Release the sidecar from FIFO
    let fifo_file = std::fs::OpenOptions::new()
        .write(true)
        .open(&fifo_path)
        .unwrap();
    let mut fifo_file = fifo_file;
    let _ = fifo_file.write_all(b"go\n");
    drop(fifo_file);

    sidecars.stop();

    let data = std::fs::read_to_string(received).unwrap();

    // Verify that all three responses were sent
    for want in &[r#""name":"a""#, r#""name":"b""#, r#""name":"c""#] {
        assert!(
            data.contains(want),
            "reply {} never reached the sidecar",
            want
        );
    }

    // Verify closes were sent
    for s in &[
        r#""surface":"s2","closed":true"#,
        r#""surface":"s3","closed":true"#,
    ] {
        assert!(data.contains(s), "close {} never reached the sidecar", s);
    }

    // Verify same image a with seq 1, 2 were replaced, only seq 4 reached
    let a_seq1_pattern = r#""name":"a","sequence":1"#;
    let a_seq2_pattern = r#""name":"a","sequence":2"#;
    let a_seq4_pattern = r#""name":"a","sequence":4"#;

    assert!(
        !data.contains(a_seq1_pattern),
        "image a with sequence 1 should have been replaced"
    );
    assert!(
        !data.contains(a_seq2_pattern),
        "image a with sequence 2 should have been replaced"
    );

    let count = data.matches(a_seq4_pattern).count();
    assert!(
        count == 1,
        "image a with sequence 4 should appear exactly once, appeared {} times",
        count
    );

    // Verify order: closes and replies came after the queued bodies
    let last_body = data.rfind(r#""data":""#);
    for want in &[r#""name":"a""#, r#""surface":"s2","closed":true"#] {
        if let Some(idx) = data.find(want) {
            assert!(
                last_body.is_none() || idx > last_body.unwrap(),
                "{} arrived before the queued bodies",
                want
            );
        }
    }
}

#[test]
fn order_is_correct_when_stop_flushes_buffered_messages() {
    let directory = tempfile::tempdir().unwrap();
    let fifo_path = directory.path().join("go");
    let fifo_str = fifo_path.display().to_string();

    // mkfifo를 호출하여 FIFO 생성
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
        &files(r#"{"executable":"build/echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();

    let (owner, _events) = owner("a", "/p");

    // Register surfaces
    for s in &["s1", "s2"] {
        sidecars.send(&owner, ECHO, s, &raw(r#"{}"#)).unwrap();
    }

    // Queue large messages to fill the queue
    let big = raw(&format!(r#"{{"data":"{}"}}"#, "x".repeat(20 * 1024)));
    let mut full = false;
    for _i in 0..4000 {
        if sidecars.send(&owner, ECHO, "s1", &big).is_err() {
            full = true;
            break;
        }
    }
    assert!(full, "the queue never filled");

    // Queue buffered responses
    for (i, name) in ["x", "y", "z"].iter().enumerate() {
        let response_json = serde_json::json!({
            "image": {
                "consumed": {
                    "name": name,
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

    // Release the sidecar from FIFO
    let fifo_file = std::fs::OpenOptions::new()
        .write(true)
        .open(&fifo_path)
        .unwrap();
    let mut fifo_file = fifo_file;
    let _ = fifo_file.write_all(b"go\n");
    drop(fifo_file);

    sidecars.stop();

    let data = std::fs::read_to_string(received).unwrap();

    // Verify all buffered messages were sent
    for want in &[
        r#""name":"x""#,
        r#""name":"y""#,
        r#""name":"z""#,
        r#""surface":"s2","closed":true"#,
    ] {
        assert!(data.contains(want), "buffered message {} was lost", want);
    }
}
