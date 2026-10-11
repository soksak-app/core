//! The files of the event writer (docs/spec/logging.md#files): the levels error, warn and info go to the main file, debug and
//! trace go to the debug file, each file rotates on its own and keeps every generation, and seq runs across both.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use soksak_host_tauriv2::event_log::{EventLog, Level, Options};

fn read(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn options(directory: &Path) -> Options {
    Options {
        directory: directory.to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1 << 30,
        pull: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: 1 << 40,
    }
}

/// The debug file beside the main file of a writer.
fn debug_path_of(log: &EventLog) -> PathBuf {
    let main = log.path().to_string_lossy().into_owned();
    PathBuf::from(format!(
        "{}.debug.jsonl",
        main.strip_suffix(".jsonl").unwrap()
    ))
}

fn levels_of(events: &[Value]) -> String {
    events
        .iter()
        .filter(|event| event["event"] == "host.app.event")
        .map(|event| event["level"].as_str().unwrap().to_string())
        .collect::<Vec<_>>()
        .join(",")
}

// contract: log.writer.splits-files-by-level
#[test]
fn debug_and_trace_events_go_to_the_debug_file_and_the_others_to_the_main_file() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::start(options(directory.path())).unwrap();
    for (index, level) in [
        Level::Error,
        Level::Debug,
        Level::Warn,
        Level::Trace,
        Level::Info,
        Level::Debug,
    ]
    .into_iter()
    .enumerate()
    {
        assert!(
            log.emit(level, "host.app.event", &json!({"kind": index.to_string()})),
            "event {index} was refused"
        );
    }
    log.flush(Duration::from_secs(5)).unwrap();
    let main = read(log.path());
    let debug = read(&debug_path_of(&log));
    for file in [&main, &debug] {
        assert_eq!(file[0]["event"], "log.open", "{file:?}");
    }
    assert_eq!(levels_of(&main), "error,warn,info");
    assert_eq!(levels_of(&debug), "debug,trace,debug");
    // seq is assigned by the writer across both files: the union is 1..n once each.
    let mut seqs: Vec<u64> = main
        .iter()
        .chain(debug.iter())
        .map(|event| event["seq"].as_u64().unwrap())
        .collect();
    seqs.sort_unstable();
    assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());
}

// contract: log.writer.rotation-keeps-every-generation
#[test]
fn each_file_rotates_on_its_own_and_rotation_never_removes_a_generation() {
    let directory = tempfile::tempdir().unwrap();
    let mut opts = options(directory.path());
    opts.rotate_bytes = 700;
    opts.queue_events = 500;
    opts.queue_bytes = 1 << 20;
    let log = EventLog::start(opts).unwrap();
    for index in 0..120 {
        assert!(
            log.emit(
                Level::Debug,
                "host.app.event",
                &json!({"kind": "x".repeat(40)})
            ),
            "event {index} was refused"
        );
    }
    assert!(log.emit(Level::Info, "host.app.event", &json!({"kind": "info"})));
    log.flush(Duration::from_secs(10)).unwrap();
    let debug = debug_path_of(&log);
    let generation = |n: usize| PathBuf::from(format!("{}.{n}", debug.display()));
    let generations: Vec<PathBuf> = (1..)
        .map(generation)
        .take_while(|path| path.exists())
        .collect();
    assert!(
        generations.len() >= 8,
        "the debug file rotated into {} generations, want more than the 5 that an earlier writer kept",
        generations.len()
    );
    assert!(
        !Path::new(&format!("{}.1", log.path().display())).exists(),
        "the main file rotated although it holds a single info event"
    );
    // The generations are numbered in the order of rotation: .1 is the oldest, each later file starts with log.open and log.rotated
    // that names the generation just closed, and seq continues across the files.
    let mut previous_last = 0;
    let files: Vec<PathBuf> = generations
        .into_iter()
        .chain(std::iter::once(debug.clone()))
        .collect();
    for (position, name) in files.iter().enumerate() {
        let events = read(name);
        assert_eq!(events[0]["event"], "log.open", "{name:?}");
        if position > 0 {
            assert_eq!(events[1]["event"], "log.rotated", "{name:?}");
            assert_eq!(events[1]["fields"]["generation"], position, "{name:?}");
        }
        let first = events[0]["seq"].as_u64().unwrap();
        assert!(position == 0 || first > previous_last, "{name:?}");
        previous_last = events.last().unwrap()["seq"].as_u64().unwrap();
    }
}

// contract: log.writer.never-blocks-and-counts-loss
#[test]
fn a_loss_names_the_channel_of_the_refused_events() {
    let directory = tempfile::tempdir().unwrap();
    let mut opts = options(directory.path());
    opts.queue_events = 4;
    opts.batch_interval = Duration::from_secs(30);
    let log = EventLog::start(opts).unwrap();
    let mut refused: BTreeMap<&str, u64> = BTreeMap::new();
    for index in 0..40 {
        let (level, channel) = if index % 3 == 0 {
            (Level::Debug, "debug")
        } else {
            (Level::Info, "other")
        };
        if !log.emit(level, "host.app.event", &json!({"kind": index.to_string()})) {
            *refused.entry(channel).or_default() += 1;
        }
    }
    assert!(
        refused.get("other").copied().unwrap_or(0) > 0
            && refused.get("debug").copied().unwrap_or(0) > 0,
        "the queue refused {refused:?}, so a channel is not covered"
    );
    log.flush(Duration::from_secs(5)).unwrap();
    let mut dropped: BTreeMap<String, u64> = BTreeMap::new();
    for event in read(log.path()) {
        if event["event"] != "log.dropped" {
            continue;
        }
        let channel = event["fields"]["channel"]
            .as_str()
            .unwrap_or("")
            .to_string();
        *dropped.entry(channel).or_default() += event["fields"]["count"].as_u64().unwrap();
    }
    assert_eq!(dropped.len(), 2, "{dropped:?}");
    assert_eq!(dropped["other"], refused["other"]);
    assert_eq!(dropped["debug"], refused["debug"]);
}
