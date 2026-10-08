//! plugin 설치(docs/spec/cli.md)가 release 를 확인해 풀고 installed.json 을 한 번에 바꾸는지 검사한다.

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// 테스트마다 고유한 임시 폴더. 끝나면 지운다.
struct Dir(PathBuf);

impl Dir {
    fn new() -> Dir {
        let path = std::env::temp_dir().join(format!(
            "sok-plugins{}-{}",
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

fn run_json(args: &[&str]) -> Value {
    let (code, stdout, stderr) = run(args);
    assert_eq!(code, 0, "{args:?}: {stderr}");
    serde_json::from_str(&stdout).expect("JSON result")
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

fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// plugin probe 의 version 마다 pack 한 release 와 sidecar 0.1.0 의 release 로 registry 를 만들고 build 한다.
struct Registry {
    dir: Dir,
    _work: Vec<Dir>,
}

impl Registry {
    fn index(&self) -> String {
        self.dir.0.join("index.json").to_str().unwrap().to_string()
    }
}

fn plugin_versions(versions: &[&str]) -> Registry {
    plugin_versions_for("0.0.2", versions)
}

/// plugin 이 core version core 를 요구하는 registry.
fn plugin_versions_for(core: &str, versions: &[&str]) -> Registry {
    let platform = soksak_sok::current_platform().expect("platform");
    let releases = Dir::new();
    let mut work = vec![];
    let mut entries = vec![];
    for version in versions {
        let dir = Dir::new();
        let package = format!(
            r#"{{"name": "@scope/plugin-probe", "version": "{version}", "engines": {{"soksak": "^{core}"}},
            "files": ["plugin.json", "ui"]}}"#
        );
        let content = format!("b {version}");
        write_tree(
            &dir.0,
            &[
                ("package.json", &package),
                (
                    "plugin.json",
                    r#"{"id": "probe", "dependencies": {"@scope/sidecar-worker": "^0.1.0"}}"#,
                ),
                ("ui/b.js", &content),
            ],
        );
        let result = run_json(&["plugin", "pack", dir.text(), releases.text()]);
        entries.push(format!(
            r#"{{"version": "{version}", "package": {{"url": "file://{}", "sha256": "{}"}},
            "engines": {{"soksak": "^{core}"}}, "sidecars": {{"@scope/sidecar-worker": "^0.1.0"}}}}"#,
            result["release"].as_str().unwrap(),
            result["sha256"].as_str().unwrap()
        ));
        work.push(dir);
    }
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
    let released = run_json(&[
        "sidecar",
        "release",
        sidecar.text(),
        releases.text(),
        "--platform",
        &platform,
    ]);
    let dir = Dir::new();
    let plugin_entry = format!(
        r#"{{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
        "license": "MIT", "repository": "https://example.invalid/probe", "versions": [{}]}}"#,
        entries.join(",")
    );
    let sidecar_entry = format!(
        r#"{{"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker",
        "versions": [{{"version": "0.1.0", "protocol": 1, "assets": {{"{platform}":
        {{"url": "file://{}", "sha256": "{}"}}}}}}]}}"#,
        released["release"].as_str().unwrap(),
        released["sha256"].as_str().unwrap()
    );
    write_tree(
        &dir.0,
        &[
            ("plugins/probe.json", &plugin_entry),
            ("sidecars/scope-sidecar-worker.json", &sidecar_entry),
            ("revoked.json", r#"{"plugins": [], "sidecars": []}"#),
        ],
    );
    run_json(&["registry", "build", dir.text()]);
    work.push(releases);
    work.push(sidecar);
    Registry { dir, _work: work }
}

// contract: cli.plugin.install-extracts-and-records
#[test]
fn plugin_install_extracts_checked_releases_and_records_the_state() {
    let platform = soksak_sok::current_platform().expect("platform");
    let registry = plugin_versions(&["0.2.0"]);
    let index = registry.index();
    let config = Dir::new();
    let used = run_json(&["registry", "use", &index, "--config-dir", config.text()]);
    assert_eq!(used["index"], format!("file://{index}").as_str());
    assert_eq!(
        read_text(&config.0.join("plugins/registry.json")),
        format!("{{\"format\":1,\"index\":\"file://{index}\"}}\n")
    );
    let (code, stdout, stderr) =
        run(&["plugin", "install", "probe", "--config-dir", config.text()]);
    let want = r#"{
  "plugin": {
    "package": "@scope/plugin-probe",
    "version": "0.2.0",
    "path": "plugins/probe/0.2.0",
    "enabled": true,
    "sidecars": {
      "@scope/sidecar-worker": "^0.1.0"
    }
  },
  "sidecars": {
    "@scope/sidecar-worker": "0.1.0"
  }
}
"#;
    assert_eq!((code, stdout.as_str()), (0, want), "{stderr}");
    assert_eq!(
        read_text(&config.0.join("plugins/probe/0.2.0/ui/b.js")),
        "b 0.2.0"
    );
    let worker = config
        .0
        .join("sidecars/scope-sidecar-worker/0.1.0")
        .join(&platform)
        .join("build/worker");
    assert_eq!(
        std::fs::metadata(&worker).unwrap().permissions().mode() & 0o777,
        0o755
    );
    let installed = read_text(&config.0.join("plugins/installed.json"));
    let sidecar_path = format!(r#""path": "sidecars/scope-sidecar-worker/0.1.0/{platform}""#);
    assert!(installed.contains(&sidecar_path), "{installed}");
    assert!(installed.contains(r#""version": "0.2.0""#), "{installed}");
    // 같은 version 을 다시 설치하면 아무것도 바꾸지 않는다.
    let (code, again, _) = run(&["plugin", "install", "probe", "--config-dir", config.text()]);
    assert_eq!((code, again), (0, stdout));
    assert_eq!(
        read_text(&config.0.join("plugins/installed.json")),
        installed
    );
}

/// package.json 과 plugin.json 옆에 폴더 밖 경로를 담은 release 를 쓰고 그 sha256 을 돌려준다.
fn unsafe_release(path: &Path) -> String {
    let mut data = vec![];
    {
        let zipped = flate2::write::GzEncoder::new(&mut data, flate2::Compression::default());
        let mut release = tar::Builder::new(zipped);
        for (name, content) in [
            (
                "package.json",
                r#"{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"}, "files": ["plugin.json"]}"#,
            ),
            ("plugin.json", r#"{"id": "probe"}"#),
            ("../escape.txt", "outside"),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            // tar crate 는 .. 를 담은 이름을 set_path 에서 거부하므로 이름 칸에 직접 쓴다.
            header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
            header.set_cksum();
            release.append(&header, content.as_bytes()).unwrap();
        }
        release.into_inner().unwrap().finish().unwrap();
    }
    std::fs::write(path, &data).unwrap();
    Sha256::digest(&data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn replace_in(path: &Path, old: &str, replacement: &str) {
    let text = read_text(path);
    assert!(text.contains(old), "{} has no {old:?}", path.display());
    std::fs::write(path, text.replacen(old, replacement, 1)).unwrap();
}

// contract: cli.plugin.install-failure-keeps-state
#[test]
fn plugin_install_failure_keeps_the_previous_state() {
    let config = Dir::new();
    let (code, _, stderr) = run(&["plugin", "install", "probe", "--config-dir", config.text()]);
    let want = format!(
        "sok: {} does not exist; run sok registry use <index.json>\n",
        config.0.join("plugins/registry.json").display()
    );
    assert_eq!((code, stderr), (1, want));
    // index 를 쓴 뒤 release 가 바뀌면 hash 비교가 설치를 멈춘다.
    let registry = plugin_versions(&["0.2.0"]);
    run_json(&[
        "registry",
        "use",
        &registry.index(),
        "--config-dir",
        config.text(),
    ]);
    let index: Value = serde_json::from_str(&read_text(Path::new(&registry.index()))).unwrap();
    let url = index["plugins"][0]["versions"][0]["package"]["url"]
        .as_str()
        .unwrap();
    let release = PathBuf::from(url.strip_prefix("file://").unwrap());
    std::fs::write(&release, "changed").unwrap();
    let (code, _, stderr) = run(&["plugin", "install", "probe", "--config-dir", config.text()]);
    assert_eq!(code, 1);
    assert!(
        stderr.starts_with(&format!(
            "sok: plugin probe 0.2.0 package: {} has sha256 ",
            release.display()
        )),
        "{stderr}"
    );
    assert!(
        !config.0.join("plugins/installed.json").exists()
            && !config.0.join("plugins/probe/0.2.0").exists()
    );
    // 폴더 밖 경로를 담은 release 는 풀지 않는다.
    let sum = unsafe_release(&release);
    let entry = registry.dir.0.join("plugins/probe.json");
    replace_in(
        &entry,
        r#""sidecars": {"@scope/sidecar-worker": "^0.1.0"}}]"#,
        r#""sidecars": {}}]"#,
    );
    let text = read_text(&entry);
    let old = text
        .split(r#""sha256": ""#)
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .to_string();
    replace_in(&entry, &old, &sum);
    run_json(&["registry", "build", registry.dir.text()]);
    let (code, _, stderr) = run(&["plugin", "install", "probe", "--config-dir", config.text()]);
    assert_eq!(
        (code, stderr.as_str()),
        (
            1,
            "sok: plugin probe 0.2.0 package: release entry ../escape.txt leaves the folder\n"
        )
    );
    assert!(!config.0.join("plugins/installed.json").exists());
    assert!(!config.0.join("plugins/probe/0.2.0").exists());
    assert!(!config.0.join("plugins/probe/escape.txt").exists());
}

// contract: cli.plugin.update-remove-enable-list
#[test]
fn plugin_update_keeps_previous_and_remove_deletes_the_folders() {
    let config = Dir::new();
    let first = plugin_versions(&["0.2.0"]);
    run_json(&[
        "registry",
        "use",
        &first.index(),
        "--config-dir",
        config.text(),
    ]);
    let (code, _, stderr) = run(&["plugin", "update", "probe", "--config-dir", config.text()]);
    assert_eq!(
        (code, stderr.as_str()),
        (1, "sok: plugin probe is not installed\n")
    );
    run_json(&["plugin", "install", "probe", "--config-dir", config.text()]);
    let disabled = run_json(&["plugin", "disable", "probe", "--config-dir", config.text()]);
    assert_eq!(disabled["enabled"], false);
    let mut registries = vec![first];
    for (version, previous) in [("0.3.0", "0.2.0"), ("0.4.0", "0.3.0")] {
        let registry = plugin_versions(&["0.2.0", version]);
        run_json(&[
            "registry",
            "use",
            &registry.index(),
            "--config-dir",
            config.text(),
        ]);
        let updated = run_json(&["plugin", "update", "probe", "--config-dir", config.text()]);
        assert_eq!(updated["plugin"]["version"], version);
        assert_eq!(updated["plugin"]["previous"], previous);
        assert_eq!(updated["plugin"]["enabled"], false);
        registries.push(registry);
    }
    let mut names: Vec<String> = std::fs::read_dir(config.0.join("plugins/probe"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["0.3.0", "0.4.0"]);
    let (code, stdout, _) = run(&["plugin", "list", "--config-dir", config.text()]);
    assert!(
        code == 0 && stdout.contains(r#""probe": {"#) && stdout.contains(r#""format": 2"#),
        "{stdout}"
    );
    let enabled = run_json(&["plugin", "enable", "probe", "--config-dir", config.text()]);
    assert_eq!(enabled["enabled"], true);
    let (code, stdout, _) = run(&["plugin", "remove", "probe", "--config-dir", config.text()]);
    assert_eq!((code, stdout.as_str()), (0, "null\n"));
    assert!(
        !config.0.join("plugins/probe").exists()
            && !config.0.join("sidecars/scope-sidecar-worker").exists()
    );
    assert_eq!(
        read_text(&config.0.join("plugins/installed.json")),
        "{\n  \"format\": 2,\n  \"plugins\": {},\n  \"sidecars\": {}\n}\n"
    );
    let (code, _, stderr) = run(&["plugin", "remove", "probe", "--config-dir", config.text()]);
    assert_eq!(
        (code, stderr.as_str()),
        (1, "sok: plugin probe is not installed\n")
    );
}

/// read_plugins_state 의 결과를 JSON 문장으로 만든다.
fn state_json(config: &Dir) -> String {
    let state = soksak_sok::plugins::read_plugins_state(&config.0).expect("plugins state");
    serde_json::to_string(&state).expect("state JSON")
}

// contract: cli.plugin.state-reads-registry-and-installed
#[test]
fn plugins_state_reports_the_registry_and_the_installation() {
    let config = Dir::new();
    assert_eq!(
        state_json(&config),
        r#"{"registry":null,"index":null,"installed":{"format":2,"plugins":{},"sidecars":{}},"firstRun":true}"#
    );
    let registry = plugin_versions(&["0.2.0"]);
    run_json(&[
        "registry",
        "use",
        &registry.index(),
        "--config-dir",
        config.text(),
    ]);
    let platform = soksak_sok::current_platform().expect("platform");
    soksak_sok::plugins::run_plugin_action(&config.0, "install", "probe", "0.0.2", &platform)
        .expect("install");
    let state: Value = serde_json::from_str(&state_json(&config)).unwrap();
    assert_eq!(state["registry"], format!("file://{}", registry.index()));
    assert_eq!(state["index"]["plugins"][0]["id"], "probe");
    assert_eq!(state["installed"]["plugins"]["probe"]["version"], "0.2.0");
    assert_eq!(state["installed"]["plugins"]["probe"]["enabled"], true);
    assert_eq!(state["firstRun"], false);
    // 읽지 못한 index 는 오류를 index 자리에 담고, 설치 상태는 그대로 보고한다.
    std::fs::remove_file(registry.index()).unwrap();
    let state: Value = serde_json::from_str(&state_json(&config)).unwrap();
    let error = state["index"]["error"].as_str().expect("index error");
    assert!(error.contains(&registry.index()), "{error}");
    assert_eq!(state["installed"]["plugins"]["probe"]["version"], "0.2.0");
    std::fs::write(config.0.join("plugins/installed.json"), "{").unwrap();
    let error = soksak_sok::plugins::read_plugins_state(&config.0)
        .err()
        .expect("invalid installed.json fails");
    assert!(
        error.contains("installed.json is not valid JSON"),
        "{error}"
    );
}

// contract: cli.plugin.action-runs-the-command
#[test]
fn run_plugin_action_matches_the_plugin_commands() {
    let config = Dir::new();
    let registry = plugin_versions(&["0.2.0"]);
    run_json(&[
        "registry",
        "use",
        &registry.index(),
        "--config-dir",
        config.text(),
    ]);
    let platform = soksak_sok::current_platform().expect("platform");
    soksak_sok::plugins::run_plugin_action(&config.0, "install", "probe", "0.0.2", &platform)
        .expect("install");
    let disabled =
        soksak_sok::plugins::run_plugin_action(&config.0, "disable", "probe", "0.0.2", "")
            .expect("disable");
    assert_eq!(serde_json::to_value(&disabled).unwrap()["enabled"], false);
    let (_, stdout, _) = run(&["plugin", "list", "--config-dir", config.text()]);
    assert!(stdout.contains(r#""enabled": false"#), "{stdout}");
    let error = soksak_sok::plugins::run_plugin_action(&config.0, "rename", "probe", "0.0.2", "")
        .err()
        .expect("unknown action fails");
    assert_eq!(error, r#"unknown plugin action "rename""#);
    let removed = soksak_sok::plugins::run_plugin_action(&config.0, "remove", "probe", "0.0.2", "")
        .expect("remove");
    assert_eq!(serde_json::to_string(&removed).unwrap(), "null");
    assert!(!config.0.join("plugins/probe").exists());
}

// contract: cli.file.errors-name-the-path-and-the-reason
#[test]
fn file_errors_name_the_path_and_the_reason() {
    let config = Dir::new();
    let missing = config.0.join("missing.json");
    let error = soksak_sok::plugins::use_registry(
        &config.0,
        missing.to_str().unwrap(),
        &soksak_sok::fetch::Fetcher::default(),
    )
    .unwrap_err();
    assert_eq!(
        error,
        format!("{}: no such file or directory", missing.display())
    );
    let installed = config.0.join("plugins/installed.json");
    std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
    std::fs::write(&installed, "{}").unwrap();
    std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o0)).unwrap();
    let error = soksak_sok::plugins::read_plugins_state(&config.0)
        .err()
        .expect("an unreadable installed state is an error");
    std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(error, format!("{}: permission denied", installed.display()));
}

// contract: install.installed.rejects-another-format
#[test]
fn an_installed_file_of_another_format_is_rejected() {
    let config = Dir::new();
    let file = config.0.join("plugins/installed.json");
    std::fs::create_dir_all(file.parent().expect("plugins")).expect("plugins folder");
    let former = r#"{"format": 1, "plugins": {}, "sidecars": {}}"#;
    std::fs::write(&file, former).expect("format 1");
    let (code, _, stderr) = run(&["plugin", "list", "--config-dir", config.text()]);
    assert_eq!(
        (code, stderr),
        (
            1,
            format!(
                "sok: {}: plugins/installed.json: format must be 2\n",
                file.display()
            )
        )
    );
    assert_eq!(read_text(&file), former);
}

// contract: cli.plugin.install-modes-ignore-the-umask
#[test]
fn plugin_install_sets_the_modes_whatever_the_umask() {
    use std::os::unix::fs::PermissionsExt;
    let platform = soksak_sok::current_platform().expect("platform");
    // 실행 파일 sok 은 이 crate 의 core version 으로 plugin 을 고른다.
    let registry = plugin_versions_for(soksak_sok::version::CORE_VERSION, &["0.2.0"]);
    let config = Dir::new();
    run_json(&[
        "registry",
        "use",
        &registry.index(),
        "--config-dir",
        config.text(),
    ]);
    // 프로세스의 umask 는 실행 파일 단위이므로 umask 077 의 shell 에서 sok 을 실행한다.
    let output = std::process::Command::new("sh")
        .args([
            "-c",
            r#"umask 077 && exec "$0" "$@""#,
            env!("CARGO_BIN_EXE_sok"),
        ])
        .args(["plugin", "install", "probe", "--config-dir", config.text()])
        .output()
        .expect("sok");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    for (path, want) in [
        (
            config
                .0
                .join("sidecars/scope-sidecar-worker/0.1.0")
                .join(&platform)
                .join("build/worker"),
            0o755,
        ),
        (config.0.join("plugins/probe/0.2.0/ui/b.js"), 0o644),
    ] {
        let mode = std::fs::metadata(&path)
            .expect("installed file")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, want, "{}", path.display());
    }
}

/// A test plugin version with plugin.json dependencies. Its package is @scope/plugin-<id>.
struct Dependent {
    id: &'static str,
    version: &'static str,
    dependencies: Vec<(&'static str, &'static str)>,
}

fn base(version: &'static str) -> Dependent {
    Dependent {
        id: "base",
        version,
        dependencies: vec![("@scope/sidecar-worker", "^0.1.0")],
    }
}

fn ext(range: &'static str) -> Dependent {
    Dependent {
        id: "ext",
        version: "1.0.0",
        dependencies: vec![("@scope/plugin-base", range)],
    }
}

/// Writes the entry files of a registry folder with a packed release of each version and the release of sidecar
/// worker 0.1.0, and writes index.json from the same entries. The sidecars of the index hold only the dependencies
/// that start with @scope/sidecar-.
fn dependency_registry(versions: &[Dependent]) -> Registry {
    let platform = soksak_sok::current_platform().expect("platform");
    let releases = Dir::new();
    let mut work = vec![];
    let mut plugins: BTreeMap<&str, Value> = BTreeMap::new();
    for item in versions {
        let dir = Dir::new();
        let dependencies: serde_json::Map<String, Value> = item
            .dependencies
            .iter()
            .map(|(name, range)| (name.to_string(), Value::from(*range)))
            .collect();
        let package = json!({"name": format!("@scope/plugin-{}", item.id), "version": item.version,
            "engines": {"soksak": "^0.0.2"}, "files": ["plugin.json"]})
        .to_string();
        let manifest = json!({"id": item.id, "dependencies": dependencies}).to_string();
        write_tree(
            &dir.0,
            &[("package.json", &package), ("plugin.json", &manifest)],
        );
        let result = run_json(&["plugin", "pack", dir.text(), releases.text()]);
        let sidecars: serde_json::Map<String, Value> = dependencies
            .into_iter()
            .filter(|(name, _)| name.starts_with("@scope/sidecar-"))
            .collect();
        let entry = plugins.entry(item.id).or_insert_with(|| {
            json!({"id": item.id, "package": format!("@scope/plugin-{}", item.id), "name": item.id,
                "description": "검사용 plugin.", "license": "MIT",
                "repository": format!("https://example.invalid/{}", item.id), "versions": []})
        });
        entry["versions"].as_array_mut().unwrap().push(json!({"version": item.version,
            "package": {"url": format!("file://{}", result["release"].as_str().unwrap()), "sha256": result["sha256"]},
            "engines": {"soksak": "^0.0.2"}, "sidecars": sidecars}));
        work.push(dir);
    }
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
    let released = run_json(&[
        "sidecar",
        "release",
        sidecar.text(),
        releases.text(),
        "--platform",
        &platform,
    ]);
    let worker = json!({"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker",
        "versions": [{"version": "0.1.0", "protocol": 1, "assets": {platform.as_str():
        {"url": format!("file://{}", released["release"].as_str().unwrap()), "sha256": released["sha256"]}}}]});
    let revoked = json!({"plugins": [], "sidecars": []});
    let mut files = vec![
        (
            "sidecars/scope-sidecar-worker.json".to_string(),
            worker.to_string(),
        ),
        ("revoked.json".to_string(), revoked.to_string()),
    ];
    for (id, entry) in &plugins {
        files.push((format!("plugins/{id}.json"), entry.to_string()));
    }
    let index = json!({"format": 1, "plugins": plugins.values().collect::<Vec<_>>(), "sidecars": [worker],
        "packs": [], "revoked": revoked});
    files.push(("index.json".to_string(), index.to_string()));
    let files: Vec<(&str, &str)> = files
        .iter()
        .map(|(name, content)| (name.as_str(), content.as_str()))
        .collect();
    let dir = Dir::new();
    write_tree(&dir.0, &files);
    work.push(releases);
    work.push(sidecar);
    Registry { dir, _work: work }
}

/// Makes the configuration directory use the index.json of the registry folder.
fn use_registry(config: &Dir, registry: &Registry) {
    run_json(&[
        "registry",
        "use",
        &registry.index(),
        "--config-dir",
        config.text(),
    ]);
}

fn installed_of(config: &Dir) -> soksak_sok::install::InstalledState {
    soksak_sok::plugins::read_installed(&config.0).expect("installed state")
}

/// Runs a sok command and stops the test when it fails.
fn succeeds(args: &[&str]) -> String {
    let (code, stdout, stderr) = run(args);
    assert_eq!(code, 0, "{args:?}: {stderr}");
    stdout
}

// contract: cli.plugin.dependencies-install
#[test]
fn plugin_install_installs_the_plugin_dependencies() {
    let full = dependency_registry(&[base("1.0.0"), base("1.1.0"), base("2.0.0"), ext("^1.0.0")]);
    // A provider that is not installed gets the newest version that satisfies the range.
    let config = Dir::new();
    use_registry(&config, &full);
    let stdout = succeeds(&["plugin", "install", "ext", "--config-dir", config.text()]);
    let want = r#"{
  "plugin": {
    "package": "@scope/plugin-ext",
    "version": "1.0.0",
    "path": "plugins/ext/1.0.0",
    "enabled": true,
    "sidecars": {}
  },
  "sidecars": {}
}
"#;
    assert_eq!(stdout, want);
    let state = installed_of(&config);
    let provider = &state.plugins["base"];
    assert_eq!(
        (
            provider.version.as_str(),
            provider.enabled,
            provider.previous.as_deref()
        ),
        ("1.1.0", true, None)
    );
    assert_eq!(
        serde_json::to_string(&provider.sidecars).unwrap(),
        r#"{"@scope/sidecar-worker":"^0.1.0"}"#
    );
    assert_eq!(state.sidecars["@scope/sidecar-worker"].version, "0.1.0");
    assert!(
        config.0.join("plugins/base/1.1.0/plugin.json").exists()
            && config.0.join("plugins/ext/1.0.0/plugin.json").exists(),
        "install ext did not extract both plugins"
    );
    // An installed provider that satisfies the range is kept and enabled.
    let config = Dir::new();
    let small = dependency_registry(&[base("1.0.0")]);
    use_registry(&config, &small);
    succeeds(&["plugin", "install", "base", "--config-dir", config.text()]);
    succeeds(&["plugin", "disable", "base", "--config-dir", config.text()]);
    use_registry(&config, &full);
    succeeds(&["plugin", "install", "ext", "--config-dir", config.text()]);
    let provider = &installed_of(&config).plugins["base"];
    assert_eq!(
        (
            provider.version.as_str(),
            provider.enabled,
            provider.previous.as_deref()
        ),
        ("1.0.0", true, None)
    );
    // An installed provider that does not satisfy the range gets the newest version that satisfies it.
    let config = Dir::new();
    use_registry(&config, &full);
    succeeds(&["plugin", "install", "base", "--config-dir", config.text()]);
    succeeds(&["plugin", "install", "ext", "--config-dir", config.text()]);
    let provider = &installed_of(&config).plugins["base"];
    assert_eq!(
        (provider.version.as_str(), provider.previous.as_deref()),
        ("1.1.0", Some("2.0.0"))
    );
}

/// The names in the plugins folder of the configuration directory.
fn plugin_folders(config: &Dir) -> String {
    let mut names: Vec<String> = std::fs::read_dir(config.0.join("plugins"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names.join(" ")
}

// contract: cli.plugin.dependencies-reject
#[test]
fn plugin_install_rejects_unresolvable_plugin_dependencies() {
    let cases = [
        (
            "ext",
            vec![Dependent {
                id: "ext",
                version: "1.0.0",
                dependencies: vec![("@scope/plugin-gone", "^1.0.0")],
            }],
            "sok: ext 1.0.0: dependency @scope/plugin-gone is neither a plugin nor a sidecar of the registry\n",
        ),
        (
            "ext",
            vec![base("1.0.0"), ext("^2.0.0")],
            "sok: plugin base has no version for core 0.0.2 that satisfies every installed plugin: ext 1.0.0 needs ^2.0.0\n",
        ),
        (
            "first",
            vec![
                Dependent {
                    id: "first",
                    version: "1.0.0",
                    dependencies: vec![("@scope/plugin-second", "^1.0.0")],
                },
                Dependent {
                    id: "second",
                    version: "1.0.0",
                    dependencies: vec![("@scope/plugin-first", "^1.0.0")],
                },
            ],
            "sok: plugin dependency cycle: first -> second -> first\n",
        ),
    ];
    for (plugin, versions, want) in cases {
        let config = Dir::new();
        let registry = dependency_registry(&versions);
        use_registry(&config, &registry);
        let (code, _, stderr) = run(&["plugin", "install", plugin, "--config-dir", config.text()]);
        assert_eq!((code, stderr.as_str()), (1, want), "install {plugin}");
        assert_eq!(
            plugin_folders(&config),
            "registry.json",
            "install {plugin} changed the installation"
        );
    }
    // A provider that the index does not list is not a plugin dependency, even when it is installed.
    let config = Dir::new();
    let small = dependency_registry(&[base("1.0.0")]);
    use_registry(&config, &small);
    succeeds(&["plugin", "install", "base", "--config-dir", config.text()]);
    let before = read_text(&config.0.join("plugins/installed.json"));
    let only_ext = dependency_registry(&[ext("^1.0.0")]);
    use_registry(&config, &only_ext);
    let (code, _, stderr) = run(&["plugin", "install", "ext", "--config-dir", config.text()]);
    assert_eq!(
        (code, stderr.as_str()),
        (
            1,
            "sok: ext 1.0.0: dependency @scope/plugin-base is neither a plugin nor a sidecar of the registry\n"
        )
    );
    assert_eq!(read_text(&config.0.join("plugins/installed.json")), before);
    assert!(!config.0.join("plugins/ext").exists());
}

// contract: cli.plugin.dependencies-update
#[test]
fn plugin_update_selects_a_provider_version_that_satisfies_every_dependent() {
    let config = Dir::new();
    let first = dependency_registry(&[base("1.0.0"), ext("^1.0.0")]);
    use_registry(&config, &first);
    succeeds(&["plugin", "install", "ext", "--config-dir", config.text()]);
    let full = dependency_registry(&[base("1.0.0"), base("1.1.0"), base("2.0.0"), ext("^1.0.0")]);
    use_registry(&config, &full);
    succeeds(&["plugin", "update", "base", "--config-dir", config.text()]);
    let provider = &installed_of(&config).plugins["base"];
    assert_eq!(
        (provider.version.as_str(), provider.previous.as_deref()),
        ("1.1.0", Some("1.0.0"))
    );
    // A disabled dependent also names a range.
    succeeds(&["plugin", "disable", "ext", "--config-dir", config.text()]);
    succeeds(&["plugin", "update", "base", "--config-dir", config.text()]);
    assert_eq!(installed_of(&config).plugins["base"].version, "1.1.0");
    succeeds(&["plugin", "remove", "ext", "--config-dir", config.text()]);
    succeeds(&["plugin", "update", "base", "--config-dir", config.text()]);
    let provider = &installed_of(&config).plugins["base"];
    assert_eq!(
        (provider.version.as_str(), provider.previous.as_deref()),
        ("2.0.0", Some("1.1.0"))
    );
}

// contract: cli.plugin.dependencies-required
#[test]
fn plugin_remove_and_disable_refuse_a_plugin_that_an_enabled_plugin_requires() {
    let config = Dir::new();
    let registry = dependency_registry(&[base("1.0.0"), ext("^1.0.0")]);
    use_registry(&config, &registry);
    succeeds(&["plugin", "install", "ext", "--config-dir", config.text()]);
    let before = read_text(&config.0.join("plugins/installed.json"));
    for action in ["remove", "disable"] {
        let (code, _, stderr) = run(&["plugin", action, "base", "--config-dir", config.text()]);
        assert_eq!(
            (code, stderr.as_str()),
            (1, "sok: plugin base is required by ext ^1.0.0\n"),
            "{action} base"
        );
        assert_eq!(read_text(&config.0.join("plugins/installed.json")), before);
        assert!(config.0.join("plugins/base/1.0.0/plugin.json").exists());
    }
    // A disabled plugin does not require its provider.
    succeeds(&["plugin", "disable", "ext", "--config-dir", config.text()]);
    succeeds(&["plugin", "disable", "base", "--config-dir", config.text()]);
    assert_eq!(
        succeeds(&["plugin", "remove", "base", "--config-dir", config.text()]),
        "null\n"
    );
}
