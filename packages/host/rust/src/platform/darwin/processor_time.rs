//! The processor time of this process: getrusage with RUSAGE_SELF (sys/resource.h), which the libc crate declares.

use std::time::Duration;

/// Returns the processor time, user and system, that this process used. The error names the failed call, which the Go host
/// also names.
pub fn processor_time() -> Result<Duration, String> {
    // SAFETY: getrusage writes the usage of the process into the zeroed structure that it is given.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
        return Err(format!("getrusage: {}", std::io::Error::last_os_error()));
    }
    let time = |value: libc::timeval| {
        Duration::from_secs(value.tv_sec as u64) + Duration::from_micros(value.tv_usec as u64)
    };
    Ok(time(usage.ru_utime) + time(usage.ru_stime))
}
