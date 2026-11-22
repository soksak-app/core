//! Checks the update of installed plugins at start (docs/spec/installation.md#update-at-start). The registries are real index
//! files with real releases, read through the file: location that the registry contract accepts.

#[path = "support/folder.rs"]
mod folder;

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use soksak_host::plugins::{Changed, Plugins, RunRequest, StartUpdate};

/// Runs the sok command and returns its JSON output.
fn sok_json(args: &[&str]) -> Value {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (vec![], vec![]);
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        core_version: soksak_sok::version::CORE_VERSION,
        config_dir_variable: None,
    };
    let code = soksak_sok::run(&args, &mut stdout, &mut stderr, &options);
    assert_eq!(
        code,
        0,
        "sok {args:?}: {}",
        String::from_utf8_lossy(&stderr)
    );
    serde_json::from_slice(&stdout).expect("sok JSON output")
}

/// One version of the probe plugin in a registry: its engines range and its plugin.json text.
struct Release {
    version: &'static str,
    engines: &'static str,
    manifest: String,
}

/// The plugin.json of the probe fixture, which the reader accepts.
fn valid_manifest() -> String {
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugin-probe/plugin.json");
    std::fs::read_to_string(source).unwrap()
}

/// The plugin.json that the reader refuses: its top-level member host is not a member of the current contract.
fn refused_manifest() -> String {
    valid_manifest().replacen(
        r#""description": "Sample.","#,
        r#""description": "Sample.", "host": {},"#,
        1,
    )
}

/// Writes the release of one version in the layout that `npm pack` writes and returns its sha256.
fn pack_release(path: &Path, release: &Release) -> String {
    use sha2::Digest;
    let package = format!(
        r#"{{"name": "plugin-probe", "version": "{}", "engines": {{"soksak": "{}"}}, "files": ["plugin.json"]}}"#,
        release.version, release.engines
    );
    let mut data = vec![];
    {
        let zipped = flate2::write::GzEncoder::new(&mut data, flate2::Compression::default());
        let mut stream = tar::Builder::new(zipped);
        for (name, content) in [
            ("package.json", package.as_bytes()),
            ("plugin.json", release.manifest.as_bytes()),
        ] {
            let mut header = tar::Header::new_ustar();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            stream
                .append_data(&mut header, format!("package/{name}"), content)
                .unwrap();
        }
        stream.into_inner().unwrap().finish().unwrap();
    }
    std::fs::write(path, &data).unwrap();
    sha2::Sha256::digest(&data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Packs the releases into dir, builds the registry index dir/index.json of them and returns its path. Calling it again on
/// the same dir replaces the releases and the index.
fn write_start_registry(dir: &Path, releases: &[Release]) -> String {
    std::fs::create_dir_all(dir.join("releases")).unwrap();
    let mut versions = vec![];
    for release in releases {
        let path = dir
            .join("releases")
            .join(format!("plugin-probe-{}.tgz", release.version));
        let sum = pack_release(&path, release);
        versions.push(json!({
            "version": release.version,
            "release": {"url": format!("file://{}", path.display()), "sha256": sum},
            "engines": {"soksak": release.engines},
            "sidecars": {},
        }));
    }
    let entry = json!({
        "id": "probe", "package": "plugin-probe", "name": "Probe", "description": "검사용 plugin.",
        "license": "MIT", "repository": "https://example.invalid/probe", "versions": versions,
    });
    std::fs::create_dir_all(dir.join("plugins")).unwrap();
    std::fs::write(dir.join("plugins/probe.json"), entry.to_string()).unwrap();
    std::fs::write(
        dir.join("revoked.json"),
        r#"{"plugins": [], "sidecars": []}"#,
    )
    .unwrap();
    sok_json(&["registry", "build", dir.to_str().unwrap()]);
    dir.join("index.json").to_str().unwrap().to_string()
}

/// The installed version of the probe plugin and the text of plugins/installed.json.
fn installed_probe(config: &Path) -> (String, String) {
    let text = std::fs::read_to_string(config.join("plugins/installed.json")).unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();
    let version = value["plugins"]["probe"]["version"]
        .as_str()
        .unwrap()
        .to_string();
    (version, text)
}

/// Replaces the plugin.json of the installed probe version with the refused manifest, which is what an earlier release of the
/// application left in the configuration folder.
fn refuse_installed_manifest(config: &Path, version: &str) {
    std::fs::write(
        config
            .join("plugins/probe")
            .join(version)
            .join("plugin.json"),
        refused_manifest(),
    )
    .unwrap();
}

fn new_plugins(config: &Path) -> (Plugins, Arc<Mutex<Vec<Changed>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let plugins = Plugins::new(
        config.to_path_buf(),
        Box::new(|| Ok(())),
        Box::new(move |change| sink.lock().unwrap().push(change)),
    )
    .expect("plugins");
    (plugins, seen)
}

/// Sets the registry of config to index and installs the newest accepted version of the probe plugin.
fn install_probe(plugins: &Plugins, config: &Path, index: &str) {
    soksak_sok::plugins::use_registry(config, index, &soksak_sok::fetch::Fetcher::default())
        .expect("registry");
    plugins
        .run(RunRequest {
            action: "install".to_string(),
            plugin: json!("probe"),
        })
        .expect("install");
}

fn release(version: &'static str, engines: &'static str, manifest: String) -> Release {
    Release {
        version,
        engines,
        manifest,
    }
}

fn update(plugin: &str, from: &str, to: &str) -> StartUpdate {
    StartUpdate {
        plugin: plugin.to_string(),
        from: from.to_string(),
        to: to.to_string(),
        error: None,
    }
}

// contract: plugins.start-update.replaces-refused-with-newest-accepted
#[test]
fn start_update_replaces_a_refused_installed_plugin_with_the_newest_accepted_version() {
    let config = folder::Folder::new();
    let registry = folder::Folder::new();
    let (plugins, changes) = new_plugins(config.path());
    let index = write_start_registry(
        registry.path(),
        &[release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest())],
    );
    install_probe(&plugins, config.path(), &index);
    refuse_installed_manifest(config.path(), "0.0.1");
    let index = write_start_registry(
        registry.path(),
        &[
            release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest()),
            release("0.0.2", ">=0.0.1 <1.0.0", valid_manifest()),
            release("0.0.3", ">=0.0.1 <0.0.46", valid_manifest()),
        ],
    );
    assert!(index.ends_with("index.json"));
    let setup = changes.lock().unwrap().len();

    let results = plugins.update_at_start();
    assert_eq!(results, vec![update("probe", "0.0.1", "0.0.2")]);
    assert_eq!(installed_probe(config.path()).0, "0.0.2");
    assert_eq!(
        changes.lock().unwrap()[setup..].to_vec(),
        vec![Changed {
            action: "update".to_string(),
            plugin: "probe".to_string()
        }]
    );
}

// contract: plugins.start-update.advances-older-accepted
#[test]
fn start_update_advances_an_older_installed_plugin_to_the_newest_accepted_version() {
    let config = folder::Folder::new();
    let registry = folder::Folder::new();
    let (plugins, _) = new_plugins(config.path());
    let index = write_start_registry(
        registry.path(),
        &[release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest())],
    );
    install_probe(&plugins, config.path(), &index);
    write_start_registry(
        registry.path(),
        &[
            release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest()),
            release("0.0.2", ">=0.0.1 <1.0.0", valid_manifest()),
        ],
    );

    assert_eq!(
        plugins.update_at_start(),
        vec![update("probe", "0.0.1", "0.0.2")]
    );
    assert_eq!(installed_probe(config.path()).0, "0.0.2");
}

// contract: plugins.start-update.repeated-start-changes-nothing
#[test]
fn repeated_start_update_changes_nothing() {
    let config = folder::Folder::new();
    let registry = folder::Folder::new();
    let (plugins, changes) = new_plugins(config.path());
    let index = write_start_registry(
        registry.path(),
        &[release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest())],
    );
    install_probe(&plugins, config.path(), &index);
    refuse_installed_manifest(config.path(), "0.0.1");
    write_start_registry(
        registry.path(),
        &[
            release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest()),
            release("0.0.2", ">=0.0.1 <1.0.0", valid_manifest()),
        ],
    );
    assert_eq!(plugins.update_at_start().len(), 1);
    let (_, before) = installed_probe(config.path());
    let count = changes.lock().unwrap().len();

    assert_eq!(plugins.update_at_start(), vec![]);
    assert_eq!(installed_probe(config.path()).1, before);
    assert_eq!(changes.lock().unwrap().len(), count);
}

// contract: plugins.start-update.refused-without-newer-is-reported-and-kept
#[test]
fn start_update_reports_a_refused_plugin_without_a_newer_accepted_version_and_keeps_it() {
    let config = folder::Folder::new();
    let registry = folder::Folder::new();
    let (plugins, changes) = new_plugins(config.path());
    let index = write_start_registry(
        registry.path(),
        &[release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest())],
    );
    install_probe(&plugins, config.path(), &index);
    refuse_installed_manifest(config.path(), "0.0.1");
    let (_, before) = installed_probe(config.path());
    let setup = changes.lock().unwrap().len();

    let results = plugins.update_at_start();
    assert_eq!(results.len(), 1, "{results:?}");
    assert_eq!(results[0].plugin, "probe");
    assert!(
        results[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("host")),
        "{results:?}"
    );
    assert_eq!(installed_probe(config.path()).1, before);
    assert!(changes.lock().unwrap()[setup..].is_empty());
}

// contract: plugins.start-update.unreadable-registry-is-reported
#[test]
fn start_update_reports_an_unreadable_registry_and_changes_nothing() {
    let config = folder::Folder::new();
    let registry = folder::Folder::new();
    let (plugins, _) = new_plugins(config.path());
    let index = write_start_registry(
        registry.path(),
        &[release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest())],
    );
    install_probe(&plugins, config.path(), &index);
    let (_, before) = installed_probe(config.path());
    // The registry is set to an https address that refuses the connection, as an offline machine would.
    std::fs::write(
        config.path().join("plugins/registry.json"),
        r#"{"format": 1, "index": "https://127.0.0.1:1/index.json"}"#,
    )
    .unwrap();

    let results = plugins.update_at_start();
    assert_eq!(results.len(), 1, "{results:?}");
    assert_eq!(results[0].plugin, "");
    assert!(
        results[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("127.0.0.1:1")),
        "{results:?}"
    );
    assert_eq!(installed_probe(config.path()).1, before);
}

// contract: plugins.start-update.failure-is-kept-in-plugins-state
#[test]
fn start_update_failure_is_kept_in_the_plugins_state() {
    let config = folder::Folder::new();
    let registry = folder::Folder::new();
    let (plugins, _) = new_plugins(config.path());
    let index = write_start_registry(
        registry.path(),
        &[release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest())],
    );
    install_probe(&plugins, config.path(), &index);
    refuse_installed_manifest(config.path(), "0.0.1");

    assert_eq!(plugins.update_at_start().len(), 1);
    let state = serde_json::to_value(plugins.state().expect("state")).unwrap();
    let failures = state["startUpdate"].as_array().expect("startUpdate list");
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(failures[0]["where"], "plugin update probe");
    assert!(
        failures[0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("host")),
        "{failures:?}"
    );
}

// contract: plugins.start-update.shutdown-before-start-changes-nothing
#[test]
fn a_shutdown_before_the_start_update_changes_nothing() {
    let config = folder::Folder::new();
    let registry = folder::Folder::new();
    let (plugins, changes) = new_plugins(config.path());
    let index = write_start_registry(
        registry.path(),
        &[release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest())],
    );
    install_probe(&plugins, config.path(), &index);
    refuse_installed_manifest(config.path(), "0.0.1");
    write_start_registry(
        registry.path(),
        &[
            release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest()),
            release("0.0.2", ">=0.0.1 <1.0.0", valid_manifest()),
        ],
    );
    let (_, before) = installed_probe(config.path());
    let setup = changes.lock().unwrap().len();

    plugins.stop();
    let results = plugins.update_at_start();
    assert_eq!(results.len(), 1, "{results:?}");
    assert!(
        results[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("shutting down")),
        "{results:?}"
    );
    assert_eq!(installed_probe(config.path()).1, before);
    assert!(!config.path().join("plugins/probe/0.0.2").exists());
    assert!(changes.lock().unwrap()[setup..].is_empty());
}

// contract: plugins.start-update.shutdown-during-install-applies-nothing
#[test]
fn a_shutdown_during_the_install_leaves_the_previous_installation() {
    let config = folder::Folder::new();
    let registry = folder::Folder::new();
    let (plugins, _) = new_plugins(config.path());
    let index = write_start_registry(
        registry.path(),
        &[release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest())],
    );
    install_probe(&plugins, config.path(), &index);
    write_start_registry(
        registry.path(),
        &[
            release("0.0.1", ">=0.0.1 <1.0.0", valid_manifest()),
            release("0.0.2", ">=0.0.1 <1.0.0", valid_manifest()),
        ],
    );
    let (_, before) = installed_probe(config.path());
    // The stop reports the shutdown from its second check on, after the release is extracted and before installed.json is written.
    let checks = std::cell::Cell::new(0);
    let stop = || {
        checks.set(checks.get() + 1);
        checks.get() >= 2
    };
    let platform = soksak_sok::current_platform().expect("platform");

    let error = soksak_sok::plugins::update_plugin_unless(
        config.path(),
        "probe",
        soksak_sok::version::CORE_VERSION,
        &platform,
        &stop,
    );
    let error = match error {
        Ok(_) => panic!("an update that the shutdown stopped must fail"),
        Err(error) => error,
    };
    assert!(error.contains("shutting down"), "{error}");
    assert_eq!(installed_probe(config.path()).1, before);
}
