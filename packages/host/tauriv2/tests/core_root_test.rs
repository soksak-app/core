//! Checks the core root of a view: the core files of the view import map and the files that the granted item rule grants
//! (docs/plans/plugin-processes.md, rule 4).

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

use std::path::Path;
use std::sync::Mutex;

use soksak_host_tauriv2::event_record::use_host_event_log;
use soksak_host_tauriv2::installed::{self, CoreRootFile};

/// Serializes the tests that attach the writer of the records, which is one value of the process.
static LOG_LOCK: Mutex<()> = Mutex::new(());

/// Writes the content to the configuration folder for each path.
fn write_installed(config: &Path, files: &[(&str, &str)]) {
    for (name, content) in files {
        let file = config.join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }
}

/// A configuration folder with three enabled plugins and one disabled plugin. The provider declares the point list with
/// a shared module. The view contributes the module ui/item.js to the point provider.list and depends on the provider,
/// which grants no file. The other plugin owns a file that no plugin is granted.
fn core_root_fixture() -> folder::Folder {
    let config = folder::Folder::new();
    write_installed(
        config.path(),
        &[
            (
                "plugins/installed.json",
                r#"{"format": 3, "plugins": {
                "provider": {"version": "1.0.0", "path": "plugins/provider/1.0.0", "enabled": true, "sidecars": {}},
                "view": {"version": "1.0.0", "path": "plugins/view/1.0.0", "enabled": true, "sidecars": {}},
                "other": {"version": "1.0.0", "path": "plugins/other/1.0.0", "enabled": true, "sidecars": {}},
                "off": {"version": "1.0.0", "path": "plugins/off/1.0.0", "enabled": false, "sidecars": {}}},
                "sidecars": {}}"#,
            ),
            (
                "plugins/provider/1.0.0/package.json",
                r#"{"name": "plugin-provider"}"#,
            ),
            (
                "plugins/provider/1.0.0/plugin.json",
                r#"{"id": "provider", "extends": {"list": {"version": "1.0.0", "modules": {"format": "ui/format.js"}}}}"#,
            ),
            (
                "plugins/provider/1.0.0/ui/format.js",
                "export const format = 1;",
            ),
            ("plugins/provider/1.0.0/ui/own.js", "export const own = 1;"),
            (
                "plugins/view/1.0.0/package.json",
                r#"{"name": "plugin-view"}"#,
            ),
            (
                "plugins/view/1.0.0/plugin.json",
                r#"{"id": "view", "dependencies": {"plugin-provider": "^1.0.0"}, "contributes": {"provider.list": [{"range": "^1.0.0", "module": "ui/item.js"}]}}"#,
            ),
            ("plugins/view/1.0.0/ui/item.js", "export const item = 1;"),
            (
                "plugins/view/1.0.0/ui/secret.js",
                "export const secret = 1;",
            ),
            (
                "plugins/other/1.0.0/package.json",
                r#"{"name": "plugin-other"}"#,
            ),
            ("plugins/other/1.0.0/plugin.json", r#"{"id": "other"}"#),
            ("plugins/other/1.0.0/secret.js", "export const other = 1;"),
            (
                "plugins/off/1.0.0/package.json",
                r#"{"name": "plugin-off"}"#,
            ),
            ("plugins/off/1.0.0/plugin.json", r#"{"id": "off"}"#),
        ],
    );
    config
}

/// The bundled frontend of the tests, addressed by its name without a leading slash. It holds the core files and also the
/// paths that a view must not receive.
fn core_frontend(name: &str) -> Option<Vec<u8>> {
    let files = [
        (
            "core-root.json",
            r#"["/modules/@soksak/plugin-api/index.js","/modules/soksak/dist/index.js"]"#,
        ),
        (
            "modules/@soksak/plugin-api/index.js",
            "export const index = 1;",
        ),
        ("modules/soksak/dist/index.js", "export const soksak = 1;"),
        ("runtime/index.js", "export const runtime = 1;"),
        ("environment.json", r#"{"plugins":[]}"#),
        ("start.json", "{}"),
        ("index.html", "<!doctype html>"),
    ];
    files
        .iter()
        .find(|(path, _)| *path == name)
        .map(|(_, text)| text.as_bytes().to_vec())
}

/// Checks that the core root serves the file at url_path to plugin with the content and the content type.
fn served(config: &Path, plugin: &str, url_path: &str, content: &str) {
    let file = installed::core_root(config, plugin, url_path, &core_frontend)
        .unwrap_or_else(|error| panic!("{url_path} for {plugin}: {error}"))
        .unwrap_or_else(|| panic!("{url_path} for {plugin}: not found, want the file"));
    assert_eq!(
        file,
        CoreRootFile {
            data: content.as_bytes().to_vec(),
            content_type: "text/javascript",
        },
        "{url_path} for {plugin}"
    );
}

/// Runs body with a writer of the records attached and returns the records that body wrote as lines of the text form.
fn records_of(body: impl FnOnce()) -> String {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let directory = folder::Folder::new();
    let log = records::start_writer(directory.path());
    body();
    let text = records::records_text(directory.path(), &log);
    use_host_event_log(None);
    text
}

/// Checks that the record text has the refusal of url_path for plugin as an error of the core root.
fn assert_refusal_recorded(written: &str, plugin: &str, url_path: &str) {
    let want = format!("error host core root: {url_path} is not granted to {plugin}");
    assert!(
        written.contains(&want),
        "{url_path} for {plugin}: the records have no {want:?}"
    );
}

// contract: document.core-root.grant
#[test]
fn core_root_serves_a_granted_module() {
    let config = core_root_fixture();
    served(
        config.path(),
        "provider",
        "/modules/plugin-view/ui/item.js",
        "export const item = 1;",
    );
}

// contract: document.core-root.grant
#[test]
fn core_root_serves_a_shared_target() {
    let config = core_root_fixture();
    for plugin in ["provider", "view"] {
        served(
            config.path(),
            plugin,
            "/shared/provider.list/format.js",
            "export const format = 1;",
        );
    }
}

// contract: document.core-root.grant
#[test]
fn core_root_serves_a_core_file() {
    let config = core_root_fixture();
    served(
        config.path(),
        "provider",
        "/modules/@soksak/plugin-api/index.js",
        "export const index = 1;",
    );
    served(
        config.path(),
        "other",
        "/modules/soksak/dist/index.js",
        "export const soksak = 1;",
    );
}

// contract: document.core-root.grant
#[test]
fn core_root_refuses_an_unrelated_plugin_file() {
    let cases = [
        ("provider", "/modules/plugin-other/secret.js"),
        ("provider", "/modules/plugin-view/ui/secret.js"),
        ("provider", "/modules/plugin-provider/ui/own.js"),
        ("view", "/modules/plugin-provider/ui/format.js"),
        ("other", "/modules/plugin-view/ui/item.js"),
    ];
    let config = core_root_fixture();
    let written = records_of(|| {
        for (plugin, url_path) in cases {
            assert_eq!(
                installed::core_root(config.path(), plugin, url_path, &core_frontend),
                Ok(None),
                "{url_path} for {plugin}"
            );
        }
    });
    for (plugin, url_path) in cases {
        assert_refusal_recorded(&written, plugin, url_path);
    }
}

// contract: document.core-root.grant
#[test]
fn core_root_refuses_runtime_and_workbench_paths() {
    let cases = [
        ("provider", "/runtime/index.js"),
        ("provider", "/environment.json"),
        ("provider", "/start.json"),
        ("provider", "/index.html"),
    ];
    let config = core_root_fixture();
    let written = records_of(|| {
        for (plugin, url_path) in cases {
            assert_eq!(
                installed::core_root(config.path(), plugin, url_path, &core_frontend),
                Ok(None),
                "{url_path} for {plugin}"
            );
        }
    });
    for (plugin, url_path) in cases {
        assert_refusal_recorded(&written, plugin, url_path);
    }
}

// contract: document.core-root.grant
#[test]
fn core_root_refuses_a_requester_that_is_not_enabled() {
    let cases = [
        ("off", "/modules/@soksak/plugin-api/index.js"),
        ("nobody", "/modules/@soksak/plugin-api/index.js"),
    ];
    let config = core_root_fixture();
    let written = records_of(|| {
        for (plugin, url_path) in cases {
            assert_eq!(
                installed::core_root(config.path(), plugin, url_path, &core_frontend),
                Ok(None),
                "{url_path} for {plugin}"
            );
        }
    });
    for (plugin, url_path) in cases {
        assert_refusal_recorded(&written, plugin, url_path);
    }
}

// contract: document.core-root.grant
#[test]
fn core_root_fails_a_granted_file_that_is_missing() {
    let config = core_root_fixture();
    std::fs::remove_file(config.path().join("plugins/view/1.0.0/ui/item.js")).unwrap();
    assert!(
        installed::core_root(
            config.path(),
            "provider",
            "/modules/plugin-view/ui/item.js",
            &core_frontend
        )
        .is_err(),
        "a granted file that is missing is not an error"
    );
}

// contract: document.core-root.grant
#[test]
fn core_root_reads_the_targets_from_the_core_root_file() {
    let config = core_root_fixture();
    let frontend = |name: &str| {
        if name == "core-root.json" {
            Some(br#"["/modules/@soksak/plugin-api/index.js"]"#.to_vec())
        } else {
            core_frontend(name)
        }
    };
    let cases = [("other", "/modules/soksak/dist/index.js")];
    let written = records_of(|| {
        assert_eq!(
            installed::core_root(
                config.path(),
                "other",
                "/modules/@soksak/plugin-api/index.js",
                &frontend
            ),
            Ok(Some(CoreRootFile {
                data: b"export const index = 1;".to_vec(),
                content_type: "text/javascript",
            }))
        );
        for (plugin, url_path) in cases {
            assert_eq!(
                installed::core_root(config.path(), plugin, url_path, &frontend),
                Ok(None),
                "{url_path} for {plugin}"
            );
        }
    });
    for (plugin, url_path) in cases {
        assert_refusal_recorded(&written, plugin, url_path);
    }
}

// contract: document.core-root.grant
#[test]
fn core_root_fails_a_missing_core_root_file() {
    let config = core_root_fixture();
    let frontend = |name: &str| {
        if name == "core-root.json" {
            None
        } else {
            core_frontend(name)
        }
    };
    assert!(
        installed::core_root(
            config.path(),
            "provider",
            "/modules/@soksak/plugin-api/index.js",
            &frontend
        )
        .is_err(),
        "a missing core-root.json is not an error"
    );
}

// contract: document.core-root.grant
#[test]
fn core_root_fails_a_malformed_core_root_file() {
    let config = core_root_fixture();
    for text in [
        r#"{"targets": []}"#,
        "null",
        r#"["/runtime/index.js"]"#,
        "not json",
    ] {
        let frontend = |name: &str| {
            if name == "core-root.json" {
                Some(text.as_bytes().to_vec())
            } else {
                core_frontend(name)
            }
        };
        assert!(
            installed::core_root(
                config.path(),
                "provider",
                "/modules/@soksak/plugin-api/index.js",
                &frontend
            )
            .is_err(),
            "core-root.json {text} is not an error"
        );
    }
}
