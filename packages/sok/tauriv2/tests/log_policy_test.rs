//! Runs every golden case of the policy file (docs/spec/cases/log-contract/policy/cases.json, docs/spec/logging.md#policy-file)
//! through the reader of the tool, so the reader of the tool gives the classes, the gate and the error texts that the readers of
//! the hosts and of the sidecars give.

use std::time::Duration;

use serde_json::Value;
use soksak_sok::event_classes::Class;
use soksak_sok::event_log::{EventLog, Level, Options};
use soksak_sok::log_policy::LogPolicy;

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

fn level_named(name: &str) -> Option<Level> {
    match name {
        "error" => Some(Level::Error),
        "warn" => Some(Level::Warn),
        "info" => Some(Level::Info),
        "debug" => Some(Level::Debug),
        "trace" => Some(Level::Trace),
        _ => None,
    }
}

fn cases() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/log-contract/policy/cases.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn level(name: &str) -> Level {
    match name {
        "error" => Level::Error,
        "warn" => Level::Warn,
        "info" => Level::Info,
        "debug" => Level::Debug,
        "trace" => Level::Trace,
        other => panic!("the golden case names the level {other}"),
    }
}

fn pairs(value: &Value) -> Vec<(Class, Level)> {
    value
        .as_array()
        .map(|pairs| {
            pairs
                .iter()
                .map(|pair| {
                    (
                        Class::parse(pair[0].as_str().unwrap()).unwrap(),
                        level(pair[1].as_str().unwrap()),
                    )
                })
                .collect()
        })
        // default: a golden case without the member lists no pair.
        .unwrap_or_default()
}

// contract: cli.log.policy-accepts-the-golden-cases
#[test]
fn the_policy_reader_accepts_every_valid_golden_case() {
    let cases = cases();
    let file = cases["file"].as_str().unwrap();
    for case in cases["valid"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let policy = LogPolicy::parse(file, case["text"].as_str().unwrap().as_bytes())
            .unwrap_or_else(|error| panic!("{name}: refused: {error}"));
        let classes = policy.classes();
        if let Some(expected) = case["classes"].as_object() {
            for (class, value) in expected {
                assert_eq!(classes.get(class), Some(value), "{name}: class {class}");
            }
        }
        for (class, level) in pairs(&case["allows"]) {
            assert!(
                policy.allows(class, level),
                "{name}: {class:?} {level:?} is refused, expected stored"
            );
        }
        for (class, level) in pairs(&case["refuses"]) {
            assert!(
                !policy.allows(class, level),
                "{name}: {class:?} {level:?} is stored, expected refused"
            );
        }
    }
}

// contract: cli.log.policy-refuses-the-golden-cases
#[test]
fn the_policy_reader_refuses_every_invalid_golden_case_with_its_text() {
    let cases = cases();
    let file = cases["file"].as_str().unwrap();
    for case in cases["invalid"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let error = match LogPolicy::parse(file, case["text"].as_str().unwrap().as_bytes()) {
            Ok(_) => panic!("{name}: accepted"),
            Err(error) => error,
        };
        if let Some(prefix) = case["error_prefix"].as_str() {
            let prefix = prefix.replace("<file>", file);
            assert!(
                error.starts_with(&prefix),
                "{name}: error {error:?} does not start with {prefix:?}"
            );
            continue;
        }
        let expected = case["error"].as_str().unwrap().replace("<file>", file);
        assert_eq!(error, expected, "{name}");
    }
}

// The writer applies the default policy before the first policy and while no policy file exists, so its gate stores the levels that the
// golden default names: a level stores when it is not more verbose than the value of its class.
// contract: log.policy.default-stores-errors
#[test]
fn the_default_policy_of_the_writer_is_the_golden_default() {
    let cases = cases();
    let directory = Folder::new("policy");
    let log = EventLog::start(Options {
        directory: directory.to_path_buf(),
        role: "sok".into(),
        boot: "b1".into(),
        layer: "sok",
        clock: || 1,
        spawn: |work| {
            std::thread::Builder::new()
                .spawn(work)
                .map_err(|error| error.to_string())
        },
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1 << 30,
        pull: None,
        policy_path: None,
        prune: None,
    })
    .unwrap();
    let default = cases["default"].as_object().unwrap();
    let classes = LogPolicy::default().classes();
    for class in Class::ALL {
        assert_eq!(
            classes.get(class.as_str()),
            Some(&default[class.as_str()]),
            "LogPolicy::default() class {}",
            class.as_str()
        );
    }
    assert_eq!(
        default.len(),
        Class::ALL.len(),
        "the golden default names every class"
    );
    let values = cases["values"].as_array().unwrap();
    for class in Class::ALL {
        let value = default[class.as_str()].as_str().unwrap();
        let position = values
            .iter()
            .position(|candidate| candidate.as_str() == Some(value))
            .unwrap();
        for name in ["error", "warn", "info", "debug", "trace"] {
            let level = level_named(name).unwrap();
            let rank = cases["levels"]
                .as_array()
                .unwrap()
                .iter()
                .position(|candidate| candidate.as_str() == Some(name))
                .unwrap()
                + 1;
            let want = rank <= position;
            assert_eq!(
                log.enabled(class, level),
                want,
                "default {} {name} stored, for the value {value:?}",
                class.as_str()
            );
        }
    }
    log.close();
}

/// Runs the tool with the arguments and the configuration directory, and returns the events that the run stored in the main file.
fn tool_run_events(config: &Folder, args: &[&str]) -> Vec<Value> {
    let mut all: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    all.push("--config-dir".into());
    all.push(config.path().to_str().unwrap().into());
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(std::path::Path::new("/nonexistent/paths.d")),
        core_version: "0.0.2",
    };
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    soksak_sok::logged(&all, &mut stdout, &mut stderr, &options, &soksak_sok::run);
    let mut events = Vec::new();
    for entry in std::fs::read_dir(config.path().join("logs")).unwrap() {
        let path = entry.unwrap().path();
        if path.to_string_lossy().ends_with(".debug.jsonl") {
            continue;
        }
        for line in std::fs::read_to_string(&path).unwrap().lines() {
            events.push(serde_json::from_str::<Value>(line).unwrap());
        }
    }
    events
}

// The tool applies the policy file of its configuration directory at its start, as every process does, so a file that stores every
// level makes the tool store its command event, which the default policy refuses.
// contract: cli.log.applies-the-policy-file
#[test]
fn the_tool_applies_the_policy_file_of_its_config_directory() {
    let config = Folder::new("policy");
    std::fs::write(
        config.path().join("log-policy.json"),
        r#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}"#,
    )
    .unwrap();
    let events = tool_run_events(&config, &["nothing"]);
    let names: Vec<&str> = events
        .iter()
        .filter_map(|event| event["event"].as_str())
        .collect();
    assert!(
        names.contains(&"sok.command"),
        "the tool stored no sok.command under a policy file that stores every level: {names:?}"
    );
}

// A policy file that the reader refuses is stored as the error record of the place `log policy`.
// contract: cli.log.records-a-refused-policy-file
#[test]
fn a_refused_policy_file_is_stored_as_a_sok_record_error() {
    let config = Folder::new("policy");
    std::fs::write(config.path().join("log-policy.json"), r#"{"schema":9}"#).unwrap();
    let events = tool_run_events(&config, &["nothing"]);
    let records: Vec<&Value> = events
        .iter()
        .filter(|event| event["event"] == "sok.record.error")
        .collect();
    assert!(
        records
            .iter()
            .any(|event| event["fields"]["where"] == "log policy"
                && event["fields"]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("schema 9 is not 1")),
        "no sok.record.error of the place log policy: {events:?}"
    );
}
