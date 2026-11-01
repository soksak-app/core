//! Checks the releases and SHA256SUMS that sidecar release (docs/spec/cli.md) writes.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

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

/// Writes the contents of each path. When the name ends with *, it sets the execute bit.
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

#[derive(Debug)]
struct TarEntry {
    name: String,
    mode: u32,
    time: u64,
    owner: u64,
}

fn read_release(path: &Path) -> (Vec<TarEntry>, String) {
    let data = std::fs::read(path).expect("release");
    let sum: String = Sha256::digest(&data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut reader = tar::Archive::new(flate2::read::GzDecoder::new(data.as_slice()));
    let mut entries = vec![];
    for entry in reader.entries().expect("entries") {
        let entry = entry.expect("entry");
        let header = entry.header().clone();
        entries.push(TarEntry {
            name: entry.path().unwrap().display().to_string(),
            mode: header.mode().unwrap(),
            time: header.mtime().unwrap(),
            owner: header.uid().unwrap() + header.gid().unwrap(),
        });
    }
    (entries, sum)
}

fn text(path: &Path) -> &str {
    path.to_str().expect("UTF-8 path")
}

fn sidecar_tree(version: &str) -> Folder {
    let dir = Folder::new("release");
    let package = format!(
        r#"{{"name": "@scope/sidecar-worker", "version": "{version}", "files": ["sidecar.json", "build/worker"]}}"#
    );
    let binary = format!("binary {version}");
    write_tree(
        dir.path(),
        &[
            ("package.json", &package),
            (
                "sidecar.json",
                r#"{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/probe"}"#,
            ),
            ("build/worker*", &binary),
            ("build/intermediate", "not listed"),
        ],
    );
    dir
}

// contract: cli.release.requires-display-name
#[test]
fn sidecar_release_rejects_a_missing_display_name() {
    let tree = sidecar_tree("0.1.0");
    write_tree(
        tree.path(),
        &[(
            "sidecar.json",
            r#"{"executable":"build/worker","protocol":1}"#,
        )],
    );
    let out = Folder::new("release");
    let (code, _, stderr) = run(&[
        "sidecar",
        "release",
        text(tree.path()),
        text(out.path()),
        "--platform",
        "darwin-arm64",
    ]);
    assert_eq!(
        (code, stderr.as_str()),
        (1, "sok: sidecar.json: displayName is required\n")
    );
    assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
}

// contract: cli.release.writes-release-and-sums
#[test]
fn sidecar_release_writes_the_asset_and_keeps_sha256sums_sorted() {
    let out = Folder::new("release");
    let mut sums = vec![];
    for (version, platform) in [
        ("0.1.1", "linux-x64"),
        ("0.1.0", "darwin-arm64"),
        ("0.1.1", "linux-x64"),
    ] {
        let tree = sidecar_tree(version);
        let (code, stdout, stderr) = run(&[
            "sidecar",
            "release",
            text(tree.path()),
            text(out.path()),
            "--platform",
            platform,
        ]);
        assert_eq!(code, 0, "{stderr}");
        let result: Value = serde_json::from_str(&stdout).unwrap();
        let name = format!("scope-sidecar-worker-{version}-{platform}.tar.gz");
        let (entries, sum) = read_release(&out.path().join(&name));
        assert_eq!(result["release"], text(&out.path().join(&name)));
        assert_eq!(result["sha256"], sum.as_str());
        assert_eq!(
            (result["platform"].as_str(), result["version"].as_str()),
            (Some(platform), Some(version))
        );
        assert_eq!(result["name"], "@scope/sidecar-worker");
        let names: Vec<(&str, u32)> = entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.mode))
            .collect();
        assert_eq!(
            names,
            [
                ("build/worker", 0o755),
                ("package.json", 0o644),
                ("sidecar.json", 0o644)
            ]
        );
        // The writer sets time 0 and owner 0, so the same files give the same bytes.
        assert!(
            entries
                .iter()
                .all(|entry| entry.time == 0 && entry.owner == 0),
            "{entries:?}"
        );
        sums.push(format!("{sum}  {name}"));
    }
    // A third release with the same name changes the first line, and the lines are in release name order.
    let written = std::fs::read_to_string(out.path().join("SHA256SUMS")).unwrap();
    assert_eq!(written, format!("{}\n{}\n", sums[1], sums[2]));
    let tree = sidecar_tree("0.1.0");
    let (code, _, stderr) = run(&[
        "sidecar",
        "release",
        text(tree.path()),
        text(out.path()),
        "--platform",
        "solaris-sparc",
    ]);
    assert_eq!(code, 2);
    assert!(
        stderr.starts_with("sok: --platform: unknown platform solaris-sparc\n"),
        "{stderr}"
    );
    let unlisted = sidecar_tree("0.1.0");
    write_tree(
        unlisted.path(),
        &[(
            "package.json",
            r#"{"name": "@scope/sidecar-worker", "version": "0.1.0", "files": ["sidecar.json"]}"#,
        )],
    );
    let (code, _, stderr) = run(&[
        "sidecar",
        "release",
        text(unlisted.path()),
        text(out.path()),
        "--platform",
        "darwin-arm64",
    ]);
    assert_eq!(
        (code, stderr.as_str()),
        (1, "sok: package.json files: build/worker is not listed\n")
    );
    write_tree(out.path(), &[("SHA256SUMS", "broken\n")]);
    let tree = sidecar_tree("0.2.0");
    let (code, _, stderr) = run(&[
        "sidecar",
        "release",
        text(tree.path()),
        text(out.path()),
        "--platform",
        "darwin-arm64",
    ]);
    let want = format!(
        "sok: {} line 1 is not \"<sha256>  <release name>\"\n",
        text(&out.path().join("SHA256SUMS"))
    );
    assert_eq!((code, stderr), (1, want));
    assert!(
        !out.path()
            .join("scope-sidecar-worker-0.2.0-darwin-arm64.tar.gz")
            .exists(),
        "a failed release left its release"
    );
}

// contract: cli.release.requires-the-replay-executable
#[test]
fn sidecar_release_refuses_a_replay_executable_that_the_package_does_not_ship() {
    let out = Folder::new("release");
    let tree = sidecar_tree("0.1.0");
    write_tree(
        tree.path(),
        &[
            (
                "sidecar.json",
                r#"{"executable": "build/worker", "displayName":"soksak://sidecar/probe","protocol": 1, "replay": {"role": "screen", "executable": "build/replay"}}"#,
            ),
            ("build/replay*", "binary replay"),
        ],
    );
    let release = |tree: &Folder| {
        run(&[
            "sidecar",
            "release",
            text(tree.path()),
            text(out.path()),
            "--platform",
            "darwin-arm64",
        ])
    };
    let (code, _, stderr) = release(&tree);
    assert_eq!(
        (code, stderr.as_str()),
        (
            1,
            "sok: package.json files: build/replay, the replay executable of sidecar.json, is not listed\n"
        )
    );
    assert!(
        !out.path()
            .join("scope-sidecar-worker-0.1.0-darwin-arm64.tar.gz")
            .exists(),
        "a refused release left its release"
    );
    write_tree(
        tree.path(),
        &[(
            "package.json",
            r#"{"name": "@scope/sidecar-worker", "version": "0.1.0", "files": ["sidecar.json", "build/worker", "build/replay"]}"#,
        )],
    );
    let (code, _, stderr) = release(&tree);
    assert_eq!(
        (code, stderr.as_str()),
        (0, ""),
        "a release that ships its replay executable failed"
    );
    write_tree(
        tree.path(),
        &[(
            "sidecar.json",
            r#"{"executable": "build/worker", "displayName":"soksak://sidecar/probe","protocol": 1, "replay": {"role": "screen"}}"#,
        )],
    );
    let (code, _, stderr) = release(&tree);
    assert_eq!(
        (code, stderr.as_str()),
        (1, "sok: sidecar.json: replay.executable is required\n")
    );
}
