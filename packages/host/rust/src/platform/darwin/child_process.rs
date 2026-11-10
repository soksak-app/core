//! The process group, the exit and the output pipes of a child process that the host starts as a sidecar
//! (docs/spec/sidecars.md#declaration-and-startup).

use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

/// Makes command the leader of a new process group.
pub fn new_process_group(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

/// Sends SIGKILL to the process group pid; ESRCH, or EPERM while the leader has exited and is not reaped, means that no
/// process of the group remains (signal_process_group).
pub fn end_process_group(pid: u32) -> Result<(), String> {
    signal_process_group(pid, libc::SIGKILL)
        .map_err(|error| format!("end process group {pid}: {error}"))
}

/// Sends SIGTERM to the process group pid; ESRCH, or EPERM while the leader has exited and is not reaped, means that no
/// process of the group remains (signal_process_group).
pub fn terminate_process_group(pid: u32) -> Result<(), String> {
    signal_process_group(pid, libc::SIGTERM)
        .map_err(|error| format!("terminate process group {pid}: {error}"))
}

/// Sends `signal` to the process group of the leader `pid`, a child of the host that the caller has not reaped: the host
/// reaps a sidecar only after the end of its group (ProcessExit of sidecars.rs) and a service after its own signal. The
/// wait for the exit of the leader (wait_process_exit) leaves it unreaped, and Darwin answers kill of a group whose
/// processes are all zombies with EPERM, not ESRCH; a group with a process that runs is signalled. So EPERM while the
/// unreaped leader has exited is the end of the group, as ESRCH is; EPERM while the leader runs, or for a process that is
/// not an unreaped child, is an error.
fn signal_process_group(pid: u32, signal: i32) -> Result<(), String> {
    let group = i32::try_from(pid).map_err(|_| "out of range".to_string())?;
    if unsafe { libc::kill(-group, signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(()),
        Some(libc::EPERM) if leader_exited(group) => Ok(()),
        _ => Err(error.to_string()),
    }
}

/// Whether the child `pid` has exited, without reaping it.
fn leader_exited(pid: i32) -> bool {
    let Ok(id) = libc::id_t::try_from(pid) else {
        return false;
    };
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                id,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } == 0
        {
            // WNOHANG leaves si_pid zero while the child runs.
            return info.si_pid == pid;
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            // default: a process that is not a child of the host, or one already reaped, is not taken as ended here; the
            // EPERM of its group stays an error.
            return false;
        }
    }
}

/// Whether an ended process ended by SIGTERM.
pub fn exited_by_termination(status: std::process::ExitStatus) -> bool {
    use std::os::unix::process::ExitStatusExt;
    status.signal() == Some(libc::SIGTERM)
}

/// Waits until the child process pid exits, without reaping it, so its owner still reaps it and reads its status. A child
/// that another wait reaped first has exited too (ECHILD).
pub fn wait_process_exit(pid: u32) -> Result<(), String> {
    let id = libc::id_t::try_from(pid).map_err(|_| format!("process {pid} is out of range"))?;
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::waitid(libc::P_PID, id, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(libc::ECHILD) => return Ok(()),
            _ => return Err(format!("wait for the exit of process {pid}: {error}")),
        }
    }
}

/// An output pipe of a child process whose reads end when its end is called: a read then takes what the pipe holds at that
/// moment and returns the end of the output, although another process keeps the write end open.
pub struct ExitOutput {
    output: OwnedFd,
    wake: OwnedFd,
    ended: bool,
}

/// Ends the reads of an `ExitOutput`.
pub struct ExitEnd {
    wake: OwnedFd,
}

/// Makes the reads of output end with the end that it returns.
pub fn exit_output(output: OwnedFd) -> Result<(ExitOutput, ExitEnd), String> {
    let mut ends = [0; 2];
    if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
        return Err(format!(
            "output end pipe: {}",
            std::io::Error::last_os_error()
        ));
    }
    // The descriptors are owned at once, so an error below closes both.
    let (wake, end) = unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
    for descriptor in ends {
        // A sidecar that starts later inherits neither end.
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(format!(
                "output end pipe: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok((
        ExitOutput {
            output,
            wake,
            ended: false,
        },
        ExitEnd { wake: end },
    ))
}

impl ExitEnd {
    /// Ends the reads of the output.
    pub fn end(&self) {
        let byte = 1u8;
        // One byte fits an empty pipe, and a second end finds the reads ended already, so a failed write ends nothing more.
        // A reader that finished and closed the output closed the wake pipe too (EPIPE): its reads have ended.
        let written =
            unsafe { libc::write(self.wake.as_raw_fd(), std::ptr::from_ref(&byte).cast(), 1) };
        if written < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EPIPE) {
                crate::application_log::log_info("sidecar output", format!("output end: {error}"));
            }
        }
    }
}

impl ExitOutput {
    /// Reads what the output holds now, without waiting; an output that holds nothing has ended.
    fn read_available(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let read = unsafe {
                libc::read(
                    self.output.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            if read >= 0 {
                return Ok(read as usize);
            }
            let error = std::io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EINTR) => continue,
                Some(libc::EAGAIN) => return Ok(0),
                _ => return Err(error),
            }
        }
    }
}

impl Read for ExitOutput {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.ended {
                return self.read_available(buffer);
            }
            let mut descriptors = [
                libc::pollfd {
                    fd: self.output.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.wake.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            if unsafe { libc::poll(descriptors.as_mut_ptr(), 2, -1) } < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(error);
            }
            if descriptors[1].revents != 0 {
                // The exit ended the output: the reads that follow take what it holds without waiting.
                let flags = unsafe { libc::fcntl(self.output.as_raw_fd(), libc::F_GETFL) };
                if flags < 0
                    || unsafe {
                        libc::fcntl(
                            self.output.as_raw_fd(),
                            libc::F_SETFL,
                            flags | libc::O_NONBLOCK,
                        )
                    } < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                self.ended = true;
                continue;
            }
            if descriptors[0].revents != 0 {
                // The pipe holds bytes or its writers closed it, so the read does not wait.
                let read = unsafe {
                    libc::read(
                        self.output.as_raw_fd(),
                        buffer.as_mut_ptr().cast(),
                        buffer.len(),
                    )
                };
                if read >= 0 {
                    return Ok(read as usize);
                }
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(error);
            }
        }
    }
}
