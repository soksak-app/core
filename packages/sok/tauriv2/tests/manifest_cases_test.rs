//! Replays every case of the manifest case table (docs/spec/cases/manifest-validation.json, the table the
//! page reader replays) through plugin pack and plugin install (docs/spec/installation.md#plugin-release).

use std::path::Path;

use serde::Deserialize;
use serde_json::{Value, json};

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

/// One case of the table: a manifest, and either `accepted` or the reader's error text.
#[derive(Deserialize)]
struct ManifestCase {
    id: String,
    manifest: Value,
    accepted: bool,
    #[serde(default)]
    error: String,
    #[serde(default, rename = "packageFiles")]
    package_files: Vec<String>,
}

fn run(args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (vec![], vec![]);
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(Path::new("/nonexistent/paths.d")),
        core_version: "0.0.2",
    };
    let code = soksak_sok::run(&args, &mut stdout, &mut stderr, &options);
    (
        code,
        String::from_utf8(stdout).expect("stdout"),
        String::from_utf8(stderr).expect("stderr"),
    )
}

/// Writes the contents of each path, creating its folders.
fn write_tree(dir: &Path, files: &[(&str, &str)]) {
    for (name, content) in files {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
    }
}

/// The cases of the table, read from the repository path of the table.
fn cases() -> Vec<ManifestCase> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/manifest-validation.json"
    );
    let text = std::fs::read_to_string(path).expect("manifest case table");
    let table: Value = serde_json::from_str(&text).expect("manifest case table JSON");
    let cases: Vec<ManifestCase> =
        serde_json::from_value(table["cases"].clone()).expect("manifest cases");
    assert!(!cases.is_empty(), "the manifest case table holds no case");
    cases
}

/// A registry index whose plugin probe has one release of version 0.2.0 that is not read: the test extracts the folder of
/// the release first, so installation reads its plugin.json.
fn index_for_probe() -> Folder {
    let dir = Folder::new("manifest-cases");
    let plugin = json!({"id": "probe", "package": "@scope/plugin-probe", "name": "Probe",
        "description": "검사용 plugin.", "license": "MIT", "repository": "https://example.invalid/probe",
        "versions": [{"version": "0.2.0",
            "release": {"url": "file:///nonexistent/probe-0.2.0.tgz", "sha256": "0".repeat(64)},
            "engines": {"soksak": "^0.0.2"}, "sidecars": {}}]});
    let index = json!({"format": 1, "plugins": [plugin], "sidecars": [], "packs": [],
        "revoked": {"plugins": [], "sidecars": []}});
    write_tree(dir.path(), &[("index.json", &index.to_string())]);
    dir
}

// contract: cli.pack.replays-manifest-cases
#[test]
fn plugin_pack_replays_the_manifest_cases() {
    let mut failures = Vec::new();
    for case in cases() {
        let files = if case.package_files.is_empty() {
            vec!["plugin.json".to_string()]
        } else {
            case.package_files.clone()
        };
        let package = json!({"name": "@scope/plugin-probe", "version": "0.2.0",
            "engines": {"soksak": "^0.0.2"}, "files": files});
        let dir = Folder::new("manifest-pack");
        write_tree(
            dir.path(),
            &[
                ("package.json", &package.to_string()),
                ("plugin.json", &case.manifest.to_string()),
            ],
        );
        for file in files.iter().filter(|file| file.as_str() != "plugin.json") {
            write_tree(dir.path(), &[(file.as_str(), "")]);
        }
        let out = Folder::new("manifest-out");
        let (code, _, stderr) = run(&["plugin", "pack", dir.text(), out.text()]);
        let ok = if case.accepted {
            code == 0
        } else {
            code == 1 && stderr == format!("sok: {}\n", case.error)
        };
        if !ok {
            failures.push(format!("{}: code {code} stderr {stderr:?}", case.id));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// contract: install.manifest.replays-manifest-cases
#[test]
fn plugin_install_replays_the_refused_manifest_cases_of_the_probe() {
    let mut failures = Vec::new();
    for case in cases() {
        // Installation checks the plugin id of the installation record first, so the cases of the id probe are replayed
        // here; the other cases are replayed by the pack test, which runs the same validation.
        if case.accepted || case.manifest.get("id") != Some(&json!("probe")) {
            continue;
        }
        let index = index_for_probe();
        let config = Folder::new("manifest-config");
        let (code, _, stderr) = run(&[
            "registry",
            "use",
            &format!("{}/index.json", index.text()),
            "--config-dir",
            config.text(),
        ]);
        assert_eq!(code, 0, "registry use: {stderr}");
        let folder = config.path().join("plugins/probe/0.2.0");
        write_tree(
            folder.as_path(),
            &[
                (
                    "package.json",
                    r#"{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"}, "files": ["plugin.json"]}"#,
                ),
                ("plugin.json", &case.manifest.to_string()),
            ],
        );
        let (code, _, stderr) = run(&["plugin", "install", "probe", "--config-dir", config.text()]);
        let want = format!("sok: {}/plugin.json: {}\n", folder.display(), case.error);
        if code != 1 || stderr != want || config.path().join("plugins/installed.json").exists() {
            failures.push(format!(
                "{}: code {code} stderr {stderr:?}, want {want:?}",
                case.id
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
