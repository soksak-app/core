//! Replays the held cases of the process.lock table (docs/spec/cases/process-lock.json) through the endpoint of the host. A held
//! case is a live owner of the configuration directory, so the host refuses the start with the text of its case
//! (docs/spec/endpoint.md#discovery).

#[path = "support/folder.rs"]
mod folder;

use std::sync::Arc;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use soksak_host_tauriv2::endpoint::{Endpoint, Failure, Service, raw};

/// One case of the table.
#[derive(Deserialize)]
struct LockCase {
    id: String,
    held: bool,
    content: String,
    #[serde(default)]
    pid: String,
    outcome: String,
}

/// A service with no window: the start is refused before any request.
struct NoWindow;

impl Service for NoWindow {
    fn unwatched(&self, _window: &str, _name: &str) {}

    fn windows(&self) -> Result<Value, Failure> {
        Ok(json!([]))
    }

    fn exists(&self, _window: &str) -> bool {
        false
    }

    fn call(
        &self,
        _window: &str,
        _method: &str,
        _params: Map<String, Value>,
    ) -> Result<Box<RawValue>, Failure> {
        raw(&Value::Null)
    }
}

/// The held cases of the table, read from the repository path of the table.
fn held_cases() -> Vec<LockCase> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/process-lock.json"
    );
    let text = std::fs::read_to_string(path).expect("process lock case table");
    let table: Value = serde_json::from_str(&text).expect("process lock case table JSON");
    let cases: Vec<LockCase> =
        serde_json::from_value(table["cases"].clone()).expect("process lock cases");
    let held: Vec<LockCase> = cases.into_iter().filter(|case| case.held).collect();
    assert!(!held.is_empty(), "the table holds no held case");
    held
}

// contract: endpoint.lock.case-table-held
#[test]
fn the_host_refuses_a_held_lock_of_each_case_with_its_text() {
    const DEAD_PID: &str = "2147483646";
    let live = std::process::id().to_string();
    let substitute = |text: &str| text.replace("$LIVE", &live).replace("$DEAD", DEAD_PID);
    let mut failures = Vec::new();
    for case in held_cases() {
        let config = folder::Folder::new();
        let lock = config.path().join("process.lock");
        let content = substitute(&case.content);
        std::fs::write(&lock, &content).expect("write process.lock");
        // The case is a live owner: it holds the advisory lock while the endpoint starts.
        let owner = std::fs::File::open(&lock).expect("open process.lock");
        owner.try_lock().expect("hold process.lock as a live owner");
        let refused = Endpoint::start(
            &config.path().join("sockets"),
            config.path(),
            "test-lock-case",
            Arc::new(NoWindow),
        )
        .err();
        let owned = format!(
            "configuration directory {} is already owned",
            config.path().display()
        );
        let want = match case.outcome.as_str() {
            "refused-live" => format!("{owned} by process {}", substitute(&case.pid)),
            "refused-held-invalid" => {
                format!(
                    "{owned} by a live process; process.lock is not the current form: {content}"
                )
            }
            "refused-held-empty" => format!("{owned} by a live process"),
            other => {
                failures.push(format!("{}: unknown outcome {other:?}", case.id));
                continue;
            }
        };
        match refused {
            Some(error) if error == want => {}
            Some(error) => failures.push(format!("{}: {error:?}, want {want:?}", case.id)),
            None => failures.push(format!(
                "{}: the start was accepted while the lock was held",
                case.id
            )),
        }
        drop(owner);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
