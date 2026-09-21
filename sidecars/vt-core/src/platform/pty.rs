use portable_pty::MasterPty;

#[cfg(unix)]
use nix::sys::signal::{kill, Signal};
#[cfg(unix)]
use nix::unistd::Pid;

/// Returns the process-group leader supplied by the active PTY platform.
pub fn process_group_leader(master: &dyn MasterPty) -> Option<i32> {
    #[cfg(unix)]
    { master.process_group_leader() }
    #[cfg(not(unix))]
    { let _ = master; None }
}

/// Terminates the PTY process group when the platform exposes one.
pub fn kill_process_group(group: Option<i32>) -> Result<(), String> {
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
        let _ = group;
        Ok(())
    }
}
