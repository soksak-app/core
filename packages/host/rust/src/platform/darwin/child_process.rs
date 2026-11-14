//! The process group, the exit and the output pipes of a child process that the host starts as a sidecar
//! (docs/spec/sidecars.md#declaration-and-startup).

use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

/// Makes command the leader of a new process group.
pub fn new_process_group(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

/// Sends SIGKILL to the process group pid; ESRCH, or EPERM while no process of the group runs, means that the group has
/// ended (signal_process_group).
pub fn end_process_group(pid: u32) -> Result<(), String> {
    signal_process_group(pid, libc::SIGKILL)
        .map_err(|error| format!("end process group {pid}: {error}"))
}

/// Sends SIGTERM to the process group pid; ESRCH, or EPERM while no process of the group runs, means that the group has
/// ended (signal_process_group).
pub fn terminate_process_group(pid: u32) -> Result<(), String> {
    signal_process_group(pid, libc::SIGTERM)
        .map_err(|error| format!("terminate process group {pid}: {error}"))
}

/// Sends `signal` to the process group `pid`. Darwin answers ESRCH only for a group that no longer exists, and a group
/// exists until its last process is reaped. It signals each process of the group that is neither a zombie nor exiting
/// (the kernel finds no reference to an exiting process), and answers EPERM when it signalled none: so EPERM also answers
/// a group whose processes have all ended, whether or not its leader was reaped, and a group whose leader has closed its
/// descriptors in its exit but is not yet a zombie. The refusal is therefore judged by the states of the processes of the group: EPERM while
/// none of them runs is the end of the group, as ESRCH is; EPERM while one runs, which the kernel does for a process that
/// the host may not signal, is an error that names the processes that run.
fn signal_process_group(pid: u32, signal: i32) -> Result<(), String> {
    let group = process_group_id(pid)?;
    let answer = if unsafe { libc::kill(-group, signal) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    };
    group_signal_result(answer, || running_group_processes(group))
}

/// The id of the process group of the leader `pid` as the system takes it: a positive signed 32-bit number, because the
/// system signals the group of the caller for 0.
pub(super) fn process_group_id(pid: u32) -> Result<i32, String> {
    match i32::try_from(pid) {
        Ok(group) if group > 0 => Ok(group),
        _ => Err("out of range".to_string()),
    }
}

/// Judges the answer of a signal to a process group (signal_process_group); `running` reads the processes of the group
/// that run.
pub(super) fn group_signal_result(
    answer: std::io::Result<()>,
    running: impl FnOnce() -> std::io::Result<Vec<i32>>,
) -> Result<(), String> {
    let Err(error) = answer else {
        return Ok(());
    };
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(()),
        Some(libc::EPERM) => {
            let running = running().map_err(|error| {
                format!("read the processes of the group: {}", system_error(&error))
            })?;
            if running.is_empty() {
                return Ok(());
            }
            let running: Vec<String> = running.iter().map(|pid| format!("pid {pid}")).collect();
            Err(format!(
                "operation not permitted; running: {}",
                running.join(", ")
            ))
        }
        _ => Err(system_error(&error)),
    }
}

/// Names a system error by its number, `errno <n>`, the form of the system error text of both hosts; an error without a
/// number keeps its text.
fn system_error(error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(errno) => format!("errno {errno}"),
        None => error.to_string(),
    }
}

/// `PROC_FLAG_INEXIT` of <sys/proc_info.h>, which the libc crate does not declare: the process is in its exit.
const PROC_FLAG_INEXIT: u32 = 4;

/// The processes of the group `group` that run: those that are neither zombies (SZOMB) nor exiting (PROC_FLAG_INEXIT), from
/// the process table of libproc, which lists the zombies and the exiting processes of the group as well.
fn running_group_processes(group: i32) -> std::io::Result<Vec<i32>> {
    // A buffer of null size answers the size in bytes that holds the pids of every process of the system.
    let size = unsafe { libc::proc_listpgrppids(group, std::ptr::null_mut(), 0) };
    if size <= 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut pids = vec![0 as libc::pid_t; size as usize / size_of::<libc::pid_t>()];
    // libproc answers an error and a group without processes both with 0 and sets errno only for the error.
    unsafe { *libc::__error() = 0 };
    let filled = unsafe { libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), size) };
    if filled <= 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(0) {
            return Err(error);
        }
    }
    pids.truncate(filled.max(0) as usize / size_of::<libc::pid_t>());
    let mut running = Vec::new();
    for pid in pids {
        let mut info: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
        let info_size = size_of::<libc::proc_bsdshortinfo>() as i32;
        // The argument 1 makes the call also answer a zombie or an exiting process.
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDT_SHORTBSDINFO,
                1,
                std::ptr::from_mut(&mut info).cast(),
                info_size,
            )
        };
        if read != info_size {
            let error = std::io::Error::last_os_error();
            // A process that its parent reaped after the listing has ended.
            if error.raw_os_error() == Some(libc::ESRCH) {
                continue;
            }
            return Err(error);
        }
        if info.pbsi_status != libc::SZOMB && info.pbsi_flags & PROC_FLAG_INEXIT == 0 {
            running.push(pid);
        }
    }
    Ok(running)
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
