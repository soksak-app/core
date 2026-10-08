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
                r#"{"id": "term", "dependencies": {"@scope/sidecar-worker": "^0.1.0"}}"#,
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
    let release = r#"{"plugins":[{"id":"alpha","package":"plugin-alpha","version":"1.0.0","manifest":{"id":"alpha"}},{"id":"term","package":"@scope/plugin-term","version":"0.1.0","manifest":{"id":"term","dependencies":{"@scope/sidecar-worker":"^0.1.0"}}}]}"#;
    assert_eq!(
        text(installed::installed_plugins_document(config.path(), false)),
        release
    );
    let diagnostic = r#"{"plugins":[{"id":"alpha","package":"plugin-alpha","version":"1.0.0","manifest":{"id":"alpha"}},{"id":"term","package":"@scope/plugin-term","version":"0.1.0","manifest":{"id":"term","dependencies":{"@scope/sidecar-worker":"^0.1.0"}},"diagnostics":{"module":"ui/d.js","exposes":{}}}]}"#;
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

/// A configuration directory where the enabled plugin alpha declares the shared modules of the point language and the
/// disabled plugin off declares a point of the same name.
fn shared_fixture() -> tempfile::TempDir {
    let config = installed_fixture();
    write_installed(
        config.path(),
        &[
            (
                "plugins/alpha/1.0.0/plugin.json",
                r#"{"id": "alpha", "extends": {"language": {"version": "1.0.0", "schema": {},
                "modules": {"@codemirror/state": "ui/state.js", "gone": "ui/gone.js", "outside": "../../term/0.1.0/ui/term.js"}}}}"#,
            ),
            ("plugins/alpha/1.0.0/ui/state.js", "export const state = 1;"),
            (
                "plugins/off/1.0.0/plugin.json",
                r#"{"id": "off", "extends": {"language": {"version": "1.0.0", "schema": {}, "modules": {"x": "ui/x.js"}}}}"#,
            ),
            ("plugins/off/1.0.0/ui/x.js", "export const x = 1;"),
        ],
    );
    config
}

// contract: installed.shared.serve-extension-point-modules
#[test]
fn installed_assets_serve_the_shared_modules_of_extension_points() {
    let config = shared_fixture();
    let directory = Arc::new(OnceLock::new());
    directory.set(config.path().to_path_buf()).unwrap();
    let assets = InstalledAssets::<tauri::Wry> {
        frontend: Box::new(Frontend),
        config_dir: directory,
        diagnostics: false,
    };
    assert_eq!(
        assets
            .get(&AssetKey::from("/shared/alpha.language/@codemirror/state"))
            .map(|data| text(data.into_owned()))
            .as_deref(),
        Some("export const state = 1;")
    );
    // An undeclared point, an unmapped specifier, a missing file, a path outside the package and a disabled plugin
    // are not found.
    for path in [
        "/shared/alpha.missing/@codemirror/state",
        "/shared/alpha.language/@codemirror/view",
        "/shared/alpha.language/gone",
        "/shared/alpha.language/outside",
        "/shared/off.language/x",
        "/shared/nobody.language/x",
        "/shared/alpha",
        "/shared/alpha.language/",
    ] {
        assert_eq!(
            installed::installed_shared(config.path(), path),
            Ok(Module::Missing),
            "{path}"
        );
        assert!(assets.get(&AssetKey::from(path)).is_none(), "{path}");
    }
    write_installed(config.path(), &[("plugins/alpha/1.0.0/plugin.json", "{")]);
    let error =
        installed::installed_shared(config.path(), "/shared/alpha.language/@codemirror/state")
            .unwrap_err();
    let manifest = config.path().join("plugins/alpha/1.0.0/plugin.json");
    assert!(error.contains(&manifest.display().to_string()), "{error}");
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
            r#"{"id": "term", "dependencies": {"@scope/sidecar-other": "^0.1.0"}}"#,
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

// contract: installed.sidecars.leave-out-plugin-packages
#[test]
fn installed_sidecars_leave_out_the_packages_of_installed_plugins() {
    let config = installed_fixture();
    // The packages of an enabled and a disabled plugin are plugin dependencies, not sidecars.
    write_installed(
        config.path(),
        &[(
            "plugins/term/0.1.0/plugin.json",
            r#"{"id": "term", "dependencies": {"@scope/sidecar-worker": "^0.1.0", "plugin-alpha": "^1.0.0", "plugin-off": "^1.0.0"}}"#,
        )],
    );
    let declarations = installed::installed_sidecars(config.path()).unwrap();
    let names: Vec<&str> = declarations.iter().map(|item| item.name.as_str()).collect();
    assert_eq!(names, ["@scope/sidecar-worker"]);
}
