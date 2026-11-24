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

    fn on_interrupt(
        &self,
        interrupted: Box<dyn FnOnce(&'static str) + Send>,
    ) -> Result<(), String> {
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

    fn prepare_log_directory(&self, path: &std::path::Path) -> Result<(), String> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(|error| crate::files::file_error(path.display(), &error))?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| crate::files::file_error(path.display(), &error))
    }

    fn create_log_file(&self, path: &std::path::Path) -> Result<std::fs::File, String> {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .create_new(true)
            .append(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| crate::files::file_error(path.display(), &error))
    }

    fn append_log_file(&self, path: &std::path::Path) -> Result<std::fs::File, String> {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| crate::files::file_error(path.display(), &error))
    }

    fn open_process_lock_file(&self, path: &std::path::Path) -> Result<std::fs::File, String> {
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

    /// The login shells of macOS read the startup files that the user PATH registration edits.
    fn user_path(&self) -> Result<(), String> {
        Ok(())
    }

    fn user_path_state(
        &self,
        environment: &crate::setup::Environment,
    ) -> Result<crate::setup::Part, String> {
        super::user_path::state(environment)
    }

    fn configure_user_path(
        &self,
        environment: &crate::setup::Environment,
        shell: &str,
        executable: &std::path::Path,
        enabled: Option<bool>,
    ) -> Result<bool, String> {
        super::user_path::configure(environment, shell, executable, enabled)
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
    /// Reads the process from proc_pidinfo PROC_PIDTBSDINFO. A pid that the table does not describe has ended or belongs to
    /// another user, a zombie has ended, a process of another user did not publish the endpoint, and a process that started
    /// later than `published` received the pid after the publisher ended.
    fn service_process_exists(
        &self,
        pid: u32,
        published: std::time::SystemTime,
    ) -> Result<bool, String> {
        if pid == 0 || pid > i32::MAX as u32 {
            return Ok(false);
        }
        // SAFETY: proc_bsdinfo is plain data, which zeroes describe.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: proc_pidinfo writes at most size bytes into info.
        let written = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                (&raw mut info).cast(),
                size,
            )
        };
        if written <= 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ESRCH | libc::EPERM) => Ok(false),
                Some(code) => Err(format!(
                    "cannot inspect service process {pid}: errno {code}"
                )),
                None => Err(format!("cannot inspect service process {pid}: {error}")),
            };
        }
        if written != size {
            return Err(format!(
                "cannot inspect service process {pid}: the table answered {written} of {size} bytes"
            ));
        }
        let started = std::time::UNIX_EPOCH
            + std::time::Duration::new(info.pbi_start_tvsec, info.pbi_start_tvusec as u32 * 1000);
        // SAFETY: geteuid reads the effective user of this process.
        let owned = info.pbi_uid == unsafe { libc::geteuid() };
        Ok(owned && info.pbi_status != libc::SZOMB && started <= published)
    }

    fn wait_process_end(&self, pid: i32) -> Result<(), String> {
        if pid <= 0 {
            return Ok(());
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
        // SAFETY: an all-zero kevent is a valid value that kevent overwrites.
        let mut event: libc::kevent = unsafe { std::mem::zeroed() };
        let result = loop {
            // SAFETY: the change and the event are live values and the counts are 1; a null timeout waits for the event.
            let count = unsafe { libc::kevent(queue, &change, 1, &mut event, 1, std::ptr::null()) };
            if count < 0 {
                let error = std::io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(libc::EINTR) => continue,
                    Some(libc::ESRCH) => break Ok(()),
                    _ => break Err(failed(error)),
                }
            }
            if event.flags & libc::EV_ERROR != 0 {
                let code = event.data as i32;
                break if code == libc::ESRCH {
                    Ok(())
                } else {
                    Err(failed(std::io::Error::from_raw_os_error(code)))
                };
            }
            break Ok(());
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

    /// Reads the mount flags of the file system with statvfs.
    fn read_only_volume(&self, path: &std::path::Path) -> Result<bool, String> {
        let status = rustix::fs::statvfs(path).map_err(|error| {
            crate::files::file_error(path.display(), &std::io::Error::from(error))
        })?;
        Ok(status
            .f_flag
            .contains(rustix::fs::StatVfsMountFlags::RDONLY))
    }

    fn registrable_sok(&self, sok: &std::path::Path) -> Result<bool, String> {
        let name = |path: Option<&std::path::Path>| {
            path.and_then(std::path::Path::file_name)
                .map(|name| name.to_string_lossy().into_owned())
        };
        let macos = sok.parent();
        let contents = macos.and_then(std::path::Path::parent);
        let bundle = contents.and_then(std::path::Path::parent);
        Ok(name(macos).as_deref() == Some("MacOS")
            && name(contents).as_deref() == Some("Contents")
            && name(bundle).is_some_and(|name| name.ends_with(".app")))
    }

    fn exec(&self, program: &std::path::Path, arguments: &[String]) -> String {
        use std::os::unix::process::CommandExt;
        let error = std::process::Command::new(program).args(arguments).exec();
        format!(
            "exec {}: {}",
            program.display(),
            crate::files::os_reason(&error)
        )
    }
}
