//! The role handshake state of a tab (docs/spec/agent-roles.md#tab-role-state and #confirmation): the stored record of
//! projects.json, the role files of the surface, the generation, the idempotency, the per-surface serialization and the stale
//! refusal, driven through the workspace store with real files. No agent CLI runs here.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use soksak_host::role_file::role_fingerprint;
use soksak_host::workspace::Workspace;

/// A configuration directory whose projects.json holds one project with one space of the fixed sidebar cards left and right
/// around one card of two tabs, and whose
/// roles.json defines the roles a and b.
fn fixture(name: &str) -> (PathBuf, Workspace) {
    let directory = std::env::temp_dir().join(format!(
        "soksak-role-state-test-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(directory.join("work")).unwrap();
    fs::write(
        directory.join("projects.json"),
        serde_json::to_vec_pretty(&json!({
            "format": 4,
            "projects": [{
                "id": "prj-aaaaaa", "root": directory.join("work"), "identity": "6F1D2C3B-4A5B-4C6D-8E9F-0A1B2C3D4E5F:7",
                "spaces": [{
                    "id": "spc-aaaaaa", "title": "SPACE1",
                    "layout": {
                        // The root holds the fixed window sidebar cards left and right, which carry no data, around the
                        // content card, as the workbench stores a space (docs/spec/projects.md).
                        "state": {"root": {"cut": "x", "kids": [
                            {"node": {"card": "left", "fixed": true, "width": 190}, "share": 0.2},
                            {"node": {"card": "card-1", "fixed": false, "data": {"tabs": [
                                {"id": "tab-aaaaaa", "plugin": "terminal", "title": "a", "role": null},
                                {"id": "tab-bbbbbb", "plugin": "terminal", "title": "b", "role": null}
                            ]}}, "share": 0.6},
                            {"node": {"card": "right", "fixed": true, "width": 210}, "share": 0.2}
                        ]}},
                        "focusedId": "card-1", "leader": "card-1", "lastCard": 1, "named": 0
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
                "a": {"text": "Role A definition.", "ko": "역할 A 정의.", "files": []},
                "b": {"text": "Role B definition.", "ko": "역할 B 정의.", "files": []}
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let store = Workspace::new(directory.clone());
    (directory, store)
}

/// Runs one role operation and returns its answer.
fn ask(store: &Workspace, request: Value) -> Value {
    store
        .apply(serde_json::from_value(request).unwrap())
        .unwrap_or_else(|e| panic!("the request returned error {e}"))
}

/// Runs one role operation and returns its error text.
fn refusal(store: &Workspace, request: Value) -> String {
    store
        .apply(serde_json::from_value(request).unwrap())
        .expect_err("the request returned no error")
}

/// Reads the member role of the tab id from projects.json.
fn stored_role(directory: &Path, tab: &str) -> Value {
    let data = fs::read_to_string(directory.join("projects.json")).unwrap();
    let document: Value = serde_json::from_str(&data).unwrap();
    for project in document["projects"].as_array().unwrap() {
        for held in project["spaces"].as_array().unwrap() {
            // The content card of the fixture is the middle kid of the root, between the fixed sidebar cards.
            for entry in held["layout"]["state"]["root"]["kids"][1]["node"]["data"]["tabs"]
                .as_array()
                .unwrap()
            {
                if entry["id"].as_str() == Some(tab) {
                    return entry["role"].clone();
                }
            }
        }
    }
    panic!("projects.json holds no tab {tab}");
}

// contract: roles.role-state-handshake
#[test]
fn the_role_handshake_answers_the_status_and_stores_the_record() {
    let (directory, store) = fixture("handshake");
    // A tab without a role answers the null members.
    assert_eq!(
        ask(&store, json!({"kind": "role", "tab": "tab-aaaaaa"})),
        json!({"role": null, "generation": null, "state": null, "seq": 0, "fingerprint": null, "path": null})
    );
    // The assignment writes the role files, stores the record and answers pending with the path.
    let fingerprint = role_fingerprint("a", "Role A definition.", &[]);
    let path = directory.join("agents").join("tab-aaaaaa").join("role.md");
    assert_eq!(
        ask(
            &store,
            json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"})
        ),
        json!({"role": "a", "generation": 1, "state": "pending", "seq": 1, "fingerprint": fingerprint, "path": path.display().to_string()})
    );
    assert_eq!(
        stored_role(&directory, "tab-aaaaaa"),
        json!({"id": "a", "generation": 1, "fingerprint": fingerprint, "confirmedFingerprint": null})
    );
    assert!(path.is_file(), "the role file is absent");
    // The confirmation of the current fingerprint stores the confirmation and gives ready.
    assert_eq!(
        ask(
            &store,
            json!({"kind": "roleConfirm", "tab": "tab-aaaaaa", "fingerprint": fingerprint})
        ),
        json!({"role": "a", "generation": 1, "state": "ready", "seq": 2, "fingerprint": fingerprint, "path": path.display().to_string()})
    );
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.role-state-idempotency
#[test]
fn the_repetitions_of_the_role_handshake_change_nothing() {
    let (directory, store) = fixture("idempotency");
    let fingerprint_a = role_fingerprint("a", "Role A definition.", &[]);
    let fingerprint_b = role_fingerprint("b", "Role B definition.", &[]);
    let path = directory.join("agents").join("tab-aaaaaa").join("role.md");
    ask(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"}),
    );
    use std::os::unix::fs::MetadataExt;
    let before = path.metadata().unwrap().ino();
    // A repeated assignment of the same role and definition writes no file: the inode stays the same.
    assert_eq!(
        ask(
            &store,
            json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"})
        ),
        json!({"role": "a", "generation": 1, "state": "pending", "seq": 1, "fingerprint": fingerprint_a, "path": path.display().to_string()})
    );
    assert_eq!(
        path.metadata().unwrap().ino(),
        before,
        "a repeated assignment wrote the role file again"
    );
    // A change to b and back to a returns the fingerprint of a, and a confirmation of it gives ready.
    ask(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "b"}),
    );
    assert_eq!(
        ask(
            &store,
            json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"})
        )["generation"],
        json!(3)
    );
    let ready = ask(
        &store,
        json!({"kind": "roleConfirm", "tab": "tab-aaaaaa", "fingerprint": fingerprint_a}),
    );
    // A repeated confirmation with the current fingerprint answers ready again and changes nothing, including seq.
    assert_eq!(
        ask(
            &store,
            json!({"kind": "roleConfirm", "tab": "tab-aaaaaa", "fingerprint": fingerprint_a})
        ),
        ready
    );
    // A confirmation of the earlier fingerprint of b is refused as stale, names the path and names no fingerprint.
    assert_eq!(
        refusal(
            &store,
            json!({"kind": "roleConfirm", "tab": "tab-aaaaaa", "fingerprint": fingerprint_b})
        ),
        format!(
            "stale fingerprint: read the role file again at {}",
            path.display()
        )
    );
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.role-state-invalid-input
#[test]
fn the_role_handshake_refuses_its_invalid_inputs() {
    let (directory, store) = fixture("invalid");
    ask(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"}),
    );
    // A role that roles.json does not define is refused, and the tab keeps its earlier role.
    assert_eq!(
        refusal(
            &store,
            json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "c"})
        ),
        "unknown agent role c"
    );
    assert_eq!(stored_role(&directory, "tab-aaaaaa")["id"], json!("a"));
    // A confirmation value of another form is refused before the stale rule.
    assert_eq!(
        refusal(
            &store,
            json!({"kind": "roleConfirm", "tab": "tab-aaaaaa", "fingerprint": "ZZZ"})
        ),
        "fingerprint ZZZ is not 16 lowercase hexadecimal characters"
    );
    // A tab without a role and a tab that no stored layout holds.
    assert_eq!(
        refusal(
            &store,
            json!({"kind": "roleConfirm", "tab": "tab-bbbbbb", "fingerprint": "0123456789abcdef"})
        ),
        "tab tab-bbbbbb has no role"
    );
    assert_eq!(
        refusal(
            &store,
            json!({"kind": "roleConfirm", "tab": "tab-zzzzzz", "fingerprint": "0123456789abcdef"})
        ),
        "surface \"tab-zzzzzz\" has no tab"
    );
    assert_eq!(
        refusal(
            &store,
            json!({"kind": "rolePut", "tab": "tab-zzzzzz", "role": "a"})
        ),
        "surface \"tab-zzzzzz\" has no tab"
    );
    // A stored content card without data is refused with the file and what the walk found; the fixed sidebar cards stay valid.
    let registry = directory.join("projects.json");
    let mut document: Value =
        serde_json::from_str(&fs::read_to_string(&registry).unwrap()).unwrap();
    document["projects"][0]["spaces"][0]["layout"]["state"]["root"]["kids"][1]["node"]
        .as_object_mut()
        .unwrap()
        .remove("data");
    fs::write(&registry, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
    assert_eq!(
        refusal(&store, json!({"kind": "role", "tab": "tab-aaaaaa"})),
        format!(
            "{}: a content card without a data object",
            registry.display()
        )
    );
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.role-state-clear-and-removal
#[test]
fn the_role_handshake_clears_and_ends_the_role_of_a_removed_tab() {
    let (directory, store) = fixture("clear");
    ask(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"}),
    );
    // Setting the role to null clears the record and removes the role files.
    assert_eq!(
        ask(
            &store,
            json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": null})
        ),
        json!({"role": null, "generation": null, "state": null, "seq": 2, "fingerprint": null, "path": null})
    );
    assert_eq!(stored_role(&directory, "tab-aaaaaa"), json!(null));
    assert!(!directory.join("agents").join("tab-aaaaaa").exists());
    // A removed tab refuses a later change and confirmation.
    ask(
        &store,
        json!({"kind": "rolePut", "tab": "tab-bbbbbb", "role": "a"}),
    );
    ask(&store, json!({"kind": "roleRemove", "tab": "tab-bbbbbb"}));
    assert_eq!(
        refusal(
            &store,
            json!({"kind": "rolePut", "tab": "tab-bbbbbb", "role": "b"})
        ),
        "tab tab-bbbbbb was removed; its role cannot change"
    );
    assert_eq!(
        refusal(
            &store,
            json!({"kind": "roleConfirm", "tab": "tab-bbbbbb", "fingerprint": "0123456789abcdef"})
        ),
        "tab tab-bbbbbb has no role"
    );
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.role-state-restart
#[test]
fn the_role_handshake_is_rebuilt_from_the_stored_record_after_a_restart() {
    let (directory, store) = fixture("restart");
    let fingerprint = role_fingerprint("a", "Role A definition.", &[]);
    ask(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"}),
    );
    // A restart without a stored confirmation answers pending; the seq of a new session starts at zero.
    let restarted = Workspace::new(directory.clone());
    assert_eq!(
        ask(&restarted, json!({"kind": "role", "tab": "tab-aaaaaa"})),
        json!({"role": "a", "generation": 1, "state": "pending", "seq": 0, "fingerprint": fingerprint,
            "path": directory.join("agents").join("tab-aaaaaa").join("role.md").display().to_string()})
    );
    // A restart with a stored confirmation answers ready without input.
    ask(
        &store,
        json!({"kind": "roleConfirm", "tab": "tab-aaaaaa", "fingerprint": fingerprint}),
    );
    let confirmed = ask(
        &Workspace::new(directory.clone()),
        json!({"kind": "role", "tab": "tab-aaaaaa"}),
    );
    assert_eq!(confirmed["state"], json!("ready"));
    let _ = fs::remove_dir_all(&directory);
}

// contract: roles.role-state-write-failures
#[test]
fn the_ordered_change_fails_at_its_steps_and_keeps_the_earlier_state() {
    // Step 1: the folder of the surface is a file, so the temporary write fails and nothing is stored.
    let (directory, store) = fixture("step1");
    fs::write(directory.join("agents"), "x").unwrap();
    let text = refusal(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"}),
    );
    assert!(
        text.starts_with(&format!(
            "role file {}: write failed: ",
            directory.join("agents").join("tab-aaaaaa").display()
        )),
        "the failed step 1 answered {text}"
    );
    assert_eq!(stored_role(&directory, "tab-aaaaaa"), json!(null));
    let _ = fs::remove_dir_all(&directory);

    // Step 2: a read-only configuration directory fails the store of projects.json; the temporary file is removed and the
    // stored role keeps its earlier value.
    let (directory, store) = fixture("step2");
    ask(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"}),
    );
    set_read_only(&directory);
    let text = refusal(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "b"}),
    );
    assert!(
        text.starts_with(&format!(
            "role file {}: write failed: ",
            directory.join("projects.json").display()
        )),
        "the failed step 2 answered {text}"
    );
    clear_read_only(&directory);
    assert_eq!(stored_role(&directory, "tab-aaaaaa")["id"], json!("a"));
    let leftovers: Vec<_> = fs::read_dir(directory.join("agents").join("tab-aaaaaa"))
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(".role-"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "the failed step 2 left temporary files"
    );
    let _ = fs::remove_dir_all(&directory);

    // Step 3: a directory in the place of role.ko.md fails its rename; the earlier record is restored.
    let (directory, store) = fixture("step3");
    ask(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "a"}),
    );
    fs::remove_file(
        directory
            .join("agents")
            .join("tab-aaaaaa")
            .join("role.ko.md"),
    )
    .unwrap();
    fs::create_dir(
        directory
            .join("agents")
            .join("tab-aaaaaa")
            .join("role.ko.md"),
    )
    .unwrap();
    let text = refusal(
        &store,
        json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": "b"}),
    );
    assert!(
        text.starts_with(&format!(
            "role file {}: rename failed: ",
            directory
                .join("agents")
                .join("tab-aaaaaa")
                .join("role.ko.md")
                .display()
        )),
        "the failed step 3 answered {text}"
    );
    assert_eq!(stored_role(&directory, "tab-aaaaaa")["id"], json!("a"));
    let _ = fs::remove_dir_all(&directory);
}

/// Removes the write permission of the configuration directory, so a write inside it fails.
fn set_read_only(directory: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(directory).unwrap().permissions().mode();
    fs::set_permissions(directory, fs::Permissions::from_mode(mode & !0o222)).unwrap();
}

/// Gives the write permission of the configuration directory back.
fn clear_read_only(directory: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(directory).unwrap().permissions().mode();
    fs::set_permissions(directory, fs::Permissions::from_mode(mode | 0o200)).unwrap();
}

// contract: roles.role-state-serialization
#[test]
fn the_role_operations_of_one_surface_run_in_arrival_order() {
    let (directory, store) = fixture("order");
    let fingerprint_a = role_fingerprint("a", "Role A definition.", &[]);
    let fingerprint_b = role_fingerprint("b", "Role B definition.", &[]);
    // Consecutive changes a to b to a raise the generation at each change.
    for (step, generation) in [("a", 1), ("b", 2), ("a", 3)] {
        let answer = ask(
            &store,
            json!({"kind": "rolePut", "tab": "tab-aaaaaa", "role": step}),
        );
        assert_eq!(
            answer["generation"],
            json!(generation),
            "the change to {step}"
        );
    }
    // A confirmation of the earlier fingerprint of b is refused as stale; the confirmation of the current one of a is
    // accepted, because each is judged against the state at its turn.
    let stale = refusal(
        &store,
        json!({"kind": "roleConfirm", "tab": "tab-aaaaaa", "fingerprint": fingerprint_b}),
    );
    assert!(
        stale.starts_with("stale fingerprint: read the role file again at "),
        "answered {stale}"
    );
    // The change back to a returned the fingerprint of a, so a confirmation of it is correct, not stale.
    let ready = ask(
        &store,
        json!({"kind": "roleConfirm", "tab": "tab-aaaaaa", "fingerprint": fingerprint_a}),
    );
    assert_eq!(ready["state"], json!("ready"));
    fs::remove_dir_all(&directory).unwrap();
}
