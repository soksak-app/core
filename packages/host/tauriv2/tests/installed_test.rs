//! 설정 폴더에 설치된 plugin 의 제공과 그 sidecar 찾기(docs/spec/installation.md 의 설치된 plugin 제공)를 검사한다.

use std::borrow::Cow;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use soksak_host_tauriv2::installed::{self, InstalledAssets, Module};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::Assets;

/// 경로마다 내용을 설정 폴더에 쓴다.
fn write_installed(config: &Path, files: &[(&str, &str)]) {
    for (name, content) in files {
        let file = config.join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }
}

/// 켜진 plugin 둘과 꺼진 plugin 하나, 그리고 sidecar 하나를 설치한 설정 폴더.
fn installed_fixture() -> tempfile::TempDir {
    let config = tempfile::tempdir().unwrap();
    let state = r#"{"format": 2, "plugins": {
        "term": {"package": "@scope/plugin-term", "version": "0.1.0", "path": "plugins/term/0.1.0", "enabled": true, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}},
        "alpha": {"package": "plugin-alpha", "version": "1.0.0", "path": "plugins/alpha/1.0.0", "enabled": true, "sidecars": {}},
        "off": {"package": "plugin-off", "version": "1.0.0", "path": "plugins/off/1.0.0", "enabled": false, "sidecars": {}}},
        "sidecars": {"@scope/sidecar-worker": {"version": "0.1.2", "path": "sidecars/scope-sidecar-worker/0.1.2/darwin-arm64"}}}"#;
    write_installed(
        config.path(),
        &[
            ("plugins/installed.json", state),
            (
                "plugins/term/0.1.0/plugin.json",
                r#"{"id": "term", "sidecars": ["@scope/sidecar-worker"]}"#,
            ),
            ("plugins/term/0.1.0/ui/term.js", "export const term = 1;"),
            (
                "plugins/term/0.1.0/diagnostics.json",
                "{\n  \"module\": \"ui/d.js\",\n  \"exposes\": {}\n}\n",
            ),
            ("plugins/alpha/1.0.0/plugin.json", r#"{"id": "alpha"}"#),
            ("plugins/off/1.0.0/plugin.json", r#"{"id": "off"}"#),
            (
                "sidecars/scope-sidecar-worker/0.1.2/darwin-arm64/sidecar.json",
                r#"{"executable": "build/worker", "protocol": 1}"#,
            ),
        ],
    );
    config
}

fn text(data: Vec<u8>) -> String {
    String::from_utf8(data).unwrap()
}

// contract: installed.document.lists-enabled-plugins
#[test]
fn installed_plugins_document_lists_enabled_plugins_by_id() {
    let config = installed_fixture();
    let release = r#"{"plugins":[{"id":"alpha","package":"plugin-alpha","version":"1.0.0","manifest":{"id":"alpha"}},{"id":"term","package":"@scope/plugin-term","version":"0.1.0","manifest":{"id":"term","sidecars":["@scope/sidecar-worker"]}}]}"#;
    assert_eq!(
        text(installed::installed_plugins_document(config.path(), false)),
        release
    );
    let diagnostic = r#"{"plugins":[{"id":"alpha","package":"plugin-alpha","version":"1.0.0","manifest":{"id":"alpha"}},{"id":"term","package":"@scope/plugin-term","version":"0.1.0","manifest":{"id":"term","sidecars":["@scope/sidecar-worker"]},"diagnostics":{"module":"ui/d.js","exposes":{}}}]}"#;
    assert_eq!(
        text(installed::installed_plugins_document(config.path(), true)),
        diagnostic
    );
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(
        text(installed::installed_plugins_document(empty.path(), true)),
        r#"{"plugins":[]}"#
    );
}

// contract: installed.document.reports-errors
#[test]
fn installed_plugins_document_reports_an_invalid_state() {
    let config = installed_fixture();
    write_installed(
        config.path(),
        &[("plugins/term/0.1.0/diagnostics.json", "{")],
    );
    let file = config.path().join("plugins/term/0.1.0/diagnostics.json");
    assert_eq!(
        text(installed::installed_plugins_document(config.path(), true)),
        format!(r#"{{"error":"{} is not valid JSON"}}"#, file.display())
    );
    write_installed(
        config.path(),
        &[
            ("plugins/term/0.1.0/diagnostics.json", "{}"),
            ("plugins/alpha/1.0.0/plugin.json", "{"),
        ],
    );
    let manifest = config.path().join("plugins/alpha/1.0.0/plugin.json");
    assert_eq!(
        text(installed::installed_plugins_document(config.path(), false)),
        format!(r#"{{"error":"{} is not valid JSON"}}"#, manifest.display())
    );
    std::fs::remove_file(&manifest).unwrap();
    assert_eq!(
        text(installed::installed_plugins_document(config.path(), false)),
        format!(
            r#"{{"error":"{}: the plugin manifest is missing"}}"#,
            manifest.display()
        )
    );
    write_installed(
        config.path(),
        &[(
            "plugins/installed.json",
            r#"{"format": 3, "plugins": {}, "sidecars": {}}"#,
        )],
    );
    let file = config.path().join("plugins/installed.json");
    assert_eq!(
        text(installed::installed_plugins_document(config.path(), false)),
        format!(
            r#"{{"error":"{}: plugins/installed.json: format must be 2"}}"#,
            file.display()
        )
    );
}

/// 경로를 그대로 돌려주는 frontend.
struct Frontend;

impl Assets<tauri::Wry> for Frontend {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        Some(Cow::Owned(
            format!("frontend {}", key.as_ref()).into_bytes(),
        ))
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

// contract: installed.modules.serve-installed-files
#[test]
fn installed_assets_serve_the_files_of_enabled_packages() {
    let config = installed_fixture();
    let directory = Arc::new(OnceLock::new());
    let assets = InstalledAssets::<tauri::Wry> {
        frontend: Box::new(Frontend),
        config_dir: directory.clone(),
        diagnostics: false,
    };
    let get = |path: &str| {
        assets
            .get(&AssetKey::from(path))
            .map(|data| text(data.into_owned()))
    };
    assert_eq!(
        get("/index.html"),
        None,
        "assets answer nothing before the host sets the configuration directory"
    );
    directory.set(config.path().to_path_buf()).unwrap();
    assert_eq!(
        get("/modules/@scope/plugin-term/ui/term.js").as_deref(),
        Some("export const term = 1;")
    );
    for path in [
        "/modules/@scope/plugin-term/ui/missing.js",
        "/modules/@scope/plugin-term/ui/../plugin.json",
        "/modules/plugin-alpha//plugin.json",
    ] {
        assert_eq!(
            installed::installed_module(config.path(), path),
            Ok(Module::Missing),
            "{path}"
        );
    }
    for path in [
        "/modules/plugin-off/plugin.json",
        "/modules/soksak/dist/index.js",
        "/index.html",
    ] {
        assert_eq!(get(path), Some(format!("frontend {path}")), "{path}");
    }
    assert!(get(installed::INSTALLED_PLUGINS_PATH)
        .unwrap()
        .starts_with(r#"{"plugins":[{"id":"alpha""#));
}

// contract: installed.sidecars.resolve-installed-folders, sidecars.declaration.fails-on-missing-sidecar-json
#[test]
fn installed_sidecars_resolve_the_installed_version_folders() {
    let config = installed_fixture();
    let declarations = installed::installed_sidecars(config.path()).unwrap();
    let folder = config
        .path()
        .join("sidecars/scope-sidecar-worker/0.1.2/darwin-arm64");
    assert_eq!(declarations.len(), 1);
    assert_eq!(declarations[0].name, "@scope/sidecar-worker");
    assert_eq!(declarations[0].folder, folder);
    assert_eq!(
        text(declarations[0].data.clone()),
        r#"{"executable": "build/worker", "protocol": 1}"#
    );
    let missing = folder.join("sidecar.json");
    std::fs::remove_file(&missing).unwrap();
    let error = installed::installed_sidecars(config.path()).unwrap_err();
    assert!(error.contains(&missing.display().to_string()), "{error}");
    write_installed(
        config.path(),
        &[(
            "plugins/term/0.1.0/plugin.json",
            r#"{"id": "term", "sidecars": ["@scope/sidecar-other"]}"#,
        )],
    );
    let error = installed::installed_sidecars(config.path()).unwrap_err();
    assert!(
        error.contains("sidecar @scope/sidecar-other has no installed version"),
        "{error}"
    );
    let empty = tempfile::tempdir().unwrap();
    assert!(installed::installed_sidecars(empty.path())
        .unwrap()
        .is_empty());
}
