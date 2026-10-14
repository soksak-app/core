//! The ownership of the configuration directory for the duration of a write of a command: the file `process.lock` is
//! created exclusively with the pid of this process, a lock of a live process refuses with the error the hosts use, and
//! a lock of an ended process is removed and retried once (docs/spec/installation.md,
//! docs/spec/hosts.md#application-log).

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use crate::platform;

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
                if let Err(error) = write!(file, "{}", std::process::id()) {
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
                let contents = fs::read_to_string(&path)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                let pid: i32 = contents
                    .trim()
                    .parse()
                    .map_err(|_| format!("{}: invalid process lock", path.display()))?;
                if pid <= 0 {
                    return Err(format!("{}: invalid process lock", path.display()));
                }
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
