//! Checks that a plugin operation does not change the version of a persistent sidecar whose service runs
//! (docs/spec/persistent-services.md#updates).

use std::cell::RefCell;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde_json::Value;
use soksak_sok::service_hold::{Held, HeldSidecar, Running, Services};

#[path = "support/folder.rs"]
mod folder;
#[path = "support/package_release.rs"]
mod package_release;

use folder::Folder;

const SIDECAR: &str = "@scope/sidecar-worker";

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

fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// A registry in which probe 0.2.0 requires the persistent sidecar worker ^0.1.0 and probe 0.3.0 requires ^0.2.0, with
/// releases of worker 0.1.0 and 0.2.0.
struct Registry {
    dir: Folder,
    _work: Vec<Folder>,
}

fn held_registry(versions: &[&str]) -> Registry {
    let platform = soksak_sok::current_platform().expect("platform");
    let releases = Folder::new("plugins");
    let mut work = vec![];
    let mut entries = vec![];
    for version in versions {
        let range = if *version == "0.2.0" {
            "^0.1.0"
        } else {
            "^0.2.0"
        };
        let dir = Folder::new("plugins");
        let package = format!(
            r#"{{"name": "@scope/plugin-probe", "version": "{version}", "engines": {{"soksak": "^0.0.2"}}, "files": ["plugin.json", "ui"]}}"#
        );
        let manifest = format!(
            r#"{{"id": "probe", "name": "Probe", "description": "Sample.", "contributes": {{"lib.point": [{{"range": "^1.0.0", "module": "ui/b.js"}}]}},
            "dependencies": {{"{SIDECAR}": "{range}"}}}}"#
        );
        let content = format!("b {version}");
        write_tree(
            dir.path(),
            &[
                ("package.json", &package),
                ("plugin.json", &manifest),
                ("ui/b.js", &content),
            ],
        );
        let result = package_release::pack(dir.path(), releases.path());
        entries.push(format!(
            r#"{{"version": "{version}", "release": {{"url": "file://{}", "sha256": "{}"}},
            "engines": {{"soksak": "^0.0.2"}}, "sidecars": {{"{SIDECAR}": "{range}"}}}}"#,
            result["release"].as_str().unwrap(),
            result["sha256"].as_str().unwrap()
        ));
        work.push(dir);
    }
    let mut sidecars = vec![];
    for version in ["0.1.0", "0.2.0"] {
        let sidecar = Folder::new("plugins");
        let package = format!(
            r#"{{"name": "{SIDECAR}", "version": "{version}", "files": ["sidecar.json", "build/worker"]}}"#
        );
        let binary = format!("binary {version}");
        write_tree(
            sidecar.path(),
            &[
                ("package.json", &package),
                (
                    "sidecar.json",
                    r#"{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/probe", "transport": "persistent"}"#,
                ),
                ("build/worker*", &binary),
            ],
        );
        let released = package_release::pack(sidecar.path(), releases.path());
        sidecars.push(format!(
            r#"{{"version": "{version}", "protocol": 1, "releases": {{"{platform}": {{"url": "file://{}", "sha256": "{}"}}}}}}"#,
            released["release"].as_str().unwrap(),
            released["sha256"].as_str().unwrap()
        ));
        work.push(sidecar);
    }
    let dir = Folder::new("plugins");
    let plugin_entry = format!(
        r#"{{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
        "license": "MIT", "repository": "https://example.invalid/probe", "versions": [{}]}}"#,
        entries.join(",")
    );
    let sidecar_entry = format!(
        r#"{{"name": "{SIDECAR}", "repository": "https://example.invalid/worker", "versions": [{}]}}"#,
        sidecars.join(",")
    );
    write_tree(
        dir.path(),
        &[
            ("plugins/probe.json", &plugin_entry),
            ("sidecars/scope-sidecar-worker.json", &sidecar_entry),
            ("revoked.json", r#"{"plugins": [], "sidecars": []}"#),
        ],
    );
    let built: Value = serde_json::from_str(&succeeds(&["registry", "build", dir.text()])).unwrap();
    assert!(built.is_object());
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

/// A child process that runs until the check ends it, with the endpoint of the service worker in config that names it.
struct Service(std::process::Child);

impl Service {
    fn start(config: &Folder) -> Service {
        let child = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("spawn the service");
        let endpoint = format!(
            r#"{{"protocol": 1, "pid": {}, "socket": "/nowhere", "token": "t"}}"#,
            child.id()
        );
        write_tree(
            config.path(),
            &[("services/worker/endpoint.json", &endpoint)],
        );
        Service(child)
    }

    fn end(&mut self) {
        self.0.kill().expect("end the service");
        assert!(!self.0.wait().expect("wait for the service").success());
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        // The child of an ended service is reaped already; a running one ends with the check.
        if let Ok(None) = self.0.try_wait() {
            self.end();
        }
    }
}

fn install_probe(config: &Folder) {
    // The registry folder holds the releases, so it lives until the install has read them.
    let registry = held_registry(&["0.2.0"]);
    use_registry(config, &registry);
    succeeds(&["plugin", "install", "probe", "--config-dir", config.text()]);
}

fn installed(config: &Folder) -> String {
    read_text(&config.path().join("plugins/installed.json"))
}

// contract: cli.plugin.update-waits-for-a-running-service
#[test]
fn an_update_that_changes_the_sidecar_of_a_running_service_writes_nothing() {
    let config = Folder::new("config");
    install_probe(&config);
    let mut service = Service::start(&config);
    let registry = held_registry(&["0.2.0", "0.3.0"]);
    use_registry(&config, &registry);
    let before = installed(&config);
    let (code, stdout, stderr) = run(&["plugin", "update", "probe", "--config-dir", config.text()]);
    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            "sok: plugin probe 0.3.0: sidecar @scope/sidecar-worker 0.2.0 waits for the end of its running service unknown\n"
        )
    );
    assert_eq!(installed(&config), before);
    assert!(!config.path().join("plugins/probe/0.3.0").exists());
    assert!(
        !config
            .path()
            .join("sidecars/scope-sidecar-worker/0.2.0")
            .exists()
    );
    // The endpoint names no process after the end of the service, so the update runs.
    service.end();
    let updated = succeeds(&["plugin", "update", "probe", "--config-dir", config.text()]);
    assert!(updated.contains(r#""version": "0.3.0""#), "{updated}");
}

// contract: cli.plugin.update-waits-for-a-running-service
#[test]
fn an_operation_of_the_host_ends_the_holding_service_before_it_writes_the_state() {
    let config = Folder::new("config");
    install_probe(&config);
    let registry = held_registry(&["0.2.0", "0.3.0"]);
    use_registry(&config, &registry);
    let platform = soksak_sok::current_platform().expect("platform");
    let services = Services::from([(SIDECAR.to_string(), Some("0.1.0".to_string()))]);
    let given = RefCell::new(Vec::new());
    let give = |held: &Held| given.borrow_mut().push(held.clone());
    let held = Running {
        services: services.clone(),
        end: None,
        held: Some(&give),
    };
    let error = soksak_sok::plugins::run_plugin_action(
        config.path(),
        "update",
        "probe",
        "0.0.2",
        &platform,
        &held,
    )
    .err();
    assert_eq!(
        error.as_deref(),
        Some(
            "plugin probe 0.3.0: sidecar @scope/sidecar-worker 0.2.0 waits for the end of its running service 0.1.0"
        )
    );
    let want = "plugin probe 0.3.0: sidecar @scope/sidecar-worker 0.2.0 waits for the end of its running service 0.1.0";
    let operation = Held {
        plugin: "probe".to_string(),
        version: "0.3.0".to_string(),
        sidecars: vec![HeldSidecar {
            sidecar: SIDECAR.to_string(),
            planned: "0.2.0".to_string(),
            running: Some("0.1.0".to_string()),
        }],
        error: want.to_string(),
    };
    assert_eq!(*given.borrow(), vec![operation.clone()]);
    // The end sees the extracted releases and the earlier installed.json, so a failed end writes nothing.
    let ended = RefCell::new(Vec::new());
    let end = |held: &Held| {
        let state = soksak_sok::plugins::read_installed(config.path())?;
        assert_eq!(state.plugins["probe"].version, "0.2.0");
        assert!(config.path().join("plugins/probe/0.3.0").exists());
        assert!(
            config
                .path()
                .join("sidecars/scope-sidecar-worker/0.2.0")
                .exists()
        );
        ended.borrow_mut().push(held.clone());
        Ok(())
    };
    let ending = Running {
        services,
        end: Some(&end),
        held: None,
    };
    soksak_sok::plugins::run_plugin_action(
        config.path(),
        "update",
        "probe",
        "0.0.2",
        &platform,
        &ending,
    )
    .expect("the update that ends the service");
    assert_eq!(*ended.borrow(), vec![operation]);
    let state = soksak_sok::plugins::read_installed(config.path()).unwrap();
    assert_eq!(state.sidecars[SIDECAR].version, "0.2.0");
}

// contract: cli.plugin.update-waits-for-a-running-service
#[test]
fn an_enable_beside_a_service_of_another_version_is_held() {
    let config = Folder::new("config");
    install_probe(&config);
    succeeds(&["plugin", "disable", "probe", "--config-dir", config.text()]);
    let before = installed(&config);
    let platform = soksak_sok::current_platform().expect("platform");
    let other = Running {
        services: Services::from([(SIDECAR.to_string(), Some("0.0.9".to_string()))]),
        end: None,
        held: None,
    };
    let error = soksak_sok::plugins::run_plugin_action(
        config.path(),
        "enable",
        "probe",
        "0.0.2",
        &platform,
        &other,
    )
    .err();
    assert_eq!(
        error.as_deref(),
        Some(
            "plugin probe 0.2.0: sidecar @scope/sidecar-worker 0.1.0 waits for the end of its running service 0.0.9"
        )
    );
    assert_eq!(installed(&config), before);
    // A service of the recorded version does not hold the enable.
    let recorded = Running {
        services: Services::from([(SIDECAR.to_string(), Some("0.1.0".to_string()))]),
        end: None,
        held: None,
    };
    soksak_sok::plugins::run_plugin_action(
        config.path(),
        "enable",
        "probe",
        "0.0.2",
        &platform,
        &recorded,
    )
    .expect("the enable beside service 0.1.0");
    let state = soksak_sok::plugins::read_installed(config.path()).unwrap();
    assert!(state.plugins["probe"].enabled);
}
