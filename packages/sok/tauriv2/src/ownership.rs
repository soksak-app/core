//! The ownership of the configuration directory for the duration of a write of a command: the file `process.lock` is
//! created exclusively with the owner of this process in the form of the host, a lock of a live process refuses with the
//! error the hosts use, a lock of an ended process is removed and retried once, and a lock in another form refuses with its
//! content (docs/spec/endpoint.md#discovery, docs/spec/installation.md).

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::platform;

/// The owner that process.lock holds: the process identifier and the boot identifier of the run, in the form that the host
/// writes (docs/spec/endpoint.md#discovery). Another member, or a missing one, is not the form.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LockOwner {
    pid: i32,
    boot: String,
}

/// The number of bytes of a lock content that a refusal reports.
const LOCK_REPORT_BYTES: usize = 256;

/// The owner of a lock content, or None when the content is not the form.
fn parse_lock_owner(contents: &[u8]) -> Option<LockOwner> {
    // default: contents that do not parse are not the current form, and the callers report them with the content.
    let owner: LockOwner = serde_json::from_slice(contents).ok()?;
    (owner.pid > 0 && !owner.boot.is_empty()).then_some(owner)
}

/// The first bytes of a lock content for a report, with an invalid sequence replaced.
fn reported_content(contents: &[u8]) -> String {
    String::from_utf8_lossy(&contents[..contents.len().min(LOCK_REPORT_BYTES)]).into_owned()
}

/// Acquires the process lock and returns the release that removes it. The caller owns the configuration directory for
/// the duration of its write.
pub(crate) fn own_configuration(config_dir: &Path) -> Result<Box<dyn FnOnce() + 'static>, String> {
    fs::create_dir_all(config_dir)
        .map_err(|error| format!("configuration directory {}: {error}", config_dir.display()))?;
    let path = config_dir.join("process.lock");
    for attempt in 0..2 {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut file) => {
                // The boot identifier of a sok run is the one of its event file: the start time in seconds and the process identifier.
                let pid = std::process::id();
                let seconds = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |since| since.as_secs());
                let owner = LockOwner {
                    pid: pid as i32,
                    boot: format!("{seconds}-{pid}"),
                };
                let text = serde_json::to_string(&owner)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                if let Err(error) = file.write_all(text.as_bytes()) {
                    // A lock whose pid cannot be written is removed, so no later command reads a partial owner.
                    if let Err(remove_error) = fs::remove_file(&path) {
                        eprintln!(
                            "sok: {}: remove after a failed write: {remove_error}",
                            path.display()
                        );
                    }
                    return Err(format!("{}: {error}", path.display()));
                }
                if let Err(error) = file.sync_all() {
                    if let Err(remove_error) = fs::remove_file(&path) {
                        eprintln!(
                            "sok: {}: remove after a failed sync: {remove_error}",
                            path.display()
                        );
                    }
                    return Err(format!("{}: {error}", path.display()));
                }
                let path = path.clone();
                let dir = config_dir.display().to_string();
                return Ok(Box::new(move || {
                    if let Err(error) = fs::remove_file(&path) {
                        // A lock that another command already removed is gone; every other failure is named.
                        if error.kind() != std::io::ErrorKind::NotFound {
                            eprintln!("sok: configuration directory {dir}: release: {error}");
                        }
                    }
                }));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                let contents =
                    fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
                let Some(owner) = parse_lock_owner(&contents) else {
                    // A lock of another form is refused and kept: its owner is unknown, so it is not removed.
                    return Err(format!(
                        "{}: process.lock is not the current form: {}",
                        path.display(),
                        reported_content(&contents)
                    ));
                };
                let pid = owner.pid;
                let running = platform::current()?.process_running(pid).is_ok();
                if running {
                    return Err(format!(
                        "configuration directory {} is already owned by process {pid}",
                        config_dir.display()
                    ));
                }
                fs::remove_file(&path).map_err(|error| format!("{}: {error}", path.display()))?;
            }
            Err(error) => return Err(format!("{}: {error}", path.display())),
        }
    }
    Err(format!("could not acquire process lock {}", path.display()))
}
