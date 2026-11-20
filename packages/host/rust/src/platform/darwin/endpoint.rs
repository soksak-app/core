//! The Unix domain socket of the local endpoint.
//!
//! The socket is placed in a directory that the caller decides (the application uses `soksak/` under the temporary
//! directory of the user). The path of the configuration directory can exceed the length limit of a socket path (104
//! bytes). The directory is accessible only to the current user, and a directory with other permissions or another
//! owner is not opened.

use std::fs;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::super::{Connection, Listener};

unsafe extern "C" {
    fn geteuid() -> u32;
    fn kill(pid: i32, signal: i32) -> i32;
    fn setsid() -> i32;
}

/// The error number that `kill` reports when no process has the number.
const ESRCH: i32 = 3;
/// The length in bytes of a unix socket path. `sockaddr_un.sun_path` has 104 bytes on macOS (`sys/un.h`), and the last
/// of them is the terminating NUL.
const SOCKET_PATH_LIMIT: usize = 103;

/// Checks whether pid is the live process that published the persistent service endpoint whose modification time is
/// `published` (docs/spec/persistent-services.md#endpoint-publisher).
///
/// It reads the process from the process table of the kernel (`proc_pidinfo` with `PROC_PIDTBSDINFO`). A pid that the
/// table does not have has ended; a zombie has ended too, as a spawn that was not awaited stays one (V5-106); a process of
/// another user did not publish the endpoint, because the service runs as the user of the host, and the kernel refuses
/// (EPERM) to describe a process of another user to a host that root does not run; and a process that started later than
/// `published` received the pid after the publisher ended. It is an error when the table cannot be read.
/// The size of `struct kinfo_proc` of `sys/sysctl.h` and the offsets of `kp_proc.p_starttime` (a `struct timeval` of an
/// 8-byte second and a 4-byte microsecond) and of `kp_eproc.e_ppid` in it. The crate libc declares no `kinfo_proc` for
/// Apple platforms, so these values come from the header; a sysctl answer of another size is an error.
const KINFO_PROC_SIZE: usize = 648;
const KINFO_PROC_STARTED: usize = 0;
const KINFO_PROC_PARENT: usize = 560;

/// Reads `pid` from the process table of the `kern.proc.pid` sysctl, which describes the processes of every user, as a
/// `sudo` parent of a process; `proc_pidinfo` refuses those (docs/spec/sidecars.md#process-identity).
pub fn process_entry(pid: u32) -> Result<Option<super::super::ProcessEntry>, String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Ok(None);
    }
    let mut name = [
        libc::CTL_KERN,
        libc::KERN_PROC,
        libc::KERN_PROC_PID,
        pid as libc::c_int,
    ];
    let mut buffer = [0u8; KINFO_PROC_SIZE];
    let mut size = KINFO_PROC_SIZE;
    // SAFETY: name has the four integers of the request, and buffer has the size that size states.
    let result = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            name.len() as libc::c_uint,
            buffer.as_mut_ptr().cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return Err(format!(
            "cannot read process {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    if size == 0 {
        return Ok(None);
    }
    if size != KINFO_PROC_SIZE {
        return Err(format!(
            "cannot read process {pid}: the process table answered {size} of {KINFO_PROC_SIZE} bytes"
        ));
    }
    // The process table holds the integers in the byte order of the machine, which is little-endian on every Mac.
    let integer = |at: usize, length: usize| {
        let mut bytes = [0u8; 8];
        bytes[..length].copy_from_slice(&buffer[at..at + length]);
        i64::from_le_bytes(bytes)
    };
    let seconds = integer(KINFO_PROC_STARTED, 8);
    let microseconds = integer(KINFO_PROC_STARTED + 8, 4);
    let parent = integer(KINFO_PROC_PARENT, 4);
    Ok(Some(super::super::ProcessEntry {
        parent: parent as u32,
        started: seconds * 1000 + microseconds / 1000,
    }))
}

pub fn service_process_exists(pid: u32, published: SystemTime) -> Result<bool, String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Ok(false);
    }
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
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
    let started =
        UNIX_EPOCH + Duration::new(info.pbi_start_tvsec, info.pbi_start_tvusec as u32 * 1000);
    let owned = info.pbi_uid == unsafe { geteuid() };
    Ok(owned && info.pbi_status != libc::SZOMB && started <= published)
}

/// The identifier of the user event that wakes the wait for a service process when its stop stops.
const STOP_EVENT: libc::uintptr_t = 1;

/// Waits for the end of the service process `pid` with the kqueue notification NOTE_EXIT, or for `stop`, which triggers a
/// user event of the same queue. A process that does not exist has ended; the registration for it fails with ESRCH.
pub fn wait_service_process_end(pid: u32, stop: &super::super::StopSignal) -> Result<bool, String> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    if pid == 0 {
        return Ok(true);
    }
    let failed = |error: std::io::Error| format!("cannot wait for service process {pid}: {error}");
    let descriptor = unsafe { libc::kqueue() };
    if descriptor < 0 {
        return Err(failed(std::io::Error::last_os_error()));
    }
    // The queue closes when the function returns, after the watch below is dropped, so no wake triggers a closed or reused
    // descriptor.
    let queue = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let wake = libc::kevent {
        ident: STOP_EVENT,
        filter: libc::EVFILT_USER,
        flags: libc::EV_ADD | libc::EV_CLEAR,
        fflags: 0,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    if unsafe {
        libc::kevent(
            queue.as_raw_fd(),
            &wake,
            1,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    } < 0
    {
        return Err(format!(
            "cannot wait for service process {pid}: stop event: {}",
            std::io::Error::last_os_error()
        ));
    }
    // A trigger that fails leaves the wait to the exit of the process, and the wait returns that failure with its answer.
    let trigger_failure = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let raw = queue.as_raw_fd();
    let failure = std::sync::Arc::clone(&trigger_failure);
    let Some(watch) = stop.watch(move || {
        let trigger = libc::kevent {
            ident: STOP_EVENT,
            filter: libc::EVFILT_USER,
            flags: 0,
            fflags: libc::NOTE_TRIGGER,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        if unsafe { libc::kevent(raw, &trigger, 1, std::ptr::null_mut(), 0, std::ptr::null()) } < 0
        {
            *failure
                .lock()
                // default: the slot holds only the text of the failure, which a panic does not tear.
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some(std::io::Error::last_os_error().to_string());
        }
    }) else {
        return Ok(false);
    };
    let ended = wait_process_exit_event(raw, pid);
    drop(watch);
    let trigger_failure = trigger_failure
        .lock()
        // default: the slot holds only the text of the failure, which a panic does not tear.
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    match (ended, trigger_failure) {
        (Ok(_), Some(error)) => Err(format!(
            "cannot wake the wait for service process {pid}: {error}"
        )),
        (ended, _) => ended,
    }
}

/// Registers the exit of pid in queue and waits for it or for the stop event of the queue.
fn wait_process_exit_event(queue: i32, pid: u32) -> Result<bool, String> {
    let failed = |error: std::io::Error| format!("cannot wait for service process {pid}: {error}");
    let change = libc::kevent {
        ident: pid as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    let mut changes = 1;
    let mut event: libc::kevent = unsafe { std::mem::zeroed() };
    loop {
        let count =
            unsafe { libc::kevent(queue, &change, changes, &mut event, 1, std::ptr::null()) };
        if count < 0 {
            let error = std::io::Error::last_os_error();
            match error.raw_os_error() {
                // The kernel applied the registration before the wait; a repeated wait only reads events.
                Some(libc::EINTR) => {
                    changes = 0;
                    continue;
                }
                Some(libc::ESRCH) => return Ok(true),
                _ => return Err(failed(error)),
            }
        }
        if event.flags & libc::EV_ERROR != 0 {
            let code = event.data as i32;
            return if code == libc::ESRCH {
                Ok(true)
            } else {
                Err(failed(std::io::Error::from_raw_os_error(code)))
            };
        }
        return Ok(event.filter != libc::EVFILT_USER);
    }
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
        if let Err(error) = fs::remove_file(&self.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            crate::application_log::log_error(&self.path.display().to_string(), error);
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

    fn peer_process(&self) -> Result<u32, String> {
        let mut pid: libc::pid_t = 0;
        let mut length = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        // SAFETY: the descriptor belongs to the stream, and pid and length are a buffer of the size that length states.
        let result = unsafe {
            libc::getsockopt(
                self.0.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&raw mut pid).cast(),
                &raw mut length,
            )
        };
        if result != 0 {
            return Err(format!(
                "cannot read the peer process of the connection: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(pid as u32)
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
/// file of the same path that an ended process with the same number left. A path longer than the limit is refused
/// before the directory is changed.
pub fn listen(directory: &Path, name: &str) -> Result<Box<dyn Listener>, String> {
    let path = directory.join(format!("{name}-{}.sock", std::process::id()));
    let length = path.as_os_str().as_encoded_bytes().len();
    if length > SOCKET_PATH_LIMIT {
        return Err(format!(
            "endpoint socket path {} is {length} bytes, over the limit of {SOCKET_PATH_LIMIT} bytes of a unix socket address",
            path.display()
        ));
    }
    private_directory(directory)?;
    remove_ended(directory, name)?;
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

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixStream;

    use super::listen;

    // contract: endpoint.transport.closing-a-disconnected-connection-succeeds
    #[test]
    fn closing_an_already_disconnected_connection_succeeds() {
        let folder = crate::test_folder::Folder::new();
        let listener = listen(&folder.path().join("sockets"), "test-close").unwrap();
        let _peer = UnixStream::connect(listener.address()).unwrap();
        let connection = listener.accept().unwrap();
        assert_eq!(connection.close(), Ok(()));
        // Closing an already closed connection again is not a failure. A socket whose shutdown is done returns ENOTCONN.
        assert_eq!(
            connection.close(),
            Ok(()),
            "closing a disconnected connection reported an error"
        );
        listener.remove();
    }
}

#[cfg(test)]
#[path = "peer_process_test.rs"]
mod peer_process_test;
