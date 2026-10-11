//! The retention of the event files (docs/spec/logging.md#retention). The files of the runs in logs/ stay within a stated bound. When
//! they pass it, the oldest runs are removed whole, one run after another, until the files are within the bound or only the run of
//! the writer and the pinned runs are left. A run whose name has a `.keep` file beside it is pinned and never removed. Every removal
//! is the event `log.pruned`, so no file disappears without a record.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};

/// The bound of the files of the runs in logs/: 6 GiB.
pub const HOST_RETENTION_BYTES: u64 = 6 << 30;

/// The files of one run.
struct RunFiles {
    name: String,
    files: Vec<(PathBuf, u64)>,
    total: u64,
    newest: SystemTime,
    pinned: bool,
}

/// What a retention pass removed.
#[derive(Debug, Default)]
pub struct PrunedRuns {
    pub files: u64,
    pub bytes: u64,
    pub runs: Vec<String>,
    pub from_us: i64,
    pub to_us: i64,
    pub remaining: u64,
}

impl PrunedRuns {
    /// The fields of the event `log.pruned`.
    pub fn fields(&self, bound: u64) -> Value {
        json!({"logs": self.files, "bytes": self.bytes, "runs": self.runs, "from_us": self.from_us, "to_us": self.to_us, "remaining": self.remaining, "bound": bound})
    }
}

/// The run that a file belongs to: `<role>-<boot>` before the first dot, when the rest of the name is an event file (`.jsonl`,
/// `.debug.jsonl`, a generation `.<n>`, an index `.idx`), the standard error, the crash output or the pin `.keep`.
fn run_of(name: &str) -> Option<&str> {
    let (run, rest) = name.split_once('.')?;
    let (role, boot) = run.split_once('-')?;
    let mut role_chars = role.chars();
    let valid_role = role_chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && role_chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let valid_boot = !boot.is_empty()
        && boot
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid_role || !valid_boot {
        return None;
    }
    match rest {
        "stderr" | "crash" | "keep" => return Some(run),
        _ => {}
    }
    // default: a name without the suffix or the prefix keeps its text, and the check of the generation judges the rest.
    let rest = rest.strip_suffix(".idx").unwrap_or(rest);
    // default: a name without the prefix keeps its text, and the check of the generation judges the rest.
    let rest = rest.strip_prefix("debug.").unwrap_or(rest);
    let event_file = match rest.strip_prefix("jsonl") {
        Some("") => true,
        Some(generation) => is_generation(generation),
        None => false,
    };
    event_file.then_some(run)
}

/// `.<n>` with n a positive number without a leading zero.
fn is_generation(text: &str) -> bool {
    text.strip_prefix('.').is_some_and(|number| {
        !number.is_empty() && number.bytes().all(|c| c.is_ascii_digit()) && !number.starts_with('0')
    })
}

/// Whether the name is the name of an event file of a run: the file, its debug file and their generations.
fn is_event_file(name: &str) -> bool {
    run_of(name).is_some()
        && !name.ends_with(".idx")
        && !name.ends_with(".stderr")
        && !name.ends_with(".crash")
        && !name.ends_with(".keep")
}

/// Removes the oldest runs in `directory` while the files of the runs pass `bound`. The run `current` and the pinned runs stay. The
/// age of a run is the newest modification time of its files. A failure of a removal or of a read is returned with the others, and the
/// pass goes on with the next file.
pub fn prune_runs(
    directory: &Path,
    current: &str,
    bound: u64,
) -> Result<PrunedRuns, (PrunedRuns, Vec<String>)> {
    let entries = std::fs::read_dir(directory).map_err(|error| {
        (
            PrunedRuns::default(),
            vec![format!("{}: {error}", directory.display())],
        )
    })?;
    let mut runs: std::collections::BTreeMap<String, RunFiles> = Default::default();
    let mut failures = Vec::new();
    let mut total = 0;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                failures.push(error.to_string());
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(run_name) = run_of(&name) else {
            continue;
        };
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => continue,
            Err(error) => {
                failures.push(format!("{}: {error}", entry.path().display()));
                continue;
            }
        };
        let run = runs
            .entry(run_name.to_string())
            .or_insert_with(|| RunFiles {
                name: run_name.to_string(),
                files: Vec::new(),
                total: 0,
                newest: SystemTime::UNIX_EPOCH,
                pinned: false,
            });
        run.files.push((entry.path(), metadata.len()));
        run.total += metadata.len();
        total += metadata.len();
        match metadata.modified() {
            Ok(modified) if modified > run.newest => run.newest = modified,
            Ok(_) => {}
            Err(error) => failures.push(format!("{}: {error}", entry.path().display())),
        }
        if name.ends_with(".keep") {
            run.pinned = true;
        }
    }
    let mut result = PrunedRuns {
        remaining: total,
        ..PrunedRuns::default()
    };
    if total <= bound {
        return if failures.is_empty() {
            Ok(result)
        } else {
            Err((result, failures))
        };
    }
    let mut candidates: Vec<&RunFiles> = runs
        .values()
        .filter(|run| run.name != current && !run.pinned)
        .collect();
    candidates.sort_by(|a, b| a.newest.cmp(&b.newest).then_with(|| a.name.cmp(&b.name)));
    for run in candidates {
        if result.remaining <= bound {
            break;
        }
        for (path, size) in &run.files {
            // default: a path without a text file name is no event file, and the empty name matches no file of a run.
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                // default: a path without a text file name is no event file, and the empty name matches no file of a run.
                .unwrap_or("");
            if is_event_file(name) {
                match event_time_range(path) {
                    Ok(Some((from, to))) => {
                        if result.from_us == 0 || from < result.from_us {
                            result.from_us = from;
                        }
                        result.to_us = result.to_us.max(to);
                    }
                    Ok(None) => {}
                    Err(error) => failures.push(error),
                }
            }
            if let Err(error) = std::fs::remove_file(path) {
                failures.push(format!("{}: {error}", path.display()));
                continue;
            }
            result.files += 1;
            result.bytes += size;
            result.remaining -= size;
        }
        result.runs.push(run.name.clone());
    }
    if failures.is_empty() {
        Ok(result)
    } else {
        Err((result, failures))
    }
}

/// The `ts_us` of one line of an event file.
fn time_of(path: &Path, line: &str) -> Result<i64, String> {
    serde_json::from_str::<Value>(line.trim())
        // silent: a line that is not JSON has no time, and the error below names the file and the line.
        .ok()
        .and_then(|event| event["ts_us"].as_i64())
        .filter(|ts| *ts > 0)
        .ok_or_else(|| {
            let shown: String = line.trim().chars().take(80).collect();
            format!("{}: a line with no ts_us in {shown:?}", path.display())
        })
}

/// The `ts_us` of the first and of the last line of an event file; `None` for an empty file, an error for a line that is no event.
fn event_time_range(path: &Path) -> Result<Option<(i64, i64)>, String> {
    let fail = |error: std::io::Error| format!("{}: {error}", path.display());
    let mut file = std::fs::File::open(path).map_err(fail)?;
    let size = file.metadata().map_err(fail)?.len();
    if size == 0 {
        return Ok(None);
    }
    let mut head = vec![0u8; size.min(64 << 10) as usize];
    file.read_exact(&mut head).map_err(fail)?;
    let head = String::from_utf8_lossy(&head);
    // default: a text with no first line is empty, and the check of the time refuses it with an error that names the file.
    let first = head.split('\n').next().unwrap_or("");
    let from = time_of(path, first)?;
    // The last line lies in the last 64 KiB of a file whose lines are far smaller than that, except an event cut at its bound.
    let length = size.min(64 << 10);
    file.seek(SeekFrom::Start(size - length)).map_err(fail)?;
    let mut tail = vec![0u8; length as usize];
    file.read_exact(&mut tail).map_err(fail)?;
    let tail = String::from_utf8_lossy(&tail);
    let tail = tail.trim_end_matches('\n');
    // default: a text with no last line is empty, and the check of the time refuses it with an error that names the file.
    let last = tail.rsplit('\n').next().unwrap_or("");
    Ok(Some((from, time_of(path, last)?)))
}
