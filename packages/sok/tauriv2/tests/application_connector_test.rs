//! Checks that installing a connector plugin connects its application (docs/spec/installation.md#applications): the
//! installer tries the locate entries of the platform it runs on and records an application it finds without installing
//! anything, refuses a platform that the application does not support with installed.json unchanged, and removing the
//! plugin removes the entry of a located application and leaves the application itself.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde_json::{Value, json};
use soksak_sok::application::{APPLICATIONS, ApplicationRecord, read_applications};

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

fn run_json(args: &[&str]) -> Value {
    let (code, stdout, stderr) = run(args);
    assert_eq!(code, 0, "{args:?}: {stderr}");
    serde_json::from_str(&stdout).expect("JSON result")
}

fn write(path: &Path, content: &str, mode: u32) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// A registry with one release of the connector plugin probe whose plugin.json declares the application, and the folder
/// of the release that the registry names.
fn connector_registry(application: &Value) -> (tempfile::TempDir, tempfile::TempDir) {
    let releases = tempfile::tempdir().unwrap();
    let plugin = tempfile::tempdir().unwrap();
    write(
        &plugin.path().join("package.json"),
        r#"{"name": "@scope/plugin-probe", "version": "0.1.0", "engines": {"soksak": "^0.0.2"}, "files": ["plugin.json"]}"#,
        0o644,
    );
    let manifest = json!({"id": "probe", "name": "Probe", "description": "Connects an application.", "application": application});
    write(
        &plugin.path().join("plugin.json"),
        &manifest.to_string(),
        0o644,
    );
    let packed = run_json(&[
        "plugin",
        "pack",
        plugin.path().to_str().unwrap(),
        releases.path().to_str().unwrap(),
    ]);
    let registry = tempfile::tempdir().unwrap();
    let entry = json!({"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
        "license": "MIT", "repository": "https://example.invalid/probe", "versions": [{"version": "0.1.0",
        "release": {"url": format!("file://{}", packed["release"].as_str().unwrap()), "sha256": packed["sha256"]},
        "engines": {"soksak": "^0.0.2"}, "sidecars": {}}]});
    write(
        &registry.path().join("plugins/probe.json"),
        &entry.to_string(),
        0o644,
    );
    write(
        &registry.path().join("revoked.json"),
        r#"{"plugins": [], "sidecars": []}"#,
        0o644,
    );
    run_json(&["registry", "build", registry.path().to_str().unwrap()]);
    // The registry names the release file in the folder of the releases, so both stay until the check ends.
    (registry, releases)
}

/// An application whose only platform entry finds an executable at path and whose recipe is never run.
fn sketcher(platform: &str, path: &Path) -> Value {
    json!({"id": "sketcher", "name": "Sketcher", "version": "1.0.0", "platforms": {platform: {
        "locate": [{"path": path}],
        "recipe": {"kind": "release", "url": "https://example.invalid/sketcher.zip", "sha256": "a".repeat(64), "unpack": "zip"},
        "program": "sketcher"
    }}})
}

// contract: application.connector.connects-installed
#[test]
fn installing_a_connector_connects_an_application_that_is_installed() {
    let platform = soksak_sok::current_platform().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let present = elsewhere.path().join("sketcher");
    write(&present, "#!/bin/sh\n", 0o755);
    let (registry, _releases) = connector_registry(&sketcher(&platform, &present));
    let config = tempfile::tempdir().unwrap();
    let config_text = config.path().to_str().unwrap();
    run_json(&[
        "registry",
        "use",
        registry.path().join("index.json").to_str().unwrap(),
        "--config-dir",
        config_text,
    ]);
    run_json(&["plugin", "install", "probe", "--config-dir", config_text]);
    let state = read_applications(config.path()).unwrap();
    let want = ApplicationRecord {
        version: "1.0.0".into(),
        path: present.display().to_string(),
        how: "located".into(),
        method: "path".into(),
    };
    assert_eq!(state.applications.get("sketcher"), Some(&want));
    assert!(
        !config.path().join("applications").exists(),
        "a located application was installed"
    );
    let (code, _, stderr) = run(&["plugin", "remove", "probe", "--config-dir", config_text]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        read_applications(config.path())
            .unwrap()
            .applications
            .is_empty()
    );
    assert!(
        present.exists(),
        "removing the connector touched the located application"
    );
}

// contract: application.connector.refuses-other-platform
#[test]
fn a_connector_for_another_platform_is_refused_and_changes_nothing() {
    let platform = soksak_sok::current_platform().unwrap();
    let other = if platform == "windows-x64" {
        "linux-x64"
    } else {
        "windows-x64"
    };
    let (registry, _releases) =
        connector_registry(&sketcher(other, Path::new("/nonexistent/sketcher")));
    let config = tempfile::tempdir().unwrap();
    let config_text = config.path().to_str().unwrap();
    run_json(&[
        "registry",
        "use",
        registry.path().join("index.json").to_str().unwrap(),
        "--config-dir",
        config_text,
    ]);
    let (code, _, stderr) = run(&["plugin", "install", "probe", "--config-dir", config_text]);
    assert!(
        code != 0 && stderr.contains(&format!("application sketcher does not support {platform}")),
        "{code} {stderr}"
    );
    assert!(!config.path().join("plugins/installed.json").exists());
    assert!(!config.path().join(APPLICATIONS).exists());
}

/// The events of the event files of the configuration, in their order.
fn events_of(config: &Path) -> Vec<Value> {
    let mut events = vec![];
    let mut files: Vec<_> = std::fs::read_dir(config.join("logs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .collect();
    files.sort();
    for file in files {
        for line in std::fs::read_to_string(&file).unwrap().lines() {
            events.push(serde_json::from_str(line).unwrap());
        }
    }
    events
}

// contract: application.connector.steps-observed-and-stored
/// Each step of the connection reaches the observer of the operation, and the command line stores it in its event file.
#[test]
fn each_step_of_the_connection_is_observed_and_stored() {
    let platform = soksak_sok::current_platform().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let present = elsewhere.path().join("sketcher");
    write(&present, "#!/bin/sh\n", 0o755);
    let (registry, _releases) = connector_registry(&sketcher(&platform, &present));
    let index = registry.path().join("index.json");

    let config = tempfile::tempdir().unwrap();
    run_json(&[
        "registry",
        "use",
        index.to_str().unwrap(),
        "--config-dir",
        config.path().to_str().unwrap(),
    ]);
    let mut steps = vec![];
    soksak_sok::plugins::run_plugin_action(
        config.path(),
        "install",
        "probe",
        "0.0.2",
        &platform,
        &mut |step| steps.push(step),
    )
    .unwrap();
    assert_eq!(steps.len(), 2, "{steps:?}");
    assert!(
        steps[0].step == "locate" && steps[0].ok && steps[0].method == "path",
        "{steps:?}"
    );
    assert!(steps[1].step == "record" && steps[1].ok, "{steps:?}");

    let logged = tempfile::tempdir().unwrap();
    let logged_text = logged.path().to_str().unwrap().to_string();
    run_json(&[
        "registry",
        "use",
        index.to_str().unwrap(),
        "--config-dir",
        &logged_text,
    ]);
    let args: Vec<String> = ["plugin", "install", "probe", "--config-dir", &logged_text]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
    let (mut stdout, mut stderr) = (vec![], vec![]);
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(Path::new("/nonexistent/paths.d")),
        core_version: "0.0.2",
    };
    let code = soksak_sok::logged(&args, &mut stdout, &mut stderr, &options, &soksak_sok::run);
    assert_eq!(code, 0, "{}", String::from_utf8_lossy(&stderr));
    let stored: Vec<Value> = events_of(logged.path())
        .into_iter()
        .filter(|event| event["event"] == "sok.application.step")
        .collect();
    assert_eq!(stored.len(), 2, "{stored:?}");
    assert_eq!(stored[0]["fields"]["step"], "locate");
    assert_eq!(stored[0]["fields"]["method"], "path");
    assert_eq!(stored[1]["fields"]["step"], "record");
}
