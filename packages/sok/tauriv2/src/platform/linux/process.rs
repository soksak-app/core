use std::path::PathBuf;

use super::super::{Connection, Platform};
use super::Linux;

impl Platform for Linux {
    /// Checks with signal 0 whether the process exists. A process of another user (EPERM) is running too.
    fn process_running(&self, pid: i32) -> Result<(), String> {
        // SAFETY: kill sends signal 0 only to check that the process exists and does not touch memory.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EPERM) {
            return Ok(());
        }
        Err(format!("process {pid} is not running: {error}"))
    }

    fn connect(&self, address: &str) -> Result<Box<dyn Connection>, String> {
        Linux::connect(address)
    }

    fn on_interrupt(&self, interrupted: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        Linux::on_interrupt(interrupted)
    }

    fn config_dir(&self) -> Result<PathBuf, String> {
        Linux::config_dir()
    }

    fn executable(&self, metadata: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    fn set_executable(&self, path: &std::path::Path, executable: bool) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        let mode = if executable { 0o755 } else { 0o644 };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|error| crate::files::file_error(path.display(), &error))
    }

    fn close_file(&self, file: std::fs::File, path: &std::path::Path) -> Result<(), String> {
        use std::os::unix::io::IntoRawFd;
        let fd = file.into_raw_fd();
        if unsafe { libc::close(fd) } == 0 {
            Ok(())
        } else {
            let error = std::io::Error::last_os_error();
            Err(crate::files::file_error(path.display(), &error))
        }
    }

    /// Takes `flock(LOCK_EX)` on the file, which excludes the other open files of the same file in every process.
    fn lock_file(&self, file: &std::fs::File) -> Result<(), String> {
        use std::os::unix::io::AsRawFd;
        // SAFETY: flock only reads the descriptor of the open file.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
            Ok(())
        } else {
            Err(format!(
                "the file cannot be locked: {}",
                std::io::Error::last_os_error()
            ))
        }
    }

    fn same_file(&self, file: &std::fs::File, path: &std::path::Path) -> Result<bool, String> {
        use std::os::unix::fs::MetadataExt;
        let opened = file
            .metadata()
            .map_err(|error| crate::files::file_error(path.display(), &error))?;
        match std::fs::metadata(path) {
            Ok(named) => Ok(opened.dev() == named.dev() && opened.ino() == named.ino()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(crate::files::file_error(path.display(), &error)),
        }
    }

    /// Reads `CLOCK_MONOTONIC`.
    fn monotonic_nanos(&self) -> Result<u64, String> {
        let mut now = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: clock_gettime writes only the timespec that is passed.
        if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) } != 0 {
            return Err(format!(
                "the monotonic clock cannot be read: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(now.tv_sec as u64 * 1_000_000_000 + now.tv_nsec as u64)
    }

    /// The shell on Linux has no folder that adds a PATH entry for each file.
    fn paths_dir(&self) -> Result<PathBuf, String> {
        Err("path entries are not implemented on linux".into())
    }

    fn extract_bundle(
        &self,
        _zip: &std::path::Path,
        _folder: &std::path::Path,
    ) -> Result<(), String> {
        Err("application bundles are not implemented on linux".into())
    }

    fn wait_process_end(&self, _pid: i32, _timeout: std::time::Duration) -> Result<bool, String> {
        Err("waiting for a process end is not implemented on linux".into())
    }

    fn copy_bundle(
        &self,
        _source: &std::path::Path,
        _destination: &std::path::Path,
    ) -> Result<(), String> {
        Err("application bundles are not implemented on linux".into())
    }

    fn open_application(
        &self,
        _bundle: &std::path::Path,
        _arguments: &[String],
    ) -> Result<(), String> {
        Err("application bundles are not implemented on linux".into())
    }

    fn bundle_version(&self, _bundle: &std::path::Path) -> Result<String, String> {
        Err("application bundles are not implemented on linux".into())
    }

    fn key(&self) -> Result<String, String> {
        match std::env::consts::ARCH {
            "aarch64" => Ok("linux-arm64".into()),
            "x86_64" => Ok("linux-x64".into()),
            other => Err(format!("linux/{other} has no platform key")),
        }
    }
}
