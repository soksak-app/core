//! The check of the parameters of a command before it runs (docs/spec/exposure.md#command-parameters).

use serde_json::Value;
use soksak_host::command_params::command_params_refusal;

/// Runs each case of docs/spec/cases/command-params.json through the check that the endpoint of the host refuses a host command
/// with.
// contract: exposure.command-params.checked-before-the-run
#[test]
fn the_host_refuses_the_params_of_each_case() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/command-params.json"
    );
    let text = std::fs::read_to_string(path).expect("command-params.json is readable");
    let file: Value = serde_json::from_str(&text).expect("command-params.json is JSON");
    let cases = file["cases"].as_array().expect("cases is a list");
    assert!(
        cases.len() >= 8,
        "command-params.json holds {} cases, fewer than eight",
        cases.len()
    );
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("a case has a name");
        let command = case["command"].as_str().expect("a case has a command");
        let schema = case["schema"]
            .as_object()
            .expect("a case has a schema object");
        let params = case["params"]
            .as_object()
            .expect("a case has a params object");
        let want = case["error"].as_str().map(str::to_string);
        let got = command_params_refusal(command, schema, params);
        if got != want {
            failures.push(format!("{name}: refused with {got:?}, want {want:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
