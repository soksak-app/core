//! The parts of the wire-case producers of the host that do not depend on the wire (docs/spec/cases/page-wire/README.md,
//! docs/spec/cases/view-wire/README.md): the variables of a case, the comparison of a reply with the reply of the case, the
//! examples that stand for the page variables of a call, and the writer of the event log that a case runs against.
#![allow(dead_code)]

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use soksak_host::event_log::{self, EventLog, Options};
use soksak_host::event_record::use_host_event_log;

use crate::folder;

pub fn is_variable(text: &str) -> bool {
    let Some(name) = text.strip_prefix('$') else {
        return false;
    };
    let mut characters = name.chars();
    characters.next().is_some_and(|c| c.is_ascii_lowercase())
        && characters.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Whether `value` is a JSON value of the type of a variable: integer, number, string, boolean, object, array or null.
pub fn has_type(value: &Value, kind: &str) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "null" => value.is_null(),
        "integer" => value.as_number().is_some_and(|n| n.is_i64()),
        "number" => value.is_number(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        _ => false,
    }
}

pub fn types_of(spec: &Value) -> Vec<String> {
    match &spec["type"] {
        Value::String(one) => vec![one.clone()],
        Value::Array(many) => many
            .iter()
            .filter_map(|kind| kind.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// Returns the first difference between the reply of the case and the reply of the host, or `None` when they match. A string of
/// the form `$name` in the case stands for any value of the declared type of that variable.
pub fn difference(
    path: &str,
    want: &Value,
    got: &Value,
    variables: &Map<String, Value>,
) -> Option<String> {
    if let Some(text) = want.as_str()
        && is_variable(text)
    {
        let Some(spec) = variables.get(&text[1..]) else {
            return Some(format!("{path}: the variable {text} is not declared"));
        };
        if !types_of(spec).iter().any(|kind| has_type(got, kind)) {
            return Some(format!(
                "{path} is {got}, the variable {text} has the type {}",
                spec["type"]
            ));
        }
        return None;
    }
    match (want, got) {
        (Value::Object(expected), Value::Object(actual)) => {
            let names: BTreeSet<&String> = expected.keys().chain(actual.keys()).collect();
            for name in names {
                let Some(expected_value) = expected.get(name) else {
                    return Some(format!(
                        "{path}: the reply has the field {name}, which the case does not record"
                    ));
                };
                let Some(value) = actual.get(name) else {
                    return Some(format!("{path}: the reply lacks the field {name}"));
                };
                if let Some(found) =
                    difference(&format!("{path}.{name}"), expected_value, value, variables)
                {
                    return Some(found);
                }
            }
            None
        }
        (Value::Object(_), _) => Some(format!(
            "{path}: the case records an object, the reply is {got}"
        )),
        (Value::Array(expected), Value::Array(actual)) if expected.len() == actual.len() => {
            expected
                .iter()
                .zip(actual)
                .enumerate()
                .find_map(|(index, (expected_item, item))| {
                    difference(&format!("{path}[{index}]"), expected_item, item, variables)
                })
        }
        (Value::Array(expected), _) => Some(format!(
            "{path}: the case records {} items, the reply is {got}",
            expected.len()
        )),
        _ if want == got => None,
        _ => Some(format!("{path} is {got}, the case records {want}")),
    }
}

/// Returns the payload of a call with each page variable replaced by its example: the page chooses those values, and the producer
/// sends the example as the value the page chose.
pub fn examples(value: &Value, variables: &Map<String, Value>) -> Result<Value, String> {
    Ok(match value {
        Value::String(text) if is_variable(text) => match variables.get(&text[1..]) {
            Some(spec) if spec["source"] == "page" => spec["example"].clone(),
            _ => {
                return Err(format!(
                    "the call uses {text}, which is not a declared page variable"
                ));
            }
        },
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| Ok((key.clone(), examples(item, variables)?)))
                .collect::<Result<_, String>>()?,
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| examples(item, variables))
                .collect::<Result<_, _>>()?,
        ),
        other => other.clone(),
    })
}

/// A writer of the host for a case, made the writer of the records until the value is dropped. With `policy`, the writer has the
/// policy file `log-policy.json` of its folder.
pub struct CaseWriter {
    pub log: Arc<EventLog>,
    _directory: folder::Folder,
}

impl CaseWriter {
    pub fn start(policy: bool) -> CaseWriter {
        let directory = folder::Folder::new();
        let policy_path: Option<PathBuf> = policy.then(|| directory.path().join("log-policy.json"));
        let log = Arc::new(
            event_log::start(Options {
                directory: directory.path().to_path_buf(),
                role: "host".into(),
                boot: "b1".into(),
                queue_events: 64,
                queue_bytes: 64 * 1024,
                batch_interval: Duration::from_millis(20),
                rotate_bytes: 1 << 30,
                pull: None,
                wake: None,
                pull_loss: None,
                policy_path,
                retention_bytes: 1 << 40,
            })
            .unwrap(),
        );
        use_host_event_log(Some(Arc::clone(&log)));
        CaseWriter {
            log,
            _directory: directory,
        }
    }
}

impl Drop for CaseWriter {
    fn drop(&mut self) {
        use_host_event_log(None);
        let _ = self.log.flush();
    }
}
