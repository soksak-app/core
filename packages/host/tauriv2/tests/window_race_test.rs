//! Checks the main-thread steps of the host against a real Tauri application: the fixture program of
//! tests/fixtures/window-race runs the event loop of wry on its main thread with hidden windows, plays one scenario on a thread
//! of its own with the real `list_entries` and `use_owner`, closes a real window through the close path of Tauri during a step,
//! and prints one JSON line. Each scenario runs as a child process with its own time limit; a child that crashes or does not
//! end fails the test with its status and its error output.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Value, json};

/// The longest run of one scenario. A scenario ends in well under a second; a child that is still running at the limit is
/// stopped and fails the test.
const SCENARIO_LIMIT: Duration = Duration::from_secs(60);

/// Builds the fixture program once and returns its executable, which cargo names in the artifact message of the build.
fn fixture() -> &'static PathBuf {
    static FIXTURE: OnceLock<PathBuf> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let manifest =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/window-race/Cargo.toml");
        let output = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
            .args(["build", "--message-format=json-render-diagnostics"])
            .arg("--manifest-path")
            .arg(&manifest)
            .stdin(Stdio::null())
            .stderr(Stdio::inherit())
            .output()
            .expect("run cargo");
        assert!(output.status.success(), "the fixture did not build");
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|message| message["reason"] == "compiler-artifact")
            .filter_map(|message| message["executable"].as_str().map(PathBuf::from))
            .next_back()
            .expect("cargo names the executable of the fixture")
    })
}

/// Runs the scenario in a child process and returns the JSON line that it printed.
fn play(scenario: &str) -> Value {
    let mut child = Command::new(fixture())
        .arg(scenario)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the fixture");
    let id = child.id();
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stdout, mut stderr) = (String::new(), String::new());
        let _ = out.read_to_string(&mut stdout);
        let _ = err.read_to_string(&mut stderr);
        let status = child.wait();
        let _ = tx.send((status, stdout, stderr));
    });
    let (status, stdout, stderr) = match rx.recv_timeout(SCENARIO_LIMIT) {
        Ok(ended) => ended,
        Err(_) => {
            // The child outlived its limit: stop it, which ends the reading thread.
            let _ = Command::new("kill").arg("-9").arg(id.to_string()).status();
            panic!("the scenario {scenario} did not end within {SCENARIO_LIMIT:?}");
        }
    };
    let status = status.expect("wait for the fixture");
    assert!(
        status.success(),
        "the scenario {scenario} ended with {status:?}\noutput: {stdout}\nerror output: {stderr}"
    );
    serde_json::from_str(stdout.lines().last().unwrap_or_default())
        .unwrap_or_else(|error| panic!("the scenario {scenario} printed {stdout:?}: {error}"))
}

/// The entry that `host.windows` lists for a window of the fixture: ready, titled with its label, without a project, not key.
fn entry(label: &str) -> Value {
    json!({"ready": true, "window": label, "title": label, "project": null, "key": false})
}

// host.windows reads the closing, the title and the focus of a window in one main-thread step. A close that the main
// thread handled during the list only removes that window from the list or puts it in, and does not make the list fail.
// contract: exposure.windows.listed-in-one-main-thread-step
#[test]
fn a_close_during_the_list_does_not_fail_the_list() {
    let result = play("list-during-close");
    assert_eq!(
        result,
        json!({
            "first": {"ok": [entry("main"), entry("w2")]},
            "closing": true,
            "second": {"ok": [entry("main")]},
        })
    );
}

// The native address of a window is read in the main-thread step that uses the address. A close that the main thread
// handled after reading comes after that step, and a window that closed before the step is not passed to the native
// code and is answered as Closed, which the request ends with error 1003 for a window that does not exist.
// contract: window-close.native-window.used-in-reading-step
#[test]
fn a_close_after_the_handle_read_does_not_reach_native_code() {
    let result = play("use-after-close");
    let native = result["native"].clone();
    assert!(
        native.as_u64().is_some_and(|address| address != 0),
        "{result}"
    );
    assert_eq!(
        result,
        json!({
            "first": {"ok": false},
            "second": {"closed": true},
            "native": native,
            "received": [native],
            "received_after_close": [false],
            "closed_failure": {"code": 1003, "message": r#"window "w2" does not exist"#},
        })
    );
}
