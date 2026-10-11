//! The policy of the event log and the gate of the producers (docs/spec/logging.md#classes-and-policy).
//!
//! The policy says for each class the least severe level that is stored. The host writes it to `<config-dir>/log-policy.json` from
//! the setting `diagnostics.log`; every process of the host watches the file through file system events and applies the policy
//! that it holds (the tool applies none and stores every event). A producer asks the gate before it builds the fields of an
//! event: a closed gate builds nothing, and the writer counts what the producers did not build for each class and level, so no
//! event disappears without a trace.

use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use serde_json::{json, Map, Value};

pub use crate::event_classes::Class;
use crate::event_log::{EventLog, Level};

/// The schema number of the policy file.
pub const SCHEMA: u64 = 1;

const LEVELS: [Level; 5] = [
    Level::Error,
    Level::Warn,
    Level::Info,
    Level::Debug,
    Level::Trace,
];

/// The values of a class in the file, from the one that stores nothing to the one that stores everything.
const NAMES: [&str; 6] = ["off", "error", "warn", "info", "debug", "trace"];

fn class_index(class: Class) -> usize {
    Class::ALL
        .iter()
        .position(|candidate| *candidate == class)
        .expect("a class is one of the classes of the contract")
}

fn level_index(level: Level) -> usize {
    LEVELS
        .iter()
        .position(|candidate| *candidate == level)
        .expect("a level is one of the levels of the contract")
}

/// The least severe level that is stored for each class.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LogPolicy {
    /// For each class in the order of `Class::ALL`, -1 when no event of the class is stored, otherwise the position in `LEVELS` of the
    /// least severe level that is stored.
    max: [i8; 5],
}

impl LogPolicy {
    /// Stores every level of every class: the diagnostic builds of the 0.0.x series record everything.
    pub fn everything() -> LogPolicy {
        LogPolicy {
            max: [(LEVELS.len() - 1) as i8; 5],
        }
    }

    /// Whether an event of the class and the level is stored under the policy.
    pub fn allows(&self, class: Class, level: Level) -> bool {
        i32::from(self.max[class_index(class)]) >= level_index(level) as i32
    }

    /// The value of each class, as the file writes it.
    pub fn classes(&self) -> Map<String, Value> {
        Class::ALL
            .iter()
            .enumerate()
            .map(|(index, class)| {
                (
                    class.as_str().to_string(),
                    json!(NAMES[(self.max[index] + 1) as usize]),
                )
            })
            .collect()
    }

    /// The text of the policy file.
    pub fn to_json(&self) -> String {
        json!({"schema": SCHEMA, "classes": self.classes()}).to_string()
    }

    /// The policy in the form that the native library takes: for each class, `OFF` (-1) or the number of the least severe level
    /// that is stored (the numbers of `SP_EVENT_*`).
    pub fn native_levels(&self) -> [i8; 5] {
        self.max
    }

    /// Reads the text of a policy file. Every member, class and level is checked, and an error names the file and what it found;
    /// a policy that leaves a class out is refused, because no value stands in for it.
    pub fn parse(file: &str, data: &[u8]) -> Result<LogPolicy, String> {
        let value: Value =
            serde_json::from_slice(data).map_err(|error| format!("{file}: not JSON: {error}"))?;
        let members = value
            .as_object()
            .ok_or_else(|| format!("{file}: not JSON: the text is not an object"))?;
        let mut names: Vec<&String> = members.keys().collect();
        names.sort();
        for name in names {
            if name != "schema" && name != "classes" {
                return Err(format!(
                    "{file}: the member {name} is not one of schema, classes"
                ));
            }
        }
        let schema = members
            .get("schema")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                format!(
                    "{file}: schema must be the number {SCHEMA}, found {}",
                    members
                        .get("schema")
                        .map_or(String::new(), |schema| schema.to_string())
                )
            })?;
        if schema != SCHEMA as i64 {
            return Err(format!("{file}: schema {schema} is not {SCHEMA}"));
        }
        let classes = members
            .get("classes")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{file}: classes must be an object that names every class"))?;
        let mut given: Vec<&String> = classes.keys().collect();
        given.sort();
        for name in given {
            if Class::parse(name).is_none() {
                return Err(format!(
                    "{file}: the class {name} is not one of {}",
                    Class::ALL.map(Class::as_str).join(", ")
                ));
            }
        }
        let mut policy = LogPolicy::everything();
        for (index, class) in Class::ALL.iter().enumerate() {
            let raw = classes
                .get(class.as_str())
                .ok_or_else(|| format!("{file}: the class {} is missing", class.as_str()))?;
            let text = raw.as_str().ok_or_else(|| {
                format!(
                    "{file}: the level of the class {} must be text, found {raw}",
                    class.as_str()
                )
            })?;
            let at = NAMES.iter().position(|name| *name == text).ok_or_else(|| {
                format!(
                    "{file}: the level {text:?} of the class {} is not one of {}",
                    class.as_str(),
                    NAMES.join(", ")
                )
            })?;
            policy.max[index] = at as i8 - 1;
        }
        Ok(policy)
    }
}

/// The gate of a writer: the policy in force and, for each class and level, the number of events that were not built or stored since
/// the writer last reported them.
pub struct Gate {
    max: [AtomicI32; 5],
    gated: [[AtomicU64; 5]; 5],
    current: Mutex<Option<(LogPolicy, String)>>,
}

impl Gate {
    pub(crate) fn new() -> Gate {
        let gate = Gate {
            max: Default::default(),
            gated: Default::default(),
            current: Mutex::new(None),
        };
        gate.store(LogPolicy::everything());
        gate
    }

    fn store(&self, policy: LogPolicy) {
        for (index, max) in policy.max.iter().enumerate() {
            self.max[index].store(i32::from(*max), Ordering::Relaxed);
        }
    }

    /// Whether an event of the class and the level is stored under the policy in force. It counts nothing.
    pub fn enabled(&self, class: Class, level: Level) -> bool {
        self.max[class_index(class)].load(Ordering::Relaxed) >= level_index(level) as i32
    }

    pub(crate) fn count(&self, class: Class, level: Level) {
        self.gated[class_index(class)][level_index(level)].fetch_add(1, Ordering::Relaxed);
    }

    /// Whether the event is stored under the policy in force; a closed gate counts the event.
    pub fn pass(&self, class: Class, level: Level) -> bool {
        if self.enabled(class, level) {
            return true;
        }
        self.count(class, level);
        false
    }

    /// Takes the count of each class and level that the gate refused since the last call.
    pub(crate) fn take_counts(&self) -> Vec<(Class, Level, u64)> {
        let mut taken = Vec::new();
        for (c, class) in Class::ALL.iter().enumerate() {
            for (l, level) in LEVELS.iter().enumerate() {
                let count = self.gated[c][l].swap(0, Ordering::Relaxed);
                if count > 0 {
                    taken.push((*class, *level, count));
                }
            }
        }
        taken
    }

    /// Puts the policy in force; returns false when it is the policy in force already and not the first one.
    pub(crate) fn set(&self, policy: LogPolicy, source: &str) -> bool {
        // default: a lock that a panicking thread poisoned still holds a consistent policy, and the policy must stay readable.
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(&*current, Some((held, _)) if *held == policy) {
            return false;
        }
        *current = Some((policy, source.to_string()));
        self.store(policy);
        true
    }
}

impl EventLog {
    /// Whether an event of the class and the level is stored under the policy in force. It counts nothing.
    pub fn enabled(&self, class: Class, level: Level) -> bool {
        self.gate_handle().enabled(class, level)
    }

    /// The question of a producer before it builds the fields of an event: it reports whether the event is stored. A closed gate counts
    /// the event, which the producer then does not build, so the counter of the class and the level stays exact.
    pub fn gate(&self, class: Class, level: Level) -> bool {
        self.gate_handle().pass(class, level)
    }

    /// Puts the policy in force. A policy that differs from the one in force, and the first policy of a writer, is the event
    /// `log.policy` with the place it came from (`default` or `file`); the same policy again stores nothing.
    pub fn set_policy(&self, policy: LogPolicy, source: &str) {
        if !self.gate_handle().set(policy, source) {
            return;
        }
        match serde_json::value::to_raw_value(
            &json!({"source": source, "classes": policy.classes()}),
        ) {
            Ok(fields) => {
                self.enqueue_writer_event(Level::Info, "log.policy", fields);
            }
            Err(error) => {
                eprintln!("event writer: the policy cannot be serialized: {error}");
            }
        }
    }
}
