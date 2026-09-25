//! 설정과 프로젝트 목록 저장소, 프로젝트 디렉터리 확인 테스트.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use soksak_host_tauriv2::platform;
use soksak_host_tauriv2::projects::folder;
use soksak_host_tauriv2::workspace::{prepare_config_directory, Workspace};

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
        json!({})
    );
    assert!(store
        .apply(
            serde_json::from_value(
                json!({"kind":"settings", "id":"prj-test", "patch":{"projectOpening":"tabs"}})
            )
            .unwrap()
        )
        .is_err());
    fs::write(config.path().join("settings.json"), "{broken").unwrap();
    assert!(store
        .apply(serde_json::from_value(json!({"kind":"settings", "patch":{"gap":2}})).unwrap())
        .is_err());
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

/// 플랫폼의 사용자 전용 디렉터리 생성이다.
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
    assert!(store
        .apply(
            serde_json::from_value(json!({"kind":"patch", "id":"prj-test", "patch":{"other":1}}))
                .unwrap()
        )
        .is_err());
}
