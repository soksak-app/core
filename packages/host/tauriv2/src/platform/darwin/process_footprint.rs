//! The physical footprint of a process: ri_phys_footprint of proc_pid_rusage (libproc.h of the macOS SDK, RUSAGE_INFO_V0).
//! The libc crate of the lock file declares proc_pid_rusage, rusage_info_v0 and RUSAGE_INFO_V0, so no declaration is written here.

use libc::{RUSAGE_INFO_V0, proc_pid_rusage, rusage_info_v0};

/// Returns the physical footprint (KB, rounded down) of the process pid. It is an error when proc_pid_rusage fails; the text
/// names the errno number, which the Go host also names.
pub fn process_footprint_kb(pid: u32) -> Result<u64, String> {
    let process =
        libc::c_int::try_from(pid).map_err(|_| format!("pid {pid} is not a process id"))?;
    let mut info = std::mem::MaybeUninit::<rusage_info_v0>::zeroed();
    let status = unsafe { proc_pid_rusage(process, RUSAGE_INFO_V0, info.as_mut_ptr().cast()) };
    if status != 0 {
        // The errno of the failed call is read at once, before another call can replace it.
        let code = unsafe { *libc::__error() };
        return Err(format!("proc_pid_rusage for pid {pid}: errno {code}"));
    }
    let info = unsafe { info.assume_init() };
    Ok(info.ri_phys_footprint / 1024)
}
