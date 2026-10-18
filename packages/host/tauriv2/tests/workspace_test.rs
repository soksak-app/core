//! Tests of the settings and project list store and the project directory check.

use std::fs;
use std::path::Path;

#[path = "support/records.rs"]
mod records;

use serde_json::{Value, json};
use soksak_host_tauriv2::platform;
use soksak_host_tauriv2::projects::folder;
use soksak_host_tauriv2::workspace::{Workspace, prepare_config_directory};

fn apply(store: &Workspace, request: Value) -> Value {
    store
        .apply(serde_json::from_value(request).unwrap())
        .unwrap()
}

fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

// contract: workspace.settings.project-file-holds-only-overrides, workspace.settings.persist-across-reopen, workspace.settings.reset-removes-override, workspace.settings.rejects-project-opening-override, workspace.settings.invalid-common-file-not-overwritten
#[test]
fn settings_use_common_and_project_files_and_reset_removes_override() {
    let config = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let store = Workspace::new(config.path().into());
    apply(
        &store,
        json!({"kind":"add", "project":{"id":"prj-test", "root":root.path(), "identity":"1:2"}}),
    );
    apply(
        &store,
        json!({"kind":"settings", "patch":{"mode":"light", "gap":6, "projectOpening":"windows"}}),
    );
    apply(
        &store,
        json!({"kind":"settings", "id":"prj-test", "patch":{"gap":12}}),
    );
    assert_eq!(
        read(&root.path().join(".soksak/settings.json")),
        json!({"gap":12})
    );
    let reopened = Workspace::new(config.path().into());
    let snapshot = apply(&reopened, json!({"kind":"snapshot"}));
    assert_eq!(snapshot["common"]["mode"], "light");
    assert_eq!(snapshot["projects"][0]["settings"], json!({"gap":12}));
    apply(
        &store,
        json!({"kind":"settings", "id":"prj-test", "remove":["gap"]}),
    );
    assert_eq!(
        read(&root.path().join(".soksak/settings.json")),
        json!({"format": 1})
    );
    assert!(
        store
            .apply(
                serde_json::from_value(
                    json!({"kind":"settings", "id":"prj-test", "patch":{"projectOpening":"tabs"}})
                )
                .unwrap()
            )
            .is_err()
    );
    fs::write(config.path().join("settings.json"), "{broken").unwrap();
    assert!(
        store
            .apply(serde_json::from_value(json!({"kind":"settings", "patch":{"gap":2}})).unwrap())
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(config.path().join("settings.json")).unwrap(),
        "{broken"
    );
}

// contract: workspace.settings.concurrent-patches-preserved, workspace.projects.move-reorders, workspace.projects.remove-keeps-remaining-order
#[test]
fn concurrent_updates_preserve_fields_and_saved_project_order() {
    let config = tempfile::tempdir().unwrap();
    let roots: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let store = std::sync::Arc::new(Workspace::new(config.path().into()));
    for (i, root) in roots.iter().enumerate() {
        apply(
            &store,
            json!({"kind":"add", "project":{"id":format!("p{i}"), "root":root.path(), "identity":i.to_string()}}),
        );
    }
    let jobs: Vec<_> = ["mode", "theme", "rail"]
        .iter()
        .map(|key| {
            let store = store.clone();
            std::thread::spawn(move || {
                apply(
                    &store,
                    json!({"kind":"settings", "patch":{key.to_string():key}}),
                )
            })
        })
        .collect();
    for job in jobs {
        job.join().unwrap();
    }
    apply(&store, json!({"kind":"move", "id":"p2", "delta":-2}));
    let snapshot = apply(&store, json!({"kind":"snapshot"}));
    assert_eq!(snapshot["common"].as_object().unwrap().len(), 3);
    assert_eq!(snapshot["projects"][0]["id"], "p2");
    apply(&store, json!({"kind":"remove", "id":"p2"}));
    assert_eq!(
        apply(&store, json!({"kind":"snapshot"}))["projects"][0]["id"],
        "p0"
    );
}

// contract: workspace.folder.aliases-share-identity, workspace.folder.rejects-file
#[test]
fn directory_aliases_have_one_identity() {
    let root = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let alias = parent.path().join("alias");
    std::os::unix::fs::symlink(root.path(), &alias).unwrap();
    let first =
        serde_json::to_value(folder(root.path().to_str().unwrap(), root.path()).unwrap()).unwrap();
    let second =
        serde_json::to_value(folder(alias.to_str().unwrap(), root.path()).unwrap()).unwrap();
    assert_eq!(first, second);
    let file = root.path().join("file");
    fs::write(&file, "x").unwrap();
    assert!(folder(file.to_str().unwrap(), root.path()).is_err());
}

// contract: workspace.config-dir.creates-requested-path, workspace.config-dir.rejects-empty-path, workspace.config-dir.rejects-path-under-file
#[test]
fn config_directory_is_created_and_canonical() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("new").join("configuration");
    let prepared = prepare_config_directory(&path, create).unwrap();
    assert_eq!(prepared, fs::canonicalize(&path).unwrap());
    assert!(prepared.is_dir(), "configuration directory was not created");
    assert!(
        prepare_config_directory(Path::new(""), create).is_err(),
        "empty path was accepted"
    );
    let file = root.path().join("file");
    fs::write(&file, "unchanged").unwrap();
    assert!(
        prepare_config_directory(&file.join("config"), create).is_err(),
        "a file was treated as a configuration directory"
    );
}

/// The platform operation that creates directories for the current user only.
fn create(path: &Path) -> Result<(), String> {
    platform::current()?.create_private_directories(path)
}

// contract: workspace.config-dir.creates-owner-only
#[test]
fn a_created_config_directory_is_owner_only_and_an_existing_one_keeps_its_mode() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let created = prepare_config_directory(&root.path().join("created"), create).unwrap();
    assert_eq!(
        fs::metadata(&created).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let existing = root.path().join("existing");
    fs::create_dir(&existing).unwrap();
    fs::set_permissions(&existing, fs::Permissions::from_mode(0o755)).unwrap();
    let kept = prepare_config_directory(&existing, create).unwrap();
    assert_eq!(
        fs::metadata(&kept).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

// contract: workspace.projects.plugin-data-patched
#[test]
fn a_project_patch_stores_plugin_data_and_rejects_unknown_fields() {
    let config = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let store = Workspace::new(config.path().into());
    apply(
        &store,
        json!({"kind":"add", "project":{"id":"prj-test", "root":root.path(), "identity":"1:2"}}),
    );
    apply(
        &store,
        json!({"kind":"patch", "id":"prj-test", "patch":{"plugins":{"probe":{"marks":["a.txt"]}}}}),
    );
    let snapshot = apply(
        &Workspace::new(config.path().into()),
        json!({"kind":"snapshot"}),
    );
    assert_eq!(
        snapshot["projects"][0]["plugins"],
        json!({"probe":{"marks":["a.txt"]}})
    );
    assert!(
        store
            .apply(
                serde_json::from_value(
                    json!({"kind":"patch", "id":"prj-test", "patch":{"other":1}})
                )
                .unwrap()
            )
            .is_err()
    );
}

// contract: workspace.folder.messages
#[test]
fn folder_errors_name_the_folder_once() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("gone").join("child");
    assert_eq!(
        folder(missing.to_str().unwrap(), root.path()).unwrap_err(),
        format!("project directory does not exist: {}", missing.display())
    );
    let file = root.path().join("file");
    fs::write(&file, "x").unwrap();
    assert_eq!(
        folder(file.to_str().unwrap(), root.path()).unwrap_err(),
        format!(
            "not a project directory: {}",
            fs::canonicalize(&file).unwrap().display()
        )
    );
    let closed = root.path().join("closed");
    fs::create_dir(&closed).unwrap();
    fs::set_permissions(&closed, fs::Permissions::from_mode(0o0)).unwrap();
    let inside = closed.join("child");
    let result = folder(inside.to_str().unwrap(), root.path());
    fs::set_permissions(&closed, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        result.unwrap_err(),
        format!("project directory is not readable: {}", inside.display())
    );
}

// contract: workspace.projects.move-requires-delta
#[test]
fn move_without_delta_is_refused() {
    let config = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let store = Workspace::new(config.path().into());
    apply(
        &store,
        json!({"kind":"add", "project":{"id":"first", "root":root.path(), "identity":"first"}}),
    );
    for request in [
        json!({"kind":"move", "id":"first"}),
        json!({"kind":"move", "id":"first", "delta":null}),
    ] {
        let error = store
            .apply(serde_json::from_value(request.clone()).unwrap())
            .unwrap_err();
        assert_eq!(error.to_string(), "move delta is missing", "{request}");
    }
}

// contract: workspace.settings.rejects-project-text-size-override
#[test]
fn a_project_text_size_override_is_rejected() {
    let config = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let store = Workspace::new(config.path().into());
    apply(
        &store,
        json!({"kind":"add", "project":{"id":"prj-test", "root":root.path(), "identity":"1:2"}}),
    );
    let refused = store.apply(
        serde_json::from_value(
            json!({"kind":"settings", "id":"prj-test", "patch":{"textSize":1.5}}),
        )
        .unwrap(),
    );
    assert_eq!(refused.err(), Some("textSize is common-only".to_string()));
    let path = root.path().join(".soksak/settings.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"{"textSize":1.5}"#).unwrap();
    let refused = store.apply(serde_json::from_value(json!({"kind":"snapshot"})).unwrap());
    assert_eq!(
        refused.err(),
        Some(format!("{}: textSize is common-only", path.display()))
    );
}

// contract: workspace.settings.records-each-change
#[test]
fn each_settings_change_is_recorded_with_its_keys() {
    // The writer of the records belongs to the process, so the scenario runs in a child process.
    if let Some(config) = std::env::var_os("SOKSAK_SETTINGS_CHILD") {
        let config = std::path::PathBuf::from(config);
        let root = tempfile::tempdir().unwrap();
        let writer = records::start_writer(&config);
        let store = Workspace::new(config.clone());
        for request in [
            json!({"kind":"add", "project":{"id":"prj-test", "root":root.path(), "identity":"1:2"}}),
            json!({"kind":"settings", "patch":{"mode":"light", "gap":6}}),
            json!({"kind":"settings", "remove":["gap", "missing"]}),
            json!({"kind":"settings", "id":"prj-test", "patch":{"gap":12}}),
        ] {
            apply(&store, request);
        }
        writer.flush(std::time::Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "each_settings_change_is_recorded_with_its_keys",
            "--nocapture",
        ])
        .env("SOKSAK_SETTINGS_CHILD", config.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the child check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let seen: Vec<String> = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| event["event"] == "host.workspace.settings")
        .map(|event| {
            let fields = &event["fields"];
            format!(
                "{} set={} removed={}",
                fields["scope"].as_str().unwrap(),
                fields["set"].as_str().unwrap(),
                fields["removed"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            "common set=gap,mode removed=",
            "common set= removed=gap",
            "prj-test set=gap removed="
        ]
    );
}

// contract: workspace.tab-state.put-keeps-other-entries
#[test]
fn tab_state_put_keeps_other_entries() {
    let config = tempfile::tempdir().unwrap();
    let first = Workspace::new(config.path().into());
    let second = Workspace::new(config.path().into());
    assert_eq!(apply(&first, json!({"kind":"tabState"})), Value::Null);
    let written = apply(
        &first,
        json!({"kind":"tabStatePut", "tab":"tab-a", "entry":{"kept":true}}),
    );
    assert!(written.as_u64().unwrap() > 0, "{written}");
    apply(
        &second,
        json!({"kind":"tabStatePut", "tab":"tab-b", "entry":{"label":"b", "state":{"format":1, "value":{"x":1}}}}),
    );
    assert_eq!(
        apply(&first, json!({"kind":"tabState"})),
        json!({"format":1, "tabs":{"tab-a":{"kept":true}, "tab-b":{"label":"b", "state":{"format":1, "value":{"x":1}}}}})
    );
    let last = apply(
        &second,
        json!({"kind":"tabStatePut", "tab":"tab-a", "entry":null}),
    );
    let size = fs::metadata(config.path().join("tab-state.json"))
        .unwrap()
        .len();
    assert_eq!(last.as_u64(), Some(size));
    assert_eq!(
        apply(&first, json!({"kind":"tabState"})),
        json!({"format":1, "tabs":{"tab-b":{"label":"b", "state":{"format":1, "value":{"x":1}}}}})
    );
}

// contract: workspace.tab-session.put-rewrites-own-file
#[test]
fn tab_session_put_rewrites_only_its_own_file() {
    let config = tempfile::tempdir().unwrap();
    let store = Workspace::new(config.path().into());
    assert_eq!(
        apply(&store, json!({"kind":"tabSession", "tab":"tab-a"})),
        Value::Null
    );
    assert_eq!(apply(&store, json!({"kind":"tabSessions"})), json!([]));
    apply(
        &store,
        json!({"kind":"tabStatePut", "tab":"tab-a", "entry":{"kept":true}}),
    );
    let state = fs::read(config.path().join("tab-state.json")).unwrap();
    let written = apply(
        &store,
        json!({"kind":"tabSessionPut", "tab":"tab-a", "regions":{"page":{"session":"AAAA"}}}),
    );
    apply(
        &store,
        json!({"kind":"tabSessionPut", "tab":"tab-b", "regions":{"page":{"session":"BBBB"}}}),
    );
    let path = config.path().join("tab-sessions").join("tab-a.json");
    let other = fs::read(config.path().join("tab-sessions").join("tab-b.json")).unwrap();
    assert_eq!(written.as_u64(), Some(fs::metadata(&path).unwrap().len()));
    apply(
        &store,
        json!({"kind":"tabSessionPut", "tab":"tab-a", "regions":{"page":{"session":"CCCC"}, "side":{"session":"DDDD"}}}),
    );
    assert_eq!(
        apply(&store, json!({"kind":"tabSession", "tab":"tab-a"})),
        json!({"format":1, "regions":{"page":{"session":"CCCC"}, "side":{"session":"DDDD"}}})
    );
    assert_eq!(
        fs::read(config.path().join("tab-sessions").join("tab-b.json")).unwrap(),
        other
    );
    assert_eq!(
        fs::read(config.path().join("tab-state.json")).unwrap(),
        state
    );
    assert_eq!(
        apply(&store, json!({"kind":"tabSessions"})),
        json!(["tab-a", "tab-b"])
    );
    assert_eq!(
        apply(
            &store,
            json!({"kind":"tabSessionPut", "tab":"tab-a", "regions":null})
        ),
        Value::Null
    );
    assert!(!path.exists());
    assert_eq!(
        apply(
            &store,
            json!({"kind":"tabSessionPut", "tab":"tab-a", "regions":null})
        ),
        Value::Null
    );
    assert_eq!(
        apply(&store, json!({"kind":"tabSessions"})),
        json!(["tab-b"])
    );
}

// contract: workspace.tab-session.rejects-other-format, workspace.tab-session.rejects-invalid-request
#[test]
fn tab_session_rejects_other_format_and_invalid_requests() {
    let config = tempfile::tempdir().unwrap();
    let store = Workspace::new(config.path().into());
    let refused = |request: Value| {
        store
            .apply(serde_json::from_value(request).unwrap())
            .unwrap_err()
    };
    let folder = config.path().join("tab-sessions");
    fs::create_dir_all(&folder).unwrap();
    let path = folder.join("tab-a.json");
    for (text, found) in [
        (
            r#"{"format":2,"regions":{}}"#,
            "tab session format 2 is not 1",
        ),
        (r#"{"regions":{}}"#, "tab session format missing is not 1"),
        (
            r#"{"format":1,"regions":[]}"#,
            "tab session regions is not an object",
        ),
    ] {
        fs::write(&path, text).unwrap();
        assert_eq!(
            refused(json!({"kind":"tabSession", "tab":"tab-a"})),
            format!("{}: {found}", path.display())
        );
    }
    for (request, want) in [
        (json!({"kind":"tabSession"}), "tab session requires a tab"),
        (
            json!({"kind":"tabSession", "tab":"../tab-a"}),
            "invalid tab session tab: ../tab-a",
        ),
        (
            json!({"kind":"tabSessionPut", "tab":"tab-a", "regions":{}}),
            "invalid tab session of tab-a: empty",
        ),
        (
            json!({"kind":"tabSessionPut", "tab":"tab-a", "regions":{"page":{"session":""}}}),
            "invalid tab session region of tab-a: page",
        ),
        (
            json!({"kind":"tabSessionPut", "tab":"tab-a", "regions":{"page":{"session":"A", "other":1}}}),
            "invalid tab session region of tab-a: page",
        ),
        (
            json!({"kind":"tabSessionPut", "tab":"tab-a", "regions":{"page":"A"}}),
            "invalid tab session region of tab-a: page",
        ),
    ] {
        assert_eq!(refused(request), want);
    }
}

// contract: workspace.tab-state.rejects-other-format, workspace.tab-state.rejects-invalid-entry
#[test]
fn tab_state_rejects_other_format_and_invalid_entries() {
    let config = tempfile::tempdir().unwrap();
    let store = Workspace::new(config.path().into());
    let path = config.path().join("tab-state.json");
    fs::write(&path, r#"{"format":2,"tabs":{}}"#).unwrap();
    let put = |tab: &str, entry: Value| {
        store
            .apply(
                serde_json::from_value(json!({"kind":"tabStatePut", "tab":tab, "entry":entry}))
                    .unwrap(),
            )
            .unwrap_err()
    };
    assert_eq!(
        put("tab-a", json!({"kept":true})),
        format!("{}: tab state format 2 is not 1", path.display())
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        r#"{"format":2,"tabs":{}}"#
    );
    fs::remove_file(&path).unwrap();
    for (tab, entry, want) in [
        ("", json!({"kept":true}), "tab state put requires a tab"),
        (
            "tab-a",
            json!({}),
            "invalid tab state entry of tab-a: empty",
        ),
        (
            "tab-a",
            json!({"kept":false}),
            "invalid tab state entry of tab-a: kept",
        ),
        (
            "tab-a",
            json!({"label":""}),
            "invalid tab state entry of tab-a: label",
        ),
        (
            "tab-a",
            json!({"state":{"format":0, "value":1}}),
            "invalid tab state entry of tab-a: state",
        ),
        (
            "tab-a",
            json!({"state":{"format":1}}),
            "invalid tab state entry of tab-a: state",
        ),
        (
            "tab-a",
            json!({"other":1}),
            "invalid tab state entry of tab-a: other",
        ),
    ] {
        assert_eq!(put(tab, entry.clone()), want, "{tab} {entry}");
    }
}
