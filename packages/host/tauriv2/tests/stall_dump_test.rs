//! The stall dumps: `diagnostics.stall.dump` stores the path of a dump as an event and names the position `(boot, seq)` of the
//! line. The same cases run in the Go host.
#![cfg(feature = "diagnostics")]

#[path = "support/records.rs"]
mod records;

use std::fs;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Value, json};
use soksak_host_tauriv2::event_record::use_host_event_log;
use soksak_host_tauriv2::stall_dump::{emit_stall_dump, parse_stall_dump};

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn parse(text: &str) -> Result<String, (i64, String)> {
    let params = serde_json::from_str::<Value>(text).unwrap();
    parse_stall_dump(params.as_object().unwrap()).map_err(|failure| (failure.code, failure.message))
}

// contract: diagnostics.stall-dump.params-validate
#[test]
fn a_stall_dump_names_an_existing_file_by_its_absolute_path() {
    let directory = tempfile::tempdir().unwrap();
    let dump = directory.path().join("stall-10-7.txt");
    fs::write(&dump, "Sampling process 10").unwrap();
    let path = dump.to_str().unwrap();
    assert_eq!(
        parse(&json!({"window": "w", "path": path}).to_string()),
        Ok(path.to_string())
    );
    let absent = directory.path().join("absent.txt");
    for (text, message) in [
        (
            r#"{"window":"w"}"#.to_string(),
            "path must be a non-empty string".to_string(),
        ),
        (
            r#"{"window":"w","path":""}"#.to_string(),
            "path must be a non-empty string".to_string(),
        ),
        (
            r#"{"window":"w","path":7}"#.to_string(),
            "path must be a non-empty string".to_string(),
        ),
        (
            r#"{"window":"w","path":"stall-10-7.txt"}"#.to_string(),
            "path must be absolute".to_string(),
        ),
        (
            json!({"window": "w", "path": absent.to_str().unwrap()}).to_string(),
            format!("path does not name a file: {}", absent.display()),
        ),
    ] {
        assert_eq!(parse(&text), Err((-32602, message)), "{text}");
    }
}

// contract: diagnostics.stall-dump.event-carries-path
#[test]
fn a_stall_dump_is_an_event_and_the_reply_names_its_position() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let config = tempfile::tempdir().unwrap();
    let log = records::start_writer(config.path());
    let (boot, seq) = emit_stall_dump("/x/logs/stall-10-7.txt", Duration::from_secs(5)).unwrap();
    log.flush(Duration::from_secs(5)).unwrap();
    let events: Vec<Value> = records::read_events(log.path())
        .into_iter()
        .filter(|event| event["event"] == "host.stall.dump")
        .collect();
    use_host_event_log(None);
    assert_eq!(boot, log.boot());
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["seq"], json!(seq));
    assert_eq!(events[0]["level"], "warn");
    assert_eq!(
        events[0]["fields"],
        json!({"path": "/x/logs/stall-10-7.txt"})
    );
}
