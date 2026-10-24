//! The ownership of the configuration directory for the duration of a write of a command. The lock is the advisory lock (flock)
//! on `process.lock`, the lock that the host takes; it is held until the release runs. A held lock refuses the command with the
//! owner's pid, and a free lock file is taken over and rewritten with the owner of this command. The release removes the file
//! while it still holds the lock, then unlocks (docs/spec/endpoint.md#discovery, docs/spec/installation.md).

use std::fs::{self, File, TryLockError};
use std::io::{Seek, SeekFrom, Write};
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

/// How many times the acquisition opens the lock file again after the file that it opened was replaced.
const LOCK_ATTEMPTS: usize = 8;

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

/// The refusal of a command beside a live owner, which holds the advisory lock: the owner's pid when the content is the current
/// form, and the content otherwise, as the hosts report it (docs/spec/endpoint.md#discovery).
fn held_refusal(config_dir: &Path, contents: &[u8]) -> String {
    if let Some(owner) = parse_lock_owner(contents) {
        return format!(
            "configuration directory {} is already owned by process {}",
            config_dir.display(),
            owner.pid
        );
    }
    if contents.iter().all(u8::is_ascii_whitespace) {
        return format!(
            "configuration directory {} is already owned by a live process",
            config_dir.display()
        );
    }
    format!(
        "configuration directory {} is already owned by a live process; process.lock is not the current form: {}",
        config_dir.display(),
        reported_content(contents)
    )
}

/// Acquires the process lock and returns the release that removes the file and then unlocks. The caller owns the configuration
/// directory for the duration of its write.
pub(crate) fn own_configuration(config_dir: &Path) -> Result<Box<dyn FnOnce() + 'static>, String> {
    fs::create_dir_all(config_dir)
        .map_err(|error| format!("configuration directory {}: {error}", config_dir.display()))?;
    let path = config_dir.join("process.lock");
    let system = platform::current()?;
    for _ in 0..LOCK_ATTEMPTS {
        let file: File = system.open_process_lock_file(&path)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                // The owner removes the file before it unlocks, so a file that is gone now was released.
                let contents = match fs::read(&path) {
                    Ok(contents) => contents,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(format!("{}: {error}", path.display())),
                };
                return Err(held_refusal(config_dir, &contents));
            }
            Err(TryLockError::Error(error)) => return Err(format!("{}: {error}", path.display())),
        }
        // The file at path was replaced after this open, so the lock is on a file that no longer names the lock.
        if !system.same_file(&file, &path)? {
            continue;
        }
        // The owner of this command is written in the form of the host. The boot identifier is the one of the event file of a sok
        // run: the start time in seconds and the process identifier.
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
        let mut writer = &file;
        writer
            .set_len(0)
            .and_then(|()| writer.seek(SeekFrom::Start(0)).map(|_| ()))
            .and_then(|()| writer.write_all(text.as_bytes()))
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let dir = config_dir.display().to_string();
        return Ok(Box::new(move || {
            if let Err(error) = fs::remove_file(&path) {
                // A lock that another command already removed is gone; every other failure is named.
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("sok: configuration directory {dir}: release: {error}");
                }
            }
            // Dropping the file closes it, which releases the advisory lock.
            drop(file);
        }));
    }
    Err(format!("could not acquire process lock {}", path.display()))
}
