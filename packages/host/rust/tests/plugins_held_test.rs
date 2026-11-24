//! Checks a plugin operation that the live service of a persistent sidecar holds, in the plugin operations of the host
//! (docs/spec/persistent-services.md#updates). The registry holds real releases, the old service is a process that the
//! endpoint names, and the installed service is the sidecar fixture program of the release.

#[path = "support/folder.rs"]
mod folder;
#[path = "support/records.rs"]
mod records;
#[path = "support/sidecar_recorder.rs"]
mod sidecar_recorder;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sidecar_recorder::SidecarRecorder;
use soksak_host::plugins::{Plugins, RunRequest};
use soksak_host::sidecars::Sidecars;
use soksak_sok::plugins::{HeldOperation, HeldService};

const WORKER: &str = "@scope/sidecar-worker";

fn sok_json(args: &[&str]) -> Value {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (vec![], vec![]);
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        core_version: soksak_sok::version::CORE_VERSION,
        config_dir_variable: None,
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

/// Writes the release of files, under package/, to path and returns its sha256. A name that ends with * is an executable.
fn pack_release(path: &Path, files: &[(&str, String)]) -> String {
    use sha2::Digest;
    let mut data = vec![];
    {
        let zipped = flate2::write::GzEncoder::new(&mut data, flate2::Compression::default());
        let mut stream = tar::Builder::new(zipped);
        for (name, content) in files {
            let (name, mode) = match name.strip_suffix('*') {
                Some(name) => (name, 0o755),
                None => (*name, 0o644),
            };
            let mut header = tar::Header::new_ustar();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(content.len() as u64);
            header.set_mode(mode);
            stream
                .append_data(&mut header, format!("package/{name}"), content.as_bytes())
                .unwrap();
        }
        stream.into_inner().unwrap().finish().unwrap();
    }
    std::fs::write(path, &data).unwrap();
    sha2::Sha256::digest(&data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The text of the sidecar fixture program, which a release carries as the executable of the sidecar.
fn fixture_program() -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/spec/cases/sidecars/fixture.sh"),
    )
    .unwrap()
}

/// Builds in dir the registry of the given probe versions: probe 0.2.0 requires the persistent sidecar worker ^0.1.0 and probe
/// 0.3.0 requires ^0.2.0. Each worker release is the fixture program, whose control publishes an endpoint on socket and
/// records the process id in pid_path. It returns the path of index.json.
fn write_held_registry(dir: &Path, socket: &Path, pid_path: &Path, versions: &[&str]) -> String {
    let platform = soksak_sok::current_platform().unwrap();
    let core = soksak_sok::version::CORE_VERSION;
    std::fs::create_dir_all(dir.join("releases")).unwrap();
    let range = |version: &str| {
        if version == "0.2.0" {
            "^0.1.0"
        } else {
            "^0.2.0"
        }
    };
    let mut entries = vec![];
    for version in versions {
        let path = dir.join("releases").join(format!("probe-{version}.tgz"));
        let sum = pack_release(
            &path,
            &[
                (
                    "package.json",
                    format!(
                        r#"{{"name": "@scope/plugin-probe", "version": "{version}", "engines": {{"soksak": "^{core}"}}, "files": ["plugin.json", "ui"]}}"#
                    ),
                ),
                (
                    "plugin.json",
                    format!(
                        r#"{{"id": "probe", "name": "Probe", "description": "Sample.", "contributes": {{"lib.point": [{{"range": "^1.0.0", "module": "ui/b.js"}}]}}, "dependencies": {{"{WORKER}": "{}"}}}}"#,
                        range(version)
                    ),
                ),
                ("ui/b.js", format!("b {version}")),
            ],
        );
        entries.push(json!({
            "version": version,
            "release": {"url": format!("file://{}", path.display()), "sha256": sum},
            "engines": {"soksak": format!("^{core}")},
            "sidecars": {WORKER: range(version)},
        }));
    }
    let mut sidecars = vec![];
    for version in ["0.1.0", "0.2.0"] {
        let path = dir.join("releases").join(format!("worker-{version}.tgz"));
        let sum = pack_release(
            &path,
            &[
                ("package.json", format!(r#"{{"name": "{WORKER}", "version": "{version}", "files": ["sidecar.json", "build"]}}"#)),
                ("sidecar.json", r#"{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/probe", "transport": "persistent"}"#.to_string()),
                ("build/worker*", fixture_program()),
                ("build/control", format!("record-pid {}\nendpoint {} harness-token\nsleep 20\n", pid_path.display(), socket.display())),
            ],
        );
        sidecars.push(json!({
            "version": version, "protocol": 1,
            "releases": {platform.clone(): {"url": format!("file://{}", path.display()), "sha256": sum}},
        }));
    }
    std::fs::create_dir_all(dir.join("plugins")).unwrap();
    std::fs::create_dir_all(dir.join("sidecars")).unwrap();
    std::fs::write(
        dir.join("plugins/probe.json"),
        json!({"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
            "license": "MIT", "repository": "https://example.invalid/probe", "versions": entries})
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        dir.join("sidecars/scope-sidecar-worker.json"),
        json!({"name": WORKER, "repository": "https://example.invalid/worker", "versions": sidecars}).to_string(),
    )
    .unwrap();
    std::fs::write(
        dir.join("revoked.json"),
        r#"{"plugins": [], "sidecars": []}"#,
    )
    .unwrap();
    sok_json(&["registry", "build", dir.to_str().unwrap()]);
    dir.join("index.json").to_str().unwrap().to_string()
}

/// The service of worker 0.1.0 that runs beside the installation: a process that the endpoint names, whose first connection
/// answers hello with 0.1.0 and ends the process after shutdown, and whose later connections, from the installed service that
/// the host starts, answer hello with 0.2.0. installed receives each later hello.
struct OldService {
    process: Arc<Mutex<std::process::Child>>,
    installed: Receiver<()>,
    pid_path: PathBuf,
}

impl Drop for OldService {
    fn drop(&mut self) {
        // The installed service is a process that the host started from this test process; the fixture ends and reaps it.
        if let Ok(text) = std::fs::read_to_string(&self.pid_path) {
            let pid: i32 = text
                .trim()
                .parse()
                .expect("the installed service writes its process identifier");
            if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 {
                let error = std::io::Error::last_os_error();
                assert_eq!(
                    error.raw_os_error(),
                    Some(libc::ESRCH),
                    "ending the installed service {pid}: {error}"
                );
            }
            let mut status: libc::c_int = 0;
            if unsafe { libc::waitpid(pid, &mut status, 0) } < 0 {
                let error = std::io::Error::last_os_error();
                assert_eq!(
                    error.raw_os_error(),
                    Some(libc::ECHILD),
                    "waiting for the installed service {pid}: {error}"
                );
            }
        }
        let mut process = self.process.lock().unwrap();
        // The process may have ended after the shutdown answer already; then the kill fails and the wait returns its status.
        let _ = process.kill();
        let _ = process.wait();
    }
}

fn serve_held_service(config: &Path, socket: &Path, pid_path: &Path) -> OldService {
    let listener = UnixListener::bind(socket).unwrap();
    let process = std::process::Command::new("cat")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    std::fs::create_dir_all(config.join("services/worker")).unwrap();
    std::fs::write(
        config.join("services/worker/endpoint.json"),
        json!({"protocol": 1, "pid": process.id(), "socket": socket, "token": "harness-token"})
            .to_string(),
    )
    .unwrap();
    let process = Arc::new(Mutex::new(process));
    let ending = Arc::clone(&process);
    let (installed_sender, installed) = channel();
    std::thread::spawn(move || {
        for index in 0.. {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let first = index == 0;
            let version = if first { "0.1.0" } else { "0.2.0" };
            let ending = Arc::clone(&ending);
            let installed_sender = installed_sender.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let operation = request["operation"].as_str().unwrap_or("").to_string();
                    let reply = match operation.as_str() {
                        "hello" => json!({"operation": "hello", "protocol": 1, "ok": true, "version": version}).to_string(),
                        "close-owner" => json!({"operation": "closed-owner", "request": request["request"], "ok": true}).to_string(),
                        "shutdown" => json!({"operation": "shutdown", "request": request["request"], "ok": true}).to_string(),
                        "retain" => json!({"operation": "retained", "request": request["request"], "ok": true, "closed": 0}).to_string(),
                        _ => line.trim_end().to_string(),
                    };
                    if writeln!(stream, "{reply}").is_err() {
                        return;
                    }
                    if operation == "hello" && !first {
                        // The check stopped waiting for the installed service, so no one receives it.
                        let _ = installed_sender.send(());
                    }
                    if operation == "shutdown" {
                        let mut process = ending.lock().unwrap();
                        let _ = process.kill();
                        let _ = process.wait();
                        return;
                    }
                    line.clear();
                }
            });
        }
    });
    OldService {
        process,
        installed,
        pid_path: pid_path.to_path_buf(),
    }
}

/// A configuration folder with probe 0.2.0 and worker 0.1.0 installed and the registry of probe 0.2.0 and 0.3.0 in use, the
/// service of worker 0.1.0, and the sidecars and the plugin operations of the host, whose apply step declares the installed
/// sidecars.
struct Installation {
    config: folder::Folder,
    sidecars: Arc<Sidecars<SidecarRecorder>>,
    plugins: Plugins,
    service: OldService,
    _folders: Vec<folder::Folder>,
}

fn held_installation() -> Installation {
    let config = folder::Folder::new();
    let sockets = folder::Folder::new();
    let socket = sockets.path().join("s.sock");
    let pids = folder::Folder::new();
    let pid_path = pids.path().join("installed.pid");
    let first = folder::Folder::new();
    let both = folder::Folder::new();
    let index = write_held_registry(first.path(), &socket, &pid_path, &["0.2.0"]);
    sok_json(&[
        "registry",
        "use",
        &index,
        "--config-dir",
        config.path().to_str().unwrap(),
    ]);
    sok_json(&[
        "plugin",
        "install",
        "probe",
        "--config-dir",
        config.path().to_str().unwrap(),
    ]);
    let index = write_held_registry(both.path(), &socket, &pid_path, &["0.2.0", "0.3.0"]);
    sok_json(&[
        "registry",
        "use",
        &index,
        "--config-dir",
        config.path().to_str().unwrap(),
    ]);
    let service = serve_held_service(config.path(), &socket, &pid_path);
    let declarations = soksak_host::installed::installed_sidecars(config.path()).unwrap();
    let sidecars = Arc::new(Sidecars::new(&declarations, config.path().to_path_buf()).unwrap());
    let (serving, applying) = (Arc::clone(&sidecars), Arc::clone(&sidecars));
    let installed = config.path().to_path_buf();
    let plugins = Plugins::new(
        config.path().to_path_buf(),
        Box::new(move || Some(serving.plugin_services())),
        Box::new(move || {
            applying.declare(&soksak_host::installed::installed_sidecars(&installed)?)
        }),
        Box::new(|_| {}),
    )
    .unwrap();
    Installation {
        config,
        sidecars,
        plugins,
        service,
        _folders: vec![sockets, pids, first, both],
    }
}

fn held_error() -> String {
    format!(
        "plugin probe 0.3.0: sidecar {WORKER} 0.2.0 waits for the end of its running service 0.1.0"
    )
}

/// The held list of the state for the update of probe beside the service of worker 0.1.0.
fn held_state(sessions: Option<usize>) -> Vec<HeldOperation> {
    vec![HeldOperation {
        plugin: "probe".to_string(),
        action: "update".to_string(),
        version: "0.3.0".to_string(),
        error: held_error(),
        sidecars: vec![HeldService {
            sidecar: WORKER.to_string(),
            planned: "0.2.0".to_string(),
            running: Some("0.1.0".to_string()),
            sessions,
        }],
    }]
}

fn request(action: &str, end: Option<Value>) -> RunRequest {
    RunRequest {
        action: action.to_string(),
        plugin: json!("probe"),
        end,
    }
}

fn installed_text(config: &Path) -> String {
    std::fs::read_to_string(config.join("plugins/installed.json")).unwrap()
}

// contract: plugins.held.update-waits-and-runs-with-the-end-of-its-service
#[test]
fn a_held_update_is_listed_and_runs_with_the_end_of_its_service() {
    let installation = held_installation();
    let writer = records::start_writer(installation.config.path());
    let plugins = &installation.plugins;
    let before = installed_text(installation.config.path());
    assert_eq!(
        plugins.run(request("update", None)).err(),
        Some(held_error())
    );
    assert_eq!(installed_text(installation.config.path()), before);
    assert_eq!(plugins.state().unwrap().held, held_state(None));
    for (request, want) in [
        (
            request("update", Some(json!("yes"))),
            "end must be true".to_string(),
        ),
        (
            request("remove", Some(json!(true))),
            "end does not apply to remove".to_string(),
        ),
        (
            request("update", Some(json!(true))),
            format!("plugin probe: the sessions of sidecar {WORKER} are not known"),
        ),
    ] {
        assert_eq!(plugins.run(request).err(), Some(want));
    }
    installation.sidecars.retain_sessions(&[]).unwrap();
    assert_eq!(plugins.state().unwrap().held, held_state(Some(0)));
    plugins.run(request("update", Some(json!(true)))).unwrap();
    let state = soksak_sok::plugins::read_installed(installation.config.path()).unwrap();
    assert_eq!(
        (
            state.plugins["probe"].version.as_str(),
            state.sidecars[WORKER].version.as_str()
        ),
        ("0.3.0", "0.2.0")
    );
    assert_eq!(plugins.state().unwrap().held, vec![]);
    // The reconnection starts the installed service after the operation.
    installation.service.installed.recv().unwrap();
    let log = records::records_text(installation.config.path(), &writer);
    let ended = format!("sidecar {WORKER}: service 0.1.0 ended for plugin probe 0.3.0");
    assert!(log.contains(&ended), "the log has no {ended:?}: {log}");
    installation.sidecars.stop();
}

// contract: plugins.held.update-at-start-keeps-a-held-candidate
#[test]
fn an_update_at_start_that_a_service_holds_stays_and_is_listed() {
    let installation = held_installation();
    let plugins = &installation.plugins;
    let before = installed_text(installation.config.path());
    let results = plugins.update_at_start();
    assert_eq!(results.len(), 1, "{results:?}");
    assert!(results[0].held, "{results:?}");
    assert_eq!(results[0].error, Some(held_error()));
    assert_eq!(installed_text(installation.config.path()), before);
    let state = plugins.state().unwrap();
    assert!(state.start_update.is_empty(), "{:?}", state.start_update);
    assert_eq!(state.held, held_state(None));
    installation.sidecars.stop();
}
