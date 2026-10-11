//! Runs every golden case of the policy file (packages/log-contract/fixtures/policy/cases.json, docs/spec/logging.md#policy-file)
//! through the reader of the tool, so the reader of the tool gives the classes, the gate and the error texts that the readers of
//! the hosts and of the sidecars give.

use serde_json::Value;
use soksak_sok::event_classes::Class;
use soksak_sok::event_log::Level;
use soksak_sok::log_policy::LogPolicy;

fn cases() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../log-contract/fixtures/policy/cases.json"
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
