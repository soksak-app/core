//! Runs the golden cases of the replay inputs (packages/log-contract/fixtures/replay/inputs.json, docs/spec/replay.md#records)
//! through the rules of the tool, so the tool refuses an input and a session with the texts of `replayInputProblem` and
//! `replaySessionProblem`.

use serde_json::Value;
use soksak_sok::replay_inputs::{replay_input_problem, replay_session_problem, ReplayInput};

fn cases() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../log-contract/fixtures/replay/inputs.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The problem of one golden input; the fields are written in the order of their keys, and each invalid golden theme has one
/// invalid color, so the order does not choose the member that the problem names.
fn problem(case: &Value) -> Option<String> {
    replay_input_problem(case["kind"].as_str().unwrap(), &case["fields"].to_string())
}

// contract: cli.debug.replay-input-cases
#[test]
fn the_replay_input_rules_reproduce_the_golden_cases() {
    let cases = cases();
    for case in cases["valid"].as_array().unwrap() {
        assert_eq!(problem(case), None, "{case}");
    }
    for case in cases["invalid"].as_array().unwrap() {
        assert_eq!(problem(case).as_deref(), case["error"].as_str(), "{case}");
    }
    for session in cases["sessions"].as_array().unwrap() {
        let inputs: Vec<ReplayInput> = session["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|input| ReplayInput {
                kind: input["kind"].as_str().unwrap().to_string(),
                fields: input["fields"].to_string(),
            })
            .collect();
        assert_eq!(
            replay_session_problem(&inputs).as_deref(),
            session["problem"].as_str(),
            "{}",
            session["name"]
        );
    }
}
