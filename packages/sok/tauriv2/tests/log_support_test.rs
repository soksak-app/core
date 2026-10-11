//! Shared helpers of the tests of the log index and the log query (docs/spec/logging.md#index, docs/spec/logging.md#query): the golden
//! fixtures of packages/log-contract/fixtures/query and the generated log that has more than one segment.

#![allow(dead_code)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;
use sha2::{Digest, Sha256};
use soksak_sok::log_query::LogPage;

pub const QUERY_FIXTURES: &str = "../../log-contract/fixtures/query";
pub const BIG_BASE: i64 = 1_791_500_000_000_000;
pub const BIG_COUNT: usize = 9000;
pub const STATE_BLOCK_BYTES: usize = 20480;
pub const RECORD_BYTES: usize = 18760;

/// Gives a source the modification time of the golden digests (1,000,000,000 seconds).
pub fn set_modified(path: &Path) {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .expect("open for the modification time");
    file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000))
        .expect("set the modification time");
}

pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sok-log-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("logs")).expect("create the logs folder");
    dir
}

/// Copies the event files of the golden fixtures into the logs folder of a new configuration directory.
pub fn fixture_config(name: &str) -> PathBuf {
    let config = temp_dir(name);
    for entry in std::fs::read_dir(Path::new(QUERY_FIXTURES).join("logs")).expect("fixture logs") {
        let entry = entry.expect("entry");
        let target = config.join("logs").join(entry.file_name());
        std::fs::copy(entry.path(), &target).expect("copy");
        set_modified(&target);
    }
    config
}

pub fn digest_of(path: &Path) -> String {
    let data = std::fs::read(path).expect("read for the digest");
    let mut hash = Sha256::new();
    hash.update(&data);
    hash.finalize().iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

pub fn read_cases() -> Vec<Value> {
    let text =
        std::fs::read_to_string(Path::new(QUERY_FIXTURES).join("cases.json")).expect("cases.json");
    let cases: Vec<Value> = serde_json::from_str(&text).expect("cases are JSON");
    assert!(
        cases.len() >= 31,
        "the golden file holds {} cases",
        cases.len()
    );
    cases
}

/// One line of the generated log (the generator is the same as the Go tests': see packages/sok/wailsv3/tests/log_support_test.go).
#[derive(Clone)]
pub struct BigEvent {
    pub line: String,
    pub ts_us: i64,
    pub seq: i64,
    pub level: String,
    pub layer: String,
    pub event: String,
    pub session: String,
    pub surface: String,
    pub cid: String,
}

const BIG_LEVELS: [&str; 5] = ["error", "warn", "info", "debug", "trace"];
const BIG_LAYERS: [&str; 6] = ["native", "host", "page", "plugin", "sidecar", "sok"];
const BIG_GROUPS: [&str; 4] = ["input", "window", "sidecar", "call"];
const BIG_VERBS: [&str; 3] = ["a", "b", "c"];

/// Calls emit for each of the n lines of the generated log in the order of seq: line 0 is log.open, line 2000 is host.test.start of run
/// r-big, line 6000 is its host.test.end, and the clocks of every third line are 1,500 microseconds early.
pub fn generate_each(n: usize, mut emit: impl FnMut(BigEvent)) {
    for i in 0..n {
        let mut ts_us = BIG_BASE + i as i64 * 1000;
        if i % 3 == 0 && i != 0 {
            ts_us -= 1500;
        }
        let seq = i as i64 + 1;
        let mono = 9_000_000_000i64 + i as i64 * 1000;
        let head = format!("{{\"ts_us\":{ts_us},\"mono_ns\":{mono},\"seq\":{seq},");
        let mut event = BigEvent {
            line: String::new(),
            ts_us,
            seq,
            level: String::new(),
            layer: String::new(),
            event: String::new(),
            session: String::new(),
            surface: String::new(),
            cid: String::new(),
        };
        match i {
            0 => {
                event.level = "info".into();
                event.layer = "host".into();
                event.event = "log.open".into();
                event.line = format!("{head}\"level\":\"info\",\"layer\":\"host\",\"event\":\"log.open\",\"fields\":{{\"schema\":2,\"pid\":1,\"role\":\"host\",\"boot\":\"big\"}}}}");
            }
            2000 => {
                event.level = "info".into();
                event.layer = "host".into();
                event.event = "host.test.start".into();
                event.line = format!("{head}\"level\":\"info\",\"layer\":\"host\",\"event\":\"host.test.start\",\"fields\":{{\"name\":\"a\",\"run\":\"r-big\"}}}}");
            }
            6000 => {
                event.level = "info".into();
                event.layer = "host".into();
                event.event = "host.test.end".into();
                event.line = format!("{head}\"level\":\"info\",\"layer\":\"host\",\"event\":\"host.test.end\",\"fields\":{{\"name\":\"a\",\"run\":\"r-big\",\"result\":\"pass\"}}}}");
            }
            _ => {
                event.level = BIG_LEVELS[i % 5].into();
                event.layer = BIG_LAYERS[i % 6].into();
                event.event = format!("{}.{}.{}", event.layer, BIG_GROUPS[i % 4], BIG_VERBS[i % 3]);
                let mut line = head;
                let _ = write!(
                    line,
                    "\"level\":\"{}\",\"layer\":\"{}\",\"event\":\"{}\",",
                    event.level, event.layer, event.event
                );
                if i % 7 == 0 {
                    event.session = format!("x{}", i % 20);
                    let _ = write!(line, "\"session\":\"{}\",", event.session);
                }
                if i % 10 == 0 {
                    event.cid = format!("c{}", i / 10);
                    let _ = write!(line, "\"cids\":[\"{}\"],", event.cid);
                }
                let _ = write!(line, "\"fields\":{{\"n\":{i},\"text\":\"line {i}\"");
                if i % 3 == 0 {
                    event.surface = format!("s{}", (i / 3) % 50);
                    let _ = write!(line, ",\"surface\":\"{}\"", event.surface);
                }
                line.push_str("}}");
                event.line = line;
            }
        }
        emit(event);
    }
}

pub fn generate_big() -> Vec<BigEvent> {
    let mut events = Vec::with_capacity(BIG_COUNT);
    generate_each(BIG_COUNT, |event| events.push(event));
    events
}

/// Writes the generated log as host-big.jsonl in the logs folder of a new configuration directory.
pub fn write_big(name: &str) -> (PathBuf, PathBuf, Vec<BigEvent>) {
    let config = temp_dir(name);
    let events = generate_big();
    let mut text = String::new();
    for event in &events {
        text.push_str(&event.line);
        text.push('\n');
    }
    let path = config.join("logs").join("host-big.jsonl");
    std::fs::write(&path, text).expect("write the generated log");
    set_modified(&path);
    (config, path, events)
}

/// The identity `<role>-<boot>:<seq>` that cases.json uses for a row.
pub fn row_ids(page: &LogPage) -> Vec<String> {
    page.rows
        .iter()
        .map(|row| {
            let event: Value = serde_json::from_str(row.event.get()).expect("the event is JSON");
            format!("{}-{}:{}", row.role, row.boot, event["seq"])
        })
        .collect()
}

pub fn seqs_of(page: &LogPage) -> Vec<i64> {
    page.rows
        .iter()
        .map(|row| {
            let event: Value = serde_json::from_str(row.event.get()).expect("the event is JSON");
            event["seq"].as_i64().expect("seq")
        })
        .collect()
}
