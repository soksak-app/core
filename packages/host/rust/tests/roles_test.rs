//! Replays the shared roles.json cases (docs/spec/cases/agent-roles/roles.json) against the workspace store of the Rust host.
//! Each read case writes its stored value to roles.json, reads it through the request roles, and compares the result or the
//! error text with the case; each write case writes its roles through the request rolesPut on an absent file.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use soksak_host::workspace::Workspace;

const CASES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../docs/spec/cases/agent-roles/roles.json"
);

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
            assert!(
                !path.exists(),
                "case {name}: a refused write created the file"
            );
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

/// A configuration directory whose projects.json holds one tab without a role, and whose roles.json holds stored.
fn tab_directory(name: &str, stored: &Value) -> (PathBuf, Workspace) {
    let directory = config_directory(name);
    fs::create_dir_all(directory.join("work")).unwrap();
    fs::write(
        directory.join("projects.json"),
        serde_json::to_vec(&json!({
            "format": 4,
            "projects": [{
                "id": "prj-aaaaaa", "root": directory.join("work"), "identity": "6F1D2C3B-4A5B-4C6D-8E9F-0A1B2C3D4E5F:7",
                "spaces": [{
                    "id": "spc-aaaaaa", "title": "SPACE1",
                    "layout": {
                        "state": {"root": {"card": "card-1", "data": {"tabs": [
                            {"id": "tab-aaaaaa", "plugin": "terminal", "title": "a", "role": null}
                        ]}},
                        "focusedId": "card-1", "leader": "card-1", "lastCard": 1, "named": 0}
                    }
                }],
                "activeSpaceId": "spc-aaaaaa"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        directory.join("roles.json"),
        serde_json::to_vec(stored).unwrap(),
    )
    .unwrap();
    let store = Workspace::new(directory.clone());
    (directory, store)
}

// contract: roles.format-3-refuses-format-2
#[test]
fn format_two_roles_are_refused_by_the_reader_and_by_a_tab_assignment() {
    let stored = json!({"format": 2, "roles": {}});
    let (directory, store) = tab_directory("format-two", &stored);
    let path = directory.join("roles.json");
    let want = format!("{}: roles: format must be 3, found 2", path.display());
    assert_eq!(
        store.apply(serde_json::from_value(json!({"kind": "roles"})).unwrap()),
        Err(want.clone())
    );
    assert_eq!(
        store.apply(
            serde_json::from_value(json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"}))
                .unwrap()
        ),
        Err(want)
    );
    let kept: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(kept, stored, "a refused assignment changed roles.json");
    assert!(
        !directory.join("agents").exists(),
        "a refused assignment wrote a role file"
    );
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.files-reader-refusals
#[test]
fn the_reader_refuses_definition_files_that_are_absent_relative_or_hold_control_characters() {
    let cases = [
        (
            json!({"text": "x", "ko": "x"}),
            "role reviewer files must be an array of strings",
        ),
        (
            json!({"text": "x", "ko": "x", "files": "/a"}),
            "role reviewer files must be an array of strings",
        ),
        (
            json!({"text": "x", "ko": "x", "files": [1]}),
            "role reviewer files must be an array of strings",
        ),
        (
            json!({"text": "x", "ko": "x", "files": ["checklist.md"]}),
            "role reviewer file checklist.md is not absolute",
        ),
        (
            json!({"text": "x", "ko": "x", "files": ["/a\tb"]}),
            "role reviewer file /a\tb holds a control character",
        ),
    ];
    for (index, (definition, reason)) in cases.into_iter().enumerate() {
        let stored = json!({"format": 3, "roles": {"reviewer": definition}});
        let (directory, store) = tab_directory(&format!("files-{index}"), &stored);
        let path = directory.join("roles.json");
        assert_eq!(
            store.apply(serde_json::from_value(json!({"kind": "roles"})).unwrap()),
            Err(format!("{}: roles: {reason}", path.display())),
            "case {index}"
        );
        let _ = fs::remove_dir_all(&directory);
    }
    // The reader does not check that an absolute path exists.
    let stored = json!({"format": 3, "roles": {"reviewer": {"text": "x", "ko": "x", "files": ["/soksak-no-such-file/checklist.md"]}}});
    let (directory, store) = tab_directory("files-absent-path", &stored);
    assert!(
        store
            .apply(serde_json::from_value(json!({"kind": "roles"})).unwrap())
            .is_ok(),
        "the reader refused an absolute path that does not exist"
    );
    let _ = fs::remove_dir_all(&directory);
}
