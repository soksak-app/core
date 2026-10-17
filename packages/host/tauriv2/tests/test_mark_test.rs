//! The marks of a test run: `diagnostics.test.mark` stores the start and the end of a test as events and names the position
//! `(boot, seq)` of the line. The same cases run in the Go host.
#![cfg(feature = "diagnostics")]

#[path = "support/records.rs"]
mod records;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use soksak_host_tauriv2::event_log::Options;
use soksak_host_tauriv2::event_record::use_host_event_log;
use soksak_host_tauriv2::test_mark::{TestMark, emit_test_mark, parse_test_mark};

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn mark(kind: &str, result: &str) -> TestMark {
    TestMark {
        kind: kind.into(),
        name: "n".into(),
        run: "r".into(),
        result: result.into(),
    }
}

fn parse(text: &str) -> Result<TestMark, (i64, String)> {
    let params = serde_json::from_str::<Value>(text).unwrap();
    parse_test_mark(params.as_object().unwrap()).map_err(|failure| (failure.code, failure.message))
}

// contract: diagnostics.test-mark.params-validate
#[test]
fn a_test_mark_accepts_only_a_start_or_an_end_with_its_result() {
    assert_eq!(
        parse(r#"{"window":"w","kind":"start","name":"n","run":"r"}"#),
        Ok(mark("start", ""))
    );
    assert_eq!(
        parse(r#"{"window":"w","kind":"end","name":"n","run":"r","result":"pass"}"#),
        Ok(mark("end", "pass"))
    );
    assert_eq!(
        parse(r#"{"window":"w","kind":"end","name":"n","run":"r","result":"skip"}"#),
        Ok(mark("end", "skip"))
    );
    for (text, message) in [
        (
            r#"{"window":"w","name":"n","run":"r"}"#,
            "kind must be start or end",
        ),
        (
            r#"{"window":"w","kind":"stop","name":"n","run":"r"}"#,
            "kind must be start or end",
        ),
        (
            r#"{"window":"w","kind":"start","name":"","run":"r"}"#,
            "name must be a non-empty string",
        ),
        (
            r#"{"window":"w","kind":"start","name":7,"run":"r"}"#,
            "name must be a non-empty string",
        ),
        (
            r#"{"window":"w","kind":"start","name":"n"}"#,
            "run must be a non-empty string",
        ),
        (
            r#"{"window":"w","kind":"end","name":"n","run":"r"}"#,
            "result must be pass, fail or skip",
        ),
        (
            r#"{"window":"w","kind":"end","name":"n","run":"r","result":"PASS"}"#,
            "result must be pass, fail or skip",
        ),
        (
            r#"{"window":"w","kind":"start","name":"n","run":"r","result":"pass"}"#,
            "result is only for an end mark",
        ),
    ] {
        assert_eq!(parse(text), Err((-32602, message.to_string())), "{text}");
    }
}

// contract: diagnostics.test-mark.event-carries-position
#[test]
fn a_test_mark_is_an_event_and_the_reply_names_its_position() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        records::start_every_level(Options {
            directory: directory.path().to_path_buf(),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 64,
            queue_bytes: 64 << 10,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    );
    use_host_event_log(Some(log.clone()));
    let (boot, start) = emit_test_mark(&mark("start", ""), Duration::from_secs(5)).unwrap();
    let (boot_end, end) = emit_test_mark(&mark("end", "fail"), Duration::from_secs(5)).unwrap();
    assert_eq!(
        (boot.as_str(), boot_end.as_str(), end),
        ("b1", "b1", start + 1)
    );
    let lines: Vec<Value> = fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    use_host_event_log(None);
    for (seq, event, fields) in [
        (start, "host.test.start", json!({"name": "n", "run": "r"})),
        (
            end,
            "host.test.end",
            json!({"name": "n", "run": "r", "result": "fail"}),
        ),
    ] {
        let line = &lines[seq as usize - 1];
        assert_eq!(line["seq"], json!(seq));
        assert_eq!(line["event"], json!(event));
        assert_eq!(line["layer"], json!("host"));
        assert_eq!(line["level"], json!("info"));
        assert_eq!(line["fields"], fields);
    }
}

// contract: diagnostics.test-mark.needs-the-event-log
#[test]
fn a_test_mark_without_an_event_log_is_an_error() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    use_host_event_log(None);
    assert_eq!(
        emit_test_mark(&mark("start", ""), Duration::from_secs(1)),
        Err("the event log of the host is not attached".to_string())
    );
}
