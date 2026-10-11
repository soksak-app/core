//! Checks that the writer of the tool follows the event contract that the writers of the hosts follow: the golden files of
//! packages/log-contract/fixtures fix the shape of a line, of log.open and of log.dropped (docs/spec/logging.md#writers).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::de::{Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::{json, Value};
use soksak_sok::event_log::{EventLog, Level};

/// The keys of a JSON object in the order they are written.
struct Keys(Vec<String>);

impl<'de> serde::Deserialize<'de> for Keys {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Keys, D::Error> {
        struct Collect;
        impl<'de> Visitor<'de> for Collect {
            type Value = Keys;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Keys, A::Error> {
                let mut keys = Vec::new();
                while let Some((key, _)) = map.next_entry::<String, IgnoredAny>()? {
                    keys.push(key);
                }
                Ok(Keys(keys))
            }
        }
        deserializer.deserialize_map(Collect)
    }
}

fn keys_of(line: &str) -> Vec<String> {
    serde_json::from_str::<Keys>(line)
        .unwrap_or_else(|error| panic!("{line:?} is not an object: {error}"))
        .0
}

/// Reads a golden file of packages/log-contract/fixtures.
fn fixture_lines(name: &str) -> Vec<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../log-contract/fixtures")
        .join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
        .trim()
        .lines()
        .map(str::to_string)
        .collect()
}

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            panic!("{}: {error}", self.0.display());
        }
    }
}

/// Starts the writer of the tool, emits through `emit` and returns the lines of its file.
fn write_events(label: &str, emit: impl FnOnce(&EventLog)) -> Vec<String> {
    let dir = Dir(std::env::temp_dir().join(format!("sok-fixture{}-{label}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let log = EventLog::start(&dir.0).unwrap();
    emit(&log);
    log.flush(Duration::from_secs(5)).unwrap();
    log.close();
    std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect()
}

fn parse(line: &str) -> Value {
    serde_json::from_str(line).unwrap_or_else(|error| panic!("{line:?}: {error}"))
}

// contract: cli.log.lines-follow-the-golden-fixtures
#[test]
fn lines_follow_the_golden_fixtures() {
    let golden = fixture_lines("key.jsonl");
    let lines = write_events("golden", |log| {
        log.emit(Level::Info, "sok.command", &json!({"name": "x"}));
    });
    assert_eq!(keys_of(&lines[0]), keys_of(&golden[0]), "keys of log.open");
    let (open, golden_open) = (parse(&lines[0]), parse(&golden[0]));
    assert!(
        open["fields"]["schema"] == golden_open["fields"]["schema"]
            && open["fields"]["role"] == "sok"
            && open["fields"].as_object().unwrap().len()
                == golden_open["fields"].as_object().unwrap().len(),
        "log.open fields {} golden {}",
        open["fields"],
        golden_open["fields"]
    );
    // An event line keeps the key order of a golden event line for the keys it has; the object identifiers and cids are optional.
    let own = keys_of(&lines[1]);
    let kept: Vec<String> = keys_of(&golden[1])
        .into_iter()
        .filter(|key| own.contains(key))
        .collect();
    assert_eq!(kept, own, "golden order {:?}", keys_of(&golden[1]));
    let event = parse(&lines[1]);
    assert!(
        event["seq"] == 2
            && event["mono_ns"].as_u64().unwrap_or(0) > 0
            && event["ts_us"].as_u64().unwrap_or(0) > 0,
        "event {event}"
    );
}

// contract: cli.log.escapes-and-truncates-like-the-contract
#[test]
fn fields_are_escaped_and_an_oversize_event_is_cut() {
    let text = "quote \" backslash \\ newline \n tab \t unicode \u{2028} é 한";
    let lines = write_events("escape", |log| {
        log.emit(Level::Info, "sok.command", &json!({"args": text}));
        log.emit(
            Level::Info,
            "sok.command",
            &json!({"args": "a".repeat(1 << 20)}),
        );
    });
    assert_eq!(lines.len(), 3);
    assert_eq!(parse(&lines[1])["fields"]["args"], text);
    let cut = parse(&lines[2]);
    let head = cut["fields"]["head"].as_str().unwrap_or("");
    assert!(
        cut["truncated"].as_u64().unwrap_or(0) > 1 << 20
            && head.len() == 4096
            && cut["fields"].as_object().unwrap().len() == 1,
        "truncated {} head {} bytes fields {}",
        cut["truncated"],
        head.len(),
        cut["fields"]
    );
}

// contract: cli.log.records-a-refused-event-as-log-dropped
#[test]
fn a_refused_event_is_counted_and_explained_by_log_dropped() {
    let lines = write_events("dropped", |log| {
        log.emit(Level::Info, "sok.command", &json!({"name": "first"}));
        // A map with keys that JSON cannot carry is refused and counted in place of the event.
        let refused: HashMap<(i32, i32), i32> = HashMap::from([((1, 2), 3)]);
        assert!(
            !log.emit(Level::Info, "sok.command", &refused),
            "an event with fields that cannot be serialized was accepted"
        );
        log.emit(Level::Info, "sok.command", &json!({"name": "last"}));
    });
    let golden = parse(&fixture_lines("dropped.jsonl")[2]);
    let events: Vec<Value> = lines.iter().map(|line| parse(line)).collect();
    let dropped = events
        .iter()
        .find(|event| event["event"] == "log.dropped")
        .unwrap_or_else(|| panic!("no log.dropped in {lines:?}"));
    for key in golden["fields"].as_object().unwrap().keys() {
        assert!(
            dropped["fields"].get(key).is_some(),
            "log.dropped lacks the golden field {key}: {dropped}"
        );
    }
    assert!(
        dropped["level"] == golden["level"]
            && dropped["fields"]["count"] == 1
            && dropped["fields"]["from_seq"] == dropped["fields"]["to_seq"],
        "log.dropped = {dropped}"
    );
    // The stored seq and the range that log.dropped names cover 1..n once each, and log.dropped is stored after its range.
    let mut covered = vec![dropped["fields"]["from_seq"].as_u64().unwrap()];
    for event in &events {
        let seq = event["seq"].as_u64().unwrap();
        assert!(
            !covered.contains(&seq),
            "seq {seq} appears twice: {lines:?}"
        );
        covered.push(seq);
    }
    for seq in 1..=covered.len() as u64 {
        assert!(
            covered.contains(&seq),
            "seq {seq} is neither stored nor named by log.dropped: {lines:?}"
        );
    }
    assert!(dropped["seq"].as_u64().unwrap() > dropped["fields"]["to_seq"].as_u64().unwrap());
}

// contract: cli.log.run-stores-only-the-declared-events
#[test]
fn a_run_stores_only_the_events_that_the_specification_names() {
    let dir = Dir(std::env::temp_dir().join(format!("sok-fixture{}-declared", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let args: Vec<String> = ["nothing", "--config-dir", dir.0.to_str().unwrap()]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(std::path::Path::new("/nonexistent/paths.d")),
        core_version: "0.0.2",
    };
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    soksak_sok::logged(&args, &mut stdout, &mut stderr, &options, &soksak_sok::run);
    let files: Vec<PathBuf> = std::fs::read_dir(dir.0.join("logs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1, "{files:?}");
    for line in std::fs::read_to_string(&files[0]).unwrap().lines() {
        let name = parse(line)["event"].as_str().unwrap().to_string();
        assert!(
            ["log.open", "sok.command", "sok.panic", "log.dropped"].contains(&name.as_str()),
            "a run stored {name}"
        );
    }
}
