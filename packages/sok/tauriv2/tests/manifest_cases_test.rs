//! Replays every case of the manifest case table (docs/spec/cases/manifest-validation.json, the table the
//! page reader replays) through plugin install of a release (docs/spec/installation.md#plugin-release).

use std::path::Path;

use serde::Deserialize;
use serde_json::{Value, json};

#[path = "support/folder.rs"]
mod folder;
#[path = "support/plugin_release.rs"]
mod plugin_release;

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

/// A registry index whose plugin probe 0.2.0 is the release at path with sum.
fn index_for_release(path: &Path, sum: &str) -> Folder {
    let dir = Folder::new("manifest-index");
    let plugin = json!({"id": "probe", "package": "@scope/plugin-probe", "name": "Probe",
        "description": "검사용 plugin.", "license": "MIT", "repository": "https://example.invalid/probe",
        "versions": [{"version": "0.2.0",
            "release": {"url": format!("file://{}", path.display()), "sha256": sum},
            "engines": {"soksak": "^0.0.2"}, "sidecars": {}}]});
    let index = json!({"format": 1, "plugins": [plugin], "sidecars": [], "packs": [],
        "revoked": {"plugins": [], "sidecars": []}});
    write_tree(dir.path(), &[("index.json", &index.to_string())]);
    dir
}

// contract: install.manifest.replays-manifest-cases
#[test]
fn plugin_install_replays_the_manifest_cases() {
    let mut failures = Vec::new();
    for case in cases() {
        let package = json!({"name": "@scope/plugin-probe", "version": "0.2.0",
            "engines": {"soksak": "^0.0.2"}, "files": case.package_files});
        let dir = Folder::new("manifest-plugin");
        write_tree(
            dir.path(),
            &[
                ("package.json", &package.to_string()),
                ("plugin.json", &case.manifest.to_string()),
            ],
        );
        for file in case
            .package_files
            .iter()
            .filter(|file| file.as_str() != "plugin.json")
        {
            write_tree(dir.path(), &[(file.as_str(), "")]);
        }
        let out = Folder::new("manifest-release");
        let release = plugin_release::pack(dir.path(), out.path());
        let index = index_for_release(
            Path::new(release["release"].as_str().unwrap()),
            release["sha256"].as_str().unwrap(),
        );
        let config = Folder::new("manifest-config");
        let (code, _, stderr) = run(&[
            "registry",
            "use",
            &format!("{}/index.json", index.text()),
            "--config-dir",
            config.text(),
        ]);
        assert_eq!(code, 0, "registry use: {stderr}");
        let (code, _, stderr) = run(&["plugin", "install", "probe", "--config-dir", config.text()]);
        let installed = config.path().join("plugins/installed.json").exists();
        let ok = if case.accepted {
            // The index holds no dependency of the plugin, so an accepted manifest with dependencies passes the reader
            // and stops at the dependency check of the registry.
            (code == 0 && installed)
                || (code == 1 && stderr.starts_with("sok: probe 0.2.0: dependency ") && !installed)
        } else {
            // Install parses plugin.json before the reader runs and refuses a value that is not an object with its
            // location; the reader text of that case names plugin.json itself.
            let want = if case.manifest.is_object() {
                format!(
                    "sok: plugin probe 0.2.0 package: plugin.json: {}\n",
                    case.error
                )
            } else {
                "sok: plugin probe 0.2.0 package: plugin.json: expected an object\n".to_string()
            };
            code == 1 && stderr == want && !installed
        };
        if !ok {
            failures.push(format!("{}: code {code} stderr {stderr:?}", case.id));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
