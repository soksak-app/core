//! plugin pack 과 sidecar release(docs/spec/cli.md)가 쓰는 archive 와 SHA256SUMS 를 검사한다.

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::Value;
use sha2::{Digest, Sha256};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// 테스트마다 고유한 임시 폴더. 끝나면 지운다.
struct Dir(PathBuf);

impl Dir {
    fn new() -> Dir {
        let path = std::env::temp_dir().join(format!(
            "sok-release{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).expect("create temporary directory");
        Dir(path)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        // 테스트 뒤 정리다. 지우지 못한 폴더는 다음 테스트에 영향을 주지 않는 고유 이름이다.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (vec![], vec![]);
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Path::new("/nonexistent/paths.d"),
        core_version: "0.0.2",
    };
    let code = soksak_sok::run(&args, &mut stdout, &mut stderr, &options);
    (
        code,
        String::from_utf8(stdout).expect("stdout"),
        String::from_utf8(stderr).expect("stderr"),
    )
}

/// 경로마다 내용을 쓴다. 이름이 * 로 끝나면 실행 bit 를 붙인다.
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
    content: String,
}

fn read_archive(path: &Path) -> (Vec<TarEntry>, String) {
    let data = std::fs::read(path).expect("archive");
    let sum: String = Sha256::digest(&data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(data.as_slice()));
    let mut entries = vec![];
    for entry in archive.entries().expect("entries") {
        let mut entry = entry.expect("entry");
        let header = entry.header().clone();
        let mut content = String::new();
        entry.read_to_string(&mut content).expect("content");
        entries.push(TarEntry {
            name: entry.path().unwrap().display().to_string(),
            mode: header.mode().unwrap(),
            time: header.mtime().unwrap(),
            owner: header.uid().unwrap() + header.gid().unwrap(),
            content,
        });
    }
    (entries, sum)
}

fn plugin_tree() -> Dir {
    let dir = Dir::new();
    write_tree(
        &dir.0,
        &[
            (
                "package.json",
                r#"{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"},
                "soksak": {"sidecars": {"@scope/sidecar-worker": "^0.1.0"}}, "files": ["plugin.json", "ui"]}"#,
            ),
            (
                "plugin.json",
                r#"{"id": "probe", "sidecars": ["@scope/sidecar-worker"]}"#,
            ),
            ("ui/b.js", "b"),
            ("ui/a/run.sh*", "run"),
            ("test/skip.mjs", "not listed"),
        ],
    );
    dir
}

fn text(path: &Path) -> &str {
    path.to_str().expect("UTF-8 path")
}

// contract: cli.pack.writes-sorted-plugin-archive
#[test]
fn plugin_pack_writes_a_sorted_archive_of_the_listed_files() {
    let dir = plugin_tree();
    let base = Dir::new();
    let out = base.0.join("out");
    let (code, stdout, stderr) = run(&["plugin", "pack", text(&dir.0), text(&out)]);
    assert_eq!(code, 0, "{stderr}");
    let archive = out.join("probe-0.2.0.tgz");
    let (entries, sum) = read_archive(&archive);
    let want = format!(
        "{{\n  \"archive\": {:?},\n  \"id\": \"probe\",\n  \"sha256\": {sum:?},\n  \"version\": \"0.2.0\"\n}}\n",
        text(&archive)
    );
    assert_eq!(stdout, want);
    let names: Vec<String> = entries
        .iter()
        .map(|entry| {
            format!(
                "{} {:o} {} {}",
                entry.name, entry.mode, entry.time, entry.owner
            )
        })
        .collect();
    assert_eq!(
        names,
        [
            "package.json 644 0 0",
            "plugin.json 644 0 0",
            "ui/a/run.sh 755 0 0",
            "ui/b.js 644 0 0"
        ]
    );
    assert_eq!(entries[3].content, "b");
    // 같은 폴더를 다시 pack 하면 같은 byte 를 쓴다.
    let (code, again, _) = run(&["plugin", "pack", text(&dir.0), text(&out)]);
    assert_eq!((code, again), (0, stdout));
}

// contract: cli.pack.rejects-links-and-manifest-mismatch
#[test]
fn plugin_pack_rejects_links_and_a_manifest_mismatch_without_writing() {
    let dir = plugin_tree();
    std::os::unix::fs::symlink("b.js", dir.0.join("ui/link.js")).unwrap();
    let base = Dir::new();
    let out = base.0.join("out");
    let (code, _, stderr) = run(&["plugin", "pack", text(&dir.0), text(&out)]);
    assert_eq!(
        (code, stderr.as_str()),
        (
            1,
            "sok: ui/link.js is a symbolic link; an archive holds no links\n"
        )
    );
    assert_eq!(
        std::fs::read_dir(&out)
            .map(|names| names.count())
            .unwrap_or(0),
        0,
        "a failed pack left files"
    );
    let other = plugin_tree();
    write_tree(&other.0, &[("plugin.json", r#"{"id": "probe"}"#)]);
    let (code, _, stderr) = run(&["plugin", "pack", text(&other.0), text(&out)]);
    assert_eq!(
        (code, stderr.as_str()),
        (1, "sok: @scope/plugin-probe: plugin.json sidecars [] differ from package.json soksak.sidecars [\"@scope/sidecar-worker\"]\n")
    );
    write_tree(
        &other.0,
        &[("plugin.json", r#"{"sidecars": ["@scope/sidecar-worker"]}"#)],
    );
    let (code, _, stderr) = run(&["plugin", "pack", text(&other.0), text(&out)]);
    assert_eq!(
        (code, stderr.as_str()),
        (1, "sok: plugin.json: id must be a lowercase identifier\n")
    );
}

fn sidecar_tree(version: &str) -> Dir {
    let dir = Dir::new();
    let package = format!(
        r#"{{"name": "@scope/sidecar-worker", "version": "{version}", "files": ["sidecar.json", "build/worker"]}}"#
    );
    let binary = format!("binary {version}");
    write_tree(
        &dir.0,
        &[
            ("package.json", &package),
            (
                "sidecar.json",
                r#"{"executable": "build/worker", "protocol": 1}"#,
            ),
            ("build/worker*", &binary),
            ("build/intermediate", "not listed"),
        ],
    );
    dir
}

// contract: cli.release.writes-asset-and-sums
#[test]
fn sidecar_release_writes_the_asset_and_keeps_sha256sums_sorted() {
    let out = Dir::new();
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
            text(&tree.0),
            text(&out.0),
            "--platform",
            platform,
        ]);
        assert_eq!(code, 0, "{stderr}");
        let result: Value = serde_json::from_str(&stdout).unwrap();
        let name = format!("scope-sidecar-worker-{version}-{platform}.tar.gz");
        let (entries, sum) = read_archive(&out.0.join(&name));
        assert_eq!(result["archive"], text(&out.0.join(&name)));
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
        sums.push(format!("{sum}  {name}"));
    }
    // 같은 이름의 세 번째 release 는 첫 줄을 바꾸고, 줄은 archive 이름 순서다.
    let written = std::fs::read_to_string(out.0.join("SHA256SUMS")).unwrap();
    assert_eq!(written, format!("{}\n{}\n", sums[1], sums[2]));
    let tree = sidecar_tree("0.1.0");
    let (code, _, stderr) = run(&[
        "sidecar",
        "release",
        text(&tree.0),
        text(&out.0),
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
        &unlisted.0,
        &[(
            "package.json",
            r#"{"name": "@scope/sidecar-worker", "version": "0.1.0", "files": ["sidecar.json"]}"#,
        )],
    );
    let (code, _, stderr) = run(&[
        "sidecar",
        "release",
        text(&unlisted.0),
        text(&out.0),
        "--platform",
        "darwin-arm64",
    ]);
    assert_eq!(
        (code, stderr.as_str()),
        (1, "sok: package.json files: build/worker is not listed\n")
    );
    write_tree(&out.0, &[("SHA256SUMS", "broken\n")]);
    let tree = sidecar_tree("0.2.0");
    let (code, _, stderr) = run(&[
        "sidecar",
        "release",
        text(&tree.0),
        text(&out.0),
        "--platform",
        "darwin-arm64",
    ]);
    let want = format!(
        "sok: {} line 1 is not \"<sha256>  <archive name>\"\n",
        text(&out.0.join("SHA256SUMS"))
    );
    assert_eq!((code, stderr), (1, want));
    assert!(
        !out.0
            .join("scope-sidecar-worker-0.2.0-darwin-arm64.tar.gz")
            .exists(),
        "a failed release left its archive"
    );
}

// contract: cli.pack.diagnostics-only-with-flag
#[test]
fn plugin_pack_adds_diagnostic_declarations_only_with_the_flag() {
    let dir = plugin_tree();
    write_tree(
        &dir.0,
        &[
            (
                "diagnostics.json",
                r#"{"module": "probe-diagnostics.js", "exposes": {}}"#,
            ),
            ("probe-diagnostics.js", "export const probe = true;"),
        ],
    );
    for (flags, want) in [
        (vec![], "package.json, plugin.json, ui/a/run.sh, ui/b.js"),
        (
            vec!["--diagnostics"],
            "diagnostics.json, package.json, plugin.json, probe-diagnostics.js, ui/a/run.sh, ui/b.js",
        ),
    ] {
        let out = Dir::new();
        let mut args = vec!["plugin", "pack", text(&dir.0), text(&out.0)];
        args.extend(flags.iter().copied());
        let (code, _, stderr) = run(&args);
        assert_eq!(code, 0, "{flags:?}: {stderr}");
        let (entries, _) = read_archive(&out.0.join("probe-0.2.0.tgz"));
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names.join(", "), want, "{flags:?}");
    }
    write_tree(
        &dir.0,
        &[(
            "package.json",
            r#"{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"},
            "soksak": {"sidecars": {"@scope/sidecar-worker": "^0.1.0"}}, "files": ["plugin.json", "ui", "probe-diagnostics.js"]}"#,
        )],
    );
    let out = Dir::new();
    let (code, _, stderr) = run(&["plugin", "pack", text(&dir.0), text(&out.0)]);
    assert_eq!(
        (code, stderr.as_str()),
        (
            1,
            "sok: package.json files: probe-diagnostics.js is diagnostic and must not be listed\n"
        )
    );
    let tree = sidecar_tree("0.1.0");
    let (code, _, stderr) = run(&[
        "sidecar",
        "release",
        text(&tree.0),
        text(&out.0),
        "--diagnostics",
    ]);
    assert_eq!(code, 2);
    assert!(
        stderr.starts_with("sok: --diagnostics belongs to plugin pack\n"),
        "{stderr}"
    );
}

// contract: cli.pack.rejects-unlisted-modules
#[test]
fn plugin_pack_rejects_a_module_that_files_does_not_list() {
    for (manifest, want) in [
        (
            r#"{"id": "probe", "sidecars": ["@scope/sidecar-worker"], "surface": {"module": "page/probe.js"}}"#,
            "plugin.json: surface module page/probe.js must be listed in files",
        ),
        (
            r#"{"id": "probe", "sidecars": ["@scope/sidecar-worker"], "sections": [{"id": "probe.list", "module": {"horizontal": "ui/b.js", "vertical": "side/v.js"}}]}"#,
            "plugin.json: section probe.list module side/v.js must be listed in files",
        ),
        (
            r#"{"id": "probe", "sidecars": ["@scope/sidecar-worker"], "state": {"module": "state.js"}}"#,
            "plugin.json: state module state.js must be listed in files",
        ),
    ] {
        let dir = plugin_tree();
        write_tree(&dir.0, &[("plugin.json", manifest)]);
        let out = Dir::new();
        let (code, _, stderr) = run(&["plugin", "pack", text(&dir.0), text(&out.0)]);
        assert_eq!((code, stderr), (1, format!("sok: {want}\n")));
    }
    let dir = plugin_tree();
    write_tree(
        &dir.0,
        &[(
            "plugin.json",
            r#"{"id": "probe", "sidecars": ["@scope/sidecar-worker"], "surface": {"module": "ui/b.js"}, "sections": [{"id": "probe.list", "module": "ui/a/run.sh"}]}"#,
        )],
    );
    let out = Dir::new();
    let (code, _, stderr) = run(&["plugin", "pack", text(&dir.0), text(&out.0)]);
    assert_eq!(code, 0, "{stderr}");
}
