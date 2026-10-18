use std::path::PathBuf;

use super::super::{Connection, Platform};
use super::Darwin;

unsafe extern "C" {
    /// The public libSystem function that reads a system clock in nanoseconds; it returns 0 and sets `errno` when the clock cannot be read. The `libc`
    /// crate does not declare it.
    fn clock_gettime_nsec_np(clock_id: libc::clockid_t) -> u64;
}

impl Platform for Darwin {
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
        Darwin::connect(address)
    }

    fn on_interrupt(&self, interrupted: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        Darwin::on_interrupt(interrupted)
    }

    fn config_dir(&self) -> Result<PathBuf, String> {
        Darwin::config_dir()
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

    /// Creates the index file with the mode 0600 when it does not exist.
    fn open_index(&self, path: &std::path::Path) -> Result<std::fs::File, String> {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .map_err(|error| crate::files::file_error(path.display(), &error))
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

    /// Reads `CLOCK_UPTIME_RAW`, which is `mach_absolute_time` in nanoseconds: the clock of `sp_mono_ns`.
    fn monotonic_nanos(&self) -> Result<u64, String> {
        // SAFETY: clock_gettime_nsec_np only reads a system clock and touches no memory of the caller.
        match unsafe { clock_gettime_nsec_np(libc::CLOCK_UPTIME_RAW) } {
            0 => Err(format!(
                "the monotonic clock cannot be read: {}",
                std::io::Error::last_os_error()
            )),
            nanos => Ok(nanos),
        }
    }

    /// For each file in this folder, the shell adds its line to PATH.
    fn paths_dir(&self) -> Result<PathBuf, String> {
        Ok(PathBuf::from("/etc/paths.d"))
    }

    /// Extracts the zip with ditto, which keeps the modes and the signature of the bundle.
    fn extract_bundle(
        &self,
        zip: &std::path::Path,
        folder: &std::path::Path,
    ) -> Result<(), String> {
        let output = std::process::Command::new("ditto")
            .args(["-x", "-k"])
            .arg(zip)
            .arg(folder)
            .output()
            .map_err(|error| format!("ditto: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "ditto: {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }

    /// Waits with the kernel notification of the end of a process, so no timer asks whether it ended.
    fn wait_process_end(&self, pid: i32, timeout: std::time::Duration) -> Result<bool, String> {
        if pid <= 0 {
            return Ok(true);
        }
        let failed = |error: std::io::Error| format!("cannot wait for process {pid}: {error}");
        // SAFETY: kqueue takes no arguments and returns a descriptor that this function closes.
        let queue = unsafe { libc::kqueue() };
        if queue < 0 {
            return Err(failed(std::io::Error::last_os_error()));
        }
        let change = libc::kevent {
            ident: pid as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let limit = libc::timespec {
            tv_sec: timeout.as_secs() as libc::time_t,
            tv_nsec: timeout.subsec_nanos() as libc::c_long,
        };
        // SAFETY: an all-zero kevent is a valid value that kevent overwrites.
        let mut event: libc::kevent = unsafe { std::mem::zeroed() };
        let result = loop {
            // SAFETY: the change and the event are live values and the counts are 1.
            let count = unsafe { libc::kevent(queue, &change, 1, &mut event, 1, &limit) };
            if count < 0 {
                let error = std::io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(libc::EINTR) => continue,
                    Some(libc::ESRCH) => break Ok(true),
                    _ => break Err(failed(error)),
                }
            }
            if count == 0 {
                break Ok(false);
            }
            if event.flags & libc::EV_ERROR != 0 {
                let code = event.data as i32;
                break if code == libc::ESRCH {
                    Ok(true)
                } else {
                    Err(failed(std::io::Error::from_raw_os_error(code)))
                };
            }
            break Ok(true);
        };
        // SAFETY: queue is the descriptor that kqueue returned above.
        if unsafe { libc::close(queue) } < 0 {
            return Err(failed(std::io::Error::last_os_error()));
        }
        result
    }

    /// Copies with ditto, which keeps the modes and the signature of the bundle.
    fn copy_bundle(
        &self,
        source: &std::path::Path,
        destination: &std::path::Path,
    ) -> Result<(), String> {
        let output = std::process::Command::new("ditto")
            .arg(source)
            .arg(destination)
            .output()
            .map_err(|error| format!("ditto: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "ditto: {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }

    /// Starts a new instance with open -n; open -g keeps the new instance in the background.
    fn open_application(
        &self,
        bundle: &std::path::Path,
        arguments: &[String],
        activate: bool,
    ) -> Result<(), String> {
        let mut command = std::process::Command::new("open");
        if !activate {
            command.arg("-g");
        }
        command.arg("-n").arg(bundle);
        if !arguments.is_empty() {
            command.arg("--args").args(arguments);
        }
        let output = command.output().map_err(|error| format!("open: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "open: {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }

    /// Reads CFBundleShortVersionString of the Info.plist of the bundle.
    fn bundle_version(&self, bundle: &std::path::Path) -> Result<String, String> {
        let output = std::process::Command::new("plutil")
            .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
            .arg(bundle.join("Contents/Info.plist"))
            .output()
            .map_err(|error| format!("plutil: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "the version of {} cannot be read: {}",
                bundle.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn key(&self) -> Result<String, String> {
        match std::env::consts::ARCH {
            "aarch64" => Ok("darwin-arm64".into()),
            "x86_64" => Ok("darwin-x64".into()),
            other => Err(format!("darwin/{other} has no platform key")),
        }
    }
}
