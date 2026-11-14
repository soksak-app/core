//! The producer of the view-wire cases (docs/spec/cases/view-wire/README.md). Each case with replay true runs against the view
//! handler of the host: each call of the case is the runtime.log call that a view sends, which the host answers itself with the writer
//! of its event log (`view_log_command`), and each reply is compared with the reply of the case. A call that the page of the workbench
//! answers has no producer here, so its case has replay false and its reason. The same cases run in the Go host.

#[path = "support/folder.rs"]
mod folder;
#[path = "support/wire_replay.rs"]
mod wire_replay;

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value};
use soksak_host::event_relay::view_log_command;
use wire_replay::{CaseWriter, difference, examples};

/// The folder of the cases, relative to the package of the host library.
const CASES: &str = "../../../docs/spec/cases/view-wire";

/// The plugin, the surface, the document and the time origin of the ready view of the producer.
const PLUGIN: &str = "probe";
const SURFACE: &str = "probe-surface";
const DOCUMENT: &str = "doc-1";
const TIME_ORIGIN: f64 = 1234.5;

/// One case file. Its members are the members of the README table; an unknown member is refused.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    #[allow(dead_code)]
    description: String,
    plugin: String,
    replay: Option<bool>,
    reason: Option<String>,
    #[serde(default)]
    variables: Map<String, Value>,
    steps: Vec<Step>,
}

/// One call step, one reply step, one notice step or one request step.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    call: Option<Call>,
    reply: Option<Reply>,
    notice: Option<Value>,
    request: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    command: String,
    #[serde(default, deserialize_with = "present")]
    params: Option<Value>,
    #[allow(dead_code)]
    cids: Option<Vec<String>>,
}

/// The result, which is null when the host answers nothing, or the error text. `held` belongs to the reader.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    #[serde(default, deserialize_with = "present")]
    result: Option<Value>,
    error: Option<String>,
    #[allow(dead_code)]
    held: Option<bool>,
}

/// Keeps a `null` as `Some(Null)`, so a value that the case records as `null` differs from a value that it records nothing for.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

fn run_case(name: &str, file: &Path) -> Result<(), String> {
    let data = fs::read(file).map_err(|error| error.to_string())?;
    let case: Case =
        serde_json::from_slice(&data).map_err(|error| format!("{}: {error}", file.display()))?;
    if case.name != name {
        return Err(format!("name {:?} does not match the file name", case.name));
    }
    match case.replay {
        None => return Err("replay is missing".into()),
        Some(false) => {
            return match case.reason.as_deref() {
                Some(reason) if !reason.is_empty() => Ok(()),
                _ => Err("a case with replay false must give its reason".into()),
            };
        }
        Some(true) => {}
    }
    // The ready view of the producer belongs to the plugin probe, so a case that it replays names that plugin.
    if case.plugin != PLUGIN {
        return Err(format!(
            "the plugin is {:?}, the view of this producer belongs to {PLUGIN}",
            case.plugin
        ));
    }
    if case.steps.len() % 2 != 0 {
        return Err("the steps are not call and reply pairs".into());
    }
    let writer = CaseWriter::start(false);
    for (index, pair) in case.steps.chunks(2).enumerate() {
        let step = index * 2;
        let (Some(call), Some(reply)) = (&pair[0].call, &pair[1].reply) else {
            return Err(format!(
                "step {step}: only a call step followed by its reply step is replayed; a notice or a request of the host is played by a view"
            ));
        };
        if call.command != "runtime.log" {
            return Err(format!(
                "step {step}: the call {} is answered by the page of the workbench, so the case needs replay false and the reason",
                call.command
            ));
        }
        let params = call
            .params
            .as_ref()
            .map(|params| examples(params, &case.variables))
            .transpose()
            .map_err(|error| format!("step {step}: {error}"))?
            .unwrap_or(Value::Null);
        let result = view_log_command(&writer.log, params, PLUGIN, SURFACE, DOCUMENT, TIME_ORIGIN);
        if let Some(error) = &reply.error {
            match result {
                Err(actual) if &actual == error => continue,
                other => {
                    return Err(format!(
                        "step {step}: runtime.log returned {other:?}, the case records the error {error:?}"
                    ));
                }
            }
        }
        let value = result.map_err(|error| {
            format!(
                "step {step}: runtime.log returned the error {error}, the case records the result {:?}",
                reply.result
            )
        })?;
        let want = reply.result.clone().unwrap_or(Value::Null);
        if let Some(found) = difference("reply", &want, &value, &case.variables) {
            return Err(format!("step {step}: runtime.log: {found}"));
        }
    }
    Ok(())
}

/// Runs each view-wire case of the folder with replay true, one after the other: the records of the host are process-wide.
// contract: view.wire.replays-recorded-cases
#[test]
fn every_case_with_replay_true_gives_its_recorded_reply() {
    let mut names: Vec<(String, PathBuf)> = fs::read_dir(CASES)
        .unwrap_or_else(|error| panic!("{CASES}: {error}"))
        .map(|entry| entry.unwrap().path())
        .filter_map(|path| {
            let name = path
                .file_name()?
                .to_str()?
                .strip_suffix(".json")?
                .to_string();
            path.is_file().then_some((name, path))
        })
        .collect();
    names.sort();
    assert!(!names.is_empty(), "{CASES} holds no case");
    let mut failures = Vec::new();
    for (name, file) in &names {
        match run_case(name, file) {
            Ok(()) => println!("passed {name}"),
            Err(error) => {
                println!("failed {name}: {error}");
                failures.push(format!("{name}: {error}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases failed:\n{}",
        failures.len(),
        names.len(),
        failures.join("\n")
    );
}
