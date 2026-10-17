//! Checks the files of the event writer of the tool (docs/spec/logging.md#files): the levels error, warn and info go to
//! logs/sok-<boot>.jsonl and debug and trace go to logs/sok-<boot>.debug.jsonl, which exists once the first such event is
//! written, and seq runs across both files.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use soksak_sok::event_log::{EventLog, Level};

/// Removes the configuration folder of a test when the test ends.
struct Config(PathBuf);

impl Config {
    fn new(label: &str) -> Config {
        let path = std::env::temp_dir().join(format!("sok-channels{}-{label}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        Config(path)
    }
}

impl Drop for Config {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            panic!("{}: {error}", self.0.display());
        }
    }
}

fn read(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn debug_path_of(log: &EventLog) -> PathBuf {
    let main = log.path().to_string_lossy().into_owned();
    PathBuf::from(format!(
        "{}.debug.jsonl",
        main.strip_suffix(".jsonl").unwrap()
    ))
}

// contract: cli.log.splits-files-by-level
mod support;

#[test]
fn the_tool_stores_debug_and_trace_events_in_the_debug_file() {
    let config = Config::new("split");
    support::store_every_level(&config.0);
    let log = soksak_sok::start_tool_event_log(&config.0).unwrap();
    for level in [
        Level::Debug,
        Level::Warn,
        Level::Trace,
        Level::Info,
        Level::Error,
    ] {
        assert!(log.emit(level, "sok.command", &json!({"name": "x"})));
    }
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let levels = |events: &[Value]| -> String {
        events
            .iter()
            .filter(|event| event["event"] == "sok.command")
            .map(|event| event["level"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
            .join(",")
    };
    let main = read(log.path());
    let debug = read(&debug_path_of(&log));
    assert_eq!(levels(&main), "warn,info,error");
    assert_eq!(levels(&debug), "debug,trace");
    assert_eq!(debug[0]["event"], "log.open");
    assert_eq!(debug[0]["class"], "lifecycle");
    let mut seqs: Vec<u64> = main
        .iter()
        .chain(debug.iter())
        .map(|event| event["seq"].as_u64().unwrap())
        .collect();
    seqs.sort_unstable();
    assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());
}

// contract: cli.log.splits-files-by-level
#[test]
fn a_run_of_the_tool_without_a_debug_event_leaves_no_debug_file() {
    let config = Config::new("nodebug");
    let log = soksak_sok::start_tool_event_log(&config.0).unwrap();
    log.emit(Level::Info, "sok.command", &json!({"name": "x"}));
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    assert!(!debug_path_of(&log).exists());
}

/// A value that JSON cannot serialize: the writer refuses the event and counts it.
struct Unserializable;

impl serde::Serialize for Unserializable {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom("a value that JSON cannot carry"))
    }
}

// contract: cli.log.records-a-refused-event-as-log-dropped
#[test]
fn a_loss_of_the_tool_names_the_channel_of_the_refused_events() {
    let config = Config::new("loss");
    support::store_every_level(&config.0);
    let log = soksak_sok::start_tool_event_log(&config.0).unwrap();
    log.emit(Level::Debug, "sok.command", &json!({"name": "first"}));
    assert!(!log.emit(Level::Debug, "sok.command", &Unserializable));
    assert!(!log.emit(Level::Info, "sok.command", &Unserializable));
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    let mut channels: BTreeMap<String, u64> = BTreeMap::new();
    for path in [log.path().to_path_buf(), debug_path_of(&log)] {
        for event in read(&path) {
            if event["event"] == "log.dropped" {
                *channels
                    .entry(event["fields"]["channel"].as_str().unwrap().to_string())
                    .or_default() += event["fields"]["count"].as_u64().unwrap();
            }
        }
    }
    assert_eq!(channels.len(), 2, "{channels:?}");
    assert_eq!(channels["other"], 1);
    assert_eq!(channels["debug"], 1);
}
