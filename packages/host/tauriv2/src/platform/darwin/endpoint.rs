//! The Unix domain socket of the local endpoint.
//!
//! The socket is placed in a directory that the caller decides (the application uses `soksak/` under the temporary
//! directory of the user). The path of the configuration directory can exceed the length limit of a socket path (104
//! bytes). The directory is accessible only to the current user, and a directory with other permissions or another
//! owner is not opened.

use std::fs;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::super::{Connection, Listener};

extern "C" {
    fn geteuid() -> u32;
    fn kill(pid: i32, signal: i32) -> i32;
    fn setsid() -> i32;
}

/// The error number that `kill` reports when no process has the number.
const ESRCH: i32 = 3;
/// The error number that `kill` reports when it refuses to signal a process of another user.
const EPERM: i32 = 1;

/// Checks whether the process of the persistent service endpoint still exists.
///
/// Only a process that can receive a signal exists. A spawn that was not awaited remains as a zombie and passes
/// kill(pid, 0) (V5-106), so the state of a process that passed is read to tell zombies apart: a zombie has already
/// ended and its endpoint is old. A refusal (EPERM) for a process of another user means that the process exists.
pub fn service_process_exists(pid: u32) -> Result<bool, String> {
    if pid == 0 {
        return Ok(false);
    }
    let result = unsafe { kill(pid as i32, 0) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(ESRCH) => return Ok(false),
            Some(EPERM) => {}
            _ => return Err(format!("cannot inspect service process {pid}: {error}")),
        }
    }
    let output = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .map_err(|e| format!("cannot inspect service process {pid} state: {e}"))?;
    let state = String::from_utf8_lossy(&output.stdout);
    if !state.trim_start().starts_with('Z') {
        return Ok(true);
    }
    Ok(false)
}

/// Waits for the end of the service process `pid` with the kqueue notification NOTE_EXIT, for at most `timeout`. A
/// process that does not exist has ended; the registration for it fails with ESRCH.
pub fn wait_service_process_end(pid: u32, timeout: std::time::Duration) -> Result<bool, String> {
    if pid == 0 {
        return Ok(true);
    }
    let failed = |error: std::io::Error| format!("cannot wait for service process {pid}: {error}");
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
    let mut event: libc::kevent = unsafe { std::mem::zeroed() };
    let result = loop {
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
    unsafe { libc::close(queue) };
    result
}

/// Writes the wait status of an ended process as `exit status <code>` or `signal <number>`.
pub fn exit_status(status: std::process::ExitStatus) -> Result<String, String> {
    use std::os::unix::process::ExitStatusExt;
    if let Some(signal) = status.signal() {
        return Ok(format!("signal {signal}"));
    }
    match status.code() {
        Some(code) => Ok(format!("exit status {code}")),
        None => Err(format!(
            "wait status {:#x} has neither an exit code nor a signal",
            status.into_raw()
        )),
    }
}

/// Makes command the leader of a new session with setsid.
pub fn new_session(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    // The function of pre_exec runs in the child between fork and exec, so only setsid, which is async-signal-safe, is
    // called. If it fails, spawn returns that error.
    unsafe {
        command.pre_exec(|| {
            if setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Returns whether the process with the number pid has ended.
fn ended(pid: i32) -> bool {
    let result = unsafe { kill(pid, 0) };
    result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(ESRCH)
}

/// Removes the socket of the name name that an ended process left in directory. A process that was terminated by force
/// cannot delete its own socket. When a process with the number exists, the socket is kept even if it is another
/// program.
fn remove_ended(directory: &Path, name: &str) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|e| format!("{}: {e}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", directory.display()))?;
        let file = entry.file_name();
        let Some(pid) = file.to_str().and_then(|file| {
            file.strip_prefix(name)?
                .strip_prefix('-')?
                .strip_suffix(".sock")?
                .parse::<i32>()
                // default: a file name without a process number is no socket of this name, so the sweep leaves it.
                .ok()
        }) else {
            continue;
        };
        if pid <= 0 || !ended(pid) {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", entry.path().display())),
        }
    }
    Ok(())
}

/// Creates path as a directory that only the current user can access. When it already exists, the owner and the
/// permissions are checked.
pub fn private_directory(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    if metadata.uid() != unsafe { geteuid() } {
        return Err(format!("{} belongs to another user", path.display()));
    }
    if metadata.mode() & 0o777 != 0o700 {
        return Err(format!(
            "{} has mode {:o}, want 700",
            path.display(),
            metadata.mode() & 0o777
        ));
    }
    Ok(())
}

struct Socket {
    listener: UnixListener,
    path: PathBuf,
}

impl Listener for Socket {
    fn accept(&self) -> Result<Box<dyn Connection>, String> {
        let (stream, _) = self.listener.accept().map_err(|e| e.to_string())?;
        Ok(Box::new(Stream(stream)))
    }

    fn transport(&self) -> &'static str {
        "unix"
    }

    fn address(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    fn remove(&self) {
        if let Err(error) = fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                crate::application_log::log_error(&self.path.display().to_string(), error);
            }
        }
    }
}

struct Stream(UnixStream);

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

impl Connection for Stream {
    fn try_clone(&self) -> Result<Box<dyn Connection>, String> {
        Ok(Box::new(Stream(
            self.0.try_clone().map_err(|e| e.to_string())?,
        )))
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> Result<(), String> {
        self.0.set_read_timeout(timeout).map_err(|e| e.to_string())
    }

    fn close(&self) -> Result<(), String> {
        match self.0.shutdown(Shutdown::Both) {
            // A connection that the peer closed first or that was already closed is in the closed state, so it is not a
            // failure.
            Err(error) if error.kind() == std::io::ErrorKind::NotConnected => Ok(()),
            result => result.map_err(|error| error.to_string()),
        }
    }
}

/// Opens the socket `<directory>/<name>-<pid>.sock`. First it removes the socket of an ended process and the socket
/// file of the same path that an ended process with the same number left.
pub fn listen(directory: &Path, name: &str) -> Result<Box<dyn Listener>, String> {
    private_directory(directory)?;
    remove_ended(directory, name)?;
    let path = directory.join(format!("{name}-{}.sock", std::process::id()));
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    let listener = UnixListener::bind(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Box::new(Socket { listener, path }))
}

/// Connects to the socket path address.
pub fn connect(address: &str) -> Result<Box<dyn Connection>, String> {
    let stream = UnixStream::connect(address).map_err(|e| format!("{address}: {e}"))?;
    Ok(Box::new(Stream(stream)))
}
