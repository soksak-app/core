//! Checks the program file of a plugin at install of a release (docs/spec/plugins.md#pluginjson): a programs member whose
//! program is plugin:<path> needs a regular file with an execute bit at <path> in the installed version folder.

use std::path::Path;

use serde_json::json;

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

/// Writes the contents of each path, creating its folders.
fn write_tree(dir: &Path, files: &[(&str, &str)]) {
    for (name, content) in files {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
    }
}

/// A registry index whose plugin probe 0.2.0 is the release at path with sum.
fn index_for_release(path: &Path, sum: &str) -> Folder {
    let dir = Folder::new("program-file-index");
    let plugin = json!({"id": "probe", "package": "@scope/plugin-probe", "name": "Probe",
        "description": "검사용 plugin.", "license": "MIT", "repository": "https://example.invalid/probe",
        "versions": [{"version": "0.2.0",
            "release": {"url": format!("file://{}", path.display()), "sha256": sum},
            "engines": {"soksak": "^0.0.2"}, "sidecars": {}, "plugins": {}}]});
    let index = json!({"format": 2, "plugins": [plugin], "sidecars": [], "packs": [],
        "revoked": {"plugins": [], "sidecars": []}});
    write_tree(dir.path(), &[("index.json", &index.to_string())]);
    dir
}

/// Packages a view plugin whose programs.run names plugin:bin/tool with the given package files, which are executable when
/// executable is true, and installs it. Returns the exit code, the standard error and whether the installation state was written.
fn install_program_probe(files: &[&str], executable: bool) -> (i32, String, bool, bool) {
    let manifest = json!({"id": "probe", "name": "Probe", "description": "Sample.",
        "surface": {"composition": {"kind": "view", "page": "ui/page.html"}},
        "mark": "P", "icon": "<svg></svg>",
        "programs": {"run": {"program": "plugin:bin/tool"}}});
    let mut package_files = vec!["plugin.json", "ui/page.html"];
    package_files.extend_from_slice(files);
    let package = json!({"name": "@scope/plugin-probe", "version": "0.2.0",
        "engines": {"soksak": "^0.0.2"}, "files": package_files});
    let dir = Folder::new("program-file-plugin");
    write_tree(
        dir.path(),
        &[
            ("package.json", &package.to_string()),
            ("plugin.json", &manifest.to_string()),
            ("ui/page.html", ""),
        ],
    );
    for file in files {
        write_tree(dir.path(), &[(file, "")]);
        set_executable(&dir.path().join(file), executable);
    }
    let out = Folder::new("program-file-release");
    let release = package_release::pack(dir.path(), out.path());
    let index = index_for_release(
        Path::new(release["release"].as_str().unwrap()),
        release["sha256"].as_str().unwrap(),
    );
    let config = Folder::new("program-file-config");
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
    let folder = config.path().join("plugins/probe/0.2.0").exists();
    (code, stderr, installed, folder)
}

/// Sets the owner, group and other execute bits of a file that is written by a test.
fn set_executable(path: &Path, executable: bool) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if executable { 0o755 } else { 0o644 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

// contract: install.plugin-program-file
#[test]
fn plugin_install_checks_the_program_file_of_the_plugin() {
    let (code, stderr, installed, _) = install_program_probe(&["bin/tool"], true);
    assert!(
        code == 0 && installed,
        "an executable program file: code {code} stderr {stderr:?}"
    );

    let (code, stderr, installed, _) = install_program_probe(&["bin/tool"], false);
    let want = "sok: plugin probe: programs.run program plugin:bin/tool is not a regular executable file\n";
    assert!(
        code == 1 && stderr == want && !installed,
        "a program file without an execute bit: code {code} stderr {stderr:?}"
    );

    let (code, stderr, installed, _) = install_program_probe(&[], true);
    let want = "sok: plugin probe: programs.run program plugin:bin/tool is not found\n";
    assert!(
        code == 1 && stderr == want && !installed,
        "a missing program file: code {code} stderr {stderr:?}"
    );
}

/// A refused installation removes the version folder that it extracted, so the next installation of the same version extracts the
/// release again instead of reading the refused files (docs/spec/installation.md#installation-layout).
#[test]
fn a_refused_plugin_install_leaves_no_version_folder() {
    let (code, stderr, installed, folder) = install_program_probe(&["bin/tool"], false);
    assert!(
        code == 1 && !installed,
        "a program file without an execute bit: code {code} stderr {stderr:?}"
    );
    assert!(!folder, "the refused installation left plugins/probe/0.2.0");
}
