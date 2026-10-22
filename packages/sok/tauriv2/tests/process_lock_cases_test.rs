//! Replays every case of the process.lock form table (docs/spec/cases/process-lock.json) through a writing command of sok
//! (docs/spec/endpoint.md#discovery, docs/spec/installation.md).

use std::path::Path;

use serde::Deserialize;

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

/// One case of the table: the content of process.lock and the outcome of the writing command beside it.
#[derive(Deserialize)]
struct LockCase {
    id: String,
    content: String,
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
fn a_writing_command_reads_the_process_lock_form_of_the_case_table() {
    const DEAD_PID: &str = "2147483646";
    let live = std::process::id().to_string();
    let mut failures = Vec::new();
    for case in cases() {
        let config = Folder::new("process-lock");
        let lock = config.path().join("process.lock");
        let content = case
            .content
            .replace("$LIVE", &live)
            .replace("$DEAD", DEAD_PID);
        std::fs::write(&lock, &content).expect("write process.lock");
        let (code, _, stderr) = run(&["plugin", "enable", "probe", "--config-dir", config.text()]);
        let problem = match case.outcome.as_str() {
            "refused-live" => {
                let want = format!(
                    "sok: configuration directory {} is already owned by process {live}\n",
                    config.text()
                );
                (code != 1 || stderr != want)
                    .then(|| format!("code {code} stderr {stderr:?}, want {want:?}"))
            }
            "refused-invalid" => {
                let want = format!(
                    "sok: {}: process.lock is not the current form: {content}\n",
                    lock.display()
                );
                (code != 1 || stderr != want)
                    .then(|| format!("code {code} stderr {stderr:?}, want {want:?}"))
            }
            "taken" => {
                if stderr.contains("already owned") || stderr.contains("process.lock") {
                    Some(format!(
                        "the command refused a lock that it should take: {stderr:?}"
                    ))
                } else if lock.exists() {
                    Some("the command did not release the lock it took".to_string())
                } else {
                    None
                }
            }
            other => Some(format!("unknown outcome {other:?}")),
        };
        if let Some(problem) = problem {
            failures.push(format!("{}: {problem}", case.id));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
