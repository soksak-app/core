//! The role definition commands of docs/spec/agent-roles.md#commands and the status core.roles, driven through the workspace store
//! with real files: the refusals, the write of roles.json, the repair of a tab that holds the defined role, and the seq of the
//! status. No agent CLI runs here.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use soksak_host::role_file::role_fingerprint;
use soksak_host::workspace::Workspace;

/// A configuration directory whose projects.json holds one project with one space of one card of one tab without a role, and
/// whose roles.json defines the role a with the file checklist.md of the project. The returned store is new in this session.
fn fixture(name: &str) -> (PathBuf, Workspace) {
    let directory = std::env::temp_dir().join(format!(
        "soksak-role-definitions-test-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(directory.join("work")).unwrap();
    fs::write(directory.join("work/checklist.md"), "checklist\n").unwrap();
    fs::write(
        directory.join("projects.json"),
        serde_json::to_vec_pretty(&json!({
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
        serde_json::to_vec(&json!({
            "format": 3,
            "roles": {
                "a": {"text": "Role A definition.", "ko": "역할 A 정의.", "files": [directory.join("work/checklist.md")]}
            }
        }))
        .unwrap(),
    )
    .unwrap();
    (directory.clone(), Workspace::new(directory))
}

fn apply(store: &Workspace, request: Value) -> Result<Value, String> {
    store.apply(serde_json::from_value(request).unwrap())
}

fn stored_roles(directory: &Path) -> Value {
    serde_json::from_slice(&fs::read(directory.join("roles.json")).unwrap()).unwrap()
}

// contract: roles.define-refuses-paths
#[test]
fn define_refuses_relative_and_missing_paths_and_writes_nothing() {
    let (directory, store) = fixture("refuses-paths");
    let before = fs::read(directory.join("roles.json")).unwrap();
    let relative = apply(
        &store,
        json!({"kind": "roleDefine", "id": "b", "entry": {"text": "x", "ko": "x", "files": ["checklist.md"]}}),
    );
    assert_eq!(
        relative,
        Err("role b: file checklist.md is not absolute".to_string())
    );
    let missing = directory.join("work/missing.md");
    let missing_text = missing.display().to_string();
    let absent = apply(
        &store,
        json!({"kind": "roleDefine", "id": "b", "entry": {"text": "x", "ko": "x", "files": [missing_text]}}),
    );
    assert_eq!(
        absent,
        Err(format!("role b: file {missing_text} does not exist"))
    );
    assert_eq!(fs::read(directory.join("roles.json")).unwrap(), before);
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.define-writes-roles-first
#[test]
fn define_writes_roles_and_publishes_the_next_seq() {
    let (directory, store) = fixture("writes");
    let file = directory.join("work/checklist.md").display().to_string();
    let answer = apply(
        &store,
        json!({"kind": "roleDefine", "id": "b", "entry": {"text": "Role B.", "ko": "역할 B.", "files": [file]}}),
    )
    .unwrap();
    assert_eq!(
        answer,
        json!({"id": "b", "text": "Role B.", "ko": "역할 B.", "files": [file]})
    );
    let stored = stored_roles(&directory);
    assert_eq!(stored["format"], json!(3));
    assert_eq!(
        stored["roles"]["b"],
        json!({"text": "Role B.", "ko": "역할 B.", "files": [file]})
    );
    let status = apply(&store, json!({"kind": "rolesStatus"})).unwrap();
    assert_eq!(status["seq"], json!(1));
    let ids: Vec<&str> = status["roles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|role| role["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["a", "b"]);
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.define-same-definition-writes-nothing
#[test]
fn define_of_the_stored_definition_writes_nothing_and_keeps_seq() {
    let (directory, store) = fixture("same");
    let file = directory.join("work/checklist.md").display().to_string();
    let before = fs::read(directory.join("roles.json")).unwrap();
    apply(
        &store,
        json!({"kind": "roleDefine", "id": "a", "entry": {"text": "Role A definition.", "ko": "역할 A 정의.", "files": [file]}}),
    )
    .unwrap();
    assert_eq!(fs::read(directory.join("roles.json")).unwrap(), before);
    let status = apply(&store, json!({"kind": "rolesStatus"})).unwrap();
    assert_eq!(status["seq"], json!(0));
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.define-writes-roles-first
#[test]
fn define_of_a_held_role_changes_the_tab_and_its_generation() {
    let (directory, store) = fixture("held");
    apply(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"}),
    )
    .unwrap();
    let file = directory.join("work/checklist.md").display().to_string();
    apply(
        &store,
        json!({"kind": "roleDefine", "id": "a", "entry": {"text": "Role A, revised.", "ko": "역할 A 수정.", "files": [file.clone()]}}),
    )
    .unwrap();
    let status = apply(&store, json!({"kind": "role", "tab": "tab-aaaaaa"})).unwrap();
    assert_eq!(status["generation"], json!(2));
    assert_eq!(status["state"], json!("pending"));
    assert_eq!(
        status["fingerprint"],
        json!(role_fingerprint("a", "Role A, revised.", &[file]))
    );
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.remove-refusals
#[test]
fn undefine_refuses_an_undefined_or_used_role_and_writes_nothing() {
    let (directory, store) = fixture("refusals");
    let before = fs::read(directory.join("roles.json")).unwrap();
    assert_eq!(
        apply(&store, json!({"kind": "roleDefinitionRemove", "id": "zz"})),
        Err("role zz is not defined".to_string())
    );
    apply(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"}),
    )
    .unwrap();
    assert_eq!(
        apply(&store, json!({"kind": "roleDefinitionRemove", "id": "a"})),
        Err("role a is used by tab tab-aaaaaa".to_string())
    );
    assert_eq!(fs::read(directory.join("roles.json")).unwrap(), before);
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.remove-unused-publishes-roles
// contract: roles.roles-status
#[test]
fn undefine_of_an_unused_role_writes_roles_and_publishes_the_seq() {
    let (directory, store) = fixture("unused");
    let file = directory.join("work/checklist.md").display().to_string();
    apply(
        &store,
        json!({"kind": "roleDefine", "id": "b", "entry": {"text": "Role B.", "ko": "역할 B.", "files": [file]}}),
    )
    .unwrap();
    assert_eq!(
        apply(&store, json!({"kind": "roleDefinitionRemove", "id": "b"})),
        Ok(Value::Bool(true))
    );
    assert!(stored_roles(&directory)["roles"].get("b").is_none());
    let status = apply(&store, json!({"kind": "rolesStatus"})).unwrap();
    assert_eq!(status["seq"], json!(2));
    assert_eq!(status["roles"].as_array().unwrap().len(), 1);
    // A new session starts the seq at zero and rebuilds the roles from roles.json.
    let restarted = Workspace::new(directory.clone());
    let status = apply(&restarted, json!({"kind": "rolesStatus"})).unwrap();
    assert_eq!(status["seq"], json!(0));
    assert_eq!(status["roles"][0]["id"], json!("a"));
    let _ = fs::remove_dir_all(&directory);
}
