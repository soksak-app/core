//! The policy of the event log (docs/spec/logging.md#classes-and-policy): the file log-policy.json says for each class the least
//! severe level that is stored; the gate at the producers builds nothing for an event the policy refuses and counts it. The same
//! cases run in the Go host.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc::channel;
use std::time::Duration;

use serde_json::{Value, json};
use soksak_host_tauriv2::event_log::{self, EventLog, Level, Options};
use soksak_host_tauriv2::event_relay::log_command;
use soksak_host_tauriv2::log_policy::{Class, LogPolicy, log_policy_announcer, start_log_policy};

const EVERYTHING: &str = r#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}"#;

fn read(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn options(directory: &Path, policy_path: Option<std::path::PathBuf>) -> Options {
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
        policy_path,
        retention_bytes: 1 << 40,
    }
}

fn start_with_policy(policy: &str) -> (tempfile::TempDir, EventLog) {
    let directory = tempfile::tempdir().unwrap();
    let log = event_log::start(options(directory.path(), None)).unwrap();
    log.set_policy(
        LogPolicy::parse("policy", policy.as_bytes()).unwrap(),
        "file",
    );
    (directory, log)
}

// contract: log.policy.file-names-every-class-and-nothing-else
#[test]
fn a_policy_file_names_every_class_with_a_level_and_nothing_else() {
    let policy = LogPolicy::parse("config/log-policy.json", EVERYTHING.as_bytes()).unwrap();
    for class in Class::ALL {
        for level in [
            Level::Error,
            Level::Warn,
            Level::Info,
            Level::Debug,
            Level::Trace,
        ] {
            assert!(policy.allows(class, level), "{class:?} {level:?}");
        }
    }
    let narrow = LogPolicy::parse(
        "config/log-policy.json",
        br#"{"schema":1,"classes":{"lifecycle":"trace","input":"debug","call":"info","io":"off","frame":"error"}}"#,
    )
    .unwrap();
    for (class, level, want) in [
        (Class::Input, Level::Debug, true),
        (Class::Input, Level::Trace, false),
        (Class::Call, Level::Info, true),
        (Class::Call, Level::Debug, false),
        (Class::Io, Level::Error, false),
        (Class::Frame, Level::Error, true),
        (Class::Frame, Level::Warn, false),
        (Class::Lifecycle, Level::Trace, true),
    ] {
        assert_eq!(narrow.allows(class, level), want, "{class:?} {level:?}");
    }
    for (text, message) in [
        (
            r#"{"schema":2,"classes":{}}"#,
            "config/log-policy.json: schema 2 is not 1",
        ),
        (
            r#"{"schema":1}"#,
            "config/log-policy.json: classes must be an object that names every class",
        ),
        (
            r#"{"schema":1,"classes":{"lifecycle":"trace"}}"#,
            "config/log-policy.json: the class input is missing",
        ),
        (
            r#"{"schema":1,"classes":{"lifecycle":"trace","input":"loud","call":"trace","io":"trace","frame":"trace"}}"#,
            r#"config/log-policy.json: the level "loud" of the class input is not one of off, error, warn, info, debug, trace"#,
        ),
        (
            r#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace","audio":"trace"}}"#,
            "config/log-policy.json: the class audio is not one of lifecycle, input, call, io, frame",
        ),
        (
            r#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"},"note":1}"#,
            "config/log-policy.json: the member note is not one of schema, classes",
        ),
        ("{broken", "config/log-policy.json: not JSON"),
    ] {
        let error = LogPolicy::parse("config/log-policy.json", text.as_bytes()).expect_err(text);
        assert!(
            error.contains(message),
            "{text}: {error:?}, want {message:?}"
        );
    }
}

fn gated_counts(log: &EventLog) -> BTreeMap<String, u64> {
    log.flush(Duration::from_secs(5)).unwrap();
    let mut counts = BTreeMap::new();
    for event in read(log.path()) {
        if event["event"] == "log.gated" {
            let fields = &event["fields"];
            *counts
                .entry(format!(
                    "{}/{}",
                    fields["class"].as_str().unwrap(),
                    fields["level"].as_str().unwrap()
                ))
                .or_default() += fields["count"].as_u64().unwrap();
            assert_eq!(event["class"], "lifecycle", "{event}");
            assert_eq!(event["level"], "info", "{event}");
        }
    }
    counts
}

// contract: log.policy.gate-counts-what-it-did-not-build
#[test]
fn a_closed_gate_stores_nothing_and_counts_what_the_producer_did_not_build() {
    let (_directory, log) = start_with_policy(
        r#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"info","io":"off","frame":"trace"}}"#,
    );
    assert!(
        !log.enabled(Class::Call, Level::Debug)
            && log.enabled(Class::Call, Level::Warn)
            && !log.enabled(Class::Io, Level::Error),
        "enabled does not follow the policy"
    );
    // `enabled` does not count; `gate` counts the event that the producer then does not build.
    for _ in 0..5 {
        assert!(!log.gate(Class::Call, Level::Debug));
    }
    assert!(log.gate(Class::Call, Level::Info));
    // An event that reaches the writer through a closed gate is not stored and counted too.
    for _ in 0..3 {
        assert!(!log.emit(
            Level::Debug,
            "host.binding.call",
            &json!({"name": "x", "args": "[]", "micros": 1, "ok": true, "truncated": false})
        ));
    }
    assert!(log.emit(Level::Info, "host.app.event", &json!({"kind": "started"})));
    assert!(!log.emit(
        Level::Error,
        "host.sidecar.request",
        &json!({"name": "n", "surface": "s", "bytes": 1})
    ));
    // An event of a name that the catalog does not declare has no class, so no gate refuses it.
    assert!(log.emit(Level::Debug, "host.test.event", &json!({})));
    let counts = gated_counts(&log);
    assert_eq!(counts.len(), 2, "{counts:?}");
    assert_eq!(counts["call/debug"], 8, "5 gates and 3 emits");
    assert_eq!(counts["io/error"], 1);
    let stored = read(log.path())
        .iter()
        .filter(|event| {
            matches!(
                event["event"].as_str(),
                Some("host.binding.call" | "host.sidecar.request")
            )
        })
        .count();
    assert_eq!(stored, 0, "gated events were stored");
}

// contract: log.policy.change-is-an-event
#[test]
fn a_policy_change_is_an_event_and_the_same_policy_is_not() {
    let (_directory, log) = start_with_policy(EVERYTHING);
    let narrow = LogPolicy::parse(
        "policy",
        br#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"info","io":"trace","frame":"trace"}}"#,
    )
    .unwrap();
    log.set_policy(narrow, "file");
    log.set_policy(narrow, "file");
    log.flush(Duration::from_secs(5)).unwrap();
    let changes: Vec<Value> = read(log.path())
        .into_iter()
        .filter(|event| event["event"] == "log.policy")
        .collect();
    assert_eq!(
        changes.len(),
        2,
        "one for the first policy and one for the change: {changes:?}"
    );
    let last = &changes[1];
    assert_eq!(last["fields"]["source"], "file");
    assert_eq!(last["fields"]["classes"]["call"], "info");
    assert_eq!(last["fields"]["classes"]["lifecycle"], "trace");
    assert_eq!(last["fields"]["classes"].as_object().unwrap().len(), 5);
    assert_eq!(last["class"], "lifecycle");
}

// contract: log.policy.gate-passes-the-events-of-the-writer-itself
#[test]
fn the_events_of_the_writer_itself_pass_a_gate_that_turns_the_lifecycle_off() {
    let (_directory, log) = start_with_policy(
        r#"{"schema":1,"classes":{"lifecycle":"off","input":"trace","call":"off","io":"trace","frame":"trace"}}"#,
    );
    log.gate(Class::Call, Level::Debug);
    log.flush(Duration::from_secs(5)).unwrap();
    let names: Vec<String> = read(log.path())
        .iter()
        .map(|event| event["event"].as_str().unwrap().to_string())
        .collect();
    for want in ["log.open", "log.policy", "log.gated"] {
        assert!(
            names.iter().any(|name| name == want),
            "the writer stored {names:?} although the policy turns the class lifecycle off"
        );
    }
}

// contract: log.policy.file-is-watched, log.policy.default-stores-errors
#[test]
fn the_policy_file_is_watched_and_every_change_is_applied_once() {
    let config = tempfile::tempdir().unwrap();
    let policy_path = config.path().join("log-policy.json");
    let log = Arc::new(
        event_log::start(options(
            &config.path().join("logs"),
            Some(policy_path.clone()),
        ))
        .unwrap(),
    );
    let (sender, applied) = channel::<(String, String)>();
    let sender = std::sync::Mutex::new(sender);
    let watch = start_log_policy(
        &log,
        Some(Box::new(move |source: &str, detail: &str| {
            sender
                .lock()
                .unwrap()
                .send((source.to_string(), detail.to_string()))
                .unwrap();
        })),
    )
    .unwrap();
    // The step names the change that the check made, so a failure states which change gave which source and detail.
    let wait = |step: &str, want: &str| {
        let (got, detail) = applied
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| {
                panic!("{step}: the policy {want:?} was not applied within 10 seconds")
            });
        assert_eq!(got, want, "{step}: applied {got:?} ({detail})");
    };
    // The file does not exist: the default policy, which stores only errors, is in force.
    wait("start without a file", "default");
    assert_default_gate(&log, "start without a file");
    let narrow = r#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"info","io":"trace","frame":"trace"}}"#;
    // An atomic replacement (a new file renamed over the path) is applied.
    let temporary = config.path().join(".log-policy.tmp");
    fs::write(&temporary, narrow).unwrap();
    fs::rename(&temporary, &policy_path).unwrap();
    wait("atomic replacement", "file");
    assert!(!log.enabled(Class::Call, Level::Debug));
    // A write in place is applied too.
    fs::write(&policy_path, EVERYTHING).unwrap();
    wait("write in place", "file");
    assert!(log.enabled(Class::Call, Level::Debug));
    // A file that breaks the format is an error record that names the file, and the policy in force stays.
    fs::write(&policy_path, r#"{"schema":9}"#).unwrap();
    wait("refused file", "error");
    assert!(log.enabled(Class::Call, Level::Debug));
    // The removal of the file returns to the default policy.
    fs::remove_file(&policy_path).unwrap();
    wait("removal", "default");
    assert_default_gate(&log, "removal");
    drop(watch);
}

/// Checks the gate of a writer under the default policy: an error event of every class is stored and an event of every class below
/// error is refused.
fn assert_default_gate(log: &EventLog, step: &str) {
    for class in Class::ALL {
        assert!(
            log.enabled(class, Level::Error),
            "{step}: the default policy refuses an error event of the class {class:?}"
        );
        for level in [Level::Warn, Level::Info, Level::Debug, Level::Trace] {
            assert!(
                !log.enabled(class, level),
                "{step}: the default policy stores a {level:?} event of the class {class:?}"
            );
        }
    }
}

// contract: log.policy.page-sets-the-file
#[test]
fn the_page_sets_the_policy_through_the_log_call_and_the_host_writes_the_file() {
    let config = tempfile::tempdir().unwrap();
    let policy_path = config.path().join("log-policy.json");
    let log = event_log::start(options(
        &config.path().join("logs"),
        Some(policy_path.clone()),
    ))
    .unwrap();
    let request = json!({"action": "policy", "classes": {"lifecycle": "trace", "input": "trace", "call": "warn", "io": "trace", "frame": "off"}});
    log_command(&log, request.clone()).unwrap();
    let written = LogPolicy::parse(
        &policy_path.display().to_string(),
        &fs::read(&policy_path).unwrap(),
    )
    .unwrap();
    assert!(!written.allows(Class::Call, Level::Info));
    assert!(written.allows(Class::Call, Level::Warn));
    assert!(!written.allows(Class::Frame, Level::Error));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&policy_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // A request that leaves a class out, names a class that does not exist or a level outside the contract is refused and writes
    // nothing.
    for (name, bad) in [
        ("a missing class", json!({"lifecycle": "trace"})),
        (
            "an unknown class",
            json!({"lifecycle": "trace", "input": "trace", "call": "trace", "io": "trace", "frame": "trace", "audio": "trace"}),
        ),
        (
            "an unknown level",
            json!({"lifecycle": "trace", "input": "loud", "call": "trace", "io": "trace", "frame": "trace"}),
        ),
        (
            "a level that is not text",
            json!({"lifecycle": 4, "input": "trace", "call": "trace", "io": "trace", "frame": "trace"}),
        ),
    ] {
        let _ = fs::remove_file(&policy_path);
        assert!(
            log_command(&log, json!({"action": "policy", "classes": bad})).is_err(),
            "{name} was accepted"
        );
        assert!(!policy_path.exists(), "{name} wrote the file");
    }
    let bare_directory = tempfile::tempdir().unwrap();
    let bare = event_log::start(options(bare_directory.path(), None)).unwrap();
    let error = log_command(&bare, request).expect_err("a writer without a policy file");
    assert!(error.contains("policy file"), "{error}");
}

// contract: log.policy.read-answers-the-policy-in-force
#[test]
fn the_action_policy_read_answers_the_classes_of_the_policy_in_force() {
    let directory = tempfile::tempdir().unwrap();
    let log = event_log::start(options(directory.path(), None)).unwrap();
    let reply = log_command(&log, json!({"action": "policy-read"})).unwrap();
    assert_eq!(
        reply.classes.map(Value::Object),
        Some(
            json!({"lifecycle": "error", "input": "error", "call": "error", "io": "error", "frame": "error"})
        )
    );
    let policy = LogPolicy::parse("policy", EVERYTHING.as_bytes()).unwrap();
    log.set_policy(policy, "file");
    let reply = log_command(&log, json!({"action": "policy-read"})).unwrap();
    assert_eq!(reply.classes, Some(policy.classes()));
}

// contract: log.policy.event-reaches-every-document
#[test]
fn each_applied_policy_is_the_event_log_policy_and_a_refused_file_is_not() {
    let config = tempfile::tempdir().unwrap();
    let policy_path = config.path().join("log-policy.json");
    let log = Arc::new(
        event_log::start(options(
            &config.path().join("logs"),
            Some(policy_path.clone()),
        ))
        .unwrap(),
    );
    let (sender, sent) = channel::<(String, Value)>();
    let sender = std::sync::Mutex::new(sender);
    let watch = start_log_policy(
        &log,
        Some(log_policy_announcer(
            &log,
            move |name: &str, payload: Value| {
                sender
                    .lock()
                    .unwrap()
                    .send((name.to_string(), payload))
                    .unwrap();
            },
        )),
    )
    .unwrap();
    let wait = |step: &str, want: Value| {
        let (name, payload) = sent
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("{step}: no event log-policy within 10 seconds"));
        assert_eq!(
            (name.as_str(), payload),
            ("log-policy", json!({"classes": want})),
            "{step}"
        );
    };
    wait(
        "start without a file",
        Value::Object(LogPolicy::default().classes()),
    );
    fs::write(&policy_path, r#"{"schema":9}"#).unwrap();
    fs::write(&policy_path, EVERYTHING).unwrap();
    // A refused file emits nothing, so the next event is the policy of the file.
    wait(
        "write in place",
        Value::Object(
            LogPolicy::parse("policy", EVERYTHING.as_bytes())
                .unwrap()
                .classes(),
        ),
    );
    drop(watch);
}
