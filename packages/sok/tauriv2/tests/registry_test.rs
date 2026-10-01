//! registry build(docs/spec/cli.md)가 registry 폴더를 검사하고 index.json 을 쓰는지 검사한다.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::Value;

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// 테스트마다 고유한 임시 폴더. 끝나면 지운다.
struct Dir(PathBuf);

impl Dir {
    fn new() -> Dir {
        let path = std::env::temp_dir().join(format!(
            "sok-registry{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).expect("create temporary directory");
        Dir(path)
    }

    fn text(&self) -> &str {
        self.0.to_str().expect("UTF-8 path")
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

/// registry 폴더와 archive 의 주소와 hash.
struct Registry {
    dir: Dir,
    _releases: Dir,
    plugin: (String, String),
    sidecar: (String, String),
}

/// pack 과 release 로 archive 를 만들고 그 주소와 hash 를 담은 registry 폴더를 쓴다.
fn registry_tree() -> Registry {
    let platform = soksak_sok::current_platform().expect("platform");
    let releases = Dir::new();
    let plugin = Dir::new();
    write_tree(
        &plugin.0,
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
        ],
    );
    let sidecar = Dir::new();
    write_tree(
        &sidecar.0,
        &[
            (
                "package.json",
                r#"{"name": "@scope/sidecar-worker", "version": "0.1.0", "files": ["sidecar.json", "build/worker"]}"#,
            ),
            (
                "sidecar.json",
                r#"{"executable": "build/worker", "protocol": 1}"#,
            ),
            ("build/worker*", "binary 0.1.0"),
        ],
    );
    let mut results = vec![];
    for args in [
        vec!["plugin", "pack", plugin.text(), releases.text()],
        vec![
            "sidecar",
            "release",
            sidecar.text(),
            releases.text(),
            "--platform",
            &platform,
        ],
    ] {
        let (code, stdout, stderr) = run(&args);
        assert_eq!(code, 0, "{stderr}");
        let result: Value = serde_json::from_str(&stdout).unwrap();
        results.push((
            result["archive"].as_str().unwrap().to_string(),
            result["sha256"].as_str().unwrap().to_string(),
        ));
    }
    let dir = Dir::new();
    let (plugin, sidecar) = (results[0].clone(), results[1].clone());
    let plugin_entry = format!(
        r#"{{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
        "license": "MIT", "repository": "https://example.invalid/probe", "versions": [{{"version": "0.2.0",
        "package": {{"url": "file://{}", "sha256": "{}"}},
        "engines": {{"soksak": "^0.0.2"}}, "sidecars": {{"@scope/sidecar-worker": "^0.1.0"}}}}]}}"#,
        plugin.0, plugin.1
    );
    let sidecar_entry = format!(
        r#"{{"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker",
        "versions": [{{"version": "0.1.0", "protocol": 1, "assets": {{"{platform}":
        {{"url": "file://{}", "sha256": "{}"}}}}}}]}}"#,
        sidecar.0, sidecar.1
    );
    write_tree(
        &dir.0,
        &[
            ("plugins/probe.json", &plugin_entry),
            ("sidecars/scope-sidecar-worker.json", &sidecar_entry),
            (
                "packs/starter.json",
                r#"{"name": "starter", "description": "처음 설치하는 plugin.", "plugins": ["probe"]}"#,
            ),
            ("revoked.json", r#"{"plugins": [], "sidecars": []}"#),
        ],
    );
    Registry {
        dir,
        _releases: releases,
        plugin,
        sidecar,
    }
}

// contract: cli.registry.writes-checked-index
#[test]
fn registry_build_writes_the_index_after_checking_every_archive() {
    let registry = registry_tree();
    let platform = soksak_sok::current_platform().expect("platform");
    let (code, stdout, stderr) = run(&["registry", "build", registry.dir.text()]);
    assert_eq!(code, 0, "{stderr}");
    let index = registry.dir.0.join("index.json");
    let index_text = index.to_str().unwrap();
    assert_eq!(
        stdout,
        format!("{{\n  \"index\": \"{index_text}\",\n  \"packs\": 1,\n  \"plugins\": 1,\n  \"sidecars\": 1\n}}\n")
    );
    let want = format!(
        r#"{{
  "format": 1,
  "plugins": [
    {{
      "id": "probe",
      "package": "@scope/plugin-probe",
      "name": "Probe",
      "description": "검사용 plugin.",
      "license": "MIT",
      "repository": "https://example.invalid/probe",
      "versions": [
        {{
          "version": "0.2.0",
          "package": {{
            "url": "file://{}",
            "sha256": "{}"
          }},
          "engines": {{
            "soksak": "^0.0.2"
          }},
          "sidecars": {{
            "@scope/sidecar-worker": "^0.1.0"
          }}
        }}
      ]
    }}
  ],
  "sidecars": [
    {{
      "name": "@scope/sidecar-worker",
      "repository": "https://example.invalid/worker",
      "versions": [
        {{
          "version": "0.1.0",
          "protocol": 1,
          "assets": {{
            "{platform}": {{
              "url": "file://{}",
              "sha256": "{}"
            }}
          }}
        }}
      ]
    }}
  ],
  "packs": [
    {{
      "name": "starter",
      "description": "처음 설치하는 plugin.",
      "plugins": [
        "probe"
      ]
    }}
  ],
  "revoked": {{
    "plugins": [],
    "sidecars": []
  }}
}}
"#,
        registry.plugin.0,
        registry.plugin.1,
        registry.sidecar.0,
        registry.sidecar.1,
        platform = platform
    );
    assert_eq!(std::fs::read_to_string(&index).unwrap(), want);
}

fn replace_in(path: &Path, old: &str, replacement: &str) {
    let text = std::fs::read_to_string(path).unwrap();
    assert!(text.contains(old), "{} has no {old:?}", path.display());
    std::fs::write(path, text.replacen(old, replacement, 1)).unwrap();
}

// contract: cli.registry.rejects-without-writing
#[test]
fn registry_build_rejects_a_mismatch_without_writing_the_index() {
    type Change = fn(&Registry);
    let cases: [(Change, &str); 6] = [
        (
            |r| replace_in(&r.dir.0.join("plugins/probe.json"), r#""sha256": ""#, r#""sha256": "0"#),
            "sha256 must be 64 lowercase hexadecimal digits",
        ),
        (|r| replace_in(&r.dir.0.join("plugins/probe.json"), &r.plugin.1, &"0".repeat(64)), "plugin probe 0.2.0 package: "),
        (
            |r| {
                replace_in(
                    &r.dir.0.join("plugins/probe.json"),
                    r#""engines": {"soksak": "^0.0.2"}"#,
                    r#""engines": {"soksak": "^0.0.3"}"#,
                )
            },
            "plugin probe 0.2.0 package: package.json engines.soksak is ^0.0.2, the entry says ^0.0.3",
        ),
        (
            |r| std::fs::rename(r.dir.0.join("packs/starter.json"), r.dir.0.join("packs/first.json")).unwrap(),
            "packs/first.json holds starter; its file name must be starter.json",
        ),
        (|r| std::fs::remove_file(r.dir.0.join("revoked.json")).unwrap(), "revoked.json: "),
        (
            |r| replace_in(&r.dir.0.join("packs/starter.json"), r#"["probe"]"#, r#"["probe", "missing"]"#),
            "registry index: pack starter names unknown plugin missing",
        ),
    ];
    for (change, want) in cases {
        let registry = registry_tree();
        change(&registry);
        let (code, _, stderr) = run(&["registry", "build", registry.dir.text()]);
        assert!(
            code == 1 && stderr.contains(want),
            "code {code} stderr {stderr:?}, want {want:?}"
        );
        assert!(
            !registry.dir.0.join("index.json").exists(),
            "a failed build wrote index.json"
        );
    }
}
