//! The policy file and the gate of the producers of the host (docs/spec/logging.md#classes-and-policy).
//!
//! The policy, the gate and the counts of what the gate refused belong to the shared writer (`soksak_sok::log_policy`). The host adds
//! the policy file: it writes `<config-dir>/log-policy.json` from the setting `diagnostics.log`, watches the file through the file
//! system events of the platform, gives the policy to the native library, and asks the gate of its writer in the producers.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use serde_json::{json, Value};
use soksak_sok::log_policy::SCHEMA;
pub use soksak_sok::log_policy::{Class, Gate, LogPolicy};

use crate::event_log::{EventLog, Level};

/// The gate of the writer of the host, which the producers of the host ask.
static ACTIVE: RwLock<Option<Arc<Gate>>> = RwLock::new(None);

/// Makes the gate of `log` the gate of the producers of the host; `None` removes it, and every gate is open again.
pub(crate) fn use_gate(log: Option<&EventLog>) {
    // default: a lock that a panicking thread poisoned still holds a consistent gate, and the writer must be able to replace it.
    *ACTIVE.write().unwrap_or_else(PoisonError::into_inner) = log.map(EventLog::gate_handle);
}

/// `gate` on the writer of the host. Without a writer every event waits in the start buffer, so every gate is open.
pub fn gate_event(class: Class, level: Level) -> bool {
    // default: a lock that a panicking thread poisoned still holds a consistent gate, and the producers must be able to ask it.
    match &*ACTIVE.read().unwrap_or_else(PoisonError::into_inner) {
        Some(gate) => gate.pass(class, level),
        None => true,
    }
}

/// `enabled` on the writer of the host: whether an event of the class and the level is stored, without a count. A producer that
/// keeps what it measured until it knows the level of the event asks it first, and asks `gate_event` when it builds the event.
pub fn event_enabled(class: Class, level: Level) -> bool {
    // default: a lock that a panicking thread poisoned still holds a consistent gate, and the producers must be able to ask it.
    match &*ACTIVE.read().unwrap_or_else(PoisonError::into_inner) {
        Some(gate) => gate.enabled(class, level),
        None => true,
    }
}

/// Writes the policy file as a new file renamed over the path, so a watcher never reads half a policy.
pub fn write_log_policy(path: &Path, policy: &LogPolicy) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let directory = path
        .parent()
        .ok_or_else(|| format!("{} has no folder", path.display()))?;
    let temporary = directory.join(format!(".log-policy-{}", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(policy.to_json().as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    result.map_err(|error| {
        let removed = std::fs::remove_file(&temporary);
        match removed {
            Err(second) if second.kind() != std::io::ErrorKind::NotFound => {
                format!(
                    "{}: {error}; {}: {second}",
                    path.display(),
                    temporary.display()
                )
            }
            _ => format!("{}: {error}", path.display()),
        }
    })
}

/// The action `policy` of the call `log`: the page sends the policy of its setting `diagnostics.log` as `classes`, and the host checks it
/// with the rules of the file and writes the file, which every watcher applies (docs/spec/logging.md#classes-and-policy).
pub fn set_log_policy(log: &EventLog, request: &Value) -> Result<(), String> {
    let path = log
        .policy_path()
        .ok_or_else(|| "this event writer has no policy file".to_string())?;
    // default: an absent member `classes` is null, which the parse refuses as a member that is not an object.
    let text = json!({"schema": SCHEMA, "classes": request.get("classes").cloned().unwrap_or(Value::Null)})
        .to_string();
    let policy = LogPolicy::parse("the call log", text.as_bytes())?;
    write_log_policy(path, &policy)
}

/// The watch of the policy file; dropping it stops the watch.
pub struct LogPolicyWatch {
    stop: Option<Box<dyn FnOnce() + Send>>,
}

impl Drop for LogPolicyWatch {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

/// The function that `start_log_policy` calls after each load with `default`, `file` or `error`.
pub type PolicyApplied = Box<dyn Fn(&str) + Send + Sync>;

/// Applies the policy file of the writer and watches the file: a creation, a write, a replacement or a removal puts the policy of the
/// file (or the default policy, when there is no file) in force. The watch is a file system event of the platform, and no timer reads
/// the file. A file that breaks the format is reported as an error record of the place `log policy` and the policy in force stays.
/// `applied`, when it is given, is called after each load with `default`, `file` or `error`.
pub fn start_log_policy(
    log: &Arc<EventLog>,
    applied: Option<PolicyApplied>,
) -> Result<LogPolicyWatch, String> {
    let path = log
        .policy_path()
        .ok_or_else(|| "the event writer has no policy file".to_string())?
        .to_path_buf();
    let system = crate::platform::current()?;
    // What the previous load found; a notification that leaves it as it was is a repeat of one that led to a read.
    let last = Arc::new(Mutex::new(String::new()));
    let load = {
        let (log, path, last) = (Arc::clone(log), path.clone(), Arc::clone(&last));
        Arc::new(move || {
            // default: a lock that a panicking thread poisoned still holds the last state, which is only compared.
            let mut last = last.lock().unwrap_or_else(PoisonError::into_inner);
            let mut source = "file";
            let mut policy = LogPolicy::everything();
            let mut failure = String::new();
            match std::fs::read(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => source = "default",
                Err(error) => {
                    source = "error";
                    failure = format!("{}: {error}", path.display());
                }
                // silent: an empty file is a file that a writer truncated and is writing; its completion is the next notification.
                Ok(data) if data.iter().all(u8::is_ascii_whitespace) => return,
                Ok(data) => match LogPolicy::parse(&path.display().to_string(), &data) {
                    Ok(parsed) => policy = parsed,
                    Err(error) => {
                        source = "error";
                        failure = error;
                    }
                },
            }
            let state = if failure.is_empty() {
                format!("{source}:{}", policy.to_json())
            } else {
                format!("{source}:{failure}")
            };
            if *last == state {
                return;
            }
            *last = state;
            if failure.is_empty() {
                log.set_policy(policy, source);
                if let Err(error) = crate::platform::current()
                    .and_then(|system| system.set_native_event_policy(policy.native_levels()))
                {
                    crate::application_log::log_error("log policy", error);
                }
            } else {
                crate::application_log::log_error("log policy", failure);
            }
            if let Some(applied) = applied.as_ref() {
                applied(source);
            }
        })
    };
    // The watch is installed before the first load, so a change between the two is not missed.
    let notify = {
        let load = Arc::clone(&load);
        Arc::new(move || {
            let load = Arc::clone(&load);
            crate::routine::spawn_named("log-policy-load", move || load());
        })
    };
    let stop = system
        .watch_file(&path, notify)
        .map_err(|error| format!("watch {}: {error}", path.display()))?;
    load();
    Ok(LogPolicyWatch { stop: Some(stop) })
}
