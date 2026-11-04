//! Replays every case of the process.lock table (docs/spec/cases/process-lock.json) through a writing command of sok
//! (docs/spec/endpoint.md#discovery, docs/spec/installation.md).

use std::path::Path;

use serde::Deserialize;

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

/// One case of the table: the content of process.lock, whether a live owner holds its lock, and the outcome of the command.
#[derive(Deserialize)]
struct LockCase {
    id: String,
    held: bool,
    content: String,
    #[serde(default)]
    pid: String,
    outcome: String,
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

/// The cases of the table, read from the repository path of the table.
fn cases() -> Vec<LockCase> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/process-lock.json"
    );
    let text = std::fs::read_to_string(path).expect("process lock case table");
    let table: serde_json::Value =
        serde_json::from_str(&text).expect("process lock case table JSON");
    let cases: Vec<LockCase> =
        serde_json::from_value(table["cases"].clone()).expect("process lock cases");
    assert!(
        !cases.is_empty(),
        "the process lock case table holds no case"
    );
    cases
}

// contract: cli.plugin.lock-form-cases
#[test]
fn a_writing_command_reads_the_process_lock_case_table() {
    const DEAD_PID: &str = "2147483646";
    let live = std::process::id().to_string();
    let substitute = |text: &str| text.replace("$LIVE", &live).replace("$DEAD", DEAD_PID);
    let mut failures = Vec::new();
    for case in cases() {
        let config = Folder::new("process-lock");
        let lock = config.path().join("process.lock");
        let content = substitute(&case.content);
        std::fs::write(&lock, &content).expect("write process.lock");
        // A live owner holds the advisory lock for the case; the lock is released when the case ends.
        let owner = if case.held {
            let owner = std::fs::File::open(&lock).expect("open process.lock");
            owner.try_lock().expect("hold process.lock as a live owner");
            Some(owner)
        } else {
            None
        };
        let (code, _, stderr) = run(&["plugin", "enable", "probe", "--config-dir", config.text()]);
        let owned = format!("configuration directory {} is already owned", config.text());
        let problem = match case.outcome.as_str() {
            "refused-live" => {
                let want = format!("sok: {owned} by process {}\n", substitute(&case.pid));
                (code != 1 || stderr != want)
                    .then(|| format!("code {code} stderr {stderr:?}, want {want:?}"))
            }
            "refused-held-invalid" => {
                let want = format!(
                    "sok: {owned} by a live process; process.lock is not the current form: {content}\n"
                );
                (code != 1 || stderr != want)
                    .then(|| format!("code {code} stderr {stderr:?}, want {want:?}"))
            }
            "refused-held-empty" => {
                let want = format!("sok: {owned} by a live process\n");
                (code != 1 || stderr != want)
                    .then(|| format!("code {code} stderr {stderr:?}, want {want:?}"))
            }
            "taken" => {
                if stderr.contains("already owned") || stderr.contains("process.lock") {
                    Some(format!("the command refused a free lock: {stderr:?}"))
                } else if lock.exists() {
                    Some("the command did not release the lock it took".to_string())
                } else {
                    None
                }
            }
            other => Some(format!("unknown outcome {other:?}")),
        };
        drop(owner);
        if let Some(problem) = problem {
            failures.push(format!("{}: {problem}", case.id));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
