//! Checks the installation formats (docs/spec/installation.md) and the version selection.

use serde_json::{Value, json};
use soksak_sok::install::{self, InstalledPlugin, InstalledSidecar, InstalledState, Selection};

const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn release(name: &str) -> Value {
    json!({"url": format!("file:///releases/{name}"), "sha256": SHA})
}

fn plugin() -> Value {
    let version = |version: &str, core: &str| {
        json!({"version": version, "release": release(&format!("probe-{version}.tgz")), "engines": {"soksak": core},
            "sidecars": {"@scope/sidecar-worker": "^0.1.0"}})
    };
    json!({"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.", "license": "MIT",
        "repository": "https://example.invalid/probe",
        "versions": [version("0.1.0", "^0.0.1"), version("0.2.0", "^0.0.2"), version("0.3.0", "^0.0.2")]})
}

fn sidecar() -> Value {
    json!({"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker", "versions": [
        {"version": "0.1.0", "protocol": 1, "releases": {"darwin-arm64": release("a"), "darwin-x64": release("b")}},
        {"version": "0.1.1", "protocol": 1, "releases": {"darwin-arm64": release("c")}}]})
}

fn index() -> Value {
    json!({"format": 1, "plugins": [plugin()], "sidecars": [sidecar()],
        "packs": [{"name": "starter", "description": "처음 설치하는 plugin.", "plugins": ["probe"]}],
        "revoked": {"plugins": [{"id": "probe", "version": "0.3.0", "reason": "breaks saved spaces"}], "sidecars": []}})
}

#[track_caller]
fn rejects<T: std::fmt::Debug>(result: Result<T, String>, want: &str) {
    match result {
        Err(error) if error.contains(want) => {}
        other => panic!("result {other:?}, want {want:?}"),
    }
}

// contract: install.version.ranges-and-order
#[test]
fn version_ranges_accept_exact_caret_tilde_and_bounded_forms() {
    for (text, min, below) in [
        ("0.0.2", "0.0.2", "0.0.3"),
        ("^0.0.2", "0.0.2", "0.0.3"),
        ("^0.2.3", "0.2.3", "0.3.0"),
        ("^1.2.3", "1.2.3", "2.0.0"),
        ("~1.2.3", "1.2.3", "1.3.0"),
        (">=0.0.2 <0.1.0", "0.0.2", "0.1.0"),
    ] {
        let range = install::parse_range(text).expect(text);
        assert_eq!(
            (
                range.min.to_string(),
                range
                    .below
                    .map(|below| below.to_string())
                    .unwrap_or_default()
            ),
            (min.to_string(), below.to_string()),
            "{text}"
        );
    }
    assert!(install::satisfies("0.0.9", ">=0.0.2 <0.1.0"));
    assert!(!install::satisfies("0.1.0", ">=0.0.2 <0.1.0"));
    // * is >=0.0.0, that is, every version, with no upper bound.
    let any = install::parse_range("*").expect("*");
    assert_eq!(
        (any.min.to_string(), any.below),
        ("0.0.0".to_string(), None)
    );
    for version in [
        "0.0.0",
        "0.0.4",
        "1.2.3",
        "4294967295.4294967295.4294967295",
    ] {
        assert!(
            install::satisfies(version, "*"),
            "* does not contain {version}"
        );
    }
    // >=x.y.z has only a lower bound and no upper bound.
    let lower = install::parse_range(">=0.0.6").expect(">=0.0.6");
    assert_eq!(
        (lower.min.to_string(), lower.below),
        ("0.0.6".to_string(), None)
    );
    assert!(install::satisfies("0.0.6", ">=0.0.6"));
    assert!(install::satisfies("0.1.0", ">=0.0.6"));
    assert!(!install::satisfies("0.0.5", ">=0.0.6"));
    assert!(
        install::parse_version("0.10.0").unwrap() > install::parse_version("0.9.9").unwrap(),
        "versions compare by number, not text"
    );
    for bad in [
        "**",
        "latest",
        "0.0",
        "01.0.0",
        ">=0.1.0 <0.1.0",
        "^0.0.2-beta",
        "4294967296.0.0",
        ">=",
        ">=0.0",
        ">= 0.0.6",
        ">=0.0.6 <",
    ] {
        rejects(install::parse_range(bad), "invalid version");
    }
}

// contract: install.version.ranges-and-order
#[test]
fn versions_and_ranges_refuse_the_forms_that_the_library_accepts() {
    for good in ["0.0.0", "4294967295.4294967295.4294967295"] {
        install::parse_version(good).expect(good);
    }
    for bad in [
        "1.2.3-beta",
        "1.2.3+build",
        "v1.2.3",
        "1.2",
        "1.2.3.4",
        "01.2.3",
        "1.02.3",
        "1.2.x",
        "1.2.3 ",
        "4294967296.0.0",
    ] {
        rejects(install::parse_version(bad), "invalid version");
    }
    for bad in [
        "1.x",
        "~>1.2",
        "1.2.3 - 2.3.4",
        ">1.2.3",
        "<2.0.0",
        "!=1.2.3",
        "=1.2.3",
        "1.2.3, 1.2.4",
        "^1.2.3 || ^2.0.0",
        "*.*.*",
        "x",
        "~1.2.3-beta",
        ">=4294967296.0.0",
        "^4294967296.0.0",
        ">=1.0.0<2.0.0",
    ] {
        rejects(install::parse_range(bad), "invalid version");
    }
    assert!(!install::satisfies("1.2.3-beta", "*"));
    assert!(!install::satisfies("1.2.3", "1.x"));
}

// contract: install.package-json.fields-and-manifest
#[test]
fn package_json_declares_version_core_range_and_files_and_the_manifest_declares_sidecar_ranges() {
    let pkg = json!({"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"},
        "files": ["plugin.json", "ui"], "private": true});
    install::validate_package_json(&pkg).expect("package");
    let ranges = install::manifest_dependencies(
        &json!({"dependencies": {"@scope/sidecar-worker": "^0.1.0"}}),
    )
    .expect("manifest");
    assert_eq!(
        ranges.into_iter().collect::<Vec<_>>(),
        [("@scope/sidecar-worker".to_string(), "^0.1.0".to_string())]
    );
    assert!(
        install::manifest_dependencies(&json!({}))
            .expect("no dependencies")
            .is_empty()
    );
    rejects(
        install::manifest_dependencies(
            &json!({"dependencies": {"@scope/sidecar-worker": "latest"}}),
        ),
        "plugin.json dependencies @scope/sidecar-worker: invalid version range",
    );
    rejects(
        install::manifest_dependencies(&json!({"dependencies": ["@scope/sidecar-worker"]})),
        "plugin.json dependencies: expected an object",
    );
    for (field, value, want) in [
        (
            "engines",
            json!({}),
            "package.json engines.soksak: invalid version range null",
        ),
        (
            "files",
            json!(["ui"]),
            "package.json files: plugin.json is not listed",
        ),
        (
            "files",
            json!(["plugin.json", "../ui"]),
            "package.json files: expected paths inside the package",
        ),
        (
            "soksak",
            json!({"sidecars": {}}),
            "package.json soksak: the sidecars of a plugin and their ranges are the dependencies of plugin.json",
        ),
        (
            "version",
            json!("0.2"),
            r#"package.json version: invalid version "0.2": expected x.y.z"#,
        ),
        (
            "name",
            json!("Plugin"),
            "package.json name: expected a package.json name",
        ),
    ] {
        let mut changed = pkg.clone();
        changed[field] = value;
        rejects(install::validate_package_json(&changed), want);
    }
}

// contract: install.registry.entries
#[test]
fn registry_entries_reject_unknown_fields_bad_releases_and_repeated_versions() {
    install::validate_registry_plugin(&plugin()).expect("plugin");
    install::validate_registry_sidecar(&sidecar()).expect("sidecar");
    let mut extra = plugin();
    extra["homepage"] = json!("x");
    rejects(
        install::validate_registry_plugin(&extra),
        "registry plugin probe: unknown field homepage",
    );
    for (url, want) in [
        (
            "ftp://example.invalid/probe.tgz",
            "ftp://example.invalid/probe.tgz: the URL must be https: or an absolute file: URL",
        ),
        (
            "https:probe.tgz",
            "https:probe.tgz: the URL must be https: or an absolute file: URL",
        ),
        (
            "file:releases/probe.tgz",
            "file:releases/probe.tgz: url must be an absolute file: URL",
        ),
        (
            "file:///releases/probe.tgz?x=1",
            "file:///releases/probe.tgz?x=1: url must be an absolute file: URL without a query or fragment",
        ),
        (
            "file:///releases/%zz.tgz",
            "file:///releases/%zz.tgz: url has an invalid escape",
        ),
    ] {
        let mut changed = plugin();
        changed["versions"][0]["release"]["url"] = json!(url);
        rejects(
            install::validate_registry_plugin(&changed),
            &format!("registry plugin probe 0.1.0 release: {want}"),
        );
    }
    assert_eq!(
        install::file_path("file:///Users/a%20b/probe.tgz").as_deref(),
        Ok("/Users/a b/probe.tgz")
    );
    let mut hash = plugin();
    hash["versions"][0]["release"]["sha256"] = json!("ABC");
    rejects(
        install::validate_registry_plugin(&hash),
        "sha256 must be 64 lowercase hexadecimal digits",
    );
    let mut twice = plugin();
    let first = twice["versions"][0].clone();
    twice["versions"].as_array_mut().unwrap().push(first);
    rejects(
        install::validate_registry_plugin(&twice),
        "registry plugin probe: version 0.1.0 appears twice",
    );
    let mut long = plugin();
    long["description"] = json!("가".repeat(201));
    rejects(
        install::validate_registry_plugin(&long),
        "description must be 1 to 200 characters",
    );
    long["description"] = json!("가".repeat(200));
    install::validate_registry_plugin(&long).expect("200 characters");
    let mut platform = sidecar();
    platform["versions"][0]["releases"]["darwin-ppc"] = release("x");
    rejects(
        install::validate_registry_sidecar(&platform),
        "registry sidecar @scope/sidecar-worker 0.1.0: unknown platform darwin-ppc",
    );
    let protocol: Value = serde_json::from_str(&sidecar().to_string().replacen(
        r#""protocol":1"#,
        r#""protocol":1.0"#,
        1,
    ))
    .unwrap();
    rejects(
        install::validate_registry_sidecar(&protocol),
        "registry sidecar @scope/sidecar-worker 0.1.0: protocol must be 1",
    );
    rejects(
        install::validate_registry_pack(
            &json!({"name": "starter", "description": "x", "plugins": []}),
        ),
        "registry pack starter: plugins must be plugin ids",
    );
    rejects(
        install::validate_revoked(
            &json!({"plugins": [{"id": "probe", "version": "0.1.0"}], "sidecars": []}),
        ),
        "registry revoked plugins probe: reason is required",
    );
}

// contract: install.registry.index-cross-checks
#[test]
fn registry_index_checks_names_packs_sidecar_ranges_and_revoked_versions() {
    install::validate_registry_index(&index()).expect("index");
    let mut pack = index();
    pack["packs"][0]["plugins"]
        .as_array_mut()
        .unwrap()
        .push(json!("missing"));
    rejects(
        install::validate_registry_index(&pack),
        "registry index: pack starter names unknown plugin missing",
    );
    let mut range = index();
    range["plugins"][0]["versions"][0]["sidecars"]["@scope/sidecar-worker"] = json!("^0.2.0");
    rejects(
        install::validate_registry_index(&range),
        "registry index: plugin probe 0.1.0 needs @scope/sidecar-worker ^0.2.0, which no version satisfies",
    );
    let mut unknown = index();
    unknown["plugins"][0]["versions"][0]["sidecars"] = json!({"@scope/sidecar-gone": "^0.1.0"});
    rejects(
        install::validate_registry_index(&unknown),
        "registry index: plugin probe 0.1.0 needs unknown sidecar @scope/sidecar-gone",
    );
    let mut revoked = index();
    revoked["revoked"]["plugins"][0]["version"] = json!("9.9.9");
    rejects(
        install::validate_registry_index(&revoked),
        "registry index: revoked plugin probe 9.9.9 is not listed",
    );
    let mut duplicate = index();
    let mut other = plugin();
    other["id"] = json!("other");
    duplicate["plugins"].as_array_mut().unwrap().push(other);
    rejects(
        install::validate_registry_index(&duplicate),
        "registry index: package @scope/plugin-probe appears twice",
    );
    let mut format = index();
    format["format"] = json!(2);
    rejects(
        install::validate_registry_index(&format),
        "registry index: format must be 1",
    );
}

fn versions(selection: &Selection) -> Vec<String> {
    selection
        .sidecars
        .iter()
        .map(|item| format!("{} {}", item.name, item.version))
        .collect()
}

// contract: install.select.newest-usable
#[test]
fn installation_resolves_newest_usable_plugin_and_sidecar_versions() {
    let index = install::validate_registry_index(&index()).expect("index");
    let empty = InstalledState::empty();
    // 0.3.0 is revoked, so the check selects 0.2.0, and for the sidecar it selects 0.1.1, the newest version that has a darwin-arm64 asset.
    let arm = install::resolve_install(&index, "probe", "0.0.2", "darwin-arm64", &empty, &[])
        .expect("darwin-arm64");
    assert_eq!(arm.version.version, "0.2.0");
    assert_eq!(versions(&arm), ["@scope/sidecar-worker 0.1.1"]);
    assert_eq!(arm.sidecars[0].release.url, "file:///releases/c");
    // The darwin-x64 asset exists only in 0.1.0.
    let x64 = install::resolve_install(&index, "probe", "0.0.2", "darwin-x64", &empty, &[])
        .expect("darwin-x64");
    assert_eq!(versions(&x64), ["@scope/sidecar-worker 0.1.0"]);
    let old = install::resolve_install(&index, "probe", "0.0.1", "darwin-arm64", &empty, &[])
        .expect("core 0.0.1");
    assert_eq!(old.version.version, "0.1.0");
    rejects(
        install::resolve_install(&index, "probe", "0.1.0", "darwin-arm64", &empty, &[]),
        "plugin probe has no version for core 0.1.0",
    );
    rejects(
        install::resolve_install(&index, "probe", "0.0.2", "linux-x64", &empty, &[]),
        "sidecar @scope/sidecar-worker has no version for linux-x64 that satisfies every installed plugin: probe 0.2.0 needs ^0.1.0",
    );
    rejects(
        install::resolve_install(&index, "gone", "0.0.2", "darwin-arm64", &empty, &[]),
        "plugin gone is not in the registry",
    );
    // A version that does not satisfy the range of an installed plugin that names the plugin is not selected.
    rejects(
        install::resolve_install(
            &index,
            "probe",
            "0.0.2",
            "darwin-arm64",
            &empty,
            &[install::Need {
                who: "ext 1.0.0".into(),
                range: "^0.3.0".into(),
            }],
        ),
        "plugin probe has no version for core 0.0.2 that satisfies every installed plugin: ext 1.0.0 needs ^0.3.0",
    );
}

fn installed(id: &str, version: &str, range: &str, used: &str) -> InstalledState {
    let mut state = InstalledState::empty();
    state.plugins.insert(
        id.into(),
        InstalledPlugin {
            version: version.into(),
            path: format!("/config/plugins/{id}/{version}"),
            enabled: true,
            sidecars: [("@scope/sidecar-worker".to_string(), range.to_string())].into(),
            previous: None,
        },
    );
    state.sidecars.insert(
        "@scope/sidecar-worker".into(),
        InstalledSidecar {
            version: used.into(),
            path: format!("/config/sidecars/scope-sidecar-worker/{used}/darwin-arm64"),
        },
    );
    state
}

// contract: install.select.shared-sidecar
#[test]
fn installation_keeps_one_sidecar_version_that_satisfies_every_installed_plugin() {
    let index = install::validate_registry_index(&index()).expect("index");
    let other = |range: &str, used: &str| installed("other", "1.0.0", range, used);
    // Another plugin uses 0.1.0 and that version satisfies both ranges, so the check keeps 0.1.0 instead of the newer 0.1.1.
    let kept = install::resolve_install(
        &index,
        "probe",
        "0.0.2",
        "darwin-arm64",
        &other("^0.1.0", "0.1.0"),
        &[],
    )
    .expect("kept");
    assert_eq!(versions(&kept), ["@scope/sidecar-worker 0.1.0"]);
    // When the range of another plugin allows only 0.1.0, the check selects 0.1.0, which satisfies both ranges.
    let exact = install::resolve_install(
        &index,
        "probe",
        "0.0.2",
        "darwin-arm64",
        &other("0.1.0", "0.1.0"),
        &[],
    )
    .expect("exact");
    assert_eq!(versions(&exact), ["@scope/sidecar-worker 0.1.0"]);
    // When no version satisfies the ranges together, selection fails and names each plugin and range.
    rejects(
        install::resolve_install(
            &index,
            "probe",
            "0.0.2",
            "darwin-arm64",
            &other("^0.2.0", "0.2.0"),
            &[],
        ),
        "sidecar @scope/sidecar-worker has no version for darwin-arm64 that satisfies every installed plugin: probe 0.2.0 needs ^0.1.0, other 1.0.0 needs ^0.2.0",
    );
    // The range of a previous version of the same plugin does not block the new version.
    let own = installed("probe", "0.1.0", "0.1.0", "0.1.0");
    let again = install::resolve_install(&index, "probe", "0.0.2", "darwin-arm64", &own, &[])
        .expect("self");
    assert_eq!(versions(&again), ["@scope/sidecar-worker 0.1.0"]);
}

// contract: install.names.releases-and-paths
#[test]
fn releases_and_installation_paths_follow_the_declared_names() {
    assert_eq!(install::release_name("probe", "0.2.0"), "probe-0.2.0.tgz");
    assert_eq!(
        install::sidecar_release_name("@scope/sidecar-worker", "0.1.1", "darwin-arm64").as_deref(),
        Ok("scope-sidecar-worker-0.1.1-darwin-arm64.tar.gz")
    );
    assert_eq!(
        install::plugin_install_path("probe", "0.2.0").as_deref(),
        Ok("plugins/probe/0.2.0")
    );
    assert_eq!(
        install::sidecar_install_path("@scope/sidecar-worker", "0.1.1", "darwin-arm64").as_deref(),
        Ok("sidecars/scope-sidecar-worker/0.1.1/darwin-arm64")
    );
    rejects(
        install::sidecar_release_name("@scope/sidecar-worker", "0.1.1", "solaris-sparc"),
        "unknown platform solaris-sparc",
    );
    rejects(
        install::plugin_install_path("../x", "0.2.0"),
        "invalid plugin id ../x",
    );
    assert_eq!(install::PLATFORMS.len(), 6);
}

// contract: install.installed.consistency
#[test]
fn installed_state_names_one_version_of_each_plugin_and_sidecar() {
    let state = json!({"format": 3, "plugins": {
        "probe": {"version": "0.2.0", "path": "plugins/probe/0.2.0", "enabled": true,
            "previous": "0.1.0", "sidecars": {"@scope/sidecar-worker": "^0.1.0"}},
        "side": {"version": "1.0.0", "path": "plugins/side/1.0.0", "enabled": false, "sidecars": {}}},
        "sidecars": {"@scope/sidecar-worker": {"version": "0.1.1", "path": "sidecars/scope-sidecar-worker/0.1.1/darwin-arm64"}}});
    let read = install::validate_installed(&state).expect("installed");
    assert_eq!(read.plugins["probe"].previous.as_deref(), Some("0.1.0"));
    assert_eq!(read.sidecars["@scope/sidecar-worker"].version, "0.1.1");
    assert_eq!(read.plugins["probe"].path, "plugins/probe/0.2.0");
    type Change = fn(&mut Value);
    let cases: [(Change, &str); 14] = [
        (
            |v| {
                _ = v["plugins"]["probe"]
                    .as_object_mut()
                    .unwrap()
                    .remove("enabled")
            },
            "plugins/installed.json probe: enabled must be true or false",
        ),
        (
            |v| v["plugins"]["side"]["package"] = json!("plugin-side"),
            "plugins/installed.json side: unknown field package",
        ),
        (
            |v| _ = v.as_object_mut().unwrap().remove("sidecars"),
            "plugins/installed.json sidecars: expected an object",
        ),
        (
            |v| {
                _ = v["plugins"]["side"]
                    .as_object_mut()
                    .unwrap()
                    .remove("sidecars")
            },
            "plugins/installed.json side sidecars: expected an object",
        ),
        (
            |v| v["sidecars"] = json!({}),
            "plugins/installed.json probe: sidecar @scope/sidecar-worker has no version in use",
        ),
        (
            |v| v["sidecars"]["@scope/sidecar-worker"] = json!({"version": "0.2.0", "path": "sidecars/scope-sidecar-worker/0.2.0/darwin-arm64"}),
            "plugins/installed.json probe: sidecar @scope/sidecar-worker 0.2.0 does not satisfy ^0.1.0",
        ),
        (
            |v| {
                v["sidecars"]["unused"] =
                    json!({"version": "1.0.0", "path": "sidecars/unused/1.0.0/darwin-arm64"})
            },
            "plugins/installed.json: sidecar unused is named by no installed plugin",
        ),
        (
            |v| v["format"] = json!(1),
            "plugins/installed.json: format must be 3",
        ),
        (
            |v| v["plugins"]["probe"]["path"] = json!("/config/plugins/probe/0.2.0"),
            "plugins/installed.json probe: path must be plugins/probe/0.2.0",
        ),
        (
            |v| v["plugins"]["probe"]["path"] = json!("plugins/probe/../side/1.0.0"),
            "plugins/installed.json probe: path must be plugins/probe/0.2.0",
        ),
        (
            |v| {
                v["sidecars"]["@scope/sidecar-worker"]["path"] =
                    json!("sidecars/scope-sidecar-worker/0.1.0/darwin-arm64")
            },
            "plugins/installed.json sidecar @scope/sidecar-worker: path must be sidecars/scope-sidecar-worker/0.1.1/<platform>",
        ),
        (
            |v| {
                v["sidecars"]["@scope/sidecar-worker"]["path"] =
                    json!("sidecars/scope-sidecar-worker/0.1.1/plan9-arm64")
            },
            "plugins/installed.json sidecar @scope/sidecar-worker: path must be sidecars/scope-sidecar-worker/0.1.1/<platform>",
        ),
        (
            |v| {
                _ = v["sidecars"]["@scope/sidecar-worker"]
                    .as_object_mut()
                    .unwrap()
                    .remove("path")
            },
            "plugins/installed.json sidecar @scope/sidecar-worker: path must be sidecars/scope-sidecar-worker/0.1.1/<platform>",
        ),
        (
            |v| v["sidecars"]["@scope/sidecar-worker"] = json!("0.1.1"),
            "plugins/installed.json sidecar @scope/sidecar-worker: expected an object",
        ),
    ];
    for (change, want) in cases {
        let mut value = state.clone();
        change(&mut value);
        rejects(install::validate_installed(&value), want);
    }
}
