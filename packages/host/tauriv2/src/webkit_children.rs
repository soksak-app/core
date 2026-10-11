//! The record of the WebKit XPC children that this run created, and the harvest at the next start (V5-113).
//!
//! The startup cleanup of V5-105 was removed because it cannot make a reliable decision (a live WebKit has no socket or
//! path proof either). The rule here follows an established precedent: the SingletonLock of a browser writes
//! hostname-PID into its own user data directory and trusts only its own record. This run also records the pid of the
//! WebKit children that it created in its own configuration directory, and the next start harvests only that record. A
//! process that is not recorded is never touched.
//!
//! All three conditions must hold to kill: it was recorded (we created it), that pid is still a WebKit process
//! (protection against pid reuse), the start time equals the record (the same instance), and the recorded host process
//! is dead (it is not the child of a live sibling instance).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;

/// The name of the record file. It is placed at the root of the configuration directory.
const RECORD: &str = "webkit-children.json";

/// The WebKit XPC processes that were already running when this run started belong to someone else. They are removed
/// from the record.
static BASELINE: OnceLock<Vec<u32>> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct Record {
    host_pid: u32,
    children: Vec<Child>,
}

#[derive(Serialize, Deserialize)]
struct Child {
    pid: u32,
    kind: String,
    /// The start time of the process (ps lstart). Protection against pid reuse: when another process uses the same pid,
    /// the value differs. The format does not change on the same machine, so the strings are compared as they are.
    lstart: String,
}

/// Runs ps with args and returns the standard output. In a query for one pid (-p), ps ends with status 1 and no output
/// when that process does not exist, and that is not a failure but the answer "that process does not exist". Any other
/// failure is an error that holds the query and the message of ps, and the caller records it.
fn ps_query(args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("ps")
        .args(args)
        .output()
        .map_err(|error| format!("ps {}: {error}", args.join(" ")))?;
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        return Ok(text);
    }
    if output.status.code() == Some(1) && text.trim().is_empty() && args.contains(&"-p") {
        return Ok(String::new());
    }
    Err(format!(
        "ps {}: {}: {}",
        args.join(" "),
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// Records a failed ps query. Without an answer to the query, the caller decides toward not killing and not toward
/// killing.
fn ps_failed(error: String) {
    crate::application_log::log_error("webkit children", error);
}

/// The list of (pid, kind) of the live WebKit XPC processes. When ps fails, it records that error and returns an empty
/// list.
fn webkit_processes() -> Vec<(u32, String)> {
    let output = match ps_query(&["-axo", "pid=,command="]) {
        Ok(output) => output,
        Err(error) => {
            ps_failed(error);
            return Vec::new();
        }
    };
    let (found, unreadable) = parse_webkit_processes(&output);
    for line in unreadable {
        crate::application_log::log_error(
            "webkit children",
            format!("ps line {line:?} begins with no process number"),
        );
    }
    found
}

/// The (pid, kind) of the WebKit XPC processes in the output of `ps -axo pid=,command=`, and the lines that begin with no
/// process number.
pub fn parse_webkit_processes(output: &str) -> (Vec<(u32, String)>, Vec<String>) {
    let mut found = Vec::new();
    let mut unreadable = Vec::new();
    // ps pads the process number with leading spaces.
    for line in output.lines().map(str::trim) {
        if line.is_empty() {
            continue;
        }
        let Some((pid, command)) = line.split_once(char::is_whitespace) else {
            unreadable.push(line.to_string());
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else {
            unreadable.push(line.to_string());
            continue;
        };
        let Some(kind) = ["WebContent", "GPU", "Networking"]
            .iter()
            .find(|kind| command.contains(&format!("com.apple.WebKit.{kind}")))
        else {
            continue;
        };
        found.push((pid, kind.to_string()));
    }
    (found, unreadable)
}

/// Whether the process pid is alive. It asks ps (no signal is used). When ps fails, it records the failure and answers
/// that the process does not exist.
fn exists(pid: u32) -> bool {
    match ps_query(&["-o", "pid=", "-p", &pid.to_string()]) {
        Ok(output) => !output.trim().is_empty(),
        Err(error) => {
            ps_failed(error);
            false
        }
    }
}

/// The start time of the process pid. It is an empty string when the process does not exist: an empty string equals no
/// lstart of the record, so the decision does not kill that entry (when it is ambiguous, it does not kill). When ps
/// fails, it records the failure and returns an empty string.
fn start_time(pid: u32) -> String {
    match ps_query(&["-o", "lstart=", "-p", &pid.to_string()]) {
        Ok(output) => output.trim().to_string(),
        Err(error) => {
            ps_failed(error);
            String::new()
        }
    }
}

/// The command line of the process pid. It is an empty string when the process does not exist: the sibling instance
/// decision cannot find the `soksak` text and is false, and the harvest continues. When ps fails, it records the
/// failure and returns an empty string.
fn command(pid: u32) -> String {
    match ps_query(&["-o", "command=", "-p", &pid.to_string()]) {
        Ok(output) => output.trim().to_string(),
        Err(error) => {
            ps_failed(error);
            String::new()
        }
    }
}

/// Takes the WebKit XPC processes at the start as the baseline. It is valid only once, before this run creates a WebKit
/// (later calls do nothing). A process in the baseline belongs to someone else.
pub fn snapshot_baseline() {
    BASELINE.get_or_init(|| webkit_processes().into_iter().map(|(pid, _)| pid).collect());
}

/// Records the WebKit children of this run. It is called at every page load: when WebKit replaces a dead child, the
/// page loads again, so the record follows the replacement. It writes only when the set of children changed (an atomic
/// replacement).
pub fn refresh(config: &Path) {
    let Some(baseline) = BASELINE.get() else {
        return;
    };
    let current: Vec<(u32, String)> = webkit_processes()
        .into_iter()
        .filter(|(pid, _)| !baseline.contains(pid))
        .collect();
    let record = Record {
        host_pid: std::process::id(),
        children: current
            .iter()
            .map(|(pid, kind)| Child {
                pid: *pid,
                kind: kind.clone(),
                lstart: start_time(*pid),
            })
            .collect(),
    };
    let target = record_path(config);
    // It does not write again when the content is the same.
    if let Ok(previous) = std::fs::read(&target) {
        if let Ok(previous_record) = serde_json::from_slice::<Record>(&previous) {
            if previous_record
                .children
                .iter()
                .map(|c| c.pid)
                .collect::<Vec<_>>()
                == record.children.iter().map(|c| c.pid).collect::<Vec<_>>()
            {
                return;
            }
        }
    }
    match serde_json::to_vec_pretty(&record)
        .map_err(|e| e.to_string())
        .and_then(|bytes| write_record(&target, &bytes))
    {
        Ok(()) => {}
        Err(error) => crate::application_log::log_error("webkit children record", error),
    }
}

/// Runs record writes one at a time. If two writes use the same .new file, the write that renames first takes the file
/// of the other, and the rename of the other fails (F68).
static RECORD_WRITES: Mutex<()> = Mutex::new(());

/// Replaces the record file target with bytes atomically. It writes the .new file next to it and renames it.
pub fn write_record(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let _turn = RECORD_WRITES
        .lock()
        .map_err(|_| "webkit children record writes: a writer panicked".to_string())?;
    let temporary: PathBuf = target.with_extension("json.new");
    crate::platform::current()?
        .write_private_file(&temporary, bytes)
        .map_err(|e| format!("write: {e}"))?;
    std::fs::rename(&temporary, target).map_err(|e| format!("rename: {e}"))
}

fn record_path(config: &Path) -> PathBuf {
    config.join(RECORD)
}

/// Harvests the WebKit children that the previous run recorded. Call it once before this run creates a WebKit. If any
/// condition to kill does not hold, the entry is not touched.
pub fn reap_recorded(config: &Path) {
    let Ok(bytes) = std::fs::read(record_path(config)) else {
        return; // There is no record, so there is nothing to harvest.
    };
    let record: Record = match serde_json::from_slice(&bytes) {
        Ok(record) => record,
        Err(error) => {
            crate::application_log::log_error(
                "webkit children record",
                format!("the record is invalid: {error}"),
            );
            return;
        }
    };
    if record.host_pid == std::process::id() {
        return; // The record is ours: the page load of this run writes it again.
    }
    if exists(record.host_pid) && command(record.host_pid).contains("soksak") {
        // The child of a live sibling instance.
        crate::application_log::log_info(
            "webkit children",
            format!(
                "host {} still owns its recorded children; not reaping",
                record.host_pid
            ),
        );
        return;
    }
    let now = webkit_processes();
    for child in &record.children {
        let decision = reap_decision(
            exists(child.pid),
            now.iter().any(|(pid, _)| *pid == child.pid),
            start_time(child.pid) == child.lstart,
        );
        match decision {
            Ok(()) => match std::process::Command::new("kill")
                .args(["-9", &child.pid.to_string()])
                .output()
                .map_err(|error| error.to_string())
                .and_then(|output| {
                    if output.status.success() {
                        Ok(())
                    } else {
                        Err(format!(
                            "{}: {}",
                            output.status,
                            String::from_utf8_lossy(&output.stderr).trim()
                        ))
                    }
                }) {
                Ok(()) => crate::application_log::log_info(
                    "webkit children",
                    format!(
                        "reaped orphaned {} pid {} left by host {}",
                        child.kind, child.pid, record.host_pid
                    ),
                ),
                Err(error) => crate::application_log::log_error(
                    "webkit children",
                    format!("kill {}: {error}", child.pid),
                ),
            },
            Err(reason) => crate::application_log::log_info(
                "webkit children",
                format!("pid {}: {}", child.pid, reason),
            ),
        }
    }
}

/// The harvest decision for one recorded child. It returns Ok when it can be killed, and otherwise the reason. The
/// caller obtains the observations of the three conditions: the decision itself is pure, so the contract check handles
/// it mechanically.
pub fn reap_decision(alive: bool, is_webkit: bool, same_start: bool) -> Result<(), &'static str> {
    if !alive {
        return Err("already dead; nothing to reap");
    }
    if !is_webkit {
        return Err("no longer a WebKit process (recycled?); not killing");
    }
    if !same_start {
        return Err("start time differs from the record; not killing");
    }
    Ok(())
}
