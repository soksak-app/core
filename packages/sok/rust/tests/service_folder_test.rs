//! The service folder of a persistent sidecar is named by the base name of its executable (docs/spec/persistent-services.md), so an
//! installation refuses a second persistent sidecar whose executable has the base name of an installed one.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

#[path = "support/folder.rs"]
mod folder;
#[path = "support/package_release.rs"]
mod package_release;

use folder::Folder;

fn run(args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (vec![], vec![]);
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        core_version: "0.0.2",
        config_dir_variable: None,
    };
    let code = soksak_sok::run(&args, &mut stdout, &mut stderr, &options);
    (
        code,
        String::from_utf8(stdout).expect("stdout"),
        String::from_utf8(stderr).expect("stderr"),
    )
}

fn succeeds(args: &[&str]) -> String {
    let (code, stdout, stderr) = run(args);
    assert_eq!(code, 0, "{args:?}: {stderr}");
    stdout
}

fn write_tree(dir: &Path, files: &[(&str, &str)]) {
    for (name, content) in files {
        let (name, mode) = match name.strip_suffix('*') {
            Some(name) => (name, 0o755),
            None => (*name, 0o644),
        };
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    }
}

/// A registry with the plugins one and two, which require the sidecars @scope/sidecar-one and @scope/sidecar-two; each sidecar
/// names the executable build/worker, persistent when its plugin is in persistent.
struct Registry {
    dir: Folder,
    _work: Vec<Folder>,
}

fn service_folder_registry(persistent: &[&str]) -> Registry {
    let platform = soksak_sok::current_platform().expect("platform");
    let releases = Folder::new("plugins");
    let dir = Folder::new("plugins");
    let mut work = vec![];
    let mut files = vec![(
        "revoked.json".to_string(),
        r#"{"plugins": [], "sidecars": []}"#.to_string(),
    )];
    for id in ["one", "two"] {
        let sidecar = format!("@scope/sidecar-{id}");
        let plugin = Folder::new("plugins");
        write_tree(
            plugin.path(),
            &[
                (
                    "package.json",
                    &format!(
                        r#"{{"name": "@scope/plugin-{id}", "version": "1.0.0", "engines": {{"soksak": "^0.0.2"}}, "files": ["plugin.json"]}}"#
                    ),
                ),
                (
                    "plugin.json",
                    &format!(
                        r#"{{"id": "{id}", "name": "Probe", "description": "Sample.", "contributes": {{"lib.point": [{{"range": "^1.0.0", "module": "ui/b.js"}}]}},
                        "dependencies": {{"{sidecar}": "^0.1.0"}}}}"#
                    ),
                ),
            ],
        );
        let packed = package_release::pack(plugin.path(), releases.path());
        files.push((
            format!("plugins/{id}.json"),
            format!(
                r#"{{"id": "{id}", "package": "@scope/plugin-{id}", "name": "Probe", "description": "검사용 plugin.",
                "license": "MIT", "repository": "https://example.invalid/{id}", "versions": [{{"version": "1.0.0",
                "release": {{"url": "file://{}", "sha256": "{}"}}, "engines": {{"soksak": "^0.0.2"}},
                "sidecars": {{"{sidecar}": "^0.1.0"}}}}]}}"#,
                packed["release"].as_str().unwrap(),
                packed["sha256"].as_str().unwrap()
            ),
        ));
        let transport = if persistent.contains(&id) {
            r#", "transport": "persistent""#
        } else {
            ""
        };
        let release = Folder::new("plugins");
        write_tree(
            release.path(),
            &[
                (
                    "package.json",
                    &format!(
                        r#"{{"name": "{sidecar}", "version": "0.1.0", "files": ["sidecar.json", "build/worker"]}}"#
                    ),
                ),
                (
                    "sidecar.json",
                    &format!(
                        r#"{{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/{id}"{transport}}}"#
                    ),
                ),
                ("build/worker*", &format!("binary {id}")),
            ],
        );
        let released = package_release::pack(release.path(), releases.path());
        files.push((
            format!("sidecars/scope-sidecar-{id}.json"),
            format!(
                r#"{{"name": "{sidecar}", "repository": "https://example.invalid/{id}", "versions": [{{"version": "0.1.0",
                "protocol": 1, "releases": {{"{platform}": {{"url": "file://{}", "sha256": "{}"}}}}}}]}}"#,
                released["release"].as_str().unwrap(),
                released["sha256"].as_str().unwrap()
            ),
        ));
        work.push(plugin);
        work.push(release);
    }
    let entries: Vec<(&str, &str)> = files
        .iter()
        .map(|(name, content)| (name.as_str(), content.as_str()))
        .collect();
    write_tree(dir.path(), &entries);
    succeeds(&["registry", "build", dir.text()]);
    work.push(releases);
    Registry { dir, _work: work }
}

fn use_registry(config: &Folder, registry: &Registry) {
    let index = registry.dir.path().join("index.json");
    succeeds(&[
        "registry",
        "use",
        index.to_str().unwrap(),
        "--config-dir",
        config.text(),
    ]);
}

// contract: cli.plugin.refuses-a-shared-service-folder
#[test]
fn an_installation_refuses_a_second_persistent_sidecar_with_the_executable_base_name_of_another() {
    let config = Folder::new("plugins");
    let registry = service_folder_registry(&["one", "two"]);
    use_registry(&config, &registry);
    succeeds(&["plugin", "install", "one", "--config-dir", config.text()]);
    let installed = config.path().join("plugins/installed.json");
    let before = std::fs::read_to_string(&installed).unwrap();
    let (code, stdout, stderr) = run(&["plugin", "install", "two", "--config-dir", config.text()]);
    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            "sok: sidecar @scope/sidecar-two: executable base name worker is already the service folder of sidecar @scope/sidecar-one\n"
        )
    );
    assert_eq!(std::fs::read_to_string(&installed).unwrap(), before);
    // A sidecar of standard I/O has no service folder, so it shares the base name.
    let config = Folder::new("plugins");
    let registry = service_folder_registry(&["one"]);
    use_registry(&config, &registry);
    succeeds(&["plugin", "install", "one", "--config-dir", config.text()]);
    let out = succeeds(&["plugin", "install", "two", "--config-dir", config.text()]);
    assert!(out.contains(r#""version": "1.0.0""#), "{out}");
}
