//! The producer of the page-wire cases (docs/spec/cases/page-wire/README.md). Each case with replay true runs against the host:
//! each call of the case goes through the operation that the host method of the call runs, and each reply is compared with the
//! reply of the case. A call of the page is named as the page names it. The same cases run in the Go host.

#[path = "support/folder.rs"]
mod folder;
#[path = "support/wire_replay.rs"]
mod wire_replay;

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value, json};
use soksak_host::event_log::EventLog;
use soksak_host::event_relay::log_command;
use soksak_host::workspace::Workspace;
use wire_replay::{CaseWriter, difference, examples};

/// The folder of the cases, relative to the package of the host library.
const CASES: &str = "../../../docs/spec/cases/page-wire";

/// One case file. Its members are the members of the README table; an unknown member is refused.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    #[allow(dead_code)]
    description: String,
    replay: Option<bool>,
    reason: Option<String>,
    writer: Option<Writer>,
    #[serde(default)]
    variables: Map<String, Value>,
    steps: Vec<Step>,
}

/// The state of the event writer of the host that the case runs against. Without the member, the writer has no policy file.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Writer {
    policy: bool,
}

/// One call step, one reply step, one notice step or one listen step.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    call: Option<Call>,
    reply: Option<Reply>,
    notice: Option<Value>,
    listen: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    name: String,
    payload: Option<Value>,
    #[allow(dead_code)]
    cids: Option<Vec<String>>,
}

/// The result, which is null when the host answers nothing, or the error text. `held` belongs to the reader; the producer compares
/// the reply as any other.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    #[serde(default, deserialize_with = "present")]
    result: Option<Value>,
    error: Option<String>,
    #[allow(dead_code)]
    held: Option<bool>,
}

/// Keeps a `null` result as `Some(Null)`, so a reply that records `null` differs from a reply that records nothing.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// Runs one call of the page. The page names the call as the runtime names it.
fn invoke(
    writer: &EventLog,
    workspace: &Workspace,
    name: &str,
    payload: Option<Value>,
) -> Result<Value, String> {
    let Some(payload) = payload else {
        return Err(format!(
            "call {name} has 0 arguments, the case records one payload"
        ));
    };
    match name {
        // The tauriv2 command `log`: the lines go to the transcript of the window, and the reply is the classes of a policy-read,
        // the clocks of a clock request, or nothing.
        "log" => {
            let reply = log_command(writer, payload)?;
            if let Some(classes) = reply.classes {
                return Ok(json!({ "classes": classes }));
            }
            serde_json::to_value(reply.clock).map_err(|error| error.to_string())
        }
        // `workspace::handle` runs the request in the store, and a snapshot carries the identifiers of the open windows, which
        // are none in this run.
        "workspace" => {
            let snapshot = payload["kind"] == "snapshot";
            let request: soksak_host::workspace::Request =
                serde_json::from_value(payload).map_err(|error| error.to_string())?;
            let mut result = workspace.apply(request)?;
            if snapshot {
                result["open"] = json!([]);
            }
            Ok(result)
        }
        other => Err(format!(
            "the case calls {other}, which the producer does not run"
        )),
    }
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
    // The producer runs the calls of the host without a window, and a notice reaches only the listeners of a window; the
    // registration of a listener is made by a page, which this producer does not have.
    for (index, step) in case.steps.iter().enumerate() {
        if step.notice.is_some() {
            return Err(format!(
                "step {index} is a notice, which this producer cannot observe; the case needs replay false and the reason"
            ));
        }
        if step.listen.is_some() {
            return Err(format!(
                "step {index} is the registration of a listener, which this producer has no page to make; the case needs replay false and the reason"
            ));
        }
    }
    if case.steps.len() % 2 != 0 {
        return Err("the steps are not call and reply pairs".into());
    }
    // A case with no steps sends no call, so the producer has no call to run and the case passes with nothing to compare.
    let writer = CaseWriter::start(case.writer.as_ref().is_some_and(|writer| writer.policy));
    let configuration = folder::Folder::new();
    let workspace = Workspace::new(configuration.path().into());
    for (index, pair) in case.steps.chunks(2).enumerate() {
        let (Some(call), Some(reply)) = (&pair[0].call, &pair[1].reply) else {
            return Err(format!(
                "step {}: a call step must be followed by its reply step",
                index * 2
            ));
        };
        let payload = call
            .payload
            .as_ref()
            .map(|payload| examples(payload, &case.variables))
            .transpose()
            .map_err(|error| format!("step {}: {error}", index * 2))?;
        let result = invoke(&writer.log, &workspace, &call.name, payload);
        let step = index * 2;
        if let Some(error) = &reply.error {
            match result {
                Err(actual) if &actual == error => continue,
                other => {
                    return Err(format!(
                        "step {step}: {} returned {other:?}, the case records the error {error:?}",
                        call.name
                    ));
                }
            }
        }
        let value = result.map_err(|error| {
            format!(
                "step {step}: {} returned the error {error}, the case records the result {:?}",
                call.name, reply.result
            )
        })?;
        let want = reply.result.clone().unwrap_or(Value::Null);
        if let Some(found) = difference("reply", &want, &value, &case.variables) {
            return Err(format!("step {step}: {}: {found}", call.name));
        }
    }
    Ok(())
}

/// Runs each page-wire case of the folder with replay true, one after the other: the records of the host are process-wide.
// contract: page.wire.replays-recorded-cases
#[test]
fn every_page_wire_case_with_replay_true_gives_its_recorded_reply() {
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
