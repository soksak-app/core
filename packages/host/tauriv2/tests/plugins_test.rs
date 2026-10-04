//! 애플리케이션 안의 plugin 작업(docs/spec/installation.md#plugin-operations-in-the-application)을 검사한다.

use std::ffi::CString;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use soksak_host_tauriv2::plugins::{Changed, Plugins, RunRequest};

/// sok 명령을 실행하고 그 JSON 출력을 돌려준다.
fn sok_json(args: &[&str]) -> Value {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (vec![], vec![]);
    let paths = tempfile::tempdir().unwrap();
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        former: None,
        paths_dir: paths.path(),
        core_version: soksak_sok::version::CORE_VERSION,
    };
    let code = soksak_sok::run(&args, &mut stdout, &mut stderr, &options);
    assert_eq!(
        code,
        0,
        "sok {args:?}: {}",
        String::from_utf8_lossy(&stderr)
    );
    serde_json::from_slice(&stdout).expect("sok JSON output")
}

fn write_tree(dir: &Path, files: &[(&str, &str)]) {
    for (name, content) in files {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
}

/// tests/fixtures/plugin-probe(sidecar 가 없는 plugin probe 0.0.2)의 archive 와 그 registry.
/// 폴더는 값이 사라질 때 지운다.
struct Registry {
    index: String,
    archive: String,
    _dirs: Vec<tempfile::TempDir>,
}

fn plugin_registry() -> Registry {
    let (releases, registry) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugin-probe");
    let packed = sok_json(&[
        "plugin",
        "pack",
        source.to_str().unwrap(),
        releases.path().to_str().unwrap(),
    ]);
    let archive = packed["archive"].as_str().unwrap().to_string();
    let entry = json!({
        "id": "probe", "package": "plugin-probe", "name": "Probe", "description": "검사용 plugin.",
        "license": "MIT", "repository": "https://example.invalid/probe",
        "versions": [{"version": "0.0.2", "package": {"url": format!("file://{archive}"), "sha256": packed["sha256"]},
            "engines": {"soksak": ">=0.0.1 <1.0.0"}, "sidecars": {}}],
    });
    write_tree(
        registry.path(),
        &[
            ("plugins/probe.json", &entry.to_string()),
            ("revoked.json", r#"{"plugins": [], "sidecars": []}"#),
        ],
    );
    sok_json(&["registry", "build", registry.path().to_str().unwrap()]);
    Registry {
        index: registry
            .path()
            .join("index.json")
            .to_str()
            .unwrap()
            .to_string(),
        archive,
        _dirs: vec![releases, registry],
    }
}

fn new_plugins(config: &Path) -> (Plugins, Arc<Mutex<Vec<Changed>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let plugins = Plugins::new(
        config.to_path_buf(),
        Box::new(move |change| sink.lock().unwrap().push(change)),
    )
    .expect("plugins");
    (plugins, seen)
}

fn request(action: &str, plugin: Value) -> RunRequest {
    RunRequest {
        action: action.to_string(),
        plugin,
    }
}

fn state_text(plugins: &Plugins) -> String {
    serde_json::to_string(&plugins.state().expect("plugins state")).unwrap()
}

// contract: plugins.state.reports-registry-and-installed
#[test]
fn plugins_state_reports_the_registry_and_the_installation() {
    let config = tempfile::tempdir().unwrap();
    let (plugins, _) = new_plugins(config.path());
    assert_eq!(
        state_text(&plugins),
        r#"{"registry":null,"index":null,"installed":{"format":2,"plugins":{},"sidecars":{}},"firstRun":true}"#
    );
    let registry = plugin_registry();
    soksak_sok::plugins::use_registry(config.path(), &registry.index).unwrap();
    plugins.run(request("install", json!("probe"))).unwrap();
    let state: Value = serde_json::from_str(&state_text(&plugins)).unwrap();
    assert_eq!(state["registry"], format!("file://{}", registry.index));
    assert_eq!(state["index"]["plugins"][0]["id"], "probe");
    assert_eq!(state["installed"]["plugins"]["probe"]["version"], "0.0.2");
    assert_eq!(state["installed"]["plugins"]["probe"]["enabled"], true);
    std::fs::remove_file(&registry.index).unwrap();
    let state: Value = serde_json::from_str(&state_text(&plugins)).unwrap();
    let error = state["index"]["error"].as_str().expect("index error");
    assert!(error.contains(&registry.index), "{error}");
    assert_eq!(state["installed"]["plugins"]["probe"]["version"], "0.0.2");
    std::fs::write(config.path().join("plugins/installed.json"), "{").unwrap();
    let error = plugins.state().err().expect("invalid installed.json fails");
    assert!(
        error.contains("installed.json is not valid JSON"),
        "{error}"
    );
}

// contract: plugins.run.changes-like-the-command
#[test]
fn plugins_run_changes_the_installation_like_the_command() {
    let config = tempfile::tempdir().unwrap();
    let registry = plugin_registry();
    soksak_sok::plugins::use_registry(config.path(), &registry.index).unwrap();
    let (plugins, seen) = new_plugins(config.path());
    let installed = plugins.run(request("install", json!("probe"))).unwrap();
    let want = r#"{"plugin":{"package":"plugin-probe","version":"0.0.2","path":"plugins/probe/0.0.2","enabled":true,"sidecars":{}},"sidecars":{}}"#;
    assert_eq!(serde_json::to_string(&installed).unwrap(), want);
    for action in ["update", "disable", "enable"] {
        plugins.run(request(action, json!("probe"))).unwrap();
    }
    let disabled = plugins.run(request("disable", json!("probe"))).unwrap();
    assert_eq!(serde_json::to_value(&disabled).unwrap()["enabled"], false);
    let removed = plugins.run(request("remove", json!("probe"))).unwrap();
    assert_eq!(serde_json::to_string(&removed).unwrap(), "null");
    assert!(!config.path().join("plugins/probe").exists());
    let seen = seen.lock().unwrap();
    assert!(
        seen.iter().all(|change| change.plugin == "probe"),
        "{seen:?}"
    );
    let actions: Vec<&str> = seen.iter().map(|change| change.action.as_str()).collect();
    assert_eq!(
        actions,
        ["install", "update", "disable", "enable", "disable", "remove"]
    );
}

// contract: plugins.run.rejects-invalid-and-concurrent
#[test]
fn plugins_run_rejects_invalid_and_concurrent_operations() {
    let config = tempfile::tempdir().unwrap();
    let registry = plugin_registry();
    soksak_sok::plugins::use_registry(config.path(), &registry.index).unwrap();
    let (plugins, seen) = new_plugins(config.path());
    for (action, plugin, want) in [
        (
            "rename",
            json!("probe"),
            r#"unknown plugin action "rename""#,
        ),
        ("install", json!(5), "plugin must be a non-empty string"),
        ("install", json!(""), "plugin must be a non-empty string"),
        ("remove", json!("probe"), "plugin probe is not installed"),
    ] {
        let error = plugins
            .run(request(action, plugin))
            .err()
            .expect("rejected");
        assert_eq!(error, want);
    }
    // archive 를 FIFO 로 바꾸면 설치는 그 FIFO 를 읽는 동안 멈춘다. FIFO 를 쓰기로 연 순간 설치는 실행 중이다.
    let data = std::fs::read(&registry.archive).unwrap();
    std::fs::remove_file(&registry.archive).unwrap();
    let fifo = CString::new(registry.archive.as_str()).unwrap();
    // SAFETY: fifo 는 NUL 로 끝나는 경로이고 mkfifo 는 그 경로만 읽는다.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0, "mkfifo");
    let plugins = Arc::new(plugins);
    let first = {
        let plugins = plugins.clone();
        std::thread::spawn(move || plugins.run(request("install", json!("probe"))).map(|_| ()))
    };
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&registry.archive)
        .unwrap();
    let error = plugins
        .run(request("install", json!("probe")))
        .err()
        .expect("concurrent install is rejected");
    assert_eq!(error, "another plugin operation is running");
    assert!(seen.lock().unwrap().is_empty());
    writer.write_all(&data).unwrap();
    drop(writer);
    first.join().unwrap().expect("first install");
    assert_eq!(
        *seen.lock().unwrap(),
        [Changed {
            action: "install".to_string(),
            plugin: "probe".to_string()
        }]
    );
}
