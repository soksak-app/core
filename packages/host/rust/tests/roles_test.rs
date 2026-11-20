//! Replays the shared roles.json cases (docs/spec/cases/agent-roles/roles.json) against the workspace store of the Rust host.
//! Each read case writes its stored value to roles.json, reads it through the request roles, and compares the result or the
//! error text with the case; each write case writes its roles through the request rolesPut on an absent file.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use soksak_host::workspace::Workspace;

const CASES: &str = "../../../../docs/spec/cases/agent-roles/roles.json";

fn load_cases() -> Value {
    let data = fs::read(CASES).unwrap();
    serde_json::from_slice(&data).unwrap()
}

fn config_directory(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "soksak-roles-test-{}-{}",
        std::process::id(),
        name.replace(|c: char| !c.is_ascii_alphanumeric(), "-")
    ));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn refusal(case: &Value, path: &Path) -> String {
    case["error"]
        .as_str()
        .unwrap()
        .replace("<file>", &path.display().to_string())
}

// contract: roles.reads-shared-cases
#[test]
fn roles_read_cases_match_shared_file() {
    for case in load_cases()["reads"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let directory = config_directory(name);
        let path = directory.join("roles.json");
        if let Some(stored) = case.get("stored") {
            fs::write(&path, serde_json::to_vec(stored).unwrap()).unwrap();
        }
        let store = Workspace::new(directory.clone());
        let result = store.apply(serde_json::from_value(json!({"kind": "roles"})).unwrap());
        if case.get("error").is_some() {
            let want = refusal(case, &path);
            assert_eq!(result, Err(want.clone()), "case {name}: want error {want}");
        } else {
            let got = result.unwrap_or_else(|e| panic!("case {name}: roles returned error {e}"));
            assert_eq!(got, case["result"], "case {name}");
        }
        let _ = fs::remove_dir_all(&directory);
    }
}

// contract: roles.writes-shared-cases
#[test]
fn roles_write_cases_match_shared_file() {
    for case in load_cases()["writes"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let directory = config_directory(name);
        let path = directory.join("roles.json");
        let store = Workspace::new(directory.clone());
        let result = store.apply(
            serde_json::from_value(json!({"kind": "rolesPut", "roles": case["roles"]})).unwrap(),
        );
        if case.get("error").is_some() {
            let want = refusal(case, &path);
            assert_eq!(result, Err(want.clone()), "case {name}: want error {want}");
            assert!(!path.exists(), "case {name}: a refused write created the file");
        } else {
            result.unwrap_or_else(|e| panic!("case {name}: rolesPut returned error {e}"));
            let written: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(written, case["file"], "case {name}");
        }
        let _ = fs::remove_dir_all(&directory);
    }
}

// contract: roles.reads-absent-file-without-creating
#[test]
fn roles_read_does_not_create_absent_file() {
    let directory = config_directory("absent");
    let store = Workspace::new(directory.clone());
    store
        .apply(serde_json::from_value(json!({"kind": "roles"})).unwrap())
        .unwrap();
    assert!(!directory.join("roles.json").exists());
    let _ = fs::remove_dir_all(&directory);
}
