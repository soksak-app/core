use portable_pty::MasterPty;

#[cfg(test)]
use std::sync::{Mutex, MutexGuard, OnceLock};

#[cfg(unix)]
use nix::sys::signal::{kill, Signal};
#[cfg(unix)]
use nix::unistd::Pid;

/// Returns the process-group leader supplied by the active PTY platform.
pub fn process_group_leader(
    #[cfg(unix)] master: &dyn MasterPty,
    #[cfg(not(unix))] _master: &dyn MasterPty,
) -> Option<i32> {
    #[cfg(unix)]
    {
        master.process_group_leader()
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// Terminates the PTY process group when the platform exposes one.
pub fn kill_process_group(
    #[cfg(unix)] group: Option<i32>,
    #[cfg(not(unix))] _group: Option<i32>,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let group = group.ok_or("PTY process group is unavailable")?;
        match kill(Pid::from_raw(-group), Signal::SIGKILL) {
            Ok(()) => Ok(()),
            Err(nix::errno::Errno::ESRCH) => Ok(()),
            Err(error) => Err(format!("kill PTY process group {group}: {error}")),
        }
    }
    #[cfg(not(unix))]
    {
        Ok(())
    }
}

/// Serializes real PTY tests within and across Rust test processes.
#[cfg(test)]
pub(crate) fn native_pty_test_lock() -> NativePtyTestLock {
    static LOCAL: OnceLock<Mutex<()>> = OnceLock::new();
    let local = LOCAL
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let path = std::env::temp_dir().join("soksak-vt-core-pty-tests.lock");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)
            .expect("PTY test lock file must open");
        nix::fcntl::flock(file.as_raw_fd(), nix::fcntl::FlockArg::LockExclusive)
            .expect("PTY test lock must acquire");
        NativePtyTestLock {
            _local: local,
            _file: file,
        }
    }
    #[cfg(not(unix))]
    {
        NativePtyTestLock { _local: local }
    }
}

#[cfg(test)]
pub(crate) struct NativePtyTestLock {
    _local: MutexGuard<'static, ()>,
    #[cfg(unix)]
    _file: std::fs::File,
}
