//! Checks what a request of a module of the page reads (the serving of installed plugins in docs/spec/installation.md):
//! the manifest of the plugin that it names and no other, and the installation of the moment.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use soksak_sok::plugins::set_after_manifest_read;

use super::{Module, installed_module, installed_shared};

const REQUESTS: usize = 5;

/// Writes the content to the configuration folder for each path.
fn write(config: &Path, files: &[(&str, &str)]) {
    for (name, content) in files {
        let file = config.join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }
}

/// A plugin record of installed.json.
fn record(id: &str) -> String {
    format!(
        r#""{id}": {{"version": "1.0.0", "path": "plugins/{id}/1.0.0", "enabled": true, "sidecars": {{}}}}"#
    )
}

/// Writes installed.json with the plugins of ids.
fn write_record(config: &Path, ids: &[&str]) {
    let plugins: Vec<String> = ids.iter().map(|id| record(id)).collect();
    let state = format!(
        r#"{{"format": 3, "plugins": {{{}}}, "sidecars": {{}}}}"#,
        plugins.join(",")
    );
    write(config, &[("plugins/installed.json", &state)]);
}

/// Writes the files of the plugin id, whose package is `plugin-<id>` and which declares the shared module `state`.
fn write_plugin(config: &Path, id: &str) {
    let folder = format!("plugins/{id}/1.0.0");
    write(
        config,
        &[
            (
                &format!("{folder}/package.json"),
                &format!(r#"{{"name": "plugin-{id}"}}"#),
            ),
            (
                &format!("{folder}/plugin.json"),
                &format!(
                    r#"{{"id": "{id}", "extends": {{"language": {{"version": "1.0.0", "schema": {{}}, "modules": {{"state": "ui/state.js"}}}}}}}}"#
                ),
            ),
            (&format!("{folder}/ui/state.js"), "export const state = 1;"),
        ],
    );
}

/// A configuration folder with the enabled plugins alpha, beta and gamma.
fn fixture() -> tempfile::TempDir {
    let config = tempfile::tempdir().unwrap();
    for id in ["alpha", "beta", "gamma"] {
        write_plugin(config.path(), id);
    }
    write_record(config.path(), &["alpha", "beta", "gamma"]);
    config
}

/// Returns the manifests that `requests` reads, in order.
fn manifests_read(requests: impl FnOnce()) -> Vec<PathBuf> {
    let read = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&read);
    set_after_manifest_read(Some(Box::new(move |file: &Path| {
        recorded.lock().unwrap().push(file.to_path_buf());
    })));
    requests();
    set_after_manifest_read(None);
    let files = read.lock().unwrap().clone();
    files
}

// contract: installed.modules.read-the-manifest-of-the-request
#[test]
fn a_module_of_a_plugin_reads_the_manifest_of_that_plugin_alone() {
    let config = fixture();
    let read = manifests_read(|| {
        for _ in 0..REQUESTS {
            assert_eq!(
                installed_module(config.path(), "/modules/plugin-beta/ui/state.js"),
                Ok(Module::File(
                    config.path().join("plugins/beta/1.0.0/ui/state.js")
                ))
            );
        }
    });
    let manifest = config.path().join("plugins/beta/1.0.0/plugin.json");
    assert_eq!(read, vec![manifest; REQUESTS]);
}

// contract: installed.modules.read-the-manifest-of-the-request
#[test]
fn a_module_of_the_frontend_reads_no_manifest() {
    let config = fixture();
    let read = manifests_read(|| {
        for _ in 0..REQUESTS {
            assert_eq!(
                installed_module(config.path(), "/modules/soksak/dist/index.js"),
                Ok(Module::Frontend)
            );
        }
    });
    assert_eq!(read, Vec::<PathBuf>::new());
}

// contract: installed.modules.read-the-manifest-of-the-request
#[test]
fn a_shared_module_reads_the_manifest_of_its_provider_alone() {
    let config = fixture();
    let read = manifests_read(|| {
        for _ in 0..REQUESTS {
            assert_eq!(
                installed_shared(config.path(), "/shared/beta.language/state.js"),
                Ok(Module::File(
                    config.path().join("plugins/beta/1.0.0/ui/state.js")
                ))
            );
        }
    });
    let manifest = config.path().join("plugins/beta/1.0.0/plugin.json");
    assert_eq!(read, vec![manifest; REQUESTS]);
}

// contract: installed.modules.read-the-manifest-of-the-request
#[test]
fn a_malformed_manifest_refuses_the_modules_of_its_own_plugin_alone() {
    let config = fixture();
    write(config.path(), &[("plugins/alpha/1.0.0/plugin.json", "{")]);
    assert_eq!(
        installed_module(config.path(), "/modules/plugin-beta/ui/state.js"),
        Ok(Module::File(
            config.path().join("plugins/beta/1.0.0/ui/state.js")
        ))
    );
    assert_eq!(
        installed_shared(config.path(), "/shared/beta.language/state.js"),
        Ok(Module::File(
            config.path().join("plugins/beta/1.0.0/ui/state.js")
        ))
    );
    assert_eq!(
        installed_module(config.path(), "/modules/plugin-alpha/ui/state.js"),
        Ok(Module::Frontend)
    );
    let manifest = config.path().join("plugins/alpha/1.0.0/plugin.json");
    let error = installed_shared(config.path(), "/shared/alpha.language/state.js").unwrap_err();
    assert!(error.contains(&manifest.display().to_string()), "{error}");
}

// contract: installed.modules.follow-the-installation
#[test]
fn the_request_after_an_install_serves_the_new_plugin() {
    let config = fixture();
    let module = "/modules/plugin-delta/ui/state.js";
    let shared = "/shared/delta.language/state.js";
    assert_eq!(
        installed_module(config.path(), module),
        Ok(Module::Frontend)
    );
    assert_eq!(installed_shared(config.path(), shared), Ok(Module::Missing));
    write_plugin(config.path(), "delta");
    write_record(config.path(), &["alpha", "beta", "gamma", "delta"]);
    let file = config.path().join("plugins/delta/1.0.0/ui/state.js");
    assert_eq!(
        installed_module(config.path(), module),
        Ok(Module::File(file.clone()))
    );
    assert_eq!(
        installed_shared(config.path(), shared),
        Ok(Module::File(file))
    );
}

// contract: installed.modules.follow-the-installation
#[test]
fn the_request_after_a_removal_does_not_serve_the_plugin() {
    let config = fixture();
    let module = "/modules/plugin-beta/ui/state.js";
    let shared = "/shared/beta.language/state.js";
    let file = config.path().join("plugins/beta/1.0.0/ui/state.js");
    assert_eq!(
        installed_module(config.path(), module),
        Ok(Module::File(file.clone()))
    );
    assert_eq!(
        installed_shared(config.path(), shared),
        Ok(Module::File(file))
    );
    write_record(config.path(), &["alpha", "gamma"]);
    assert_eq!(
        installed_module(config.path(), module),
        Ok(Module::Frontend)
    );
    assert_eq!(installed_shared(config.path(), shared), Ok(Module::Missing));
}

// contract: installed.modules.follow-the-installation
#[test]
fn the_request_after_an_update_reads_the_new_manifest() {
    let config = fixture();
    let shared = "/shared/beta.language/state.js";
    assert!(matches!(
        installed_shared(config.path(), shared),
        Ok(Module::File(_))
    ));
    write(
        config.path(),
        &[(
            "plugins/beta/1.0.0/plugin.json",
            r#"{"id": "beta", "extends": {"language": {"version": "1.0.0", "schema": {}, "modules": {"other": "ui/state.js"}}}}"#,
        )],
    );
    assert_eq!(installed_shared(config.path(), shared), Ok(Module::Missing));
}
