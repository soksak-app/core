//! Helpers of the tests that read the records of the host (docs/spec/logging.md#writers): they attach a writer of events to
//! the records, and they render the record events as the lines of the text form `<time> <level> <layer> <place>: <text>`.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use serde_json::Value;
use soksak_host_tauriv2::application_log::entry_line;
use soksak_host_tauriv2::event_log::EventLog;
use soksak_host_tauriv2::event_record::use_host_event_log;

/// Starts the writer of the host in `logs/` of `config` and makes it the writer of the records.
pub fn start_writer(config: &Path) -> Arc<EventLog> {
    let log = Arc::new(EventLog::start_host(config).unwrap());
    use_host_event_log(Some(Arc::clone(&log)));
    log
}

/// The events of an event log file.
pub fn read_events(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// The only host event log under the logs folder of a configuration folder.
pub fn event_log_path(config: &Path) -> PathBuf {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(config.join("logs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("host-") && name.ends_with(".jsonl"))
        })
        .collect();
    assert_eq!(paths.len(), 1, "event logs {paths:?}");
    paths.remove(0)
}

/// The record events of `events` as lines of the text form, one per line, each with its own time.
pub fn text_of(events: &[Value]) -> String {
    let mut text = String::new();
    for event in events {
        let name = event["event"].as_str().unwrap_or_default();
        let parts: Vec<&str> = name.split('.').collect();
        if parts.len() != 3 || parts[1] != "record" {
            continue;
        }
        let at = UNIX_EPOCH + Duration::from_micros(event["ts_us"].as_u64().unwrap());
        let stamp = soksak_host_tauriv2::performance::timestamp(at).unwrap();
        let place = event["fields"]["where"].as_str().unwrap();
        let line = entry_line(
            parts[2],
            parts[0],
            place,
            event["fields"]["text"].as_str().unwrap(),
        );
        text.push_str(&format!("{stamp} {line}\n"));
    }
    text
}

/// The records of the host written to the event log of `config`, as lines of the text form, after the writer flushed.
pub fn records_text(config: &Path, log: &EventLog) -> String {
    log.flush(Duration::from_secs(5)).unwrap();
    text_of(&read_events(&event_log_path(config)))
}

/// Runs `body` with a writer attached, then prints the records it wrote to the standard error as lines of the text form, so
/// a parent process that ran this test as a child reads them.
pub fn capturing(body: impl FnOnce()) {
    let directory = tempfile::tempdir().unwrap();
    let log = start_writer(directory.path());
    body();
    let text = records_text(directory.path(), &log);
    use_host_event_log(None);
    eprint!("{text}");
}

/// The raw standard error of the run, from the only stderr file under the logs folder of a configuration folder.
pub fn standard_error_text(config: &Path) -> String {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(config.join("logs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "stderr")
        })
        .collect();
    assert_eq!(paths.len(), 1, "stderr files {paths:?}");
    std::fs::read_to_string(paths.remove(0)).unwrap()
}
